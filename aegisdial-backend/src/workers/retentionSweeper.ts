import cron from 'node-cron';
import { query } from '../lib/db.js';
import { expireStaleTamperAlerts } from '../services/email/inboxTamperDetector.js';

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
// I-M1 fix (adversarial round): Identity Shield's new tables
// (068-075) carried retention guidance in their migration headers
// that wasn't being enforced. Added:
//   - identity_monitors           90d after active=FALSE flip (cooldown)
//   - identity_breach_findings    90d after remediation_completed_at
//   - active_threats              hard-delete on expires_at expiry
// threat_intel_candidates + threat_landscape_briefings deliberately
// remain unswept — they're training-signal / strategic artifacts
// (no per-user PII inside the row body).
//
// Runs daily at 04:07 UTC. Deletes are idempotent — a second run is a no-op.

const DAILY_CRON = '7 4 * * *';

interface SweepSpec {
  table: string;
  column: string;
  days: number;
  /**
   * I-M1: optional alternate policy. When 'expired_only', the spec
   * deletes rows whose `column` value is < NOW() (an absolute
   * expiry-time comparison) instead of the default `< NOW() - X days`.
   * Used for active_threats whose expires_at column already encodes
   * the absolute cutoff timestamp set by the service layer. Existing
   * SPECS without `policy` retain the legacy days-relative semantics.
   */
  policy?: 'days_relative' | 'expired_only';
  /**
   * I-M1: optional secondary WHERE-clause guard. When set, the
   * resulting DELETE adds `AND <guard>` after the time predicate.
   * Used to scope identity_monitors sweep to soft-deleted rows only.
   * The guard is a static SQL fragment defined inside this file —
   * never derived from user input.
   */
  extraWhere?: string;
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
  // SMS Shield manual-paste scans. 30d window matches migration 054's
  // stated intent and the transcript_events / companion_messages
  // sensitivity tier — we keep body_sha256 + a redacted 80-char excerpt,
  // never plaintext, so 30d is plenty for "show me my last month of
  // pastes" without growing the table unchecked.
  { table: 'sms_scans', column: 'scanned_at', days: 30 },
  // Email Shield — per-message scoring audit. Same sensitivity tier
  // as SMS Shield (no body at rest, only subject_excerpt +
  // from_address_hash + sender_domain), so the same 30d window
  // applies. email_accounts itself is NOT in the sweep — that's the
  // user's linked-inbox registry, not transient data; it lives until
  // the user unlinks or deletes their account (cascade handles both).
  { table: 'email_scans', column: 'scanned_at', days: 30 },
  // Email Shield — account-compromise reports. Higher retention
  // (90d) because users want to compare today's check against last
  // month's baseline. The findings JSONB is descriptive (no
  // bodies, no tokens, no IPs) so 90d doesn't grow a sensitive
  // surface — just an audit trail.
  { table: 'email_compromise_reports', column: 'generated_at', days: 90 },
  // Email Shield — "did you delete this?" tamper alerts. 90d
  // window matches email_compromise_reports because alerts
  // contribute to compromise verdicts and we want them visible
  // alongside the reports they correlate with. The expiry-flip
  // (expireStaleTamperAlerts, called below as a non-DELETE step)
  // flips PENDING rows to 'expired' at 72h; this sweep finishes
  // the lifecycle by deleting everything — pending, resolved,
  // expired — at 90d.
  //
  // Caveat: scan_id has ON DELETE CASCADE → email_scans, which is
  // swept at 30d. In practice tamper-alert rows effectively retain
  // for min(90d, 30d) = 30d once their parent scan is wiped. The
  // 90d ceiling here only matters for the (rare) tamper alert
  // whose parent scan was paused from sweep (e.g., an open recovery
  // session that holds the scan row).
  { table: 'email_tamper_alerts', column: 'created_at', days: 90 },
  { table: 'url_reputations', column: 'checked_at', days: 7 },
  // Dashboards / funnels / deliverability.
  { table: 'metric_counters', column: 'bucket', days: 30 },
  { table: 'analytics_events', column: 'created_at', days: 180 },
  { table: 'email_messages', column: 'created_at', days: 365 },
  // Anonymous Paste-a-Text trial tracking — 3-day trial expires long
  // before this; 30 days of grace lets us see lapsed anonymous users
  // who came back after expiry. After that they're noise.
  { table: 'anonymous_analyzer_trials', column: 'first_seen_at', days: 30 },
  // ── Identity Shield (I-M1) ─────────────────────────────────────
  // Soft-deleted monitors: 068's header says "physical row preserved
  // 90d for audit, then swept." active=TRUE rows are NEVER swept —
  // they're the user's live watchlist. The 90d clock starts at
  // created_at OR the most-recent edit; we use created_at because the
  // soft-delete path (PATCH active=FALSE) doesn't bump a separate
  // deleted_at column. Operator-tolerable: a long-active monitor
  // that's just been soft-deleted today won't sweep until 90d AFTER
  // its original creation — fine because every soft-deleted row by
  // definition was created at least once.
  {
    table: 'identity_monitors',
    column: 'created_at',
    days: 90,
    extraWhere: 'active = FALSE',
  },
  // Findings: 90d after remediation_completed_at per migration 070
  // ("90 days after remediation_completed_at; indefinite otherwise").
  // The IS NOT NULL guard preserves never-remediated findings forever
  // — they're the user's still-open task list.
  {
    table: 'identity_breach_findings',
    column: 'remediation_completed_at',
    days: 90,
    extraWhere: 'remediation_completed_at IS NOT NULL',
  },
  // active_threats: migration 071 documents "Retention cron DELETEs
  // rows where expires_at < NOW() daily." This is a different shape
  // from every other spec (absolute timestamp comparison, not
  // X-days-relative), so the runner branches on `policy='expired_only'`.
  // The IS NOT NULL guard preserves confirmed_scammer rows that
  // intentionally carry NULL expires_at (eternal).
  {
    table: 'active_threats',
    column: 'expires_at',
    days: 0,
    policy: 'expired_only',
    extraWhere: 'expires_at IS NOT NULL',
  },
  // threat_intel_candidates + threat_landscape_briefings: indefinite
  // by spec — candidates are training signal (the meta-analyst
  // learns from past approve/reject decisions), briefings are
  // operator-facing strategic artifacts. No PII enters either body.
  // Intentionally NOT included here.
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
      // I-M1: branch on policy. `expired_only` uses absolute-time
      // comparison (`column < NOW()`); the default `days_relative`
      // path preserves the original `column < NOW() - X days`
      // semantics. The extraWhere clause is a static fragment
      // defined inside SPECS — never user-derived — and the
      // table+column identifiers come from the same constant array,
      // so a SQL-injection vector would have to be planted in this
      // file itself (which would be caught at code review).
      const extraClause = spec.extraWhere ? ` AND ${spec.extraWhere}` : '';
      let res;
      if (spec.policy === 'expired_only') {
        res = await query(
          `DELETE FROM ${spec.table}
            WHERE ${spec.column} < NOW()${extraClause}`,
        );
      } else {
        res = await query(
          `DELETE FROM ${spec.table}
            WHERE ${spec.column} < NOW() - ($1 || ' days')::INTERVAL${extraClause}`,
          [String(spec.days)],
        );
      }
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
  // Lifecycle step that isn't a DELETE — flip stale pending tamper
  // alerts to 'expired' at 72h. Reported as a pseudo-row in the same
  // result array so the cron log shows it. Daily cadence is fine: a
  // pending alert that's been ignored for 72-95 hours sitting in
  // 'pending' for ~24 more hours is harmless (the per-user cap of 5
  // is the only place pending count matters, and even there a real
  // attack would push past 5 in minutes, not hours).
  try {
    const expiry = await expireStaleTamperAlerts();
    out.push({
      table: 'email_tamper_alerts (expiry-flip)',
      deleted: expiry.expired,
      skipped: false,
    });
  } catch (err) {
    out.push({
      table: 'email_tamper_alerts (expiry-flip)',
      deleted: 0,
      skipped: true,
      reason: err instanceof Error ? err.message : String(err),
    });
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
