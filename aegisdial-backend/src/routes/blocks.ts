import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { normalizeE164 } from '../lib/phone.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { emitMetric } from '../lib/observability.js';

// Live Shield v3 — A2 user-block routes.
//
// A2's founding principle: AegisDial NEVER autonomously blocks anyone.
// Every entry in user_blocks comes from the user explicitly tapping
// "Block" in one of four UI surfaces:
//
//   live_shield_post_call — end-of-Live-Shield-session "Block this caller forever"
//   a1_sources_panel       — A1's "Decline + Block forever" button
//   call_log               — long-press a recent call → Block
//   settings               — manual entry from settings
//
// All four surfaces funnel through POST /v1/blocks. The route writes
// to user_blocks (idempotent on (user_id, e164)) and the iOS Call
// Directory Extension picks up the change on its next sync via
// GET /v1/blocks/snapshot.
//
// Cross-user fraud-graph contribution: when the user has
// family_alert_preferences.cross_user_contribution_enabled = TRUE,
// the block ALSO writes an anonymized signal to the mentions table
// with source = 'aegisdial_user_block'. Other AegisDial users called
// by the same number in the future see this in their A1 sources panel.
// This is the network-effect moat. Toggle controls it; default is ON.
//
// Privacy guarantee (locked in spec): the only data that flows to
// mentions is { e164, source, severity, weight, observed_at }. No
// user identifier, no transcript, no PII. Hour-rounded timestamp.

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const ReasonCodeSchema = z.enum([
  'live_shield_critical',
  'live_shield_post_call',
  'a1_sources_panel',
  'call_log',
  'settings',
  'other',
]);

const SourceSurfaceSchema = z.enum([
  'live_shield_post_call',
  'a1_sources_panel',
  'call_log',
  'settings',
]);

const CreateBlockSchema = z.object({
  e164: z.string().min(5).max(20),
  reason_code: ReasonCodeSchema,
  source_surface: SourceSurfaceSchema,
});

const RetryAttemptSchema = z.object({
  e164: z.string().min(5).max(20),
  attempted_at: z.string().datetime().optional(),
});

