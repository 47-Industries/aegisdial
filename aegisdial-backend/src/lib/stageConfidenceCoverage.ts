import { config } from '../config.js';
import {
  PLAYBOOKS,
  PLAYBOOKS_BY_ID,
  type PlaybookId,
  type StageId,
} from '../data/playbooks.js';
import {
  CONFIDENCE_BUCKETS,
  CONFIDENCE_BUCKET_BOUNDARIES,
  CONFIDENCE_BUCKET_SET,
  type ConfidenceBucket,
} from './confidenceBuckets.js';

// Live Shield v4 — Phase 13 — stage-confidence calibration view.
//
// `v4.classifier.classified{playbook_id, stage, confidence_bucket}`
// has been emitted since v4 Phase 0. Phase 13 reads it: for each
// (playbook, stage) pair, what fraction of commits land in each
// confidence bucket?
//
// The classifier's commit threshold is V4_PLAYBOOK_MIN_CONFIDENCE
// (default 0.55). Below it the result is dropped without persisting,
// but the metric fires regardless — so this view shows the FULL
// distribution, including sub-threshold returns. A playbook+stage
// that consistently lands in lt30/lt50 is one where the classifier
// is unsure: prompt is weak for it, seed phrases don't fire, OR the
// playbook is genuinely overlapping with another and ought to be
// merged.
//
// Pairs with:
//   - Phase 11 (/admin/v4/stage-timing): did stage transitions hit
//     the expected timing window?
//   - Phase 12 (/admin/v4/claim-coverage): did B4 extract the claim
//     types each playbook expected?
//   - Phase 13 (this one, /admin/v4/stage-confidence): is the
//     classifier actually CONFIDENT for each playbook+stage?
//
// Together these are the calibration triangle the operator checks
// before flipping V4_PLAYBOOK_*_ENABLED flags ON in prod.

// Bucket vocabulary now lives in src/lib/confidenceBuckets.ts — single
// source of truth for the v4 stage classifier emit site AND this
// dashboard. Re-export for backward compatibility with tests/callers.
export { CONFIDENCE_BUCKETS, type ConfidenceBucket } from './confidenceBuckets.js';

export interface StageConfidenceMetricRow {
  playbook_id: string;
  stage: string;
  confidence_bucket: string;
  count: number;
}

export interface StageConfidenceRow {
  playbook_id: PlaybookId;
  stage: StageId;
  total: number;
  /** Per-bucket counts. Always all 5 keys present even when total=0. */
  buckets: Record<ConfidenceBucket, number>;
  /**
   * 0..100, one-decimal precision. Share of returns in the gte90
   * bucket. NULL when total === 0. This is the "very confident" tail.
   */
  high_confidence_pct: number | null;
  /**
   * 0..100, one-decimal precision. Lower bound on the share of
   * returns that committed at or above 0.7 confidence (the
   * lt90 + gte90 buckets — values >= 0.7). Phase 13 adversarial-
   * review H3 fix: this is the operationally-grounded "did the
   * classifier produce a solid commit?" signal, distinct from the
   * "did it commit at all?" signal which would be muddied by the
   * lt70 bucket spanning 0.5..0.7 (both sub-threshold and
   * above-threshold).
   *
   * NULL when total === 0.
   */
  committed_confident_pct: number | null;
  /**
   * Health verdict, grounded in committed_confident_pct (NOT
   * high_confidence_pct — Phase 13 H3 fix):
   *   - 'no_data': total === 0
   *   - 'healthy': committed_confident_pct >= 50% (most returns
   *                are in the 0.7+ band — solidly above the commit
   *                gate of 0.55)
   *   - 'low_confidence': below — classifier is hovering near the
   *                commit gate, prompt may be weak for this pair
   *
   * Comparison uses the RAW fraction, not the rounded display value,
   * to dodge the same false-healthy boundary bug Phase 11 caught.
   */
  health: 'healthy' | 'low_confidence' | 'no_data';
}

