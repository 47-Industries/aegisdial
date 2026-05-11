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
 * CRITICAL bug fix from Phase 5 adversarial review: ALSO rehydrates
 * any in-flight armed watches from the b3_armed_post_dismiss_watches
 * table. Without this, a process restart mid-call drops the timer
 * silently and the post-dismiss family-alert never fires.
 *
 * No-op if V3_B3_ENABLED is off.
 */
export async function startPostDismissWatcher(): Promise<void> {
  if (!config.V3_B3_ENABLED) return;
  if (riskUnsubscribe !== null) return; // already started

  riskUnsubscribe = subscribeRiskTransition(handleRiskTransition);

  // Rehydrate any active watches from the DB. These are watches that
  // were armed before this process started — including watches that
  // pre-date a redeploy. Each rehydrated watch re-arms its timer; if
  // the original 30s window has already elapsed since dismiss + the
  // session is still critical, escalate() fires immediately on the
  // next tick.
  try {
    const active = await query<{
      session_id: string;
      user_id: string;
      dismissed_at: Date;
      scam_type: string;
      matched_red_flags: string[];
      current_score: number;
      critical_entered_at: Date | null;
    }>(
      `SELECT w.session_id, w.user_id, w.dismissed_at, w.scam_type,
              w.matched_red_flags, w.current_score, w.critical_entered_at
         FROM b3_armed_post_dismiss_watches w
         JOIN call_sessions cs ON cs.id = w.session_id
        WHERE cs.ended_at IS NULL
          AND cs.family_alert_post_dismiss_fired_at IS NULL`,
    );

    let rehydrated = 0;
    for (const row of active.rows) {
      const state: WatchState = {
        user_id: row.user_id,
        session_id: row.session_id,
        dismissed_at: row.dismissed_at,
        current_level: row.critical_entered_at ? 'critical' : 'high',
        current_score: row.current_score,
        scam_type: row.scam_type,
        matched_red_flags: row.matched_red_flags,
        critical_entered_at: row.critical_entered_at,
        timer: null,
      };
      watchStates.set(row.session_id, state);
      if (state.critical_entered_at) {
        // Compute the remaining slice of the 30s window. A process
        // restart 25s into the window arms a 5s timer, NOT a fresh
        // 30s. Floor at 0 — escalate immediately if the window
        // already lapsed during the restart gap (escalate() handles
        // the not-still-critical case by exit).
        const fullMs = config.V3_B3_POST_DISMISS_FAMILY_ALERT_SECONDS * 1000;
        const elapsedMs = Date.now() - state.critical_entered_at.getTime();
        const remainingMs = Math.max(0, fullMs - elapsedMs);
        armTimer(state, remainingMs);
      }
      rehydrated++;
    }
    emitMetric('v3.post_dismiss_watcher.rehydrated', { count: rehydrated });
  } catch (err) {
    emitMetric('v3.post_dismiss_watcher.rehydrate_failed', {});
    // eslint-disable-next-line no-console
    console.error('[postDismissWatcher] rehydrate failed on boot', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

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

  const dismissedAt = new Date();
  const criticalEnteredAt = input.current_level === 'critical' ? dismissedAt : null;
  const state: WatchState = {
    user_id: input.user_id,
    session_id: input.session_id,
    dismissed_at: dismissedAt,
    current_level: input.current_level,
    current_score: input.current_score,
    scam_type: input.scam_type,
    matched_red_flags: input.matched_red_flags,
    critical_entered_at: criticalEnteredAt,
    timer: null,
  };
  watchStates.set(input.session_id, state);

  // Persist to DB so a process restart can rehydrate. Fire-and-forget;
  // arm is best-effort even if the DB write hiccups, because the
  // in-memory timer fires regardless. If DB fails, we lose the
  // restart-safety net but not the active timer.
  void query(
    `INSERT INTO b3_armed_post_dismiss_watches
       (session_id, user_id, dismissed_at, scam_type, matched_red_flags,
        current_score, critical_entered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (session_id) DO UPDATE
       SET dismissed_at = EXCLUDED.dismissed_at,
           scam_type = EXCLUDED.scam_type,
           matched_red_flags = EXCLUDED.matched_red_flags,
           current_score = EXCLUDED.current_score,
           critical_entered_at = EXCLUDED.critical_entered_at`,
    [
      input.session_id,
      input.user_id,
      dismissedAt,
      input.scam_type,
      input.matched_red_flags,
      input.current_score,
      criticalEnteredAt,
    ],
  ).catch((err) => {
    emitMetric('v3.post_dismiss_watcher.persist_failed', {});
    // eslint-disable-next-line no-console
    console.warn('[postDismissWatcher] persist failed', {
      session_id: input.session_id,
      err: err instanceof Error ? err.message : String(err),
    });
  });

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
  if (state?.timer) clearTimeout(state.timer);
  watchStates.delete(session_id);
  // Also clean the DB row so the rehydrate-on-boot path doesn't try
  // to revive this watch. Best-effort; if the DELETE fails, the watch
  // will rehydrate on next boot but then immediately escalate-or-die
  // since the session will likely be ended-or-already-fired by then.
  void query(
    `DELETE FROM b3_armed_post_dismiss_watches WHERE session_id = $1`,
    [session_id],
  ).catch(() => {
    /* swallow — best-effort */
  });
  emitMetric('v3.post_dismiss_watcher.disarmed', {});
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function armTimer(state: WatchState, delayMsOverride?: number): void {
  // Clear any existing timer first so we never have two for the same session.
  if (state.timer) clearTimeout(state.timer);

  // When delayMsOverride is provided (boot-time rehydration), use it.
  // Otherwise use the full 30s window. The override exists because a
  // process restart that lands 25s into a 30s window must arm a 5s
  // timer, not a fresh 30s — otherwise the actual escalation latency
  // becomes 30s + restart_lag instead of the spec's 30s.
  const delayMs = delayMsOverride ?? config.V3_B3_POST_DISMISS_FAMILY_ALERT_SECONDS * 1000;
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
  // Re-read current risk state from the DB before firing. The in-memory
  // `state.current_level` is updated via risk-transition events, but
  // after a process restart that spans the 30s window (LOW finding from
  // the second-pass adversarial review), no risk-transition events fired
  // during the downtime. Rehydration arms a remainingMs=0 timer based
  // on the persisted `critical_entered_at`, even if the user actually
  // became safe during the gap. Without this guard, a deploy mid-call
  // could fire a spurious "your relative may be in danger" family
  // alert. Source-of-truth is call_sessions.risk_level (updated by the
  // hybrid risk scorer on every transcript chunk).
  const current = await query<{ risk_level: string; ended_at: Date | null }>(
    `SELECT risk_level, ended_at FROM call_sessions WHERE id = $1`,
    [state.session_id],
  );
  if (current.rows.length === 0 || current.rows[0]!.ended_at) {
    // Session deleted or ended during the window; no escalation needed.
    emitMetric('v3.post_dismiss_watcher.escalate_skipped_ended', {});
    if (state.timer) clearTimeout(state.timer);
    watchStates.delete(state.session_id);
    void query(
      `DELETE FROM b3_armed_post_dismiss_watches WHERE session_id = $1`,
      [state.session_id],
    ).catch(() => {});
    return;
  }
  if (current.rows[0]!.risk_level !== 'critical') {
    // No longer critical — user is safe, drop the watch silently.
    emitMetric('v3.post_dismiss_watcher.escalate_skipped_not_critical', {});
    if (state.timer) clearTimeout(state.timer);
    watchStates.delete(state.session_id);
    void query(
      `DELETE FROM b3_armed_post_dismiss_watches WHERE session_id = $1`,
      [state.session_id],
    ).catch(() => {});
    return;
  }

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
    // watch state AND the DB persistence row so neither leak.
    emitMetric('v3.post_dismiss_watcher.already_fired', {});
    if (state.timer) clearTimeout(state.timer);
    watchStates.delete(state.session_id);
    void query(
      `DELETE FROM b3_armed_post_dismiss_watches WHERE session_id = $1`,
      [state.session_id],
    ).catch(() => {});
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

    // M-15 follow-up: when the alert dispatch silently fails (DB insert
    // raised inside guardianAlerts, swallowed there, surfaced here as
    // outcome='all_delivery_failed' with no exception), the firing-
    // rights flag still got set on the call session. Without this
    // branch, the flag stays set forever AND the finally below tears
    // down the in-memory + DB watch state — so no future tick can ever
    // retry. Mirror the catch-path compensating release so the row is
    // left in a consistent state and a future B3 dismiss on the same
    // session can re-arm. Don't re-throw — the outcome enum already
    // gave us the structured signal we needed for the metric.
    if (fireResult.outcome === 'all_delivery_failed') {
      await query(
        `UPDATE call_sessions
            SET family_alert_post_dismiss_fired_at = NULL
          WHERE id = $1`,
        [state.session_id],
      ).catch(() => {
        /* swallow — best-effort compensation */
      });
    }

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
    void query(
      `DELETE FROM b3_armed_post_dismiss_watches WHERE session_id = $1`,
      [state.session_id],
    ).catch(() => {});
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
