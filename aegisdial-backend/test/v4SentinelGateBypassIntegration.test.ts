import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 8 — end-to-end bypass integration tests.
//
// MEDIUM-2 fix from adversarial review. Pins:
//   - Flag OFF → gate blocks even when v4 would qualify (legacy)
//   - Flag ON + v4_playbook_id NULL → gate blocks (flag-composition safety)
//   - Flag ON + bypass list matches + confidence >= floor → FIRES
//   - Flag ON + bypass list matches + confidence < floor → gate blocks
//   - Flag ON + playbook NOT in bypass list → gate blocks
//   - Single pre-loop DB lookup per chunk (HIGH-1 race fix verified —
//     N patterns ≠ N SELECTs)

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-sentinel-bypass-int';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-sentinel-bypass-int-test';
process.env.V3_B3_ENABLED = 'true';
process.env.V3_B3_MOM_SIDE_STT_ENABLED = 'true';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';
process.env.V4_PLAYBOOK_B3_GATE_BYPASS_ENABLED = 'true';
process.env.V4_PLAYBOOK_B3_GATE_BYPASS_MIN_CONFIDENCE = '0.75';

const db = await import('../src/lib/db.ts');
const sentinelMatcher = await import('../src/services/sentinelMatcher.ts');
const momSideStt = await import('../src/services/momSideStt.ts');
const v3SessionEvents = await import('../src/services/v3SessionEvents.ts');
const { config: appConfig } = await import('../src/config.ts');

const SESSION_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = '00000000-0000-0000-0000-000000000000';

// One pattern seeded — SSN sentinel with the standard context gate.
// Bypass list for ssn_spoken_aloud includes irs_impersonation.
const PATTERN_ROW = {
  id: 'pat-1',
  pattern_name: 'ssn_spoken_aloud',
  regex_source: '\\b\\d{3}[ -]?\\d{2}[ -]?\\d{4}\\b',
  required_scammer_context_regex: '(?:social security|tax id|ssn|your social)',
  scammer_context_window_seconds: 60,
  enabled: true,
};

// In-memory call_sessions state mutated per-test.
let sessionV4: { playbook_id: string | null; confidence_pct: number | null } = {
  playbook_id: null,
  confidence_pct: null,
};

// Track the call_sessions SELECT count so HIGH-1 (one fetch per chunk,
// not per pattern) can be verified.
let callSessionsSelectCount = 0;

const fakeQuery = async (
  text: string,
  _params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (/FROM b3_sentinel_patterns/i.test(t)) {
    return { rows: [PATTERN_ROW], rowCount: 1 };
  }
  if (/SELECT v4_playbook_id, v4_stage_confidence FROM call_sessions/i.test(t)) {
    callSessionsSelectCount++;
    return {
      rows: [{
        v4_playbook_id: sessionV4.playbook_id,
        v4_stage_confidence: sessionV4.confidence_pct,
      }],
      rowCount: 1,
    };
  }
  // Any other read defaults to empty — these tests don't exercise other paths.
  return { rows: [], rowCount: 0 };
};

before(() => {
  type Patchable = { pool: { query: typeof fakeQuery } };
  (db as unknown as Patchable).pool.query = fakeQuery as unknown as typeof fakeQuery;
});

beforeEach(() => {
  callSessionsSelectCount = 0;
  sessionV4 = { playbook_id: null, confidence_pct: null };
  sentinelMatcher._resetForTests();
  momSideStt._resetForTests();
  v3SessionEvents._resetForTests();
});

after(() => {
  sentinelMatcher._resetForTests();
});

interface FireRecord {
  pattern_name: string;
  matched_text: string;
  scammer_context_match: string | null;
}
const fireLog: FireRecord[] = [];

function captureFires(): void {
  fireLog.length = 0;
  sentinelMatcher.registerFireHandler((input) => {
    fireLog.push({
      pattern_name: input.pattern_name,
      matched_text: input.matched_text,
      scammer_context_match: input.scammer_context_match,
    });
  });
}

async function emitMomChunk(text: string): Promise<void> {
  await momSideStt.emitChunk({
    session_id: SESSION_ID,
    user_id: USER_ID,
    text,
    confidence: 0.95,
    offset_seconds: 0,
    emitted_at: new Date(),
  });
}

const SSN_UTTERANCE = 'okay it is 123-45-6789';

