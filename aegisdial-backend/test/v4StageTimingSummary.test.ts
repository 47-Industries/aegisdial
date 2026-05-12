import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 11 — stage-timing summary aggregator tests.
//
// summarizeStageTimingRows is a pure function: takes raw GROUP BY
// rows from metric_counters and reshapes into the dashboard view.
// Tests pin:
//
//   1. Percentage math + one-decimal precision
//   2. Zero-fill against the full 14×5=70 (playbook, stage) taxonomy
//   3. health verdict thresholds (no_data / drift / healthy)
//   4. Off-taxonomy rows (stale playbook/stage from a rolled-back
//      seed) are silently dropped — invisible-but-correct cleanup
//   5. Off-taxonomy verdict strings ignored

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-stage-timing-summary';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-stage-timing-summary';

const { summarizeStageTimingRows } = await import('../src/services/v4StageTimingSummary.ts');
const { PLAYBOOKS } = await import('../src/data/playbooks.ts');

const TOTAL_PAIRS = PLAYBOOKS.reduce((acc, p) => acc + p.stages.length, 0);

describe('summarizeStageTimingRows — zero-fill against the full taxonomy', () => {
  it('returns a row for every (playbook, stage) pair even when there are zero metric rows', () => {
    const out = summarizeStageTimingRows([], { hours: 24 });
    assert.equal(out.hours, 24);
    assert.equal(out.total_events, 0);
    assert.equal(
      out.rows.length,
      TOTAL_PAIRS,
      `expected ${TOTAL_PAIRS} rows (one per playbook×stage in the taxonomy)`,
    );
    // Every row must be no_data with null pct fields.
    for (const r of out.rows) {
      assert.equal(r.total, 0);
      assert.equal(r.in_range_pct, null);
      assert.equal(r.too_fast_pct, null);
      assert.equal(r.too_slow_pct, null);
      assert.equal(r.health, 'no_data');
    }
  });
});

describe('summarizeStageTimingRows — percentage math + one-decimal precision', () => {
  it('rounds percentages to one decimal', () => {
    // 7 in_range / 2 too_fast / 1 too_slow = 70.0% / 20.0% / 10.0%
    const out = summarizeStageTimingRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'in_range', count: 7 },
        { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'too_fast', count: 2 },
        { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'too_slow', count: 1 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
    assert.equal(row.total, 10);
    assert.equal(row.in_range, 7);
    assert.equal(row.too_fast, 2);
    assert.equal(row.too_slow, 1);
    assert.equal(row.in_range_pct, 70.0);
    assert.equal(row.too_fast_pct, 20.0);
    assert.equal(row.too_slow_pct, 10.0);
  });

  it('handles non-integer percentage division (1/3 → 33.3)', () => {
    const out = summarizeStageTimingRows(
      [
        { playbook_id: 'irs_impersonation', stage: 'ask', verdict: 'in_range', count: 1 },
        { playbook_id: 'irs_impersonation', stage: 'ask', verdict: 'too_fast', count: 1 },
        { playbook_id: 'irs_impersonation', stage: 'ask', verdict: 'too_slow', count: 1 },
      ],
      { hours: 1 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'irs_impersonation' && r.stage === 'ask')!;
    assert.equal(row.total, 3);
    assert.equal(row.in_range_pct, 33.3);
    assert.equal(row.too_fast_pct, 33.3);
    assert.equal(row.too_slow_pct, 33.3);
  });

  it('total_events sums across every populated row', () => {
    const out = summarizeStageTimingRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'in_range', count: 5 },
        { playbook_id: 'irs_impersonation', stage: 'ask', verdict: 'too_fast', count: 3 },
      ],
      { hours: 24 },
    );
    assert.equal(out.total_events, 8);
  });
});

describe('summarizeStageTimingRows — health verdict thresholds', () => {
  it('health=no_data when total is 0', () => {
    const out = summarizeStageTimingRows([], { hours: 24 });
    const row = out.rows[0]!;
    assert.equal(row.health, 'no_data');
  });

  it('health=healthy when in_range_pct >= 70', () => {
    // 7/10 = 70.0% — boundary inclusive.
    const out = summarizeStageTimingRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'rapport', verdict: 'in_range', count: 7 },
        { playbook_id: 'bank_impersonation', stage: 'rapport', verdict: 'too_fast', count: 3 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find(
      (r) => r.playbook_id === 'bank_impersonation' && r.stage === 'rapport',
    )!;
    assert.equal(row.in_range_pct, 70.0);
    assert.equal(row.health, 'healthy', '70% is the inclusive boundary');
  });

  it('health=drift when in_range_pct < 70', () => {
    // 6.9/10 = 69.0% → drift
    const out = summarizeStageTimingRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'rapport', verdict: 'in_range', count: 69 },
        { playbook_id: 'bank_impersonation', stage: 'rapport', verdict: 'too_fast', count: 31 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find(
      (r) => r.playbook_id === 'bank_impersonation' && r.stage === 'rapport',
    )!;
    assert.equal(row.in_range_pct, 69.0);
    assert.equal(row.health, 'drift', '69% falls below the 70% threshold');
  });

  it('health=drift when in_range is 0', () => {
    const out = summarizeStageTimingRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'close', verdict: 'too_fast', count: 5 },
        { playbook_id: 'bank_impersonation', stage: 'close', verdict: 'too_slow', count: 5 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find(
      (r) => r.playbook_id === 'bank_impersonation' && r.stage === 'close',
    )!;
    assert.equal(row.in_range_pct, 0);
    assert.equal(row.health, 'drift');
  });
});

