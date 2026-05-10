import { config } from '../config.js';
import { query } from '../lib/db.js';
import { emitMetric } from '../lib/observability.js';
import { subscribe, type MomSideTranscriptChunk } from './momSideStt.js';
import { subscribeTranscript, type TranscriptChunkEvent } from './v3SessionEvents.js';

// Live Shield v3 — B3 sentinel matcher (real implementation).
//
// What it does (per spec section "B3 trigger — Path B"):
//
//   1. Subscribes to Mom-side transcript chunks for an active session.
//   2. On each chunk, evaluates the loaded regex pattern set.
//   3. For each match, applies the pattern's optional scammer-side
//      context gate — checking whether scammer-side audio in the
//      last N seconds (default 60) matched a required-context regex.
//   4. If both regex AND context gate pass, fires the B3 takeover
//      callback with trigger_path = 'sentinel_keyword'.
//
// The B3 takeover dispatch itself lives in src/routes/criticalTakeover.ts;
// this service just calls fireTakeoverFn() that the route registers
// at startup.
//
// State per session:
//   - Loaded pattern set (cached at session start, refreshed on
//     manual reload via reloadPatterns()).
//   - Rolling 60-second scammer-side text buffer (used by gates).
//   - Set of pattern_names that already fired in this session
//     (per-session per-pattern dedup — same pattern doesn't
//     fire twice in one call).

export interface SentinelPattern {
  id: string;
  name: string;
  regex: RegExp;
  required_scammer_context_regex: RegExp | null;
  scammer_context_window_seconds: number;
  enabled: boolean;
}

interface ScammerSideEntry {
  text: string;
  spoken_at: Date;
}

interface SessionState {
  patterns: SentinelPattern[];
  scammerBuffer: ScammerSideEntry[];
  firedPatterns: Set<string>;
  unsubscribers: Array<() => void>;
}

/**
 * Sentinel-fire callback shape. The B3 takeover route registers a
 * concrete handler at startup; this module calls it on every match.
 *
 * Decoupled via injection so this module stays testable without a
 * live HTTP stack. Tests register a mock handler.
 */
export type SentinelFireHandler = (input: {
  session_id: string;
  user_id: string;
  pattern_name: string;
  matched_text: string;
  scammer_context_match: string | null;
  spoken_at: Date;
}) => void | Promise<void>;

let fireHandler: SentinelFireHandler | null = null;
const sessionStates = new Map<string, SessionState>();

/**
 * Register the B3 takeover dispatch handler. Called once at app
 * startup from the route file. Replacing an existing handler is
 * supported (most recent wins) — tests use this to swap a mock.
 */
export function registerFireHandler(fn: SentinelFireHandler): void {
  fireHandler = fn;
}

/**
 * Start the sentinel matcher for a session. Subscribes to Mom-side
 * STT (for the matching) AND to the v3 session-events stream (for
 * the scammer-side context buffer).
 *
 * Returns a stop function the session-end handler must call.
 */
export async function startForSession(
  session_id: string,
  user_id: string,
): Promise<() => void> {
  if (!config.V3_B3_ENABLED || !config.V3_B3_MOM_SIDE_STT_ENABLED) {
    return () => {};
  }

  const patterns = await loadPatterns();
  const state: SessionState = {
    patterns,
    scammerBuffer: [],
    firedPatterns: new Set(),
    unsubscribers: [],
  };
  sessionStates.set(session_id, state);

  emitMetric('v3.sentinel_matcher.session_started', {
    patterns_loaded: patterns.length,
  });

  // Subscribe to Mom-side STT chunks for this specific session.
  const momUnsubscribe = subscribe(session_id, (chunk) => evaluateChunk(state, session_id, user_id, chunk));
  state.unsubscribers.push(momUnsubscribe);

  // Subscribe to ALL session events (transcript chunks). We filter
  // to this session_id and to scammer-speaker chunks inside the
  // handler. The hub publishes everything for everyone — wasteful
  // at huge concurrency but fine at our scale.
  const transcriptUnsubscribe = subscribeTranscript((event) => {
    if (event.session_id !== session_id) return;
    if (event.speaker !== 'caller') return;
    appendScammerContext(state, event);
  });
  state.unsubscribers.push(transcriptUnsubscribe);

  return () => {
    for (const u of state.unsubscribers) u();
    sessionStates.delete(session_id);
    emitMetric('v3.sentinel_matcher.session_ended', {
      patterns_fired: state.firedPatterns.size,
    });
  };
}

/**
 * Force a fresh pattern load. Useful after admin-side hot-push
 * updates to b3_sentinel_patterns. Currently affects only NEW
 * sessions; in-flight sessions keep their session-start snapshot.
 */
