import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v3 — B4 sub-threshold score-boost (audit Gap #3).
//
// Tests pin two things:
//   1. The integer-math formula: round(weight * confidence * 100)
//   2. The orchestrator's UPDATE shape: SET b4_score_boost = LEAST(100, ...).
//
// The full extract → verify → dispatch pipeline is covered by
// test/v3Phase3B4.test.ts. This file isolates the boost math so the
// regression surface is small and the test reads cleanly.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-b4-boost';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v3-b4-boost-test';
process.env.V3_B4_ENABLED = 'true';
process.env.V3_B4_TAKEOVER_THRESHOLD = '0.95';
process.env.V3_B4_SCORE_BOOST_LOW_CONF_WEIGHT = '0.15';
process.env.V3_B4_SCORE_BOOST_CANNOT_VERIFY_WEIGHT = '0.05';

const db = await import('../src/lib/db.ts');
const orch = await import('../src/services/b4Orchestrator.ts');
const { config } = await import('../src/config.ts');

const SESSION_ID = '00000000-0000-0000-0000-00000000b4b4';

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

before(() => {
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

beforeEach(() => {
  queryLog.length = 0;
});

describe('B4 score boost — UPDATE shape', () => {
  it('applies a positive boost via call_sessions UPDATE', async () => {
    await orch._applyB4ScoreBoostForTests(SESSION_ID, 15);
    const updates = queryLog.filter((c) => /UPDATE call_sessions/i.test(c.text));
    assert.equal(updates.length, 1);
    const call = updates[0]!;
    assert.match(call.text, /b4_score_boost\s*=\s*LEAST\(100,\s*b4_score_boost\s*\+\s*\$2\)/i);
    assert.equal(call.params[0], SESSION_ID);
    assert.equal(call.params[1], 15);
  });

  it('does not throw when DB fails (best-effort write)', async () => {
    // Swap fakeQuery for a throwing one for this test.
    const original = (db.pool as unknown as { query: typeof fakeQuery }).query;
    (db.pool as unknown as { query: typeof fakeQuery }).query = (async () => {
      throw new Error('simulated DB outage');
    }) as typeof fakeQuery;
    try {
      // Must not throw — boost is best-effort.
      await orch._applyB4ScoreBoostForTests(SESSION_ID, 10);
      assert.ok(true);
    } finally {
      (db.pool as unknown as { query: typeof fakeQuery }).query = original;
    }
  });
});

describe('B4 score boost — integer math', () => {
  // The orchestrator branches:
  //   contradicted < threshold → round(LOW_CONF_WEIGHT * confidence * 100)
  //   cannot_verify           → round(CANNOT_VERIFY_WEIGHT * confidence * 100)
  // These tests pin the formula independently of orchestrator wiring.

  function lowConfBoost(confidence: number): number {
    return Math.round(config.V3_B4_SCORE_BOOST_LOW_CONF_WEIGHT * confidence * 100);
  }
  function cannotVerifyBoost(confidence: number): number {
    return Math.round(config.V3_B4_SCORE_BOOST_CANNOT_VERIFY_WEIGHT * confidence * 100);
  }

  it('low-conf contradicted: 0.8 confidence → 12 points (0.15 * 0.8 * 100)', () => {
    assert.equal(lowConfBoost(0.8), 12);
  });

  it('low-conf contradicted: 0.5 confidence → 8 points (rounded from 7.5)', () => {
    assert.equal(lowConfBoost(0.5), 8);
  });

  it('low-conf contradicted: maximum sub-threshold (0.94) → 14 points', () => {
    assert.equal(lowConfBoost(0.94), 14);
  });

  it('cannot_verify: 0.8 confidence → 4 points (0.05 * 0.8 * 100)', () => {
    assert.equal(cannotVerifyBoost(0.8), 4);
  });

  it('cannot_verify: 0.5 confidence → 3 points (rounded from 2.5)', () => {
    // ECMAScript guarantees Math.round(2.5) === 3 (round-half-up, NOT
    // banker's rounding). 0.05 * 0.5 * 100 = 2.5 → 3. Pin for clarity.
    assert.equal(cannotVerifyBoost(0.5), 3);
  });

  it('cannot_verify: 1.0 confidence → 5 points (the absolute ceiling per finding)', () => {
    assert.equal(cannotVerifyBoost(1.0), 5);
  });
});

describe('B4 score boost — stacking semantics', () => {
  it('multiple boosts accumulate additively via repeated UPDATE calls', async () => {
    await orch._applyB4ScoreBoostForTests(SESSION_ID, 12);
    await orch._applyB4ScoreBoostForTests(SESSION_ID, 8);
    await orch._applyB4ScoreBoostForTests(SESSION_ID, 5);
    const updates = queryLog.filter((c) => /UPDATE call_sessions/i.test(c.text));
    assert.equal(updates.length, 3);
    // Each UPDATE's $2 param is the delta. The LEAST(100, ...) cap
    // is enforced by Postgres at write time. We can't observe the
    // running total from the fake here; the SQL test below in
    // v3DemoFlow.e2e.ts asserts the actual accumulated value.
    assert.equal((updates[0]!.params)[1], 12);
    assert.equal((updates[1]!.params)[1], 8);
    assert.equal((updates[2]!.params)[1], 5);
  });

  it('updated_at = NOW() is part of the UPDATE so subsequent route reads see fresh updated_at', async () => {
    await orch._applyB4ScoreBoostForTests(SESSION_ID, 10);
    const call = queryLog.find((c) => /UPDATE call_sessions/i.test(c.text))!;
    assert.match(call.text, /updated_at\s*=\s*NOW\(\)/i);
  });
});

describe('B4 score boost — dispatchFinding branch coverage (F1 follow-up)', () => {
  // Pin which branch of dispatchFinding fires for each (result,
  // confidence) combination. Without this, a regression that swaps
  // the two weight constants, drops the `if (boost > 0)` guard, or
  // calls applyB4ScoreBoost on the `consistent` path would ship green.

  const baseEvent = {
    session_id: SESSION_ID,
    user_id: '00000000-0000-0000-0000-00000000aaaa',
    speaker: 'caller' as const,
    text: 'this is the IRS',
    confidence: 0.9,
    spoken_at: new Date(),
  };
  const baseClaim = {
    type: 'agency_affiliation' as const,
    raw_quote: 'this is the IRS',
    spoken_at: new Date().toISOString(),
    agency_name: 'IRS',
  };

  it('consistent result → NO boost UPDATE (security rule: never validate scammer)', async () => {
    await orch._dispatchFindingForTests(
      baseEvent,
      baseClaim,
      {
        result: 'consistent',
        confidence: 0.99,
        reasoning: 'IRS confirmed',
        source_layer: 'curated',
        source_url: null,
        source_snippet: null,
        source_curated_entry_id: null,
      },
      'finding-id-1',
    );
    const updates = queryLog.filter((c) => /b4_score_boost/i.test(c.text));
    assert.equal(updates.length, 0, 'consistent must not touch b4_score_boost');
  });

  it('cannot_verify with non-zero confidence → boost UPDATE with CANNOT_VERIFY weight', async () => {
    await orch._dispatchFindingForTests(
      baseEvent,
      baseClaim,
      {
        result: 'cannot_verify',
        confidence: 0.8,
        reasoning: 'no curated entry; L2 disabled',
        source_layer: 'curated',
        source_url: null,
        source_snippet: null,
        source_curated_entry_id: null,
      },
      'finding-id-2',
    );
    const updates = queryLog.filter((c) => /b4_score_boost/i.test(c.text));
    assert.equal(updates.length, 1);
    // 0.05 * 0.8 * 100 = 4
    assert.equal(updates[0]!.params[1], 4);
  });

  it('cannot_verify with confidence=0 → NO boost UPDATE (boost > 0 guard)', async () => {
    await orch._dispatchFindingForTests(
      baseEvent,
      baseClaim,
      {
        result: 'cannot_verify',
        confidence: 0,
        reasoning: 'L2 unavailable',
        source_layer: 'curated',
        source_url: null,
        source_snippet: null,
        source_curated_entry_id: null,
      },
      'finding-id-3',
    );
    const updates = queryLog.filter((c) => /b4_score_boost/i.test(c.text));
    assert.equal(updates.length, 0, 'confidence=0 produces 0 boost; guard must skip the UPDATE');
  });

  it('contradicted with confidence below threshold (0.7) → boost UPDATE with LOW_CONF weight', async () => {
    await orch._dispatchFindingForTests(
      baseEvent,
      baseClaim,
      {
        result: 'contradicted',
        confidence: 0.7,
        reasoning: 'agency does not match',
        source_layer: 'curated',
        source_url: null,
        source_snippet: null,
        source_curated_entry_id: null,
      },
      'finding-id-4',
    );
    const updates = queryLog.filter((c) => /b4_score_boost/i.test(c.text));
    assert.equal(updates.length, 1);
    // 0.15 * 0.7 * 100 = 10.5 → round → 11
    assert.equal(updates[0]!.params[1], 11);
  });

  it('contradicted with confidence above threshold (0.97) → NO boost (takeover path instead)', async () => {
    // The takeover path runs UPDATE call_sessions for b3_takeover_fired_at
    // (different column), but should NOT call applyB4ScoreBoost.
    await orch._dispatchFindingForTests(
      baseEvent,
      baseClaim,
      {
        result: 'contradicted',
        confidence: 0.97,
        reasoning: 'IRS does not cold-call',
        source_layer: 'curated',
        source_url: null,
        source_snippet: null,
        source_curated_entry_id: null,
      },
      'finding-id-5',
    );
    const boostUpdates = queryLog.filter((c) => /b4_score_boost/i.test(c.text));
    assert.equal(boostUpdates.length, 0, 'above-threshold contradicted fires takeover, not boost');
  });
});

describe('B4 score boost — bounds', () => {
  it('zero-confidence finding produces zero boost (no UPDATE in the production path)', () => {
    // The orchestrator's `if (boost > 0)` guard means a finding
    // with confidence so low that the rounded boost is 0 doesn't
    // touch the DB. Pin the math: 0 confidence → 0 boost for both
    // weight branches.
    const lowConfWeight = config.V3_B4_SCORE_BOOST_LOW_CONF_WEIGHT;
    const cannotVerifyWeight = config.V3_B4_SCORE_BOOST_CANNOT_VERIFY_WEIGHT;
    assert.equal(Math.round(lowConfWeight * 0 * 100), 0);
    assert.equal(Math.round(cannotVerifyWeight * 0 * 100), 0);
  });

  it('SQL LEAST(100, ...) is in the UPDATE so a runaway boost cannot exceed the column CHECK', async () => {
    await orch._applyB4ScoreBoostForTests(SESSION_ID, 999);
    const call = queryLog.find((c) => /UPDATE call_sessions/i.test(c.text))!;
    // The cap is enforced by SQL; the migration's CHECK (b4_score_boost
    // BETWEEN 0 AND 100) plus the LEAST() in the UPDATE form a
    // belt-and-suspenders defense. Even if the orchestrator hands us
    // 999, the actual stored value will be 100. Pin the SQL pattern.
    assert.match(call.text, /LEAST\(100/);
  });
});
