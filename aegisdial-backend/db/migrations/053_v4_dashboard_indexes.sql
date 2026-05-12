-- Live Shield v4 — Phase 21 — dashboard query performance hardening.
--
-- The v4 admin dashboards (Phases 11/12/13/14/17) all share the same
-- query shape: filter metric_counters by a specific `name` over a
-- time window, then GROUP BY JSONB tag extractions. The existing
-- idx_metric_counters_name_bucket (migration 012) covers the WHERE
-- clause; this migration adds a PARTIAL index that further shrinks
-- the leaf set to just the metric names the v4 dashboards read.
--
-- Why partial: at full scale `metric_counters` accumulates rows from
-- every emit site in the system (~50+ distinct names). A general
-- index on (name, bucket) bloats with rows the v4 dashboards never
-- touch. The partial index lives only on v4-dashboard-relevant
-- names, making it ~10x smaller per metric and producing tighter
-- planner choices for the admin queries specifically. Insert
-- performance is unchanged for non-v4 emits (predicate doesn't
-- match → no index write); v4 emits pay one extra index update
-- per insert (cheap compared to the row itself).
--
-- Why not GIN(tags): our queries don't FILTER on tag values, they
-- GROUP BY tag extractions. GIN on jsonb helps `WHERE tags @>
-- '{...}'`; our queries don't have that shape. A functional index
-- on `(name, (tags->>'playbook_id'))` would help even more, but
-- adds N indexes per dashboard query shape. The partial index
-- below covers the WHERE-clause selectivity gain without that
-- multiplication.
--
-- Migration is additive-only + idempotent. Safe to run against a
-- prod DB with v3+v4 traffic.

-- NOTE: plain CREATE INDEX rather than CONCURRENTLY because the
-- migrator wraps each file in BEGIN/COMMIT and CONCURRENTLY can't
-- run inside a transaction. At current scale metric_counters has
-- ≤ 30 days of low-volume rows (retention sweep at workers/
-- retentionSweeper.ts:64) so the index build is sub-second and the
-- exclusive lock window is negligible. If this table grows past
-- millions of rows in a single emit window, switch this migration
-- to a standalone `psql -c "CREATE INDEX CONCURRENTLY ..."` script
-- run outside the migrator.
CREATE INDEX IF NOT EXISTS idx_metric_counters_v4_dashboard
  ON metric_counters (name, bucket DESC)
  WHERE name IN (
    'v4.stage_timing.evaluated',
    'v4.b4.claim_extracted_vs_playbook',
    'v4.classifier.classified',
    'v3.sentinel_matcher.fired'
  );

COMMENT ON INDEX idx_metric_counters_v4_dashboard IS
  'v4 Phase 21 — partial index covering the metric names read by the /admin/v4/* dashboards (stage-timing, claim-coverage, stage-confidence, sentinel-coverage). Excludes high-volume non-dashboard names so the index leaf stays small and admin queries plan toward a tight index scan.';
