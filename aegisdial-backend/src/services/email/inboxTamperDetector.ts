import { query } from '../../lib/db.js';
import { sendToUser } from '../../lib/apns.js';
import { emitMetric, captureError } from '../../lib/observability.js';

// Email Shield — inbox-tamper detector.
//
// The compromise-check Pillar 3 detectors (inbox-rules, OAuth
// grants, login anomalies) catch CONFIGURATION-level compromise:
// the attacker who set up a forwarding rule, granted a malicious
// app, or logged in from Lagos at 3am. This detector catches the
// BEHAVIOR-level signal the configuration audits can't see:
// manually deleting incoming mail from a hijacked session to cover
// the attacker's tracks.
//
// FLOW:
//
//   1. The polling worker (P-worker, separate) observes a delete
//      event from the provider (Gmail history.list messageDeleted,
//      Microsoft Graph delta tombstone, IMAP UID gone). For each
//      deleted message id, it calls maybeFireTamperAlert(...).
//
//   2. This detector looks up the corresponding email_scans row.
//      If the row exists AND was scored 'safe' or 'suspicious'
//      (NOT 'fraud' — the user knowingly deletes fraud emails) AND
//      the delete-after-arrival window is short, we INSERT a
//      pending email_tamper_alerts row and push "Did you delete
//      the email from <sender_domain>?" to the user via APNs.
//
//   3. iOS shows the alert. User taps "Yes I did" or "No I didn't"
//      → /v1/email/tamper-alerts/:id/respond updates the status.
//
//   4. 'denied' responses are surfaced to the compromise-check
//      engine. Three or more denials within a rolling 24h window
//      auto-create an email_compromise_reports row with
//      overall_verdict='compromised'.
//
//   5. After 72h with no response, the cron sweep flips pending
//      alerts to 'expired' and emits a metric.
//
// CALIBRATION:
//
//   - Default window: 600 seconds (10 minutes). User-initiated
//     deletes typically happen later (newsletter sweep at end of
//     day, etc.). Attacker deletes happen within seconds-minutes.
//   - 'fraud' verdicts are excluded because the user is supposed
//     to delete those — that's the entire AegisDial value prop.
//   - Per-user cap: at most 5 pending tamper alerts per user at
//     a time to prevent push-notification overload during a real
//     compromise scenario.

export const DEFAULT_TAMPER_WINDOW_SECONDS = 600;
const MAX_PENDING_ALERTS_PER_USER = 5;

export interface TamperAlertCandidate {
  /** The scan row that referenced this message before it was deleted. */
  scan_id: string;
  /** Owner of the scan. The detector looks this up itself; passed for caller convenience. */
  user_id: string;
  /** Same — passed for caller convenience to avoid an extra query. */
  email_account_id: string;
  /** Seconds between message arrival and the delete event. */
  delete_after_seconds: number;
}

export interface TamperAlertResult {
  fired: boolean;
  alert_id?: string;
  reason_skipped?:
    | 'scan_not_found'
    | 'verdict_was_fraud'
    | 'outside_window'
    | 'pending_cap_reached'
    | 'already_alerted';
}

/**
 * Decide whether a delete event warrants a tamper alert. Pure-ish
 * — does a few SELECTs and conditionally INSERTs + pushes. Returns
 * a structured result so the polling worker can emit per-skip
 * metrics. Tests stub sendToUser via the same provider-injection
 * pattern used elsewhere.
 *
 * Idempotent: a second call for the same scan_id no-ops via the
 * UNIQUE constraint on email_tamper_alerts.scan_id.
 */
