import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 1 — playbook subscriber tests.
//
// Pins the subscriber's per-session state contract:
//   - First caller chunk creates a SessionContext with current=null/null
//   - Rolling-text buffer prunes entries older than 60s
//   - 'self' chunks are ignored (playbook is a property of caller side)
//   - endSession drops the per-session entry
//   - In-memory current-state cache updates after a commit (the
//     classifier's classifyAndCommit return drives the cache write)
//
// The classifier itself is mocked at the subscriber boundary — these
// tests verify the SUBSCRIBER's behavior, not Anthropic-API correctness
// (Phase 0 prompt-grounding tests cover that).

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-subscriber';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-subscriber-test';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';
process.env.V4_PLAYBOOK_STAGE_TIMING_TELEMETRY_ENABLED ||= 'true';

const sub = await import('../src/services/playbookSubscriber.ts');
const hub = await import('../src/services/v3SessionEvents.ts');
const db = await import('../src/lib/db.ts');
const { config: appConfig } = await import('../src/config.ts');

const SESSION = '00000000-0000-0000-0000-000000004444';
const USER = '00000000-0000-0000-0000-00000000aaaa';

function callerChunk(text: string, ageSec = 0): {
  session_id: string;
  user_id: string;
  speaker: 'caller';
  text: string;
  confidence: number | null;
  spoken_at: Date;
} {
  return {
    session_id: SESSION,
    user_id: USER,
    speaker: 'caller',
    text,
    confidence: 0.9,
    spoken_at: new Date(Date.now() - ageSec * 1000),
  };
}

beforeEach(() => {
  sub._resetForTests();
  hub._resetForTests();
});

describe('playbookSubscriber — session-context lifecycle', () => {
  it('creates a session context lazily on first caller chunk', async () => {
    assert.equal(sub._getSessionContextForTests(SESSION), null);
    await sub._handleCallerChunkForTests(callerChunk('this is the IRS calling'));
    const ctx = sub._getSessionContextForTests(SESSION);
    assert.ok(ctx, 'context should exist after first chunk');
    assert.equal(ctx!.rolling_text_count, 1);
    assert.equal(ctx!.current.playbook_id, null, 'cold session has no playbook yet');
    assert.equal(ctx!.current.stage, null);
  });

  it('endSession drops the context (no monotonic Map growth)', async () => {
    await sub._handleCallerChunkForTests(callerChunk('hello'));
    assert.ok(sub._getSessionContextForTests(SESSION));
    sub.endSession(SESSION);
    assert.equal(sub._getSessionContextForTests(SESSION), null);
  });

  it('endSession is idempotent — second call on dropped session is a no-op', () => {
    sub.endSession(SESSION);
    sub.endSession(SESSION);
    assert.equal(sub._getSessionContextForTests(SESSION), null);
  });

  it('rolling-text buffer prunes entries older than 60s', async () => {
    // Seed 3 chunks: one 90s old (should prune), one 30s old (keep), now (keep).
    await sub._handleCallerChunkForTests(callerChunk('ancient chunk', 90));
    await sub._handleCallerChunkForTests(callerChunk('recent chunk', 30));
    await sub._handleCallerChunkForTests(callerChunk('current chunk', 0));
    const ctx = sub._getSessionContextForTests(SESSION);
    assert.ok(ctx);
    assert.equal(
      ctx!.rolling_text_count,
      2,
      'the 90s-old chunk must be pruned; recent + current keep',
    );
  });
});

describe('playbookSubscriber — current-state caching', () => {
  it('seeded state survives subsequent calls until a new transition lands', () => {
    sub._seedSessionStateForTests(SESSION, {
      playbook_id: 'irs_impersonation',
      stage: 'fear',
    });
    const ctx = sub._getSessionContextForTests(SESSION);
    assert.ok(ctx);
    assert.equal(ctx!.current.playbook_id, 'irs_impersonation');
    assert.equal(ctx!.current.stage, 'fear');
  });
});

