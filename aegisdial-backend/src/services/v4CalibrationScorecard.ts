import { getStageTimingSummary } from './v4StageTimingSummary.js';
import { getClaimCoverageSummary } from './v4ClaimCoverageSummary.js';
import { getStageConfidenceSummary } from './v4StageConfidenceSummary.js';
import type { StageTimingSummary, PlaybookStageSummary } from './v4StageTimingSummary.js';
import type {
  ClaimCoverageSummary,
  PlaybookClaimCoverage,
} from '../lib/playbookClaimCoverage.js';
import type {
  StageConfidenceSummary,
  StageConfidenceRow,
} from '../lib/stageConfidenceCoverage.js';
import { config } from '../config.js';

// Live Shield v4 — Phase 14 — calibration scorecard.
//
// Phases 11/12/13 give the operator three calibration dashboards.
// Phase 14 collapses those into one yes-or-no answer: is v4 safe
// to flip to ON in prod, or does it still need calibration work?
//
// Sources (all already in production, no new emit sites):
//   - Phase 11: v4.stage_timing.evaluated — did transitions hit
//     the expected window?
//   - Phase 12: v4.b4.claim_extracted_vs_playbook — did B4 extract
//     the expected claim types per playbook?
//   - Phase 13: v4.classifier.classified — is the classifier
//     confidently locking on?
//
// The scorecard rolls each up to a count of "flagged" pairs/playbooks
// and emits an overall verdict. The actual flagged-row details stay
// in the underlying dashboards — Phase 14 is a triage entry-point,
// not a replacement.

export interface ScorecardThresholds {
  /**
   * Minimum total_events PER AXIS before a 'ship_ready' verdict is
   * possible. Below this an axis flips to 'insufficient_data'
   * regardless of how clean the rows look — a dashboard saying
   * "0/70 pairs flagged" when there are only 3 total events doesn't
   * mean v4 is ready, it means v4 hasn't run enough.
   *
   * IMPORTANT — H-3 adversarial-review note: the three axes count
   * different units. Timing counts stage TRANSITIONS (~1 per
   * committed advance, ~3-5 per call). Claim-coverage counts CLAIM
   * EXTRACTIONS (~4-6 per call). Confidence counts CLASSIFIER
   * RETURNS including sub-threshold/debounced (much higher rate).
   * The same min_events scalar maps to different call counts per
   * axis (roughly: 50 events = 10 calls of timing data, 8 calls of
   * claim data, 3 calls of confidence data). When tuning, lean
   * toward the slowest-emitting axis (timing) — staging operator
   * who wants "at least 50 calls of evidence" should pass
   * ?min_events=250 or higher. Per-axis thresholds are a future
   * enhancement; today this is one knob.
   */
  min_events: number;
}

export const DEFAULT_SCORECARD_THRESHOLDS: ScorecardThresholds = {
  min_events: 50,
};

interface AxisFlag {
  playbook_id: string;
  stage?: string;
  reason: string;
}

export interface ScorecardAxisCounts {
  total_events: number;
  /**
   * Canonical taxonomy size for this axis — 70 (playbook×stage) for
   * timing/confidence, 14 (playbook only) for claim_coverage. The
   * zero-fill total, NOT the number of pairs that had data.
   * pairs_with_data = pairs - by_health.no_data.
   */
  pairs: number;
  /**
   * Counts of pairs in each health bucket. Keys are PER-AXIS, not a
   * shared union — see the per-axis docstring on the axis field.
   * Consumers should default-zero on missing keys.
   *   - timing: { healthy, drift, no_data }
   *   - claim_coverage: { aligned, gap, surprise, no_data }
   *   - confidence: { healthy, low_confidence, no_data }
   */
  by_health: Record<string, number>;
  /** Pairs/playbooks the operator should look at, capped at 20. */
  flagged: AxisFlag[];
  /**
   * True when the underlying axis had more flagged rows than fit in
   * the cap. M-3 adversarial-fix: a dashboard consumer should be
   * able to tell at a glance that the flagged list is incomplete
   * without having to compute by_health[bad_bucket] - flagged.length.
   */
  flagged_truncated: boolean;
  /**
   * Count of events whose tags didn't match the canonical taxonomy
   * for this axis (typo'd stage / unknown playbook / malformed
   * verdict). L-5 adversarial-fix: scorecard previously discarded
   * this signal so an upstream emitter bug looked identical to
   * "no data yet." Non-zero here means chase a typo, not wait.
   */
  off_taxonomy_count: number;
}

