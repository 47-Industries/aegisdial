-- Live Shield v2: LLM-augmented columns on call_sessions.
--
-- The hybrid risk engine runs regex first (every chunk) and Claude
-- second (every ~8s, only when regex score ≥ 50). The LLM result is
-- cached on the session so:
--   - Subsequent chunks read the latest LLM verdict without firing again
--   - We have a debounce timestamp so the LLM doesn't run on every chunk
--   - The coaching line is persisted so iOS can render it without a
--     separate fetch
--
-- The single `family_alert_fired_at` flag prevents duplicate alerts
-- when a session bounces above and below 75 — fan-out happens once,
-- on first crossing.

ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS llm_score              INT,
  ADD COLUMN IF NOT EXISTS llm_scam_type          TEXT,
  ADD COLUMN IF NOT EXISTS llm_coaching_line      TEXT,
  ADD COLUMN IF NOT EXISTS llm_last_called_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS family_alert_fired_at  TIMESTAMPTZ;

-- Index covers the "did we already fan out for this session?" check on
-- the hot transcript path. Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_call_sessions_alert_fired
  ON call_sessions (id) WHERE family_alert_fired_at IS NOT NULL;
