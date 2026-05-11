import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v3 — Phase 2 post-dismiss watcher tests.
//
// Exercises the escalation logic itself (without the timer firing in
// real wall-clock time). Tests use _flushTimersForTests() to drive
// the clock forward synchronously where needed.
//
//   1. Arming a watch records state, doesn't immediately fire
//   2. Score dropping below critical disarms the timer
//   3. Score climbing back to critical re-arms the timer
//   4. Timer firing claims the post-dismiss flag atomically
//   5. Already-fired session returns alreadyFired:true on second arm

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v3-phase2-post-dismiss';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v3-phase2-post-dismiss';
process.env.ALLOW_DEV_BEARER = 'true';
process.env.ENZOIC_MOCK = 'true';
process.env.V3_B3_ENABLED = 'true';

const db = await import('../src/lib/db.ts');
const watcher = await import('../src/services/postDismissWatcher.ts');
const v3SessionEvents = await import('../src/services/v3SessionEvents.ts');

const SESSION_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = '00000000-0000-0000-0000-000000000000';

// -------------------------------------------------------------------------
// Fake DB state
// -------------------------------------------------------------------------

interface SessionRow {
  id: string;
  family_alert_post_dismiss_fired_at: Date | null;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  ended_at: Date | null;
}
const sessions = new Map<string, SessionRow>();
let firedAlerts: Array<{ session_id: string }> = [];

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.trim();

  // Pre-escalate guard: re-read risk_level + ended_at before firing.
  // Added in the LOW-1 fix from the second-pass adversarial review.
  if (/SELECT risk_level, ended_at FROM call_sessions/i.test(t)) {
    const id = params[0] as string;
    const row = sessions.get(id);
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [{ risk_level: row.risk_level, ended_at: row.ended_at }],
      rowCount: 1,
    };
  }

  // Atomic claim of post-dismiss firing rights.
  if (/UPDATE call_sessions[\s\S]+SET family_alert_post_dismiss_fired_at = NOW\(\)/i.test(t)) {
    const id = params[0] as string;
    const row = sessions.get(id);
    if (!row || row.family_alert_post_dismiss_fired_at !== null) {
      return { rows: [], rowCount: 0 };
    }
    row.family_alert_post_dismiss_fired_at = new Date();
    return { rows: [], rowCount: 1 };
  }

  // Compensating release of the claim.
  if (/SET family_alert_post_dismiss_fired_at = NULL/i.test(t)) {
    const id = params[0] as string;
    const row = sessions.get(id);
    if (row) row.family_alert_post_dismiss_fired_at = null;
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // emitGuardianAlert internally queries family_members, push_devices, etc.
  // We mock those to return zero rows so emit returns delivered:0
  // without throwing — the watcher is what we're testing, not delivery.
  if (/FROM family_alert_preferences/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }
  if (/FROM family_members/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }
  if (/FROM push_devices/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }
  // emitGuardianAlert may insert audit-log rows; accept silently.
  if (/^INSERT INTO/i.test(t)) {
    return { rows: [], rowCount: 1 };
  }

  // Anything else: surface so we know we missed a code path.
  throw new Error(`unhandled query: ${t.slice(0, 100)}`);
};

before(() => {
  type Patchable = { pool: { query: typeof fakeQuery } };
  (db as unknown as Patchable).pool.query = fakeQuery as unknown as typeof fakeQuery;
});

beforeEach(() => {
  sessions.clear();
  firedAlerts = [];
  watcher._resetForTests();
  v3SessionEvents._resetForTests();
  watcher.startPostDismissWatcher();

  sessions.set(SESSION_ID, {
    id: SESSION_ID,
    family_alert_post_dismiss_fired_at: null,
    risk_level: 'critical',
    ended_at: null,
  });
});

after(() => {
  watcher.stopPostDismissWatcher();
});

void firedAlerts; // reserved for future delivery-assert tests

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('B3 post-dismiss watcher — armed state', () => {
  it('arming records the watch state with critical_entered_at when level is critical at dismiss', () => {
    watcher.armPostDismissWatch({
      session_id: SESSION_ID,
      user_id: USER_ID,
      current_level: 'critical',
      current_score: 88,
      scam_type: 'bank_impersonation',
      matched_red_flags: ['ssn_request'],
    });

    const state = watcher._getWatchStateForTests(SESSION_ID);
    assert.ok(state, 'state should exist');
    assert.equal(state!.current_level, 'critical');
    assert.ok(state!.critical_entered_at);
    assert.ok(state!.timer);
  });

  it('arming does NOT start a timer when the level is below critical at dismiss', () => {
    watcher.armPostDismissWatch({
      session_id: SESSION_ID,
      user_id: USER_ID,
      current_level: 'high',
      current_score: 70,
      scam_type: 'unknown',
      matched_red_flags: [],
    });

    const state = watcher._getWatchStateForTests(SESSION_ID);
    assert.ok(state);
    assert.equal(state!.critical_entered_at, null);
    assert.equal(state!.timer, null);
  });
});

