-- Pre-attack signal — breach/dark-web exposure monitoring.
-- We let the user register identifiers (email, phone) to watch, and a
-- weekly worker pushes them through Enzoic's Exposures API. New
-- exposures become breach_alerts the user can see, dismiss, and react to.
--
-- Storage shape:
--   - value_hash    — SHA-256 of the normalized (lowercase + trim)
--                     identifier. Used for the unique-per-user index
--                     and for fast dedup.
--   - display_value — the plaintext identifier. Kept in plain text so
--                     background workers can re-scan without the user
--                     re-entering it, and so the UI can show a masked
--                     form. Pre-launch we plan to wrap this column in
--                     envelope encryption (KMS) so at-rest leaks don't
--                     expose user emails/phones. Until then the value
--                     sits at the same trust level as users.email.

CREATE TABLE IF NOT EXISTS monitored_identifiers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('email','phone')),
  value_hash     TEXT NOT NULL,
  display_value  TEXT NOT NULL,   -- pretty form for the UI ("ky***@gmail.com")
  last_scanned_at TIMESTAMPTZ,
  last_scan_exposure_count INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, kind, value_hash)
);

CREATE INDEX IF NOT EXISTS idx_monitored_identifiers_user
  ON monitored_identifiers (user_id);
CREATE INDEX IF NOT EXISTS idx_monitored_identifiers_scan_stale
  ON monitored_identifiers (last_scanned_at NULLS FIRST);

-- One row per (identifier, exposure) so we don't re-alert on the same
-- breach twice. Enzoic exposure IDs are stable.
CREATE TABLE IF NOT EXISTS breach_alerts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monitored_id      UUID NOT NULL REFERENCES monitored_identifiers(id) ON DELETE CASCADE,
  source            TEXT NOT NULL CHECK (source IN ('enzoic','hibp','mock')),
  exposure_id       TEXT NOT NULL,
  breach_title      TEXT NOT NULL,
  breach_date       DATE,
  source_domain     TEXT,
  data_types        TEXT[] NOT NULL DEFAULT '{}',
  entries_count     INT,
  severity          TEXT NOT NULL CHECK (severity IN ('info','warning','critical')) DEFAULT 'warning',
  description       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at      TIMESTAMPTZ,
  acknowledged_at   TIMESTAMPTZ,
  UNIQUE (monitored_id, source, exposure_id)
);

CREATE INDEX IF NOT EXISTS idx_breach_alerts_user_active
  ON breach_alerts (user_id, created_at DESC) WHERE dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_breach_alerts_user_all
  ON breach_alerts (user_id, created_at DESC);
