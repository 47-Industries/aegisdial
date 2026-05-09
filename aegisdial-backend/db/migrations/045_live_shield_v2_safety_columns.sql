-- Live Shield v2 — safety columns added in response to adversarial review.
--
--  consent_version       — version of the privacy disclosure the user
--                          accepted when starting the session. v1 = audio
--                          never leaves device. v2 = text leaves the device
--                          when call detected as suspicious. We REFUSE to
--                          fire Claude on v1 sessions to honor the
--                          original consent contract.
--  llm_invocation_count  — running count of Claude calls on this session.
--                          Capped at LLM_MAX_INVOCATIONS so an abandoned
--                          session can't drain budget.

ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS consent_version       INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS llm_invocation_count  INT NOT NULL DEFAULT 0;
