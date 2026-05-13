import { detectPhrases } from '../lib/scamPhrases.js';
import { scoreHits } from './liveShield.js';
import { extractUrls, scanUrls } from '../lib/urlScan.js';

// SMS Shield — manual-paste scoring service.
//
// Sibling to services/smsClassify.ts (which serves Apple's
// ILMessageFilterExtension). Differences:
//   - This service is INVOKED by the user (paste a text → score it),
//     not by Apple's silent filter extension. Response is designed
//     for direct human display, not for an iOS Action enum.
//   - Returns a 0..100 fraud_score (same scale as Live Shield's
//     risk_score) so the iOS recap UI can render a familiar
//     red/yellow/green progress chip.
//   - Surfaces an `explainable_reasons[]` list — short human-
//     readable bullets the user can read on the result screen.
//   - Includes URL findings inline (which links are flagged + why).
//
// Today this is pattern + URL scan only — already strong for known
// smishing shapes, deterministic, no per-request cost. LLM augmentation
// would land behind its own flag (e.g. V4_SMS_LLM_ENABLED) in a later
// phase; the deterministic path stays the trust-first default until an
// operator turns LLM on explicitly.

export interface SmsManualScoreResult {
  /** 0..100, same scale as Live Shield risk_score. */
  fraud_score: number;
  /**
   * Human-facing verdict:
   *   - 'safe'        : 0..29 — no smishing patterns
   *   - 'suspicious'  : 30..69 — at least one pattern; user discretion
   *   - 'fraud'       : 70..100 — multiple patterns OR a malicious link
   * Mirrors the Live Shield risk_level vocabulary so an operator
   * (or operator-trained user) doesn't have to learn a second scale.
   */
  verdict: 'safe' | 'suspicious' | 'fraud';
  /**
   * Short bullets the iOS result screen can render as a list.
   * Caps at 8 bullets; UI truncation isn't this service's concern,
   * but unbounded server-side leaks PII (a quoted matched_text
   * fragment could include a real digit string).
   */
  explainable_reasons: string[];
  /** Pattern categories the message matched (smishing_bait, time_pressure, etc.). */
  triggered_categories: string[];
  /** Per-URL findings: which links are malicious and why. */
  url_findings: Array<{
    url: string;
    is_malicious: boolean;
    /** GSB threat categories ('MALWARE', 'SOCIAL_ENGINEERING', etc.)
     *  or 'heuristic' tags. Empty when clean. */
    threat_types: string[];
    /** Provenance: 'safe_browsing' | 'heuristic' | 'cache'. */
    source: 'safe_browsing' | 'heuristic' | 'cache';
  }>;
}

const REASON_CAP = 8;

/**
 * Score a user-pasted SMS body. Pure-ish — calls extractUrls + scanUrls
 * (which is cache-fronted but does network I/O on cache miss). No DB
 * writes; the caller persists to sms_scans for history.
 */
export async function scoreManualSms(text: string): Promise<SmsManualScoreResult> {
  const hits = detectPhrases(text);
  const score = scoreHits(hits);
  const urls = extractUrls(text);
  const urlFindings = urls.length > 0 ? await scanUrls(urls) : [];
  const hasMaliciousUrl = urlFindings.some((f) => f.is_malicious);
  // Heuristic-only flag — URL has suspicious indicators (TLD,
  // smishing keyword in URL, lookalike domain) but Google Safe
  // Browsing didn't confirm. Worth a score nudge because real
  // deployments may lack a GSB key and the heuristic is calibrated
  // to be high-precision (low false-positive on real banking URLs).
  const hasSuspiciousUrl = urlFindings.some(
    (f) => !f.is_malicious && f.threat_types.length > 0,
  );

  // Compose fraud_score (0..100) from:
  //   - pattern-based score (0..100, already in scoreHits)
  //   - +25 for any malicious URL (GSB-confirmed)
  //   - +15 for any heuristic-suspicious URL (additive but only one
  //     of the two URL bumps applies — the malicious bump is the
  //     ceiling; suspicious doesn't stack on top)
  // Cap is hard at 100; pattern + URL stacking should reach 'fraud'
  // verdict without overshooting.
  let fraud_score = score.risk_score;
  if (hasMaliciousUrl) fraud_score = Math.min(100, fraud_score + 25);
  else if (hasSuspiciousUrl) fraud_score = Math.min(100, fraud_score + 15);

  let verdict: SmsManualScoreResult['verdict'];
  if (fraud_score >= 70) verdict = 'fraud';
  else if (fraud_score >= 30) verdict = 'suspicious';
  else verdict = 'safe';

  // Build explainable_reasons. Pattern rationale already comes from
  // scoreHits; add a URL-flagged callout when relevant, cap at 8.
  const reasons: string[] = [];
  if (hasMaliciousUrl) reasons.push('Contains a link flagged by safe-browsing.');
  else if (hasSuspiciousUrl) {
    reasons.push('Contains a link with suspicious indicators (TLD, lookalike domain, or smishing keyword).');
  }
  for (const r of score.rationale) {
    if (reasons.length >= REASON_CAP) break;
    reasons.push(r);
  }
  if (reasons.length === 0 && urls.length > 0) {
    reasons.push(`Contains ${urls.length} link${urls.length === 1 ? '' : 's'} — verify the sender before tapping.`);
  }
  if (reasons.length === 0) {
    reasons.push('No common smishing patterns detected.');
  }

  return {
    fraud_score,
    verdict,
    explainable_reasons: reasons.slice(0, REASON_CAP),
    triggered_categories: score.triggered_categories,
    url_findings: urlFindings.map((f) => ({
      url: f.url,
      is_malicious: f.is_malicious,
      threat_types: f.threat_types,
      source: f.source,
    })),
  };
}
