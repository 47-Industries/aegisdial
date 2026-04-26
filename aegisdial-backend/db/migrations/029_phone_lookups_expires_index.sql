-- Fix: migration 028's `idx_phone_lookups_expires` used
--   `CREATE INDEX ... ON phone_lookups (expires_at) WHERE expires_at > NOW()`
-- which Postgres REJECTS because `NOW()` is not immutable and cannot
-- appear in a partial-index predicate. If migration 028 applied
-- successfully in your environment it did so because the predicate was
-- silently evaluated with a pinned NOW() at index creation time,
-- making the index wrong for every subsequent query. Drop + recreate
-- without the predicate; a full-table index on `expires_at` is the
-- right shape for TTL sweeps.

DROP INDEX IF EXISTS idx_phone_lookups_expires;

CREATE INDEX IF NOT EXISTS idx_phone_lookups_expires
  ON phone_lookups (expires_at);
