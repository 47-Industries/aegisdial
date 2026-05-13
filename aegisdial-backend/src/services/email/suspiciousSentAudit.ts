// Email Shield — suspicious-sent audit. Compromise-check Pillar 3,
// finding slice `suspicious_sent`.
//
// The three sibling detectors (inbox_rules, oauth_grants,
// login_anomalies) catch CONFIGURATION-level compromise: a hidden
// forwarding rule, a malicious app grant, a login from an
// impossible-travel location. This detector catches the BEHAVIOR
// the attacker used the foothold to commit: outbound BEC drafts
// the legitimate account owner would not actually send.
//
// THREAT MODEL:
//
//   Once an attacker has session-level access (stolen cookies,
//   compromised refresh token, freshly granted "Mail Read/Send" OAuth
//   app), the first revenue action is almost always a wire-fraud
//   payload sent OUT of the victim's mailbox to a contact, vendor,
//   or AP team. The classic shapes are:
//
//     1. Wire request — "please wire $X today to account Y"
//     2. Invoice account-change — "our banking info has changed"
//     3. Gift-card purchase — "buy iTunes cards for the team"
//     4. Urgent payment + reply-to mismatch
//     5. Credential reset / password-share message
//
//   The four-corners audit on inbox rules + OAuth + logins WILL
//   miss this if the attacker (a) added no rules and (b) revoked the
//   app or used a stolen cookie that left no app trail. The sent
//   folder is the only place the artifact reliably lands.
//
// REUSE:
//
//   `detectBecPatterns()` in becPatterns.ts already implements the
//   exact phrase-pattern library we need — wire requests, invoice
//   redirects, gift cards, urgency, secrecy, etc. The detector is
//   PURE so we apply it to outgoing text with no modification. The
//   only outgoing-specific signal layered on top is recipient
//   freshness: an outbound wire request to a brand-new external
//   recipient (no prior correspondence in this window) is a
//   meaningfully stronger signal than the same message to a known
//   correspondent.
//
// PROVIDER SURFACE:
//
//   The EmailProvider interface (types.ts) does not yet expose
//   `getSentMessages` — adding it as a REQUIRED method would force
//   provider-side work for IMAP servers whose Sent folder name is
//   server-specific. For v1 we treat the method as OPTIONAL:
//   providers that already list their Sent folder implement it, the
//   detector checks for its presence at runtime, and providers that
//   don't return an empty result with no exception. The route layer
//   sees an empty `findings.suspicious_sent` and the composite
//   verdict simply doesn't penalize on a signal we couldn't gather.
//
// PII:
//
//   `subject_excerpt` runs through `redactSensitiveDigits` (the
//   same helper SMS Shield uses) before persistence. `to_domain` is
//   ALWAYS eTLD+1, never the local-part — a `bookkeeper@victim.com`
//   sent to `cfo@victimco.com` must NOT leak `cfo` to the findings
//   JSONB.

import { redactSensitiveDigits } from '../sentinelMatcher.js';
import { detectBecPatterns, type BecCategory, type BecMatch } from './becPatterns.js';
import type {
  EmailProvider,
  IncomingMessage,
  LinkedAccountCredentials,
} from './types.js';

const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_SUBJECT_EXCERPT = 80;

/** Categories surfaced by this detector. A superset of `BecCategory`
 * filtered down to the shapes that make sense on OUTBOUND mail. */
export type SuspiciousSentCategory =
  | 'wire_request'
  | 'invoice_account_change'
  | 'gift_card_purchase'
  | 'credential_reset'
  | 'urgent_payment';

