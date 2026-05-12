import { query } from '../lib/db.js';
import {
  PLAYBOOKS,
  type PlaybookId,
  type StageId,
} from '../data/playbooks.js';

// Live Shield v4 — Phase 11 — operator surface that turns Phase 10's
// raw metric_counters rows into an actionable per-playbook×stage view.
//
// Phase 10 emits `v4.stage_timing.evaluated{playbook_id, stage, verdict}`
// on every committed transition. The dashboard needs to answer:
//
//   "For each playbook+stage in the last N hours, what fraction of
//    measurements were in_range vs too_fast vs too_slow?"
//
// That answer is the gate before flipping any v4 feature flag ON in
// prod — a playbook+stage with 30% too_fast or too_slow signals
// miscalibrated typical_duration_seconds bounds in src/data/playbooks.ts
// (or a new scam variant we haven't catalogued yet).
//
// Design choices:
//   - Zero-fill against the full 14×5=70 (playbook, stage) taxonomy.
//     "Never seen" is itself actionable signal — coverage gap maps
//     directly to "this playbook isn't firing where we expected."
//   - One SQL pass with GROUP BY, then pure-function reshape. The
//     pure-function half is unit-testable without a DB.
//   - Bucket aggregation already done by emitMetric upstream — we
//     just SUM(value) across buckets within the time window.

export type StageTimingVerdict = 'in_range' | 'too_fast' | 'too_slow';

const VERDICTS: readonly StageTimingVerdict[] = ['in_range', 'too_fast', 'too_slow'] as const;

/** Raw row shape from the GROUP BY query. */
export interface StageTimingMetricRow {
  playbook_id: string;
  stage: string;
  verdict: string;
  count: number;
}

/** Per-(playbook, stage) summary. Zero-filled for unseen pairs. */
export interface PlaybookStageSummary {
  playbook_id: PlaybookId;
  stage: StageId;
  total: number;
  in_range: number;
  too_fast: number;
  too_slow: number;
  /** 0..100, one-decimal precision. NULL when total === 0 (no coverage). */
  in_range_pct: number | null;
  too_fast_pct: number | null;
  too_slow_pct: number | null;
  /**
   * Operator-facing verdict for the SLO. 'no_data' when total === 0.
   * 'healthy' when in_range >= 70%. 'drift' below that — the seed
   * bounds are likely wrong or a new variant has emerged.
   */
  health: 'healthy' | 'drift' | 'no_data';
}

/**
 * Off-taxonomy drop summary. MEDIUM-1 adversarial fix from Phase 11
 * review: silently dropping rows whose (playbook_id, stage, verdict)
 * doesn't match the canonical taxonomy makes upstream typos invisible
 * to the operator. The dashboard's whole purpose is to catch
 * miscalibration before flag flips — silent drops are the exact
 * failure mode the operator is checking for.
 *
 * Failure modes this catches:
 *   - Classifier emits a stage like 'fear ' (trailing space) — phantom
 *     pair that doesn't render anywhere, looks like "no_data" instead.
 *   - A refactor adds a new stage id without seeding it in playbooks.ts
 *   - A rollback removes a playbook_id but stale metric_counters rows
 *     remain (and the rollback is incomplete somewhere upstream).
 *
 * `samples` is capped — the cardinality is bounded but we don't want
 * an unbounded blob if something is genuinely broken.
 */
export interface OffTaxonomyDropSummary {
  /** Total events dropped (across all off-taxonomy rows). */
  count: number;
  /** Up to 10 sample rows for operator triage. */
  samples: StageTimingMetricRow[];
}

export interface StageTimingSummary {
  hours: number;
  /**
   * Total events across the canonical taxonomy in the window. Excludes
   * off-taxonomy events — see `dropped_off_taxonomy` for those.
   */
  total_events: number;
  /** 70-element array, one per (playbook, stage) pair in the taxonomy. */
  rows: PlaybookStageSummary[];
  /**
   * Events whose tags don't match the canonical taxonomy. Should be
   * zero in steady state; non-zero means an upstream emitter is using
   * an off-taxonomy playbook_id, stage, or verdict — a bug to chase,
   * not silence.
   */
  dropped_off_taxonomy: OffTaxonomyDropSummary;
}

// One-decimal rounding helper. Used for the pct fields. Avoids the
// IEEE-754 noise that pure (x*100/total) would expose to dashboard
// consumers.
function pct1(num: number, denom: number): number | null {
  if (denom <= 0) return null;
  return Math.round((num * 1000) / denom) / 10;
}

/**
 * Pure reshape from the raw metric rows to the dashboard view. Zero-
 * fills against the canonical playbook×stage taxonomy.
 *
 * Off-taxonomy rows (a playbook_id, stage, or verdict no longer in
 * the seed — stale data after a rollback OR an upstream emitter typo)
 * are surfaced in `dropped_off_taxonomy`, NOT silently dropped. See
 * the OffTaxonomyDropSummary docstring for the failure modes this
 * catches.
 */
