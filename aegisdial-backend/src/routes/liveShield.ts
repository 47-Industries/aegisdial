import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, withTx } from '../lib/db.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { normalizeE164 } from '../lib/phone.js';
import { detectPhrases, patternById } from '../lib/scamPhrases.js';
import { scoreHits } from '../services/liveShield.js';
import type { PhraseHit } from '../lib/scamPhrases.js';
import { emitGuardianAlert } from '../services/guardianAlerts.js';
import { track } from '../lib/analytics.js';
import { trackCallBlocked } from '../lib/internalEvents.js';
import { encryptString, readMaybeEncrypted } from '../lib/crypto.js';
import {
  shouldFireLlm,
  mergeScores,
  runLlmAndCache,
  LLM_TRIGGER_THRESHOLD,
  FAMILY_ALERT_THRESHOLD,
} from '../services/liveShieldLlm.js';
import { fireFamilyAlert } from '../services/liveShieldFamilyAlert.js';

// Suggestion payload returned to the iOS app when an emergency-relative
// pattern fires. The client uses it to render the "Call them back on
// their saved number" / "Ask for the safe word" panel. If no contact is
// registered, `matched_contact` is null but we still set the suggestion
// flag so the client can prompt the user to add a contact right now.
interface FamilySuggestion {
  matched_contact: {
    id: string;
    display_name: string;
    phone: string;
    relationship: string | null;
    is_guardian: boolean;
    has_safe_word: boolean;
    challenge_prompt: string | null;
    has_challenge: boolean;
  } | null;
  guardian_contacts: Array<{
    id: string;
    display_name: string;
    phone: string;
    relationship: string | null;
  }>;
  instruction: string;
}

async function buildFamilySuggestion(
  userId: string,
  sessionId: string,
): Promise<FamilySuggestion> {
  const peerRes = await query<{ peer_e164: string | null }>(
    `SELECT peer_e164 FROM call_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  const peer = peerRes.rows[0]?.peer_e164 ?? null;

  let matched: FamilySuggestion['matched_contact'] = null;
  if (peer) {
    const m = await query<{
      id: string;
      display_name: string;
      phone_e164: string;
      relationship: string | null;
      is_guardian: boolean;
      has_safe_word: boolean;
      challenge_prompt: string | null;
      has_challenge: boolean;
    }>(
      `SELECT id, display_name, phone_e164, relationship, is_guardian,
              safe_word_hash IS NOT NULL AS has_safe_word,
              challenge_prompt,
              challenge_answer_hash IS NOT NULL AS has_challenge
         FROM family_contacts
        WHERE user_id = $1 AND phone_e164 = $2`,
      [userId, peer],
    );
    if (m.rows[0]) {
      matched = {
        id: m.rows[0].id,
        display_name: m.rows[0].display_name,
        phone: m.rows[0].phone_e164,
        relationship: m.rows[0].relationship,
        is_guardian: m.rows[0].is_guardian,
        has_safe_word: m.rows[0].has_safe_word,
        challenge_prompt: m.rows[0].challenge_prompt,
        has_challenge: m.rows[0].has_challenge,
      };
    }
  }

  const guardians = await query<{
    id: string;
    display_name: string;
    phone_e164: string;
    relationship: string | null;
  }>(
    `SELECT id, display_name, phone_e164, relationship
       FROM family_contacts
      WHERE user_id = $1 AND is_guardian = TRUE
      ORDER BY display_name ASC`,
    [userId],
  );

  return {
    matched_contact: matched,
    guardian_contacts: guardians.rows.map((g) => ({
      id: g.id,
      display_name: g.display_name,
      phone: g.phone_e164,
      relationship: g.relationship,
    })),
    instruction: matched
      ? `Hang up and call ${matched.display_name} back at their saved number — or ask them for your safe word. A real family member will pass this check; a voice-cloning scam won't.`
      : `The caller claims to be family. Hang up and call them back at the number you have saved. If you don't have their number saved, DO NOT send money — call another relative to confirm where they are.`,
  };
}

