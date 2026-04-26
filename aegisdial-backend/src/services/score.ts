import type {
  NumberSignals,
  Verdict,
  VerdictResponse,
  BusinessMatch,
} from '../types.js';
import { lookupHighSpoofTarget } from './highSpoofTargets.js';

export const SCORE_VERSION = 1;

export interface ScoreInput {
  e164: string;
  signals: NumberSignals;
}

export interface ScoreOutput {
  trust_score: number;
  verdict: Verdict;
  summary: string;
  user_message?: string;
  display_color: VerdictResponse['display_color'];
  recommended_action: VerdictResponse['recommended_action'];
}

export function computeScore(input: ScoreInput): ScoreOutput {
  const { e164, signals } = input;

  const highSpoofTarget = lookupHighSpoofTarget(e164);
  let businessMatch: BusinessMatch | null = signals.business_match;
  if (highSpoofTarget && !businessMatch) {
    businessMatch = {
      name: highSpoofTarget.name,
      category: highSpoofTarget.category,
      verified: true,
      source: 'high_spoof_targets_registry',
    };
  }

  let score = 70;

  score -= Math.min(40, 0.05 * signals.mention_count_30d);
  score -= 20 * signals.negative_sentiment_ratio;

  if (!signals.stir_shaken_attestation || signals.stir_shaken_attestation === 'C') {
    score -= 15;
  } else if (signals.stir_shaken_attestation === 'A') {
    score += 10;
  }

  if (signals.line_type === 'voip' && !businessMatch) {
    score -= 10;
  }

  const extraSources = Math.max(0, signals.complaint_sources - 1);
  score -= 5 * extraSources;

  if (businessMatch?.verified) {
    score += 20;
  }

  if (signals.number_age_days !== null && signals.number_age_days > 1825) {
    score += 10;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict: Verdict;
  let summary: string;
  let user_message: string | undefined;
  let display_color: VerdictResponse['display_color'];
  let recommended_action: VerdictResponse['recommended_action'];

  if (
    businessMatch?.verified &&
    highSpoofTarget &&
    signals.spoof_reports_30d > 10
  ) {
    verdict = 'spoof_risk_high';
    summary = `Verified ${businessMatch.name} line, but reported ${signals.spoof_reports_30d} times as spoofed in the last 30 days.`;
    user_message = highSpoofTarget.spoof_message;
    display_color = 'amber';
    recommended_action = 'verify_offline';
  } else if (score >= 80) {
    verdict = 'trusted';
    summary = businessMatch
      ? `Verified ${businessMatch.name}. No recent spoof reports.`
      : `Low-risk number. No significant spam signals.`;
    display_color = 'green';
    recommended_action = 'answer';
  } else if (score >= 50) {
    verdict = 'unknown';
    summary = buildUnknownSummary(signals);
    display_color = 'yellow';
    recommended_action = 'answer_with_caution';
  } else if (score >= 25) {
    verdict = 'suspicious';
    summary = buildSuspiciousSummary(signals);
    display_color = 'amber';
    recommended_action = 'verify_offline';
  } else {
    verdict = 'likely_spoof';
    summary = buildSpoofSummary(signals);
    display_color = 'red';
    recommended_action = 'decline';
  }

  return {
    trust_score: score,
    verdict,
    summary,
    user_message,
    display_color,
    recommended_action,
  };
}

function buildUnknownSummary(s: NumberSignals): string {
  if (s.mention_count_all === 0) {
    return 'No public reports found. Unknown caller.';
  }
  return `${s.mention_count_30d} mentions in last 30 days across ${s.complaint_sources} source${s.complaint_sources === 1 ? '' : 's'}.`;
}

function buildSuspiciousSummary(s: NumberSignals): string {
  const parts: string[] = [];
  if (s.mention_count_30d > 0) {
    parts.push(`${s.mention_count_30d} recent complaints`);
  }
  if (s.stir_shaken_attestation === 'C' || !s.stir_shaken_attestation) {
    parts.push('no carrier verification');
  }
  if (s.line_type === 'voip') {
    parts.push('VoIP origin');
  }
  return parts.length
    ? `Caution: ${parts.join(', ')}.`
    : 'Multiple risk signals detected.';
}

function buildSpoofSummary(s: NumberSignals): string {
  const parts: string[] = [];
  if (s.mention_count_30d > 50) {
    parts.push(`${s.mention_count_30d} complaints in 30 days`);
  } else if (s.mention_count_all > 0) {
    parts.push(`${s.mention_count_all} total complaints`);
  }
  if (s.stir_shaken_attestation === 'C' || !s.stir_shaken_attestation) {
    parts.push('STIR/SHAKEN failed');
  }
  if (s.complaint_sources > 1) {
    parts.push(`${s.complaint_sources} independent sources`);
  }
  return parts.length ? parts.join(' · ') : 'Heavy scam signals. Do not answer.';
}
