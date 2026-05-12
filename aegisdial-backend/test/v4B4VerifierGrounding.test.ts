import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 6 — B4 Layer 2 verifier grounding tests.
//
// Pins:
//   - buildVerifierPlaybookBias returns "" when flag is off
//   - Returns "" when playbook_id is null OR unknown
//   - Returns a non-empty block with display_name + the explicit
//     "verdict still requires evidence" reminder
//   - layer2CacheKey is namespaced by playbook WHEN the flag is on
//     AND a playbook is supplied — preserves cross-playbook cache
//     separation without breaking legacy cache shape

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-b4-verifier';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-b4-verifier-test';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';
process.env.V4_B4_VERIFIER_GROUNDING_ENABLED = 'true';
process.env.V3_B4_ENABLED = 'true';
process.env.V3_B4_LAYER2_ENABLED = 'true';
process.env.SERPER_API_KEY = 'fake-serper-key';
process.env.ANTHROPIC_API_KEY = 'fake-anthropic-key';

const layer2 = await import('../src/services/b4Layer2.ts');
const playbooks = await import('../src/data/playbooks.ts');
const { config: appConfig } = await import('../src/config.ts');

describe('buildVerifierPlaybookBias — gate composition', () => {
  it('returns empty when playbook_id is null', () => {
    const out = layer2.buildVerifierPlaybookBias(null);
    assert.equal(out, '');
  });

  it('returns empty when V4_B4_VERIFIER_GROUNDING_ENABLED is OFF', () => {
    const original = appConfig.V4_B4_VERIFIER_GROUNDING_ENABLED;
    try {
      (appConfig as { V4_B4_VERIFIER_GROUNDING_ENABLED: boolean }).V4_B4_VERIFIER_GROUNDING_ENABLED = false;
      const out = layer2.buildVerifierPlaybookBias('irs_impersonation');
      assert.equal(out, '');
    } finally {
      (appConfig as { V4_B4_VERIFIER_GROUNDING_ENABLED: boolean }).V4_B4_VERIFIER_GROUNDING_ENABLED = original;
    }
  });

  it('returns empty when playbook id is unknown (stale data after rollback)', () => {
    // @ts-expect-error — intentionally invalid playbook id
    const out = layer2.buildVerifierPlaybookBias('unknown_xyz');
    assert.equal(out, '');
  });

  it('returns a populated block when all gates pass', () => {
    const out = layer2.buildVerifierPlaybookBias('bank_impersonation');
    assert.ok(out.length > 0);
    // Should NAME the playbook
    const pb = playbooks.PLAYBOOKS_BY_ID.get('bank_impersonation')!;
    assert.ok(out.includes(pb.display_name), 'should include the display name');
  });

  it('block carries the explicit "verdict still requires evidence" reminder', () => {
    // CRITICAL invariant — if a future tuning weakens the reminder,
    // the playbook bias could trick the verifier into returning
    // "contradicted" without search-result evidence. This test pins
    // the reminder language as a barrier.
    const out = layer2.buildVerifierPlaybookBias('irs_impersonation');
    assert.ok(
      out.toLowerCase().includes('still requires evidence'),
      'block must include "still requires evidence" reminder',
    );
    assert.ok(
      out.includes('<search_result>'),
      'block must reference search_result tags so the verifier knows where evidence lives',
    );
  });

  it('block is wrapped in <playbook_context> tags (untrusted-region defense)', () => {
    // Adversarial MEDIUM-2 fix — the block lives inside an XML tag
    // that VERIFY_SYSTEM enumerates as UNTRUSTED INPUT. Pre-emptive
    // hardening for the future where display_name might come from a
    // mutable source (DB / i18n / admin UI).
    const out = layer2.buildVerifierPlaybookBias('bank_impersonation');
    assert.ok(out.includes('<playbook_context>'), 'block must be wrapped in <playbook_context> tag');
    assert.ok(out.includes('</playbook_context>'), 'block must close the <playbook_context> tag');
  });

  it('preserves leading + trailing newlines so the rendered user prompt stays well-formed', () => {
    // Adversarial LOW-2 fix — pins the whitespace contract. A future
    // `.trim()` on the return value would silently destroy the
    // spacing between this block and the claim/results blocks.
    const out = layer2.buildVerifierPlaybookBias('irs_impersonation');
    assert.ok(out.startsWith('\n'), 'block must lead with a newline');
    assert.ok(out.endsWith('\n'), 'block must end with a newline');
  });

  it('returns empty when V4_PLAYBOOK_AWARE_ENABLED is OFF (strict layered gating)', () => {
    // Adversarial LOW-1 fix — both the master flag AND the verifier-
    // grounding flag must be on. Defends against the misconfig where
    // AWARE flips off but VERIFIER_GROUNDING stays on; stale
    // v4_playbook_id rows must NOT leak into the verifier prompt.
    const original = appConfig.V4_PLAYBOOK_AWARE_ENABLED;
    try {
      (appConfig as { V4_PLAYBOOK_AWARE_ENABLED: boolean }).V4_PLAYBOOK_AWARE_ENABLED = false;
      const out = layer2.buildVerifierPlaybookBias('irs_impersonation');
      assert.equal(out, '');
    } finally {
      (appConfig as { V4_PLAYBOOK_AWARE_ENABLED: boolean }).V4_PLAYBOOK_AWARE_ENABLED = original;
    }
  });
});

describe('layer2CacheKey — playbook namespacing', () => {
  // Use the bank claim as a canonical example. Cache key is hashed, so
  // we compare by EQUALITY, not by inspecting the bytes.
  const claim = {
    type: 'bank_affiliation' as const,
    bank_name: 'Wells Fargo',
    raw_quote: 'this is wells fargo',
  };

  it('namespaces the cache key by playbook when flag is on AND playbook is supplied', () => {
    const noPlaybook = layer2._internals.layer2CacheKey(claim);
    const withIRS = layer2._internals.layer2CacheKey(claim, 'irs_impersonation');
    const withBank = layer2._internals.layer2CacheKey(claim, 'bank_impersonation');
    // Three distinct keys — same claim under different playbook
    // contexts must not collide.
    assert.notEqual(noPlaybook, withIRS);
    assert.notEqual(noPlaybook, withBank);
    assert.notEqual(withIRS, withBank);
  });

  it('keeps legacy cache shape when flag is off (no key collision risk)', () => {
    const original = appConfig.V4_B4_VERIFIER_GROUNDING_ENABLED;
    try {
      (appConfig as { V4_B4_VERIFIER_GROUNDING_ENABLED: boolean }).V4_B4_VERIFIER_GROUNDING_ENABLED = false;
      // Both calls must return the same key — playbook is ignored when
      // flag is off. Preserves backward-compat with existing cache
      // entries written before Phase 6.
      const a = layer2._internals.layer2CacheKey(claim);
      const b = layer2._internals.layer2CacheKey(claim, 'irs_impersonation');
      assert.equal(a, b, 'flag OFF must produce legacy cache key shape regardless of playbook arg');
    } finally {
      (appConfig as { V4_B4_VERIFIER_GROUNDING_ENABLED: boolean }).V4_B4_VERIFIER_GROUNDING_ENABLED = original;
    }
  });
});