export interface SuspiciousSentFinding {
  /** Provider's native message id. Gmail msgId / Graph id / IMAP UID. */
  message_id: string;
  /** When the message was sent (from the message's Date header). */
  sent_at: Date;
  /**
   * eTLD+1 of the FIRST recipient. NEVER the local-part — local-part
   * is high-PII (cfo@, ceo@, treasurer@) and the findings JSONB ships
   * unredacted to the iOS client.
   */
  to_domain: string;
  category: SuspiciousSentCategory;
  /** Digit-redacted, capped at 80 chars. Safe for the iOS UI. */
  subject_excerpt: string;
  confidence: 'low' | 'medium' | 'high';
  /** 1-line operator-readable explanation. Generic — no PII fragments. */
  reason: string;
}

export interface SuspiciousSentAuditResult {
  findings: SuspiciousSentFinding[];
  scanned_count: number;
  window_days: number;
}

/**
 * Optional provider method. A provider that supports listing its
 * Sent folder implements this. The detector checks for its presence
 * at runtime and returns an empty result if missing — no exception.
 *
 * Returning IncomingMessage works because outgoing messages share
 * the same envelope shape (from, to, subject, body_text, headers).
 * The semantic difference is that `from.address` is now the linked
 * account's own address and `to[]` is the external party.
 */
export interface SentMessageCapableProvider extends EmailProvider {
  getSentMessages(
    credentials: LinkedAccountCredentials,
    opts: { window_days: number; limit: number },
  ): Promise<IncomingMessage[]>;
}

function hasGetSentMessages(p: EmailProvider): p is SentMessageCapableProvider {
  return typeof (p as Partial<SentMessageCapableProvider>).getSentMessages === 'function';
}

/**
 * Map the existing BEC taxonomy into the detector's narrower
 * outgoing-focused taxonomy. Categories that don't make sense as
 * OUTBOUND signals (e.g. authority_impersonation — the account owner
 * IS the authority on their own outbound mail) are dropped from
 * consideration, NOT mapped to anything.
 *
 * Returning `null` means "do not emit a finding for this category."
 */
function mapBecToSentCategory(c: BecCategory): SuspiciousSentCategory | null {
  switch (c) {
    case 'wire_request': return 'wire_request';
    case 'invoice_redirect': return 'invoice_account_change';
    case 'payroll_change': return 'invoice_account_change';
    case 'gift_card_purchase': return 'gift_card_purchase';
    case 'credential_phish': return 'credential_reset';
    case 'urgency_pressure': return 'urgent_payment';
    // Outbound mail from the legitimate owner's address is the
    // signal source, not the impersonation vector — skip.
    case 'secrecy_pressure':
    case 'authority_impersonation':
    case 'fake_shipping':
    case 'fake_invoice_attachment':
    case 'crypto_request':
    case 'attorney_pretext':
    case 'mobile_only_contact':
      return null;
    // Defensive: if a future BecCategory is added without updating
    // this switch (TypeScript exhaustiveness catches it at build,
    // but `@ts-ignore` or skipped compile would slip through),
    // surface as null rather than `undefined`. Pinned by the
    // verification audit — keeps the priority lookup at the
    // caller from indexing on undefined.
    default:
      return null;
  }
}

/**
 * Priority order used when one message hits multiple BEC categories.
 * Wire / account-change / gift-card are higher-signal than a generic
 * urgency hit. We emit ONE finding per message, picking the
 * highest-priority category that matched.
 */
const CATEGORY_PRIORITY: Record<SuspiciousSentCategory, number> = {
  wire_request: 5,
  invoice_account_change: 4,
  gift_card_purchase: 4,
  credential_reset: 2,
  urgent_payment: 1,
};

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.in', 'gov.in', 'ac.in', 'org.in', 'net.in',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.kr', 'or.kr',
  'co.za', 'org.za', 'gov.za',
  'com.mx', 'gob.mx', 'org.mx',
  'com.sg', 'edu.sg',
  'com.hk', 'org.hk', 'gov.hk',
]);

/**
 * Extract the eTLD+1 of an email address. Mirrors `etldFrom` in
 * emailScorer.ts — kept inline rather than imported because that
 * helper is a private module-scope function. If the address is
 * malformed (no `@`), returns '' so callers can branch on truthiness.
 */