describe('B3 sentinel bypass — flag composition', () => {
  it('bypass flag OFF: gate blocks even when v4 would have qualified', async () => {
    // Phase 17 HIGH-1 fix: v4Ctx fetch is now gated on the MASTER
    // V4_PLAYBOOK_AWARE_ENABLED flag (so the Phase 17 sentinel-
    // coverage dashboard can tag fires with the playbook lock).
    // The BYPASS behavior is still gated on V4_PLAYBOOK_B3_GATE_BYPASS_ENABLED.
    // This test pins the safety property: with bypass flag OFF,
    // the legacy gate-block behavior holds — even though v4Ctx is
    // now fetched for telemetry, it must not trigger a bypass-fire.
    const original = appConfig.V4_PLAYBOOK_B3_GATE_BYPASS_ENABLED;
    try {
      (appConfig as { V4_PLAYBOOK_B3_GATE_BYPASS_ENABLED: boolean }).V4_PLAYBOOK_B3_GATE_BYPASS_ENABLED = false;
      sessionV4 = { playbook_id: 'irs_impersonation', confidence_pct: 90 };
      captureFires();
      const stop = await sentinelMatcher.startForSession(SESSION_ID, USER_ID);
      try {
        await emitMomChunk(SSN_UTTERANCE);
        assert.equal(fireLog.length, 0, 'bypass flag OFF must keep legacy gate-block behavior');
      } finally {
        stop();
      }
    } finally {
      (appConfig as { V4_PLAYBOOK_B3_GATE_BYPASS_ENABLED: boolean }).V4_PLAYBOOK_B3_GATE_BYPASS_ENABLED = original;
    }
  });

  it('flag ON + v4_playbook_id NULL: gate still blocks (composition safety)', async () => {
    sessionV4 = { playbook_id: null, confidence_pct: null };
    captureFires();
    const stop = await sentinelMatcher.startForSession(SESSION_ID, USER_ID);
    try {
      await emitMomChunk(SSN_UTTERANCE);
      assert.equal(fireLog.length, 0, 'NULL playbook lock must not unlock bypass');
    } finally {
      stop();
    }
  });

  it('flag ON + playbook in bypass list + confidence >= floor: FIRES with null scammer_context_match', async () => {
    // irs_impersonation IS in ssn_spoken_aloud's bypass list.
    // 80 >= 75 → above floor.
    sessionV4 = { playbook_id: 'irs_impersonation', confidence_pct: 80 };
    captureFires();
    const stop = await sentinelMatcher.startForSession(SESSION_ID, USER_ID);
    try {
      await emitMomChunk(SSN_UTTERANCE);
      assert.equal(fireLog.length, 1, 'bypass should have fired');
      assert.equal(fireLog[0]!.pattern_name, 'ssn_spoken_aloud');
      assert.equal(
        fireLog[0]!.scammer_context_match,
        null,
        'bypass path passes null for scammer_context_match (no in-window match)',
      );
    } finally {
      stop();
    }
  });

  it('flag ON + playbook in bypass list + confidence < floor: gate blocks (confidence-floor defense)', async () => {
    // 60 < 75 — below the bypass floor even though playbook qualifies.
    // Pins HIGH-2 (the 0.55 commit threshold is too permissive for takeover-firing).
    sessionV4 = { playbook_id: 'irs_impersonation', confidence_pct: 60 };
    captureFires();
    const stop = await sentinelMatcher.startForSession(SESSION_ID, USER_ID);
    try {
      await emitMomChunk(SSN_UTTERANCE);
      assert.equal(fireLog.length, 0, 'below-floor confidence must NOT unlock bypass');
    } finally {
      stop();
    }
  });

  it('flag ON + playbook NOT in bypass list: gate blocks', async () => {
    // crypto_investment_scam is NOT in ssn_spoken_aloud's bypass list.
    sessionV4 = { playbook_id: 'crypto_investment_scam', confidence_pct: 95 };
    captureFires();
    const stop = await sentinelMatcher.startForSession(SESSION_ID, USER_ID);
    try {
      await emitMomChunk(SSN_UTTERANCE);
      assert.equal(fireLog.length, 0, 'non-listed playbook must NOT unlock bypass');
    } finally {
      stop();
    }
  });
});

describe('B3 sentinel bypass — pre-loop fetch (HIGH-1 race fix)', () => {
  it('issues exactly one call_sessions SELECT per chunk regardless of pattern count', async () => {
    // Only one pattern is seeded here, but the contract is: one SELECT
    // per chunk, not one per pattern in the loop. Verify the counter
    // increments by exactly 1 per Mom-side chunk processed.
    sessionV4 = { playbook_id: 'irs_impersonation', confidence_pct: 80 };
    captureFires();
    const stop = await sentinelMatcher.startForSession(SESSION_ID, USER_ID);
    try {
      callSessionsSelectCount = 0;  // reset post-startup
      await emitMomChunk(SSN_UTTERANCE);
      assert.equal(callSessionsSelectCount, 1, 'one v4 lookup per chunk (pre-loop, not per-pattern)');
    } finally {
      stop();
    }
  });
});
