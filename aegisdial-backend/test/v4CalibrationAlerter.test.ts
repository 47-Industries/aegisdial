import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 16 — calibration alerter tests.
// Pure-function tests for compareScorecards + buildSnapshot.
// Pins every cell of the regression decision table.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-alerter';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-alerter';

const a = await import('../src/workers/v4CalibrationAlerter.ts');

function snapshot(
  verdict: 'ship_ready' | 'needs_calibration' | 'insufficient_data',
  opts: {
    timing?: string[];
    claim_coverage?: string[];
    confidence?: string[];
    v4_aware_enabled?: boolean;
    all_axes_empty?: boolean;
  } = {},
): import('../src/workers/v4CalibrationAlerter.ts').ScorecardSnapshot {
  return {
    computed_at: '2026-05-11T12:00:00Z',
    verdict,
    flagged_keys: {
      timing: opts.timing ?? [],
      claim_coverage: opts.claim_coverage ?? [],
      confidence: opts.confidence ?? [],
    },
    v4_aware_enabled: opts.v4_aware_enabled ?? true,
    all_axes_empty: opts.all_axes_empty ?? false,
  };
}

describe('compareScorecards — master-flag suppression', () => {
  it('returns severity=none when master flag is off (regardless of verdict change)', () => {
    const r = a.compareScorecards(
      snapshot('ship_ready'),
      snapshot('needs_calibration', { v4_aware_enabled: false, timing: ['bank_impersonation|fear'] }),
    );
    assert.equal(r.severity, 'none');
    assert.match(r.reason, /master flag is off/);
  });
});

describe('compareScorecards — first-run cold start', () => {
  it('returns severity=none on first snapshot (no prior baseline)', () => {
    const r = a.compareScorecards(null, snapshot('needs_calibration', { timing: ['bank_impersonation|fear'] }));
    assert.equal(r.severity, 'none');
    assert.match(r.reason, /first run/);
  });
});

describe('compareScorecards — M-1 fix: master-flag OFF → ON resets baseline', () => {
  it('does NOT fire CRITICAL on insufficient_data (flag off) → needs_calibration (flag on)', () => {
    // Operator flipped master flag OFF for a day, then back ON.
    // Prior snapshot is insufficient_data (suppressed) with
    // v4_aware_enabled=false. Current scorecard is needs_calibration
    // — that's expected first-time-on, not a regression.
    const r = a.compareScorecards(
      snapshot('insufficient_data', { v4_aware_enabled: false, all_axes_empty: true }),
      snapshot('needs_calibration', {
        v4_aware_enabled: true,
        timing: ['bank_impersonation|fear', 'irs_impersonation|ask'],
      }),
    );
    assert.equal(r.severity, 'none', 'flag-flip transition is not a regression');
    assert.match(r.reason, /OFF → ON/);
  });

  it('does NOT fire CRITICAL on ship_ready (flag off impossible — but defensive)', () => {
    // Pathological but defensive: prev says ship_ready while flag
    // was off (shouldn't happen — but the comparator should still
    // resolve to OFF→ON reset rather than alert on the verdict diff).
    const r = a.compareScorecards(
      snapshot('ship_ready', { v4_aware_enabled: false }),
      snapshot('needs_calibration', { v4_aware_enabled: true, timing: ['x|y'] }),
    );
    assert.equal(r.severity, 'none');
    assert.match(r.reason, /OFF → ON/);
  });
});

describe('compareScorecards — critical regressions', () => {
  it('ship_ready → needs_calibration is CRITICAL', () => {
    const r = a.compareScorecards(
      snapshot('ship_ready'),
      snapshot('needs_calibration', { timing: ['bank_impersonation|fear'] }),
    );
    assert.equal(r.severity, 'critical');
    assert.match(r.reason, /ship_ready → needs_calibration/);
    assert.deepEqual(r.newly_flagged.timing, ['bank_impersonation|fear']);
  });

  it('insufficient_data → needs_calibration is CRITICAL', () => {
    const r = a.compareScorecards(
      snapshot('insufficient_data'),
      snapshot('needs_calibration', { confidence: ['irs_impersonation|ask'] }),
    );
    assert.equal(r.severity, 'critical');
    assert.match(r.reason, /insufficient_data → needs_calibration/);
  });

  it('ship_ready → insufficient_data is CRITICAL (lost data)', () => {
    const r = a.compareScorecards(
      snapshot('ship_ready'),
      snapshot('insufficient_data'),
    );
    assert.equal(r.severity, 'critical');
    assert.match(r.reason, /lost data/);
  });
});

