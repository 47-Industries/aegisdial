import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 3C — Recovery Concierge preload tests.
//
// resolveRecoveryPreload is a pure function over (v4_playbook_id,
// v4_stage). Pins the gate composition:
//   - Flag OFF → null
//   - v4_playbook_id NULL → null
//   - unknown playbook id → null
//   - playbook valid, stage missing → preload returned, ended_at_stage NULL
//   - playbook valid, stage unknown → preload returned, ended_at_stage NULL
//     (defense-in-depth — don't fail the whole preload over a bad stage)
//   - everything valid → full preload object with display_name, blurb,
//     ended_at_stage, recovery_steps_link, counter_scripts

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-recovery-preload';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-recovery-preload-test';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';
process.env.V4_PLAYBOOK_RECOVERY_PRELOAD_ENABLED = 'true';

const preload = await import('../src/services/v4RecoveryPreload.ts');
const playbooks = await import('../src/data/playbooks.ts');
const { config: appConfig } = await import('../src/config.ts');

describe('resolveRecoveryPreload — gate composition', () => {
  it('returns a full preload when playbook + stage are valid', () => {
    const out = preload.resolveRecoveryPreload({
      v4_playbook_id: 'irs_impersonation',
      v4_stage: 'ask',
    });
    assert.ok(out);
    const pb = playbooks.PLAYBOOKS_BY_ID.get('irs_impersonation')!;
    assert.equal(out!.playbook_id, 'irs_impersonation');
    assert.equal(out!.playbook_display_name, pb.display_name);
    assert.equal(out!.blurb, pb.family_alert_blurb);
    assert.equal(out!.ended_at_stage, 'ask');
    assert.equal(out!.recovery_steps_link, pb.recovery_steps_link);
    assert.ok(Array.isArray(out!.counter_scripts));
    assert.ok(out!.counter_scripts.length > 0);
    assert.ok(out!.counter_scripts.length <= 3);
  });

  it('returns null when v4_playbook_id is null (legacy / cold session)', () => {
    const out = preload.resolveRecoveryPreload({
      v4_playbook_id: null,
      v4_stage: 'ask',
    });
    assert.equal(out, null);
  });

  it('returns null when playbook id is unknown (stale data after rollback)', () => {
    const out = preload.resolveRecoveryPreload({
      v4_playbook_id: 'unknown_xyz',
      v4_stage: 'ask',
    });
    assert.equal(out, null);
  });

  it('tolerates missing v4_stage — returns preload with ended_at_stage NULL', () => {
    const out = preload.resolveRecoveryPreload({
      v4_playbook_id: 'bank_impersonation',
      v4_stage: null,
    });
    assert.ok(out, 'playbook context is useful even without stage');
    assert.equal(out!.ended_at_stage, null);
    // Other fields should still be populated.
    assert.equal(out!.playbook_id, 'bank_impersonation');
    assert.ok(out!.counter_scripts.length > 0);
  });

  it('tolerates unknown v4_stage label — drops stage but keeps preload', () => {
    const out = preload.resolveRecoveryPreload({
      v4_playbook_id: 'bank_impersonation',
      v4_stage: 'frenzy',  // not in the canonical taxonomy
    });
    assert.ok(out);
    assert.equal(out!.ended_at_stage, null);
  });
});

describe('resolveRecoveryPreload — flag OFF', () => {
  it('returns null when V4_PLAYBOOK_RECOVERY_PRELOAD_ENABLED is OFF, even with valid inputs', () => {
    const original = appConfig.V4_PLAYBOOK_RECOVERY_PRELOAD_ENABLED;
    try {
      (appConfig as { V4_PLAYBOOK_RECOVERY_PRELOAD_ENABLED: boolean }).V4_PLAYBOOK_RECOVERY_PRELOAD_ENABLED = false;
      const out = preload.resolveRecoveryPreload({
        v4_playbook_id: 'irs_impersonation',
        v4_stage: 'ask',
      });
      assert.equal(out, null, 'flag OFF must short-circuit before playbook lookup');
    } finally {
      (appConfig as { V4_PLAYBOOK_RECOVERY_PRELOAD_ENABLED: boolean }).V4_PLAYBOOK_RECOVERY_PRELOAD_ENABLED = original;
    }
  });
});

describe('resolveRecoveryPreload — every playbook resolves cleanly', () => {
  for (const p of playbooks.PLAYBOOKS) {
    it(`playbook=${p.id} resolves with display_name + blurb + counter_scripts`, () => {
      const out = preload.resolveRecoveryPreload({
        v4_playbook_id: p.id,
        v4_stage: 'close',
      });
      assert.ok(out, `playbook ${p.id} should resolve`);
      assert.equal(out!.playbook_display_name, p.display_name);
      assert.ok(out!.blurb.length > 0);
      assert.ok(out!.counter_scripts.length > 0);
    });
  }
});