export async function maybeFireTamperAlert(
  input: TamperAlertCandidate,
  opts: {
    window_seconds?: number;
    /** Override for tests — defaults to the real APNs sender. */
    pushSender?: typeof sendToUser;
  } = {},
): Promise<TamperAlertResult> {
  const windowSec = opts.window_seconds ?? DEFAULT_TAMPER_WINDOW_SECONDS;
  if (input.delete_after_seconds < 0 || input.delete_after_seconds > windowSec) {
    void emitMetric('email_shield.tamper_skipped', { reason: 'outside_window' });
    return { fired: false, reason_skipped: 'outside_window' };
  }

  // Pull the scan row. Bails out early if the scan was already
  // swept (30d retention) or never existed (race condition: poll
  // observed a delete event for a message we never scored).
  const scan = await query<{
    id: string;
    user_id: string;
    email_account_id: string;
    verdict: 'safe' | 'suspicious' | 'fraud';
    sender_domain: string;
    subject_excerpt: string;
  }>(
    `SELECT id, user_id, email_account_id, verdict, sender_domain, subject_excerpt
       FROM email_scans WHERE id = $1`,
    [input.scan_id],
  );
  if ((scan.rowCount ?? 0) === 0) {
    void emitMetric('email_shield.tamper_skipped', { reason: 'scan_not_found' });
    return { fired: false, reason_skipped: 'scan_not_found' };
  }
  const row = scan.rows[0]!;
  if (row.verdict === 'fraud') {
    // User is supposed to delete fraud-verdict messages — that's
    // the product. Don't pester them about it.
    void emitMetric('email_shield.tamper_skipped', { reason: 'verdict_was_fraud' });
    return { fired: false, reason_skipped: 'verdict_was_fraud' };
  }

  // Per-user pending cap. During a real compromise scenario the
  // attacker may delete dozens of messages in a row — pushing
  // 50 alerts overwhelms the user. Cap at 5 pending; subsequent
  // deletes get swallowed (operator metric still emits) and the
  // composite compromise-check engine picks up the slack.
  const pendingCount = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM email_tamper_alerts
      WHERE user_id = $1 AND status = 'pending'`,
    [row.user_id],
  );
  if (Number(pendingCount.rows[0]!.count) >= MAX_PENDING_ALERTS_PER_USER) {
    void emitMetric('email_shield.tamper_skipped', { reason: 'pending_cap_reached' });
    return { fired: false, reason_skipped: 'pending_cap_reached' };
  }

  // INSERT — UNIQUE (scan_id) makes this idempotent. If a second
  // call comes through (history page replay), the conflict path
  // returns no rows.
  const ins = await query<{ id: string }>(
    `INSERT INTO email_tamper_alerts (
       user_id, email_account_id, scan_id, sender_domain,
       subject_excerpt, delete_after_seconds, status
     ) VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT (scan_id) DO NOTHING
     RETURNING id`,
    [
      row.user_id,
      row.email_account_id,
      row.id,
      row.sender_domain,
      row.subject_excerpt,
      Math.floor(input.delete_after_seconds),
    ],
  );
  if ((ins.rowCount ?? 0) === 0) {
    void emitMetric('email_shield.tamper_skipped', { reason: 'already_alerted' });
    return { fired: false, reason_skipped: 'already_alerted' };
  }
  const alertId = ins.rows[0]!.id;

  // Fire the push. Best-effort — if APNs is down or the user has
  // no device tokens, the DB row still exists for iOS to surface
  // on the next /v1/email/tamper-alerts poll.
  //
  // PRIVACY: the push body is intentionally generic — no
  // sender_domain, no subject_excerpt, no inbox identifier. Push
  // bodies mirror to lock screen, CarPlay, watchOS, and macOS
  // Continuity; for a B2B user on a vanity domain, "an email from
  // jesiah-personal-llc.com was deleted" reveals identity to anyone
  // in earshot. The detail (sender_domain + scan_id) ships in the
  // `data` payload, which iOS only renders inside the unlocked app.
  const pushFn = opts.pushSender ?? sendToUser;
  try {
    await pushFn({
      userId: row.user_id,
      title: 'Did you delete this email?',
      body: 'AegisDial noticed an email was deleted seconds after it arrived. Tap to confirm it was you.',
      threadId: 'email-tamper-alert',
      data: {
        kind: 'email_tamper_alert',
        alert_id: alertId,
        email_account_id: row.email_account_id,
        sender_domain: row.sender_domain,
      },
      interruptionLevel: 'time-sensitive',
      priority: 10,
      relevanceScore: 0.9,
    });
  } catch (err) {
    captureError(err, { component: 'inboxTamperDetector.push', user_id: row.user_id });
    // Don't roll back the DB row — iOS will show the alert on
    // the next foreground fetch.
  }

  void emitMetric('email_shield.tamper_alert_fired', {
    delete_after_bucket: bucketDeleteAfter(input.delete_after_seconds),
  });
  return { fired: true, alert_id: alertId };
}

/**
 * Bucket the delete-after-seconds value for metric cardinality.
 * Bounded vocabulary so the metric_counters JSONB tag set stays
 * small.
 */
function bucketDeleteAfter(seconds: number): string {
  if (seconds <= 30) return '0_30s';
  if (seconds <= 120) return '30_120s';
  if (seconds <= 300) return '120_300s';
  return '300_600s';
}

/**
 * Resolve a user response to a tamper alert. Called by
 * /v1/email/tamper-alerts/:id/respond.
 *
 * 'denied' responses contribute to a rolling-window compromise
 * signal: three or more denials in 24h auto-create an
 * email_compromise_reports row with overall_verdict='compromised'.
 *
 * Returns true when the response was accepted, false when the
 * alert wasn't found or wasn't pending.
 */
export async function resolveTamperAlert(input: {
  alert_id: string;
  user_id: string;
  decision: 'confirmed' | 'denied';
}): Promise<{ ok: boolean; escalated_to_compromise_report: boolean }> {
  // UPDATE only if status='pending' so a replay doesn't flip a
  // resolved alert.
  const upd = await query<{
    id: string;
    email_account_id: string;
  }>(
    `UPDATE email_tamper_alerts
        SET status = $1, responded_at = NOW()
      WHERE id = $2 AND user_id = $3 AND status = 'pending'
      RETURNING id, email_account_id`,
    [input.decision, input.alert_id, input.user_id],
  );
  if ((upd.rowCount ?? 0) === 0) {
    return { ok: false, escalated_to_compromise_report: false };
  }
  void emitMetric('email_shield.tamper_alert_resolved', { decision: input.decision });

  // Confirmed responses are pure dismissals; no follow-up.
  if (input.decision === 'confirmed') {
    return { ok: true, escalated_to_compromise_report: false };
  }

  // Denied — check the rolling-24h denial count. Three or more
  // denials = high-confidence compromise; escalate.
  const denials = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM email_tamper_alerts
      WHERE user_id = $1
        AND status = 'denied'
        AND responded_at > NOW() - INTERVAL '24 hours'`,
    [input.user_id],
  );
  const denialCount = Number(denials.rows[0]!.count);
  const DENIAL_ESCALATION_THRESHOLD = 3;
  if (denialCount < DENIAL_ESCALATION_THRESHOLD) {
    return { ok: true, escalated_to_compromise_report: false };
  }

  // Escalate. INSERT a compromise report with the tamper-alert
  // denials as the finding. The iOS compromise-check UI already
  // renders email_compromise_reports.findings.inbox_tamper_alerts
  // — so this surfaces in the existing screen without a new view.
  //
  // RACE GUARD: three concurrent denials can each see denialCount=3
  // (each peer's UPDATE commits before the others' COUNT runs under
  // READ COMMITTED), and naively each would INSERT a separate
  // compromise report. The `WHERE NOT EXISTS` clause makes the
  // INSERT atomic with the "is there already a recent tamper-alert
  // report?" check — Postgres serializes the row-level decision
  // within a single statement. If a peer beat us, rowCount=0 and we
  // still return escalated=true (one is already on file for this
  // incident; the iOS UI renders it correctly).
  try {
    const escalation = await query<{ id: string }>(
      `INSERT INTO email_compromise_reports
         (user_id, email_account_id, overall_verdict, findings)
       SELECT $1, $2, 'compromised', $3::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM email_compromise_reports
           WHERE user_id = $1
             AND email_account_id = $4
             AND generated_at > NOW() - INTERVAL '1 hour'
             AND findings ? 'inbox_tamper_alerts'
        )
       RETURNING id`,
      [
        input.user_id,
        upd.rows[0]!.email_account_id,
        JSON.stringify({
          inbox_tamper_alerts: {
            denial_count_24h: denialCount,
            threshold: DENIAL_ESCALATION_THRESHOLD,
            reason: 'User denied responsibility for multiple auto-deleted incoming emails — strong signal of an attacker session manually deleting mail to cover BEC tracks.',
          },
        }),
        upd.rows[0]!.email_account_id,
      ],
    );
    if ((escalation.rowCount ?? 0) === 0) {
      // A peer denial in the same race already created the report.
      // Still surface the escalation flag to this caller — the UI
      // contract is "we escalated this incident," not "you, the
      // specific request, did the INSERT."
      void emitMetric('email_shield.tamper_escalated_deduped', {});
    } else {
      void emitMetric('email_shield.tamper_escalated_to_compromise', { denial_count: String(denialCount) });
    }
  } catch (err) {
    captureError(err, {
      component: 'inboxTamperDetector.escalate',
      user_id: input.user_id,
    });
    // Don't fail the response — the user's "denied" is still
    // recorded; escalation can happen on the next denial.
    return { ok: true, escalated_to_compromise_report: false };
  }
  return { ok: true, escalated_to_compromise_report: true };
}

