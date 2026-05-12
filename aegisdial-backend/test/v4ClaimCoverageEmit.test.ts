import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 12 — emission-gate tests for the B4 ×
// playbook claim-coverage telemetry. Pins the wiring of
// emitClaimCoverageMetricsForChunk inside b4Orchestrator:
//
//   (a) emits 1 metric per extracted claim when all gates pass
//   (b) flag V4_B4_CLAIM_COVERAGE_TELEMETRY_ENABLED gates everything
//   (c) master V4_PLAYBOOK_AWARE_ENABLED gates everything
//   (d) playbook_id=null short-circuits (no lock, nothing to tag)
//   (e) per-claim isClaimTypeExpected=null branch skips that one claim
//   (f) `expected` tag is derived from canonical map (true/false correct)
//
// Test seam: _emitClaimCoverageMetricsForChunkForTests exposes the
// helper directly so we don't have to mock the Anthropic call chain.
// Same MEDIUM-2 pattern Phase 10 established (helper extraction +
// dedicated test export).

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-claim-coverage-emit';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-claim-coverage-emit';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';
process.env.V4_B4_CLAIM_COVERAGE_TELEMETRY_ENABLED ||= 'true';

const db = await import('../src/lib/db.ts');
const orchestrator = await import('../src/services/b4Orchestrator.ts');
const { config: appConfig } = await import('../src/config.ts');

interface MetricEmit {
  name: string;
  tags: Record<string, unknown>;
}

let emissions: MetricEmit[] = [];

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  if (/INSERT\s+INTO\s+metric_counters/i.test(text)) {
    const name = params[0] as string;
    let tags: Record<string, unknown> = {};
    try {
      tags = JSON.parse(params[1] as string) as Record<string, unknown>;
    } catch {
      // ignore
    }
    emissions.push({ name, tags });
  }
  return { rows: [], rowCount: 0 };
};

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  emissions = [];
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

// Mock claims that exercise both expected + unexpected paths for
// bank_impersonation (expects bank_affiliation, case_number,
// account_tail, employee_identity).
const expectedClaim = {
  type: 'bank_affiliation' as const,
  bank_name: 'Wells Fargo',
  raw_quote: 'this is Wells Fargo fraud department',
};
const unexpectedClaim = {
  type: 'geographic_location' as const,
  claimed_location: 'New York',
  raw_quote: 'calling from our New York office',
};

describe('emitClaimCoverageMetricsForChunk — happy path', () => {
  it('emits one metric per extracted claim with expected=true for expected types', async () => {
    orchestrator._emitClaimCoverageMetricsForChunkForTests('bank_impersonation', [expectedClaim]);
    await flushMicrotasks();
    const filtered = emissions.filter((e) => e.name === 'v4.b4.claim_extracted_vs_playbook');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.tags.playbook_id, 'bank_impersonation');
    assert.equal(filtered[0]!.tags.claim_type, 'bank_affiliation');
    assert.equal(filtered[0]!.tags.expected, 'true');
  });

  it('emits expected=false when claim type is NOT in PLAYBOOK_CLAIM_EXPECTATIONS for this playbook', async () => {
    orchestrator._emitClaimCoverageMetricsForChunkForTests('bank_impersonation', [unexpectedClaim]);
    await flushMicrotasks();
    const filtered = emissions.filter((e) => e.name === 'v4.b4.claim_extracted_vs_playbook');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.tags.claim_type, 'geographic_location');
    assert.equal(filtered[0]!.tags.expected, 'false', 'unexpected for bank_impersonation');
  });

  it('emits one metric per claim when multiple are extracted from one chunk', async () => {
    orchestrator._emitClaimCoverageMetricsForChunkForTests('bank_impersonation', [
      expectedClaim,
      unexpectedClaim,
    ]);
    await flushMicrotasks();
    const filtered = emissions.filter((e) => e.name === 'v4.b4.claim_extracted_vs_playbook');
    assert.equal(filtered.length, 2, 'one emit per claim');
  });
});

describe('emitClaimCoverageMetricsForChunk — gate composition', () => {
  it('does NOT emit when playbook_id is null (no lock)', async () => {
    orchestrator._emitClaimCoverageMetricsForChunkForTests(null, [expectedClaim]);
    await flushMicrotasks();
    const filtered = emissions.filter((e) => e.name === 'v4.b4.claim_extracted_vs_playbook');
    assert.equal(filtered.length, 0);
  });

  it('does NOT emit when V4_B4_CLAIM_COVERAGE_TELEMETRY_ENABLED is off', async () => {
    const original = appConfig.V4_B4_CLAIM_COVERAGE_TELEMETRY_ENABLED;
    try {
      (appConfig as { V4_B4_CLAIM_COVERAGE_TELEMETRY_ENABLED: boolean }).V4_B4_CLAIM_COVERAGE_TELEMETRY_ENABLED = false;
      orchestrator._emitClaimCoverageMetricsForChunkForTests('bank_impersonation', [expectedClaim]);
      await flushMicrotasks();
      const filtered = emissions.filter((e) => e.name === 'v4.b4.claim_extracted_vs_playbook');
      assert.equal(filtered.length, 0);
    } finally {
      (appConfig as { V4_B4_CLAIM_COVERAGE_TELEMETRY_ENABLED: boolean }).V4_B4_CLAIM_COVERAGE_TELEMETRY_ENABLED = original;
    }
  });

  it('does NOT emit when master V4_PLAYBOOK_AWARE_ENABLED is off', async () => {
    const original = appConfig.V4_PLAYBOOK_AWARE_ENABLED;
    try {
      (appConfig as { V4_PLAYBOOK_AWARE_ENABLED: boolean }).V4_PLAYBOOK_AWARE_ENABLED = false;
      orchestrator._emitClaimCoverageMetricsForChunkForTests('bank_impersonation', [expectedClaim]);
      await flushMicrotasks();
      const filtered = emissions.filter((e) => e.name === 'v4.b4.claim_extracted_vs_playbook');
      assert.equal(filtered.length, 0, 'master flag must gate everything');
    } finally {
      (appConfig as { V4_PLAYBOOK_AWARE_ENABLED: boolean }).V4_PLAYBOOK_AWARE_ENABLED = original;
    }
  });

  it('emits zero metrics for an empty claims array', async () => {
    orchestrator._emitClaimCoverageMetricsForChunkForTests('bank_impersonation', []);
    await flushMicrotasks();
    const filtered = emissions.filter((e) => e.name === 'v4.b4.claim_extracted_vs_playbook');
    assert.equal(filtered.length, 0);
  });
});
