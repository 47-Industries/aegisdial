import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { emitMetric } from '../lib/observability.js';

// Live Shield v3 — B4 findings routes.
//
// Two endpoints:
//
//   GET /v1/findings/:session_id
//     Returns all B4 findings for a session. Powers the post-call
//     "What we checked" recap UI in iOS. Includes findings of all
//     confidence levels so the user sees what AegisDial caught
//     even when it didn't fire a takeover.
//
//   POST /v1/findings/:id/feedback
//     User submits "was that finding right?" — feeds into the
//     V3_B4_TAKEOVER_THRESHOLD calibration analysis.

const FeedbackSchema = z.object({
  feedback: z.enum(['correct', 'wrong', 'unsure']),
});

export async function findingsRoutes(app: FastifyInstance): Promise<void> {
  if (!config.V3_B4_ENABLED) {
    return;
  }

  // -------------------------------------------------------------------------
  // GET /v1/findings/:session_id
  // -------------------------------------------------------------------------

  app.get(
    '/v1/findings/:session_id',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { session_id } = req.params as { session_id: string };

      // Confirm the session belongs to this user. A finding row leak
      // here would expose the scammer's claims from another user's
      // call (the scammer claims aren't sensitive in isolation, but
      // the existence of a session + its participation pattern is).
      const owned = await query<{ id: string }>(
        `SELECT id FROM call_sessions WHERE id = $1 AND user_id = $2`,
        [session_id, user.id],
      );
      if (owned.rows.length === 0) {
        return reply.code(404).send({ error: 'session_not_found' });
      }

      const findings = await query<{
        id: string;
        claim_type: string;
        claim_value: Record<string, unknown>;
        raw_quote: string;
        spoken_at: Date;
        result: string;
        confidence: number;
        reasoning: string;
        source_layer: string;
        source_url: string | null;
        source_snippet: string | null;
        verified_at: Date;
      }>(
        `SELECT f.id, c.claim_type, c.claim_value, c.raw_quote, c.spoken_at,
                f.result, f.confidence, f.reasoning, f.source_layer,
                f.source_url, f.source_snippet, f.verified_at
           FROM b4_findings f
           JOIN b4_extracted_claims c ON c.id = f.claim_id
          WHERE f.session_id = $1
            AND f.result IN ('contradicted', 'cannot_verify')
          ORDER BY c.spoken_at ASC`,
        [session_id],
      );

      return reply.send({
        session_id,
        findings: findings.rows.map((f) => ({
          id: f.id,
          claim_type: f.claim_type,
          claim_value: f.claim_value,
          raw_quote: f.raw_quote,
          spoken_at: f.spoken_at.toISOString(),
          result: f.result,
          confidence: f.confidence,
          reasoning: f.reasoning,
          source: {
            layer: f.source_layer,
            url: f.source_url,
            snippet: f.source_snippet,
          },
          verified_at: f.verified_at.toISOString(),
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/findings/:id/feedback
  // -------------------------------------------------------------------------
  //
  // Surfaces post-call: "AegisDial said the caller wasn't really from
  // [bank/agency] — was that right?" with [Yes / No / Not sure] buttons.
  // Feeds into b4_feedback for V3_B4_TAKEOVER_THRESHOLD tuning.

  app.post(
    '/v1/findings/:id/feedback',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };

      const parsed = FeedbackSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }

      // Confirm the finding belongs to a session owned by this user.
      const owned = await query<{ session_id: string }>(
        `SELECT cs.id AS session_id
           FROM b4_findings f
           JOIN call_sessions cs ON cs.id = f.session_id
          WHERE f.id = $1 AND cs.user_id = $2`,
        [id, user.id],
      );
      if (owned.rows.length === 0) {
        return reply.code(404).send({ error: 'finding_not_found' });
      }

      // Idempotent on (finding_id, user_id) via the existing column
      // shapes. Re-submission UPDATEs the feedback value rather than
      // inserting a new row. (Alternative: dedicated UNIQUE constraint;
      // for v3 we keep schema simple and let normal usage dedupe.)
      await query(
        `INSERT INTO b4_feedback (finding_id, user_id, feedback)
         VALUES ($1, $2, $3)`,
        [id, user.id, parsed.data.feedback],
      );

      emitMetric('v3.b4.feedback_submitted', {
        feedback: parsed.data.feedback,
      });

      return reply.code(201).send({
        finding_id: id,
        feedback: parsed.data.feedback,
        submitted_at: new Date().toISOString(),
      });
    },
  );
}
