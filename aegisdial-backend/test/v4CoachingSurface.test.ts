import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 3A — counter-script coaching surface tests.
//
// resolveCoachingSurface is a pure function over (playbook_id,
// stage_confidence). Tests pin the gate composition:
//   - Flag OFF → null
//   - playbook_id NULL → null
//   - confidence below floor → null
//   - unknown playbook_id → null
//   - all conditions met → { playbook_id, counter_scripts: top-N }
//   - counter_scripts capped at V4_PLAYBOOK_COACHING_MAX_LINES

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-coaching';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-coaching-test';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';
process.env.V4_PLAYBOOK_COACHING_ENABLED = 'true';
process.env.V4_PLAYBOOK_COACHING_MIN_CONFIDENCE = '0.7';
process.env.V4_PLAYBOOK_COACHING_MAX_LINES = '3';

const coaching = await import('../src/services/v4Coaching.ts');
const playbooks = await import('../src/data/playbooks.ts');
const { config: appConfig } = await import('../src/config.ts');

describe('resolveCoachingSurface — gate composition', () => {
  it('returns the playbook id + capped counter_scripts when all gates pass', () => {
    const out = coaching.resolveCoachingSurface({
      v4_playbook_id: 'irs_impersonation',
      v4_stage_confidence: 85,
    });
    assert.ok(out);
    assert.equal(out!.playbook_id, 'irs_impersonation');
    assert.ok(Array.isArray(out!.counter_scripts));
    assert.ok(out!.counter_scripts.length > 0);
    assert.ok(out!.counter_scripts.length <= 3, 'capped at V4_PLAYBOOK_COACHING_MAX_LINES (3)');
    // First counter-script should match the playbook's first entry —
    // pins the strongest-first ordering.
    const pb = playbooks.PLAYBOOKS_BY_ID.get('irs_impersonation')!;
    assert.equal(out!.counter_scripts[0], pb.counter_scripts[0]);
  });

  it('returns null when v4_playbook_id is null', () => {
    const out = coaching.resolveCoachingSurface({
      v4_playbook_id: null,
      v4_stage_confidence: 95,
    });
    assert.equal(out, null);
  });

  it('returns null when v4_stage_confidence is null', () => {
    const out = coaching.resolveCoachingSurface({
      v4_playbook_id: 'irs_impersonation',
      v4_stage_confidence: null,
    });
    assert.equal(out, null);
  });

  it('returns null when confidence is below the floor (69 < 70)', () => {
    const out = coaching.resolveCoachingSurface({
      v4_playbook_id: 'irs_impersonation',
      v4_stage_confidence: 69,
    });
    assert.equal(out, null);
  });

  it('accepts confidence exactly at the floor (70 == 70)', () => {
    const out = coaching.resolveCoachingSurface({
      v4_playbook_id: 'irs_impersonation',
      v4_stage_confidence: 70,
    });
    assert.ok(out, 'inclusive-at-floor: 70 must clear');
  });

  it('returns null when playbook_id is unknown (stale data after rollback)', () => {
    const out = coaching.resolveCoachingSurface({
      v4_playbook_id: 'unknown_xyz',
      v4_stage_confidence: 95,
    });
    assert.equal(out, null);
  });
});

describe('resolveCoachingSurface — flag OFF', () => {
  // Mutate config at runtime to pin the V4_PLAYBOOK_COACHING_ENABLED
  // gate. The flag is read on every call, so toggling at runtime is
  // sufficient. try/finally restores so the rest of the file's tests
  // see the original ON state.
  it('returns null when V4_PLAYBOOK_COACHING_ENABLED is OFF, even with all other gates clear', () => {
    const original = appConfig.V4_PLAYBOOK_COACHING_ENABLED;
    try {
      (appConfig as { V4_PLAYBOOK_COACHING_ENABLED: boolean }).V4_PLAYBOOK_COACHING_ENABLED = false;
      const out = coaching.resolveCoachingSurface({
        v4_playbook_id: 'irs_impersonation',
        v4_stage_confidence: 95,
      });
      assert.equal(out, null, 'flag OFF must short-circuit before playbook lookup');
    } finally {
      (appConfig as { V4_PLAYBOOK_COACHING_ENABLED: boolean }).V4_PLAYBOOK_COACHING_ENABLED = original;
    }
  });
});

describe('resolveCoachingSurface — counter-script ordering + capping', () => {
  it('preserves the strongest-first ordering from the playbook seed', () => {
    const out = coaching.resolveCoachingSurface({
      v4_playbook_id: 'bank_impersonation',
      v4_stage_confidence: 90,
    });
    assert.ok(out);
    const pb = playbooks.PLAYBOOKS_BY_ID.get('bank_impersonation')!;
    // Lines returned should be a prefix of the playbook's array.
    assert.deepEqual(
      out!.counter_scripts,
      pb.counter_scripts.slice(0, out!.counter_scripts.length),
    );
  });

  it('every playbook in PLAYBOOKS has at least one counter-script (no empty surfaces)', () => {
    for (const p of playbooks.PLAYBOOKS) {
      const out = coaching.resolveCoachingSurface({
        v4_playbook_id: p.id,
        v4_stage_confidence: 95,
      });
      assert.ok(out, `playbook ${p.id} should resolve a coaching surface`);
      assert.ok(
        out!.counter_scripts.length > 0,
        `playbook ${p.id} has empty counter_scripts — coaching surface would be useless`,
      );
    }
  });
});
