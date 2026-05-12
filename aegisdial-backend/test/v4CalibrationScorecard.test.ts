import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 14 — calibration scorecard composer tests.
//
// composeScorecard is a pure function over three dashboard summaries.
// Tests pin the verdict tree, per-axis flagged-list construction,
// determinism, the insufficient-data precedence rule, and the
// flagged-cap.
//
// The three dashboard inputs are built with hand-rolled fixtures
// rather than running the real aggregators — we're testing the
// composer, not the upstream summaries.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-scorecard';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-scorecard';

const sc = await import('../src/services/v4CalibrationScorecard.ts');
const timingLib = await import('../src/services/v4StageTimingSummary.ts');
const claimLib = await import('../src/lib/playbookClaimCoverage.ts');
const confLib = await import('../src/lib/stageConfidenceCoverage.ts');

const TH = sc.DEFAULT_SCORECARD_THRESHOLDS;

// --- Fixture builders ---

function timingSummary(
  rows: Array<{
    playbook_id: string;
    stage: string;
    health: 'healthy' | 'drift' | 'no_data';
    total: number;
    in_range_pct?: number | null;
  }>,
  off_taxonomy_count = 0,
): ReturnType<typeof timingLib.summarizeStageTimingRows> {
  return {
    hours: 24,
    total_events: rows.reduce((a, r) => a + r.total, 0),
    rows: rows.map((r) => ({
      playbook_id: r.playbook_id as never,
      stage: r.stage as never,
      total: r.total,
      in_range: 0,
      too_fast: 0,
      too_slow: 0,
      in_range_pct: r.in_range_pct ?? null,
      too_fast_pct: null,
      too_slow_pct: null,
      health: r.health,
    })),
    dropped_off_taxonomy: { count: off_taxonomy_count, samples: [] },
  };
}

function claimSummary(rows: Array<{
  playbook_id: string;
  calibration: 'aligned' | 'gap' | 'surprise' | 'no_data';
  total: number;
  expected_missing?: string[];
  unexpected_observed?: Array<{ claim_type: string; count: number }>;
}>): ReturnType<typeof claimLib.summarizeClaimCoverageRows> {
  return {
    hours: 24,
    total_events: rows.reduce((a, r) => a + r.total, 0),
    expectations_hash: 'aaaaaaaaaaaa',
    rows: rows.map((r) => ({
      playbook_id: r.playbook_id as never,
      expected_types: [],
      expected_observed: [],
      expected_missing: (r.expected_missing ?? []) as never,
      unexpected_observed: (r.unexpected_observed ?? []) as never,
      total: r.total,
      calibration: r.calibration,
    })),
    dropped_off_taxonomy: { count: 0, samples: [] },
  };
}

function confSummary(rows: Array<{
  playbook_id: string;
  stage: string;
  health: 'healthy' | 'low_confidence' | 'no_data';
  total: number;
  committed_confident_pct?: number | null;
}>): ReturnType<typeof confLib.summarizeStageConfidenceRows> {
  return {
    hours: 24,
    total_events: rows.reduce((a, r) => a + r.total, 0),
    commit_threshold: 0.55,
    bucket_boundaries: { lt30: 0.3, lt50: 0.5, lt70: 0.7, lt90: 0.9 },
    rows: rows.map((r) => ({
      playbook_id: r.playbook_id as never,
      stage: r.stage as never,
      total: r.total,
      buckets: { lt30: 0, lt50: 0, lt70: 0, lt90: 0, gte90: 0 },
      high_confidence_pct: null,
      committed_confident_pct: r.committed_confident_pct ?? null,
      health: r.health,
    })),
    dropped_off_taxonomy: { count: 0, samples: [] },
  };
}

const composeOpts = { hours: 24, thresholds: TH, v4_aware_enabled: true };

// ---------------------------------------------------------------
// Verdict tree
// ---------------------------------------------------------------

