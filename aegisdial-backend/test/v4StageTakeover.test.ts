import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 4 — stage-transition takeover tests.
//
// Pins the contract:
//   - shouldFireStageTakeover gate respects flag + stage allow-list
//     (ask/close only) + confidence floor (0.8 default)
//   - maybeFireStageTakeover does the atomic claim on
//     b3_takeover_fired_at (NULL → NOW) and only enqueues if won
//   - On already-claimed (B3/B4 won first), returns false + emits the
//     suppression metric, does NOT enqueue
//   - Trigger_path = 'v4_stage_classifier' + context carries
//     playbook_id + stage + confidence

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-stage-takeover';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-stage-takeover-test';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';
process.env.V4_STAGE_TAKEOVER_ENABLED = 'true';
process.env.V4_STAGE_TAKEOVER_MIN_CONFIDENCE = '0.8';
// V3_B3_ENABLED is required for the downstream enqueue to actually
// insert into guardian_alerts (the dispatcher gates on it).
process.env.V3_B3_ENABLED = 'true';

const db = await import('../src/lib/db.ts');
const stageTakeover = await import('../src/services/v4StageTakeover.ts');
const { config: appConfig } = await import('../src/config.ts');

interface QueryCall {
  text: string;
  params: unknown[];
}
const queryLog: QueryCall[] = [];

// Per-test mutable behaviors. The atomic claim returns rowCount=1
// when this session has no prior takeover; rowCount=0 when B3/B4
// already won. The 60s-window suppression COUNT returns 0 by default
// (no prior takeover within the window).
let claimAvailable = true;

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  queryLog.push({ text, params });
  const t = text.replace(/\s+/g, ' ').trim();

  // Atomic claim — UPDATE call_sessions SET b3_takeover_fired_at = NOW()
  // WHERE id = $1 AND b3_takeover_fired_at IS NULL
  if (
    /UPDATE call_sessions SET b3_takeover_fired_at = NOW\(\), updated_at = NOW\(\) WHERE id = \$1 AND b3_takeover_fired_at IS NULL/i.test(
      t,
    )
  ) {
    return { rows: [], rowCount: claimAvailable ? 1 : 0 };
  }

  // 60s rolling-window suppression check inside enqueueCriticalTakeoverPush.
  if (/SELECT COUNT\(\*\)::TEXT AS count FROM guardian_alerts/i.test(t)) {
    return { rows: [{ count: '0' }], rowCount: 1 };
  }

  // INSERT into guardian_alerts (the takeover row).
  if (/INSERT INTO guardian_alerts/i.test(t)) {
    return { rows: [{ id: 'fake-alert-id' }], rowCount: 1 };
  }

  return { rows: [], rowCount: 1 };
};

