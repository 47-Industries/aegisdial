import { extractUrls, scanUrls, type UrlFinding } from '../../lib/urlScan.js';
import {
  detectBecPatterns,
  scoreBecMatches,
  describeBecCategory,
  type BecCategory,
} from './becPatterns.js';
import {
  detectSenderLookalike,
  describeSenderLookalikeKind,
  type SenderLookalikeFinding,
} from './senderLookalike.js';
import {
  checkAttachments,
  describeAttachmentThreat,
  type AttachmentFinding,
} from './attachmentHeuristics.js';
import type { IncomingMessage } from './types.js';

// Email Shield — score composition.
//
// Takes a provider-agnostic IncomingMessage (from Gmail / Microsoft
// Graph / IMAP) and produces a verdict on the same 0..100 scale and
// 'safe' / 'suspicious' / 'fraud' vocabulary as Live Shield + SMS
// Shield. The user mental model is one risk-level scale across
// all three surfaces.
//
// SCORE SOURCES (deterministic-only; LLM augmenter is a future flag):
//
//   1. BEC pattern library (becPatterns.ts): up to ~100 from
//      category-weighted body/subject phrase matches. The
//      heaviest single signal in the stack — invoice_redirect +
//      wire_request together can saturate this slice alone.
//
//   2. Sender lookalike (senderLookalike.ts):
//        - display_name_brand_mismatch: +25
//        - brand_keyword_in_domain:     +25
//        - typosquat_of_known_brand:    +20
//        - idn_homograph:               +15
//      Multiple lookalike findings on the same address: take MAX
//      (no double-counting from the same root impersonation).
//
//   3. Authentication (auth_results from IncomingMessage):
//        - spf=fail:    +15
//        - dkim=fail:   +15
//        - dmarc=fail:  +25
//      pass / none / softfail / neutral do NOT contribute — a
//      missing AR header (the "none" floor) is the legacy case,
//      not a positive signal of badness.
//
//   4. Reply-To divergence: if reply_to.address exists AND its
//      domain != from.address domain, +10. Classic BEC trick to
//      siphon replies to attacker-controlled inbox.
//
//   5. URL scan (urlScan.ts, reused from SMS Shield):
//        - GSB-confirmed malicious: +25
//        - heuristic-suspicious:    +15 (additive but bounded —
//          only the higher of the two bumps applies)
//
//   6. Attachment heuristics (attachmentHeuristics.ts):
//        - one or more 'fraud'-severity threats: +25
//        - one or more 'suspicious'-severity threats: +15
//      (higher of the two; not stacked)
//
// VERDICT THRESHOLDS (mirror SMS Shield + Live Shield):
//   - 'safe'        : 0..29 — nothing actionable.
//   - 'suspicious'  : 30..69 — user discretion advised.
//   - 'fraud'       : 70..100 — high confidence; iOS recommends "delete + block".
//
// CAP: hard 100. No matter how many categories light up, the
// score doesn't overflow.

export interface EmailScoreResult {
  fraud_score: number;
  verdict: 'safe' | 'suspicious' | 'fraud';
  /**
   * Short bullets the iOS verdict screen renders as a list. Capped
   * at 8. NEVER echoes back PII fragments (matched_text, filenames,
   * URLs) — only category descriptions.
   */
  explainable_reasons: string[];
  /**
   * BEC + lookalike + attachment-threat category names. Sorted for
   * stable diffing.
   */
  triggered_categories: string[];
  /** Per-URL findings (reuse of urlScan.ts). */
  url_findings: UrlFinding[];
  /** Per-attachment findings (deterministic heuristics). */
  attachment_findings: AttachmentFinding[];
  /** Sender-lookalike findings, surfaced separately for admin dashboards. */
  sender_lookalike_findings: SenderLookalikeFinding[];
}

const REASON_CAP = 8;

/**
 * Score an IncomingMessage. The single entry point the polling
 * worker (P6) calls per message before persisting to email_scans.
 *
 * Side effects: calls urlScan.scanUrls, which is cache-fronted but
 * does network I/O on cache miss (GSB lookup). No DB writes; the
 * caller (worker) persists the EmailScoreResult to email_scans.
 */
