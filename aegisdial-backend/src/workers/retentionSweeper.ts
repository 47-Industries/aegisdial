import cron from 'node-cron';
import { query } from '../lib/db.js';

// Data retention sweeper. Trims PII + telemetry tables after fixed windows
// so we don't keep user data forever. Windows are tuned for the smallest
// useful observability cost — enough to debug last month's incidents but
// not enough to build a dossier.
//
// Windows:
//   call_sessions          90 days   — longest-lived, for cohort analysis
//   transcript_events      30 days   — Live Shield transcripts (highest-sensitivity)
//   metric_counters        30 days   — roll-up counters for dashboards
//   analytics_events       180 days  — product funnels (phi-free)
//   email_messages         365 days  — outbound deliverability history
//
// Runs daily at 04:07 UTC. Deletes are idempotent — a second run is a no-op.

const DAILY_CRON = '7 4 * * *';

interface SweepSpec {
  table: string;
  column: string;
  days: number;
}

// NOTE: if a table doesn't exist (e.g. older deploy), the sweeper logs and
// continues — deliberate so a stale schema doesn't wedge the cron.
//
// Windows are tuned to the smallest useful debug surface. Anything that
// holds decrypted-on-demand customer PII (recovery_*, transcript_events,
// phone_lookups) trims on the shorter end of its usefulness window.
const SPECS: SweepSpec[] = [
  // Live Shield call session + transcript chunks. Transcripts are the
  // highest-sensitivity artifact we store — both the parent row (retained
  // 90d for cohort debugging) and the child rows (30d by policy).
  //
  // Historical bug: this used column='created_at' which doesn't exist on
  // transcript_events (actual column is received_at), so the DELETE
  // silently errored every run and transcripts were NEVER trimmed —
  // they piggybacked on the 90d parent cascade. Fix documented in audit.
  { table: 'call_sessions', column: 'started_at', days: 90 },
  { table: 'transcript_events', column: 'received_at', days: 30 },
  // Recovery Concierge — sessions, evidence, companion chat, outcomes.
  // Companion messages are the most sensitive (raw confessions to the
  // AI) and per migration 023 are meant to drop at 30d. Sessions +
  // their aggregates hold for ~2y post-completion for longitudinal
  // outcome reporting, then drop.
  { table: 'recovery_companion_messages', column: 'created_at', days: 30 },
  { table: 'recovery_evidence', column: 'created_at', days: 730 },
  { table: 'recovery_outcomes', column: 'created_at', days: 730 },
  { table: 'recovery_sessions', column: 'started_at', days: 730 },
  // Number enrichment cache — rows carry expires_at. Anything expired
  // more than a day ago is dead weight (still costs AES-GCM decrypt
  // on reads) — hard-delete.
  { table: 'phone_lookups', column: 'expires_at', days: 1 },
  // Alert tables grow per-breach-per-user / per-guardian-fanout forever
  // if we don't trim. 365d keeps an entire year of audit trail.
  { table: 'guardian_alerts', column: 'created_at', days: 365 },
  { table: 'breach_alerts', column: 'created_at', days: 365 },
  // SMS filter + URL rep are opportunistic caches — trim on the short end.
  { table: 'sms_classifications', column: 'created_at', days: 90 },
  { table: 'url_reputations', column: 'checked_at', days: 7 },
  // Dashboards / funnels / deliverability.
  { table: 'metric_counters', column: 'bucket', days: 30 },
  { table: 'analytics_events', column: 'created_at', days: 180 },
  { table: 'email_messages', column: 'created_at', days: 365 },
  // Anonymous Paste-a-Text trial tracking — 3-day trial expires long
  // before this; 30 days of grace lets us see lapsed anonymous users
  // who came back after expiry. After that they're noise.
  { table: 'anonymous_analyzer_trials', column: 'first_seen_at', days: 30 },
];

export interface RetentionSweepResult {
  table: string;
  deleted: number;
  skipped: boolean;
  reason?: string;
}

export async function runRetentionSweepOnce(): Promise<RetentionSweepResult[]> {
  const out: RetentionSweepResult[] = [];
  for (const spec of SPECS) {
    try {
      const res = await query(
        `DELETE FROM ${spec.table}
          WHERE ${spec.column} < NOW() - ($1 || ' days')::INTERVAL`,
        [String(spec.days)],
      );
      out.push({ table: spec.table, deleted: res.rowCount ?? 0, skipped: false });
    } catch (err) {
      // Most likely: table doesn't exist on this deploy, or the column is
      // named differently. Log and skip — we'd rather keep the cron healthy
      // than crash the process for one missing table.
      out.push({
        table: spec.table,
        deleted: 0,
        skipped: true,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export interface RetentionSweeperHandle {
  task: cron.ScheduledTask;
}

export function startRetentionSweeper(): RetentionSweeperHandle {
  const task = cron.schedule(
    DAILY_CRON,
    () => {
      void (async () => {
        const started = Date.now();
        const results = await runRetentionSweepOnce();
        // eslint-disable-next-line no-console
        console.log('[retention-sweeper] complete', {
          duration_ms: Date.now() - started,
          results,
        });
      })();
    },
    { timezone: 'UTC' },
  );
  return { task };
}

export function stopRetentionSweeper(handle: RetentionSweeperHandle): void {
  handle.task.stop();
}
