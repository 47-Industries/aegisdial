import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 13 — pure aggregator tests for stage-
// confidence calibration. Pins:
//   - Zero-fill against the full 14×5 taxonomy
//   - All 5 confidence buckets present per row
//   - high_confidence_pct math + one-decimal precision
//   - health verdict thresholds (raw fraction, not rounded — Phase 11 lesson)
//   - off-taxonomy surfacing for playbook id / stage / bucket label

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-stage-confidence';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-stage-confidence';

const cov = await import('../src/lib/stageConfidenceCoverage.ts');
const playbooks = await import('../src/data/playbooks.ts');

const TOTAL_PAIRS = playbooks.PLAYBOOKS.reduce((acc, p) => acc + p.stages.length, 0);

describe('summarizeStageConfidenceRows — zero-fill against full taxonomy', () => {
  it('returns one row per (playbook, stage) pair even with empty input', () => {
    const out = cov.summarizeStageConfidenceRows([], { hours: 24 });
    assert.equal(out.hours, 24);
    assert.equal(out.total_events, 0);
    assert.equal(out.rows.length, TOTAL_PAIRS);
    for (const r of out.rows) {
      assert.equal(r.total, 0);
      assert.equal(r.health, 'no_data');
      assert.equal(r.high_confidence_pct, null);
      // All 5 bucket keys present with 0 counts.
      assert.equal(r.buckets.lt30, 0);
      assert.equal(r.buckets.lt50, 0);
      assert.equal(r.buckets.lt70, 0);
      assert.equal(r.buckets.lt90, 0);
      assert.equal(r.buckets.gte90, 0);
    }
  });
});

describe('summarizeStageConfidenceRows — bucket math', () => {
  it('sums counts across all buckets into total', () => {
    const out = cov.summarizeStageConfidenceRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'lt30', count: 1 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'lt50', count: 2 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'lt70', count: 3 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'lt90', count: 4 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte90', count: 5 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
    assert.equal(row.total, 15);
    assert.equal(row.buckets.lt30, 1);
    assert.equal(row.buckets.lt50, 2);
    assert.equal(row.buckets.lt70, 3);
    assert.equal(row.buckets.lt90, 4);
    assert.equal(row.buckets.gte90, 5);
  });

  it('folds duplicate (playbook, stage, bucket) rows additively', () => {
    // Two rows with the same key (e.g. from disjoint minute buckets) — must sum.
    const out = cov.summarizeStageConfidenceRows(
      [
        { playbook_id: 'irs_impersonation', stage: 'ask', confidence_bucket: 'gte90', count: 4 },
        { playbook_id: 'irs_impersonation', stage: 'ask', confidence_bucket: 'gte90', count: 6 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'irs_impersonation' && r.stage === 'ask')!;
    assert.equal(row.buckets.gte90, 10);
    assert.equal(row.total, 10);
  });

  it('total_events sums across every populated row', () => {
    const out = cov.summarizeStageConfidenceRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte90', count: 5 },
        { playbook_id: 'irs_impersonation', stage: 'ask', confidence_bucket: 'lt70', count: 3 },
      ],
      { hours: 24 },
    );
    assert.equal(out.total_events, 8);
  });
});

describe('summarizeStageConfidenceRows — health verdict on committed_confident (HIGH-3 fix)', () => {
  // Phase 13 adversarial-review H3: health was originally on
  // gte90/total >= 0.5 — an arbitrary threshold not grounded in the
  // commit gate. New semantic: (lt90 + gte90)/total >= 0.5 — share
  // of returns at or above 0.7 confidence, unambiguously solidly
  // above the V4_PLAYBOOK_MIN_CONFIDENCE=0.55 commit gate.

  it('health=healthy when (lt90 + gte90) / total >= 0.5 exactly', () => {
    // 3 lt90 + 2 gte90 = 5; total = 10; committed_confident_pct = 50.0
    const out = cov.summarizeStageConfidenceRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte90', count: 2 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'lt90', count: 3 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'lt70', count: 5 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
    assert.equal(row.committed_confident_pct, 50.0);
    assert.equal(row.high_confidence_pct, 20.0, 'gte90 is the narrow tail; pct distinct');
    assert.equal(row.health, 'healthy', '50% inclusive');
  });

  it('health=low_confidence when committed_confident_pct < 50', () => {
    const out = cov.summarizeStageConfidenceRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte90', count: 1 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'lt90', count: 3 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'lt70', count: 6 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
    assert.equal(row.committed_confident_pct, 40);
    assert.equal(row.health, 'low_confidence');
  });

  it('health uses RAW committed_confident fraction (false-healthy boundary defense, Phase 11 lesson)', () => {
    // 999 committed_confident / 2000 total = 49.95% → pct1 rounds to
    // 50.0. Must report low_confidence based on raw fraction.
    const out = cov.summarizeStageConfidenceRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte90', count: 499 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'lt90', count: 500 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'lt70', count: 1001 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
    assert.equal(row.committed_confident_pct, 50.0);
    assert.equal(
      row.health,
      'low_confidence',
      'raw 0.4995 < 0.5 → low_confidence even though display rounds to 50.0',
    );
  });

  it('health=no_data when total=0', () => {
    const out = cov.summarizeStageConfidenceRows([], { hours: 24 });
    const row = out.rows[0]!;
    assert.equal(row.health, 'no_data');
    assert.equal(row.high_confidence_pct, null);
    assert.equal(row.committed_confident_pct, null);
  });
});

