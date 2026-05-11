import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// R8 — per-recipient family-alert 60s cooldown. Reviewer note from
// the original Phase 5 review: "Phase 5 PR adds per-shield_takeover-
// kind 60s suppression but not per-family-member across all kinds.
// Worth implementing before launch."
//
// These tests pin the contract:
//   - Two non-critical alerts to the same recipient within 60s → second is suppressed
//   - Critical severity bypasses cooldown (post_dismiss escalation case)
//   - Critical alerts still SET the cooldown (chatter after a critical is suppressed)
//   - Different subjects don't cross-interfere (per-(recipient,subject) key)
//   - Different recipients don't cross-interfere

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-r8';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://r8-cooldown-test';

const db = await import('../src/lib/db.ts');
const { emitGuardianAlert, _resetCooldownForTests } = await import(
  '../src/services/guardianAlerts.ts'
);

const SUBJECT = '00000000-0000-0000-0000-000000000001';
const SUBJECT_B = '00000000-0000-0000-0000-000000000002';
const GUARDIANS = [
  '00000000-0000-0000-0000-000000001001',
  '00000000-0000-0000-0000-000000001002',
];
const [g1, g2] = GUARDIANS;

interface QueryCall {
  text: string;
  params: unknown[];
}
const queryLog: QueryCall[] = [];

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  queryLog.push({ text, params });
  const t = text.trim();
  if (/WITH plan AS/i.test(t)) {
    return { rows: GUARDIANS.map((user_id) => ({ user_id })), rowCount: GUARDIANS.length };
  }
  if (/^SELECT family_plan_id\s+FROM family_members/i.test(t)) {
    return { rows: [{ family_plan_id: 'plan-1' }], rowCount: 1 };
  }
  if (/^INSERT INTO guardian_alerts/i.test(t)) {
    // rowCount = number of (8-param) groups in params
    return { rows: [], rowCount: Math.floor(params.length / 8) };
  }
  if (/SELECT u\.id AS user_id, u\.email/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }
  if (/SELECT display_name FROM users/i.test(t)) {
    return { rows: [{ display_name: 'Test Subject' }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

// Patch the underlying pool, not the exported `query` (ESM bindings
// are read-only). lib/db.ts's `query` calls `pool.query` internally,
// so the patched method intercepts. Same pattern as guardianAlerts.test.ts.
(db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;

before(() => {
  // Sanity check — imports resolved.
  assert.equal(typeof _resetCooldownForTests, 'function');
});

beforeEach(async () => {
  queryLog.length = 0;
  // Cooldown state outlives a single test; clear it explicitly so each
  // case starts from a clean slate. Both subjects, both guardians.
  await _resetCooldownForTests(SUBJECT, GUARDIANS);
  await _resetCooldownForTests(SUBJECT_B, GUARDIANS);
});

function insertCall(): QueryCall | undefined {
  return queryLog.find((c) => /^INSERT INTO guardian_alerts/i.test(c.text.trim()));
}

describe('R8 cooldown — non-critical alerts', () => {
  it('first emit delivers to all guardians', async () => {
    const r = await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'recovery_started',
      severity: 'info',
      title: 'first',
      body: 'first',
    });
    assert.equal(r.delivered, 2);
    assert.equal(r.recipients, 2);
  });

  it('second emit within 60s to same subject is fully suppressed', async () => {
    await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'recovery_started',
      severity: 'info',
      title: 'first',
      body: 'first',
    });
    queryLog.length = 0;
    const r2 = await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'safe_word_failed',
      severity: 'warning',
      title: 'second',
      body: 'second',
    });
    // All guardians on cooldown — no INSERT, recipients=0.
    assert.equal(r2.delivered, 0);
    assert.equal(r2.recipients, 0);
    assert.equal(insertCall(), undefined);
  });

  it('suppression spans alert KINDS — info → warning still suppressed', async () => {
    // Specifically the case the reviewer flagged: per-takeover-kind
    // suppression at the dispatcher layer does NOT cover
    // multi-kind chatter to the same recipient.
    await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'breach_new',
      severity: 'info',
      title: 'a',
      body: 'a',
    });
    queryLog.length = 0;
    const r2 = await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'shield_post_dismiss',
      severity: 'warning',
      title: 'b',
      body: 'b',
    });
    assert.equal(r2.delivered, 0);
  });
});

