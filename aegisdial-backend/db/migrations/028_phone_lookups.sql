-- Public-info cache for phone numbers. When a user gets a call from an
-- unfamiliar number, we answer "who is this?" by enriching from one or
-- more provider APIs (Twilio Lookup V2, Ekata, IPQualityScore,
-- Numverify) and caching the result so repeat lookups for the same
-- number (huge for scam campaigns blasting thousands) don't re-bill us.
--
-- Privacy model: the `owner_name`, `address`, and `city` fields contain
-- PII about the caller (not the user), but they come from regulated
-- CNAM / subscriber-data feeds and are already "public record" per the
-- providers' TOS. Still — encrypt at rest because the combination of
-- (owner, address, phone) in a leak is a real risk.

CREATE TABLE IF NOT EXISTS phone_lookups (
  e164                  TEXT PRIMARY KEY,
  owner_name            TEXT,       -- plaintext placeholder (empty) — see _ct
  owner_name_ct         TEXT,       -- AES-256-GCM envelope
  line_type             TEXT,       -- mobile | landline | voip | toll_free | unknown
  carrier_name          TEXT,
  carrier_type          TEXT,
  country_code          TEXT,
  city                  TEXT,
  city_ct               TEXT,
  state_code            TEXT,
  address_ct            TEXT,       -- encrypted; concatenated street+city+state when available
  is_spoofable          BOOLEAN,    -- voip / toll_free / numbers with poor carrier attestation
  spam_risk_score       SMALLINT,   -- 0-100 from IPQualityScore if configured
  public_records_found  BOOLEAN NOT NULL DEFAULT FALSE,
  sources               TEXT[] NOT NULL DEFAULT '{}',  -- ['twilio_lookup_v2', 'ekata', 'ipqs']
  raw_payload           JSONB,      -- debugging; NOT surfaced to clients
  looked_up_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
);

COMMENT ON TABLE phone_lookups IS
  'Cache for phone-info enrichment from Twilio Lookup / Ekata / IPQS. 30-day TTL.';
COMMENT ON COLUMN phone_lookups.owner_name_ct IS
  'AES-256-GCM ciphertext of owner_name. Plaintext column kept empty as placeholder.';
COMMENT ON COLUMN phone_lookups.raw_payload IS
  'Last raw provider responses for debugging. Never expose to the client API.';

-- Postgres rejects NOW() in partial-index predicates (not IMMUTABLE).
-- Migration 029 also recreates this without the WHERE clause; we apply
-- the fix here directly so fresh DBs apply 028 cleanly.
CREATE INDEX IF NOT EXISTS idx_phone_lookups_expires
  ON phone_lookups (expires_at);
