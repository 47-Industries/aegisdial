import { PLAYBOOKS_BY_ID, type PlaybookId, type StageId } from '../data/playbooks.js';

// Live Shield v4 — Phase 10 — stage-timing telemetry helper.
//
// Every playbook seed carries `typical_duration_seconds: [min, max]`
// for each stage (e.g. bank_impersonation.fear is [30, 120] — fear
// stage typically runs 30-120 seconds before the scammer pivots to
// the ask). Phase 10 captures the ACTUAL elapsed time the call spent
// in each stage and emits a metric tagged by playbook+stage+verdict
// (in_range / too_fast / too_slow). No behavior change — pure
// observability work that feeds calibration dashboards.
//
// Why this matters: every v4 feature flag is currently OFF in prod.
// Before flipping any of them, the team needs to know how often the
// classifier's stage transitions actually match the seed's expected
// timing. A playbook where the v4 lock is "right" but the transition
// timing is consistently off-by-10x signals miscalibrated seeds or a
// new scam variant we haven't catalogued yet.

export type StageTimingVerdict = 'in_range' | 'too_fast' | 'too_slow' | 'no_data';

export interface StageTimingResult {
  verdict: StageTimingVerdict;
  /** Expected min in seconds (null when verdict='no_data'). */
  expected_min: number | null;
  /** Expected max in seconds (null when verdict='no_data'). */
  expected_max: number | null;
  /** The actual elapsed time we evaluated against (null when verdict='no_data'). */
  elapsed_seconds: number | null;
}

/**
 * Evaluate how long a session spent in a given (playbook, stage)
 * against the playbook seed's typical_duration_seconds. Pure function:
 * no DB, no metrics — caller is responsible for emitting.
 *
 * Returns 'no_data' when the playbook or stage doesn't resolve (stale
 * data, rollback, off-taxonomy values). The caller should treat
 * 'no_data' as "don't emit a verdict metric for this transition."
 *
 * Verdict thresholds:
 *   - in_range: min <= elapsed <= max
 *   - too_fast: elapsed < min
 *   - too_slow: elapsed > max
 *
 * Negative elapsed (clock skew, test fixtures with future timestamps)
 * is treated as 'no_data' — defensive, since neither too_fast nor
 * too_slow is a sensible label for a backwards-in-time transition.
 */
export function evaluateStageTiming(
  playbook_id: string | null | undefined,
  stage: string | null | undefined,
  elapsed_seconds: number,
): StageTimingResult {
  if (!playbook_id || !stage) {
    return { verdict: 'no_data', expected_min: null, expected_max: null, elapsed_seconds: null };
  }
  if (!Number.isFinite(elapsed_seconds) || elapsed_seconds < 0) {
    return { verdict: 'no_data', expected_min: null, expected_max: null, elapsed_seconds: null };
  }
  const playbook = PLAYBOOKS_BY_ID.get(playbook_id as PlaybookId);
  if (!playbook) {
    return { verdict: 'no_data', expected_min: null, expected_max: null, elapsed_seconds: null };
  }
  const stageDef = playbook.stages.find((s) => s.id === (stage as StageId));
  if (!stageDef) {
    return { verdict: 'no_data', expected_min: null, expected_max: null, elapsed_seconds: null };
  }
  const [min, max] = stageDef.typical_duration_seconds;
  let verdict: StageTimingVerdict;
  if (elapsed_seconds < min) verdict = 'too_fast';
  else if (elapsed_seconds > max) verdict = 'too_slow';
  else verdict = 'in_range';
  return {
    verdict,
    expected_min: min,
    expected_max: max,
    elapsed_seconds,
  };
}