describe('playbookSubscriber — speaker filtering at the subscribe layer', () => {
  // The subscribe() callback in startV4PlaybookSubscriber filters
  // event.speaker !== 'caller'. We can't easily start the subscriber
  // and inject events without a v3SessionEvents harness; we pin the
  // contract by calling the handler directly with a 'caller' chunk
  // (works) and noting that 'self' chunks bypass the handler entirely.
  // The filter lives at src/services/playbookSubscriber.ts L75-L77.
  it('handler accepts caller chunks (filter contract documented)', async () => {
    await sub._handleCallerChunkForTests(callerChunk('a caller utterance'));
    const ctx = sub._getSessionContextForTests(SESSION);
    assert.ok(ctx);
    assert.equal(ctx!.rolling_text_count, 1);
  });
});

describe('playbookSubscriber — start/stop lifecycle', () => {
  it('startV4PlaybookSubscriber is idempotent — second call does NOT double-subscribe', async () => {
    // M5 strengthening: it's not enough to assert no-throw. The
    // contract is exactly-one subscription regardless of how many
    // times start() is called — double-subscription would double-
    // count every chunk and double-bill the classifier prompt.
    //
    // We pin this by counting dispatches through the real hub:
    // start twice, push one chunk, expect rolling_text_count = 1
    // (not 2). The handler updates the in-memory context once per
    // dispatch, so the count is a faithful proxy for handler-fired-N-times.
    sub.startV4PlaybookSubscriber();
    sub.startV4PlaybookSubscriber();

    try {
      await hub.notifyTranscriptChunk(callerChunk('a single utterance'));
      const ctx = sub._getSessionContextForTests(SESSION);
      assert.ok(ctx, 'context must exist after one dispatched chunk');
      assert.equal(
        ctx!.rolling_text_count,
        1,
        'double-start must not double-dispatch — exactly one entry in rolling buffer',
      );
    } finally {
      sub.stopV4PlaybookSubscriber();
    }
  });

  it('stopV4PlaybookSubscriber clears in-memory session contexts', async () => {
    sub.startV4PlaybookSubscriber();
    await sub._handleCallerChunkForTests(callerChunk('hi'));
    assert.ok(sub._getSessionContextForTests(SESSION));
    sub.stopV4PlaybookSubscriber();
    assert.equal(sub._getSessionContextForTests(SESSION), null);
  });
});

describe('playbookSubscriber — observability surface', () => {
  it('_classifierState returns active session count', async () => {
    assert.equal(sub._classifierState().active_sessions, 0);
    await sub._handleCallerChunkForTests(callerChunk('hi'));
    assert.equal(sub._classifierState().active_sessions, 1);
    sub.endSession(SESSION);
    assert.equal(sub._classifierState().active_sessions, 0);
  });
});

// ---------------------------------------------------------------------------
// Live Shield v4 — Phase 10 — stage-timing telemetry wiring tests.
//
// These pin the subscriber's commit-side wiring of evaluateStageTiming.
// The pure-function tests live in v4StageTiming.test.ts; here we
// verify the WIRING in applyCommitToContext:
//   (a) On a transition, the metric is emitted tagged by the PRIOR
//       playbook+stage (not the new ones — the elapsed time is time-
//       spent-in-the-stage-we're-leaving)
//   (b) On committed_initial, NO timing metric (no prior stage)
//   (c) current_since resets to the chunk's spoken_at on every commit
//   (d) Master flag V4_PLAYBOOK_STAGE_TIMING_TELEMETRY_ENABLED gates
//       emission — when OFF, no v4.stage_timing.evaluated emit (state
//       still updates)
//
// MEDIUM-2 adversarial fix from Phase 10 review: without these, the
// wiring guards (current_since presence check, action===transition
// check, master flag check) and the spoken_at-based reset were tested
// only indirectly through the helper. A future refactor of
// handleCallerChunk could silently drop the timing-metric branch and
// the existing tests wouldn't catch it.
// ---------------------------------------------------------------------------

