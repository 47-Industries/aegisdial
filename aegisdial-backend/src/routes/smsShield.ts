import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireAppUser } from '../lib/auth.js';
import { query } from '../lib/db.js';
import { scoreManualSms } from '../services/smsManualScore.js';
import { redactSensitiveDigits } from '../services/sentinelMatcher.js';
import { emitMetric, captureError } from '../lib/observability.js';
import { normalizeE164 } from '../lib/phone.js';

// SMS Shield — manual-paste scoring route + per-user scan history.
//
// Two surfaces here:
//   POST /v1/sms/score   — user pastes a message, gets a fraud score
//   GET  /v1/sms/scans   — user's own recent scan history
//
// Both authed (requireAppUser). The Apple-filter side (auto-scan
// mode) is /v1/sms-classify in services/smsClassify.ts; that route
// is intentionally unauthenticated because Apple's Message Filter
// Extension doesn't send a bearer.
//
// PII posture: the user pasted the text themselves, but we don't
// store plaintext at rest. Persist body_sha256 + an 80-char excerpt
// after digit redaction. Original body never leaves the request
// scope — gets scored in-process and the response is the only place
// the full text could surface, and it doesn't (response echoes
// score + reasons, not body).

const ScoreSchema = z.object({
  message_body: z.string().min(1).max(3200),
  sender_e164: z.string().max(32).optional(),
});

const SMS_SCAN_MODES = ['disabled', 'manual_only', 'auto'] as const;
type SmsScanMode = (typeof SMS_SCAN_MODES)[number];

const SettingsSchema = z.object({
  sms_scan_mode: z.enum(SMS_SCAN_MODES),
});

const EXCERPT_LENGTH = 80;

function bodyExcerpt(text: string): string {
  return redactSensitiveDigits(text).slice(0, EXCERPT_LENGTH);
}

function bodyHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function smsShieldRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/sms/score',
    {
      preHandler: requireAppUser,
      config: {
        // Per-user rate limit. Manual-paste mode is interactive — a
        // user can plausibly paste 5-10 messages in a row when
        // reviewing a thread. 30/min gives them room without
        // tolerating a malicious script. M-1 adversarial fix:
        // user-keyed (not IP-keyed) so shared-IP users (office /
        // CGNAT / VPN) don't share quota.
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          // Adversarial-review H1 (Email Shield P11 review):
          // `hook: 'preHandler'` so the keyGenerator runs AFTER
          // requireAppUser populates req.appUser. Without this,
          // @fastify/rate-limit's default `onRequest` hook fires
          // before auth and the keyGenerator silently falls through
          // to `ip:` keying — defeating the M-1 user-keyed
          // intention.
          hook: 'preHandler',
          keyGenerator: (req) =>
            req.appUser?.id ? `user:${req.appUser.id}` : `ip:${req.ip}`,
        },
      },
    },
    async (req, reply) => {
      const parsed = ScoreSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const { message_body, sender_e164 } = parsed.data;
      const userId = req.appUser!.id;
      // Adversarial fix H2: iOS clients sometimes pass the user-visible
      // "From:" string verbatim — "(415) 555-1234", "+1 415 555 1234",
      // bare digits, or alphanumeric short codes like "CHASE". Normalize
      // to canonical E.164 so the cross-pool hot-numbers lookup
      // (a1HotNumbersPopulator → call_sessions.peer_e164 match) actually
      // hits. If normalization fails (alpha sender or short code), we
      // keep the raw string — better imperfect provenance than dropping
      // the field; it just won't participate in the E.164 hot-numbers
      // graph (which is shaped by libphonenumber-validated numbers).
      const normalizedSender = sender_e164
        ? (normalizeE164(sender_e164) ?? sender_e164)
        : null;

      let result;
      try {
        result = await scoreManualSms(message_body);
      } catch (err) {
        captureError(err, { component: 'smsShield.score', user_id: userId });
        return reply.code(500).send({ error: 'scoring_failed' });
      }

      // Persist scan to sms_scans. Failures here don't break the
      // user's response — they get the score back even if the audit
      // write fails. Operator visibility via the metric.
      try {
        await query(
          `INSERT INTO sms_scans
             (user_id, body_sha256, body_excerpt, sender_e164,
              fraud_score, verdict, triggered_categories, reasons,
              url_findings, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, 'manual')`,
          [
            userId,
            bodyHash(message_body),
            bodyExcerpt(message_body),
            normalizedSender,
            result.fraud_score,
            result.verdict,
            JSON.stringify(result.triggered_categories),
            JSON.stringify(result.explainable_reasons),
            JSON.stringify(result.url_findings),
          ],
        );
      } catch (err) {
        void emitMetric('sms_shield.audit_insert_failed', {});
        captureError(err, { component: 'smsShield.persist', user_id: userId });
        // Continue — return the score even if audit failed.
      }

      void emitMetric('sms_shield.scored', { verdict: result.verdict });
      return reply.send(result);
    },
  );

  // GET /v1/sms/settings — read the user's current SMS scan mode.
  // iOS calls this on app launch to decide whether to prompt for the
  // ILMessageFilterExtension permission (only when mode='auto').
  app.get(
    '/v1/sms/settings',
    {
      preHandler: requireAppUser,
      config: {
        // H2 adversarial fix: user-keyed limiter so a shared-IP
        // user doesn't get throttled by another's traffic.
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
          // Adversarial-review H1 (Email Shield P11 review):
          // `hook: 'preHandler'` so the keyGenerator runs AFTER
          // requireAppUser populates req.appUser. Without this,
          // @fastify/rate-limit's default `onRequest` hook fires
          // before auth and the keyGenerator silently falls through
          // to `ip:` keying — defeating the M-1 user-keyed
          // intention.
          hook: 'preHandler',
          keyGenerator: (req) =>
            req.appUser?.id ? `user:${req.appUser.id}` : `ip:${req.ip}`,
        },
      },
    },
    async (req, reply) => {
      const userId = req.appUser!.id;
      // H2 adversarial fix: tolerate the migration-not-applied state.
      // COALESCE returns the default mode if the column exists but
      // is NULL (it isn't, by migration 055), AND the try/catch
      // around the whole call handles the column-missing case during
      // a rolling deploy where boot precedes migrate.
      try {
        const res = await query<{ sms_scan_mode: SmsScanMode }>(
          `SELECT COALESCE(sms_scan_mode, 'manual_only')::TEXT AS sms_scan_mode FROM users WHERE id = $1`,
          [userId],
        );
        if (res.rowCount === 0) return reply.code(404).send({ error: 'user_not_found' });
        return reply.send({
          sms_scan_mode: res.rows[0]!.sms_scan_mode,
          available_modes: SMS_SCAN_MODES,
        });
      } catch (err) {
        // pg error code 42703 = "undefined_column". Surfaces when
        // migration 055 hasn't applied yet. Fall back to the default
        // so the settings UI doesn't 500 during a rolling deploy.
        const pgCode = (err as { code?: string }).code;
        if (pgCode === '42703') {
          void emitMetric('sms_shield.settings_column_missing', {});
          return reply.send({
            sms_scan_mode: 'manual_only',
            available_modes: SMS_SCAN_MODES,
          });
        }
        throw err;
      }
    },
  );

  // POST /v1/sms/settings — update the user's SMS scan mode.
  // Onboarding sets this once; settings UI can change it later.
  app.post(
    '/v1/sms/settings',
    {
      preHandler: requireAppUser,
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
          // Adversarial-review H1 (Email Shield P11 review):
          // `hook: 'preHandler'` so the keyGenerator runs AFTER
          // requireAppUser populates req.appUser. Without this,
          // @fastify/rate-limit's default `onRequest` hook fires
          // before auth and the keyGenerator silently falls through
          // to `ip:` keying — defeating the M-1 user-keyed
          // intention.
          hook: 'preHandler',
          keyGenerator: (req) =>
            req.appUser?.id ? `user:${req.appUser.id}` : `ip:${req.ip}`,
        },
      },
    },
    async (req, reply) => {
      const parsed = SettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const { sms_scan_mode } = parsed.data;
      const userId = req.appUser!.id;
      try {
        const res = await query<{ id: string }>(
          `UPDATE users SET sms_scan_mode = $1 WHERE id = $2 RETURNING id`,
          [sms_scan_mode, userId],
        );
        if (res.rowCount === 0) return reply.code(404).send({ error: 'user_not_found' });
        void emitMetric('sms_shield.settings_updated', { mode: sms_scan_mode });
        return reply.send({ sms_scan_mode });
      } catch (err) {
        const pgCode = (err as { code?: string }).code;
        if (pgCode === '42703') {
          // Migration 055 hasn't applied. Don't pretend to have
          // saved; tell the iOS app to retry after deploy stabilizes.
          void emitMetric('sms_shield.settings_column_missing', {});
          return reply.code(503).send({ error: 'settings_not_yet_available' });
        }
        throw err;
      }
    },
  );

  app.get(
    '/v1/sms/scans',
    {
      preHandler: requireAppUser,
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
          // Adversarial-review H1 (Email Shield P11 review):
          // `hook: 'preHandler'` so the keyGenerator runs AFTER
          // requireAppUser populates req.appUser. Without this,
          // @fastify/rate-limit's default `onRequest` hook fires
          // before auth and the keyGenerator silently falls through
          // to `ip:` keying — defeating the M-1 user-keyed
          // intention.
          hook: 'preHandler',
          keyGenerator: (req) =>
            req.appUser?.id ? `user:${req.appUser.id}` : `ip:${req.ip}`,
        },
      },
    },
    async (req, reply) => {
      const q = req.query as { limit?: string; flagged_only?: string };
      const rawLimit = q.limit ? parseInt(q.limit, 10) : 50;
      const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50));
      const flaggedOnly = q.flagged_only === 'true' || q.flagged_only === '1';
      const userId = req.appUser!.id;

      const where = flaggedOnly
        ? `user_id = $1 AND verdict IN ('suspicious', 'fraud')`
        : `user_id = $1`;

      const res = await query<{
        id: string;
        body_excerpt: string;
        sender_e164: string | null;
        fraud_score: number;
        verdict: string;
        triggered_categories: unknown;
        reasons: unknown;
        url_findings: unknown;
        source: string;
        scanned_at: Date;
      }>(
        `SELECT id, body_excerpt, sender_e164, fraud_score, verdict,
                triggered_categories, reasons, url_findings, source,
                scanned_at
           FROM sms_scans
          WHERE ${where}
          ORDER BY scanned_at DESC
          LIMIT $2`,
        [userId, limit],
      );

      return reply.send({
        scans: res.rows.map((r) => ({
          id: r.id,
          body_excerpt: r.body_excerpt,
          sender_e164: r.sender_e164,
          fraud_score: r.fraud_score,
          verdict: r.verdict,
          triggered_categories: r.triggered_categories,
          reasons: r.reasons,
          url_findings: r.url_findings,
          source: r.source,
          scanned_at: r.scanned_at.toISOString(),
        })),
        limit,
        flagged_only: flaggedOnly,
      });
    },
  );
}
