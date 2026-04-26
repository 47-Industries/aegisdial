import { detectPhrases, type PhraseHit } from '../lib/scamPhrases.js';
import { scoreHits } from './liveShield.js';
import { extractUrls, scanUrls, type UrlFinding } from '../lib/urlScan.js';

// SMS / iMessage classifier. Combines:
//   - on-device-style phrase detection
//   - URL reputation (Google Safe Browsing + heuristics)
// and returns an Apple ILMessageFilterAction-compatible result
// (allow | junk | promotion | transaction).
//
// Decision policy:
//   - any malicious URL → junk
//   - risk_level == critical → junk
//   - risk_level == high → junk
//   - risk_level == medium → promotion (warn, don't hard-block)
//   - contains clear transactional keywords with no phrase hits → transaction
//   - otherwise → allow

export type SmsAction = 'allow' | 'junk' | 'promotion' | 'transaction';

export interface SmsClassification {
  action: SmsAction;
  risk_score: number;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  phrase_hits: PhraseHit[];
  triggered_categories: string[];
  url_hits: UrlFinding[];
  reason: string;
}

const TRANSACTIONAL_HINTS =
  /\b(verification code|confirmation code|one.?time|otp|your\s+(order|delivery|shipment|receipt|transaction|payment|charge))\b/i;

export async function classifySms(text: string, _sender?: string): Promise<SmsClassification> {
  const hits = detectPhrases(text);
  const score = scoreHits(hits);
  const urls = extractUrls(text);
  const urlFindings = urls.length > 0 ? await scanUrls(urls) : [];
  const hasMaliciousUrl = urlFindings.some((f) => f.is_malicious);

  // SMS context is noisier than calls, but smishing patterns are also
  // more distinctive — a single high-confidence smishing_bait hit is
  // enough to junk, especially when paired with any URL or time
  // pressure.
  const hasSmishingBait = score.triggered_categories.includes('smishing_bait');
  const hasTimePressure = score.triggered_categories.includes('time_pressure');
  const hasUrl = urls.length > 0;

  let action: SmsAction;
  let reason: string;
  if (hasMaliciousUrl) {
    action = 'junk';
    reason = 'Contains a flagged malicious URL.';
  } else if (score.risk_level === 'critical' || score.risk_level === 'high') {
    action = 'junk';
    reason = score.rationale.join('; ') || 'Matches multiple scam patterns.';
  } else if (hasSmishingBait && (hasTimePressure || hasUrl)) {
    // Classic smishing shape: bait phrase + urgency OR bait phrase +
    // link. Real legit messages don't combine these.
    action = 'junk';
    reason = `Smishing pattern: ${score.rationale.join('; ')}`;
  } else if (score.risk_level === 'medium') {
    action = 'promotion';
    reason = score.rationale.join('; ') || 'Contains one scam pattern; treating as promotion.';
  } else if (TRANSACTIONAL_HINTS.test(text)) {
    action = 'transaction';
    reason = 'Looks like a legitimate transaction / confirmation message.';
  } else {
    action = 'allow';
    reason = 'No scam patterns detected.';
  }

  return {
    action,
    risk_score: score.risk_score,
    risk_level: score.risk_level,
    phrase_hits: hits,
    triggered_categories: score.triggered_categories,
    url_hits: urlFindings,
    reason,
  };
}