beforeEach(() => {
  queryLog.length = 0;
  claimAvailable = true;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

const SESSION = '00000000-0000-0000-0000-000000007070';
const USER = '00000000-0000-0000-0000-00000000aaab';

// Whitespace-tolerant filters — production SQL is multi-line, so the
// literal-space regex above would miss matches. Normalize before
// matching.
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
function claims(): QueryCall[] {
  return queryLog.filter((q) =>
    /UPDATE call_sessions SET b3_takeover_fired_at/i.test(normalize(q.text)),
  );
}
function enqueues(): QueryCall[] {
  return queryLog.filter((q) => /INSERT INTO guardian_alerts/i.test(normalize(q.text)));
}

// Drain the microtask queue. maybeFireStageTakeover fires the enqueue
// as `void enqueueCriticalTakeoverPush(...)` — it returns before the
// enqueue's await chain (currently SELECT count + INSERT, two awaits)
// completes. Tests that check queryLog AFTER calling
// maybeFireStageTakeover need to yield enough times for the chain to
// flush. setImmediate runs after I/O callbacks, guaranteeing one
// microtask drain.
//
// We loop 5 times for robustness — if a future change adds more awaits
// to enqueueCriticalTakeoverPush (e.g. a new metric write, a config
// fetch), a single drain could pass-then-fail with no test source
// change. 5 iterations covers anything realistic without slowing
// tests perceptibly (<5ms total).
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------
// shouldFireStageTakeover — pure gate
// ---------------------------------------------------------------------

describe('shouldFireStageTakeover — gate composition', () => {
  it('rejects stages outside ask/close', () => {
    assert.equal(stageTakeover.shouldFireStageTakeover('rapport', 0.95), false);
    assert.equal(stageTakeover.shouldFireStageTakeover('authority', 0.95), false);
    assert.equal(stageTakeover.shouldFireStageTakeover('fear', 0.95), false);
  });

  it('rejects confidence below the 0.8 floor', () => {
    assert.equal(stageTakeover.shouldFireStageTakeover('ask', 0.79), false);
    assert.equal(stageTakeover.shouldFireStageTakeover('ask', 0.5), false);
  });

  it('accepts ask + close at or above the floor', () => {
    assert.equal(stageTakeover.shouldFireStageTakeover('ask', 0.8), true);
    assert.equal(stageTakeover.shouldFireStageTakeover('ask', 0.95), true);
    assert.equal(stageTakeover.shouldFireStageTakeover('close', 0.8), true);
  });

  it('returns false when the V4_STAGE_TAKEOVER_ENABLED flag is OFF', () => {
    const original = appConfig.V4_STAGE_TAKEOVER_ENABLED;
    try {
      (appConfig as { V4_STAGE_TAKEOVER_ENABLED: boolean }).V4_STAGE_TAKEOVER_ENABLED = false;
      assert.equal(stageTakeover.shouldFireStageTakeover('ask', 0.95), false);
    } finally {
      (appConfig as { V4_STAGE_TAKEOVER_ENABLED: boolean }).V4_STAGE_TAKEOVER_ENABLED = original;
    }
  });
});

// ---------------------------------------------------------------------
// maybeFireStageTakeover — end-to-end through the atomic claim
// ---------------------------------------------------------------------

describe('maybeFireStageTakeover — atomic claim + enqueue', () => {
  it('claims the session and enqueues the push on ask + high confidence', async () => {
    claimAvailable = true;
    const fired = await stageTakeover.maybeFireStageTakeover({
      session_id: SESSION,
      user_id: USER,
      stage: 'ask',
      confidence: 0.9,
      playbook_id: 'irs_impersonation',
    });
    await drainMicrotasks();
    assert.equal(fired, true);
    assert.equal(claims().length, 1, 'one atomic UPDATE-with-WHERE claim');
    assert.equal(enqueues().length, 1, 'one INSERT into guardian_alerts');
    // Verify the enqueue payload carries v4_stage_classifier trigger_path.
    const enqueueQ = enqueues()[0]!;
    const insertParams = enqueueQ.params as unknown[];
    // payload JSONB is one of the params — find it
    const hasV4Trigger = insertParams.some(
      (p) => typeof p === 'string' && p.includes('v4_stage_classifier'),
    );
    assert.ok(hasV4Trigger, 'guardian_alerts payload must carry trigger_path=v4_stage_classifier');
  });

  it('does NOT enqueue when B3/B4 already claimed (claim returns rowCount=0)', async () => {
    claimAvailable = false;
    const fired = await stageTakeover.maybeFireStageTakeover({
      session_id: SESSION,
      user_id: USER,
      stage: 'ask',
      confidence: 0.95,
      playbook_id: 'irs_impersonation',
    });
    assert.equal(fired, false);
    assert.equal(claims().length, 1, 'claim attempted');
    assert.equal(enqueues().length, 0, 'NO enqueue when claim was already taken');
  });

  it('does NOT touch the DB at all when shouldFire is false (below-floor confidence)', async () => {
    const fired = await stageTakeover.maybeFireStageTakeover({
      session_id: SESSION,
      user_id: USER,
      stage: 'ask',
      confidence: 0.7,  // below 0.8 floor
      playbook_id: 'irs_impersonation',
    });
    assert.equal(fired, false);
    assert.equal(claims().length, 0, 'no SQL when gate fails');
    assert.equal(enqueues().length, 0);
  });

  it('does NOT fire on low-danger stages even with high confidence', async () => {
    const fired = await stageTakeover.maybeFireStageTakeover({
      session_id: SESSION,
      user_id: USER,
      stage: 'rapport',
      confidence: 0.99,
      playbook_id: 'irs_impersonation',
    });
    assert.equal(fired, false);
    assert.equal(claims().length, 0);
  });

  it('fires for close stage too — not just ask', async () => {
    claimAvailable = true;
    const fired = await stageTakeover.maybeFireStageTakeover({
      session_id: SESSION,
      user_id: USER,
      stage: 'close',
      confidence: 0.9,
      playbook_id: 'bank_impersonation',
    });
    await drainMicrotasks();
    assert.equal(fired, true);
    assert.equal(enqueues().length, 1);
  });
});

describe('maybeFireStageTakeover — payload contract', () => {
  it('passes playbook_display_name into the enqueue context for human-readable copy', async () => {
    claimAvailable = true;
    await stageTakeover.maybeFireStageTakeover({
      session_id: SESSION,
      user_id: USER,
      stage: 'ask',
      confidence: 0.9,
      playbook_id: 'irs_impersonation',
    });
    await drainMicrotasks();
    // The display name 'IRS impersonation' should be in the enqueue
    // params (carried via context for buildTakeoverCopy).
    const params = enqueues()[0]!.params as unknown[];
    const hasName = params.some(
      (p) => typeof p === 'string' && p.includes('IRS impersonation'),
    );
    assert.ok(hasName, 'enqueue context must carry playbook_display_name');
  });
});
