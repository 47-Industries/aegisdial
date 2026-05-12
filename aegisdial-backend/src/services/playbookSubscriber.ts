import { config } from '../config.js';
import { query } from '../lib/db.js';
import { emitMetric } from '../lib/observability.js';
import { subscribeTranscript, type TranscriptChunkEvent } from './v3SessionEvents.js';
import {
  classifyAndCommit,
  type StageClassification,
  type UserAgeBand,
} from './stageClassifier.js';
import { dobYearToAgeBand } from '../lib/ageBand.js';
import { evaluateStageTiming } from '../lib/stageTiming.js';
import type { PlaybookId, StageId } from '../data/playbooks.js';

// Live Shield v4 — Phase 1 — playbook subscriber.
//
// Subscribes to caller-side transcript chunks (v3SessionEvents) and
// drives the stage classifier per session. Mirrors the b4Orchestrator
// pattern that already exists for B4 claim extraction:
//   - Per-session rolling 60s caller-side context buffer
//   - Per-session current-state cache (avoids DB read per chunk)
//   - Boot-time start, /end-route teardown to bound memory
//
// Architecture notes:
//   - Classifier itself debounces (8s) and caps (100/24h) per session
//     in Redis. This subscriber doesn't second-guess; it dispatches
//     every chunk and lets the classifier short-circuit.
//   - Mom-side ('self') chunks are intentionally ignored. The
//     playbook is a property of the SCAMMER's script — Mom's
//     responses don't classify the playbook (though future v4.x may
//     incorporate Mom-side as a confidence signal).
//   - When the classifier commits a new (playbook, stage), this
//     module updates the in-memory state cache so the NEXT chunk's
//     classifier call sees the latest state without a DB read.
//
// Memory bounds: one SessionContext per active call. Cleaned up
// in endSession() called from /v1/live-shield/:id/end. If /end
// is missed (process restart mid-call), the next boot starts
// clean — sessions that were already in-flight just lose their
// per-session classifier history (minor degradation — classifier
// re-classifies cold the next time it sees a chunk).

interface SessionContext {
  /** Rolling caller-side text from the last 60s. */
  rolling_text: Array<{ text: string; spoken_at: Date }>;
  /**
   * Last committed classification. NULL when no playbook has been
   * detected yet (cold session). Updated in-band by the classifier
   * after each commit; used as the bias input on the next classify.
   */
  current: { playbook_id: PlaybookId | null; stage: StageId | null };
  /**
   * v4 Phase 10 — wall-clock timestamp of when the session entered
   * the current (playbook, stage). NULL on cold session (no
   * classification yet). On the NEXT transition commit we compute
   * (now - current_since) to evaluate against the playbook seed's
   * typical_duration_seconds and emit the stage-timing telemetry
   * metric. Reset (to now) on every committed transition.
   */
  current_since: Date | null;
  /**
   * v4 Phase 7 — caller age band, lazy-fetched on the first chunk
   * of the session and cached for the rest of the call. dob_year
   * doesn't change mid-call, so one SELECT per session is enough.
   *
   * State machine:
   *   'unfetched' = haven't tried yet (next chunk will fetch)
   *   'fetching'  = SELECT in flight (concurrent chunks short-circuit
   *                 to pass null this round; not strictly required
   *                 for correctness — both chunks would write the
   *                 same value — but avoids redundant DB load when
   *                 two chunks land 100-200ms apart from STT)
   *   UserAgeBand = resolved (cached for the rest of the session)
   *   null        = resolved as "no band available" (user has no
   *                 dob_year on file, flag was off when fetch happened,
   *                 or DB error)
   */
  user_age_band: 'unfetched' | 'fetching' | UserAgeBand | null;
}

const sessionContexts = new Map<string, SessionContext>();

let unsubscribe: (() => void) | null = null;

/**
 * Drop per-session in-memory state. Called from the live-shield
 * session-end route. Idempotent — fine to call on a session that
 * already ended or never had any v4 activity.
 *
 * Why this matters: monotonic Map growth on long-running prod
 * processes is the same risk b4Orchestrator caught in Phase 5
 * adversarial review. The /end-route hook prevents it.
 */