export async function scoreEmailMessage(
  msg: IncomingMessage,
): Promise<EmailScoreResult> {
  // 1. BEC pattern matches.
  const becMatches = detectBecPatterns({
    subject: msg.subject,
    body_text: msg.body_text,
    body_html: msg.body_html,
  });
  const { pattern_score, triggered_categories: becCategories } = scoreBecMatches(becMatches);

  // 2. Sender lookalike.
  const lookalikeFindings = detectSenderLookalike({
    from_address: msg.from.address,
    display_name: msg.from.display,
  });

  // 3. Authentication.
  const authPenalty = scoreAuthResults(msg.auth_results);

  // 4. Reply-To divergence. M6 fix: don't penalize free-mail-to-
  // free-mail divergence — a parent maintaining two free-mail
  // accounts (gmail + yahoo) forwarding mail to a Pro subscriber
  // is normal, not BEC. The divergence-as-BEC-signal applies when
  // a corporate / brand from-address has an attacker-controlled
  // reply-to, which by definition crosses out of free-mail.
  const replyToPenalty = isReplyToDivergent(msg) && !isFreeMailToFreeMail(msg) ? 10 : 0;

  // 5. URL scan (reused — same code path as SMS Shield).
  const urls = [
    ...extractUrls(msg.body_text),
    ...extractUrls(msg.body_html),
  ];
  const dedupedUrls = [...new Set(urls)];
  const urlFindings = dedupedUrls.length > 0 ? await scanUrls(dedupedUrls) : [];
  const hasMaliciousUrl = urlFindings.some((f) => f.is_malicious);
  const hasSuspiciousUrl = urlFindings.some(
    (f) => !f.is_malicious && f.threat_types.length > 0,
  );

  // 6. Attachment heuristics.
  const attachmentFindings = checkAttachments(msg.attachments);
  const hasFraudAttachment = attachmentFindings.some((f) => f.severity === 'fraud');
  const hasSuspiciousAttachment = attachmentFindings.some(
    (f) => f.severity === 'suspicious',
  );

  // Compose. Each slice has its own cap-aware contribution.
  let fraud_score = pattern_score;

  // Lookalike contribution: take the MAX of all findings so a
  // display-name-mismatch AND a typosquat on the same address
  // don't double-count.
  let lookalikeContribution = 0;
  for (const f of lookalikeFindings) {
    const c = scoreLookalikeKind(f.kind);
    if (c > lookalikeContribution) lookalikeContribution = c;
  }
  fraud_score += lookalikeContribution;

  fraud_score += authPenalty;
  fraud_score += replyToPenalty;

  if (hasMaliciousUrl) fraud_score += 25;
  else if (hasSuspiciousUrl) fraud_score += 15;

  if (hasFraudAttachment) fraud_score += 25;
  else if (hasSuspiciousAttachment) fraud_score += 15;

  fraud_score = Math.min(100, fraud_score);

  let verdict: EmailScoreResult['verdict'];
  if (fraud_score >= 70) verdict = 'fraud';
  else if (fraud_score >= 30) verdict = 'suspicious';
  else verdict = 'safe';

  // Build explainable_reasons. Adversarial-review H2 fix: reorder
  // so the highest-confidence binary signals (auth fail, reply-to
  // divergence, lookalike) surface FIRST, then the strongest BEC
  // categories (wire / invoice / gift-card / payroll), then
  // concrete URL / attachment evidence, then weaker BEC
  // categories. The prior order buried DMARC-fail and wire-request
  // under attorney_pretext-style soft signals when the cap was
  // saturated. The 8-bullet cap stays — but the bullets we keep
  // are now the strongest 8, not the first 8 in code-order.
  const reasons: string[] = [];

  // Tier 1: binary "the message is provably forged" signals.
  if (authPenalty > 0 && reasons.length < REASON_CAP) {
    const failures: string[] = [];
    if (msg.auth_results.spf === 'fail') failures.push('SPF');
    if (msg.auth_results.dkim === 'fail') failures.push('DKIM');
    if (msg.auth_results.dmarc === 'fail') failures.push('DMARC');
    if (failures.length > 0) {
      reasons.push(`Email failed ${failures.join(' / ')} authentication checks.`);
    }
  }
  for (const f of lookalikeFindings) {
    if (reasons.length >= REASON_CAP) break;
    reasons.push(describeSenderLookalikeKind(f.kind, f.impersonated_brand));
  }
  if (replyToPenalty > 0 && reasons.length < REASON_CAP) {
    reasons.push('Reply-To address belongs to a different domain than the From address — a known BEC tactic.');
  }

  // Tier 2: the strongest BEC categories — wire / invoice redirect
  // / payroll / gift card / crypto. These are the canonical BEC
  // signatures; if one fires, the user needs to see it BEFORE we
  // start showing weaker pattern rationale.
  const STRONG_BEC: ReadonlySet<BecCategory> = new Set([
    'wire_request',
    'invoice_redirect',
    'payroll_change',
    'gift_card_purchase',
    'crypto_request',
  ]);
  for (const c of becCategories) {
    if (reasons.length >= REASON_CAP) break;
    if (STRONG_BEC.has(c as BecCategory)) {
      reasons.push(describeBecCategory(c as BecCategory));
    }
  }

  // Tier 3: concrete URL / attachment evidence.
  if (hasMaliciousUrl && reasons.length < REASON_CAP) {
    reasons.push('Contains a link flagged by safe-browsing as malicious.');
  } else if (hasSuspiciousUrl && reasons.length < REASON_CAP) {
    reasons.push('Contains a link with suspicious indicators (TLD, lookalike domain, or brand keyword in URL).');
  }
  // Surface the first attachment-threat bullet per unique threat
  // category (a message with 3 macro-bearing docs still shows
  // one bullet, not three).
  const seenThreatTypes = new Set<string>();
  for (const af of attachmentFindings) {
    for (const t of af.threats) {
      if (seenThreatTypes.has(t)) continue;
      seenThreatTypes.add(t);
      if (reasons.length >= REASON_CAP) break;
      reasons.push(describeAttachmentThreat(t));
    }
    if (reasons.length >= REASON_CAP) break;
  }

  // Tier 4: weaker BEC categories (urgency, secrecy, authority
  // impersonation, attorney pretext, mobile-only contact, fake
  // shipping, credential phish, fake invoice attachment).
  for (const c of becCategories) {
    if (reasons.length >= REASON_CAP) break;
    if (!STRONG_BEC.has(c as BecCategory)) {
      reasons.push(describeBecCategory(c as BecCategory));
    }
  }

  if (reasons.length === 0) {
    reasons.push('No common phishing or BEC patterns detected.');
  }

  // Triggered categories: BEC categories + lookalike kinds +
  // attachment threats. Stable sorted for diffing.
  const triggered = new Set<string>(becCategories);
  for (const f of lookalikeFindings) triggered.add(`sender_${f.kind}`);
  for (const af of attachmentFindings) for (const t of af.threats) triggered.add(`attachment_${t}`);
  if (replyToPenalty > 0) triggered.add('reply_to_divergence');
  if (authPenalty > 0) triggered.add('auth_failure');
  if (hasMaliciousUrl) triggered.add('malicious_url');
  else if (hasSuspiciousUrl) triggered.add('suspicious_url');

  return {
    fraud_score,
    verdict,
    explainable_reasons: reasons.slice(0, REASON_CAP),
    triggered_categories: [...triggered].sort(),
    url_findings: urlFindings,
    attachment_findings: attachmentFindings,
    sender_lookalike_findings: lookalikeFindings,
  };
}

