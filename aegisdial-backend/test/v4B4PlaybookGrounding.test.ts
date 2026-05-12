import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 5 — B4 claim grounding by playbook tests.
//
// Pins the contract for buildPlaybookBias (the helper that injects
// the playbook-context bias paragraph into the claim extractor's
// user prompt):
//   - Returns "" when V4_B4_PLAYBOOK_GROUNDING_ENABLED is OFF
//   - Returns "" when playbook_id is null (classifier hasn't locked)
//   - Returns "" when playbook_id is unknown (stale data)
//   - Returns a non-empty paragraph with display_name + expected
//     claim types when all gates pass
//   - Explicit "bias, NOT a gate" instruction in the body — defense
//     against the LLM dropping non-expected claim types
//
// Also pins PLAYBOOK_CLAIM_EXPECTATIONS: every playbook has at
// least one expected claim type (no empty buckets) AND every entry
// is a valid B4ClaimType (no drift between extractor + map).

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-b4-grounding';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-b4-grounding-test';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';
process.env.V4_B4_PLAYBOOK_GROUNDING_ENABLED = 'true';
process.env.V3_B4_ENABLED = 'true';

const extractor = await import('../src/services/claimExtractor.ts');
const playbooks = await import('../src/data/playbooks.ts');
const { config: appConfig } = await import('../src/config.ts');

const VALID_CLAIM_TYPES: ReadonlySet<string> = new Set([
  'bank_affiliation',
  'agency_affiliation',
  'account_tail',
  'case_number',
  'employee_identity',
  'geographic_location',
]);

describe('buildPlaybookBias — gate composition', () => {
  it('returns empty when playbook_id is null', () => {
    const out = extractor.buildPlaybookBias(null);
    assert.equal(out, '');
  });

  it('returns empty when V4_B4_PLAYBOOK_GROUNDING_ENABLED is OFF', () => {
    const original = appConfig.V4_B4_PLAYBOOK_GROUNDING_ENABLED;
    try {
      (appConfig as { V4_B4_PLAYBOOK_GROUNDING_ENABLED: boolean }).V4_B4_PLAYBOOK_GROUNDING_ENABLED = false;
      const out = extractor.buildPlaybookBias('irs_impersonation');
      assert.equal(out, '');
    } finally {
      (appConfig as { V4_B4_PLAYBOOK_GROUNDING_ENABLED: boolean }).V4_B4_PLAYBOOK_GROUNDING_ENABLED = original;
    }
  });

  it('returns empty when playbook_id is unknown (stale data after rollback)', () => {
    // TypeScript would normally reject this — defense-in-depth for
    // a future runtime path where a stale string lands.
    // @ts-expect-error — intentionally invalid playbook id
    const out = extractor.buildPlaybookBias('unknown_xyz');
    assert.equal(out, '');
  });

  it('returns a populated bias paragraph when all gates pass', () => {
    const out = extractor.buildPlaybookBias('irs_impersonation');
    assert.ok(out.length > 0, 'bias paragraph should be non-empty');
    // Should NAME the playbook
    assert.ok(out.includes('IRS impersonation'), 'should include the display name');
    // Should list the expected claim types for IRS
    assert.ok(out.includes('agency_affiliation'));
    assert.ok(out.includes('case_number'));
    assert.ok(out.includes('employee_identity'));
    // Should NOT include claim types this playbook doesn't expect
    assert.ok(!out.includes('bank_affiliation'), 'IRS bias must not list bank_affiliation');
    // CRITICAL: must instruct the model that this is bias, NOT a gate
    assert.ok(out.toLowerCase().includes('not a gate'), 'must explicitly say "not a gate"');
  });

  it('paragraph ends with a blank line so it composes cleanly with the rest of the user prompt', () => {
    const out = extractor.buildPlaybookBias('bank_impersonation');
    // Two newlines at the end so the next section starts after a blank line.
    assert.ok(out.endsWith('\n\n'), 'bias paragraph must end with blank line for prompt composition');
  });
});

describe('buildPlaybookBias — per-playbook content', () => {
  it('lists bank-specific claim types for bank_impersonation', () => {
    const out = extractor.buildPlaybookBias('bank_impersonation');
    assert.ok(out.includes('bank_affiliation'));
    assert.ok(out.includes('case_number'));
    assert.ok(out.includes('account_tail'));
    // Should NOT include agency types — bank scammers don't claim to be IRS
    assert.ok(!out.includes('agency_affiliation'));
  });

  it('lists employee_identity only for tech_support_scam (no bank/agency)', () => {
    const out = extractor.buildPlaybookBias('tech_support_scam');
    assert.ok(out.includes('employee_identity'));
    assert.ok(!out.includes('bank_affiliation'));
    assert.ok(!out.includes('agency_affiliation'));
    assert.ok(!out.includes('case_number'));
  });

  it('includes geographic_location for romance_scam (long-cycle deployed-overseas pattern)', () => {
    const out = extractor.buildPlaybookBias('romance_scam');
    assert.ok(out.includes('geographic_location'));
    assert.ok(out.includes('employee_identity'));
  });
});

describe('PLAYBOOK_CLAIM_EXPECTATIONS — completeness + validity', () => {
  it('every playbook has at least one expected claim type (no empty buckets)', () => {
    for (const p of playbooks.PLAYBOOKS) {
      const expected = playbooks.PLAYBOOK_CLAIM_EXPECTATIONS[p.id];
      assert.ok(expected, `playbook ${p.id} missing from PLAYBOOK_CLAIM_EXPECTATIONS`);
      assert.ok(
        expected.length > 0,
        `playbook ${p.id} has zero expected claims — bias paragraph would be useless`,
      );
    }
  });

  it('every entry is a valid B4ClaimType (no drift between extractor and map)', () => {
    for (const [playbookId, expected] of Object.entries(playbooks.PLAYBOOK_CLAIM_EXPECTATIONS)) {
      for (const claimType of expected) {
        assert.ok(
          VALID_CLAIM_TYPES.has(claimType),
          `playbook ${playbookId} expects unknown claim type "${claimType}" — drift between extractor's 6 types and PLAYBOOK_CLAIM_EXPECTATIONS`,
        );
      }
    }
  });

  it('every PlaybookId in the union has a corresponding map entry', () => {
    // Build the set of map keys, compare to the playbooks array.
    const mapKeys = new Set(Object.keys(playbooks.PLAYBOOK_CLAIM_EXPECTATIONS));
    for (const p of playbooks.PLAYBOOKS) {
      assert.ok(mapKeys.has(p.id), `PLAYBOOK_CLAIM_EXPECTATIONS missing key for ${p.id}`);
    }
  });
});
