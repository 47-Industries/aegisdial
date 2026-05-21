import { Resend } from 'resend';
import { config } from '../config.js';
import { query } from './db.js';
import { captureError, emitMetric } from './observability.js';

// Transactional email via Resend. All sends are audited in
// email_messages so we can see bounces, complaints, and resend on
// failure. When RESEND_API_KEY is unset, send() logs + stores a
// `queued` row and exits — useful for dev + CI.
//
// Templates live in this file for now (small enough). When we add
// more than ~5, consider react-email or mjml.

let client: Resend | null = null;
function getClient(): Resend | null {
  if (client) return client;
  if (!config.RESEND_API_KEY) return null;
  client = new Resend(config.RESEND_API_KEY);
  return client;
}

export interface EmailRequest {
  userId?: string | null;
  to: string;
  template: EmailTemplate;
  data: Record<string, unknown>;
}

export type EmailTemplate =
  | 'breach_digest'
  | 'family_invite'
  | 'guardian_critical_alert'
  | 'recovery_followup'
  | 'welcome'
  | 'account_deleted'
  | 'password_reset_code'
  | 'support_ticket_forward';

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(req: EmailRequest): Promise<{ id: string; sent: boolean }> {
  const rendered = render(req.template, req.data);

  // Always audit, even when we can't actually send.
  const ins = await query<{ id: string }>(
    `INSERT INTO email_messages (user_id, to_email, template, subject, payload, status)
     VALUES ($1, $2, $3, $4, $5, 'queued')
     RETURNING id`,
    [req.userId ?? null, req.to, req.template, rendered.subject, JSON.stringify(req.data)],
  );
  const messageId = ins.rows[0]!.id;

  const c = getClient();
  if (!c) {
    // eslint-disable-next-line no-console
    console.log('[email] dry-run (no Resend key)', { to: req.to, template: req.template });
    void emitMetric('email.dry_run', { template: req.template });
    // Mark dry-run rows as 'failed' with a known error so ops can
    // filter them out of "stuck queue" alerts. Check constraint only
    // allows queued/sent/failed/bounced/complained, so re-use failed.
    await query(
      `UPDATE email_messages SET status = 'failed', error = 'dry_run_no_resend_key' WHERE id = $1`,
      [messageId],
    );
    return { id: messageId, sent: false };
  }

  try {
    const resp = await c.emails.send({
      from: config.RESEND_FROM,
      to: req.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    await query(
      `UPDATE email_messages
          SET status = 'sent', provider_id = $2, sent_at = NOW()
        WHERE id = $1`,
      [messageId, resp.data?.id ?? null],
    );
    void emitMetric('email.sent', { template: req.template });
    return { id: messageId, sent: true };
  } catch (err) {
    await query(
      `UPDATE email_messages SET status = 'failed', error = $2 WHERE id = $1`,
      [messageId, (err as Error).message ?? 'unknown'],
    );
    // Mask the recipient address before it reaches Sentry. We still
    // want the domain (provider diagnostic signal — "all gmail sends
    // are bouncing" is a real alert) but the local part is PII and
    // Sentry isn't inside our retention + encryption boundary.
    captureError(err, {
      component: 'email',
      template: req.template,
      to: maskEmailForTelemetry(req.to),
    });
    void emitMetric('email.failed', { template: req.template });
    return { id: messageId, sent: false };
  }
}

// "alice@example.com" → "***@example.com". Preserves just enough signal
// for ops diagnostics (which ESP / domain is failing) while dropping
// the identifying local part. Non-email strings collapse to `***` so a
// malformed value can't accidentally leak either.
export function maskEmailForTelemetry(addr: string): string {
  if (!addr) return '***';
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return '***';
  return `***@${addr.slice(at + 1)}`;
}

// ---- Templates ----

function render(template: EmailTemplate, data: Record<string, unknown>): RenderedEmail {
  switch (template) {
    case 'breach_digest':
      return renderBreachDigest(data);
    case 'family_invite':
      return renderFamilyInvite(data);
    case 'guardian_critical_alert':
      return renderGuardianCriticalAlert(data);
    case 'recovery_followup':
      return renderRecoveryFollowup(data);
    case 'welcome':
      return renderWelcome(data);
    case 'account_deleted':
      return renderAccountDeleted(data);
    case 'password_reset_code':
      return renderPasswordResetCode(data);
    case 'support_ticket_forward':
      return renderSupportTicketForward(data);
  }
}

function renderPasswordResetCode(d: Record<string, unknown>): RenderedEmail {
  const code = esc(d.code ?? '------');
  const minutes = esc(d.expires_in_minutes ?? 15);
  const inner = `
    <h1 style="font-size:24px;font-weight:700;margin:24px 0 8px;">Reset your AegisDial password</h1>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">
      Enter this 6-digit code in the AegisDial app to set a new password.
      It expires in ${minutes} minutes.
    </p>
    <div style="margin:24px 0;padding:20px;background:#161823;border-radius:12px;text-align:center;font-family:'SF Mono',Menlo,Monaco,monospace;font-size:32px;letter-spacing:6px;color:#6aa9ff;font-weight:700;">${code}</div>
    <p style="font-size:14px;color:#9097a3;">
      If you didn't request this, you can ignore the email — your password won't change
      until someone enters this code. If you keep getting these and didn't request them,
      reply to this email and we'll help secure your account.
    </p>`;
  return {
    subject: `AegisDial password reset code: ${code}`,
    html: wrap(inner, 'Your password reset code is inside.'),
    text:
      `Your AegisDial password reset code is ${code}. ` +
      `It expires in ${minutes} minutes. ` +
      `Enter it in the app to set a new password.`,
  };
}

function wrap(inner: string, preheader?: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AegisDial</title>
${preheader ? `<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0">${esc(preheader)}</span>` : ''}
</head>
<body style="margin:0;padding:0;background:#0a0b10;color:#f5f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;">
  <div style="font-size:20px;font-weight:700;letter-spacing:-0.4px;">🛡️ AegisDial</div>
  ${inner}
  <hr style="border:none;border-top:1px solid #2a2d38;margin:32px 0;">
  <div style="font-size:12px;color:#9097a3;line-height:1.5;">
    You're receiving this because you protect someone (or yourself) with AegisDial.
    Manage notifications in Settings → Notifications.
  </div>
</div></body></html>`;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderWelcome(d: Record<string, unknown>): RenderedEmail {
  const name = (d.display_name as string) ?? 'there';
  const inner = `
    <h1 style="font-size:26px;font-weight:700;margin:24px 0 8px;">Welcome, ${esc(name)}.</h1>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">
      You're now protected by the first live scam shield built for the call itself —
      not just before the ring. Here's what to set up today:
    </p>
    <ul style="font-size:15px;line-height:1.6;color:#c8cdda;padding-left:18px;">
      <li><b>Add your trusted family contacts</b> with a shared safe word. A voice clone
      won't know it.</li>
      <li><b>Monitor your email + phone</b> for dark-web exposure — we'll alert you
      the moment scammers get new ammo.</li>
      <li><b>Turn on push notifications</b> so we can reach you the instant a family
      member answers a scam call.</li>
    </ul>`;
  return {
    subject: `Welcome to AegisDial, ${name}`,
    html: wrap(inner, 'Your live scam shield is active.'),
    text: `Welcome, ${name}. Open AegisDial and add your family contacts + breach monitors.`,
  };
}

function renderBreachDigest(d: Record<string, unknown>): RenderedEmail {
  const count = Number(d.count ?? 0);
  const items = ((d.alerts as Array<{ breach_title: string; breach_date?: string }>) ?? []).slice(0, 5);
  const list = items
    .map((a) =>
      `<li style="margin:6px 0;"><b>${esc(a.breach_title)}</b>${a.breach_date ? ` — ${esc(a.breach_date)}` : ''}</li>`,
    )
    .join('');
  const inner = `
    <h1 style="font-size:24px;font-weight:700;margin:24px 0 8px;">${count} new breach exposure${count === 1 ? '' : 's'}</h1>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">
      One of your monitored identifiers showed up in a new dark-web leak. Scammers
      will use this in their next sweep — here's what we found:
    </p>
    <ul style="color:#c8cdda;">${list}</ul>
    <p style="font-size:15px;color:#c8cdda;">Rotate any shared passwords and enable 2FA on those accounts.</p>`;
  return {
    subject: `${count} new breach exposure${count === 1 ? '' : 's'} found`,
    html: wrap(inner),
    text: `New breach exposures: ${items.map((a) => a.breach_title).join(', ')}`,
  };
}

function renderFamilyInvite(d: Record<string, unknown>): RenderedEmail {
  const inviter = esc(d.inviter_name ?? 'A family member');
  const code = esc(d.code ?? '');
  const inner = `
    <h1 style="font-size:24px;font-weight:700;margin:24px 0 8px;">${inviter} invited you to their family plan</h1>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">
      You're being added to bank-grade call protection. Install AegisDial from the
      App Store, sign in, and enter this code in Settings → Family Plan:
    </p>
    <div style="margin:24px 0;padding:20px;background:#161823;border-radius:12px;text-align:center;font-family:'SF Mono',Menlo,Monaco,monospace;font-size:28px;letter-spacing:4px;color:#6aa9ff;">${code}</div>
    <p style="font-size:14px;color:#9097a3;">The code expires in 7 days.</p>`;
  return {
    subject: `${d.inviter_name ?? 'Someone'} invited you to AegisDial`,
    html: wrap(inner),
    text: `Enter code ${code} in AegisDial → Settings → Family Plan.`,
  };
}

function renderGuardianCriticalAlert(d: Record<string, unknown>): RenderedEmail {
  const subject = esc(d.subject_name ?? 'A family member');
  const detail = esc(d.body ?? '');
  const inner = `
    <h1 style="font-size:26px;font-weight:700;margin:24px 0 8px;color:#ff6b70;">Critical: check in on ${subject}</h1>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">${detail}</p>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">
      Call them directly on the number you have saved. If they don't answer, call
      another family member to confirm where they are.
    </p>`;
  return {
    subject: `URGENT: ${subject} may be on a scam call`,
    html: wrap(inner),
    text: `Check in on ${subject}. ${detail}`,
  };
}

function renderAccountDeleted(d: Record<string, unknown>): RenderedEmail {
  const name = (d.display_name as string) ?? 'there';
  const inner = `
    <h1 style="font-size:24px;font-weight:700;margin:24px 0 8px;">Your account is deleted, ${esc(name)}.</h1>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">
      Everything we had — your account, your family contacts and safe words, your
      monitored identifiers, your call sessions, your breach alerts — has been wiped.
    </p>
    <p style="font-size:15px;color:#c8cdda;">
      If this wasn't you, reply to this email immediately. If it was, thanks for trying AegisDial.
      If you cancel your App Store subscription separately, it will stop auto-renewing.
    </p>`;
  return {
    subject: 'Your AegisDial account has been deleted',
    html: wrap(inner),
    text: `Your AegisDial account and all associated data has been deleted. Reply if this wasn't you.`,
  };
}

function renderSupportTicketForward(d: Record<string, unknown>): RenderedEmail {
  const subject = esc(d.subject ?? '(no subject)');
  const msgBody = esc(d.body ?? '').replace(/\n/g, '<br>');
  const from = esc(d.from_email ?? 'unknown');
  const userId = esc(d.from_user_id ?? 'anonymous');
  const category = esc(d.category ?? 'other');
  const appVer = esc(d.app_version ?? '—');
  const iosVer = esc(d.ios_version ?? '—');
  const dev = esc(d.device_model ?? '—');
  const ticket = esc(d.ticket_id ?? '');
  const inner = `
    <h1 style="font-size:22px;font-weight:700;margin:16px 0 8px;">[${category}] ${subject}</h1>
    <p style="font-size:13px;color:#9097a3;margin:0 0 16px;">
      Ticket <code>${ticket}</code> · from ${from} · user ${userId}<br>
      ${appVer} on iOS ${iosVer} · device ${dev}
    </p>
    <div style="padding:16px;background:#161823;border-radius:10px;color:#c8cdda;font-size:15px;line-height:1.55;white-space:pre-wrap;">${msgBody}</div>`;
  return {
    subject: `[AegisDial support] ${category}: ${subject}`,
    html: wrap(inner),
    text: `[${category}] ${subject}\nFrom: ${from}\n\n${d.body ?? ''}`,
  };
}

function renderRecoveryFollowup(d: Record<string, unknown>): RenderedEmail {
  const bucket = (d.bucket as string) ?? '24h';
  // 30d and 90d copy is structurally different from the 24h/3d/7d
  // checklist format — they're emotional check-ins, not task nudges —
  // so we branch out of the shared template early for those cases.
  if (bucket === '30d') return renderRecoveryFollowup30d(d);
  if (bucket === '90d') return renderRecoveryFollowup90d(d);

  const headline = bucket === '7d'
    ? "It's been a week — how are things?"
    : bucket === '3d'
      ? "Three days in — quick progress check"
      : 'Checking in — how are you doing?';
  const lead = bucket === '7d'
    ? "You started a recovery session a week ago. A few things worth double-checking today:"
    : bucket === '3d'
      ? "You started a recovery session three days ago. Make sure these are done:"
      : "It's been 24 hours since you started a recovery session. Here's what to double-check today:";
  const inner = `
    <h1 style="font-size:24px;font-weight:700;margin:24px 0 8px;">${headline}</h1>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">${lead}</p>
    <ul style="font-size:15px;line-height:1.6;color:#c8cdda;padding-left:18px;">
      <li>Have you frozen your credit at <b>all three</b> bureaus (Equifax, Experian, TransUnion)?</li>
      <li>Did you file an FTC report at reportfraud.ftc.gov?</li>
      <li>Did you file an IC3 report at ic3.gov if money was sent?</li>
      <li>Is your family aware, in case the scammer calls them next?</li>
    </ul>
    <p style="font-size:14px;color:#9097a3;">Open AegisDial → Settings → Recovery History to pick up where you left off.</p>`;
  return {
    subject: headline,
    html: wrap(inner),
    text: `${headline}\n${lead}\n- Freeze credit at Equifax/Experian/TransUnion\n- File FTC + IC3 reports\n- Tell your family`,
  };
}

// T+30d "outcome check-in". The worker only queues this when a
// recovery_outcomes row exists, so recovered_any + recovered_cents are
// authoritative at send time. The copy references the outcome
// explicitly ("you told us you recovered $X") because a generic
// check-in a month out feels robotic, and the outcome row is the only
// place we have a tangible fact to anchor to. 988 + AARP fraud helpline
// numbers are in every version — emotional fallout is non-trivial for
// scam victims, and we want those numbers visible without a second tap.
function renderRecoveryFollowup30d(d: Record<string, unknown>): RenderedEmail {
  const recoveredAny = d.recovered_any as boolean | null | undefined;
  const recoveredCents = typeof d.recovered_cents === 'number' ? d.recovered_cents : null;
  const recoveredUsd = recoveredCents != null ? recoveredCents / 100 : null;

  // Three lanes of personalization, based on the outcome row:
  //   1. Recovered some money          → celebrate + invite advice.
  //   2. Tried, no recovery            → emotional acknowledgment.
  //   3. Outcome submitted but unclear → neutral check-in.
  // We never shame or imply the user "should have" done anything — every
  // lane ends with the same invitation to reply.
  let outcomeLine: string;
  if (recoveredAny === true && recoveredUsd != null && recoveredUsd > 0) {
    outcomeLine =
      `When we last checked in, you told us you were able to recover about ` +
      `$${recoveredUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}. ` +
      `That's a real win — a lot of victims never claw anything back.`;
  } else if (recoveredAny === true) {
    outcomeLine =
      `When we last checked in, you told us you were able to recover some of what was lost. ` +
      `That's a real win — a lot of victims never claw anything back.`;
  } else if (recoveredAny === false) {
    outcomeLine =
      `When we last checked in, you told us the money didn't come back. That's the harder ` +
      `outcome, and it's not a reflection of anything you did wrong — most scam recoveries hit this wall.`;
  } else {
    outcomeLine =
      `You shared an outcome with us on that session. We wanted to check back in a month later.`;
  }

  const inner = `
    <h1 style="font-size:24px;font-weight:700;margin:24px 0 8px;">It's been a month. How are you feeling?</h1>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">${esc(outcomeLine)}</p>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">
      It's been a month since you walked the recovery plan. How are you feeling? If you're still
      processing it, <b>988</b> is there 24/7, and AARP's fraud helpline is
      <b>1-877-908-3360</b>. Both are free and confidential.
    </p>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">
      If you've noticed a pattern — a second wave of calls, a new angle from the same scammers —
      or you have advice for other victims, reply to this email. Your story helps us build
      better defenses for the next person.
    </p>`;
  return {
    subject: "It's been a month — how are you feeling?",
    html: wrap(inner),
    text:
      `It's been a month since your recovery session. ${outcomeLine}\n\n` +
      `If you're still processing it, call 988 (24/7) or AARP's fraud helpline at 1-877-908-3360.\n` +
      `If you've noticed a pattern or have advice for other victims, reply to this email.`,
  };
}

// T+90d "long-tail check-in". Fires for every session, outcome row or
// not — the worker only skips it if the user has explicitly opted out.
// The 41% re-target figure is from FBI IC3 multi-year data; it's the
// most important thing for a 3-month-out victim to know because this
// is the window when recovery-scam secondary victimization peaks
// ("hi, I'm a recovery specialist who can get your money back").
function renderRecoveryFollowup90d(_d: Record<string, unknown>): RenderedEmail {
  const inner = `
    <h1 style="font-size:24px;font-weight:700;margin:24px 0 8px;">90 days in — heads up</h1>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">
      It's been 90 days since you opened that recovery session. Most victims think the danger
      passes with the first week. It doesn't.
    </p>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">
      <b>Scammers re-target 41% of victims within 6 months.</b> Your number is on a list now.
      Here's what to watch for:
    </p>
    <ul style="font-size:15px;line-height:1.6;color:#c8cdda;padding-left:18px;">
      <li><b>"Recovery specialists"</b> who call claiming they can get your money back for a fee.
          These are the same scammer networks running a second pass.</li>
      <li><b>"FBI / FTC agents"</b> with a case number referencing the original scam. Real
          agents never call to collect fees or gift cards.</li>
      <li><b>Lawyers or accountants</b> who contact you unsolicited about the incident. Hang up
          and call your own attorney if you have one.</li>
      <li><b>New pretexts from a "different" scam</b> — fake package redelivery, toll notices,
          Medicare re-enrollment — that arrive right as you're letting your guard down.</li>
    </ul>
    <p style="font-size:16px;line-height:1.55;color:#c8cdda;">
      If anything feels off, open AegisDial and start a triage session before you engage. And
      if you're still working through the emotional fallout, <b>988</b> is there 24/7.
    </p>
    <p style="font-size:14px;color:#9097a3;">
      Don't want these follow-ups? Reply "STOP" and we'll mark your preferences.
    </p>`;
  return {
    subject: '90 days in — watch for the second wave',
    html: wrap(inner),
    text:
      `90 days in. Scammers re-target 41% of victims within 6 months. Here's what to watch for:\n` +
      `- "Recovery specialists" who can "get your money back" for a fee\n` +
      `- Fake FBI / FTC agents with a case number\n` +
      `- Unsolicited lawyers or accountants\n` +
      `- New pretexts: package redelivery, toll, Medicare re-enrollment\n\n` +
      `988 is there 24/7 if you need to talk.`,
  };
}