// Live Shield: in-call protection routes.
//
// Flow:
//   1. Client calls /v1/live-shield/start (returns session_id).
//   2. Client streams on-device transcript chunks to /v1/live-shield/transcript.
//      Each chunk gets scanned; new phrase hits are persisted and the
//      session's running risk snapshot is returned (risk_score, level,
//      new warnings to surface).
//   3. Client calls /v1/live-shield/end on hang-up (or timeout).
//
// The client is responsible for on-device speech recognition. The
// backend never receives audio — only text.

const START_SCHEMA = z.object({
  peer_number: z.string().max(20).optional(),
  direction: z.enum(['inbound', 'outbound', 'unknown']).optional().default('inbound'),
  consent_given: z.boolean(),
});

const TRANSCRIPT_SCHEMA = z.object({
  seq: z.number().int().nonnegative(),
  speaker: z.enum(['caller', 'self', 'unknown']).optional().default('unknown'),
  text: z.string().min(1).max(4000),
  confidence: z.number().min(0).max(1).optional(),
});

const END_SCHEMA = z.object({
  outcome: z
    .enum(['user_hung_up', 'user_completed', 'user_called_guardian', 'user_abandoned', 'unknown'])
    .optional()
    .default('unknown'),
});

export async function liveShieldRoutes(app: FastifyInstance): Promise<void> {
  // Start a shielded call session. Consent must be explicit — we never
  // analyze audio without it (two-party-consent safety).
  app.post(
    '/v1/live-shield/start',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = START_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      if (!parsed.data.consent_given) {
        return reply.code(400).send({
          error: 'consent_required',
          message:
            'Live call analysis requires explicit user consent. Present the disclosure before starting.',
        });
      }
      const peer = parsed.data.peer_number ? normalizeE164(parsed.data.peer_number) : null;

      const row = await query<{ id: string; started_at: Date }>(
        `INSERT INTO call_sessions (user_id, peer_e164, direction, consent_given)
         VALUES ($1, $2, $3, TRUE)
         RETURNING id, started_at`,
        [user.id, peer, parsed.data.direction],
      );
      const { id, started_at } = row.rows[0]!;
      void track('shield_started', {
        userId: user.id,
        properties: { direction: parsed.data.direction, has_peer: !!peer },
      });
      return reply.send({
        session_id: id,
        started_at: started_at.toISOString(),
        risk_score: 0,
        risk_level: 'low',
        triggered_categories: [],
      });
    },
  );

  // Submit a transcript chunk. Server scans for phrase hits, persists
  // both the event and any new hits, re-scores the session with all
  // hits seen so far, and returns the fresh snapshot + any newly-fired
  // warnings the client should display.
  app.post(
    '/v1/live-shield/:id/transcript',
    {
      preHandler: [requireAppUser, requireProTier],
      // Per-user limiter. At our ~8s flush cadence a single call emits
      // ~7 chunks/min. 120/min per user gives a 15× margin for a
      // chatty call without opening a DoS vector.
      config: {
        rateLimit: {
          max: 120,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const parsed = TRANSCRIPT_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const owned = await query<{ id: string; ended_at: Date | null }>(
        `SELECT id, ended_at FROM call_sessions WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (owned.rows.length === 0) return reply.code(404).send({ error: 'session_not_found' });
      if (owned.rows[0]!.ended_at) return reply.code(409).send({ error: 'session_ended' });

      // Detect phrases against plaintext BEFORE encryption. The plaintext
      // never touches disk — only the ciphertext lands in transcript_events.
      const newHits = detectPhrases(parsed.data.text);
      const encryptedText = encryptString(parsed.data.text);

      const snapshot = await withTx(async (client) => {
        // Upsert transcript event. Client retries with the same seq keep
        // the same row — use DO UPDATE so RETURNING always yields the id.
        // `text` is set to empty string (column is nullable post-migration
        // 020 but still present for backward compat with legacy readers);
        // the real payload is in text_ct.
        const evt = await client.query<{ id: string }>(
          `INSERT INTO transcript_events (session_id, seq, speaker, text, text_ct, confidence)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (session_id, seq) DO UPDATE
             SET text = EXCLUDED.text,
                 text_ct = EXCLUDED.text_ct,
                 confidence = EXCLUDED.confidence
           RETURNING id`,
          [id, parsed.data.seq, parsed.data.speaker, '', encryptedText, parsed.data.confidence ?? null],
        );
        const eventId = evt.rows[0]!.id;

        // Single multi-row INSERT for all new phrase hits in this chunk.
        // ON CONFLICT (session_id, pattern_id) DO NOTHING skips duplicates
        // we've already persisted in a prior chunk. RETURNING pattern_id
        // gives us exactly the set that was newly inserted. Replaces N
        // serial round-trips with 1 (critical on a Live Shield path that
        // fires ~7 chunks/min × up to 5 hits = 35 saved RTTs/call).
        let newlyPersistedIds: string[] = [];
        if (newHits.length > 0) {
          const values: string[] = [];
          const params: unknown[] = [];
          let p = 0;
          for (const hit of newHits) {
            values.push(
              `($${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p})`,
            );
            params.push(
              id,
              eventId,
              hit.pattern.id,
              hit.pattern.category,
              hit.pattern.severity,
              hit.pattern.weight,
              '',
              encryptString(hit.matched_text),
            );
          }
          const ins = await client.query<{ pattern_id: string }>(
            `INSERT INTO scam_phrase_hits
               (session_id, transcript_event_id, pattern_id, category, severity, weight, matched_text, matched_text_ct)
             VALUES ${values.join(', ')}
             ON CONFLICT (session_id, pattern_id) DO NOTHING
             RETURNING pattern_id`,
            params,
          );
          newlyPersistedIds = ins.rows.map((r) => r.pattern_id);
        }

        // Rebuild full hit set and re-score. Score calculation only needs
        // pattern metadata — the matched_text string isn't used for
        // scoring, so we don't need to decrypt the ciphertext here.
        const allHits = await client.query<{ pattern_id: string }>(
          `SELECT pattern_id FROM scam_phrase_hits WHERE session_id = $1`,
          [id],
        );

        const rehydrated: PhraseHit[] = [];
        for (const row of allHits.rows) {
          const p = patternById(row.pattern_id);
          if (p) rehydrated.push({ pattern: p, matched_text: '', offset: 0 });
        }
        const score = scoreHits(rehydrated);

        await client.query(
          `UPDATE call_sessions
              SET risk_score = $2,
                  risk_level = $3,
                  triggered_categories = $4,
                  updated_at = NOW()
            WHERE id = $1`,
          [id, score.risk_score, score.risk_level, score.triggered_categories],
        );

        return { score, newHitIds: newlyPersistedIds };
      });

      const newWarnings = snapshot.newHitIds
        .map((pid) => {
          const p = patternById(pid);
          return p ? { pattern_id: p.id, label: p.label, severity: p.severity, category: p.category } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      // Deepfake / emergency-relative defense: if the session has ever
      // triggered emergency_relative OR the caller claimed to be
      // family, attach the family-verify guidance + any registered
      // contact matching the peer number.
      const emergency =
        snapshot.score.triggered_categories.includes('emergency_relative');
      let familySuggest: FamilySuggestion | null = null;
      if (emergency) {
        familySuggest = await buildFamilySuggestion(user.id, id);
      }

      // Live Shield v2 — hybrid risk engine.
      //
      // Read the LLM cache that may have been populated by an earlier
      // chunk's async LLM call. Merge regex + LLM scores (LLM can
      // escalate, never demote — see services/liveShieldLlm.ts).
      const llmRow = await query<{
        llm_score: number | null;
        llm_scam_type: string | null;
        llm_coaching_line: string | null;
        llm_last_called_at: Date | null;
      }>(
        `SELECT llm_score, llm_scam_type, llm_coaching_line, llm_last_called_at
           FROM call_sessions WHERE id = $1`,
        [id],
      );
      const llmScore = llmRow.rows[0]?.llm_score ?? null;
      const llmCoachingLine = llmRow.rows[0]?.llm_coaching_line ?? null;
      const llmScamType = llmRow.rows[0]?.llm_scam_type ?? null;
      const llmLastCalledAt = llmRow.rows[0]?.llm_last_called_at ?? null;

      const finalScore = mergeScores(snapshot.score.risk_score, llmScore);
      const finalLevel: 'low' | 'medium' | 'high' | 'critical' =
        finalScore >= 75 ? 'critical' :
        finalScore >= 50 ? 'high' :
        finalScore >= 25 ? 'medium' : 'low';

      // If the merged score differs from the regex-only snapshot we just
      // wrote inside the tx, persist the merged value so subsequent
      // reads (auto-populate, dashboard, this same route on next chunk)
      // see the truth.
      if (finalScore !== snapshot.score.risk_score) {
        await query(
          `UPDATE call_sessions
              SET risk_score = $2, risk_level = $3, updated_at = NOW()
            WHERE id = $1`,
          [id, finalScore, finalLevel],
        );
      }

      // Fire Claude async if regex crossed the trigger threshold AND we're
      // outside the 8-second debounce window. Fire-and-forget — the next
      // chunk reads the updated cache. This is the key cost-control: the
      // LLM only runs on suspicious calls (≈30% of shielded sessions).
      if (
        snapshot.score.risk_score >= LLM_TRIGGER_THRESHOLD &&
        shouldFireLlm(llmLastCalledAt)
      ) {
        void runLlmAndCache({
          session_id: id,
          triggered_categories: snapshot.score.triggered_categories,
          regex_score: snapshot.score.risk_score,
          subject_user_id: user.id,
        });
      }

      // Family alert fan-out at merged score ≥ 75. Idempotent per-session
      // (fireFamilyAlert checks family_alert_fired_at atomically and
      // refuses to fire twice). Privacy level (minimal/default/open) is
      // looked up inside the helper from family_alert_preferences.
      if (finalScore >= FAMILY_ALERT_THRESHOLD) {
        void fireFamilyAlert({
          session_id: id,
          subject_user_id: user.id,
          risk_score: finalScore,
          scam_type: llmScamType ?? snapshot.score.triggered_categories[0] ?? 'unknown',
          matched_red_flags: snapshot.score.rationale.slice(0, 5),
        });
      }

      // Track shield_critical only when new patterns landed AND merged
      // score is critical. Same trigger semantics as v1 but using the
      // merged score so an LLM-escalated call still emits the event.
      if (snapshot.newHitIds.length > 0 && finalLevel === 'critical') {
        void track('shield_critical', {
          userId: user.id,
          properties: {
            risk_score: finalScore,
            categories: snapshot.score.triggered_categories,
            llm_invoked: llmScore !== null,
          },
        });
      }

      // Family-emergency safe-word flow stays as a SECOND alert channel
      // (different kind, different UX). Independent of the family-plan
      // critical alert above — emergency-relative + non-critical can
      // still fire here.
      if (snapshot.newHitIds.length > 0 && emergency) {
        void emitGuardianAlert({
          subjectUserId: user.id,
          kind: 'shield_family_emergency',
          severity: 'warning',
          title: 'Caller is claiming a family emergency',
          body:
            'Someone is claiming to be family and asking for money. We\'ve asked them to ' +
            'verify with a safe word. A real family member will pass this check.',
          payload: { session_id: id },
        });
      }

      return reply.send({
        session_id: id,
        risk_score: finalScore,
        risk_level: finalLevel,
        triggered_categories: snapshot.score.triggered_categories,
        rationale: snapshot.score.rationale,
        // v2 additions: surface the LLM coaching + scam type so iOS can
        // render them inline. Both are null until Claude has spoken on
        // this session for the first time.
        coaching_line: llmCoachingLine,
        llm_scam_type: llmScamType,
        new_warnings: newWarnings,
        family_verify_suggested: emergency,
        family_suggestion: familySuggest,
      });
    },
  );

  // End the session. Locks risk snapshot, records duration + outcome.
  app.post(
    '/v1/live-shield/:id/end',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const parsed = END_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const result = await query<{
        started_at: Date;
        ended_at: Date;
        duration_seconds: number;
        risk_score: number;
        risk_level: string;
        triggered_categories: string[];
      }>(
        `UPDATE call_sessions
            SET ended_at = NOW(),
                outcome = $3,
                duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INT,
                updated_at = NOW()
          WHERE id = $1 AND user_id = $2 AND ended_at IS NULL
         RETURNING started_at, ended_at, duration_seconds, risk_score, risk_level, triggered_categories`,
        [id, user.id, parsed.data.outcome],
      );
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'session_not_found_or_already_ended' });
      }
      const row = result.rows[0]!;

      void track('shield_ended', {
        userId: user.id,
        properties: {
          session_id: id,
          duration_seconds: row.duration_seconds,
          final_risk_score: row.risk_score,
          final_risk_level: row.risk_level,
          triggered_categories: row.triggered_categories,
          outcome: parsed.data.outcome,
        },
      });

      // Founder-dashboard signal — fires only when a critical-risk call
      // ends with the user disengaging (hung up or escalated to their
      // guardian). user_completed / user_abandoned aren't counted because
      // we can't tell from those whether the user fell for the scam.
      if (
        row.risk_level === 'critical' &&
        (parsed.data.outcome === 'user_hung_up' ||
          parsed.data.outcome === 'user_called_guardian')
      ) {
        trackCallBlocked(user.id, {
          sessionId: id,
          riskScore: row.risk_score,
          durationSeconds: row.duration_seconds,
          outcome: parsed.data.outcome,
          triggeredCategories: row.triggered_categories,
        });
      }

      return reply.send({
        session_id: id,
        started_at: row.started_at.toISOString(),
        ended_at: row.ended_at.toISOString(),
        duration_seconds: row.duration_seconds,
        risk_score: row.risk_score,
        risk_level: row.risk_level,
        triggered_categories: row.triggered_categories,
        outcome: parsed.data.outcome,
      });
    },
  );

  // Active session (if any) for the current user — for resume-in-progress.
  // REGISTERED BEFORE /:id so Fastify matches /active literally rather than
  // treating "active" as a session id.
  app.get(
    '/v1/live-shield/active',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const row = await query<{ id: string }>(
        `SELECT id FROM call_sessions
          WHERE user_id = $1 AND ended_at IS NULL
          ORDER BY started_at DESC LIMIT 1`,
        [user.id],
      );
      if (row.rows.length === 0) return reply.send({ active: false });
      return reply.send({ active: true, session_id: row.rows[0]!.id });
    },
  );

  // Get current state. Used for the iOS "resume in-flight shield" flow.
  app.get(
    '/v1/live-shield/:id',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const sess = await query<{
        id: string;
        peer_e164: string | null;
        direction: string;
        started_at: Date;
        ended_at: Date | null;
        risk_score: number;
        risk_level: string;
        triggered_categories: string[];
        outcome: string | null;
      }>(
        `SELECT id, peer_e164, direction, started_at, ended_at, risk_score,
                risk_level, triggered_categories, outcome
           FROM call_sessions WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (sess.rows.length === 0) return reply.code(404).send({ error: 'session_not_found' });
      const hits = await query<{
        pattern_id: string;
        category: string;
        severity: number;
        matched_text: string | null;
        matched_text_ct: string | null;
        created_at: Date;
      }>(
        `SELECT pattern_id, category, severity, matched_text, matched_text_ct, created_at
           FROM scam_phrase_hits WHERE session_id = $1 ORDER BY created_at ASC`,
        [id],
      );
      const row = sess.rows[0]!;
      return reply.send({
        session_id: row.id,
        peer_number: row.peer_e164,
        direction: row.direction,
        started_at: row.started_at.toISOString(),
        ended_at: row.ended_at?.toISOString() ?? null,
        risk_score: row.risk_score,
        risk_level: row.risk_level,
        triggered_categories: row.triggered_categories,
        outcome: row.outcome,
        hits: hits.rows.map((h) => ({
          pattern_id: h.pattern_id,
          label: patternById(h.pattern_id)?.label ?? h.pattern_id,
          category: h.category,
          severity: h.severity,
          matched_text: readMaybeEncrypted(h.matched_text_ct) || h.matched_text || null,
          at: h.created_at.toISOString(),
        })),
      });
    },
  );

}
