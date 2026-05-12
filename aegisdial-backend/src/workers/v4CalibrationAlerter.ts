import { cacheGet, cacheSet, cacheInvalidate, cacheSetNX } from '../lib/cache.js';
import { captureMessage, emitMetric } from '../lib/observability.js';
import {
  getCalibrationScorecard,
  DEFAULT_SCORECARD_THRESHOLDS,
  type CalibrationScorecard,
  type ScorecardThresholds,
} from '../services/v4CalibrationScorecard.js';

// Live Shield v4 — Phase 16 — calibration alerting worker.
//
// Phases 11/12/13 emit raw telemetry. Phase 14 rolls it up to a
// scorecard verdict. Phase 16 turns those dashboards into PROACTIVE
// signal — runs the scorecard hourly, compares to the previous
// snapshot (stored in Redis), and emits a Sentry message + metric
// when the verdict regresses. On-call notices before an operator
// has to poll the dashboard.
//
// Regression rules (in order of severity — first match wins):
//   1. CRITICAL: ship_ready/insufficient_data → needs_calibration
//      (something broke that wasn't broken before)
//   2. CRITICAL: ship_ready → insufficient_data
//      (we LOST data we previously had — could be metric pipeline
//       broken, or v4 master flag flipped off)
//   3. WARNING: needs_calibration with NEW flagged pairs
//      (was needs_calibration before too, but a new pair joined
//       the flagged set — indicates regression on a specific axis)
//   4. INFO: needs_calibration → ship_ready (recovery)
//
// Storage: snapshot lives in Redis (key v4_scorecard_snapshot:vN)
// with a 25-hour TTL — long enough to survive missed runs, short
// enough that stale data is auto-purged. No new table needed.
//
// Master flag context: when V4_PLAYBOOK_AWARE_ENABLED is OFF,
// scorecard is always insufficient_data (no telemetry emits). We
// suppress the OFF-state alerts because that's intentional, not a
// regression — only signal when the flag is ON.

const SNAPSHOT_KEY = 'v4_scorecard_snapshot:v1';
/**
 * 7 days — auto-purges stale snapshots while tolerating multi-day
 * deploy freezes (L-3 adversarial fix). Below this, a 48-hour
 * cron pause would expire the baseline and the next run would
 * silently miss any regression that occurred during the freeze.
 */
const SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Single-flight lock key + TTL. Prevents duplicate alerts when the
 * scheduler runs on multiple Fly instances (L-2 adversarial fix —
 * pre-emptive defense before auto-scale flips on). 5-minute TTL
 * is conservative: the cron only fires once per hour, so a single
 * 5-minute lock is plenty to cover the run-and-write window.
 */
const RUN_LOCK_KEY = 'v4_calibration_run_lock';
const RUN_LOCK_TTL_SECONDS = 5 * 60;

export interface ScorecardSnapshot {
  /** ISO timestamp of when this snapshot was computed. */
  computed_at: string;
  verdict: CalibrationScorecard['overall']['verdict'];
  /** Per-axis flagged-pair keys, normalized as "playbook_id|stage" so
   *  the comparator can detect a NEW pair joining. */
  flagged_keys: {
    timing: string[];
    claim_coverage: string[];
    confidence: string[];
  };
  /** Echoes for context — surfaced into Sentry alert body so the
   *  on-call doesn't have to cross-reference. */
  v4_aware_enabled: boolean;
  all_axes_empty: boolean;
}

export type RegressionSeverity = 'critical' | 'warning' | 'info' | 'none';

export interface RegressionReport {
  severity: RegressionSeverity;
  reason: string;
  /** Specific flagged keys that are NEW since the prior snapshot. */
  newly_flagged: {
    timing: string[];
    claim_coverage: string[];
    confidence: string[];
  };
}

/**
 * Pure-function comparator. Detects regression between two scorecards
 * given the prior snapshot. Returns 'none' when nothing actionable
 * changed.
 *
 * Exported for tests — the worker function below wraps this with
 * the I/O (read scorecard, read/write Redis, emit metrics).
 */