describe('compareScorecards — warning regressions', () => {
  it('needs_calibration → needs_calibration with NEW flagged pair is WARNING', () => {
    const r = a.compareScorecards(
      snapshot('needs_calibration', { timing: ['bank_impersonation|fear'] }),
      snapshot('needs_calibration', { timing: ['bank_impersonation|fear', 'irs_impersonation|ask'] }),
    );
    assert.equal(r.severity, 'warning');
    assert.deepEqual(r.newly_flagged.timing, ['irs_impersonation|ask']);
  });

  it('needs_calibration → needs_calibration with SAME flagged pairs is severity=none', () => {
    const r = a.compareScorecards(
      snapshot('needs_calibration', { timing: ['bank_impersonation|fear'] }),
      snapshot('needs_calibration', { timing: ['bank_impersonation|fear'] }),
    );
    assert.equal(r.severity, 'none');
  });

  it('NEW pairs across multiple axes all show up in newly_flagged', () => {
    const r = a.compareScorecards(
      snapshot('needs_calibration', { timing: ['a|fear'] }),
      snapshot('needs_calibration', {
        timing: ['a|fear', 'b|ask'],
        claim_coverage: ['c|'],
        confidence: ['d|close'],
      }),
    );
    assert.equal(r.severity, 'warning');
    assert.deepEqual(r.newly_flagged.timing, ['b|ask']);
    assert.deepEqual(r.newly_flagged.claim_coverage, ['c|']);
    assert.deepEqual(r.newly_flagged.confidence, ['d|close']);
  });
});

describe('compareScorecards — recovery (info)', () => {
  it('needs_calibration → ship_ready is INFO', () => {
    const r = a.compareScorecards(
      snapshot('needs_calibration', { timing: ['x|y'] }),
      snapshot('ship_ready'),
    );
    assert.equal(r.severity, 'info');
    assert.match(r.reason, /recovered/);
  });

  it('insufficient_data → ship_ready is INFO', () => {
    const r = a.compareScorecards(
      snapshot('insufficient_data'),
      snapshot('ship_ready'),
    );
    assert.equal(r.severity, 'info');
  });
});

describe('compareScorecards — no-op cells', () => {
  it('ship_ready → ship_ready is severity=none', () => {
    const r = a.compareScorecards(snapshot('ship_ready'), snapshot('ship_ready'));
    assert.equal(r.severity, 'none');
  });

  it('insufficient_data → insufficient_data is severity=none', () => {
    const r = a.compareScorecards(snapshot('insufficient_data'), snapshot('insufficient_data'));
    assert.equal(r.severity, 'none');
  });

  it('needs_calibration → insufficient_data is severity=none (not a regression — lost data while flagged)', () => {
    // This is a corner case — we already had a problem AND lost data.
    // Today's policy: severity=none (the existing flag has alerted
    // already; data loss while flagged isn't a NEW regression).
    const r = a.compareScorecards(
      snapshot('needs_calibration', { timing: ['x|y'] }),
      snapshot('insufficient_data'),
    );
    assert.equal(r.severity, 'none');
  });
});

describe('buildSnapshot — flagged-key normalization', () => {
  it('joins playbook_id + stage with pipe and sorts', () => {
    const snap = a.buildSnapshot(
      {
        hours: 24,
        thresholds: { min_events: 50 },
        timing: {
          total_events: 100,
          pairs: 70,
          by_health: {},
          flagged: [
            { playbook_id: 'z_pb', stage: 'rapport', reason: 'x' },
            { playbook_id: 'a_pb', stage: 'fear', reason: 'y' },
          ],
          flagged_truncated: false,
          off_taxonomy_count: 0,
        },
        claim_coverage: {
          total_events: 100,
          pairs: 14,
          by_health: {},
          flagged: [{ playbook_id: 'p_pb', reason: 'q' }],
          flagged_truncated: false,
          off_taxonomy_count: 0,
        },
        confidence: {
          total_events: 100,
          pairs: 70,
          by_health: {},
          flagged: [],
          flagged_truncated: false,
          off_taxonomy_count: 0,
        },
        overall: {
          verdict: 'needs_calibration',
          reason: 'x',
          v4_aware_enabled: true,
          all_axes_empty: false,
        },
      },
      new Date('2026-05-11T12:00:00Z'),
    );
    assert.deepEqual(snap.flagged_keys.timing, ['a_pb|fear', 'z_pb|rapport']);
    assert.deepEqual(snap.flagged_keys.claim_coverage, ['p_pb|']);
    assert.equal(snap.computed_at, '2026-05-11T12:00:00.000Z');
    assert.equal(snap.verdict, 'needs_calibration');
  });
});
