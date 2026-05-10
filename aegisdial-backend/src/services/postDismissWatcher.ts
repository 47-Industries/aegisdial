import { config } from '../config.js';
import { query } from '../lib/db.js';
import { emitMetric } from '../lib/observability.js';
import { subscribeRiskTransition } from './v3SessionEvents.js';
import { firePostDismissFamilyAlert } from './liveShieldFamilyAlert.js';
import { emitSystemEvent, familyAlertDispatched } from './transcriptEvents.js';

// Live Shield v3 — B3 post-dismiss watcher.
//
// When the user dismisses a B3 takeover, the protection isn't over —
// AegisDial keeps Live Shield running and the family alert is the
// safety net if she stays in danger. This service is the timer.
//
// Spec section "B3 dismiss + escalation":
//   - User dismisses takeover (3s long-press on "I'm safe")
//   - AegisDial keeps watching
//   - If continuous critical state persists for 30+ seconds AFTER
//     dismiss → fire family alert with the "post-dismiss continued
//     risk" copy variant
//   - If score drops below critical → cancel timer
//   - Idempotent: only fires once per session via
//     family_alert_post_dismiss_fired_at column on call_sessions
//
// State per session (in-memory; lost on process restart, fine
// because Phase 2 sessions are short-lived and pinned to one process):
//
//   timer:           NodeJS.Timeout | null
//   dismissedAt:     Date          — when the dismiss happened
//   currentLevel:    risk_level    — last observed
//   userId, sessionId — for the eventual fire call

interface WatchState {
  user_id: string;
  session_id: string;
  dismissed_at: Date;
  current_level: 'low' | 'medium' | 'high' | 'critical';
  scam_type: string;
  matched_red_flags: string[];
  current_score: number;
  /** Set when current_level goes critical AFTER dismiss; cleared when it leaves critical. */
  critical_entered_at: Date | null;
  timer: NodeJS.Timeout | null;
}

const watchStates = new Map<string, WatchState>();

let riskUnsubscribe: (() => void) | null = null;

/**
 * Wire the watcher up at app startup. Subscribes to risk-transition
 * events from v3SessionEvents and drives the per-session timers.
 *
 * No-op if V3_B3_ENABLED is off.
 */
export function startPostDismissWatcher(): void {
  if (!config.V3_B3_ENABLED) return;
  if (riskUnsubscribe !== null) return; // already started

  riskUnsubscribe = subscribeRiskTransition(handleRiskTransition);
  emitMetric('v3.post_dismiss_watcher.started', {});
}

/**
 * Stop the watcher cleanly — used on process shutdown and in tests.
 */
