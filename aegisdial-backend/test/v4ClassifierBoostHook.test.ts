import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 2 — classifier → score-boost integration.
//
// Pins the contract that handleClassification, after committing a
// transition to a high-danger stage with high confidence, also fires
// the v4 score-boost UPDATE. The boost must NOT fire when:
//   - confidence is below the boost floor
//   - stage is not in (ask, close)
//   - it's a no-change-stable tick (same tuple as before)

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-boost-hook';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-boost-hook-test';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';
process.env.V4_PLAYBOOK_SCORE_BOOST_ENABLED = 'true';
process.env.V4_SCORE_BOOST_MIN_CONFIDENCE = '0.7';
process.env.V4_SCORE_BOOST_ASK = '15';
process.env.V4_SCORE_BOOST_CLOSE = '10';
process.env.V4_PLAYBOOK_MIN_CONFIDENCE = '0.55';

const db = await import('../src/lib/db.ts');
const classifier = await import('../src/services/stageClassifier.ts');

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
beforeEach(() => {
  queryLog.length = 0;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

const SESSION = '00000000-0000-0000-0000-000000009999';
const USER = '00000000-0000-0000-0000-00000000dddd';

function countBoostUpdates(): number {
  return queryLog.filter(
    (q) => /UPDATE\s+call_sessions/i.test(q.text) && /v4_score_boost\s*=\s*LEAST/i.test(q.text),
  ).length;
}

describe('handleClassification → v4 score boost', () => {
  it('fires the boost UPDATE after committing a transition into ask with high confidence', async () => {
    await classifier.handleClassification({
      session_id: SESSION,
      user_id: USER,
      current: { playbook_id: 'irs_impersonation', stage: 'fear' },
      classification: {
        playbook_id: 'irs_impersonation',
        stage: 'ask',
        confidence: 0.85,
        reasoning: 'caller demanded gift card',
      },
      trigger_event_id: null,
    });
    assert.equal(countBoostUpdates(), 1, 'one v4_score_boost UPDATE expected after ask transition');
  });

  it('fires the boost on the initial commit when first detection is ask', async () => {
    await classifier.handleClassification({
      session_id: SESSION,
      user_id: USER,
      current: { playbook_id: null, stage: null },
      classification: {
        playbook_id: 'bank_impersonation',
        stage: 'ask',
        confidence: 0.95,
        reasoning: 'caller asked to wire funds to safe account',
      },
      trigger_event_id: null,
    });
    assert.equal(countBoostUpdates(), 1);
  });

  it('does NOT boost on a transition into a low-danger stage', async () => {
    await classifier.handleClassification({
      session_id: SESSION,
      user_id: USER,
      current: { playbook_id: null, stage: null },
      classification: {
        playbook_id: 'irs_impersonation',
        stage: 'rapport',
        confidence: 0.9,
        reasoning: 'opening courtesy phrasing',
      },
      trigger_event_id: null,
    });
    assert.equal(countBoostUpdates(), 0);
  });

  it('does NOT boost when confidence is at or above commit floor but below boost floor', async () => {
    // 0.6 clears the commit floor (0.55) but not the boost floor (0.7).
    // The tuple gets persisted, but no boost fires.
    await classifier.handleClassification({
      session_id: SESSION,
      user_id: USER,
      current: { playbook_id: null, stage: null },
      classification: {
        playbook_id: 'irs_impersonation',
        stage: 'ask',
        confidence: 0.6,
        reasoning: 'ambiguous payment ask',
      },
      trigger_event_id: null,
    });
    assert.equal(countBoostUpdates(), 0, 'confidence between commit floor and boost floor must not boost');
    // But the commit itself DID happen.
    const commits = queryLog.filter(
      (q) => /UPDATE\s+call_sessions/i.test(q.text) && /v4_playbook_id\s*=/i.test(q.text),
    );
    assert.equal(commits.length, 1, 'tuple commit still fires at commit-floor confidence');
  });

  it('does NOT boost on no-change-stable tick (same tuple as before)', async () => {
    await classifier.handleClassification({
      session_id: SESSION,
      user_id: USER,
      current: { playbook_id: 'irs_impersonation', stage: 'ask' },
      classification: {
        playbook_id: 'irs_impersonation',
        stage: 'ask',
        confidence: 0.95,
        reasoning: 'still asking for gift cards',
      },
      trigger_event_id: null,
    });
    assert.equal(countBoostUpdates(), 0);
    // And no commit UPDATE either — same-tuple short-circuits before commit.
    const commits = queryLog.filter(
      (q) => /UPDATE\s+call_sessions/i.test(q.text) && /v4_playbook_id\s*=/i.test(q.text),
    );
    assert.equal(commits.length, 0);
  });

  it('boosts close-stage transitions with the close-tier value', async () => {
    await classifier.handleClassification({
      session_id: SESSION,
      user_id: USER,
      current: { playbook_id: 'irs_impersonation', stage: 'ask' },
      classification: {
        playbook_id: 'irs_impersonation',
        stage: 'close',
        confidence: 0.9,
        reasoning: 'instructed not to tell anyone',
      },
      trigger_event_id: null,
    });
    const boostQ = queryLog.find(
      (q) => /UPDATE\s+call_sessions/i.test(q.text) && /v4_score_boost\s*=\s*LEAST/i.test(q.text),
    );
    assert.ok(boostQ);
    // params[1] is the boost value — must be the V4_SCORE_BOOST_CLOSE
    // value (10), not the V4_SCORE_BOOST_ASK value (15).
    assert.equal(boostQ!.params[1], 10);
  });
});
