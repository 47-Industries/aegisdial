import cron from 'node-cron';
import { query } from '../lib/db.js';
import { sendToUser } from '../lib/apns.js';
import { captureError, emitMetric } from '../lib/observability.js';

// Push dispatcher worker. Reads rows where pushed_at IS NULL and fans
// out a push via APNs. Runs on a short cron (every 30 seconds by
// default) — not real-time, but fast enough for "someone just answered
// a scam call, notify the guardian" UX.
//
// Two tables feed this:
//   - guardian_alerts    — family critical events (shield, safe word)
//   - breach_alerts      — new exposure from Enzoic
//
// The breach table only has pushed_at on guardian fan-out via
// guardian_alerts (breach events emit a guardian row when new). The
// user's own breach notification is handled via separate self-push below.

const CRON_EXPR = '*/30 * * * * *'; // every 30 seconds

export interface DispatcherHandle {
  task: cron.ScheduledTask;
}

interface GuardianRow {
  id: string;
  guardian_user_id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
}

const BATCH_SIZE = 200;
const MAX_BATCHES_PER_TICK = 10; // safety cap: 2000 alerts per tick

export async function dispatchPending(): Promise<{ delivered: number; attempted: number }> {
  let attempted = 0;
  let delivered = 0;

  // Loop-until-empty (bounded). A single mass-breach event could
  // generate more than BATCH_SIZE rows; we drain the queue within a
  // tick so latency doesn't stack up.
  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    const pending = await query<GuardianRow>(
      `SELECT id, guardian_user_id, kind, severity, title, body, payload
         FROM guardian_alerts
        WHERE pushed_at IS NULL
        ORDER BY created_at ASC
        LIMIT $1`,
      [BATCH_SIZE],
    );
    if (pending.rows.length === 0) break;

    // Concurrent fan-out. APNs HTTP/2 multiplexes natively and a typical
    // batch of 200 rows with a 25-way pool cuts wall-clock from ~20s to
    // ~800ms without stressing Apple's rate limits (we're nowhere near
    // the documented 10k/connection).
    const CONCURRENCY = 25;
    const pushedIds: string[] = [];
    const rows = pending.rows;
    let idx = 0;
    async function worker() {
      while (idx < rows.length) {
        const row = rows[idx++]!;
        attempted++;
        try {
          // CRITICAL bug fix from Phase 5 adversarial review: lift the
          // interruption-level / relevance-score hints from payload
          // up to the typed PushPayload fields so apns.ts actually
          // sets the aps.interruption-level header. Without this,
          // every shield_takeover would silently downgrade to default
          // priority and Mom on Silent/DND would never see it.
          const interruption =
            (row.payload?.interruption_level_request as
              | 'passive'
              | 'active'
              | 'time-sensitive'
              | 'critical'
              | undefined) ?? undefined;
          const interruptionFallback =
            (row.payload?.interruption_level_fallback as
              | 'passive'
              | 'active'
              | 'time-sensitive'
              | 'critical'
              | undefined) ?? undefined;
          const relevance =
            typeof row.payload?.relevance_score === 'number'
              ? (row.payload.relevance_score as number)
              : undefined;

          const count = await sendToUser({
            userId: row.guardian_user_id,
            title: row.title,
            body: row.body,
            threadId: `guardian-${row.kind}`,
            // Effective interruption level: requested if the entitlement
            // path is wired (handled inside apns.ts when we have the
            // Critical Alerts entitlement); fallback otherwise.
            interruptionLevel: interruption ?? interruptionFallback,
            // High urgency for shield_takeover and shield_post_dismiss.
            // block_retry uses passive (default priority is fine).
            priority:
              row.kind === 'shield_takeover' || row.kind === 'shield_post_dismiss'
                ? 10
                : undefined,
            relevanceScore: relevance,
            data: {
              alert_id: row.id,
              kind: row.kind,
              severity: row.severity,
              ...row.payload,
            },
          });
          if (count > 0) delivered++;
          pushedIds.push(row.id);
        } catch (err) {
          captureError(err, { component: 'pushDispatcher.guardian', alert_id: row.id });
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker()),
    );

    // Batched UPDATE — one round-trip instead of N. Always mark pushed
    // (even when count=0) so we don't loop forever on users with no
    // registered devices.
    if (pushedIds.length > 0) {
      await query(
        `UPDATE guardian_alerts SET pushed_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [pushedIds],
      );
    }

    if (pending.rows.length < BATCH_SIZE) break; // queue drained
  }

  if (attempted > 0) {
    void emitMetric('push.dispatcher_run', {}, attempted);
    void emitMetric('push.dispatcher_delivered', {}, delivered);
  }
  return { attempted, delivered };
}

export function startPushDispatcher(): DispatcherHandle {
  const task = cron.schedule(
    CRON_EXPR,
    () => {
      void dispatchPending();
    },
    { timezone: 'UTC' },
  );
  return { task };
}

export function stopPushDispatcher(handle: DispatcherHandle): void {
  handle.task.stop();
}
