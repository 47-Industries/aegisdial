-- Drop the lookup_history table.
--
-- This table has been in the schema since 002_users.sql but nothing in
-- the current code path INSERTs into it — only routes/stats.ts reads
-- from it, always returning 0. It's dead schema.
--
-- Rather than ship a misleading "lookups_all_time: 0" metric or wire a
-- half-baked INSERT path this close to launch, we remove the column.
-- When there's a real user story for lookup history (Lookup History
-- view is already in TODO.md Phase 2) we reintroduce the table
-- alongside the INSERT path, the retention policy, and the encryption
-- of stored e164 values all in one coherent migration.
--
-- stats.ts is updated in the same PR to drop the dead query and the
-- lookups_all_time field from the /v1/stats/summary response. The iOS
-- app ignores unknown fields, so older clients remain compatible.

DROP INDEX IF EXISTS idx_lookup_history_user_time;
DROP TABLE IF EXISTS lookup_history;
