-- url_reputations used to store the full URL string verbatim. Any user-
-- submitted phishing link with query parameters would bring PII /
-- credentials / session tokens along for the ride, sit in our DB for 6
-- hours, and become cross-tenant via the shared cache. Remove it.
--
-- We keep the SHA-256 hash (primary key), plus a canonicalized
-- "redacted_host" column for debugging — just the hostname, no path,
-- no query, no auth. That's enough to understand which domains are
-- trending in the cache without leaking a single user's link.

ALTER TABLE url_reputations
  DROP COLUMN IF EXISTS url;

ALTER TABLE url_reputations
  ADD COLUMN IF NOT EXISTS redacted_host TEXT;

COMMENT ON COLUMN url_reputations.redacted_host IS
  'Hostname only (no path, no query, no userinfo). Populated by urlScan.ts.';
