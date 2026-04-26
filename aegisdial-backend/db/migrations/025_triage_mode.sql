-- Triage mode — "is this a scam?" pre-loss consultation sessions.
--
-- A single recovery_sessions row can be either a RECOVERY (victim
-- already lost money, needs the step playbook) OR a TRIAGE (victim is
-- unsure whether what just happened was a scam; talking through it with
-- the Companion). Triage sessions skip step generation and the guardian
-- broadcast, because alerting family over a maybe-scam is the wrong
-- move. If the triage determines it WAS a scam AND money has moved,
-- the session converts in place to mode='recovery' and gets the full
-- step list.
--
-- resolved_as captures the triage outcome for analytics + PR narrative:
-- "scams prevented before loss" is the single most important metric
-- for the fundraise story.

ALTER TABLE recovery_sessions
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'recovery'
    CHECK (mode IN ('recovery', 'triage')),
  ADD COLUMN IF NOT EXISTS resolved_as TEXT
    CHECK (
      resolved_as IS NULL OR resolved_as IN (
        'scam_confirmed_no_loss',
        'converted_to_recovery',
        'not_a_scam',
        'unclear'
      )
    ),
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

COMMENT ON COLUMN recovery_sessions.mode IS
  'recovery = victim with loss walking the step playbook; triage = pre-loss "is this a scam" chat.';
COMMENT ON COLUMN recovery_sessions.resolved_as IS
  'Triage outcome. scam_confirmed_no_loss is our win metric.';

CREATE INDEX IF NOT EXISTS idx_recovery_sessions_triage
  ON recovery_sessions (user_id, started_at DESC) WHERE mode = 'triage';
CREATE INDEX IF NOT EXISTS idx_recovery_sessions_prevented
  ON recovery_sessions (resolved_at DESC) WHERE resolved_as = 'scam_confirmed_no_loss';
