import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 12 — pure-function tests for the B4 × playbook
// claim-coverage primitives. Pins:
//
//   - isClaimTypeExpected predicate (used at emit site + at reshape)
//   - summarizeClaimCoverageRows reshape:
//     * gap (expected but absent)
//     * surprise (observed but not expected)
//     * surprise dominates gap when both present
//     * aligned baseline
//     * no_data baseline
//     * off-taxonomy surfacing (defense from Phase 11 lesson)

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-claim-coverage';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-claim-coverage';

const cov = await import('../src/lib/playbookClaimCoverage.ts');
const playbooks = await import('../src/data/playbooks.ts');

const TOTAL_PLAYBOOKS = playbooks.PLAYBOOKS.length;

describe('isClaimTypeExpected — predicate contract', () => {
  it('returns true for claim types in PLAYBOOK_CLAIM_EXPECTATIONS', () => {
    // bank_impersonation expects bank_affiliation + case_number + account_tail + employee_identity
    assert.equal(cov.isClaimTypeExpected('bank_impersonation', 'bank_affiliation'), true);
    assert.equal(cov.isClaimTypeExpected('bank_impersonation', 'employee_identity'), true);
  });

  it('returns false for a canonical claim type NOT in this playbook\'s expectation list', () => {
    // bank_impersonation does NOT expect geographic_location
    assert.equal(cov.isClaimTypeExpected('bank_impersonation', 'geographic_location'), false);
  });

  it('returns null for unknown playbook ids (stale data after rollback)', () => {
    assert.equal(cov.isClaimTypeExpected('unknown_xyz', 'bank_affiliation'), null);
  });

  it('returns null for non-canonical claim types', () => {
    assert.equal(cov.isClaimTypeExpected('bank_impersonation', 'whatever'), null);
  });

  it('returns null for null/undefined inputs', () => {
    assert.equal(cov.isClaimTypeExpected(null, 'bank_affiliation'), null);
    assert.equal(cov.isClaimTypeExpected('bank_impersonation', null), null);
    assert.equal(cov.isClaimTypeExpected(undefined, undefined), null);
  });

  it('matches the source-of-truth map exactly', () => {
    // Spot-check completeness: every entry in PLAYBOOK_CLAIM_EXPECTATIONS
    // must return true via the predicate. Defends against drift between
    // the predicate and the data file.
    for (const [pb, expected] of Object.entries(playbooks.PLAYBOOK_CLAIM_EXPECTATIONS)) {
      for (const claim of expected) {
        assert.equal(
          cov.isClaimTypeExpected(pb, claim),
          true,
          `predicate must agree with map for ${pb}.${claim}`,
        );
      }
    }
  });
});

describe('summarizeClaimCoverageRows — zero-fill against full taxonomy', () => {
  it('returns one row per playbook even with empty input', () => {
    const out = cov.summarizeClaimCoverageRows([], { hours: 24 });
    assert.equal(out.hours, 24);
    assert.equal(out.total_events, 0);
    assert.equal(out.rows.length, TOTAL_PLAYBOOKS);
    for (const r of out.rows) {
      assert.equal(r.total, 0);
      assert.equal(r.calibration, 'no_data');
      assert.equal(r.expected_observed.length, 0);
      assert.equal(r.unexpected_observed.length, 0);
      // expected_types is the static seed list — non-empty for every playbook.
      assert.ok(r.expected_types.length > 0, `${r.playbook_id} has no expected types in seed`);
      // expected_missing == expected_types when nothing was observed.
      assert.equal(r.expected_missing.length, r.expected_types.length);
    }
  });
});

