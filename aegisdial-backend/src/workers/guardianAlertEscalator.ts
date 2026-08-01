import cron from 'node-cron';
import { config } from '../config.js';
import { withTx } from '../lib/db.js';
import { captureError, emitMetric } from '../lib/observability.js';
import { sendTelnyxSms } from '../lib/telnyx.js';

// Guardian alert SMS escalator.
//
// APNs push is best-effort: the device may be off, the token may be
// dead, the family member may not have the app open and notifications
// dismissed. For critical alerts, that's not good enough — someone is
// actively being scammed right now and we need to wake the guardian.
//
// This worker runs every 5 minutes. It finds `guardian_alerts` rows
// that:
//   - are severity='critical'
//   - have seen_at IS NULL        (guardian hasn't acknowledged)
//   - have escalated_at IS NULL   (we haven't already tried)
//   - were created 15 min to 24 hr ago
//       - under 15 min: give APNs + user time to react first
//       - over 24 hr: stale, SMS would arrive after the moment
// and for each, sends an SMS to the guardian's users.phone_number via
// Twilio's Messages API.
//
// Escalation is one-shot: escalated_at is stamped regardless of SMS
// delivery success, so we never double-text. If Twilio is down we log
// and move on; we don't queue retries.

const CRON_EXPR = '*/5 * * * *'; // every 5 minutes
const BATCH_SIZE = 100;
// Eligibility window: 15 min (APNs headroom) to 24 hr (staleness
// cutoff). Applied via SQL INTERVAL literals below so the window is
// computed from NOW() on the DB side, not JS clock skew.

export interface EscalatorHandle {
  task: cron.ScheduledTask;
}

interface AlertRow {
  id: string;
  guardian_user_id: string;
  title: string;
  body: string;
  phone_number: string | null;
}

function twilioConfigured(): boolean {
  return !!(
    config.TWILIO_ACCOUNT_SID &&
    config.TWILIO_AUTH_TOKEN &&
    config.TWILIO_MESSAGING_FROM
  );
}

/** Exported for tests / admin ops. */
export async function runEscalator(): Promise<{ considered: number; sent: number; skipped: number }> {
  // Short-circuit when Twilio isn't wired. We still want to run the
  // query in CI / dev so migrations get exercised, but there's no
  // point scanning the table if we couldn't send anyway.
  if (!twilioConfigured()) {
    return { considered: 0, sent: 0, skipped: 0 };
  }

  // Claim rows for this tick atomically: SELECT ... FOR UPDATE SKIP LOCKED
  // inside a tx, stamp escalated_at = NOW() before releasing the row
  // lock. This guarantees we never send two SMS for the same alert even
  // if the process crashes mid-tick or a second worker instance runs
  // the cron at the same minute. The one-shot invariant ("we never
  // re-text a guardian for the same alert") is enforced by the DB, not
  // by the ordering of JS statements.
  //
  // A Twilio outage that happens AFTER the claim means the guardian
  // doesn't get an SMS for that specific alert — which is the correct
  // trade-off: the alert has already aged out of the relevance window
  // by the time Twilio recovers, and we do not want a guardian to
  // receive yesterday's scam ping at 3am.
  const claimed = await withTx(async (client) => {
    const res = await client.query<AlertRow>(
      `WITH eligible AS (
         SELECT ga.id
           FROM guardian_alerts ga
          WHERE ga.severity = 'critical'
            AND ga.seen_at IS NULL
            AND ga.escalated_at IS NULL
            AND ga.created_at <= NOW() - INTERVAL '15 minutes'
            AND ga.created_at >= NOW() - INTERVAL '24 hours'
          ORDER BY ga.created_at ASC
          LIMIT $1
          FOR UPDATE OF ga SKIP LOCKED
       )
       UPDATE guardian_alerts ga
          SET escalated_at = NOW()
         FROM eligible, users u
        WHERE ga.id = eligible.id
          AND u.id = ga.guardian_user_id
       RETURNING ga.id, ga.guardian_user_id, ga.title, ga.body, u.phone_number`,
      [BATCH_SIZE],
    );
    return res.rows;
  });
  if (claimed.length === 0) return { considered: 0, sent: 0, skipped: 0 };

  let sent = 0;
  let skipped = 0;

  for (const r of claimed) {
    if (!r.phone_number) {
      skipped++;
      continue;
    }
    try {
      // Provider is selected per-env by CALL_PROVIDER (default 'twilio').
      // Both senders share the same contract — resolve true/false, never
      // throw for a delivery failure — so the switch is a single ternary and
      // Twilio stays fully intact as the fallback until Telnyx is verified
      // live. See TELNYX_MIGRATION.md.
      const send = config.CALL_PROVIDER === 'telnyx' ? sendTelnyxSms : sendTwilioSms;
      const ok = await send({
        to: r.phone_number,
        body: buildSmsBody(r.title, r.body),
      });
      if (ok) sent++;
      else skipped++;
    } catch (err) {
      captureError(err, {
        component: 'guardianAlertEscalator.send',
        alert_id: r.id,
      });
      skipped++;
    }
  }

  void emitMetric('guardian.sms_escalation_run', {}, claimed.length);
  if (sent > 0) void emitMetric('guardian.sms_escalation_sent', {}, sent);
  if (skipped > 0) void emitMetric('guardian.sms_escalation_skipped', {}, skipped);

  return { considered: claimed.length, sent, skipped };
}

function buildSmsBody(title: string, body: string): string {
  // Cap at ~320 chars (two SMS segments) so we don't shred the message
  // into six parts. The full alert is available in the app; SMS is a
  // wake-up ping, not the full payload.
  const MAX = 300;
  const combined = `${title}. ${body} — open AegisDial for details.`;
  if (combined.length <= MAX) return combined;
  return combined.slice(0, MAX - 1) + '…';
}

async function sendTwilioSms(args: { to: string; body: string }): Promise<boolean> {
  const auth = Buffer.from(
    `${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`,
  ).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams();
  // MESSAGING_FROM may be a raw +E.164 phone or a Messaging Service
  // SID (MG…). Twilio accepts both in the `From` field in practice,
  // though the canonical form is `MessagingServiceSid` for the latter.
  if (config.TWILIO_MESSAGING_FROM!.startsWith('MG')) {
    form.append('MessagingServiceSid', config.TWILIO_MESSAGING_FROM!);
  } else {
    form.append('From', config.TWILIO_MESSAGING_FROM!);
  }
  form.append('To', args.to);
  form.append('Body', args.body);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) {
    // 4xx on this endpoint = bad phone number, unsubscribed, etc. We
    // treat all non-2xx as skipped. Body text is useful for debugging
    // but we don't want to surface Twilio error messages to users.
    const text = await res.text().catch(() => '');
    captureError(new Error(`twilio_sms_${res.status}`), {
      component: 'guardianAlertEscalator.twilio',
      status: res.status,
      body: text.slice(0, 200),
    });
    return false;
  }
  return true;
}

export function startGuardianAlertEscalator(): EscalatorHandle {
  const task = cron.schedule(
    CRON_EXPR,
    () => {
      void runEscalator().catch((err) => {
        captureError(err, { component: 'guardianAlertEscalator.cron' });
      });
    },
    { timezone: 'UTC' },
  );
  console.log('[escalator] guardian SMS escalator @ every 5 min');
  return { task };
}

export function stopGuardianAlertEscalator(h: EscalatorHandle): void {
  h.task.stop();
}