function toDomainOf(addr: string): string {
  if (!addr) return '';
  const at = addr.indexOf('@');
  if (at < 0) return '';
  const labels = addr.slice(at + 1).toLowerCase().split('.').filter(Boolean);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0]!;
  if (labels.length >= 3) {
    const tail2 = labels.slice(-2).join('.');
    if (MULTI_LABEL_PUBLIC_SUFFIXES.has(tail2)) {
      return labels.slice(-3).join('.');
    }
  }
  return labels.slice(-2).join('.');
}

/**
 * Digit-redact + truncate a subject for safe persistence to the
 * findings JSONB and the iOS client. Two-step ordering matters:
 * redact FIRST so we don't truncate mid-digit-run and end up with
 * `<<7 dig` as the trailing 80-char chunk.
 */
function buildSubjectExcerpt(subject: string): string {
  const redacted = redactSensitiveDigits(subject ?? '');
  // Collapse whitespace so multi-line subjects don't waste excerpt
  // budget on \n / runs of spaces.
  const collapsed = redacted.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, MAX_SUBJECT_EXCERPT);
}

/**
 * Compose the operator-readable reason for a finding. Generic — does
 * NOT echo body fragments or recipient local-parts. The matched_text
 * fields from `BecMatch` are PII-adjacent (they can quote a real
 * dollar amount or vendor name) so we never surface them; the
 * category alone carries the meaning operators need.
 */
function reasonFor(
  category: SuspiciousSentCategory,
  recipientFresh: boolean,
): string {
  const baseReason: Record<SuspiciousSentCategory, string> = {
    wire_request:
      'Outbound message contains wire-transfer instruction language.',
    invoice_account_change:
      'Outbound message announces a change to bank / wire / payroll account details.',
    gift_card_purchase:
      'Outbound message asks the recipient to purchase gift cards.',
    credential_reset:
      'Outbound message asks the recipient to verify, reset, or share credentials.',
    urgent_payment:
      'Outbound message uses urgent-payment language without other obvious context.',
  };
  if (recipientFresh) {
    return `${baseReason[category]} Recipient domain has no prior outbound history in the scan window.`;
  }
  return baseReason[category];
}

/**
 * Confidence calibration:
 *   - `high`   wire / invoice-change / gift-card to a brand-new external recipient
 *   - `medium` wire / invoice-change / gift-card to a known recipient
 *              OR credential-reset wording in either case
 *   - `low`    urgent-payment language alone, no other category
 */
function confidenceFor(
  category: SuspiciousSentCategory,
  recipientFresh: boolean,
): 'low' | 'medium' | 'high' {
  if (category === 'urgent_payment') return 'low';
  if (category === 'credential_reset') return 'medium';
  // wire_request / invoice_account_change / gift_card_purchase
  return recipientFresh ? 'high' : 'medium';
}

/**
 * Walk the BEC matches for one message and pick the single
 * highest-priority outgoing-relevant category that fired. Returns
 * null if no outgoing-relevant category matched.
 */
function pickCategory(matches: BecMatch[]): SuspiciousSentCategory | null {
  let best: SuspiciousSentCategory | null = null;
  let bestPriority = -1;
  for (const m of matches) {
    const mapped = mapBecToSentCategory(m.category);
    if (!mapped) continue;
    const p = CATEGORY_PRIORITY[mapped];
    if (p > bestPriority) {
      bestPriority = p;
      best = mapped;
    }
  }
  return best;
}

/**
 * Run the suspicious-sent audit. Idempotent, read-only, no DB
 * writes — the route layer is responsible for persisting the
 * findings into email_compromise_reports.findings.suspicious_sent.
 *
 * Provider-side errors propagate up to the caller. The route layer
 * already wraps every Pillar 3 audit in `.catch(() => [])` so a
 * single failing audit doesn't sink the whole compromise check.
 */
