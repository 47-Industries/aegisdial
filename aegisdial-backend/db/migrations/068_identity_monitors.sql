-- Identity Shield — Pillar 1 foundation: per-user monitor list.
--
-- One row per identifier the user wants AegisDial to watch for. The
-- ingest workers (HIBP/Enzoic deltas, Telegram chatter classifier,
-- darknet market crawler) cross-reference EVERY discovered artifact
-- against this table; a hit produces an identity_breach_findings row
-- (for breaches) or an active_threats row (for live chatter).
--
-- FIVE MONITOR KINDS, ONE TABLE:
--   'email'              — plaintext email address (already plaintext
--                          in email_accounts / contact channels)
--   'phone_e164'         — plaintext E.164-normalized phone number
--                          (already plaintext in users.phone_number)
--   'ssn_last4_hash'     — sha256( per_user_salt_hex || 'ssn4' ||
--                          ssn_last4 ). Plaintext SSN-last-4 is taken
--                          in the /v1/identity-shield/monitors POST
--                          body, hashed server-side IMMEDIATELY with
--                          the per-user salt + kind-tag 'ssn4', and the
--                          plaintext is discarded before INSERT. We
--                          NEVER persist plaintext SSN at any tier.
--   'dob_hash'           — sha256( per_user_salt_hex || 'dob' ||
--                          'YYYY-MM-DD' ). Same handling discipline as
--                          SSN.
--   'name_address_hash'  — sha256( per_user_salt_hex || 'na' ||
--                          'firstlast canonicalized|zip5' ). Composite-
--                          PII match for darknet listings that leak
--                          name+address pairs.
--
-- CANONICAL HASH SCHEME (load-bearing — do not drift):
--   digest = sha256( salt_hex || tag || plaintext )
--   tag ∈ {'ssn4', 'dob', 'na'} discriminates kind so an SSN-4 hash
--   cannot replay against the DOB column. Three call sites pin this
--   scheme: src/routes/identityShield.ts hashWithSalt() (INSERT path),
--   src/workers/darknetMarketCrawler.ts hashWithSalt() (match path),
--   and this comment. Any future change must touch all three together.
--   Adversarial-review I-H1 fix (2026-05-12) collapsed three previously-
--   drifted schemes onto this one.
--
-- PRIVACY POSTURE:
--   - SSN / DOB / name-address kinds: hash ONLY, with per-user salt.
--     Match against Enzoic/HIBP via THEIR pre-hashed indexes so the
--     plaintext never crosses our process boundary on outbound calls.
--   - Email / phone kinds: plaintext, because they're already
--     plaintext in user records (email_accounts, users.phone_number)
--     and the ingest workers need the literal value to compare
--     against literal values in HIBP / Enzoic / chatter feeds.
--   - salt_hex: 32 bytes hex-encoded; per (user_id, monitor_kind).
--     Rotated yearly; old hashes re-derived during sweep.
--     NULL for plaintext kinds (email, phone_e164).
--
-- RETENTION: indefinite while active=TRUE. Soft-deleted on DELETE
-- /v1/identity-shield/monitors/:id (sets active=FALSE; physical row
-- preserved 90d for audit, then swept).
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS identity_monitors (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Kind discriminates how watched_value is interpreted: literal
  -- value for email/phone, hash for SSN/DOB/composite-PII.
  monitor_kind              TEXT NOT NULL CHECK (monitor_kind IN
    ('email','phone_e164','ssn_last4_hash','dob_hash','name_address_hash')),
  -- Plaintext (for email/phone) OR hash (for SSN/DOB/composite-PII).
  -- SSN/DOB are NEVER stored plaintext. Email/phone are plaintext because
  -- they're already plaintext in email_accounts / user profile.
  watched_value             TEXT NOT NULL,
  -- Per-user salt for hash kinds. NULL for plaintext kinds. Hex-encoded
  -- 32 bytes (64 chars). Salt rotation re-derives the hash; the salt
  -- field itself changes, not the underlying SSN/DOB.
  salt_hex                  TEXT,
  -- Soft-delete flag. The DELETE route flips this to FALSE rather
  -- than DROPping the row so an audit can prove "the user did monitor
  -- this identifier at the time the breach surfaced."
  active                    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Dedup constraint: a user can't double-add the same identifier.
  -- For hash kinds the uniqueness key is (kind, hash), so adding the
  -- same SSN twice (even with different salt rotations across years)
  -- would still resolve to the same monitor row after the
  -- re-derivation sweep. Race-safe: ON CONFLICT (user_id, monitor_kind,
  -- watched_value) DO NOTHING in the POST route.
  UNIQUE (user_id, monitor_kind, watched_value)
);

-- Hot path: ingest workers iterate ALL active monitors for a given
-- (kind, value) when a new artifact surfaces. Partial index keeps the
-- scan small — inactive monitors don't participate in matching.
CREATE INDEX IF NOT EXISTS idx_monitors_active
  ON identity_monitors(user_id) WHERE active;

-- Reverse-lookup: "who's watching this artifact?" — driven by the
-- ingest workers (HIBP/Enzoic finds a breach record, scans all
-- monitor rows that share its (kind, value)).
CREATE INDEX IF NOT EXISTS idx_monitors_by_kind_value
  ON identity_monitors(monitor_kind, watched_value) WHERE active;

COMMENT ON TABLE identity_monitors IS
  'Identity Shield — per-user list of monitored identifiers. Email/phone stored plaintext; SSN/DOB/name-address stored as sha256(value || per_user_salt). UNIQUE(user_id, monitor_kind, watched_value) prevents accidental duplicates.';

COMMENT ON COLUMN identity_monitors.watched_value IS
  'Literal value for email/phone_e164; hash digest (hex) for ssn_last4_hash/dob_hash/name_address_hash. Plaintext SSN/DOB are NEVER persisted — hashed at the /v1/identity-shield/monitors POST boundary and the plaintext discarded before INSERT.';

COMMENT ON COLUMN identity_monitors.salt_hex IS
  'Per-user-per-kind salt for hash monitor kinds (32 bytes hex). NULL for plaintext kinds. Rotated yearly via re-derivation sweep.';

COMMENT ON COLUMN identity_monitors.active IS
  'Soft-delete flag. DELETE /v1/identity-shield/monitors/:id sets this FALSE; the row is preserved 90d for audit trail before physical sweep.';