const ContributionToggleSchema = z.object({
  enabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function blocksRoutes(app: FastifyInstance): Promise<void> {
  if (!config.V3_A2_ENABLED) {
    // Feature flag is OFF: routes don't register at all. iOS clients
    // hitting them get 404, which is the right signal — feature
    // genuinely isn't available on this backend.
    return;
  }

  // -------------------------------------------------------------------------
  // POST /v1/blocks — create a user block from any of the 4 entry surfaces
  // -------------------------------------------------------------------------

  app.post(
    '/v1/blocks',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = CreateBlockSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }

      const e164 = normalizeE164(parsed.data.e164);
      if (!e164) {
        return reply.code(400).send({ error: 'invalid_phone_number' });
      }

      // Look up cross_user_contribution_enabled BEFORE the insert so
      // the contributed_to_graph flag reflects the user's current
      // toggle state. Default TRUE if no row exists yet (matches
      // the column default in family_alert_preferences).
      const prefs = await query<{ cross_user_contribution_enabled: boolean }>(
        `SELECT cross_user_contribution_enabled
           FROM family_alert_preferences
          WHERE user_id = $1`,
        [user.id],
      );
      const contributesToGraph = prefs.rows[0]?.cross_user_contribution_enabled ?? true;

      // Idempotent insert. If the user has already blocked this number
      // we update the reason_code and source_surface to reflect the
      // most recent block action, but preserve the original blocked_at
      // so retry-attempt history stays meaningful.
      const inserted = await query<{
        id: string;
        blocked_at: Date;
        was_new: boolean;
      }>(
        `INSERT INTO user_blocks
           (user_id, e164, reason_code, source_surface, contributed_to_graph)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, e164)
           DO UPDATE SET reason_code    = EXCLUDED.reason_code,
                         source_surface = EXCLUDED.source_surface
         RETURNING id, blocked_at, (xmax = 0) AS was_new`,
        [
          user.id,
          e164,
          parsed.data.reason_code,
          parsed.data.source_surface,
          contributesToGraph,
        ],
      );

      const row = inserted.rows[0]!;

      // Cross-user contribution: write anonymized signal to mentions
      // when the toggle is on AND this is a NEW block (not a re-block
      // of an existing entry, which would double-count). Errors here
      // do not fail the user-facing request — the user successfully
      // blocked the number even if our graph write hiccups.
      if (contributesToGraph && row.was_new) {
        try {
          await query(
            `INSERT INTO mentions
               (e164, source, source_ref, snippet, sentiment, scam_category,
                severity, weight, observed_at)
             VALUES ($1, 'aegisdial_user_block', $2, NULL, 'negative',
                     NULL, $3, $4, DATE_TRUNC('hour', NOW()))`,
            [
              e164,
              `block:${row.id}`, // opaque ref; user_id never leaves user_blocks
              severityForReason(parsed.data.reason_code),
              0.7, // user-block weight; tuned conservatively — Reddit at 0.5, FCC at 1.0
            ],
          );
          emitMetric('v3.a2.fraud_graph_contributed', { reason: parsed.data.reason_code });
        } catch (err) {
          emitMetric('v3.a2.fraud_graph_contribution_failed', {});
          req.log.warn({ err, e164 }, 'a2_fraud_graph_write_failed');
        }
      }

      emitMetric('v3.a2.block_created', {
        surface: parsed.data.source_surface,
        was_new: row.was_new,
      });

      return reply.code(row.was_new ? 201 : 200).send({
        id: row.id,
        e164,
        blocked_at: row.blocked_at.toISOString(),
        was_new: row.was_new,
        contributed_to_graph: contributesToGraph && row.was_new,
      });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /v1/blocks/:e164 — remove a user block
  // -------------------------------------------------------------------------
  //
  // Rare path. The spec is explicit: AegisDial does NOT surface "unblock"
  // on retry notifications because the user's intent was to block. This
  // route exists for the case where the user changes their mind via the
  // in-app block log.

  app.delete(
    '/v1/blocks/:e164',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { e164: rawE164 } = req.params as { e164: string };
      const e164 = normalizeE164(decodeURIComponent(rawE164));
      if (!e164) {
        return reply.code(400).send({ error: 'invalid_phone_number' });
      }

      const result = await query(
        `DELETE FROM user_blocks WHERE user_id = $1 AND e164 = $2`,
        [user.id, e164],
      );

      emitMetric('v3.a2.block_removed', { found: (result.rowCount ?? 0) > 0 });
      return reply.send({ removed: (result.rowCount ?? 0) > 0 });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/blocks/snapshot — diff-update for the iOS Call Directory Extension
  // -------------------------------------------------------------------------
  //
  // The extension stores its own copy of the user's block list and
  // periodically syncs from this endpoint. `since` is an optional
  // ISO timestamp; without it, the full list is returned.

  app.get(
    '/v1/blocks/snapshot',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const since = (req.query as { since?: string }).since;
      const sinceDate = since ? new Date(since) : null;
      if (since && (!sinceDate || Number.isNaN(sinceDate.getTime()))) {
        return reply.code(400).send({ error: 'invalid_since_timestamp' });
      }

      const result = await query<{ e164: string; blocked_at: Date }>(
        sinceDate
          ? `SELECT e164, blocked_at FROM user_blocks
              WHERE user_id = $1 AND blocked_at > $2
              ORDER BY blocked_at ASC`
          : `SELECT e164, blocked_at FROM user_blocks
              WHERE user_id = $1
              ORDER BY blocked_at ASC`,
        sinceDate ? [user.id, sinceDate] : [user.id],
      );

      return reply.send({
        blocks: result.rows.map((r) => ({
          e164: r.e164,
          blocked_at: r.blocked_at.toISOString(),
        })),
        snapshot_at: new Date().toISOString(),
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/blocks/explain — block detail + retry-attempt history
  // -------------------------------------------------------------------------
  //
  // Powers the in-app block log's tap-to-see-details view AND the
  // tap-to-receipts action on the AEGISDIAL_BLOCK_RETRY notification.

  app.get(
    '/v1/blocks/explain',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const e164Param = (req.query as { e164?: string }).e164;
      if (!e164Param) {
        return reply.code(400).send({ error: 'missing_e164' });
      }
      const e164 = normalizeE164(e164Param);
      if (!e164) {
        return reply.code(400).send({ error: 'invalid_phone_number' });
      }

      const block = await query<{
        id: string;
        blocked_at: Date;
        reason_code: string;
        source_surface: string;
      }>(
        `SELECT id, blocked_at, reason_code, source_surface
           FROM user_blocks
          WHERE user_id = $1 AND e164 = $2`,
        [user.id, e164],
      );

      if (block.rows.length === 0) {
        return reply.code(404).send({ error: 'block_not_found' });
      }

      const retries = await query<{ attempted_at: Date; notification_grouped: boolean }>(
        `SELECT attempted_at, notification_grouped
           FROM block_retry_attempts
          WHERE user_id = $1 AND e164 = $2
          ORDER BY attempted_at DESC
          LIMIT 50`,
        [user.id, e164],
      );

      return reply.send({
        block: {
          id: block.rows[0]!.id,
          e164,
          blocked_at: block.rows[0]!.blocked_at.toISOString(),
          reason_code: block.rows[0]!.reason_code,
          source_surface: block.rows[0]!.source_surface,
        },
        retry_attempts: retries.rows.map((r) => ({
          attempted_at: r.attempted_at.toISOString(),
          grouped_into_digest: r.notification_grouped,
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/blocks/retry-attempt — iOS reports a blocked retry
  // -------------------------------------------------------------------------
  //
  // The iOS Call Directory Extension blocks calls silently at OS level.
  // The host app detects these via CallKit's CXCallObserver call-history
  // diffing on app launch and posts each blocked attempt here.
  //
  // Rate-limited per V3_A2_RETRY_NOTIFY_RATE_PER_24H AND per-number
  // hourly coalescing per V3_A2_RETRY_NOTIFY_PER_NUMBER_HOURLY. The
  // actual push is dispatched asynchronously by a worker (Phase 2 wires
  // the worker; for now this route just records the attempt and
  // sets notification_sent based on rate-limit eligibility).

  app.post(
    '/v1/blocks/retry-attempt',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = RetryAttemptSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }

      const e164 = normalizeE164(parsed.data.e164);
      if (!e164) {
        return reply.code(400).send({ error: 'invalid_phone_number' });
      }

      // Defensive: only accept retry-attempt reports for numbers the
      // user has actually blocked. Otherwise the iOS app could create
      // arbitrary entries and trigger arbitrary push notifications —
      // a rate-limit-evasion vector.
      const isBlocked = await query<{ blocked: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM user_blocks WHERE user_id = $1 AND e164 = $2
         ) AS blocked`,
        [user.id, e164],
      );
      if (!isBlocked.rows[0]?.blocked) {
        return reply.code(409).send({ error: 'number_not_blocked' });
      }

      const attemptedAt = parsed.data.attempted_at
        ? new Date(parsed.data.attempted_at)
        : new Date();

      // Rate-limit logic. Atomically count attempts by this user in
      // the last 24h AND attempts to/from this number in the last
      // hour, then decide whether to flag this attempt as
      // notification-eligible or roll into the daily digest.
      const dayCount = await query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
           FROM block_retry_attempts
          WHERE user_id = $1
            AND attempted_at > NOW() - INTERVAL '24 hours'
            AND notification_sent = TRUE
            AND notification_grouped = FALSE`,
        [user.id],
      );
      const recentDayCount = parseInt(dayCount.rows[0]?.count ?? '0', 10);

      const hourCount = await query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
           FROM block_retry_attempts
          WHERE user_id = $1
            AND e164 = $2
            AND attempted_at > NOW() - INTERVAL '1 hour'
            AND notification_sent = TRUE`,
        [user.id, e164],
      );
      const recentHourCount = parseInt(hourCount.rows[0]?.count ?? '0', 10);

      const eligibleForIndividualPush =
        recentDayCount < config.V3_A2_RETRY_NOTIFY_RATE_PER_24H &&
        recentHourCount < config.V3_A2_RETRY_NOTIFY_PER_NUMBER_HOURLY;

      const inserted = await query<{ id: string }>(
        `INSERT INTO block_retry_attempts
           (user_id, e164, attempted_at, notification_sent, notification_grouped)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          user.id,
          e164,
          attemptedAt,
          eligibleForIndividualPush,
          !eligibleForIndividualPush,
        ],
      );

      emitMetric('v3.a2.retry_attempt_recorded', {
        eligible_for_individual_push: eligibleForIndividualPush,
      });

      // TODO(Phase 2 worker): if eligibleForIndividualPush, enqueue an
      // APNs send for the AEGISDIAL_BLOCK_RETRY category. For now the
      // attempt is recorded and the iOS client can poll
      // GET /v1/blocks/explain to see retry history.

      return reply.code(201).send({
        id: inserted.rows[0]!.id,
        attempted_at: attemptedAt.toISOString(),
        notification_eligible: eligibleForIndividualPush,
        notification_grouped: !eligibleForIndividualPush,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/blocks/contribution-toggle — flip cross_user_contribution
  // -------------------------------------------------------------------------
  //
  // Single source of truth for the cross-user fraud-graph contribution
  // setting. Affects A1's "Decline + Block" action AND A2's block
  // entries. Default is ON; user can disable in Settings.

  app.post(
    '/v1/blocks/contribution-toggle',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = ContributionToggleSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body' });
      }

      // family_alert_preferences row may not exist yet for this user
      // (some v2 users never opened the family-alert settings screen).
      // UPSERT on the row, defaulting privacy_level to 'default'.
      await query(
        `INSERT INTO family_alert_preferences
           (user_id, privacy_level, cross_user_contribution_enabled)
         VALUES ($1, 'default', $2)
         ON CONFLICT (user_id)
           DO UPDATE SET cross_user_contribution_enabled = EXCLUDED.cross_user_contribution_enabled,
                         updated_at = NOW()`,
        [user.id, parsed.data.enabled],
      );

      emitMetric('v3.a2.contribution_toggled', { enabled: parsed.data.enabled });
      return reply.send({ cross_user_contribution_enabled: parsed.data.enabled });
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityForReason(reason: z.infer<typeof ReasonCodeSchema>): number {
  // 0–10 scale matching the existing mentions.severity convention.
  // Critical-Live-Shield blocks carry the highest weight because
  // they're corroborated by AegisDial's own scoring — not just
  // user judgment.
  switch (reason) {
    case 'live_shield_critical':
      return 9;
    case 'live_shield_post_call':
      return 7;
    case 'a1_sources_panel':
      return 6;
    case 'call_log':
      return 5;
    case 'settings':
      return 5;
    default:
      return 5;
  }
}
