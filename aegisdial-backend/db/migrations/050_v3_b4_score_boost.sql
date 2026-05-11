-- Live Shield v3 — B4 sub-threshold score-boost column (audit Gap #3).
--
-- The B4 verifier produces findings at confidence < V3_B4_TAKEOVER_THRESHOLD
-- (currently 0.95) that don't fire a takeover by themselves but ARE
-- weak signals that the call is suspicious. Pre-this-migration, those
-- findings were emitted as metrics and dropped on the floor — the
-- TODO at src/services/b4Orchestrator.ts:225 documented the unbuilt
-- path explicitly. Same for cannot_verify findings WITH non-zero
-- verifier confidence (verifier checked the claim and was uncertain
-- but didn't reach contradicted). cannot_verify findings with
-- confidence=0 (verifier outright bailed — L2 disabled, budget
-- exhausted, network error) produce NO boost — system-side
-- unavailability shouldn't poison the user's score.
--
-- v3 spec says these should boost the running v2 risk score via
-- V3_B4_SCORE_BOOST_LOW_CONF_WEIGHT and V3_B4_SCORE_BOOST_CANNOT_VERIFY_WEIGHT
-- (config defaults: 0.15 and 0.05). The boost is additive in the
-- transcript route's score-merge pipeline — multiple weak signals
-- stack toward the critical threshold without any single one being
-- strong enough to take over.
--
-- Storage shape: a single accumulator column on call_sessions, in
-- 0..100 points (same scale as risk_score). Each sub-threshold
-- finding adds `round(weight * confidence * 100)` integer points,
-- capped at 100 to prevent any one feature from monopolizing the
-- merged-score space. SMALLINT is enough headroom (max value 100).
--
-- Idempotency: writes are `b4_score_boost = LEAST(100, b4_score_boost
-- + N)` so a torn write only undercounts by 1 finding — same loss
-- tolerance as the existing b4_findings_count / b4_contradicted_count
-- columns. The orchestrator updates this column from b4_orchestrator
-- .dispatchFinding's score-boost branch.
--
-- Reading: the transcript route reads b4_score_boost alongside the
-- LLM cache columns, adds it into mergeScores, persists the new
-- merged risk_score back to the same row. The boost itself is NOT
-- decremented over time — accumulates for the session lifetime.
-- That's intentional: a call that produced 3 weak contradictions
-- earlier shouldn't lose those signals when the conversation
-- shifts. The session-end cleanup (next call starts fresh) is the
-- reset mechanism.

ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS b4_score_boost SMALLINT NOT NULL DEFAULT 0
    CHECK (b4_score_boost BETWEEN 0 AND 100);

COMMENT ON COLUMN call_sessions.b4_score_boost IS
  'Accumulated 0..100 score boost from B4 sub-threshold findings (contradicted < threshold + cannot_verify). Read in transcript route score merge; written by b4Orchestrator.dispatchFinding. Reset implicitly per session.';
