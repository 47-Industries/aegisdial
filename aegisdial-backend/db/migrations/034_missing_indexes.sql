-- Missing indexes uncovered by the pre-launch route + DB review.
--
-- 1. guardian_alerts (subject_user_id, created_at DESC)
--    The existing idx_guardian_alerts_unseen + idx_guardian_alerts_all are
--    both keyed on guardian_user_id (the recipient). Every query that
--    looks up alerts ABOUT a given user — data export, guardian feed
--    grouped by family member, the retention sweeper — currently has to
--    sequential-scan guardian_alerts. Cheap to add, expensive to skip.
--
-- 2. recovery_sessions (family_plan_id) WHERE family_plan_id IS NOT NULL
--    Partial index: most sessions are solo (no family plan). The guardian
--    fan-out query, family dashboard, and plan-level recovery analytics
--    all filter by family_plan_id — a partial index is ~1/5th the size of
--    a full one while covering every real query.
--
-- 3. family_verifications (user_id, created_at DESC)
--    The existing index is only on call_session_id (partial). Every read
--    ordered by time for a user — audit trail, "did the safe word fail
--    today?" — falls back to seq scan. Fixed here.

CREATE INDEX IF NOT EXISTS idx_guardian_alerts_subject
  ON guardian_alerts (subject_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recovery_sessions_family_plan
  ON recovery_sessions (family_plan_id)
  WHERE family_plan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_family_verifications_user
  ON family_verifications (user_id, created_at DESC);