interface MetricEmit {
  name: string;
  tags: Record<string, unknown>;
}

function captureMetricEmissions(): {
  emissions: MetricEmit[];
  restore: () => void;
} {
  const emissions: MetricEmit[] = [];
  const originalQuery = (db.pool as unknown as { query: unknown }).query;
  const fakeQuery = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    // emitMetric INSERTs into metric_counters; intercept that one shape.
    if (/INSERT\s+INTO\s+metric_counters/i.test(text)) {
      const name = params[0] as string;
      let tags: Record<string, unknown> = {};
      try {
        tags = JSON.parse(params[1] as string) as Record<string, unknown>;
      } catch {
        // ignore — defensive
      }
      emissions.push({ name, tags });
    }
    return { rows: [], rowCount: 1 };
  };
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
  return {
    emissions,
    restore: () => {
      (db.pool as unknown as { query: unknown }).query = originalQuery;
    },
  };
}

// emitMetric is fire-and-forget (no await at call sites); give the
// microtask queue a tick to drain before asserting on emissions.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('playbookSubscriber — Phase 10 stage-timing wiring (MEDIUM-2 fix)', () => {
  it('emits v4.stage_timing.evaluated tagged with PRIOR playbook+stage on a committed_transition', async () => {
    const t0 = new Date('2026-05-11T10:00:00Z');
    const t1 = new Date('2026-05-11T10:01:00Z'); // 60s later — in_range for bank_impersonation.fear [30,120]

    sub._seedSessionStateForTests(
      SESSION,
      { playbook_id: 'bank_impersonation', stage: 'fear' },
      t0,
    );

    const cap = captureMetricEmissions();
    try {
      sub._simulateCommitForTests(
        SESSION,
        {
          playbook_id: 'bank_impersonation',
          stage: 'ask',
          confidence: 0.9,
          reasoning: 'test',
          latency_ms: 0,
        },
        t1,
        'committed_transition',
      );
      await flushMicrotasks();

      const timingEmits = cap.emissions.filter((e) => e.name === 'v4.stage_timing.evaluated');
      assert.equal(timingEmits.length, 1, 'exactly one timing emit per transition');
      assert.equal(
        timingEmits[0]!.tags.playbook_id,
        'bank_impersonation',
        'tag is prior playbook (here: same playbook, stage changed)',
      );
      assert.equal(
        timingEmits[0]!.tags.stage,
        'fear',
        'tag is PRIOR stage — the stage we are leaving, not the new one',
      );
      assert.equal(timingEmits[0]!.tags.verdict, 'in_range', '60s is mid-window for fear [30,120]');
    } finally {
      cap.restore();
    }
  });

  it('does NOT emit v4.stage_timing.evaluated on committed_initial (no prior stage)', async () => {
    // Cold session — no prior classification, no current_since set.
    const t1 = new Date('2026-05-11T10:00:00Z');

    const cap = captureMetricEmissions();
    try {
      sub._simulateCommitForTests(
        SESSION,
        {
          playbook_id: 'irs_impersonation',
          stage: 'authority',
          confidence: 0.85,
          reasoning: 'test',
          latency_ms: 0,
        },
        t1,
        'committed_initial',
      );
      await flushMicrotasks();

      const timingEmits = cap.emissions.filter((e) => e.name === 'v4.stage_timing.evaluated');
      assert.equal(
        timingEmits.length,
        0,
        'committed_initial has no prior stage to evaluate — must not emit',
      );

      // Recorded-transition metric should still fire (proves we reached the helper).
      const recordedEmits = cap.emissions.filter(
        (e) => e.name === 'v4.playbook_subscriber.transition_recorded',
      );
      assert.equal(recordedEmits.length, 1, 'transition_recorded fires on initial commit too');
    } finally {
      cap.restore();
    }
  });

  it('resets current_since to the chunk spoken_at on every commit (MEDIUM-1 timing-bias fix)', () => {
    const t0 = new Date('2026-05-11T10:00:00Z');
    const t1 = new Date('2026-05-11T10:00:45Z'); // 45s later — in_range
    const t2 = new Date('2026-05-11T10:02:00Z'); // 75s after t1 — in_range for next eval

    // Initial seed: as if a prior committed_initial happened at t0.
    sub._seedSessionStateForTests(
      SESSION,
      { playbook_id: 'bank_impersonation', stage: 'fear' },
      t0,
    );
    const before = sub._getSessionContextForTests(SESSION);
    assert.ok(before);
    assert.deepEqual(before!.current_since, t0, 'seeded current_since matches t0');

    // First transition: fear -> ask at t1.
    sub._simulateCommitForTests(
      SESSION,
      {
        playbook_id: 'bank_impersonation',
        stage: 'ask',
        confidence: 0.9,
        reasoning: 'test',
        latency_ms: 0,
      },
      t1,
      'committed_transition',
    );
    const afterFirst = sub._getSessionContextForTests(SESSION);
    assert.ok(afterFirst);
    assert.equal(afterFirst!.current.stage, 'ask', 'current stage advanced');
    assert.deepEqual(
      afterFirst!.current_since,
      t1,
      'current_since stamped from chunk spoken_at (NOT Date.now)',
    );

    // Second transition: ask -> close at t2.
    sub._simulateCommitForTests(
      SESSION,
      {
        playbook_id: 'bank_impersonation',
        stage: 'close',
        confidence: 0.9,
        reasoning: 'test',
        latency_ms: 0,
      },
      t2,
      'committed_transition',
    );
    const afterSecond = sub._getSessionContextForTests(SESSION);
    assert.ok(afterSecond);
    assert.equal(afterSecond!.current.stage, 'close');
    assert.deepEqual(
      afterSecond!.current_since,
      t2,
      'current_since reset to t2 — every commit re-stamps',
    );
  });

  it('does NOT emit v4.stage_timing.evaluated when V4_PLAYBOOK_STAGE_TIMING_TELEMETRY_ENABLED is OFF (state still updates)', async () => {
    const t0 = new Date('2026-05-11T10:00:00Z');
    const t1 = new Date('2026-05-11T10:01:00Z');

    sub._seedSessionStateForTests(
      SESSION,
      { playbook_id: 'bank_impersonation', stage: 'fear' },
      t0,
    );

    const original = appConfig.V4_PLAYBOOK_STAGE_TIMING_TELEMETRY_ENABLED;
    const cap = captureMetricEmissions();
    try {
      (appConfig as { V4_PLAYBOOK_STAGE_TIMING_TELEMETRY_ENABLED: boolean }).V4_PLAYBOOK_STAGE_TIMING_TELEMETRY_ENABLED = false;
      sub._simulateCommitForTests(
        SESSION,
        {
          playbook_id: 'bank_impersonation',
          stage: 'ask',
          confidence: 0.9,
          reasoning: 'test',
          latency_ms: 0,
        },
        t1,
        'committed_transition',
      );
      await flushMicrotasks();

      const timingEmits = cap.emissions.filter((e) => e.name === 'v4.stage_timing.evaluated');
      assert.equal(
        timingEmits.length,
        0,
        'flag-OFF must silence v4.stage_timing.evaluated entirely',
      );

      // State must still update — the master flag gates the metric, not the state.
      const after = sub._getSessionContextForTests(SESSION);
      assert.ok(after);
      assert.equal(after!.current.stage, 'ask', 'state still advances when telemetry is off');
      assert.deepEqual(after!.current_since, t1, 'current_since still resets when telemetry is off');
    } finally {
      cap.restore();
      (appConfig as { V4_PLAYBOOK_STAGE_TIMING_TELEMETRY_ENABLED: boolean }).V4_PLAYBOOK_STAGE_TIMING_TELEMETRY_ENABLED = original;
    }
  });
});