describe('composeScorecard — verdict=insufficient_data takes precedence', () => {
  it('returns insufficient_data when any axis has too few events', () => {
    // Timing has plenty; claim and confidence are empty.
    const out = sc.composeScorecard(
      timingSummary([
        { playbook_id: 'bank_impersonation', stage: 'fear', health: 'healthy', total: 100 },
      ]),
      claimSummary([]),
      confSummary([]),
      composeOpts,
    );
    assert.equal(out.overall.verdict, 'insufficient_data');
    assert.match(out.overall.reason, /claim_coverage|confidence/);
  });

  it('insufficient_data names ALL deficient axes in the reason (mixed case)', () => {
    // Hit the per-axis listing branch by giving timing enough volume
    // but starving claim_coverage + confidence. all_axes_empty is
    // false (timing has events), so we fall through to the
    // per-axis listing.
    const out = sc.composeScorecard(
      timingSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 100 }]),
      claimSummary([]),
      confSummary([]),
      composeOpts,
    );
    assert.equal(out.overall.verdict, 'insufficient_data');
    assert.doesNotMatch(out.overall.reason, /timing/, 'timing met the threshold; not deficient');
    assert.match(out.overall.reason, /claim_coverage/);
    assert.match(out.overall.reason, /confidence/);
  });

  it('insufficient_data overrides needs_calibration even when flags exist', () => {
    // 1 drift pair in timing, but only 5 events — below min_events.
    const out = sc.composeScorecard(
      timingSummary([
        { playbook_id: 'bank_impersonation', stage: 'fear', health: 'drift', total: 5 },
      ]),
      claimSummary([
        { playbook_id: 'bank_impersonation', calibration: 'surprise', total: 100 },
      ]),
      confSummary([
        { playbook_id: 'bank_impersonation', stage: 'fear', health: 'healthy', total: 100 },
      ]),
      composeOpts,
    );
    assert.equal(out.overall.verdict, 'insufficient_data', 'low-volume drift is noise, not signal');
  });
});

describe('composeScorecard — verdict=needs_calibration', () => {
  it('any flagged axis with sufficient volume forces needs_calibration', () => {
    const out = sc.composeScorecard(
      timingSummary([
        { playbook_id: 'bank_impersonation', stage: 'fear', health: 'drift', total: 100, in_range_pct: 45 },
        { playbook_id: 'irs_impersonation', stage: 'ask', health: 'healthy', total: 100 },
      ]),
      claimSummary([
        { playbook_id: 'bank_impersonation', calibration: 'aligned', total: 100 },
      ]),
      confSummary([
        { playbook_id: 'bank_impersonation', stage: 'fear', health: 'healthy', total: 100 },
      ]),
      composeOpts,
    );
    assert.equal(out.overall.verdict, 'needs_calibration');
    assert.match(out.overall.reason, /timing=1/);
  });

  it('reason names every axis with flagged > 0', () => {
    const out = sc.composeScorecard(
      timingSummary([
        { playbook_id: 'a_pb', stage: 'fear', health: 'drift', total: 100 },
      ]),
      claimSummary([
        { playbook_id: 'a_pb', calibration: 'gap', total: 100, expected_missing: ['bank_affiliation'] },
      ]),
      confSummary([
        { playbook_id: 'a_pb', stage: 'fear', health: 'low_confidence', total: 100, committed_confident_pct: 30 },
      ]),
      composeOpts,
    );
    assert.equal(out.overall.verdict, 'needs_calibration');
    assert.match(out.overall.reason, /timing=1/);
    assert.match(out.overall.reason, /claim_coverage=1/);
    assert.match(out.overall.reason, /confidence=1/);
  });
});

