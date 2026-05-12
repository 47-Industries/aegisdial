import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 8 — sentinel-gate playbook bypass tests.
//
// Pins the contract of isSentinelGateBypassed:
//   - Returns false when playbook_id is null (no v4 lock)
//   - Returns false when pattern not in the bypass map
//   - Returns false when playbook isn't listed for this pattern
//   - Returns true when playbook IS listed for the pattern
//
// Plus content invariants on the SENTINEL_PLAYBOOK_BYPASS map:
//   - Every entry's playbook_ids are valid PlaybookId values (no drift
//     between the map and the canonical playbook taxonomy)
//   - Bypass map keys correspond to seeded pattern names (calibration
//     check — we don't want bypass entries for patterns that don't
//     exist in production, OR for patterns that never had a context
//     gate in the first place)

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-sentinel-bypass';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-sentinel-bypass-test';

const bypassMod = await import('../src/data/sentinelPlaybookBypass.ts');
const playbooks = await import('../src/data/playbooks.ts');

describe('isSentinelGateBypassed — gate composition', () => {
  it('returns false when playbook_id is null (no v4 lock yet)', () => {
    assert.equal(bypassMod.isSentinelGateBypassed('ssn_spoken_aloud', null), false);
  });

  it('returns false for an unknown pattern_name', () => {
    assert.equal(
      bypassMod.isSentinelGateBypassed('unknown_pattern_xyz', 'irs_impersonation'),
      false,
    );
  });

  it('returns false when playbook is not listed for the pattern', () => {
    // ssn_spoken_aloud bypasses irs/ssa/medicare/police_warrant.
    // tech_support_scam should NOT bypass — tech-support scammers
    // rarely have SSN-disclosure context.
    assert.equal(
      bypassMod.isSentinelGateBypassed('ssn_spoken_aloud', 'tech_support_scam'),
      false,
    );
  });

  it('returns true for an SSN sentinel under an SSN-pattern playbook', () => {
    assert.equal(bypassMod.isSentinelGateBypassed('ssn_spoken_aloud', 'irs_impersonation'), true);
    assert.equal(bypassMod.isSentinelGateBypassed('ssn_spoken_aloud', 'ssa_impersonation'), true);
    assert.equal(
      bypassMod.isSentinelGateBypassed('ssn_spoken_aloud', 'medicare_impersonation'),
      true,
    );
  });

  it('returns true for card disclosure under bank impersonation', () => {
    assert.equal(
      bypassMod.isSentinelGateBypassed('card_number_spoken_aloud', 'bank_impersonation'),
      true,
    );
  });

  it('MFA bypass is TIGHT — only bank_impersonation (defense against 6-digit-ambiguity)', () => {
    assert.equal(
      bypassMod.isSentinelGateBypassed('mfa_code_spoken_aloud', 'bank_impersonation'),
      true,
    );
    // Tech-support scammers ask for MFA codes too, but the bypass
    // is calibrated tight here per the comment in the map — needs
    // the existing in-window context gate for 6-digit disambiguation.
    assert.equal(
      bypassMod.isSentinelGateBypassed('mfa_code_spoken_aloud', 'tech_support_scam'),
      false,
    );
  });
});

describe('SENTINEL_PLAYBOOK_BYPASS — content invariants', () => {
  it('every entry only lists valid PlaybookId values', () => {
    const validIds = new Set<string>();
    for (const p of playbooks.PLAYBOOKS) validIds.add(p.id);
    for (const [pattern, allowed] of Object.entries(bypassMod.SENTINEL_PLAYBOOK_BYPASS)) {
      for (const id of allowed) {
        assert.ok(
          validIds.has(id),
          `pattern ${pattern} references unknown playbook ${id} — drift between bypass map and playbook taxonomy`,
        );
      }
    }
  });

  it('every entry has at least one playbook (no empty bypass arrays)', () => {
    for (const [pattern, allowed] of Object.entries(bypassMod.SENTINEL_PLAYBOOK_BYPASS)) {
      assert.ok(
        allowed.length > 0,
        `pattern ${pattern} has empty bypass array — entry is useless and should be removed`,
      );
    }
  });

  it('does NOT bypass voluntary-only patterns (those have no context gate to bypass)', () => {
    // voluntary_card_phrase, voluntary_password_phrase, voluntary_routing_account
    // already fire WITHOUT a scammer-context gate (no required_scammer_context_regex
    // in the seed). Listing them in the bypass map would be a no-op
    // calibration mistake — pin against it.
    const map = bypassMod.SENTINEL_PLAYBOOK_BYPASS;
    assert.equal(map.voluntary_card_phrase, undefined);
    assert.equal(map.voluntary_password_phrase, undefined);
    assert.equal(map.voluntary_routing_account, undefined);
  });
});
