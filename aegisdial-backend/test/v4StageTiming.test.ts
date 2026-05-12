import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 10 — stage-timing telemetry tests.
//
// evaluateStageTiming is a pure function over (playbook_id, stage,
// elapsed_seconds). Tests pin:
//
//   1. Verdict thresholds — in_range / too_fast / too_slow boundaries
//      against the playbook seed's typical_duration_seconds
//   2. 'no_data' fallback on null/unknown inputs (stale-data defense)
//   3. Every playbook+stage in the canonical taxonomy returns a
//      verdict (completeness invariant — no silent 'no_data' on valid
//      inputs)

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-stage-timing';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-stage-timing';

const { evaluateStageTiming } = await import('../src/lib/stageTiming.ts');
const playbooks = await import('../src/data/playbooks.ts');

describe('evaluateStageTiming — boundary thresholds', () => {
  // bank_impersonation.fear has typical_duration_seconds [30, 120].
  // Pin the exact min/max boundaries + just-outside cases.
  const PB = 'bank_impersonation';
  const STAGE = 'fear';

  it('returns "too_fast" when elapsed is below min (29 < 30)', () => {
    const out = evaluateStageTiming(PB, STAGE, 29);
    assert.equal(out.verdict, 'too_fast');
    assert.equal(out.expected_min, 30);
    assert.equal(out.expected_max, 120);
  });

  it('returns "in_range" when elapsed equals min (30 == 30 — inclusive)', () => {
    const out = evaluateStageTiming(PB, STAGE, 30);
    assert.equal(out.verdict, 'in_range');
  });

  it('returns "in_range" mid-window (75)', () => {
    const out = evaluateStageTiming(PB, STAGE, 75);
    assert.equal(out.verdict, 'in_range');
  });

  it('returns "in_range" when elapsed equals max (120 == 120 — inclusive)', () => {
    const out = evaluateStageTiming(PB, STAGE, 120);
    assert.equal(out.verdict, 'in_range');
  });

  it('returns "too_slow" when elapsed is above max (121 > 120)', () => {
    const out = evaluateStageTiming(PB, STAGE, 121);
    assert.equal(out.verdict, 'too_slow');
  });

  it('returns the underlying playbook seed values in the result', () => {
    const out = evaluateStageTiming(PB, STAGE, 60);
    assert.equal(out.elapsed_seconds, 60);
    const seed = playbooks.PLAYBOOKS_BY_ID.get(PB)!;
    const stageDef = seed.stages.find((s) => s.id === STAGE)!;
    assert.equal(out.expected_min, stageDef.typical_duration_seconds[0]);
    assert.equal(out.expected_max, stageDef.typical_duration_seconds[1]);
  });
});

describe('evaluateStageTiming — no_data fallback', () => {
  it('returns no_data when playbook_id is null', () => {
    const out = evaluateStageTiming(null, 'fear', 60);
    assert.equal(out.verdict, 'no_data');
    assert.equal(out.expected_min, null);
    assert.equal(out.expected_max, null);
    assert.equal(out.elapsed_seconds, null);
  });

  it('returns no_data when stage is null', () => {
    const out = evaluateStageTiming('bank_impersonation', null, 60);
    assert.equal(out.verdict, 'no_data');
  });

  it('returns no_data when playbook is unknown (stale data after rollback)', () => {
    const out = evaluateStageTiming('unknown_xyz', 'fear', 60);
    assert.equal(out.verdict, 'no_data');
  });

  it('returns no_data when stage is unknown (off-taxonomy label)', () => {
    const out = evaluateStageTiming('bank_impersonation', 'frenzy', 60);
    assert.equal(out.verdict, 'no_data');
  });

  it('returns no_data when elapsed is negative (clock skew)', () => {
    const out = evaluateStageTiming('bank_impersonation', 'fear', -5);
    assert.equal(out.verdict, 'no_data');
  });

  it('returns no_data when elapsed is NaN', () => {
    const out = evaluateStageTiming('bank_impersonation', 'fear', NaN);
    assert.equal(out.verdict, 'no_data');
  });

  it('returns no_data when elapsed is Infinity', () => {
    const out = evaluateStageTiming('bank_impersonation', 'fear', Infinity);
    assert.equal(out.verdict, 'no_data');
  });
});

describe('evaluateStageTiming — completeness over every playbook+stage', () => {
  // Every (playbook, stage) pair in the canonical taxonomy must
  // resolve to a real verdict given a plausible elapsed value. Guards
  // against a future playbook seed entry missing typical_duration_seconds.
  it('every playbook+stage pair has a typical_duration_seconds window', () => {
    for (const playbook of playbooks.PLAYBOOKS) {
      for (const stage of playbook.stages) {
        const [min, max] = stage.typical_duration_seconds;
        assert.ok(
          Number.isFinite(min) && Number.isFinite(max),
          `playbook ${playbook.id} stage ${stage.id} has non-finite duration bounds`,
        );
        assert.ok(min <= max, `playbook ${playbook.id} stage ${stage.id}: min > max`);
        assert.ok(min > 0, `playbook ${playbook.id} stage ${stage.id}: non-positive min`);

        // Evaluate at the midpoint — should be in_range.
        const mid = (min + max) / 2;
        const out = evaluateStageTiming(playbook.id, stage.id, mid);
        assert.equal(
          out.verdict,
          'in_range',
          `mid-window evaluation failed for ${playbook.id}.${stage.id}`,
        );
      }
    }
  });
});