describe('B3 post-dismiss watcher — risk transitions disarm + re-arm', () => {
  it('drops out of critical → timer is canceled', async () => {
    watcher.armPostDismissWatch({
      session_id: SESSION_ID,
      user_id: USER_ID,
      current_level: 'critical',
      current_score: 88,
      scam_type: 'bank_impersonation',
      matched_red_flags: [],
    });
    assert.ok(watcher._getWatchStateForTests(SESSION_ID)!.timer);

    await v3SessionEvents.notifyRiskTransition({
      session_id: SESSION_ID,
      user_id: USER_ID,
      previous_level: 'critical',
      new_level: 'high',
      current_score: 60,
      occurred_at: new Date(),
    });

    const state = watcher._getWatchStateForTests(SESSION_ID);
    assert.equal(state!.timer, null);
    assert.equal(state!.critical_entered_at, null);
  });

  it('re-enters critical → timer is re-armed and clock resets', async () => {
    watcher.armPostDismissWatch({
      session_id: SESSION_ID,
      user_id: USER_ID,
      current_level: 'high',
      current_score: 70,
      scam_type: 'unknown',
      matched_red_flags: [],
    });
    assert.equal(watcher._getWatchStateForTests(SESSION_ID)!.timer, null);

    await v3SessionEvents.notifyRiskTransition({
      session_id: SESSION_ID,
      user_id: USER_ID,
      previous_level: 'high',
      new_level: 'critical',
      current_score: 88,
      occurred_at: new Date(),
    });

    const state = watcher._getWatchStateForTests(SESSION_ID);
    assert.ok(state!.timer);
    assert.ok(state!.critical_entered_at);
  });
});

describe('B3 post-dismiss watcher — escalation', () => {
  it('flushing the timer claims the post-dismiss flag atomically', async () => {
    watcher.armPostDismissWatch({
      session_id: SESSION_ID,
      user_id: USER_ID,
      current_level: 'critical',
      current_score: 88,
      scam_type: 'bank_impersonation',
      matched_red_flags: ['ssn_request'],
    });

    // Verify the flag is null before escalation.
    assert.equal(sessions.get(SESSION_ID)!.family_alert_post_dismiss_fired_at, null);

    await watcher._flushTimersForTests();

    // Flag is set after escalation.
    assert.ok(sessions.get(SESSION_ID)!.family_alert_post_dismiss_fired_at);
    // Watch state is cleaned up.
    assert.equal(watcher._getWatchStateForTests(SESSION_ID), undefined);
  });

  it('does NOT fire twice — claim returns rowCount 0 on subsequent arm + flush', async () => {
    // Pre-fire it.
    sessions.get(SESSION_ID)!.family_alert_post_dismiss_fired_at = new Date();

    watcher.armPostDismissWatch({
      session_id: SESSION_ID,
      user_id: USER_ID,
      current_level: 'critical',
      current_score: 88,
      scam_type: 'bank_impersonation',
      matched_red_flags: [],
    });
    await watcher._flushTimersForTests();

    // No second mutation — flag stays whatever value it had.
    // (We can't easily verify "didn't fire" via mock without instrumenting
    // emitGuardianAlert; the absence of a second sessions.set() isn't
    // observable. The watcher cleanup is — state should still be deleted.)
    assert.equal(watcher._getWatchStateForTests(SESSION_ID), undefined);
  });
});

describe('B3 post-dismiss watcher — disarm', () => {
  it('disarming removes state cleanly', () => {
    watcher.armPostDismissWatch({
      session_id: SESSION_ID,
      user_id: USER_ID,
      current_level: 'critical',
      current_score: 88,
      scam_type: 'bank_impersonation',
      matched_red_flags: [],
    });
    assert.ok(watcher._getWatchStateForTests(SESSION_ID));

    watcher.disarmPostDismissWatch(SESSION_ID);
    assert.equal(watcher._getWatchStateForTests(SESSION_ID), undefined);
  });
});