describe('composeScorecard — verdict=ship_ready', () => {
  it('returns ship_ready only when every axis has sufficient volume AND zero flagged', () => {
    const out = sc.composeScorecard(
      timingSummary([
        { playbook_id: 'bank_impersonation', stage: 'fear', health: 'healthy', total: 100 },
      ]),
      claimSummary([
        { playbook_id: 'bank_impersonation', calibration: 'aligned', total: 100 },
      ]),
      confSummary([
        { playbook_id: 'bank_impersonation', stage: 'fear', health: 'healthy', total: 100 },
      ]),
      composeOpts,
    );
    assert.equal(out.overall.verdict, 'ship_ready');
    assert.equal(out.timing.flagged.length, 0);
    assert.equal(out.claim_coverage.flagged.length, 0);
    assert.equal(out.confidence.flagged.length, 0);
  });

  it('no_data rows do NOT flag the row but DO require min_events at the axis level', () => {
    // 70 no_data rows, total_events 0 — should be insufficient_data, not ship_ready.
    const out = sc.composeScorecard(
      timingSummary([
        { playbook_id: 'bank_impersonation', stage: 'fear', health: 'no_data', total: 0 },
      ]),
      claimSummary([
        { playbook_id: 'bank_impersonation', calibration: 'no_data', total: 0 },
      ]),
      confSummary([
        { playbook_id: 'bank_impersonation', stage: 'fear', health: 'no_data', total: 0 },
      ]),
      composeOpts,
    );
    assert.equal(out.overall.verdict, 'insufficient_data');
  });
});

// ---------------------------------------------------------------
// Per-axis flagged lists
// ---------------------------------------------------------------

describe('composeScorecard — axis flagged lists', () => {
  it('timing.flagged includes only drift rows (not healthy/no_data)', () => {
    const out = sc.composeScorecard(
      timingSummary([
        { playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 100 },
        { playbook_id: 'b_pb', stage: 'fear', health: 'drift', total: 100, in_range_pct: 45 },
        { playbook_id: 'c_pb', stage: 'fear', health: 'no_data', total: 0 },
      ]),
      claimSummary([{ playbook_id: 'a_pb', calibration: 'aligned', total: 100 }]),
      confSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 100 }]),
      composeOpts,
    );
    assert.equal(out.timing.flagged.length, 1);
    assert.equal(out.timing.flagged[0]!.playbook_id, 'b_pb');
    assert.equal(out.timing.flagged[0]!.stage, 'fear');
    assert.match(out.timing.flagged[0]!.reason, /45/);
  });

  it('claim_coverage.flagged includes gap AND surprise', () => {
    const out = sc.composeScorecard(
      timingSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 100 }]),
      claimSummary([
        { playbook_id: 'a_pb', calibration: 'aligned', total: 100 },
        { playbook_id: 'b_pb', calibration: 'gap', total: 100, expected_missing: ['account_tail'] },
        { playbook_id: 'c_pb', calibration: 'surprise', total: 100, unexpected_observed: [{ claim_type: 'bank_affiliation', count: 7 }] },
      ]),
      confSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 100 }]),
      composeOpts,
    );
    assert.equal(out.claim_coverage.flagged.length, 2);
    const reasons = out.claim_coverage.flagged.map((f) => f.reason);
    assert.ok(reasons.some((r) => /gap.*account_tail/.test(r)));
    assert.ok(reasons.some((r) => /surprise.*bank_affiliation/.test(r)));
  });

  it('confidence.flagged includes only low_confidence (not healthy/no_data)', () => {
    const out = sc.composeScorecard(
      timingSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 100 }]),
      claimSummary([{ playbook_id: 'a_pb', calibration: 'aligned', total: 100 }]),
      confSummary([
        { playbook_id: 'a_pb', stage: 'fear', health: 'low_confidence', total: 100, committed_confident_pct: 30 },
        { playbook_id: 'b_pb', stage: 'ask', health: 'healthy', total: 100 },
      ]),
      composeOpts,
    );
    assert.equal(out.confidence.flagged.length, 1);
    assert.equal(out.confidence.flagged[0]!.playbook_id, 'a_pb');
    assert.match(out.confidence.flagged[0]!.reason, /30/);
  });

  it('caps flagged list at 20 per axis AND surfaces flagged_truncated=true (MEDIUM-3 fix)', () => {
    // Build 25 drift rows; expect only 20 returned + flagged_truncated.
    const driftRows = Array.from({ length: 25 }, (_, i) => ({
      playbook_id: `pb_${i.toString().padStart(2, '0')}`,
      stage: 'fear',
      health: 'drift' as const,
      total: 100,
      in_range_pct: 10,
    }));
    const out = sc.composeScorecard(
      timingSummary(driftRows),
      claimSummary([{ playbook_id: 'pb_00', calibration: 'aligned', total: 100 }]),
      confSummary([{ playbook_id: 'pb_00', stage: 'fear', health: 'healthy', total: 100 }]),
      composeOpts,
    );
    assert.equal(out.timing.flagged.length, 20, 'capped at 20');
    assert.equal(out.timing.by_health.drift, 25);
    assert.equal(out.timing.flagged_truncated, true, 'must surface truncation');
  });

  it('flagged_truncated is false when the cap is not exceeded', () => {
    const out = sc.composeScorecard(
      timingSummary([
        { playbook_id: 'a_pb', stage: 'fear', health: 'drift', total: 100 },
        { playbook_id: 'b_pb', stage: 'fear', health: 'drift', total: 100 },
      ]),
      claimSummary([{ playbook_id: 'a_pb', calibration: 'aligned', total: 100 }]),
      confSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 100 }]),
      composeOpts,
    );
    assert.equal(out.timing.flagged.length, 2);
    assert.equal(out.timing.flagged_truncated, false);
  });
});

