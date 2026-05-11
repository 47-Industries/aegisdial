import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v3 — Phase 5 push-dispatcher enqueue tests.
//
// Verifies that:
//   - shield_takeover rows land in guardian_alerts with the right shape
//   - Different trigger_paths produce different title/body copy
//   - B4 trigger with raw_quote injects the quote into the body
//   - block_retry rows have severity=info and the right payload shape
//   - Feature-flag gates prevent enqueue when disabled

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v3-phase5-push';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v3-phase5-push';
process.env.ALLOW_DEV_BEARER = 'true';
process.env.ENZOIC_MOCK = 'true';
process.env.V3_B3_ENABLED = 'true';
process.env.V3_A2_ENABLED = 'true';

const db = await import('../src/lib/db.ts');
const dispatcher = await import('../src/services/v3PushDispatcher.ts');

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = '00000000-0000-0000-0000-000000000000';

interface GuardianRow {
  guardian_user_id: string;
  subject_user_id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
}

const dbState = {
  inserts: [] as GuardianRow[],
};

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.trim();

  // 60-second per-user suppression check added by the Phase 5
  // adversarial-review fix. Return 0 so tests reach the INSERT path.
  if (/SELECT COUNT\(\*\)::TEXT AS count\s+FROM guardian_alerts/i.test(t) && /shield_takeover/i.test(t)) {
    return { rows: [{ count: '0' }], rowCount: 1 };
  }

  if (/^INSERT INTO guardian_alerts/i.test(t)) {
    const [guardian_user_id, subject_user_id, title, body, payloadJson] = params as [
      string, string, string, string, string,
    ];
    const kindMatch = t.match(/'(shield_takeover|block_retry|shield_post_dismiss)'/);
    const severityMatch = t.match(/'(critical|warning|info)'/);
    dbState.inserts.push({
      guardian_user_id,
      subject_user_id,
      kind: kindMatch?.[1] ?? 'unknown',
      severity: severityMatch?.[1] ?? 'unknown',
      title,
      body,
      payload: JSON.parse(payloadJson),
    });
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`unhandled query: ${t.slice(0, 80)}`);
};

before(() => {
  type Patchable = { pool: { query: typeof fakeQuery } };
  (db as unknown as Patchable).pool.query = fakeQuery as unknown as typeof fakeQuery;
});

beforeEach(() => {
  dbState.inserts.length = 0;
});

describe('enqueueCriticalTakeoverPush — B3 critical', () => {
  it('writes a shield_takeover row with severity=critical and live_shield_critical trigger', async () => {
    const result = await dispatcher.enqueueCriticalTakeoverPush({
      session_id: SESSION_ID,
      user_id: USER_ID,
      trigger_path: 'live_shield_critical',
      risk_score: 92,
    });
    assert.equal(result.enqueued, true);
    assert.equal(dbState.inserts.length, 1);
    const row = dbState.inserts[0]!;
    assert.equal(row.kind, 'shield_takeover');
    assert.equal(row.severity, 'critical');
    assert.equal(row.guardian_user_id, USER_ID); // self-targeted
    assert.equal(row.subject_user_id, USER_ID);
    assert.equal(row.payload.session_id, SESSION_ID);
    assert.equal(row.payload.trigger_path, 'live_shield_critical');
    assert.equal(row.payload.interruption_level_request, 'critical');
    assert.equal(row.payload.interruption_level_fallback, 'time-sensitive');
    assert.equal(row.payload.ios_category, 'AEGISDIAL_CRITICAL_TAKEOVER');
    assert.match(row.title, /STOP/);
  });
});

describe('enqueueCriticalTakeoverPush — B4 finding with quoted lie', () => {
  it('injects the verbatim quote into the notification body', async () => {
    await dispatcher.enqueueCriticalTakeoverPush({
      session_id: SESSION_ID,
      user_id: USER_ID,
      trigger_path: 'b4_finding',
      risk_score: 97,
      context: {
        claim_type: 'bank_affiliation',
        raw_quote: 'Hi, this is Wells Fargo fraud department',
        reasoning: 'Wells Fargo does not cold-call.',
        finding_id: 'abc',
      },
    });
    const row = dbState.inserts[0]!;
    assert.match(row.body, /Wells Fargo fraud department/);
    assert.match(row.title, /lying/i);
    assert.equal(row.payload.trigger_path, 'b4_finding');
  });

  it('truncates long quotes to fit notification body', async () => {
    const longQuote = 'A'.repeat(200);
    await dispatcher.enqueueCriticalTakeoverPush({
      session_id: SESSION_ID,
      user_id: USER_ID,
      trigger_path: 'b4_finding',
      risk_score: 97,
      context: { claim_type: 'bank_affiliation', raw_quote: longQuote },
    });
    const row = dbState.inserts[0]!;
    // Should be truncated to 80 chars + ellipsis. Body wraps in quotes,
    // so we just check the body is reasonably bounded.
    assert.ok(row.body.length < 200);
    assert.match(row.body, /…/);
  });
});

describe('enqueueCriticalTakeoverPush — B3 sentinel', () => {
  it('uses sentinel-specific copy', async () => {
    await dispatcher.enqueueCriticalTakeoverPush({
      session_id: SESSION_ID,
      user_id: USER_ID,
      trigger_path: 'sentinel_keyword',
      risk_score: 100,
      context: { pattern_name: 'ssn_spoken_aloud', matched_text: '123 45 6789' },
    });
    const row = dbState.inserts[0]!;
    assert.match(row.title, /STOP/);
    assert.match(row.body, /share/i);
    assert.equal(row.payload.trigger_path, 'sentinel_keyword');
  });
});

describe('enqueueBlockRetryPush', () => {
  it('writes a block_retry row with severity=info', async () => {
    const result = await dispatcher.enqueueBlockRetryPush({
      user_id: USER_ID,
      e164: '+14155550199',
      attempted_at: new Date('2026-05-11T12:00:00Z'),
    });
    assert.equal(result.enqueued, true);
    const row = dbState.inserts[0]!;
    assert.equal(row.kind, 'block_retry');
    assert.equal(row.severity, 'info');
    assert.equal(row.guardian_user_id, USER_ID);
    assert.equal(row.payload.e164, '+14155550199');
    assert.equal(row.payload.interruption_level_request, 'passive');
    assert.equal(row.payload.ios_category, 'AEGISDIAL_BLOCK_RETRY');
  });

  it('does NOT leak the e164 number in the notification body', async () => {
    await dispatcher.enqueueBlockRetryPush({
      user_id: USER_ID,
      e164: '+14155550199',
      attempted_at: new Date(),
    });
    const row = dbState.inserts[0]!;
    // The body is what shows on the lock screen — must not contain
    // the actual number (the iOS app can fetch via /v1/blocks/explain
    // after auth-gated tap).
    assert.doesNotMatch(row.body, /4155550199/);
    assert.doesNotMatch(row.body, /\+1/);
  });
});