export interface CalibrationScorecard {
  hours: number;
  thresholds: ScorecardThresholds;
  timing: ScorecardAxisCounts;
  claim_coverage: ScorecardAxisCounts;
  confidence: ScorecardAxisCounts;
  overall: {
    /**
     *   - 'ship_ready':       every axis is below threshold for flagged pairs
     *                         AND each axis has >= min_events total_events
     *   - 'needs_calibration': any axis has >= 1 flagged pair AND has
     *                         enough events to trust the verdict
     *   - 'insufficient_data': any axis has < min_events total_events
     *                         (regardless of flag counts — too few
     *                          observations to draw conclusions)
     */
    verdict: 'ship_ready' | 'needs_calibration' | 'insufficient_data';
    reason: string;
    /**
     * v4 master flag state echoed for operator context. When false,
     * v4 emits zero telemetry — the verdict will be
     * 'insufficient_data' and the `reason` will name the master flag
     * explicitly (M-1 adversarial fix).
     */
    v4_aware_enabled: boolean;
    /**
     * True when EVERY axis has total_events === 0. Distinct from
     * 'insufficient_data' because a partial-data state (one axis
     * with events, two axes empty) is also insufficient but the
     * triage is different. H-1 adversarial-fix surface.
     */
    all_axes_empty: boolean;
  };
}

const FLAGGED_CAP = 20;

/**
 * Pure reshape from three dashboard summaries to the rolled-up
 * scorecard. Pure function so the verdict logic is testable in
 * isolation without hitting any of the underlying aggregators.
 */
export function composeScorecard(
  timing: StageTimingSummary,
  claims: ClaimCoverageSummary,
  confidence: StageConfidenceSummary,
  opts: {
    hours: number;
    thresholds: ScorecardThresholds;
    v4_aware_enabled: boolean;
  },
): CalibrationScorecard {
  const timingAxis = computeTimingAxis(timing);
  const claimsAxis = computeClaimsAxis(claims);
  const confidenceAxis = computeConfidenceAxis(confidence);

  const all_axes_empty =
    timingAxis.total_events === 0 &&
    claimsAxis.total_events === 0 &&
    confidenceAxis.total_events === 0;

  let verdict: CalibrationScorecard['overall']['verdict'];
  let reason: string;

  // H-1 adversarial-fix: when EVERY axis is empty, ship_ready is
  // never the right answer regardless of how low min_events is set.
  // A scorecard saying "ship_ready" with zero data points anywhere
  // is operationally meaningless and trivially weaponizable —
  // ?min_events=0 against an empty database would otherwise rubber-
  // stamp a green light. Check this BEFORE the min_events test.
  if (all_axes_empty) {
    verdict = 'insufficient_data';
    // M-1 adversarial-fix: when the master flag is off, no v4
    // telemetry emits regardless of traffic. The operator's first
    // triage step needs to be flipping the flag, not waiting for
    // more data. Call this out explicitly so the human-readable
    // reason matches the operational fix.
    reason = opts.v4_aware_enabled
      ? 'all axes empty — v4 master flag is on but no telemetry has emitted yet'
      : 'v4 master flag (V4_PLAYBOOK_AWARE_ENABLED) is OFF — no telemetry to evaluate';
  } else {
    // Insufficient data dominates — if any axis has too few events,
    // its flag count isn't trustworthy, and we shouldn't claim
    // ship_ready OR needs_calibration based on noise.
    const insufficient = [
      timingAxis.total_events < opts.thresholds.min_events ? 'timing' : null,
      claimsAxis.total_events < opts.thresholds.min_events ? 'claim_coverage' : null,
      confidenceAxis.total_events < opts.thresholds.min_events ? 'confidence' : null,
    ].filter((x): x is string => x !== null);

    if (insufficient.length > 0) {
      verdict = 'insufficient_data';
      reason = `axes below min_events=${opts.thresholds.min_events}: ${insufficient.join(', ')}`;
    } else if (
      timingAxis.flagged.length > 0 ||
      claimsAxis.flagged.length > 0 ||
      confidenceAxis.flagged.length > 0
    ) {
      verdict = 'needs_calibration';
      const counts = [
        timingAxis.flagged.length > 0 ? `timing=${timingAxis.flagged.length}` : null,
        claimsAxis.flagged.length > 0 ? `claim_coverage=${claimsAxis.flagged.length}` : null,
        confidenceAxis.flagged.length > 0 ? `confidence=${confidenceAxis.flagged.length}` : null,
      ].filter((x): x is string => x !== null);
      reason = `flagged pairs across axes: ${counts.join(', ')}`;
    } else {
      verdict = 'ship_ready';
      reason = `all axes healthy with sufficient data (min_events=${opts.thresholds.min_events})`;
    }
  }

  return {
    hours: opts.hours,
    thresholds: opts.thresholds,
    timing: timingAxis,
    claim_coverage: claimsAxis,
    confidence: confidenceAxis,
    overall: {
      verdict,
      reason,
      v4_aware_enabled: opts.v4_aware_enabled,
      all_axes_empty,
    },
  };
}

