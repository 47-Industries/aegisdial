CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_method    TEXT NOT NULL CHECK (auth_method IN ('apple', 'email', 'guest')),
  apple_sub      TEXT UNIQUE,
  email          TEXT UNIQUE,
  email_hash     TEXT,
  device_id      TEXT UNIQUE,
  display_name   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tier           TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'trial'))
);

CREATE INDEX IF NOT EXISTS idx_users_apple_sub ON users (apple_sub) WHERE apple_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_device_id ON users (device_id) WHERE device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_attest_keys (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id           TEXT NOT NULL,
  public_key_pem   TEXT NOT NULL,
  counter          BIGINT NOT NULL DEFAULT 0,
  bundle_id        TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_app_attest_keys_user ON app_attest_keys (user_id);

CREATE TABLE IF NOT EXISTS lookup_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  e164           TEXT NOT NULL,
  trust_score    SMALLINT,
  verdict        TEXT,
  looked_up_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lookup_history_user_time ON lookup_history (user_id, looked_up_at DESC);
