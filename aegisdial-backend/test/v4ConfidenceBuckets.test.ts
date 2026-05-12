import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 13 adversarial fix H1+H2 — bucketConfidence
// + CONFIDENCE_BUCKETS lived in two places: a private function in
// stageClassifier and a hardcoded array in the Phase 13 aggregator,
// joined only by a comment. The unification moved both into
// src/lib/confidenceBuckets.ts. This test pins the contract so a
// future edit to the boundaries / labels can't silently desync.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-confidence-buckets';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-confidence-buckets';

const buckets = await import('../src/lib/confidenceBuckets.ts');

describe('confidenceBuckets — bucketConfidence boundary behavior', () => {
  it('values strictly less than each boundary land in the lower bucket', () => {
    assert.equal(buckets.bucketConfidence(0.0), 'lt30');
    assert.equal(buckets.bucketConfidence(0.29), 'lt30');
    assert.equal(buckets.bucketConfidence(0.3), 'lt50', '0.3 is the boundary — strictly less goes to lt30, equal goes to lt50');
    assert.equal(buckets.bucketConfidence(0.49), 'lt50');
    assert.equal(buckets.bucketConfidence(0.5), 'lt70');
    assert.equal(buckets.bucketConfidence(0.69), 'lt70');
    assert.equal(buckets.bucketConfidence(0.7), 'lt90');
    assert.equal(buckets.bucketConfidence(0.89), 'lt90');
    assert.equal(buckets.bucketConfidence(0.9), 'gte90');
    assert.equal(buckets.bucketConfidence(1.0), 'gte90');
  });

  it('every bucketConfidence return is in CONFIDENCE_BUCKET_SET (trust-trap defense)', () => {
    // If anyone adds a new return path in bucketConfidence without
    // also adding the label to CONFIDENCE_BUCKETS, this fails.
    for (const c of [0.05, 0.4, 0.6, 0.8, 0.95]) {
      const b = buckets.bucketConfidence(c);
      assert.ok(
        buckets.CONFIDENCE_BUCKET_SET.has(b),
        `bucketConfidence returned "${b}" for ${c} but it's not in CONFIDENCE_BUCKET_SET`,
      );
    }
  });

  it('CONFIDENCE_BUCKETS is exactly the 5 known labels in order', () => {
    assert.deepEqual(
      [...buckets.CONFIDENCE_BUCKETS],
      ['lt30', 'lt50', 'lt70', 'lt90', 'gte90'],
    );
  });

  it('CONFIDENCE_BUCKET_BOUNDARIES exposes the 4 upper edges', () => {
    assert.deepEqual(buckets.CONFIDENCE_BUCKET_BOUNDARIES, {
      lt30: 0.3,
      lt50: 0.5,
      lt70: 0.7,
      lt90: 0.9,
    });
  });
});