export function compareScorecards(
  prev: ScorecardSnapshot | null,
  current: ScorecardSnapshot,
): RegressionReport {
  const empty: RegressionReport['newly_flagged'] = {
    timing: [],
    claim_coverage: [],
    confidence: [],
  };

  // Suppress all alerts when master flag is off — the scorecard's
  // "insufficient_data" verdict in that case is intentional, not a
  // regression. The operator already knows v4 is dormant.
  if (!current.v4_aware_enabled) {
    return { severity: 'none', reason: 'v4 master flag is off — alerts suppressed', newly_flagged: empty };
  }

  // First-ever snapshot — nothing to compare against. Don't alert
  // on cold start; the next run will have a baseline.
  if (!prev) {
    return { severity: 'none', reason: 'no prior snapshot — first run', newly_flagged: empty };
  }

  // M-1 adversarial fix: master-flag OFF → ON transition resets
  // the baseline. The prior snapshot was taken while v4 was dormant
  // (all axes empty, suppressed alerts). First post-flip run will
  // almost certainly land needs_calibration or insufficient_data —
  // that's not a REGRESSION, it's the operator seeing the system
  // for the first time. Treat as first-run.
  if (!prev.v4_aware_enabled) {
    return {
      severity: 'none',
      reason: 'master flag transitioned OFF → ON — resetting baseline',
      newly_flagged: empty,
    };
  }

  // CRITICAL: regressed from healthy/unknown into needs_calibration.
  if (
    current.verdict === 'needs_calibration' &&
    (prev.verdict === 'ship_ready' || prev.verdict === 'insufficient_data')
  ) {
    return {
      severity: 'critical',
      reason: `verdict regressed: ${prev.verdict} → needs_calibration`,
      newly_flagged: diffFlagged(prev.flagged_keys, current.flagged_keys),
    };
  }

  // CRITICAL: ship_ready → insufficient_data is a real bad signal —
  // we LOST data we previously had. Possible causes: master flag
  // flipped off post-ship-ready, metric pipeline broken, retention
  // sweep too aggressive.
  if (current.verdict === 'insufficient_data' && prev.verdict === 'ship_ready') {
    return {
      severity: 'critical',
      reason: 'ship_ready → insufficient_data (lost data we previously had)',
      newly_flagged: empty,
    };
  }

  // WARNING: still needs_calibration but a NEW pair joined the
  // flagged set on any axis — surfaces incremental degradation.
  if (current.verdict === 'needs_calibration' && prev.verdict === 'needs_calibration') {
    const newly = diffFlagged(prev.flagged_keys, current.flagged_keys);
    const totalNew =
      newly.timing.length + newly.claim_coverage.length + newly.confidence.length;
    if (totalNew > 0) {
      return {
        severity: 'warning',
        reason: `${totalNew} new flagged pair(s) joined the needs_calibration set`,
        newly_flagged: newly,
      };
    }
    return { severity: 'none', reason: 'still needs_calibration, no new flagged pairs', newly_flagged: empty };
  }

  // INFO: recovery — we got back to ship_ready.
  if (current.verdict === 'ship_ready' && prev.verdict !== 'ship_ready') {
    return {
      severity: 'info',
      reason: `verdict recovered: ${prev.verdict} → ship_ready`,
      newly_flagged: empty,
    };
  }

  return { severity: 'none', reason: 'no verdict change', newly_flagged: empty };
}

/**
 * Set-difference between two arrays of "playbook_id|stage" keys.
 *
 * KEY CONTRACT — DO NOT BREAK (L-4 adversarial-review pin):
 *   `buildSnapshot.flagKeys` joins playbook_id + (stage ?? '') with a
 *   pipe. Stage-less axes (claim_coverage) produce keys like
 *   "playbook_id|" with a trailing pipe. The diff comparator treats
 *   "p_pb" and "p_pb|" as DIFFERENT keys, so a future writer that
 *   strips the trailing pipe for stage-less axes would silently
 *   re-fire every claim_coverage flag forever.
 */
function diffFlagged(
  prev: ScorecardSnapshot['flagged_keys'],
  current: ScorecardSnapshot['flagged_keys'],
): RegressionReport['newly_flagged'] {
  const newSet = (oldArr: string[], newArr: string[]): string[] => {
    const old = new Set(oldArr);
    return newArr.filter((k) => !old.has(k)).sort();
  };
  return {
    timing: newSet(prev.timing, current.timing),
    claim_coverage: newSet(prev.claim_coverage, current.claim_coverage),
    confidence: newSet(prev.confidence, current.confidence),
  };
}