export function endSession(session_id: string): void {
  sessionContexts.delete(session_id);
}

/**
 * Start the classifier subscriber. Idempotent — re-calls are no-ops
 * if already started. Server boot calls this once.
 *
 * M1 adversarial fix: the subscriber installs UNCONDITIONALLY at
 * boot, but the per-chunk handler re-checks
 * `config.V4_PLAYBOOK_AWARE_ENABLED` and short-circuits when OFF.
 * This removes the restart-required footgun where a runtime flip
 * from OFF→ON would have been a partial enable (classifier
 * checks the flag per-call, but the subscriber wouldn't have been
 * installed). Cost: one bool check per caller chunk (~7-30/min) —
 * trivial. The hub itself is also flag-gated (v3SessionEvents.ts
 * notifyTranscriptChunk early-out includes V4_PLAYBOOK_AWARE_ENABLED),
 * so when the flag is OFF this subscriber receives zero events.
 */
export function startV4PlaybookSubscriber(): void {
  if (unsubscribe) return;

  // Operator-visibility warning: V4 flag is ON but the classifier
  // has no API key, so every classify() call will silently short-
  // circuit to null and nothing will get committed. Without this
  // warn, the operator sees zero v4.classifier.* metrics and may
  // mistakenly think the feature is working. Emitted once at boot
  // rather than per-chunk to avoid log spam.
  if (config.V4_PLAYBOOK_AWARE_ENABLED && !config.ANTHROPIC_API_KEY) {
    emitMetric('v4.playbook_subscriber.no_api_key', {});
    // eslint-disable-next-line no-console
    console.warn(
      '[playbookSubscriber] V4_PLAYBOOK_AWARE_ENABLED=true but ANTHROPIC_API_KEY is unset — classifier will no-op',
    );
  }

  unsubscribe = subscribeTranscript((event) => {
    if (!config.V4_PLAYBOOK_AWARE_ENABLED) return;
    if (event.speaker !== 'caller') return;
    void handleCallerChunk(event).catch((err) => {
      emitMetric('v4.playbook_subscriber.threw', {});
      // eslint-disable-next-line no-console
      console.error('[playbookSubscriber] handler threw', {
        session_id: event.session_id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  });

  emitMetric('v4.playbook_subscriber.started', {});
}

export function stopV4PlaybookSubscriber(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  sessionContexts.clear();
}

async function handleCallerChunk(event: TranscriptChunkEvent): Promise<void> {
  // Maintain rolling 60s caller-side context per session.
  const ctx = appendToSessionContext(event);

  // recent_context is concatenated, capped at 2000 chars to keep
  // classifier prompt tokens bounded. Same cap b4Orchestrator uses.
  const recent_context = ctx.rolling_text
    .map((e) => e.text)
    .join(' ')
    .slice(-2000);

  // v4 Phase 7 — lazy-fetch the caller's age band on the first chunk
  // and cache for the rest of the session. dob_year doesn't change
  // mid-call, so one SELECT per session suffices.
  //
  // M1 race-condition defense: the SELECT is async, so back-to-back
  // chunks (100-200ms apart from STT) would both see 'unfetched' and
  // both fire SELECT. Setting the cache to 'fetching' BEFORE the
  // await ensures the second chunk sees 'fetching' and passes null
  // for this round. Both writes are idempotent so correctness is
  // preserved either way; this just avoids the duplicate DB call.
  //
  // Flag-OFF reset behavior is intentional: if operator flips the
  // flag back on mid-call, the next chunk fetches fresh. ON→OFF→ON
  // cycle pays one extra SELECT per cycle — acceptable.
  if (config.V4_PLAYBOOK_DEMOGRAPHIC_PRIORS_ENABLED && ctx.user_age_band === 'unfetched') {
    ctx.user_age_band = 'fetching';
    ctx.user_age_band = await loadUserAgeBand(event.user_id);
  } else if (!config.V4_PLAYBOOK_DEMOGRAPHIC_PRIORS_ENABLED) {
    // Flag off: keep the cache slot empty for a future flip-on.
    ctx.user_age_band = 'unfetched';
  }
  // The classifier's classify() accepts UserAgeBand | null. Coerce
  // the two sentinel values ('unfetched' / 'fetching') to null —
  // both mean "no band to pass this round."
  const ageBandForCall: UserAgeBand | null =
    ctx.user_age_band === 'unfetched' || ctx.user_age_band === 'fetching'
      ? null
      : ctx.user_age_band;

  const { classification, action } = await classifyAndCommit(event, {
    recent_context,
    current: ctx.current,
    // trigger_event_id is null at this layer — the chunk doesn't
    // carry the transcript_events.id and synthesizing one would
    // add a UUID per chunk for no consumer (recap UI is Phase 2).
    trigger_event_id: null,
    user_age_band: ageBandForCall,
  });

  if (!classification || !action) return;

  // Update in-memory current-state cache on commit. The classifier
  // already wrote call_sessions; this keeps the next chunk's
  // classify call's `current` accurate without a DB read.
  if (action === 'committed_transition' || action === 'committed_initial') {
    applyCommitToContext(ctx, classification, event.spoken_at, action);
  }
}

/**
 * Apply a successful classification commit to the in-memory session
 * context. Extracted as a separate function so:
 *   1. The full pipeline test can use it via the test-only export
 *      (MEDIUM-2 adversarial fix — without this, the wiring guards
 *      and current_since reset path were unreachable without mocking
 *      the entire Anthropic API call chain).
 *   2. The two side-effect concerns (stage-timing metric emission +
 *      state update) live in one place with one set of guards.
 *
 * Side effects:
 *   - emitMetric('v4.stage_timing.evaluated', ...) if a transition
 *     elapsed-time evaluation produced a verdict.
 *   - emitMetric('v4.playbook_subscriber.transition_recorded', ...)
 *     always emitted on commit.
 *   - Mutates ctx.current and ctx.current_since.
 */
function applyCommitToContext(
  ctx: SessionContext,
  classification: StageClassification,
  spokenAt: Date,
  action: 'committed_transition' | 'committed_initial',
): void {
  // v4 Phase 10 — stage-timing telemetry. Before overwriting the
  // current/current_since pair, evaluate the time spent in the PRIOR
  // (playbook, stage) and emit a metric tagged by playbook+stage+
  // verdict. Only fires on transitions (committed_transition), not
  // on the initial commit — committed_initial has no prior stage to
  // evaluate against.
  //
  // MEDIUM-1 fix from adversarial review: use chunk-level
  // `spoken_at` timestamps on BOTH ends of the elapsed math, not
  // `Date.now()` at commit time. Both timestamps reflect Mom's
  // perspective of when the scammer's audio actually landed; using
  // commit-time wall-clock would bake in classifier debounce +
  // LLM latency (~8s) and bias every measurement low.
  if (
    action === 'committed_transition' &&
    config.V4_PLAYBOOK_STAGE_TIMING_TELEMETRY_ENABLED &&
    ctx.current.playbook_id &&
    ctx.current.stage &&
    ctx.current_since
  ) {
    const elapsedSec = (spokenAt.getTime() - ctx.current_since.getTime()) / 1000;
    const timing = evaluateStageTiming(
      ctx.current.playbook_id,
      ctx.current.stage,
      elapsedSec,
    );
    if (timing.verdict !== 'no_data') {
      emitMetric('v4.stage_timing.evaluated', {
        playbook_id: ctx.current.playbook_id,
        stage: ctx.current.stage,
        verdict: timing.verdict,
      });
    }
  }

  ctx.current = {
    playbook_id: classification.playbook_id,
    stage: classification.stage,
  };
  // Stamp from the chunk's spoken_at (NOT Date.now()) so the next
  // transition's elapsed math is "scammer-spoke-at A → scammer-spoke-at B"
  // instead of "wall-clock-at-commit-A → wall-clock-at-commit-B."
  ctx.current_since = spokenAt;
  emitMetric('v4.playbook_subscriber.transition_recorded', {
    playbook_id: classification.playbook_id,
    stage: classification.stage,
  });
}

function appendToSessionContext(event: TranscriptChunkEvent): SessionContext {
  let ctx = sessionContexts.get(event.session_id);
  if (!ctx) {
    ctx = {
      rolling_text: [],
      current: { playbook_id: null, stage: null },
      user_age_band: 'unfetched',
      current_since: null,
    };
    sessionContexts.set(event.session_id, ctx);
  }
  ctx.rolling_text.push({ text: event.text, spoken_at: event.spoken_at });

  // Prune entries older than 60s. Same cadence as b4Orchestrator.
  const cutoff = Date.now() - 60_000;
  while (
    ctx.rolling_text.length > 0 &&
    ctx.rolling_text[0]!.spoken_at.getTime() < cutoff
  ) {
    ctx.rolling_text.shift();
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Test-only — clear all state between tests. */
export function _resetForTests(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  sessionContexts.clear();
}

/** Test-only — read the in-memory session context for a session. */
export function _getSessionContextForTests(session_id: string):
  | {
      rolling_text_count: number;
      current: { playbook_id: PlaybookId | null; stage: StageId | null };
      current_since: Date | null;
    }
  | null {
  const ctx = sessionContexts.get(session_id);
  if (!ctx) return null;
  return {
    rolling_text_count: ctx.rolling_text.length,
    current: { ...ctx.current },
    current_since: ctx.current_since,
  };
}

/**
 * Test-only — drive applyCommitToContext directly without going
 * through the Anthropic API. MEDIUM-2 adversarial fix for Phase 10:
 * the timing-metric emission + current_since reset live inside the
 * post-commit branch of handleCallerChunk. Without this hatch, the
 * only way to exercise that branch was to mock the entire LLM call
 * chain — too much surface to mock for a unit test, and any change
 * to the classifier's internals would break the test for the wrong
 * reason. This export lets the test pin the wiring contract directly.
 */
export function _simulateCommitForTests(
  session_id: string,
  classification: StageClassification,
  spokenAt: Date,
  action: 'committed_transition' | 'committed_initial',
): void {
  let ctx = sessionContexts.get(session_id);
  if (!ctx) {
    ctx = {
      rolling_text: [],
      current: { playbook_id: null, stage: null },
      user_age_band: 'unfetched',
      current_since: null,
    };
    sessionContexts.set(session_id, ctx);
  }
  applyCommitToContext(ctx, classification, spokenAt, action);
}

/** Test-only — drive a chunk through the handler directly. */
export async function _handleCallerChunkForTests(event: TranscriptChunkEvent): Promise<void> {
  await handleCallerChunk(event);
}

/** Test-only — seed an initial classification into the cache (simulates a prior commit). */
export function _seedSessionStateForTests(
  session_id: string,
  current: { playbook_id: PlaybookId | null; stage: StageId | null },
  current_since: Date | null = null,
): void {
  let ctx = sessionContexts.get(session_id);
  if (!ctx) {
    ctx = {
      rolling_text: [],
      current: { playbook_id: null, stage: null },
      user_age_band: 'unfetched',
      current_since: null,
    };
    sessionContexts.set(session_id, ctx);
  }
  ctx.current = current;
  ctx.current_since = current_since;
}

/**
 * v4 Phase 7 — fetch the caller's age band from users.dob_year. NULL
 * when:
 *   - The user row is missing (shouldn't happen for a session that
 *     reached the classifier — the route layer would have rejected
 *     unauthenticated requests — but defensive)
 *   - dob_year is NULL (pre-migration account)
 *   - dob_year is out of plausible range (DB CHECK should prevent;
 *     dobYearToAgeBand validates again)
 *
 * Errors here ALWAYS swallow to null — demographic priors are a
 * tie-break enhancement, not safety-critical. A failed fetch means
 * "skip demographic priors for this session," not "skip classifier."
 */
async function loadUserAgeBand(user_id: string): Promise<UserAgeBand | null> {
  try {
    const res = await query<{ dob_year: number | null }>(
      `SELECT dob_year FROM users WHERE id = $1`,
      [user_id],
    );
    return dobYearToAgeBand(res.rows[0]?.dob_year ?? null);
  } catch {
    emitMetric('v4.playbook_subscriber.age_band_fetch_failed', {});
    return null;
  }
}

// Export for external observability (e.g., metrics endpoint).
export function _classifierState(): { active_sessions: number } {
  return { active_sessions: sessionContexts.size };
}

export type { StageClassification };
