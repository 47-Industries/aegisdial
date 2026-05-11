-- Live Shield v3 — Phase 5: durable post-dismiss watch state.
--
-- CRITICAL bug fix from the Phase 5 adversarial review:
-- src/services/postDismissWatcher.ts maintained the post-dismiss
-- escalation timer state ENTIRELY in memory. A process restart
-- (Fly redeploy, OOM kill, autoscaling event) during an active
-- call would silently lose the watch — the post-dismiss family
-- alert that's supposed to fire 30s after a takeover dismiss
-- would never fire, and Mom would be unprotected for the rest
-- of the call.
--
-- This table makes the watch state durable. On arm, we INSERT.
-- On disarm/escalate, we DELETE. On process boot, the watcher
-- queries this table for active watches against sessions that
-- haven't ended yet and rehydrates the in-memory timers.

CREATE TABLE IF NOT EXISTS b3_armed_post_dismiss_watches (
  session_id          UUID        PRIMARY KEY REFERENCES call_sessions(id) ON DELETE CASCADE,
  user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  armed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at        TIMESTAMPTZ NOT NULL,
  scam_type           TEXT        NOT NULL,
  matched_red_flags   TEXT[]      NOT NULL DEFAULT '{}',
  current_score       INTEGER     NOT NULL,
  -- When the score first entered critical AFTER the dismiss. Null when
  -- the current level is below critical. The 30s escalation timer
  -- counts from this point; if it goes null and back to non-null we
  -- reset, matching the in-memory semantics.
  critical_entered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_b3_armed_watches_critical
  ON b3_armed_post_dismiss_watches (critical_entered_at)
  WHERE critical_entered_at IS NOT NULL;
