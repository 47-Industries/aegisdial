import { config } from '../config.js';
import { query } from '../lib/db.js';
import { emitMetric } from '../lib/observability.js';
import { subscribe, type MomSideTranscriptChunk } from './momSideStt.js';

// Live Shield v3 — B3 sentinel matcher.
//
// PHASE 2 — full implementation lands when Phase 1 (A1/A2) wraps and
// B3 starts. This Phase 0 scaffold establishes:
//   - The public interface (start/stop per session)
//   - The subscriber-shape that the momSideStt service emits into
//   - The pattern-loading path against b3_sentinel_patterns table
//   - The context-window data structure for scammer-side gating
//
// What the matcher does (per spec section "B3 trigger"):
//
//   1. Subscribes to Mom-side transcript chunks for an active session.
//   2. On each chunk, evaluates the loaded regex pattern set.
//   3. For each match, applies the pattern's optional scammer-side
//      context gate — checking whether scammer-side audio in the last
//      N seconds (default 60) matched a required-context regex.
//   4. If both regex AND context gate pass, fires the B3 takeover via
//      the pushCriticalTakeover() route, marking trigger_path =
//      'sentinel_keyword' on the resulting b3_dismiss_events row.
//
// Pattern library: hot-pushable, lives in b3_sentinel_patterns.
// Reload behavior is "every N minutes from DB" — patterns can be
// added/disabled in production without restart. Initial seed has 5
// patterns (spec section "B3 trigger") — populated in Phase 2.
//
// False-positive surface (R4 in risk register): patterns are
// inherently regex; misheard audio + Mom dictating a tracking
// number → false positive. The dismiss UX is the recovery path,
// and post-dismiss telemetry (every fire + outcome) feeds tuning.

export interface SentinelPattern {
  id: string;
  name: string;
  // Compiled regex (we store source as TEXT in DB; compile on load).
  regex: RegExp;
  // Optional gate — match must also have scammer-side context within
  // window for the sentinel to fire.
  required_scammer_context_regex: RegExp | null;
  scammer_context_window_seconds: number;
  enabled: boolean;
}

/**
 * Start the sentinel matcher for a session. Subscribes to the
 * mom-side STT stream and watches for matches.
 *
 * Returns a stop function that the session-end handler must call to
 * unsubscribe and free the rolling-context buffer.
 *
 * Phase 0 scaffold — fan-out is wired but pattern loading + match
 * dispatch is the Phase 2 work.
 */
export async function startForSession(session_id: string, user_id: string): Promise<() => void> {
  if (!config.V3_B3_ENABLED || !config.V3_B3_MOM_SIDE_STT_ENABLED) {
    // Both flags must be on. With either off, sentinel matcher no-ops.
    return () => {};
  }

  const patterns = await loadPatterns();
  emitMetric('v3.sentinel_matcher.session_started', {
    patterns_loaded: patterns.length,
  });

  const handler = (chunk: MomSideTranscriptChunk) => {
    // TODO(Phase 2): for each pattern, run regex against chunk.text;
    // on match, evaluate the scammer-side context gate against the
    // session's rolling context buffer; on full match, dispatch a
    // b3 takeover via POST /v1/push/critical-takeover with
    // trigger_path = 'sentinel_keyword'.
    //
    // The rolling context buffer needs to live in this module —
    // keyed by session_id, holding the last
    // scammer_context_window_seconds of scammer-side transcript
    // chunks (consumed from the same EventEmitter v2 already uses).
    //
    // Don't fire twice per session for the same pattern_name —
    // dedupe in-memory keyed by (session_id, pattern_name) for
    // the duration of the call.
    void chunk;
    void patterns;
    void user_id;
  };

  const unsubscribe = subscribe(session_id, handler);
  return () => {
    unsubscribe();
    emitMetric('v3.sentinel_matcher.session_ended', {});
  };
}

/**
 * Load the active pattern set from b3_sentinel_patterns. Compiled
 * regexes are cached for the lifetime of the process; production
 * reload is via a periodic refresh (Phase 2 wires the cron).
 */
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

  return result.rows.map((row) => ({
    id: row.id,
    name: row.pattern_name,
    regex: new RegExp(row.regex_source, 'i'),
    required_scammer_context_regex: row.required_scammer_context_regex
      ? new RegExp(row.required_scammer_context_regex, 'i')
      : null,
    scammer_context_window_seconds: row.scammer_context_window_seconds,
    enabled: row.enabled,
  }));
}
