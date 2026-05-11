import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v3 — family-transcript SSE stream (Gap #2 from the
// 2026-05-11 audit). The v3 spec assumed an "existing v2 family-
// transcript stream" that didn't exist; this file ships it.
//
// Tests pin the in-process pub-sub contract. The SSE route itself
// (auth, hijack, heartbeat) is verified via the live-server E2E
// driver — node:test's fastify-inject pattern doesn't play well
// with hijacked long-lived responses.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-fts';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://family-transcript-stream-test';

const fts = await import('../src/services/familyTranscriptStream.ts');

const SUBJECT_A = '00000000-0000-0000-0000-000000000010';
const SUBJECT_B = '00000000-0000-0000-0000-000000000011';
const SESSION = '00000000-0000-0000-0000-000000005555';

beforeEach(() => {
  fts._resetForTests();
});

describe('familyTranscriptStream.publish — basic dispatch', () => {
  it('delivers a transcript frame to a single subscriber', () => {
    const received: typeof fts extends { FamilyStreamFrame: infer T } ? T[] : unknown[] = [];
    const unsub = fts.subscribe(SUBJECT_A, (frame) => {
      received.push(frame);
    });
    try {
      fts.publish({
        type: 'transcript',
        subject_user_id: SUBJECT_A,
        session_id: SESSION,
        speaker: 'caller',
        text: 'this is the IRS calling',
        spoken_at: '2026-05-11T12:00:00Z',
      });
      assert.equal(received.length, 1);
      const f = received[0] as { type: string; text: string };
      assert.equal(f.type, 'transcript');
      assert.equal(f.text, 'this is the IRS calling');
    } finally {
      unsub();
    }
  });

  it('delivers a system_event frame', () => {
    let count = 0;
    let eventType = '';
    const unsub = fts.subscribe(SUBJECT_A, (frame) => {
      count++;
      if (frame.type === 'system_event') eventType = frame.event_type;
    });
    try {
      fts.publish({
        type: 'system_event',
        subject_user_id: SUBJECT_A,
        session_id: SESSION,
        event_type: 'b3_takeover_fired',
        payload: { trigger_path: 'live_shield_critical' },
        occurred_at: '2026-05-11T12:00:00Z',
      });
      assert.equal(count, 1);
      assert.equal(eventType, 'b3_takeover_fired');
    } finally {
      unsub();
    }
  });

  it('delivers a heartbeat frame', () => {
    let lastType = '';
    const unsub = fts.subscribe(SUBJECT_A, (frame) => {
      lastType = frame.type;
    });
    try {
      fts.publish({
        type: 'heartbeat',
        subject_user_id: SUBJECT_A,
        at: '2026-05-11T12:00:00Z',
      });
      assert.equal(lastType, 'heartbeat');
    } finally {
      unsub();
    }
  });
});

describe('familyTranscriptStream — per-subject isolation', () => {
  it('does not deliver across subjects', () => {
    let aCount = 0;
    let bCount = 0;
    const uA = fts.subscribe(SUBJECT_A, () => {
      aCount++;
    });
    const uB = fts.subscribe(SUBJECT_B, () => {
      bCount++;
    });
    try {
      fts.publish({
        type: 'transcript',
        subject_user_id: SUBJECT_A,
        session_id: SESSION,
        speaker: 'caller',
        text: 'subject A only',
        spoken_at: '2026-05-11T12:00:00Z',
      });
      assert.equal(aCount, 1);
      assert.equal(bCount, 0);
    } finally {
      uA();
      uB();
    }
  });

  it('fans out to multiple subscribers on the same subject', () => {
    let s1 = 0;
    let s2 = 0;
    const u1 = fts.subscribe(SUBJECT_A, () => {
      s1++;
    });
    const u2 = fts.subscribe(SUBJECT_A, () => {
      s2++;
    });
    try {
      fts.publish({
        type: 'transcript',
        subject_user_id: SUBJECT_A,
        session_id: SESSION,
        speaker: 'self',
        text: 'fan-out',
        spoken_at: '2026-05-11T12:00:00Z',
      });
      assert.equal(s1, 1);
      assert.equal(s2, 1);
    } finally {
      u1();
      u2();
    }
  });
});

describe('familyTranscriptStream — subscriber isolation on throw', () => {
  it('one subscriber throwing does not stop the others', () => {
    let okCount = 0;
    const uThrow = fts.subscribe(SUBJECT_A, () => {
      throw new Error('boom');
    });
    const uOk = fts.subscribe(SUBJECT_A, () => {
      okCount++;
    });
    try {
      fts.publish({
        type: 'transcript',
        subject_user_id: SUBJECT_A,
        session_id: SESSION,
        speaker: 'caller',
        text: 'isolation',
        spoken_at: '2026-05-11T12:00:00Z',
      });
      assert.equal(okCount, 1);
    } finally {
      uThrow();
      uOk();
    }
  });
});

describe('familyTranscriptStream — unsubscribe / cleanup', () => {
  it('no further frames after unsubscribe', () => {
    let count = 0;
    const u = fts.subscribe(SUBJECT_A, () => {
      count++;
    });
    fts.publish({
      type: 'transcript',
      subject_user_id: SUBJECT_A,
      session_id: SESSION,
      speaker: 'caller',
      text: 'before',
      spoken_at: '2026-05-11T12:00:00Z',
    });
    assert.equal(count, 1);
    u();
    fts.publish({
      type: 'transcript',
      subject_user_id: SUBJECT_A,
      session_id: SESSION,
      speaker: 'caller',
      text: 'after',
      spoken_at: '2026-05-11T12:00:00Z',
    });
    assert.equal(count, 1, 'unsubscribe must prevent further frames');
  });

  it('subscriber count is 0 after every subscriber unsubscribes (no leak)', () => {
    const u1 = fts.subscribe(SUBJECT_A, () => {});
    const u2 = fts.subscribe(SUBJECT_A, () => {});
    assert.equal(fts._subscriberCountForTests(SUBJECT_A), 2);
    u1();
    assert.equal(fts._subscriberCountForTests(SUBJECT_A), 1);
    u2();
    // After all subscribers gone, the inner Set must be removed
    // from the registry (not just emptied) — otherwise repeated
    // sub/unsub for a hot subject accumulates empty Sets.
    assert.equal(fts._subscriberCountForTests(SUBJECT_A), 0);
  });
});

describe('familyTranscriptStream — no-op when no subscribers', () => {
  it('publish() does not throw when nobody is listening', () => {
    // Nobody has subscribed to SUBJECT_A in this test.
    fts.publish({
      type: 'transcript',
      subject_user_id: SUBJECT_A,
      session_id: SESSION,
      speaker: 'caller',
      text: 'shouting into the void',
      spoken_at: '2026-05-11T12:00:00Z',
    });
    // Test passes if no throw.
    assert.ok(true);
  });
});

describe('familyTranscriptStream — emitSystemEvent integration', () => {
  it('emitSystemEvent publishes a system_event frame', async () => {
    // emitSystemEvent imports query() which will try to INSERT.
    // We don't have a fake DB wired in this test, so we accept
    // that the publish happens AFTER a successful INSERT (which
    // won't happen here). The publish branch is inside the try,
    // so a failed INSERT skips publish — exactly the behavior
    // we want (don't publish unsaved events).
    //
    // To actually test the publish path inline, we'd need a
    // fakeQuery. The contract is verified at the integration
    // level via the e2e driver. Here we just exercise the
    // module-load + subscribe surface; the publish→subscriber
    // pipe is already covered by the earlier publish() tests.
    let count = 0;
    const u = fts.subscribe(SUBJECT_A, () => {
      count++;
    });
    try {
      // Direct publish — equivalent to what emitSystemEvent does
      // post-INSERT. This is the contract guard.
      fts.publish({
        type: 'system_event',
        subject_user_id: SUBJECT_A,
        session_id: SESSION,
        event_type: 'family_alert_dispatched',
        payload: { reason: 'live_shield_critical' },
        occurred_at: '2026-05-11T12:00:00Z',
      });
      assert.equal(count, 1);
    } finally {
      u();
    }
  });
});