/**
 * Per-axis score contribution for SPF / DKIM / DMARC verdicts.
 * Only `fail` contributes; pass / none / softfail / neutral are
 * floor.
 */
function scoreAuthResults(
  auth: IncomingMessage['auth_results'],
): number {
  let s = 0;
  if (auth.spf === 'fail') s += 15;
  if (auth.dkim === 'fail') s += 15;
  if (auth.dmarc === 'fail') s += 25;
  return s;
}

/**
 * Reply-To divergence detector. Returns true if reply_to.address
 * is present AND its eTLD+1 differs from the from-address eTLD+1.
 * The classic BEC trick: From is the spoofed brand domain, Reply-To
 * is the attacker's mailbox.
 */
function isReplyToDivergent(msg: IncomingMessage): boolean {
  if (!msg.reply_to || !msg.reply_to.address) return false;
  const fromDomain = etldFrom(msg.from.address);
  const replyDomain = etldFrom(msg.reply_to.address);
  return fromDomain !== '' && replyDomain !== '' && fromDomain !== replyDomain;
}

function etldFrom(addr: string): string {
  const at = addr.indexOf('@');
  if (at < 0) return '';
  const labels = addr.slice(at + 1).toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 1) return labels.join('.');
  // Adversarial-review H1 fix: respect multi-label public suffixes
  // so `bbc.co.uk` and `evil.co.uk` correctly compare as DIFFERENT
  // eTLD+1s, not both as `co.uk`. Without this, every UK BEC where
  // the attacker registers `evil.co.uk` would slip past reply-to-
  // divergence detection.
  if (labels.length >= 3) {
    const tail2 = labels.slice(-2).join('.');
    if (MULTI_LABEL_PUBLIC_SUFFIXES.has(tail2)) {
      return labels.slice(-3).join('.');
    }
  }
  return labels.slice(-2).join('.');
}

// Mirrors the multi-label suffix set in senderLookalike.ts. Kept
// inline here so the scorer's eTLD logic doesn't import a private
// helper from a sibling module.
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
 * Common free-mail eTLD+1 set. Used by isFreeMailToFreeMail to
 * suppress the reply-to-divergence penalty when both addresses
 * are on consumer free-mail providers — a legitimate use case
 * (forwarded mail, family across providers).
 */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'ymail.com', 'rocketmail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'aol.com',
  'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com',
  'gmx.com', 'gmx.us', 'gmx.de',
  'mail.com', 'fastmail.com', 'tutanota.com',
]);

function isFreeMailToFreeMail(msg: IncomingMessage): boolean {
  if (!msg.reply_to || !msg.reply_to.address) return false;
  const fromDomain = etldFrom(msg.from.address);
  const replyDomain = etldFrom(msg.reply_to.address);
  return FREE_MAIL_DOMAINS.has(fromDomain) && FREE_MAIL_DOMAINS.has(replyDomain);
}

function scoreLookalikeKind(
  kind: SenderLookalikeFinding['kind'],
): number {
  switch (kind) {
    case 'display_name_brand_mismatch': return 25;
    case 'brand_keyword_in_domain':     return 25;
    case 'typosquat_of_known_brand':    return 20;
    case 'idn_homograph':               return 15;
  }
}