function computeTimingAxis(s: StageTimingSummary): ScorecardAxisCounts {
  const by_health: Record<string, number> = { healthy: 0, drift: 0, no_data: 0 };
  const flagged: AxisFlag[] = [];
  let totalFlaggableCount = 0;
  for (const r of s.rows) {
    by_health[r.health] = (by_health[r.health] ?? 0) + 1;
    if (r.health === 'drift') {
      totalFlaggableCount++;
      if (flagged.length < FLAGGED_CAP) {
        flagged.push({
          playbook_id: r.playbook_id,
          stage: r.stage,
          reason: `in_range=${r.in_range_pct ?? 0}% (< 70%)`,
        });
      }
    }
  }
  // Sort flagged by playbook_id+stage for deterministic order.
  flagged.sort((a, b) =>
    a.playbook_id.localeCompare(b.playbook_id) || (a.stage ?? '').localeCompare(b.stage ?? ''),
  );
  return {
    total_events: s.total_events,
    pairs: s.rows.length,
    by_health,
    flagged,
    flagged_truncated: totalFlaggableCount > flagged.length,
    off_taxonomy_count: s.dropped_off_taxonomy.count,
  };
}

function computeClaimsAxis(s: ClaimCoverageSummary): ScorecardAxisCounts {
  const by_health: Record<string, number> = {
    aligned: 0,
    gap: 0,
    surprise: 0,
    no_data: 0,
  };
  const flagged: AxisFlag[] = [];
  let totalFlaggableCount = 0;
  for (const r of s.rows) {
    by_health[r.calibration] = (by_health[r.calibration] ?? 0) + 1;
    if (r.calibration === 'gap' || r.calibration === 'surprise') {
      totalFlaggableCount++;
      if (flagged.length < FLAGGED_CAP) {
        flagged.push({
          playbook_id: r.playbook_id,
          reason: scorecardClaimReason(r),
        });
      }
    }
  }
  flagged.sort((a, b) => a.playbook_id.localeCompare(b.playbook_id));
  return {
    total_events: s.total_events,
    pairs: s.rows.length,
    by_health,
    flagged,
    flagged_truncated: totalFlaggableCount > flagged.length,
    off_taxonomy_count: s.dropped_off_taxonomy.count,
  };
}

function scorecardClaimReason(r: PlaybookClaimCoverage): string {
  if (r.calibration === 'surprise') {
    const surpriseList = r.unexpected_observed
      .slice(0, 3)
      .map((u) => `${u.claim_type}(${u.count})`)
      .join(', ');
    return `surprise: ${surpriseList}`;
  }
  if (r.calibration === 'gap') {
    return `gap: missing ${r.expected_missing.join(', ')}`;
  }
  return r.calibration;
}

function computeConfidenceAxis(s: StageConfidenceSummary): ScorecardAxisCounts {
  const by_health: Record<string, number> = {
    healthy: 0,
    low_confidence: 0,
    no_data: 0,
  };
  const flagged: AxisFlag[] = [];
  let totalFlaggableCount = 0;
  for (const r of s.rows) {
    by_health[r.health] = (by_health[r.health] ?? 0) + 1;
    if (r.health === 'low_confidence') {
      totalFlaggableCount++;
      if (flagged.length < FLAGGED_CAP) {
        flagged.push({
          playbook_id: r.playbook_id,
          stage: r.stage,
          reason: `committed_confident=${r.committed_confident_pct ?? 0}% (< 50%)`,
        });
      }
    }
  }
  flagged.sort((a, b) =>
    a.playbook_id.localeCompare(b.playbook_id) || (a.stage ?? '').localeCompare(b.stage ?? ''),
  );
  return {
    total_events: s.total_events,
    pairs: s.rows.length,
    by_health,
    flagged,
    flagged_truncated: totalFlaggableCount > flagged.length,
    off_taxonomy_count: s.dropped_off_taxonomy.count,
  };
}

/**
 * Fetch all three dashboards in parallel and compose the scorecard.
 * Errors propagate — the admin route translates to 500.
 */
export async function getCalibrationScorecard(
  hours: number,
  thresholds: ScorecardThresholds = DEFAULT_SCORECARD_THRESHOLDS,
): Promise<CalibrationScorecard> {
  const [timing, claims, confidence] = await Promise.all([
    getStageTimingSummary(hours),
    getClaimCoverageSummary(hours),
    getStageConfidenceSummary(hours),
  ]);
  return composeScorecard(timing, claims, confidence, {
    hours,
    thresholds,
    v4_aware_enabled: config.V4_PLAYBOOK_AWARE_ENABLED,
  });
}

// Re-export the underlying row types so test files can name them
// without reaching into the dashboard libs directly.
export type {
  PlaybookStageSummary,
  PlaybookClaimCoverage,
  StageConfidenceRow,
};