describe('composeScorecard — H-1 fix (zero-data + min_events=0 is NOT ship_ready)', () => {
  it('all_axes_empty forces insufficient_data regardless of min_events=0', () => {
    const out = sc.composeScorecard(
      timingSummary([]),
      claimSummary([]),
      confSummary([]),
      { hours: 24, thresholds: { min_events: 0 }, v4_aware_enabled: true },
    );
    assert.equal(
      out.overall.verdict,
      'insufficient_data',
      'min_events=0 must NOT rubber-stamp ship_ready over an empty scorecard',
    );
    assert.equal(out.overall.all_axes_empty, true);
  });

  it('all_axes_empty surface field is set whenever every axis has total_events=0', () => {
    const out = sc.composeScorecard(
      timingSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'no_data', total: 0 }]),
      claimSummary([{ playbook_id: 'a_pb', calibration: 'no_data', total: 0 }]),
      confSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'no_data', total: 0 }]),
      composeOpts,
    );
    assert.equal(out.overall.all_axes_empty, true);
    assert.equal(out.overall.verdict, 'insufficient_data');
  });

  it('all_axes_empty is false when any axis has even one event', () => {
    const out = sc.composeScorecard(
      timingSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 1 }]),
      claimSummary([]),
      confSummary([]),
      composeOpts,
    );
    assert.equal(out.overall.all_axes_empty, false);
  });
});

describe('composeScorecard — M-1 fix (master-flag-aware reason)', () => {
  it('when all axes empty AND master flag off, reason names the master flag', () => {
    const out = sc.composeScorecard(
      timingSummary([]),
      claimSummary([]),
      confSummary([]),
      { hours: 24, thresholds: TH, v4_aware_enabled: false },
    );
    assert.equal(out.overall.verdict, 'insufficient_data');
    assert.match(
      out.overall.reason,
      /V4_PLAYBOOK_AWARE_ENABLED/,
      'master-flag-off case must call out the flag explicitly so operator triage points the right way',
    );
  });

  it('when all axes empty AND master flag on, reason says "telemetry has emitted yet"', () => {
    const out = sc.composeScorecard(
      timingSummary([]),
      claimSummary([]),
      confSummary([]),
      { hours: 24, thresholds: TH, v4_aware_enabled: true },
    );
    assert.equal(out.overall.verdict, 'insufficient_data');
    assert.doesNotMatch(out.overall.reason, /OFF/, 'flag is on, message must not say OFF');
    assert.match(out.overall.reason, /no telemetry has emitted/);
  });
});