export interface StageConfidenceSummary {
  hours: number;
  /**
   * Total classifier returns in the window — counts ALL classify()
   * calls including sub-threshold (dropped) and debounced-out ones.
   * Different semantic from Phase 11's total_events (transitions
   * only). Document this divergence in the operator dashboard.
   */
  total_events: number;
  /**
   * Echo of config.V4_PLAYBOOK_MIN_CONFIDENCE — the value below
   * which the classifier drops a return instead of committing.
   * Surfaced so operators can interpret the bucket distribution
   * relative to the gate, NOT relative to the dashboard's 0.5/0.7/0.9
   * display boundaries (M-1 adversarial fix).
   */
  commit_threshold: number;
  /**
   * Echo of the live bucket boundaries from
   * CONFIDENCE_BUCKET_BOUNDARIES. M-2 adversarial fix (Phase 12's
   * expectations_hash precedent applied here): a future tweak to
   * the bucket edges silently re-bucketed historical data — the
   * operator should be able to detect that across dashboard
   * snapshots.
   */
  bucket_boundaries: typeof CONFIDENCE_BUCKET_BOUNDARIES;
  /** Rows in canonical (playbook, stage) iteration order. */
  rows: StageConfidenceRow[];
  /** Off-taxonomy defense — same shape as Phase 11/12. */
  dropped_off_taxonomy: {
    count: number;
    samples: StageConfidenceMetricRow[];
  };
}

function pct1(num: number, denom: number): number | null {
  if (denom <= 0) return null;
  return Math.round((num * 1000) / denom) / 10;
}

const OFF_TAX_SAMPLE_CAP = 10;
const HEALTHY_THRESHOLD = 0.5;

/**
 * Pure reshape from raw GROUP BY rows to the per-(playbook, stage)
 * confidence-distribution view. Zero-fills against the canonical
 * 14×5=70 taxonomy. Off-taxonomy rows (unknown playbook, stage, or
 * bucket label) surface in dropped_off_taxonomy instead of being
 * silently merged.
 */
export function summarizeStageConfidenceRows(
  rows: readonly StageConfidenceMetricRow[],
  opts: { hours: number },
): StageConfidenceSummary {
  // Build canonical (playbook, stage) set.
  const canonicalPairs = new Set<string>();
  for (const playbook of PLAYBOOKS) {
    for (const stageDef of playbook.stages) {
      canonicalPairs.add(`${playbook.id}|${stageDef.id}`);
    }
  }

  // Index by (playbook, stage, bucket).
  const idx = new Map<string, number>();
  const offTaxonomySamples: StageConfidenceMetricRow[] = [];
  let offTaxonomyCount = 0;

  for (const r of rows) {
    const isPbCanonical = PLAYBOOKS_BY_ID.has(r.playbook_id as PlaybookId);
    const isPairCanonical = canonicalPairs.has(`${r.playbook_id}|${r.stage}`);
    const isBucketCanonical = CONFIDENCE_BUCKET_SET.has(r.confidence_bucket);
    if (!isPbCanonical || !isPairCanonical || !isBucketCanonical) {
      offTaxonomyCount += r.count;
      if (offTaxonomySamples.length < OFF_TAX_SAMPLE_CAP) offTaxonomySamples.push(r);
      continue;
    }
    const key = `${r.playbook_id}|${r.stage}|${r.confidence_bucket}`;
    idx.set(key, (idx.get(key) ?? 0) + r.count);
  }

  const out: StageConfidenceRow[] = [];
  let totalEvents = 0;

  for (const playbook of PLAYBOOKS) {
    for (const stageDef of playbook.stages) {
      const buckets: Record<ConfidenceBucket, number> = {
        lt30: 0,
        lt50: 0,
        lt70: 0,
        lt90: 0,
        gte90: 0,
      };
      let total = 0;
      for (const b of CONFIDENCE_BUCKETS) {
        const c = idx.get(`${playbook.id}|${stageDef.id}|${b}`) ?? 0;
        buckets[b] = c;
        total += c;
      }
      totalEvents += total;

      // committed_confident = lt90 + gte90 — strictly >= 0.7 confidence,
      // unambiguously above the 0.55 commit gate. H3 adversarial fix.
      const committed_confident = buckets.lt90 + buckets.gte90;
      let health: StageConfidenceRow['health'];
      if (total === 0) health = 'no_data';
      else if (committed_confident / total >= HEALTHY_THRESHOLD) health = 'healthy';
      else health = 'low_confidence';

      out.push({
        playbook_id: playbook.id,
        stage: stageDef.id,
        total,
        buckets,
        high_confidence_pct: pct1(buckets.gte90, total),
        committed_confident_pct: pct1(committed_confident, total),
        health,
      });
    }
  }

  return {
    hours: opts.hours,
    total_events: totalEvents,
    commit_threshold: config.V4_PLAYBOOK_MIN_CONFIDENCE,
    bucket_boundaries: CONFIDENCE_BUCKET_BOUNDARIES,
    rows: out,
    dropped_off_taxonomy: { count: offTaxonomyCount, samples: offTaxonomySamples },
  };
}