export function stopPostDismissWatcher(): void {
  if (riskUnsubscribe) {
    riskUnsubscribe();
    riskUnsubscribe = null;
  }
  for (const state of watchStates.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  watchStates.clear();
}

/**
 * Called by the dismiss route when the user completes the
 * 3-second long-press on the "I'm safe" button.
 *
 * Starts the watch. The watch stays armed until either:
 *   - The 30s continuous-critical timer fires (we escalate), OR
 *   - Score drops below critical (we cancel), OR
 *   - The session ends.
 */
export function armPostDismissWatch(input: {
  session_id: string;
  user_id: string;
  current_level: 'low' | 'medium' | 'high' | 'critical';
  current_score: number;
  scam_type: string;
  matched_red_flags: string[];
}): void {
  if (!config.V3_B3_ENABLED) return;

  // Replace any existing state — re-arming is fine if the user
  // dismisses, score drops, then climbs back to critical and they
  // dismiss a second takeover.
  const existing = watchStates.get(input.session_id);
  if (existing?.timer) clearTimeout(existing.timer);

  const state: WatchState = {
    user_id: input.user_id,
    session_id: input.session_id,
    dismissed_at: new Date(),
    current_level: input.current_level,
    current_score: input.current_score,
    scam_type: input.scam_type,
    matched_red_flags: input.matched_red_flags,
    critical_entered_at: input.current_level === 'critical' ? new Date() : null,
    timer: null,
  };
  watchStates.set(input.session_id, state);

  // If we're critical AT dismiss-time, start the 30s timer immediately.
  // (Common case — the takeover fires BECAUSE the score is critical.)
  if (state.critical_entered_at) {
    armTimer(state);
  }

  emitMetric('v3.post_dismiss_watcher.armed', {
    started_critical: state.critical_entered_at !== null,
  });
}

/**
 * Disarm an active watch. Called when the session ends or the
 * caller explicitly cancels (e.g. the takeover gets re-fired and
 * a fresh watch will be armed on the next dismiss).
 */
export function disarmPostDismissWatch(session_id: string): void {
  const state = watchStates.get(session_id);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  watchStates.delete(session_id);
  emitMetric('v3.post_dismiss_watcher.disarmed', {});
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function armTimer(state: WatchState): void {
  // Clear any existing timer first so we never have two for the same session.
  if (state.timer) clearTimeout(state.timer);

  const delayMs = config.V3_B3_POST_DISMISS_FAMILY_ALERT_SECONDS * 1000;
  state.timer = setTimeout(() => {
    void escalate(state).catch((err) => {
      emitMetric('v3.post_dismiss_watcher.escalate_threw', {});
      // eslint-disable-next-line no-console
      console.error('[postDismissWatcher] escalate threw', {
        session_id: state.session_id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, delayMs);
  // Don't keep the event loop alive on shutdown.
  state.timer.unref();
}

function handleRiskTransition(event: {
  session_id: string;
  user_id: string;
  previous_level: string;
  new_level: 'low' | 'medium' | 'high' | 'critical';
  current_score: number;
  occurred_at: Date;
}): void {
  const state = watchStates.get(event.session_id);
  if (!state) return; // nothing armed for this session

  state.current_level = event.new_level;
  state.current_score = event.current_score;

  if (event.new_level === 'critical') {
    // Continuing or re-entering critical — make sure timer is armed.
    if (state.critical_entered_at === null) {
      // Re-enter critical AFTER having been below it. Reset the
      // 30s clock — the spec says CONTINUOUS critical for 30s,
      // so a flicker out and back resets the meter.
      state.critical_entered_at = event.occurred_at;
    }
    if (!state.timer) armTimer(state);
    return;
  }

  // Score dropped below critical — disarm the timer. Don't delete
  // the state yet; if the score climbs back to critical we re-arm.
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.critical_entered_at = null;
}

async function escalate(state: WatchState): Promise<void> {
  // Atomic claim of the post-dismiss firing rights via UPDATE-with-WHERE-guard.
  // Mirrors the v2 family_alert_fired_at pattern. Only one escalation
  // per session, ever.
  const result = await query(
    `UPDATE call_sessions
        SET family_alert_post_dismiss_fired_at = NOW()
      WHERE id = $1 AND family_alert_post_dismiss_fired_at IS NULL`,
    [state.session_id],
  );
  if ((result.rowCount ?? 0) === 0) {
    // Already fired — nothing more to do. Still clean up the in-memory
    // watch state so we don't leak it across the rest of the call.
    emitMetric('v3.post_dismiss_watcher.already_fired', {});
    if (state.timer) clearTimeout(state.timer);
    watchStates.delete(state.session_id);
    return;
  }

  try {
    const fireResult = await firePostDismissFamilyAlert({
      session_id: state.session_id,
      subject_user_id: state.user_id,
      risk_score: state.current_score,
      scam_type: state.scam_type,
      matched_red_flags: state.matched_red_flags,
    });

    emitMetric('v3.post_dismiss_watcher.escalated', {
      delivered: fireResult.delivered,
    });

    // Mark the transcript stream so the watching family member sees
    // the escalation event. The push notification itself was already
    // delivered by firePostDismissFamilyAlert.
    void emitSystemEvent(
      familyAlertDispatched(state.session_id, state.user_id, {
        reason: 'post_dismiss_escalation',
      }),
    );
  } catch (err) {
    // Compensating release of the firing rights so a future tick
    // could potentially re-try (in practice the timer fires once).
    await query(
      `UPDATE call_sessions
          SET family_alert_post_dismiss_fired_at = NULL
        WHERE id = $1`,
      [state.session_id],
    ).catch(() => {
      /* swallow — best-effort compensation */
    });
    throw err;
  } finally {
    // Whether we succeeded or threw, the watch is done for this session.
    if (state.timer) clearTimeout(state.timer);
    watchStates.delete(state.session_id);
  }
}

/** Test-only — read the in-memory state for a session. */
export function _getWatchStateForTests(session_id: string): WatchState | undefined {
  return watchStates.get(session_id);
}

/** Test-only — fire all pending escalation timers immediately. */
export async function _flushTimersForTests(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const state of [...watchStates.values()]) {
    if (state.timer && state.critical_entered_at) {
      clearTimeout(state.timer);
      state.timer = null;
      promises.push(escalate(state));
    }
  }
  await Promise.all(promises);
}

/** Test-only — clear all watch state. */
export function _resetForTests(): void {
  for (const state of watchStates.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  watchStates.clear();
  if (riskUnsubscribe) {
    riskUnsubscribe();
    riskUnsubscribe = null;
  }
}