export function summarizeStageTimingRows(
  rows: readonly StageTimingMetricRow[],
  opts: { hours: number },
): StageTimingSummary {
  // Build canonical (playbook, stage) set for the off-taxonomy check.
  const canonicalPairs = new Set<string>();
  for (const playbook of PLAYBOOKS) {
    for (const stageDef of playbook.stages) {
      canonicalPairs.add(`${playbook.id}|${stageDef.id}`);
    }
  }

  // Index canonical raw rows by (playbook_id, stage, verdict) for O(1)
  // lookup during the zero-fill loop. Non-canonical rows accumulate
  // into the off-taxonomy summary instead of being merged.
  const idx = new Map<string, number>();
  const offTaxonomySamples: StageTimingMetricRow[] = [];
  let offTaxonomyCount = 0;
  const OFF_TAX_SAMPLE_CAP = 10;

  for (const r of rows) {
    const isCanonicalPair = canonicalPairs.has(`${r.playbook_id}|${r.stage}`);
    const isCanonicalVerdict = VERDICTS.includes(r.verdict as StageTimingVerdict);
    if (!isCanonicalPair || !isCanonicalVerdict) {
      offTaxonomyCount += r.count;
      if (offTaxonomySamples.length < OFF_TAX_SAMPLE_CAP) offTaxonomySamples.push(r);
      continue;
    }
    // Additive fold — see Phase 13 review M-3. SQL GROUP BY already
    // produces unique keys per row, so this is a no-op on the happy
    // path; the defensive `(get ?? 0) + count` is here for parity
    // with the other v4 aggregators (claim-coverage, stage-confidence)
    // so all three reshape helpers have identical behavior when fed
    // pre-merged input.
    const key = `${r.playbook_id}|${r.stage}|${r.verdict}`;
    idx.set(key, (idx.get(key) ?? 0) + r.count);
  }

  const out: PlaybookStageSummary[] = [];
  let total_events = 0;

  for (const playbook of PLAYBOOKS) {
    for (const stageDef of playbook.stages) {
      const in_range = idx.get(`${playbook.id}|${stageDef.id}|in_range`) ?? 0;
      const too_fast = idx.get(`${playbook.id}|${stageDef.id}|too_fast`) ?? 0;
      const too_slow = idx.get(`${playbook.id}|${stageDef.id}|too_slow`) ?? 0;
      const total = in_range + too_fast + too_slow;
      total_events += total;

      const in_range_pct = pct1(in_range, total);
      // HIGH-1 adversarial fix: compare against the RAW fraction, not
      // the rounded display value. pct1() rounds half-up to one
      // decimal, so 1399/2000 = 69.95% true rate rounds to 70.0 — and
      // the rounded comparison would mark that 'healthy' when it's
      // actually below the SLO floor. This dashboard exists to gate
      // V4_PLAYBOOK_*_ENABLED flips; a false-healthy at the boundary
      // is exactly the failure mode the operator is checking for.
      let health: PlaybookStageSummary['health'];
      if (total === 0) health = 'no_data';
      else if (in_range / total >= 0.70) health = 'healthy';
      else health = 'drift';

      out.push({
        playbook_id: playbook.id,
        stage: stageDef.id,
        total,
        in_range,
        too_fast,
        too_slow,
        in_range_pct,
        too_fast_pct: pct1(too_fast, total),
        too_slow_pct: pct1(too_slow, total),
        health,
      });
    }
  }

  return {
    hours: opts.hours,
    total_events,
    rows: out,
    dropped_off_taxonomy: { count: offTaxonomyCount, samples: offTaxonomySamples },
  };
}

/**
 * Fetch + summarize. Single SQL pass, then pure reshape. Errors are
 * propagated — the admin route handler will translate to 500.
 */
export async function getStageTimingSummary(
  hours: number,
): Promise<StageTimingSummary> {
  const res = await query<{
    playbook_id: string;
    stage: string;
    verdict: string;
    count: string;
  }>(
    `SELECT
       tags->>'playbook_id' AS playbook_id,
       tags->>'stage'       AS stage,
       tags->>'verdict'     AS verdict,
       SUM(value)::bigint   AS count
     FROM metric_counters
     WHERE name = 'v4.stage_timing.evaluated'
       AND bucket > NOW() - $1::INTERVAL
     GROUP BY 1, 2, 3`,
    [`${hours} hours`],
  );

  const rows: StageTimingMetricRow[] = res.rows.map((r) => ({
    playbook_id: r.playbook_id,
    stage: r.stage,
    verdict: r.verdict,
    // SUM() in pg comes back as a numeric string for bigint safety.
    count: Number(r.count),
  }));

  return summarizeStageTimingRows(rows, { hours });
}
