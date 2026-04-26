-- Extend the recovery follow-up cadence past the first week. The initial
-- 24h/3d/7d cadence (migration 017) covers the "did you do the work?"
-- nudge window. The two longer buckets added here cover the emotional
-- arc that doesn't fit in a week:
--
--   - T+30d: outcome check-in. Only fires for sessions where the user
--     already submitted a recovery_outcomes row — the email references
--     their recovered_any / recovered_cents and invites them to share
--     advice for other victims.
--
--   - T+90d: long-tail check-in. Fires regardless of outcome state
--     because scammer re-targeting peaks 3–6 months after the initial
--     hit (FBI IC3 data: ~41% re-target rate in 6 months). Gives us a
--     place to warn about recovery-scam secondary victimization.
--
-- NULL = not yet sent. The recoveryFollowupWorker reads these columns
-- to decide eligibility on each cron tick.

ALTER TABLE recovery_sessions
  ADD COLUMN IF NOT EXISTS followup_30d_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS followup_90d_sent_at TIMESTAMPTZ;

-- Partial indexes mirror the 017 pattern: the worker selects rows where
-- the send column IS NULL, ordered by started_at. A plain index over
-- (started_at) would bloat with every row that's already been sent; the
-- partial index stays tight and the query planner uses it directly.
CREATE INDEX IF NOT EXISTS idx_recovery_sessions_followup_30d
  ON recovery_sessions (started_at) WHERE followup_30d_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recovery_sessions_followup_90d
  ON recovery_sessions (started_at) WHERE followup_90d_sent_at IS NULL;
