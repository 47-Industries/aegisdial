import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { emitMetric } from '../lib/observability.js';
import { registerFireHandler } from '../services/sentinelMatcher.js';
import { armPostDismissWatch } from '../services/postDismissWatcher.js';
import {
  emitSystemEvent,
  b3TakeoverFired,
  b3TakeoverDismissed,
} from '../services/transcriptEvents.js';

// Live Shield v3 — B3 critical-takeover routes.
//
// Two routes + one in-process registration:
//
//   POST /v1/push/critical-takeover
//     Internal-only — the Live Shield risk scorer + sentinel matcher
//     call this when they detect a critical event that warrants a
//     full-screen takeover on Mom's iPhone. Records the takeover
//     event and (Phase 3 wires the actual APNs delivery) queues
//     the critical-priority push.
//
//   POST /v1/sessions/:id/dismiss
//     iOS reports the user completed the 3-second long-press on
//     "I'm safe". Records the dismiss event in b3_dismiss_events
//     and arms the post-dismiss watcher. The watcher fires the
//     family alert if continuous-critical persists for
//     V3_B3_POST_DISMISS_FAMILY_ALERT_SECONDS (default 30s).
//
// In-process registration:
//   The sentinel matcher uses dependency injection to fire takeovers
//   without itself depending on the route's HTTP machinery. We
//   register a concrete handler here at module load that funnels
//   sentinel matches through the same dispatch path the explicit
//   POST route uses.

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TriggerPathSchema = z.enum(['live_shield_critical', 'sentinel_keyword', 'b4_finding']);

const CriticalTakeoverSchema = z.object({
  session_id: z.string().uuid(),
  trigger_path: TriggerPathSchema,
  risk_score: z.number().int().min(0).max(100),
  // Optional payload that varies by trigger:
  //   live_shield_critical → empty
  //   sentinel_keyword     → { pattern_name, matched_text, scammer_context_match }
  //   b4_finding           → { claim_type, raw_quote, finding_id }
  context: z.record(z.unknown()).optional(),
});