describe('summarizeStageConfidenceRows — operator-context fields (M-1 + M-2 fixes)', () => {
  it('exposes commit_threshold matching V4_PLAYBOOK_MIN_CONFIDENCE', async () => {
    const { config: appConfig } = await import('../src/config.ts');
    const out = cov.summarizeStageConfidenceRows([], { hours: 24 });
    assert.equal(
      out.commit_threshold,
      appConfig.V4_PLAYBOOK_MIN_CONFIDENCE,
      'commit_threshold must echo the live config value so operators see the dropped/committed boundary',
    );
  });

  it('exposes bucket_boundaries with all four upper edges', () => {
    const out = cov.summarizeStageConfidenceRows([], { hours: 24 });
    assert.equal(out.bucket_boundaries.lt30, 0.3);
    assert.equal(out.bucket_boundaries.lt50, 0.5);
    assert.equal(out.bucket_boundaries.lt70, 0.7);
    assert.equal(out.bucket_boundaries.lt90, 0.9);
  });
});

describe('summarizeStageConfidenceRows — off-taxonomy defense', () => {
  it('surfaces unknown playbook ids in dropped_off_taxonomy (not silent)', () => {
    const out = cov.summarizeStageConfidenceRows(
      [
        { playbook_id: 'unknown_xyz', stage: 'fear', confidence_bucket: 'gte90', count: 100 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte90', count: 5 },
      ],
      { hours: 24 },
    );
    assert.equal(out.total_events, 5);
    assert.equal(out.dropped_off_taxonomy.count, 100);
    assert.equal(out.dropped_off_taxonomy.samples[0]!.playbook_id, 'unknown_xyz');
  });

  it('surfaces unknown stage ids', () => {
    const out = cov.summarizeStageConfidenceRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'frenzy', confidence_bucket: 'gte90', count: 7 },
      ],
      { hours: 24 },
    );
    assert.equal(out.total_events, 0);
    assert.equal(out.dropped_off_taxonomy.count, 7);
  });

  it('surfaces malformed bucket labels (defensive against future schema drift)', () => {
    const out = cov.summarizeStageConfidenceRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte95', count: 9 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte90', count: 4 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
    assert.equal(row.total, 4, 'phantom bucket does not contaminate');
    assert.equal(out.dropped_off_taxonomy.count, 9);
  });

  it('surfaces null/empty/uppercase/whitespace bucket labels (MEDIUM-4 fix)', () => {
    // Defensive: if pg's tags->>'confidence_bucket' returns NULL,
    // or a future emitter writes a non-canonical variant, those
    // rows must surface in dropped_off_taxonomy, not pollute the
    // canonical buckets.
    const out = cov.summarizeStageConfidenceRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: null as unknown as string, count: 1 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: '', count: 2 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'GTE90', count: 4 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: ' gte90 ', count: 8 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte90', count: 16 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
    assert.equal(row.buckets.gte90, 16, 'only the canonical "gte90" lands in the bucket');
    assert.equal(out.dropped_off_taxonomy.count, 1 + 2 + 4 + 8, 'all four variants surface as off-taxonomy');
  });

  it('folds duplicate-key input additively (MEDIUM-3 cross-aggregator consistency)', () => {
    // Phase 13 review M-3: all v4 aggregators should fold additively
    // for identical (playbook, stage, bucket) keys so callers can
    // pass pre-merged input without surprises.
    const out = cov.summarizeStageConfidenceRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte90', count: 3 },
        { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte90', count: 7 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
    assert.equal(row.buckets.gte90, 10, 'duplicate keys must sum');
  });

  it('caps off-taxonomy samples at 10', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      playbook_id: `unknown_${i}`,
      stage: 'fear',
      confidence_bucket: 'gte90',
      count: 1,
    }));
    const out = cov.summarizeStageConfidenceRows(rows, { hours: 24 });
    assert.equal(out.dropped_off_taxonomy.count, 30);
    assert.equal(out.dropped_off_taxonomy.samples.length, 10);
  });
});

describe('summarizeStageConfidenceRows — output shape contract', () => {
  it('every row exposes all 5 bucket keys + total + high_confidence_pct + health', () => {
    const out = cov.summarizeStageConfidenceRows(
      [{ playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte90', count: 1 }],
      { hours: 1 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
    assert.equal(typeof row.playbook_id, 'string');
    assert.equal(typeof row.stage, 'string');
    assert.equal(typeof row.total, 'number');
    for (const b of cov.CONFIDENCE_BUCKETS) {
      assert.equal(typeof row.buckets[b], 'number', `bucket ${b} is a number`);
    }
    assert.ok(['healthy', 'low_confidence', 'no_data'].includes(row.health));
  });
});
