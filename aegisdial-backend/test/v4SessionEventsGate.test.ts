import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 1 — flag-gate regression test for the
// v3SessionEvents hub.
//
// notifyTranscriptChunk gates the dispatch loop on:
//   V3_A1_ENABLED || V3_B3_ENABLED || V3_B4_ENABLED || V4_PLAYBOOK_AWARE_ENABLED
//
// The V4 clause was added in Phase 1 so a v4-only cohort (all V3
// features OFF, V4 ON) still receives caller chunks via the playbook
// subscriber. A future cleanup that "tidies" the gate could silently
// drop the V4 clause and break v4-only rollouts — this test pins
// the contract so that regression is caught at CI.
//
// Setup contract: env must be set BEFORE importing config (zod
// parses on module load). Each test file owns its own env preamble.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-gate';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-gate-test';

// CRITICAL: v3 features OFF, v4 ON — this is the v4-only-cohort
// shape we're pinning.
process.env.V3_A1_ENABLED = 'false';
process.env.V3_B3_ENABLED = 'false';
process.env.V3_B4_ENABLED = 'false';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';

const hub = await import('../src/services/v3SessionEvents.ts');

const SESSION = '00000000-0000-0000-0000-000000005555';
const USER = '00000000-0000-0000-0000-00000000bbbb';

beforeEach(() => {
  hub._resetForTests();
});

describe('v3SessionEvents — V4_PLAYBOOK_AWARE_ENABLED gate clause', () => {
  it('dispatches caller chunks when only V4 is enabled (v4-only cohort)', async () => {
    // Regression pin for Phase 1: if someone removes the
    // `|| V4_PLAYBOOK_AWARE_ENABLED` clause from notifyTranscriptChunk,
    // this counter will stay at 0 and the test will fail.
    let received = 0;
    const unsub = hub.subscribeTranscript(() => {
      received++;
    });

    try {
      await hub.notifyTranscriptChunk({
        session_id: SESSION,
        user_id: USER,
        speaker: 'caller',
        text: 'hello this is the IRS',
        confidence: 0.9,
        spoken_at: new Date(),
      });

      assert.equal(
        received,
        1,
        'v4-only cohort must still receive chunks via the hub — V4 clause in gate is the contract',
      );
    } finally {
      unsub();
    }
  });

  it('dispatches even when speaker is self — gate is speaker-agnostic at hub layer', async () => {
    // Subscriber-side filtering for speaker is intentional (playbook
    // subscriber drops 'self' chunks). The hub itself must fan out
    // every chunk so other v4.x subscribers can opt in to Mom-side.
    let received = 0;
    const unsub = hub.subscribeTranscript(() => {
      received++;
    });

    try {
      await hub.notifyTranscriptChunk({
        session_id: SESSION,
        user_id: USER,
        speaker: 'self',
        text: 'sorry can you repeat that',
        confidence: 0.9,
        spoken_at: new Date(),
      });

      assert.equal(received, 1);
    } finally {
      unsub();
    }
  });
});
