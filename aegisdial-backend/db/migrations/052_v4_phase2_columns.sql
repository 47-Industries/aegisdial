-- Live Shield v4 — Phase 2 — score boost + recovery preload columns.
--
-- Phase 0 + 1 shipped the dormant classifier and wired it to the
-- transcript hub. Phase 2 starts CONSUMING the (playbook, stage)
-- tuple downstream:
--
--   (a) v4_score_boost on call_sessions — a per-session SMALLINT 0..100
--       that the playbook subscriber writes when the classifier locks
--       onto a high-danger stage ('ask' / 'close') with high confidence.
--       Mirrors the v3 b4_score_boost mechanism: the risk-merge path in
--       routes/liveShield.ts reads it on every chunk and adds it to the
--       merged regex+LLM score (capped at 100). Separate column from
--       b4_score_boost so admin dashboards can distinguish v3 (claim-
--       verification) boosts from v4 (playbook-stage) boosts during
--       calibration. They can be consolidated later if the calibration
--       data shows they overlap.
--
--   (b) v4_playbook_id + v4_stage on recovery_sessions — the auto-
--       handoff path in /end-route reads call_sessions.v4_playbook_id at
--       call-end and copies it into the triage-mode recovery_sessions
--       row. Recovery Concierge then uses it to preload per-playbook
--       recovery steps (e.g. "we saw IRS impersonation — here are your 4
--       specific steps") instead of generic triage. v4_stage captures
--       which stage the call ended at, useful for picking which recovery
--       checkpoint to start at (a call that ended at 'ask' needs
--       different first steps than one that ended at 'close').
--
-- Additive-only. Safe against a running v3 prod fleet — every column is
-- nullable + DEFAULT, every index uses IF NOT EXISTS.

-- =========================================================================
-- (a) v4_score_boost on call_sessions
-- =========================================================================
ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS v4_score_boost SMALLINT NOT NULL DEFAULT 0
    CHECK (v4_score_boost BETWEEN 0 AND 100);

COMMENT ON COLUMN call_sessions.v4_score_boost IS
  'Live Shield v4 — additive score boost from playbook-stage classifier. '
  'Written when the classifier locks onto a high-danger stage (ask/close) '
  'with confidence above MIN_BOOST_CONFIDENCE. Read by the transcript '
  'route''s risk-score merge (additive, then capped at 100). Separate '
  'from b4_score_boost so v3 vs v4 contributions stay debuggable.';

-- =========================================================================
-- (b) v4 columns on recovery_sessions
-- =========================================================================
ALTER TABLE recovery_sessions
  ADD COLUMN IF NOT EXISTS v4_playbook_id TEXT,
  ADD COLUMN IF NOT EXISTS v4_stage       TEXT;

CREATE INDEX IF NOT EXISTS idx_recovery_sessions_v4_playbook
  ON recovery_sessions (v4_playbook_id) WHERE v4_playbook_id IS NOT NULL;

COMMENT ON COLUMN recovery_sessions.v4_playbook_id IS
  'Live Shield v4 — playbook detected on the source call_sessions row '
  'at /end time. Recovery Concierge uses this to preload playbook-'
  'specific recovery steps. NULL when call ended without a v4 detection '
  '(cold call, classifier off, or below confidence floor).';

COMMENT ON COLUMN recovery_sessions.v4_stage IS
  'Live Shield v4 — stage the call ended at. Used by Recovery Concierge '
  'to pick which recovery checkpoint to start at — a call that ended at '
  '"ask" needs different first steps than one that ended at "close".';