export async function runSuspiciousSentAudit(
  provider: EmailProvider,
  creds: LinkedAccountCredentials,
  opts: { window_days?: number; limit?: number } = {},
): Promise<SuspiciousSentAuditResult> {
  const window_days = clampPositive(opts.window_days, DEFAULT_WINDOW_DAYS, 1, 90);
  const limit = clampPositive(opts.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

  // Providers that don't expose a Sent-folder API return an empty
  // result. Composite verdict simply won't gain a `suspicious_sent`
  // signal for this account — equivalent to "we looked but couldn't
  // see anything," not "we saw zero suspicious messages."
  if (!hasGetSentMessages(provider)) {
    return { findings: [], scanned_count: 0, window_days };
  }

  const messages = await provider.getSentMessages(creds, { window_days, limit });

  // Defensive: respect the limit even if the provider over-shot.
  const bounded = messages.slice(0, limit);

  // Time-window filter. The window_days option is the AUTHORITATIVE
  // ceiling — a provider that ignored the hint and shipped older
  // mail gets cropped here. cutoff is computed once and reused.
  const cutoff = Date.now() - window_days * 24 * 60 * 60 * 1000;

  // First pass: figure out which recipient domains have prior
  // outbound traffic IN THIS SCAN WINDOW. A "fresh" recipient is one
  // we have not corresponded with in the trailing window — strongest
  // BEC signal when paired with a wire request. We use receivedAt
  // ordering (the IncomingMessage.received_at field doubles as the
  // sent-at timestamp for messages in the Sent folder; the provider
  // is responsible for the equivalence).
  const recipientHistogram = new Map<string, number>();
  for (const msg of bounded) {
    if (msg.received_at.getTime() < cutoff) continue;
    const firstTo = msg.to[0]?.address ?? '';
    const dom = toDomainOf(firstTo);
    if (!dom) continue;
    recipientHistogram.set(dom, (recipientHistogram.get(dom) ?? 0) + 1);
  }

  const findings: SuspiciousSentFinding[] = [];
  let scanned_count = 0;

  for (const msg of bounded) {
    if (msg.received_at.getTime() < cutoff) {
      // Out-of-window — don't even count toward scanned_count.
      // The caller's metric should reflect what we actually
      // evaluated, not what the provider over-shipped.
      continue;
    }
    scanned_count += 1;

    const matches = detectBecPatterns({
      subject: msg.subject ?? '',
      body_text: msg.body_text ?? '',
      body_html: msg.body_html ?? '',
    });
    if (matches.length === 0) continue;

    const category = pickCategory(matches);
    if (!category) continue;

    const firstTo = msg.to[0]?.address ?? '';
    const to_domain = toDomainOf(firstTo);
    if (!to_domain) {
      // No usable recipient — can't surface a finding without a
      // domain to display in the iOS UI. Skip rather than emit a
      // hollow row.
      continue;
    }

    // Recipient-freshness: did we send mail to this domain more
    // than ONCE in the window? Count > 1 means there's prior
    // history beyond this one message; count == 1 means this is
    // the only outbound to that domain in the window. We treat
    // count == 1 as "fresh" (single-shot conversation with the
    // suspicious payload).
    const recipientFresh = (recipientHistogram.get(to_domain) ?? 0) <= 1;

    findings.push({
      message_id: msg.external_message_id,
      sent_at: msg.received_at,
      to_domain,
      category,
      subject_excerpt: buildSubjectExcerpt(msg.subject ?? ''),
      confidence: confidenceFor(category, recipientFresh),
      reason: reasonFor(category, recipientFresh),
    });
  }

  return { findings, scanned_count, window_days };
}

/**
 * Clamp a positive integer option to [min, max], falling back to a
 * default for undefined / NaN / non-finite / non-integer input.
 * Defensive: a caller passing `limit: 1e9` or `limit: -1` MUST NOT
 * blow out the scan budget.
 */
function clampPositive(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