describe('composeScorecard — L-5 fix (off_taxonomy_count surfaced per axis)', () => {
  it('per-axis off_taxonomy_count reflects upstream dropped_off_taxonomy', () => {
    const out = sc.composeScorecard(
      timingSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 100 }], 17),
      claimSummary([{ playbook_id: 'a_pb', calibration: 'aligned', total: 100 }]),
      confSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 100 }]),
      composeOpts,
    );
    assert.equal(out.timing.off_taxonomy_count, 17);
    assert.equal(out.claim_coverage.off_taxonomy_count, 0);
    assert.equal(out.confidence.off_taxonomy_count, 0);
  });
});

// ---------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------

describe('composeScorecard — determinism', () => {
  it('timing.flagged is sorted by (playbook_id, stage) for stable diffs', () => {
    const out = sc.composeScorecard(
      timingSummary([
        { playbook_id: 'z_pb', stage: 'rapport', health: 'drift', total: 100 },
        { playbook_id: 'a_pb', stage: 'close', health: 'drift', total: 100 },
        { playbook_id: 'a_pb', stage: 'ask', health: 'drift', total: 100 },
      ]),
      claimSummary([{ playbook_id: 'a_pb', calibration: 'aligned', total: 100 }]),
      confSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 100 }]),
      composeOpts,
    );
    assert.deepEqual(
      out.timing.flagged.map((f) => `${f.playbook_id}.${f.stage}`),
      ['a_pb.ask', 'a_pb.close', 'z_pb.rapport'],
      'sorted by playbook_id then stage',
    );
  });
});

// ---------------------------------------------------------------
// Operator-context fields
// ---------------------------------------------------------------

describe('composeScorecard — operator-context fields', () => {
  it('echoes hours, thresholds, v4_aware_enabled, all_axes_empty', () => {
    const out = sc.composeScorecard(
      timingSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 100 }]),
      claimSummary([{ playbook_id: 'a_pb', calibration: 'aligned', total: 200 }]),
      confSummary([{ playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 300 }]),
      { hours: 6, thresholds: { min_events: 25 }, v4_aware_enabled: false },
    );
    assert.equal(out.hours, 6);
    assert.equal(out.thresholds.min_events, 25);
    assert.equal(out.overall.v4_aware_enabled, false);
    assert.equal(out.overall.all_axes_empty, false, 'three axes with data → not empty');
  });

  it('exposes by_health buckets per axis', () => {
    const out = sc.composeScorecard(
      timingSummary([
        { playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 100 },
        { playbook_id: 'b_pb', stage: 'fear', health: 'drift', total: 100 },
        { playbook_id: 'c_pb', stage: 'fear', health: 'no_data', total: 0 },
      ]),
      claimSummary([
        { playbook_id: 'a_pb', calibration: 'aligned', total: 100 },
        { playbook_id: 'b_pb', calibration: 'gap', total: 100 },
        { playbook_id: 'c_pb', calibration: 'surprise', total: 100 },
        { playbook_id: 'd_pb', calibration: 'no_data', total: 0 },
      ]),
      confSummary([
        { playbook_id: 'a_pb', stage: 'fear', health: 'healthy', total: 100 },
        { playbook_id: 'b_pb', stage: 'fear', health: 'low_confidence', total: 100 },
      ]),
      composeOpts,
    );
    assert.equal(out.timing.by_health.healthy, 1);
    assert.equal(out.timing.by_health.drift, 1);
    assert.equal(out.timing.by_health.no_data, 1);
    assert.equal(out.claim_coverage.by_health.aligned, 1);
    assert.equal(out.claim_coverage.by_health.gap, 1);
    assert.equal(out.claim_coverage.by_health.surprise, 1);
    assert.equal(out.claim_coverage.by_health.no_data, 1);
    assert.equal(out.confidence.by_health.healthy, 1);
    assert.equal(out.confidence.by_health.low_confidence, 1);
  });
});
