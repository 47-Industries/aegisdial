import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Retention sweeper — Identity Shield tables (I-M1).
//
// The base retentionSweeper.test.ts smoke-imports the module against
// a real-DB-absent fixture. This file pins the SQL-shape contract for
// the new Identity Shield specs (identity_monitors, identity_breach_
// findings, active_threats) by stubbing pool.query against an
// in-memory model and verifying that each spec's WHERE clause keeps
// the right rows alive and DELETEs the rest.
//
// Coverage:
//   - identity_monitors  active=TRUE       → preserved regardless of age
//   - identity_monitors  active=FALSE >90d  → deleted
//   - identity_monitors  active=FALSE <90d  → preserved
//   - findings           remediation_completed_at <90d → preserved
//   - findings           remediation_completed_at >90d → deleted
//   - findings           remediation_completed_at IS NULL → preserved
//   - active_threats     expires_at < NOW()   → deleted
//   - active_threats     expires_at IS NULL   → preserved (confirmed_scammer)
//   - active_threats     expires_at in future → preserved

process.env.DATA_ENCRYPTION_KEY ||=
  'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-retention-id';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://retention-id-test';

const db = await import('../src/lib/db.ts');
const sweeper = await import('../src/workers/retentionSweeper.ts');

// ────────────────────────────────────────────────────────────────
// In-memory state for the three Identity Shield tables we care
// about. Every other DELETE the sweeper issues falls through to a
// no-op response so legacy specs don't crash the test.
// ────────────────────────────────────────────────────────────────

interface FakeMonitor {
  active: boolean;
  created_at: Date;
}
interface FakeFinding {
  remediation_completed_at: Date | null;
}
interface FakeActiveThreat {
  expires_at: Date | null;
}

const state = {
  monitors: [] as FakeMonitor[],
  findings: [] as FakeFinding[],
  active_threats: [] as FakeActiveThreat[],
};

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}
function daysAhead(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.replace(/\s+/g, ' ').trim();

  // ── identity_monitors sweep ─────────────────────────────────
  if (/^DELETE FROM identity_monitors WHERE created_at < NOW\(\)/i.test(t)) {
    const days = parseInt(String(params[0] ?? '0'), 10);
    const cutoff = Date.now() - days * 86400 * 1000;
    const before = state.monitors.length;
    state.monitors = state.monitors.filter((m) => {
      // Mirror the SQL: delete iff created_at < cutoff AND active=FALSE.
      const tooOld = m.created_at.getTime() < cutoff;
      const isSoftDeleted = !m.active;
      return !(tooOld && isSoftDeleted);
    });
    return { rows: [], rowCount: before - state.monitors.length };
  }

  // ── identity_breach_findings sweep ──────────────────────────
  if (
    /^DELETE FROM identity_breach_findings WHERE remediation_completed_at < NOW\(\)/i.test(t)
  ) {
    const days = parseInt(String(params[0] ?? '0'), 10);
    const cutoff = Date.now() - days * 86400 * 1000;
    const before = state.findings.length;
    state.findings = state.findings.filter((f) => {
      if (f.remediation_completed_at === null) return true; // IS NOT NULL guard
      const tooOld = f.remediation_completed_at.getTime() < cutoff;
      return !tooOld;
    });
    return { rows: [], rowCount: before - state.findings.length };
  }

  // ── active_threats expired_only sweep ───────────────────────
  if (/^DELETE FROM active_threats WHERE expires_at < NOW\(\)/i.test(t)) {
    const now = Date.now();
    const before = state.active_threats.length;
    state.active_threats = state.active_threats.filter((a) => {
      if (a.expires_at === null) return true; // IS NOT NULL guard
      return a.expires_at.getTime() >= now;
    });
    return { rows: [], rowCount: before - state.active_threats.length };
  }

  // Every other DELETE/SELECT issued by the sweeper falls through —
  // legacy specs run against tables that don't exist in this fake,
  // so the sweeper logs them as skipped (matches prod behavior when
  // a table is missing on a fresh deploy).
  return { rows: [], rowCount: 0 };
};

// Note: expireStaleTamperAlerts runs the same query() path which
// reaches our fake pool below. It issues an UPDATE on
// email_tamper_alerts which falls through to the catch-all
// {rowCount:0} response — harmless for these tests.