/**
 * Cron sweep — flip pending alerts older than 72h to 'expired'.
 * Called by the retention sweeper or a dedicated cron. Idempotent.
 */
export async function expireStaleTamperAlerts(): Promise<{ expired: number }> {
  const EXPIRY_HOURS = 72;
  // NOTE: deliberately do NOT set responded_at — that column is
  // reserved for "the user actually tapped a button." Setting it on
  // cron-expiry would lie to the GDPR export and to any future query
  // that means "alerts the user engaged with." Expired rows are
  // identified by status='expired' alone; created_at gives the
  // timeline.
  const res = await query(
    `UPDATE email_tamper_alerts
        SET status = 'expired'
      WHERE status = 'pending'
        AND created_at < NOW() - ($1 || ' hours')::INTERVAL`,
    [String(EXPIRY_HOURS)],
  );
  const expired = res.rowCount ?? 0;
  if (expired > 0) {
    void emitMetric('email_shield.tamper_alerts_expired', { count: String(expired) });
  }
  return { expired };
}

/**
 * Compose a "we're analyzing your inbox" welcome push. Fired by
 * the polling worker on the FIRST scan of a freshly-linked
 * email_account so the user understands background scanning is
 * active. One-shot per account.
 */
export async function dispatchAnalysisStartedPush(input: {
  user_id: string;
  email_account_id: string;
  display_email: string;
  pushSender?: typeof sendToUser;
}): Promise<void> {
  // PRIVACY: generic body — the display_email lands on the lock
  // screen / CarPlay / watchOS otherwise. The detail (which inbox
  // is being scanned) is in `data.email_account_id` for the
  // in-app screen.
  const pushFn = input.pushSender ?? sendToUser;
  try {
    await pushFn({
      userId: input.user_id,
      title: 'AegisDial is watching your inbox',
      body: 'Email Shield is now scanning your linked inbox for phishing, BEC, and compromise signals.',
      threadId: 'email-shield-status',
      data: {
        kind: 'email_shield_analysis_started',
        email_account_id: input.email_account_id,
        display_email: input.display_email,
      },
      interruptionLevel: 'passive',
      priority: 5,
    });
    void emitMetric('email_shield.analysis_started_push', {});
  } catch (err) {
    captureError(err, {
      component: 'inboxTamperDetector.analysis_started_push',
      user_id: input.user_id,
    });
  }
}