const DismissSchema = z.object({
  takeover_kind: z.enum(['b3', 'b4']),
  trigger_path: TriggerPathSchema,
  takeover_fired_at: z.string().datetime(),
  score_at_dismiss: z.number().int().min(0).max(100),
  scam_type: z.string().min(1).max(64).default('unknown'),
  matched_red_flags: z.array(z.string()).max(20).default([]),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function criticalTakeoverRoutes(app: FastifyInstance): Promise<void> {
  if (!config.V3_B3_ENABLED) {
    return;
  }

  // -------------------------------------------------------------------------
  // POST /v1/push/critical-takeover
  // -------------------------------------------------------------------------
  //
  // Records the takeover event in call_sessions.b3_takeover_fired_at
  // and emits the system_event marker into the family transcript
  // stream. Phase 3 wires the actual APNs critical-priority push;
  // for now this route is the official "the takeover is happening"
  // signal, and iOS clients can be wired in Phase 3 to receive it.

  app.post(
    '/v1/push/critical-takeover',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = CriticalTakeoverSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }

      const owned = await query<{ ended_at: Date | null }>(
        `SELECT ended_at FROM call_sessions WHERE id = $1 AND user_id = $2`,
        [parsed.data.session_id, user.id],
      );
      if (owned.rows.length === 0) {
        return reply.code(404).send({ error: 'session_not_found' });
      }
      if (owned.rows[0]!.ended_at) {
        return reply.code(409).send({ error: 'session_ended' });
      }

      // Atomic claim of the b3_takeover_fired_at flag — only the FIRST
      // takeover per session populates it. Subsequent fires (e.g. B4
      // landing a contradicted finding after B3 already fired) are
      // recorded for audit but don't update the timestamp.
      const claim = await query(
        `UPDATE call_sessions
            SET b3_takeover_fired_at = NOW()
          WHERE id = $1 AND b3_takeover_fired_at IS NULL`,
        [parsed.data.session_id],
      );
      const wasFirstTakeover = (claim.rowCount ?? 0) > 0;

      emitMetric('v3.b3.takeover_fired', {
        trigger_path: parsed.data.trigger_path,
        was_first: wasFirstTakeover,
      });

      // Transcript marker for the family transcript view.
      void emitSystemEvent(
        b3TakeoverFired(parsed.data.session_id, user.id, {
          trigger_path: parsed.data.trigger_path,
        }),
      );

      // TODO(Phase 3): enqueue an APNs critical-priority push via
      // pushDispatcher with category AEGISDIAL_CRITICAL_TAKEOVER.
      // The push payload should carry trigger_path + context so the
      // iOS CriticalInterruptView can render the right copy:
      //   live_shield_critical → "STOP — SCAM CONFIRMED"
      //   sentinel_keyword     → "STOP — DO NOT SHARE INFO"
      //   b4_finding           → "AT 3:14 PM, THE CALLER SAID..."

      return reply.code(201).send({
        session_id: parsed.data.session_id,
        was_first_takeover: wasFirstTakeover,
        fired_at: new Date().toISOString(),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/sessions/:id/dismiss
  // -------------------------------------------------------------------------

  app.post(
    '/v1/sessions/:id/dismiss',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };

      const parsed = DismissSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }

      const owned = await query<{ ended_at: Date | null; risk_level: string; risk_score: number }>(
        `SELECT ended_at, risk_level, risk_score
           FROM call_sessions WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (owned.rows.length === 0) {
        return reply.code(404).send({ error: 'session_not_found' });
      }
      if (owned.rows[0]!.ended_at) {
        return reply.code(409).send({ error: 'session_ended' });
      }

      const takeoverFiredAt = new Date(parsed.data.takeover_fired_at);
      const dismissedAt = new Date();

      // Persist audit-trail row in b3_dismiss_events.
      await query(
        `INSERT INTO b3_dismiss_events
           (session_id, user_id, takeover_fired_at, dismissed_at,
            score_at_dismiss, trigger_path)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          user.id,
          takeoverFiredAt,
          dismissedAt,
          parsed.data.score_at_dismiss,
          parsed.data.trigger_path,
        ],
      );

      // Mark the dismiss timestamp on the session for post-call recap.
      await query(
        `UPDATE call_sessions
            SET b3_takeover_dismissed_at = COALESCE(b3_takeover_dismissed_at, $2)
          WHERE id = $1`,
        [id, dismissedAt],
      );

      // Arm the post-dismiss watcher. If continuous-critical persists
      // for V3_B3_POST_DISMISS_FAMILY_ALERT_SECONDS (default 30s),
      // the watcher fires the post-dismiss family alert via
      // firePostDismissFamilyAlert.
      armPostDismissWatch({
        session_id: id,
        user_id: user.id,
        current_level: owned.rows[0]!.risk_level as 'low' | 'medium' | 'high' | 'critical',
        current_score: owned.rows[0]!.risk_score,
        scam_type: parsed.data.scam_type,
        matched_red_flags: parsed.data.matched_red_flags,
      });

      const secondsToDismiss = Math.max(
        0,
        Math.round((dismissedAt.getTime() - takeoverFiredAt.getTime()) / 1000),
      );
      emitMetric('v3.b3.takeover_dismissed', {
        trigger_path: parsed.data.trigger_path,
        seconds_to_dismiss: secondsToDismiss,
      });

      void emitSystemEvent(
        b3TakeoverDismissed(id, user.id, {
          score_at_dismiss: parsed.data.score_at_dismiss,
          seconds_to_dismiss: secondsToDismiss,
        }),
      );

      return reply.code(201).send({
        session_id: id,
        dismissed_at: dismissedAt.toISOString(),
        post_dismiss_watch_armed: true,
        post_dismiss_alert_in_seconds: config.V3_B3_POST_DISMISS_FAMILY_ALERT_SECONDS,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Sentinel matcher fire-handler registration
// ---------------------------------------------------------------------------
//
// The sentinel matcher needs a way to dispatch takeovers without
// itself owning HTTP machinery. We register a function here at
// startup that internally executes the same takeover-fire logic
// the POST route does. The result: a sentinel match fires a
// real takeover even though no HTTP call was made.

let fireHandlerRegistered = false;

/**
 * Wire up the sentinel matcher's fire handler. Idempotent —
 * subsequent calls are no-ops. Called from server.ts at boot.
 */
export function registerCriticalTakeoverHandlers(): void {
  if (fireHandlerRegistered) return;
  if (!config.V3_B3_ENABLED) return;

  registerFireHandler(async ({ session_id, user_id, pattern_name, matched_text }) => {
    try {
      // Atomic claim of the takeover_fired_at flag.
      const claim = await query(
        `UPDATE call_sessions
            SET b3_takeover_fired_at = NOW()
          WHERE id = $1 AND b3_takeover_fired_at IS NULL`,
        [session_id],
      );
      const wasFirst = (claim.rowCount ?? 0) > 0;

      emitMetric('v3.b3.takeover_fired_via_sentinel', {
        pattern: pattern_name,
        was_first: wasFirst,
      });

      void emitSystemEvent(
        b3TakeoverFired(session_id, user_id, {
          trigger_path: 'sentinel_keyword',
        }),
      );

      // TODO(Phase 3): enqueue APNs critical-priority push for the
      // iOS app. Same dispatch path the POST route uses; for now we
      // record the event and the iOS post-call recap shows the
      // pattern that fired.
      void matched_text; // kept for the upcoming push payload wire-up
    } catch (err) {
      emitMetric('v3.b3.sentinel_fire_handler_threw', { pattern: pattern_name });
      // eslint-disable-next-line no-console
      console.error('[criticalTakeover] sentinel fire handler threw', {
        session_id,
        pattern: pattern_name,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fireHandlerRegistered = true;
}