export async function reloadPatterns(): Promise<number> {
  // Reload happens lazily — next session that starts pulls fresh.
  // For in-flight sessions to pick up changes we'd need to walk
  // sessionStates and replace each .patterns array. v3 does not.
  // (Spec section "B3 trigger" notes: "Initial seed has 5 patterns;
  // populated in Phase 2." Hot-reload during a call is v3.5 work.)
  return (await loadPatterns()).length;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function loadPatterns(): Promise<SentinelPattern[]> {
  const result = await query<{
    id: string;
    pattern_name: string;
    regex_source: string;
    required_scammer_context_regex: string | null;
    scammer_context_window_seconds: number;
    enabled: boolean;
  }>(
    `SELECT id, pattern_name, regex_source, required_scammer_context_regex,
            scammer_context_window_seconds, enabled
       FROM b3_sentinel_patterns
      WHERE enabled = TRUE`,
  );

  return result.rows
    .map((row) => {
      try {
        return {
          id: row.id,
          name: row.pattern_name,
          regex: new RegExp(row.regex_source, 'i'),
          required_scammer_context_regex: row.required_scammer_context_regex
            ? new RegExp(row.required_scammer_context_regex, 'i')
            : null,
          scammer_context_window_seconds: row.scammer_context_window_seconds,
          enabled: row.enabled,
        };
      } catch (err) {
        // A malformed regex in the DB is a config error — log and
        // skip rather than fail the whole loader.
        emitMetric('v3.sentinel_matcher.pattern_compile_failed', {
          pattern: row.pattern_name,
        });
        // eslint-disable-next-line no-console
        console.error('[sentinelMatcher] failed to compile pattern', {
          pattern: row.pattern_name,
          err: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    })
    .filter((p): p is SentinelPattern => p !== null);
}

function appendScammerContext(state: SessionState, event: TranscriptChunkEvent): void {
  state.scammerBuffer.push({ text: event.text, spoken_at: event.spoken_at });
  pruneScammerBuffer(state);
}

function pruneScammerBuffer(state: SessionState): void {
  // Drop entries older than the LARGEST window any pattern needs.
  // Keeping the buffer minimal saves memory on long calls.
  const maxWindow = state.patterns.reduce(
    (acc, p) => Math.max(acc, p.scammer_context_window_seconds),
    0,
  );
  if (maxWindow === 0) {
    state.scammerBuffer.length = 0;
    return;
  }
  const cutoff = Date.now() - maxWindow * 1000;
  while (state.scammerBuffer.length > 0 && state.scammerBuffer[0]!.spoken_at.getTime() < cutoff) {
    state.scammerBuffer.shift();
  }
}

async function evaluateChunk(
  state: SessionState,
  session_id: string,
  user_id: string,
  chunk: MomSideTranscriptChunk,
): Promise<void> {
  // Skip very-low-confidence transcript chunks. Misheard audio is the
  // dominant false-positive source for the digit-pattern sentinels;
  // requiring confidence ≥ 0.6 throws out the worst cases without
  // losing legit matches.
  if (chunk.confidence < 0.6) return;

  for (const pattern of state.patterns) {
    if (state.firedPatterns.has(pattern.name)) continue;

    const match = pattern.regex.exec(chunk.text);
    if (!match) continue;

    let scammerContextMatch: string | null = null;
    if (pattern.required_scammer_context_regex) {
      // Build the rolling scammer-side text within the pattern's window.
      const cutoff = Date.now() - pattern.scammer_context_window_seconds * 1000;
      const recent = state.scammerBuffer
        .filter((e) => e.spoken_at.getTime() >= cutoff)
        .map((e) => e.text)
        .join(' ');
      const ctxMatch = pattern.required_scammer_context_regex.exec(recent);
      if (!ctxMatch) {
        // Gate failed — record the near-miss so we can tune later.
        emitMetric('v3.sentinel_matcher.gate_blocked_match', {
          pattern: pattern.name,
        });
        continue;
      }
      scammerContextMatch = ctxMatch[0];
    }

    // Pass — fire.
    state.firedPatterns.add(pattern.name);
    emitMetric('v3.sentinel_matcher.fired', { pattern: pattern.name });

    if (!fireHandler) {
      // Misconfiguration — log loudly, do not silently drop.
      emitMetric('v3.sentinel_matcher.no_fire_handler_registered', {});
      // eslint-disable-next-line no-console
      console.error('[sentinelMatcher] no fireHandler registered; takeover would have fired', {
        session_id,
        pattern: pattern.name,
      });
      continue;
    }

    try {
      await fireHandler({
        session_id,
        user_id,
        pattern_name: pattern.name,
        matched_text: match[0],
        scammer_context_match: scammerContextMatch,
        spoken_at: chunk.emitted_at,
      });
    } catch (err) {
      emitMetric('v3.sentinel_matcher.fire_handler_threw', { pattern: pattern.name });
      // eslint-disable-next-line no-console
      console.error('[sentinelMatcher] fire handler threw', {
        session_id,
        pattern: pattern.name,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Test-only — read the in-memory state for a session. Lets unit
 * tests assert on which patterns fired without exposing internals
 * publicly.
 */
export function _getSessionStateForTests(session_id: string): SessionState | undefined {
  return sessionStates.get(session_id);
}

/** Test-only — clear all session state between tests. */
export function _resetForTests(): void {
  for (const state of sessionStates.values()) {
    for (const u of state.unsubscribers) u();
  }
  sessionStates.clear();
  fireHandler = null;
}