describe('R8 cooldown — critical severity bypass', () => {
  it('critical bypasses cooldown after a recent non-critical', async () => {
    await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'recovery_started',
      severity: 'info',
      title: 'low',
      body: 'low',
    });
    queryLog.length = 0;
    const r2 = await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'shield_critical',
      severity: 'critical',
      title: 'crit',
      body: 'crit',
    });
    assert.equal(r2.delivered, 2);
    assert.equal(r2.recipients, 2);
  });

  it('critical → critical within 60s both deliver (post_dismiss case)', async () => {
    // This is the actual post-dismiss escalation: shield_critical at t=0,
    // shield_post_dismiss (critical) at t=30s. Both must land.
    const r1 = await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'shield_critical',
      severity: 'critical',
      title: 'first',
      body: 'first',
    });
    const r2 = await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'shield_post_dismiss',
      severity: 'critical',
      title: 'esc',
      body: 'esc',
    });
    assert.equal(r1.delivered, 2);
    assert.equal(r2.delivered, 2);
  });

  it('critical alert SETS the cooldown — subsequent non-critical suppressed', async () => {
    await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'shield_critical',
      severity: 'critical',
      title: 'crit',
      body: 'crit',
    });
    queryLog.length = 0;
    const r2 = await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'recovery_started',
      severity: 'info',
      title: 'low',
      body: 'low',
    });
    // Critical claimed the recipients' attention; chatter is muted.
    assert.equal(r2.delivered, 0);
  });
});

describe('R8 cooldown — concurrency (MEDIUM-2 follow-up)', () => {
  it('two concurrent non-critical emits to same (subject,guardians) → exactly one delivers per guardian', async () => {
    // The whole correctness argument for using `incrWithTtl` (atomic
    // Lua) over `incr() + expire()` rests on race-resistance under
    // concurrent calls. This test pins the contract: two emits fired
    // in parallel result in exactly one delivery to each guardian
    // across both, not two and not zero.
    //
    // HONEST CAVEAT: InMemoryCache (test backend) is synchronous run-
    // to-completion under Node's single-threaded loop, so `Promise.all`
    // doesn't truly interleave. The atomic-Lua property is only
    // *meaningful* on real Redis. This test catches a future refactor
    // that swaps `incrWithTtl` for `get-then-incr` even in the
    // sequential case (the second call would observe the first's
    // increment in any sane implementation), but it does NOT prove
    // race-safety on prod Upstash. The Lua script itself + the
    // contract on `incrWithTtl` are the production guarantee.
    const [r1, r2] = await Promise.all([
      emitGuardianAlert({
        subjectUserId: SUBJECT,
        kind: 'recovery_started',
        severity: 'info',
        title: 'a',
        body: 'a',
      }),
      emitGuardianAlert({
        subjectUserId: SUBJECT,
        kind: 'safe_word_failed',
        severity: 'warning',
        title: 'b',
        body: 'b',
      }),
    ]);
    // Exactly one of the two calls delivered to each of the 2 guardians.
    assert.equal(r1.delivered + r2.delivered, 2);
    // The other call saw all guardians on cooldown.
    assert.equal(r1.cooldownSuppressed + r2.cooldownSuppressed, 2);
  });
});

describe('R8 cooldown — outcome discriminator (MEDIUM-4 follow-up)', () => {
  it('no family registered → recipients=0, cooldownSuppressed=0', async () => {
    // Empty guardian list — return early before cooldown filter.
    const SOLITARY = '00000000-0000-0000-0000-00000000ffff';
    const oldQuery = (db.pool as unknown as { query: typeof fakeQuery }).query;
    (db.pool as unknown as { query: typeof fakeQuery }).query = (async (text, params = []) => {
      const t = (text as string).trim();
      if (/WITH plan AS/i.test(t)) return { rows: [], rowCount: 0 };
      return oldQuery(text, params);
    }) as typeof fakeQuery;
    try {
      const r = await emitGuardianAlert({
        subjectUserId: SOLITARY,
        kind: 'recovery_started',
        severity: 'info',
        title: 'x',
        body: 'x',
      });
      assert.equal(r.delivered, 0);
      assert.equal(r.recipients, 0);
      assert.equal(r.cooldownSuppressed, 0);
    } finally {
      (db.pool as unknown as { query: typeof fakeQuery }).query = oldQuery;
    }
  });

  it('all suppressed by cooldown → recipients=0, cooldownSuppressed=GUARDIANS.length', async () => {
    await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'recovery_started',
      severity: 'info',
      title: 'a',
      body: 'a',
    });
    const r2 = await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'safe_word_failed',
      severity: 'warning',
      title: 'b',
      body: 'b',
    });
    assert.equal(r2.delivered, 0);
    assert.equal(r2.recipients, 0);
    assert.equal(r2.cooldownSuppressed, GUARDIANS.length);
    // Distinguished from no-family: cooldownSuppressed > 0.
  });
});

describe('R8 cooldown — per-(recipient,subject) keying', () => {
  it('different subjects do NOT share cooldown', async () => {
    await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'recovery_started',
      severity: 'info',
      title: 'a',
      body: 'a',
    });
    // SUBJECT_B has the same guardians but a different subject — they
    // should be alertable independently.
    const r2 = await emitGuardianAlert({
      subjectUserId: SUBJECT_B,
      kind: 'recovery_started',
      severity: 'info',
      title: 'b',
      body: 'b',
    });
    assert.equal(r2.delivered, 2);
    assert.equal(r2.recipients, 2);
  });
});
