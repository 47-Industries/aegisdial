// Live Shield v4 — shared confidence-bucket vocabulary.
//
// Phase 0 introduced `bucketConfidence` privately in stageClassifier
// to keep metric_counters tag cardinality bounded. Phase 13 added a
// dashboard that reads those tagged emissions back. The two pieces
// were coupled by a comment only — Phase 13's BUCKET_SET hardcoded
// the label strings and trusted a docstring that they matched. That
// trust trap surfaces in the Phase 13 adversarial review (H1+H2):
// a single edit in stageClassifier's private helper silently
// invalidates the dashboard's off-taxonomy logic.
//
// This module is the single source of truth. Any module that needs
// to BUCKET a confidence value, or that needs to read back the SET
// OF KNOWN BUCKET LABELS, imports from here. The b4Orchestrator
// keeps its own bucketB4Confidence (different boundaries, different
// labels — see b4Orchestrator.ts) — it is intentionally NOT this
// vocabulary.

/**
 * Bucket boundaries, in order. A confidence value `c` lands in the
 * first bucket whose upper-bound it falls strictly below; values
 * >= the last boundary land in the final bucket.
 *
 * Exported so dashboards can include this map in their response —
 * lets operators detect when bucket boundaries shifted across deploys
 * (the goalpost-shift defense Phase 12 introduced).
 */
export const CONFIDENCE_BUCKET_BOUNDARIES = {
  lt30: 0.3,
  lt50: 0.5,
  lt70: 0.7,
  lt90: 0.9,
  // gte90 has no upper bound — it's the open-ended top bucket.
} as const;

export const CONFIDENCE_BUCKETS = ['lt30', 'lt50', 'lt70', 'lt90', 'gte90'] as const;
export type ConfidenceBucket = (typeof CONFIDENCE_BUCKETS)[number];
export const CONFIDENCE_BUCKET_SET: ReadonlySet<string> = new Set(CONFIDENCE_BUCKETS);

/**
 * Bucket a confidence value (0..1) to one of CONFIDENCE_BUCKETS.
 * Used by the v4 stage classifier emit site; mirrored by the
 * dashboard's off-taxonomy check.
 */
export function bucketConfidence(c: number): ConfidenceBucket {
  if (c < CONFIDENCE_BUCKET_BOUNDARIES.lt30) return 'lt30';
  if (c < CONFIDENCE_BUCKET_BOUNDARIES.lt50) return 'lt50';
  if (c < CONFIDENCE_BUCKET_BOUNDARIES.lt70) return 'lt70';
  if (c < CONFIDENCE_BUCKET_BOUNDARIES.lt90) return 'lt90';
  return 'gte90';
}