/**
 * Build a snapshot from a scorecard. Pure-ish — uses a current ISO
 * timestamp from Date.now, which the test path overrides via the
 * `now` injection point.
 */
export function buildSnapshot(
  scorecard: CalibrationScorecard,
  now: Date = new Date(),
): ScorecardSnapshot {
  const flagKeys = (
    flagged: Array<{ playbook_id: string; stage?: string }>,
  ): string[] =>
    flagged.map((f) => `${f.playbook_id}|${f.stage ?? ''}`).sort();

  return {
    computed_at: now.toISOString(),
    verdict: scorecard.overall.verdict,
    flagged_keys: {
      timing: flagKeys(scorecard.timing.flagged),
      claim_coverage: flagKeys(scorecard.claim_coverage.flagged),
      confidence: flagKeys(scorecard.confidence.flagged),
    },
    v4_aware_enabled: scorecard.overall.v4_aware_enabled,
    all_axes_empty: scorecard.overall.all_axes_empty,
  };
}

export interface AlerterResult {
  scorecard: CalibrationScorecard;
  snapshot: ScorecardSnapshot;
  regression: RegressionReport;
}

/**
 * Multi-instance-safe wrapper around runCalibrationCheck. Acquires a
 * Redis single-flight lock; if another instance already holds it,
 * skip this run. Used by the hourly cron — see L-2 from the Phase
 * 16 adversarial review. The manual /admin/v4/calibration-check
 * route calls runCalibrationCheck DIRECTLY (no lock) so an operator
 * can always force a check.
 */
export async function runCalibrationCheckSingleFlight(): Promise<
  AlerterResult | { error: string } | { skipped: true; reason: string }
> {
  const acquired = await cacheSetNX(RUN_LOCK_KEY, Date.now(), RUN_LOCK_TTL_SECONDS);
  if (!acquired) {
    emitMetric('v4.scorecard.run_skipped_lock_held', {});
    return { skipped: true, reason: 'another instance holds the run lock' };
  }
  return runCalibrationCheck();
}

/**
 * Run one calibration check: compute current scorecard, compare to
 * the previous Redis snapshot, emit signals on regression, write
 * the new snapshot back. Never throws — failures emit a metric and
 * return a sentinel result so the cron loop keeps going.
 */
export async function runCalibrationCheck(
  hours: number = 24,
  thresholds: ScorecardThresholds = DEFAULT_SCORECARD_THRESHOLDS,
): Promise<AlerterResult | { error: string }> {
  try {
    const scorecard = await getCalibrationScorecard(hours, thresholds);
    const snapshot = buildSnapshot(scorecard);
    const prev = await cacheGet<ScorecardSnapshot>(SNAPSHOT_KEY);
    const regression = compareScorecards(prev, snapshot);

    // Always emit the verdict gauge so dashboards can chart it.
    emitMetric('v4.scorecard.verdict', { verdict: snapshot.verdict });

    if (regression.severity !== 'none') {
      emitMetric('v4.scorecard.regression', {
        severity: regression.severity,
        from: prev?.verdict ?? 'none',
        to: snapshot.verdict,
      });

      // Sentry: critical → 'error', warning → 'warning', info → 'info'.
      const sentryLevel: 'info' | 'warning' | 'error' =
        regression.severity === 'critical'
          ? 'error'
          : regression.severity === 'warning'
            ? 'warning'
            : 'info';
      captureMessage(
        `[v4 calibration] ${regression.severity}: ${regression.reason}`,
        sentryLevel,
      );
    }

    await cacheSet(SNAPSHOT_KEY, snapshot, SNAPSHOT_TTL_SECONDS);

    return { scorecard, snapshot, regression };
  } catch (err) {
    emitMetric('v4.scorecard.check_failed', {});
    // eslint-disable-next-line no-console
    console.error('[v4CalibrationAlerter] check failed', err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Test-only — clear the Redis snapshot key. L-5 fix: use the dedicated
 * cacheInvalidate (DEL) instead of a TTL-1 write of "null", which only
 * worked by accident through JSON.parse('null') semantics.
 */
export async function _clearSnapshotForTests(): Promise<void> {
  await cacheInvalidate(SNAPSHOT_KEY);
}

/** Test-only — expose the snapshot key so a test can read it directly. */
export const _SNAPSHOT_KEY_FOR_TESTS = SNAPSHOT_KEY;