describe('summarizeStageTimingRows — off-taxonomy surfacing (MEDIUM-1 fix)', () => {
  // Phase 11 adversarial review MEDIUM-1: off-taxonomy rows MUST be
  // surfaced, not silently dropped. The dashboard exists to catch
  // upstream miscalibration; silent drops hide exactly the failure
  // mode the operator is checking for (a typo'd stage id, a refactor
  // that didn't seed a new playbook, a rollback that didn't finish).

  it('off-taxonomy playbook ids do NOT inflate canonical rows AND are surfaced in dropped_off_taxonomy', () => {
    const out = summarizeStageTimingRows(
      [
        { playbook_id: 'unknown_xyz', stage: 'fear', verdict: 'in_range', count: 100 },
        { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'in_range', count: 5 },
      ],
      { hours: 24 },
    );
    assert.equal(out.rows.length, TOTAL_PAIRS, 'canonical row count is taxonomy-bounded');
    assert.equal(out.total_events, 5, 'total_events is taxonomy-only');
    assert.equal(out.dropped_off_taxonomy.count, 100, 'off-taxonomy total surfaced');
    assert.equal(out.dropped_off_taxonomy.samples.length, 1);
    assert.equal(out.dropped_off_taxonomy.samples[0]!.playbook_id, 'unknown_xyz');
  });

  it('off-taxonomy stage ids surface in dropped_off_taxonomy (typo defense)', () => {
    const out = summarizeStageTimingRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'frenzy', verdict: 'in_range', count: 100 },
      ],
      { hours: 24 },
    );
    assert.equal(out.total_events, 0);
    assert.equal(out.dropped_off_taxonomy.count, 100);
    assert.equal(out.dropped_off_taxonomy.samples[0]!.stage, 'frenzy');
  });

  it('off-taxonomy verdict strings surface in dropped_off_taxonomy', () => {
    const out = summarizeStageTimingRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'whatever', count: 100 },
        { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'in_range', count: 5 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
    assert.equal(row.total, 5, 'phantom verdict does not contaminate count');
    assert.equal(out.dropped_off_taxonomy.count, 100);
    assert.equal(out.dropped_off_taxonomy.samples[0]!.verdict, 'whatever');
  });

  it('caps samples at 10 to bound response size when something is genuinely broken', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      playbook_id: `unknown_${i}`,
      stage: 'fear',
      verdict: 'in_range',
      count: 1,
    }));
    const out = summarizeStageTimingRows(rows, { hours: 24 });
    assert.equal(out.dropped_off_taxonomy.count, 25);
    assert.equal(out.dropped_off_taxonomy.samples.length, 10, 'sample list is capped');
  });

  it('reports empty dropped_off_taxonomy when input is clean', () => {
    const out = summarizeStageTimingRows(
      [{ playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'in_range', count: 5 }],
      { hours: 24 },
    );
    assert.equal(out.dropped_off_taxonomy.count, 0);
    assert.equal(out.dropped_off_taxonomy.samples.length, 0);
  });
});

describe('summarizeStageTimingRows — HIGH-1 fix (raw fraction, not rounded pct, gates healthy)', () => {
  // Phase 11 adversarial review HIGH-1: the health threshold must
  // compare against the raw fraction, not the one-decimal display
  // value. Otherwise 1399/2000 = 69.95% rounds to 70.0 and earns a
  // false 'healthy' badge — the exact false-positive the dashboard
  // exists to prevent.
  it('1399/2000 = 69.95% true rate is drift, not healthy (boundary regression)', () => {
    const out = summarizeStageTimingRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'in_range', count: 1399 },
        { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'too_fast', count: 601 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
    assert.equal(row.total, 2000);
    // The displayed pct rounds UP to 70.0 (one-decimal half-up).
    assert.equal(row.in_range_pct, 70.0);
    // But the raw fraction 1399/2000 = 0.6995 is BELOW 0.70 — drift.
    assert.equal(row.health, 'drift', 'health must use raw fraction, not rounded display value');
  });

  it('7/10 = 70.0% exactly IS healthy (true-boundary inclusive)', () => {
    const out = summarizeStageTimingRows(
      [
        { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'in_range', count: 7 },
        { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'too_fast', count: 3 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
    assert.equal(row.health, 'healthy', '70% exact is the inclusive threshold');
  });
});

describe('summarizeStageTimingRows — output shape contract', () => {
  it('exposes hours echo and total_events at the top level', () => {
    const out = summarizeStageTimingRows([], { hours: 48 });
    assert.equal(out.hours, 48);
    assert.equal(typeof out.total_events, 'number');
    assert.ok(Array.isArray(out.rows));
  });

  it('every row exposes the full field surface (operator UI contract)', () => {
    const out = summarizeStageTimingRows(
      [{ playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'in_range', count: 1 }],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
    // Pin every key the dashboard depends on.
    assert.equal(typeof row.playbook_id, 'string');
    assert.equal(typeof row.stage, 'string');
    assert.equal(typeof row.total, 'number');
    assert.equal(typeof row.in_range, 'number');
    assert.equal(typeof row.too_fast, 'number');
    assert.equal(typeof row.too_slow, 'number');
    assert.ok(['healthy', 'drift', 'no_data'].includes(row.health));
  });
});
