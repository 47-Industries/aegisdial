import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { query, withTx } from '../lib/db.js';
import { requireAppUser } from '../lib/auth.js';
import { track } from '../lib/analytics.js';
import { sendToUser } from '../lib/apns.js';

// Guardian dashboard routes.
//   GET   /v1/guardian/alerts                   — list my guardian alerts
//   GET   /v1/guardian/alerts/unseen-count      — badge count
//   PATCH /v1/guardian/alerts/:id/seen          — mark seen (iOS contract)
//   PATCH /v1/guardian/alerts/seen-all          — bulk mark seen (iOS contract)
//   POST  /v1/guardian/alerts/:id/seen          — legacy mirror of PATCH
//   POST  /v1/guardian/alerts/seen-all          — legacy mirror of PATCH
//   POST  /v1/guardian/challenge                — fire a safe-word challenge at a subject
//   POST  /v1/guardian/challenge/:id/respond    — subject answers
//
// Not pro-gated — being a guardian doesn't cost anything; the protected
// person is the paying subscriber.

const CHALLENGE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const challengeSchema = z.object({
  subject_user_id: z.string().uuid(),
});
const respondSchema = z.object({
  answer: z.string().min(1).max(200),
});

export async function guardianRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/guardian/alerts',
    { preHandler: [requireAppUser] },
    async (req, reply) => {
      const user = req.appUser!;
      const { seen } = (req.query as { seen?: string }) ?? {};
      const includeSeen = seen === 'true';
      const rows = await query<AlertRow>(
        `SELECT id, guardian_user_id, subject_user_id, family_plan_id, kind,
                severity, title, body, payload, created_at, seen_at, pushed_at
           FROM guardian_alerts
          WHERE guardian_user_id = $1
            ${includeSeen ? '' : 'AND seen_at IS NULL'}
          ORDER BY created_at DESC
          LIMIT 200`,
        [user.id],
      );
      return reply.send({ alerts: rows.rows.map(shape) });
    },
  );

  app.get(
    '/v1/guardian/alerts/unseen-count',
    { preHandler: [requireAppUser] },
    async (req, reply) => {
      const user = req.appUser!;
      const r = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM guardian_alerts
          WHERE guardian_user_id = $1 AND seen_at IS NULL`,
        [user.id],
      );
      return reply.send({ count: Number(r.rows[0]!.count) });
    },
  );

  // The iOS client wires to PATCH; the legacy POST mirrors stay so
  // older builds don't 405 after this deploy.
  for (const method of ['patch', 'post'] as const) {
    app[method](
      '/v1/guardian/alerts/:id/seen',
      { preHandler: [requireAppUser] },
      async (req, reply) => {
        const user = req.appUser!;
        const { id } = req.params as { id: string };
        const r = await query<{ kind: string; severity: string }>(
          `UPDATE guardian_alerts SET seen_at = NOW()
            WHERE id = $1 AND guardian_user_id = $2 AND seen_at IS NULL
            RETURNING kind, severity`,
          [id, user.id],
        );
        if (r.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
        void track('guardian_alert_seen', {
          userId: user.id,
          properties: {
            alert_id: id,
            kind: r.rows[0]!.kind,
            severity: r.rows[0]!.severity,
            source: 'single',
          },
        });
        return reply.send({ ok: true, count: 1, seen: true });
      },
    );
    app[method](
      '/v1/guardian/alerts/seen-all',
      { preHandler: [requireAppUser] },
      async (req, reply) => {
        const user = req.appUser!;
        const r = await query(
          `UPDATE guardian_alerts SET seen_at = NOW()
            WHERE guardian_user_id = $1 AND seen_at IS NULL`,
          [user.id],
        );
        const count = r.rowCount ?? 0;
        void track('guardian_alert_seen', {
          userId: user.id,
          properties: { count, source: 'seen_all' },
        });
        return reply.send({ ok: true, count, marked_seen: count });
      },
    );
  }

  // -----------------------------------------------------------------
  // Safe-word challenge. A guardian — having seen a sketchy event on
  // the subject's activity — asks the subject "prove it's you." We
  // push-notify the subject, persist a challenge row, and the subject
  // responds with the shared safe word from their family_contacts
  // registry. Match = identity confirmed; mismatch = likely compromise.
  //
  // The safe word hash lives on the SUBJECT's side of the relationship:
  // family_contacts rows on the SUBJECT's list, is_guardian=TRUE,
  // phone_e164 matching the GUARDIAN's users.phone_number. That's the
  // same mapping recovery.ts's isNamedGuardian uses.
  // -----------------------------------------------------------------
  app.post(
    '/v1/guardian/challenge',
    {
      preHandler: [requireAppUser],
      // 5/hour/user. A guardian has no legitimate need to spam
      // challenges at a subject; this ceiling contains a compromised
      // guardian JWT from hammering a vulnerable family member with
      // social-engineering-adjacent push spam.
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = challengeSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const subjectId = parsed.data.subject_user_id;

      // Caller must be a guardian of the subject. Use the same
      // phone→contact mapping that recovery R20 uses, but inverted:
      // here the subject is the contact-list owner and the caller's
      // phone_number must match one of subject's is_guardian=TRUE
      // family_contacts. Plus both must still share a plan.
      //
      // Security: do NOT return distinct error codes for "not on the
      // subject's plan" vs "on plan but no safe word" vs "challenging
      // self". All three collapse to a single opaque 403. Otherwise an
      // authenticated attacker could enumerate family-plan membership
      // by watching which 400/403 they get back.
      const auth = subjectId === user.id
        ? { rows: [] as Array<{ prompt: string | null; answer_hash: string | null }> }
        : await query<{ prompt: string | null; answer_hash: string | null }>(
        `SELECT fc.challenge_prompt AS prompt,
                fc.safe_word_hash AS answer_hash
           FROM users gu
           JOIN family_contacts fc
             ON fc.user_id = $1                   -- subject is the contact-list owner
            AND fc.is_guardian = TRUE
            AND fc.phone_e164 = gu.phone_number
           JOIN family_members fm_sub
             ON fm_sub.user_id = $1
           JOIN family_members fm_guard
             ON fm_guard.user_id = $2
            AND fm_guard.family_plan_id = fm_sub.family_plan_id
          WHERE gu.id = $2
          LIMIT 1`,
        [subjectId, user.id],
      );
      if (auth.rows.length === 0 || !auth.rows[0]!.answer_hash) {
        return reply.code(403).send({ error: 'challenge_not_available' });
      }

      const inserted = await query<{ id: string; expires_at: Date }>(
        `INSERT INTO guardian_challenges
           (subject_user_id, initiated_by_user_id, challenge_prompt, expires_at)
         VALUES ($1, $2, $3, NOW() + ($4::text || ' milliseconds')::interval)
         RETURNING id, expires_at`,
        [
          subjectId,
          user.id,
          auth.rows[0]!.prompt,
          String(CHALLENGE_TTL_MS),
        ],
      );
      const challengeId = inserted.rows[0]!.id;

      // User-facing push — targeted at the SUBJECT, not the guardian.
      // sendToUser() is safe to call even without APNs creds (no-ops),
      // so we don't await / block the response on push success.
      void sendToUser({
        userId: subjectId,
        title: 'Quick check from your family',
        body: "Your family member wants to verify it's really you. Tap to answer.",
        threadId: 'guardian-challenge',
        data: {
          kind: 'guardian_challenge',
          challenge_id: challengeId,
          prompt: auth.rows[0]!.prompt ?? null,
        },
      });

      void track('guardian_challenge_started', {
        userId: user.id,
        properties: { challenge_id: challengeId, subject_user_id: subjectId },
      });

      return reply.send({
        challenge_id: challengeId,
        expires_at: inserted.rows[0]!.expires_at.toISOString(),
        prompt: auth.rows[0]!.prompt ?? null,
      });
    },
  );

  app.post(
    '/v1/guardian/challenge/:id/respond',
    {
      preHandler: [requireAppUser],
      // 10/minute subject-side — bcrypt.compare is deliberately slow
      // and rate-limiting contains a leaked-token brute force against
      // a 4-digit safe word.
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const parsed = respondSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await withTx(async (client) => {
        const row = await client.query<{
          id: string;
          subject_user_id: string;
          initiated_by_user_id: string;
          expires_at: Date;
          resolved_at: Date | null;
        }>(
          `SELECT id, subject_user_id, initiated_by_user_id,
                  expires_at, resolved_at
             FROM guardian_challenges
            WHERE id = $1
            FOR UPDATE`,
          [id],
        );
        if (row.rows.length === 0) return { kind: 'not_found' as const };
        const c = row.rows[0]!;
        if (c.subject_user_id !== user.id) return { kind: 'forbidden' as const };
        if (c.resolved_at !== null) return { kind: 'already_resolved' as const };
        if (c.expires_at.getTime() <= Date.now()) return { kind: 'expired' as const };

        // Pull the same safe-word hash the challenge was authorized
        // against — re-derive via the guardian's phone so the hash
        // can't be spoofed by the client.
        const hashRow = await client.query<{ answer_hash: string | null }>(
          `SELECT fc.safe_word_hash AS answer_hash
             FROM users gu
             JOIN family_contacts fc
               ON fc.user_id = $1
              AND fc.is_guardian = TRUE
              AND fc.phone_e164 = gu.phone_number
            WHERE gu.id = $2
            LIMIT 1`,
          [c.subject_user_id, c.initiated_by_user_id],
        );
        const stored = hashRow.rows[0]?.answer_hash ?? null;
        if (!stored) return { kind: 'no_safe_word_configured' as const };

        const normalized = parsed.data.answer.trim().toLowerCase().replace(/\s+/g, ' ');
        const match = await bcrypt.compare(normalized, stored);

        await client.query(
          `UPDATE guardian_challenges
              SET resolved_at = NOW(),
                  resolved_success = $2
            WHERE id = $1`,
          [c.id, match],
        );

        // Audit trail — same table the safe-word verify endpoint uses.
        await client.query(
          `INSERT INTO family_verifications
             (user_id, verification_type, success)
           VALUES ($1, 'challenge', $2)`,
          [user.id, match],
        );
        return { kind: 'ok' as const, match, initiatedBy: c.initiated_by_user_id };
      });

      if (result.kind === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (result.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      if (result.kind === 'expired') return reply.code(410).send({ error: 'challenge_expired' });
      if (result.kind === 'already_resolved') {
        return reply.code(409).send({ error: 'already_resolved' });
      }
      if (result.kind === 'no_safe_word_configured') {
        return reply.code(400).send({ error: 'no_safe_word_configured' });
      }

      // Bounce a push back to the guardian so they see the result
      // without polling. Again, fire-and-forget (push is best-effort).
      void sendToUser({
        userId: result.initiatedBy,
        title: result.match ? 'Identity confirmed' : 'Safe word did not match',
        body: result.match
          ? 'Your family member answered correctly.'
          : 'The safe word did not match. This could mean the person you were worried about is not who they say they are.',
        threadId: 'guardian-challenge',
        data: {
          kind: 'guardian_challenge_resolved',
          challenge_id: id,
          matched: result.match,
        },
      });

      void track('guardian_challenge_responded', {
        userId: user.id,
        properties: { challenge_id: id, matched: result.match },
      });
      return reply.send({ matched: result.match });
    },
  );
}

interface AlertRow {
  id: string;
  guardian_user_id: string;
  subject_user_id: string;
  family_plan_id: string | null;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  payload: unknown;
  created_at: Date;
  seen_at: Date | null;
  pushed_at: Date | null;
}

function shape(row: AlertRow) {
  return {
    id: row.id,
    guardian_user_id: row.guardian_user_id,
    subject_user_id: row.subject_user_id,
    family_plan_id: row.family_plan_id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    payload: row.payload,
    created_at: row.created_at.toISOString(),
    seen_at: row.seen_at?.toISOString() ?? null,
    pushed_at: row.pushed_at?.toISOString() ?? null,
  };
}
