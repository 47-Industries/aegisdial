import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v3 — Phase 2 sentinel matcher tests.
//
// Exercises:
//   - Pattern firing on a Mom-side chunk that matches regex
//   - Scammer-side context-gating: same Mom-side text fires only when
//     scammer-side context matches the gate
//   - Per-(session, pattern) dedup: same pattern doesn't fire twice
//   - Low-confidence chunks are skipped (false-positive guard)

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v3-phase2-sentinel';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v3-phase2-sentinel';
process.env.ALLOW_DEV_BEARER = 'true';
process.env.ENZOIC_MOCK = 'true';
process.env.V3_B3_ENABLED = 'true';
// Make sure the Mom-side STT pipeline is on; the matcher checks this flag.
process.env.V3_B3_MOM_SIDE_STT_ENABLED = 'true';

const db = await import('../src/lib/db.ts');
const sentinelMatcher = await import('../src/services/sentinelMatcher.ts');
const momSideStt = await import('../src/services/momSideStt.ts');
const v3SessionEvents = await import('../src/services/v3SessionEvents.ts');

const SESSION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID = '00000000-0000-0000-0000-000000000000';

// -------------------------------------------------------------------------
// Fake DB: the only query the matcher runs is loading patterns at session start.
// -------------------------------------------------------------------------

interface PatternRow {
  id: string;
  pattern_name: string;
  regex_source: string;
  required_scammer_context_regex: string | null;
  scammer_context_window_seconds: number;
  enabled: boolean;
}

let patterns: PatternRow[] = [];

const fakeQuery = async (
  text: string,
  _params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.trim();
  if (/FROM b3_sentinel_patterns/i.test(t)) {
    return { rows: patterns.filter((p) => p.enabled), rowCount: patterns.length };
  }
  throw new Error(`unhandled query: ${t.slice(0, 80)}`);
};

before(() => {
  type Patchable = { pool: { query: typeof fakeQuery } };
  (db as unknown as Patchable).pool.query = fakeQuery as unknown as typeof fakeQuery;
});

beforeEach(() => {
  patterns = [];
  sentinelMatcher._resetForTests();
  momSideStt._resetForTests();
  v3SessionEvents._resetForTests();
});

after(() => {
  sentinelMatcher._resetForTests();
});

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

interface FireRecord {
  pattern_name: string;
  matched_text: string;
  scammer_context_match: string | null;
}
const fireLog: FireRecord[] = [];

function setupCapturingFireHandler(): void {
  fireLog.length = 0;
  sentinelMatcher.registerFireHandler((input) => {
    fireLog.push({
      pattern_name: input.pattern_name,
      matched_text: input.matched_text,
      scammer_context_match: input.scammer_context_match,
    });
  });
}

async function emitMomChunk(text: string, opts: { confidence?: number } = {}): Promise<void> {
  await momSideStt.emitChunk({
    session_id: SESSION_ID,
    user_id: USER_ID,
    text,
    confidence: opts.confidence ?? 0.95,
    offset_seconds: 0,
    emitted_at: new Date(),
  });
}

async function emitScammerChunk(text: string): Promise<void> {
  await v3SessionEvents.notifyTranscriptChunk({
    session_id: SESSION_ID,
    user_id: USER_ID,
    speaker: 'caller',
    text,
    confidence: 0.95,
    spoken_at: new Date(),
  });
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('B3 sentinel matcher — ungated patterns', () => {
  it('fires on a voluntary-disclosure phrase (no context gate)', async () => {
    patterns = [{
      id: 'p1',
      pattern_name: 'voluntary_card_phrase',
      regex_source: '(my card number is|the card number is)',
      required_scammer_context_regex: null,
      scammer_context_window_seconds: 0,
      enabled: true,
    }];
    setupCapturingFireHandler();

    const stop = await sentinelMatcher.startForSession(SESSION_ID, USER_ID);
    await emitMomChunk('OK my card number is 4111 1111 1111 1111');

    assert.equal(fireLog.length, 1);
    assert.equal(fireLog[0]!.pattern_name, 'voluntary_card_phrase');
    stop();
  });

  it('does NOT fire twice for the same pattern in the same session', async () => {
    patterns = [{
      id: 'p1',
      pattern_name: 'voluntary_card_phrase',
      regex_source: '(my card number is)',
      required_scammer_context_regex: null,
      scammer_context_window_seconds: 0,
      enabled: true,
    }];
    setupCapturingFireHandler();

    const stop = await sentinelMatcher.startForSession(SESSION_ID, USER_ID);
    await emitMomChunk('my card number is 4111');
    await emitMomChunk('my card number is 4111 again');

    assert.equal(fireLog.length, 1);
    stop();
  });
});

describe('B3 sentinel matcher — context-gated patterns', () => {
  it('does NOT fire when Mom matches but scammer context is absent', async () => {
    patterns = [{
      id: 'p1',
      pattern_name: 'ssn_spoken_aloud',
      regex_source: '(?:\\d[\\s-]?){9}',
      required_scammer_context_regex: '(social security|ssn)',
      scammer_context_window_seconds: 60,
      enabled: true,
    }];
    setupCapturingFireHandler();

    const stop = await sentinelMatcher.startForSession(SESSION_ID, USER_ID);
    // No scammer context published — Mom reading 9 digits should NOT fire.
    await emitMomChunk('the tracking number is 1 2 3 4 5 6 7 8 9');
    assert.equal(fireLog.length, 0);
    stop();
  });

  it('FIRES when scammer mentioned the gate phrase before Mom said the digits', async () => {
    patterns = [{
      id: 'p1',
      pattern_name: 'ssn_spoken_aloud',
      regex_source: '(?:\\d[\\s-]?){9}',
      required_scammer_context_regex: '(social security|ssn)',
      scammer_context_window_seconds: 60,
      enabled: true,
    }];
    setupCapturingFireHandler();

    const stop = await sentinelMatcher.startForSession(SESSION_ID, USER_ID);
    await emitScammerChunk('I need to verify your social security number please');
    await emitMomChunk('123 45 6789');

    assert.equal(fireLog.length, 1);
    assert.equal(fireLog[0]!.pattern_name, 'ssn_spoken_aloud');
    assert.match(fireLog[0]!.scammer_context_match!, /social security/i);
    stop();
  });
});

describe('B3 sentinel matcher — confidence gate', () => {
  it('skips chunks with confidence < 0.6 (misheard guard)', async () => {
    patterns = [{
      id: 'p1',
      pattern_name: 'voluntary_card_phrase',
      regex_source: 'my card number is',
      required_scammer_context_regex: null,
      scammer_context_window_seconds: 0,
      enabled: true,
    }];
    setupCapturingFireHandler();

    const stop = await sentinelMatcher.startForSession(SESSION_ID, USER_ID);
    await emitMomChunk('my card number is 4111', { confidence: 0.4 });
    assert.equal(fireLog.length, 0);

    // Same text at higher confidence DOES fire.
    await emitMomChunk('my card number is 4111', { confidence: 0.9 });
    assert.equal(fireLog.length, 1);
    stop();
  });
});