describe('summarizeClaimCoverageRows — aligned baseline', () => {
  it('calibration=aligned when every expected type was observed and no surprises', () => {
    // bank_impersonation expects bank_affiliation, case_number, account_tail, employee_identity
    const out = cov.summarizeClaimCoverageRows(
      [
        { playbook_id: 'bank_impersonation', claim_type: 'bank_affiliation', expected: 'true', count: 5 },
        { playbook_id: 'bank_impersonation', claim_type: 'case_number', expected: 'true', count: 3 },
        { playbook_id: 'bank_impersonation', claim_type: 'account_tail', expected: 'true', count: 2 },
        { playbook_id: 'bank_impersonation', claim_type: 'employee_identity', expected: 'true', count: 4 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation')!;
    assert.equal(row.calibration, 'aligned');
    assert.equal(row.expected_missing.length, 0);
    assert.equal(row.unexpected_observed.length, 0);
    assert.equal(row.total, 14);
    assert.equal(row.expected_observed.length, 4);
  });
});

describe('summarizeClaimCoverageRows — gap signal', () => {
  it('calibration=gap when an expected type has zero observations', () => {
    // bank_impersonation expects 4 types; only see 3
    const out = cov.summarizeClaimCoverageRows(
      [
        { playbook_id: 'bank_impersonation', claim_type: 'bank_affiliation', expected: 'true', count: 10 },
        { playbook_id: 'bank_impersonation', claim_type: 'case_number', expected: 'true', count: 5 },
        { playbook_id: 'bank_impersonation', claim_type: 'employee_identity', expected: 'true', count: 7 },
        // account_tail missing → gap
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation')!;
    assert.equal(row.calibration, 'gap');
    assert.deepEqual(row.expected_missing, ['account_tail']);
    assert.equal(row.unexpected_observed.length, 0);
  });
});

describe('summarizeClaimCoverageRows — surprise signal', () => {
  it('calibration=surprise when an unexpected type is observed', () => {
    // tech_support_scam expects ONLY employee_identity
    const out = cov.summarizeClaimCoverageRows(
      [
        { playbook_id: 'tech_support_scam', claim_type: 'employee_identity', expected: 'true', count: 10 },
        // Unexpected: bank_affiliation extracted on a tech_support call
        { playbook_id: 'tech_support_scam', claim_type: 'bank_affiliation', expected: 'false', count: 3 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'tech_support_scam')!;
    assert.equal(row.calibration, 'surprise');
    assert.equal(row.expected_missing.length, 0);
    assert.equal(row.unexpected_observed.length, 1);
    assert.equal(row.unexpected_observed[0]!.claim_type, 'bank_affiliation');
    assert.equal(row.unexpected_observed[0]!.count, 3);
  });

  it('surprise dominates when both gap and surprise are present', () => {
    // bank_impersonation expects 4 types — we only see 2 expected AND see geographic_location
    const out = cov.summarizeClaimCoverageRows(
      [
        { playbook_id: 'bank_impersonation', claim_type: 'bank_affiliation', expected: 'true', count: 5 },
        { playbook_id: 'bank_impersonation', claim_type: 'case_number', expected: 'true', count: 3 },
        // account_tail + employee_identity missing → would be gap on its own
        { playbook_id: 'bank_impersonation', claim_type: 'geographic_location', expected: 'false', count: 2 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation')!;
    assert.equal(row.calibration, 'surprise', 'surprise wins — more actionable signal');
    assert.equal(row.expected_missing.length, 2);
    assert.equal(row.unexpected_observed.length, 1);
  });

  it('orders unexpected_observed by count desc (loudest surprise first)', () => {
    const out = cov.summarizeClaimCoverageRows(
      [
        { playbook_id: 'tech_support_scam', claim_type: 'employee_identity', expected: 'true', count: 1 },
        { playbook_id: 'tech_support_scam', claim_type: 'geographic_location', expected: 'false', count: 2 },
        { playbook_id: 'tech_support_scam', claim_type: 'bank_affiliation', expected: 'false', count: 9 },
        { playbook_id: 'tech_support_scam', claim_type: 'agency_affiliation', expected: 'false', count: 4 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'tech_support_scam')!;
    assert.deepEqual(
      row.unexpected_observed.map((u) => u.claim_type),
      ['bank_affiliation', 'agency_affiliation', 'geographic_location'],
    );
  });

  it('tie-breaks equal counts lexicographically by claim_type (MEDIUM-2 fix)', () => {
    // Adversarial review M-2: SQL GROUP BY has no ordering guarantee,
    // so two equally-loud surprises must be sorted deterministically
    // OR consecutive dashboard hits could swap positions and break
    // diff tooling.
    const out = cov.summarizeClaimCoverageRows(
      [
        { playbook_id: 'tech_support_scam', claim_type: 'geographic_location', expected: 'false', count: 5 },
        { playbook_id: 'tech_support_scam', claim_type: 'bank_affiliation', expected: 'false', count: 5 },
        { playbook_id: 'tech_support_scam', claim_type: 'agency_affiliation', expected: 'false', count: 5 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'tech_support_scam')!;
    assert.deepEqual(
      row.unexpected_observed.map((u) => u.claim_type),
      ['agency_affiliation', 'bank_affiliation', 'geographic_location'],
      'equal counts must sort lexicographically by claim_type',
    );
  });
});

describe('summarizeClaimCoverageRows — expectations_hash version marker (MEDIUM-3 fix)', () => {
  // Adversarial review M-3: the summarizer re-derives expected/unexpected
  // from the live PLAYBOOK_CLAIM_EXPECTATIONS map, so editing the map
  // mid-window re-grades pre-edit data. The expectations_hash lets
  // an operator detect that the goalposts moved between two dashboard
  // views.
  it('exposes expectations_hash at the response root', () => {
    const out = cov.summarizeClaimCoverageRows([], { hours: 24 });
    assert.equal(typeof out.expectations_hash, 'string');
    assert.match(out.expectations_hash, /^[a-f0-9]{12}$/, 'hash is a 12-char hex prefix');
  });

  it('expectations_hash is deterministic across calls (no per-call randomness)', () => {
    const a = cov.summarizeClaimCoverageRows([], { hours: 1 });
    const b = cov.summarizeClaimCoverageRows([], { hours: 168 });
    assert.equal(a.expectations_hash, b.expectations_hash);
  });

  it('getExpectationsHash returns the same value as the field', () => {
    const out = cov.summarizeClaimCoverageRows([], { hours: 24 });
    assert.equal(out.expectations_hash, cov.getExpectationsHash());
  });
});

describe('summarizeClaimCoverageRows — canonical map is source of truth', () => {
  // Adversarial defense: if a raw row's `expected` tag is stale (e.g.
  // PLAYBOOK_CLAIM_EXPECTATIONS was edited mid-window), the canonical
  // map MUST win over the raw tag. Otherwise dashboards would report
  // pre-edit semantics for already-emitted data, masking the very
  // calibration change the edit was making.
  it('ignores stale "expected" tag — derives from canonical map', () => {
    const out = cov.summarizeClaimCoverageRows(
      [
        // Tag says expected=true but per canonical map, bank_impersonation
        // does NOT expect geographic_location → should land in surprise.
        { playbook_id: 'bank_impersonation', claim_type: 'geographic_location', expected: 'true', count: 5 },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation')!;
    assert.equal(row.unexpected_observed.length, 1);
    assert.equal(row.unexpected_observed[0]!.claim_type, 'geographic_location');
    assert.equal(row.unexpected_observed[0]!.count, 5);
  });

  it('honors stale "expected=false" tag — inverse direction (MEDIUM-1 fix)', () => {
    // Adversarial review M-1: prior test only covered the
    // 'true → surprise' direction. Pin the inverse: a row tagged
    // expected=false for a type the CURRENT map says IS expected
    // must land in expected_observed, not unexpected_observed.
    // Otherwise a future refactor that adds `&& r.expected === 'true'`
    // to the routing branch would silently drop these rows.
    const out = cov.summarizeClaimCoverageRows(
      [
        {
          playbook_id: 'bank_impersonation',
          claim_type: 'bank_affiliation',
          expected: 'false',
          count: 7,
        },
      ],
      { hours: 24 },
    );
    const row = out.rows.find((r) => r.playbook_id === 'bank_impersonation')!;
    assert.equal(row.expected_observed.length, 1, 'must land in expected_observed');
    assert.equal(row.expected_observed[0]!.claim_type, 'bank_affiliation');
    assert.equal(row.expected_observed[0]!.count, 7);
    assert.equal(row.unexpected_observed.length, 0);
  });
});

describe('summarizeClaimCoverageRows — off-taxonomy defense', () => {
  it('surfaces off-taxonomy playbook ids (rolled-back seed) in dropped_off_taxonomy', () => {
    const out = cov.summarizeClaimCoverageRows(
      [
        { playbook_id: 'unknown_xyz', claim_type: 'bank_affiliation', expected: 'true', count: 100 },
        { playbook_id: 'bank_impersonation', claim_type: 'bank_affiliation', expected: 'true', count: 5 },
      ],
      { hours: 24 },
    );
    assert.equal(out.total_events, 5, 'total_events is taxonomy-only');
    assert.equal(out.dropped_off_taxonomy.count, 100);
    assert.equal(out.dropped_off_taxonomy.samples.length, 1);
    assert.equal(out.dropped_off_taxonomy.samples[0]!.playbook_id, 'unknown_xyz');
  });

  it('surfaces off-taxonomy claim types in dropped_off_taxonomy', () => {
    const out = cov.summarizeClaimCoverageRows(
      [
        { playbook_id: 'bank_impersonation', claim_type: 'whatever', expected: 'true', count: 7 },
      ],
      { hours: 24 },
    );
    assert.equal(out.total_events, 0);
    assert.equal(out.dropped_off_taxonomy.count, 7);
  });

  it('surfaces malformed `expected` tag in dropped_off_taxonomy', () => {
    const out = cov.summarizeClaimCoverageRows(
      [
        { playbook_id: 'bank_impersonation', claim_type: 'bank_affiliation', expected: 'maybe', count: 3 },
      ],
      { hours: 24 },
    );
    assert.equal(out.total_events, 0);
    assert.equal(out.dropped_off_taxonomy.count, 3);
  });

  it('caps off-taxonomy samples at 10', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      playbook_id: `unknown_${i}`,
      claim_type: 'bank_affiliation',
      expected: 'true' as const,
      count: 1,
    }));
    const out = cov.summarizeClaimCoverageRows(rows, { hours: 24 });
    assert.equal(out.dropped_off_taxonomy.count, 25);
    assert.equal(out.dropped_off_taxonomy.samples.length, 10);
  });
});
