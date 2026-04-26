-- Track which follow-up emails have been dispatched per session.
-- The recoveryFollowupWorker cron reads these columns to decide when
-- to send the next nudge. NULL = not yet sent.

ALTER TABLE recovery_sessions
  ADD COLUMN IF NOT EXISTS followup_24h_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS followup_3d_sent_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS followup_7d_sent_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_recovery_sessions_followup_24h
  ON recovery_sessions (started_at) WHERE followup_24h_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recovery_sessions_followup_3d
  ON recovery_sessions (started_at) WHERE followup_3d_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recovery_sessions_followup_7d
  ON recovery_sessions (started_at) WHERE followup_7d_sent_at IS NULL;
