import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 9 — gate-composition tests for the recovery
// scam_type resolver. Mirrors the gate-composition pattern from
// v4RecoveryPreload.test.ts. MED-2 adversarial fix — without these,
// the gate is only tested at the helper-mapping level, not at the
// composed-gate level.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-recovery-resolver';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-recovery-resolver';
process.env.V4_PLAYBOOK_RECOVERY_SCAM_TYPE_ENABLED = 'true';
process.env.V4_PLAYBOOK_RECOVERY_SCAM_TYPE_MIN_CONFIDENCE = '0.7';

const { resolveEffectiveScamType } = await import('../src/services/v4RecoveryScamType.ts');
const { config: appConfig } = await import('../src/config.ts');

describe('resolveEffectiveScamType — flag-OFF fallthrough', () => {
  it('returns llm_scam_type fallback when V4_PLAYBOOK_RECOVERY_SCAM_TYPE_ENABLED is off', () => {
    const original = appConfig.V4_PLAYBOOK_RECOVERY_SCAM_TYPE_ENABLED;
    try {
      (appConfig as { V4_PLAYBOOK_RECOVERY_SCAM_TYPE_ENABLED: boolean }).V4_PLAYBOOK_RECOVERY_SCAM_TYPE_ENABLED = false;
      const out = resolveEffectiveScamType({
        v4_playbook_id: 'irs_impersonation',
        v4_stage_confidence_pct: 95,
        llm_scam_type: null,
      });
      assert.equal(out.scam_type, 'unknown_triage');
      assert.equal(out.from_playbook, false);
    } finally {
      (appConfig as { V4_PLAYBOOK_RECOVERY_SCAM_TYPE_ENABLED: boolean }).V4_PLAYBOOK_RECOVERY_SCAM_TYPE_ENABLED = original;
    }
  });
});

describe('resolveEffectiveScamType — v4-classification missing', () => {
  it('falls through when v4_playbook_id is null', () => {
    const out = resolveEffectiveScamType({
      v4_playbook_id: null,
      v4_stage_confidence_pct: 95,
      llm_scam_type: 'bank_impersonation',
    });
    assert.equal(out.scam_type, 'bank_impersonation');
    assert.equal(out.from_playbook, false);
  });

  it('falls through when v4_stage_confidence_pct is null', () => {
    const out = resolveEffectiveScamType({
      v4_playbook_id: 'irs_impersonation',
      v4_stage_confidence_pct: null,
      llm_scam_type: null,
    });
    assert.equal(out.scam_type, 'unknown_triage');
    assert.equal(out.from_playbook, false);
  });
});

describe('resolveEffectiveScamType — confidence floor (MED-1: column-scale)', () => {
  it('falls through when confidence is below the floor (69 < 70)', () => {
    const out = resolveEffectiveScamType({
      v4_playbook_id: 'irs_impersonation',
      v4_stage_confidence_pct: 69,
      llm_scam_type: null,
    });
    assert.equal(out.scam_type, 'unknown_triage');
    assert.equal(out.from_playbook, false);
  });

  it('substitutes when confidence is exactly at the floor (70 == 70)', () => {
    const out = resolveEffectiveScamType({
      v4_playbook_id: 'irs_impersonation',
      v4_stage_confidence_pct: 70,
      llm_scam_type: null,
    });
    assert.equal(out.scam_type, 'irs_impersonation');
    assert.equal(out.from_playbook, true);
  });

  it('substitutes well above the floor', () => {
    const out = resolveEffectiveScamType({
      v4_playbook_id: 'bank_impersonation',
      v4_stage_confidence_pct: 92,
      llm_scam_type: null,
    });
    assert.equal(out.scam_type, 'bank_impersonation');
    assert.equal(out.from_playbook, true);
  });
});

describe('resolveEffectiveScamType — LLM-signal precedence (MED-3 fix)', () => {
  // Critical contract: when the LLM has committed to a SPECIFIC
  // scam_type, v4 must NOT override it. v4's 14-bucket taxonomy is
  // coarser than the LLM's 52-bucket taxonomy; the LLM has classes
  // like fema_disaster_relief_fraud and pig_butchering that v4's
  // coarser playbook mapping would silently lose.

  it('does NOT override a specific LLM scam_type (fema_disaster_relief_fraud beats charity_disaster_scam mapping)', () => {
    const out = resolveEffectiveScamType({
      v4_playbook_id: 'charity_disaster_scam',
      v4_stage_confidence_pct: 95,
      llm_scam_type: 'fema_disaster_relief_fraud',
    });
    assert.equal(out.scam_type, 'fema_disaster_relief_fraud', 'specific LLM judgment must win');
    assert.equal(out.from_playbook, false);
  });

  it('does NOT override a specific LLM scam_type (pig_butchering beats crypto_investment_scam mapping)', () => {
    const out = resolveEffectiveScamType({
      v4_playbook_id: 'crypto_investment_scam',
      v4_stage_confidence_pct: 95,
      llm_scam_type: 'pig_butchering',
    });
    assert.equal(out.scam_type, 'pig_butchering');
    assert.equal(out.from_playbook, false);
  });

  it('DOES substitute when LLM is null', () => {
    const out = resolveEffectiveScamType({
      v4_playbook_id: 'irs_impersonation',
      v4_stage_confidence_pct: 90,
      llm_scam_type: null,
    });
    assert.equal(out.scam_type, 'irs_impersonation');
    assert.equal(out.from_playbook, true);
  });

  it('DOES substitute when LLM is "unknown_triage" (LLM had no judgment)', () => {
    const out = resolveEffectiveScamType({
      v4_playbook_id: 'bank_impersonation',
      v4_stage_confidence_pct: 90,
      llm_scam_type: 'unknown_triage',
    });
    assert.equal(out.scam_type, 'bank_impersonation');
    assert.equal(out.from_playbook, true);
  });

  it('DOES substitute when LLM is "generic" (LLM was vague)', () => {
    const out = resolveEffectiveScamType({
      v4_playbook_id: 'tech_support_scam',
      v4_stage_confidence_pct: 90,
      llm_scam_type: 'generic',
    });
    assert.equal(out.scam_type, 'tech_support', 'mapped from tech_support_scam');
    assert.equal(out.from_playbook, true);
  });

  it('DOES substitute when LLM is empty string (defensive against empty-string-vs-null DB shape)', () => {
    const out = resolveEffectiveScamType({
      v4_playbook_id: 'romance_scam',
      v4_stage_confidence_pct: 90,
      llm_scam_type: '',
    });
    assert.equal(out.scam_type, 'romance_scam');
    assert.equal(out.from_playbook, true);
  });
});

describe('resolveEffectiveScamType — unknown playbook id (HIGH-1)', () => {
  it('falls through when v4_playbook_id is not a valid PlaybookId (stale data)', () => {
    const out = resolveEffectiveScamType({
      v4_playbook_id: 'unknown_xyz',
      v4_stage_confidence_pct: 95,
      llm_scam_type: null,
    });
    assert.equal(out.scam_type, 'unknown_triage');
    assert.equal(out.from_playbook, false);
  });
});
