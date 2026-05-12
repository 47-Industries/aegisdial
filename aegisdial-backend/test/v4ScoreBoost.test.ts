import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 2 — score-boost service tests.
//
// Pins the contract of v4ScoreBoost.ts:
//   - shouldBoost() gate respects V4_PLAYBOOK_SCORE_BOOST_ENABLED,
//     the per-stage allow-list (ask/close only), and the confidence
//     floor (V4_SCORE_BOOST_MIN_CONFIDENCE).
//   - boostForStage() returns the per-stage configured value.
//   - applyV4ScoreBoost() runs the additive-capped UPDATE.
//   - maybeApplyStageBoost() composes all of the above; skipped paths
//     do not touch the DB.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-boost';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-boost-test';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';
process.env.V4_PLAYBOOK_SCORE_BOOST_ENABLED = 'true';
process.env.V4_SCORE_BOOST_MIN_CONFIDENCE = '0.7';
process.env.V4_SCORE_BOOST_ASK = '15';
process.env.V4_SCORE_BOOST_CLOSE = '10';

const db = await import('../src/lib/db.ts');
const boost = await import('../src/services/v4ScoreBoost.ts');

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
  return { rows: [], rowCount: 1 };
};

// Re-install the fake on EVERY test, not just once. Node runs test
// files in parallel and `db.pool` is a process singleton, so a sibling
// file's `before` can win the override race and pollute our queryLog.
// Per-test re-install pins this file's fake right before each `it`.
beforeEach(() => {
  queryLog.length = 0;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

const SESSION = '00000000-0000-0000-0000-000000007777';

describe('v4ScoreBoost — boostForStage', () => {
  it('returns configured value for ask + close, 0 otherwise', () => {
    assert.equal(boost.boostForStage('ask'), 15);
    assert.equal(boost.boostForStage('close'), 10);
    assert.equal(boost.boostForStage('rapport'), 0);
    assert.equal(boost.boostForStage('authority'), 0);
    assert.equal(boost.boostForStage('fear'), 0);
  });
});

describe('v4ScoreBoost — shouldBoost', () => {
  it('rejects stages outside ask/close', () => {
    assert.equal(boost.shouldBoost('rapport', 0.9), false);
    assert.equal(boost.shouldBoost('authority', 0.9), false);
    assert.equal(boost.shouldBoost('fear', 0.9), false);
  });

  it('rejects confidence below the floor', () => {
    assert.equal(boost.shouldBoost('ask', 0.69), false);
    assert.equal(boost.shouldBoost('ask', 0.5), false);
  });

  it('accepts ask + close at or above the floor', () => {
    assert.equal(boost.shouldBoost('ask', 0.7), true);
    assert.equal(boost.shouldBoost('ask', 0.95), true);
    assert.equal(boost.shouldBoost('close', 0.7), true);
  });
});

// Helper: filter queryLog to just call_sessions UPDATEs. `emitMetric`
// writes to metric_counters under the hood, so a raw count would
// over-count by 1 per emit. Tests care about the UPDATE shape, not
// the observability side-effect.
function callSessionsUpdates(): QueryCall[] {
  return queryLog.filter((q) => /UPDATE\s+call_sessions/i.test(q.text));
}

describe('v4ScoreBoost — applyV4ScoreBoost SQL contract', () => {
  it('issues one additive-capped UPDATE', async () => {
    await boost.applyV4ScoreBoost(SESSION, 15);
    const updates = callSessionsUpdates();
    assert.equal(updates.length, 1);
    const q = updates[0]!;
    assert.match(
      q.text,
      /v4_score_boost\s*=\s*LEAST\(100,\s*v4_score_boost\s*\+\s*\$2\)/i,
      'UPDATE must be additive-capped at the SQL layer',
    );
    assert.deepEqual(q.params, [SESSION, 15]);
  });

  it('no-ops when boost is zero or negative', async () => {
    await boost.applyV4ScoreBoost(SESSION, 0);
    await boost.applyV4ScoreBoost(SESSION, -5);
    assert.equal(callSessionsUpdates().length, 0, 'no UPDATE when boost <= 0');
  });
});

describe('v4ScoreBoost — maybeApplyStageBoost end-to-end', () => {
  it('applies the configured boost on ask + high confidence', async () => {
    const applied = await boost.maybeApplyStageBoost({
      session_id: SESSION,
      stage: 'ask',
      confidence: 0.85,
    });
    assert.equal(applied, 15);
    assert.equal(callSessionsUpdates().length, 1);
  });

  it('applies the configured boost on close + high confidence', async () => {
    const applied = await boost.maybeApplyStageBoost({
      session_id: SESSION,
      stage: 'close',
      confidence: 0.9,
    });
    assert.equal(applied, 10);
    assert.equal(callSessionsUpdates().length, 1);
  });

  it('skips below-floor confidence — no SQL issued', async () => {
    const applied = await boost.maybeApplyStageBoost({
      session_id: SESSION,
      stage: 'ask',
      confidence: 0.5,
    });
    assert.equal(applied, 0);
    assert.equal(callSessionsUpdates().length, 0);
  });

  it('skips low-danger stages — no SQL issued', async () => {
    const applied = await boost.maybeApplyStageBoost({
      session_id: SESSION,
      stage: 'rapport',
      confidence: 0.99,
    });
    assert.equal(applied, 0);
    assert.equal(callSessionsUpdates().length, 0);
  });
});

describe('v4ScoreBoost — DB-error tolerance', () => {
  it('swallows UPDATE failures — boost is best-effort', async () => {
    (db.pool as unknown as { query: typeof fakeQuery }).query = (async () => {
      throw new Error('simulated DB outage');
    }) as typeof fakeQuery;

    try {
      // Must NOT throw. Boost is fire-and-forget from the classifier
      // commit path; an exception here would break v4 commits.
      await boost.applyV4ScoreBoost(SESSION, 15);
    } finally {
      (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
    }
  });
});