(db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;

beforeEach(() => {
  state.monitors = [];
  state.findings = [];
  state.active_threats = [];
});

// ────────────────────────────────────────────────────────────────
// identity_monitors
// ────────────────────────────────────────────────────────────────

describe('I-M1: retentionSweeper identity_monitors', () => {
  it('preserves active=TRUE monitors regardless of age', async () => {
    state.monitors.push({ active: true, created_at: daysAgo(365) });
    state.monitors.push({ active: true, created_at: daysAgo(91) });
    await sweeper.runRetentionSweepOnce();
    assert.equal(state.monitors.length, 2, 'active monitors never swept');
  });

  it('deletes soft-deleted (active=FALSE) monitors older than 90d', async () => {
    state.monitors.push({ active: false, created_at: daysAgo(95) });
    await sweeper.runRetentionSweepOnce();
    assert.equal(state.monitors.length, 0);
  });

  it('preserves soft-deleted monitors newer than 90d (still within cooldown)', async () => {
    state.monitors.push({ active: false, created_at: daysAgo(30) });
    await sweeper.runRetentionSweepOnce();
    assert.equal(state.monitors.length, 1);
  });

  it('mixed cohort: only old soft-deleted rows are removed', async () => {
    state.monitors.push(
      { active: true, created_at: daysAgo(200) },   // preserved (active)
      { active: false, created_at: daysAgo(95) },   // deleted (old soft-delete)
      { active: false, created_at: daysAgo(15) },   // preserved (recent soft-delete)
      { active: true, created_at: daysAgo(2) },     // preserved (active)
    );
    await sweeper.runRetentionSweepOnce();
    assert.equal(state.monitors.length, 3);
    assert.ok(state.monitors.every((m) => m.active || m.created_at.getTime() > daysAgo(90).getTime()));
  });
});

// ────────────────────────────────────────────────────────────────
// identity_breach_findings
// ────────────────────────────────────────────────────────────────

describe('I-M1: retentionSweeper identity_breach_findings', () => {
  it('deletes findings remediated more than 90 days ago', async () => {
    state.findings.push({ remediation_completed_at: daysAgo(120) });
    await sweeper.runRetentionSweepOnce();
    assert.equal(state.findings.length, 0);
  });

  it('preserves findings remediated within the last 90 days', async () => {
    state.findings.push({ remediation_completed_at: daysAgo(30) });
    await sweeper.runRetentionSweepOnce();
    assert.equal(state.findings.length, 1);
  });

  it('preserves never-remediated findings (remediation_completed_at IS NULL) forever', async () => {
    state.findings.push({ remediation_completed_at: null });
    await sweeper.runRetentionSweepOnce();
    assert.equal(state.findings.length, 1, 'open findings are the user task list');
  });

  it('mixed cohort: only completed-and-stale rows are removed', async () => {
    state.findings.push(
      { remediation_completed_at: null },          // preserved (open)
      { remediation_completed_at: daysAgo(120) },  // deleted (stale)
      { remediation_completed_at: daysAgo(60) },   // preserved (recent)
    );
    await sweeper.runRetentionSweepOnce();
    assert.equal(state.findings.length, 2);
  });
});

// ────────────────────────────────────────────────────────────────
// active_threats
// ────────────────────────────────────────────────────────────────

describe('I-M1: retentionSweeper active_threats', () => {
  it('deletes rows whose expires_at is in the past', async () => {
    state.active_threats.push({ expires_at: daysAgo(1) });
    await sweeper.runRetentionSweepOnce();
    assert.equal(state.active_threats.length, 0);
  });

  it('preserves rows with expires_at IS NULL (confirmed_scammer, eternal)', async () => {
    state.active_threats.push({ expires_at: null });
    await sweeper.runRetentionSweepOnce();
    assert.equal(state.active_threats.length, 1);
  });

  it('preserves rows with expires_at in the future', async () => {
    state.active_threats.push({ expires_at: daysAhead(30) });
    await sweeper.runRetentionSweepOnce();
    assert.equal(state.active_threats.length, 1);
  });

  it('mixed cohort: only expired-and-non-null rows are removed', async () => {
    state.active_threats.push(
      { expires_at: null },           // preserved (eternal)
      { expires_at: daysAgo(1) },     // deleted (expired)
      { expires_at: daysAhead(7) },   // preserved (future)
    );
    await sweeper.runRetentionSweepOnce();
    assert.equal(state.active_threats.length, 2);
    assert.ok(
      state.active_threats.every(
        (a) => a.expires_at === null || a.expires_at.getTime() > Date.now(),
      ),
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Integration — single sweep doesn't break the legacy specs
// ────────────────────────────────────────────────────────────────

describe('I-M1: retentionSweeper integration with legacy specs', () => {
  it('runs end-to-end and reports identity-shield tables in the result array', async () => {
    state.monitors.push({ active: false, created_at: daysAgo(100) });
    state.findings.push({ remediation_completed_at: daysAgo(100) });
    state.active_threats.push({ expires_at: daysAgo(1) });
    const results = await sweeper.runRetentionSweepOnce();
    const tables = new Set(results.map((r) => r.table));
    assert.ok(tables.has('identity_monitors'));
    assert.ok(tables.has('identity_breach_findings'));
    assert.ok(tables.has('active_threats'));
    // All three Identity Shield rows were deleted in this run.
    assert.equal(state.monitors.length, 0);
    assert.equal(state.findings.length, 0);
    assert.equal(state.active_threats.length, 0);
  });
});
