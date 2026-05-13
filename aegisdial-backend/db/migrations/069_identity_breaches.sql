-- Identity Shield — global breach catalog.
--
-- NOT per-user. One row per distinct breach known to AegisDial, synced
-- from external providers (HIBP, Enzoic) and from internal observations
-- (a recovery case that exposes a new breach is INSERTable here with
-- source='aegisdial_internal').
--
-- WHY ONE GLOBAL CATALOG INSTEAD OF PER-USER ROWS:
-- Pre-aggregating breaches once into our own table makes per-user
-- matching a cheap SQL join against identity_monitors instead of a
-- paid API call per (user × identifier × day). The cost model in
-- RECOVERY_AND_IDENTITY_SHIELDS.md §6.E ($0.30/mo/Pro user) depends on
-- this: cache the catalog, diff monthly, do per-user matching locally.
--
-- SOURCE VOCABULARY:
--   'hibp'                — Have I Been Pwned API delta
--   'enzoic'              — Enzoic credential-exposure API
--   'aegisdial_internal'  — a recovery case that surfaces a breach we
--                           hadn't catalogued yet (rare; mostly small
--                           regional dumps that don't reach HIBP/Enzoic)
--
-- DATA_CLASSES VOCABULARY:
-- Plaintext array of HIBP-style class names (e.g., 'Email addresses',
-- 'Passwords', 'Phone numbers', 'Physical addresses', 'Social security
-- numbers'). Used for severity escalation in the findings layer: a
-- breach exposing SSN auto-escalates the per-user finding's severity
-- to 'critical'.
--
-- RETENTION: indefinite. Breach history is reference data; once
-- catalogued, never expired. Catalog grows ~50–200 rows/month.
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS identity_breaches (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human-readable name: "LinkedIn (2012)", "Exactis (2018)",
  -- "Twitter (2022)". Rendered in the iOS finding card.
  breach_name               TEXT NOT NULL,
  source                    TEXT NOT NULL CHECK (source IN
    ('hibp','enzoic','aegisdial_internal')),
  -- Provider's stable ID for re-sync delta. HIBP: the breach Name (e.g.,
  -- "LinkedIn"). Enzoic: their exposure ID. Internal: a UUID we mint.
  source_breach_id          TEXT NOT NULL,
  -- eTLD+1 of the breached service (e.g., "linkedin.com"). Used for
  -- the dashboard "service-level" rollup ("you have 4 monitored
  -- identifiers exposed across 3 services").
  domain                    TEXT,
  -- When the breach actually occurred (per provider). NULL if unknown
  -- to the provider (some HIBP entries omit it).
  breach_date               DATE,
  -- When the provider catalogued the breach (their "added" timestamp).
  added_date                TIMESTAMPTZ,
  -- Record count claimed by the provider. BIGINT because some dumps
  -- exceed INT range (Exactis: 340M; some aggregator dumps: 8B+).
  pwn_count                 BIGINT,
  -- HIBP-style array of leaked data classes. See header comment for
  -- vocabulary. Empty array if the provider reports no class detail.
  data_classes              TEXT[] NOT NULL DEFAULT '{}',
  -- HIBP "verified" flag (provider claims the breach data is authentic
  -- vs. a sample/test). Drives a more confident severity rating.
  is_verified               BOOLEAN NOT NULL DEFAULT FALSE,
  -- HIBP "sensitive" flag (e.g., Ashley Madison). UI dampens copy on
  -- sensitive breaches to avoid stigma on the user.
  is_sensitive              BOOLEAN NOT NULL DEFAULT FALSE,
  -- Provider-supplied description; rendered in the breach detail card.
  description               TEXT,
  -- Wall-clock of our most recent sync. Used by the worker to decide
  -- which breaches need re-fetch (provider sometimes updates).
  synced_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Dedup constraint: a single breach in a single source has exactly
  -- one row. Re-sync paths UPSERT via ON CONFLICT (source, source_breach_id).
  UNIQUE (source, source_breach_id)
);

-- Hot path: admin "what breaches arrived this week" query + the
-- dashboard "new breaches in last 7d" counter. Descending sort on
-- synced_at means the most recent rows are first in the index.
CREATE INDEX IF NOT EXISTS idx_breaches_recent
  ON identity_breaches(synced_at DESC);

COMMENT ON TABLE identity_breaches IS
  'Identity Shield — global breach catalog. NOT per-user. Synced from HIBP + Enzoic + internal recovery-case observations. Per-user matching joins this table with identity_monitors locally — avoids a paid API call per (user × identifier).';

COMMENT ON COLUMN identity_breaches.source_breach_id IS
  'Provider stable identifier for delta-sync. HIBP: breach Name slug. Enzoic: exposure ID. aegisdial_internal: minted UUID. UPSERT key is (source, source_breach_id).';

COMMENT ON COLUMN identity_breaches.data_classes IS
  'HIBP-style data-class names exposed by the breach. Drives severity escalation: a breach class containing "Social security numbers" auto-escalates the per-user finding to severity=critical.';

COMMENT ON COLUMN identity_breaches.pwn_count IS
  'Record count claimed by the provider. BIGINT because aggregator dumps (e.g., COMB) exceed 32-bit INT range.';
