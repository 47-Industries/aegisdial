-- Observability + ops infrastructure:
--   metric_counters  — lightweight in-DB counters for anything we want
--                      to slice without standing up Prometheus. Keeps
--                      cost low during MVP; swap to a real TSDB later.
--   device_tokens    — APNs tokens per user (one phone can have many
--                      over time as the OS rotates them).
--   email_messages   — audit log of every email we dispatch through
--                      Resend. Gives us idempotency + debuggable bounces.
--   analytics_events — mirror of PostHog events for recovery when the
--                      vendor is down, plus lets us answer simple SQL
--                      funnel questions without a vendor round-trip.

CREATE TABLE IF NOT EXISTS metric_counters (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  tags       JSONB NOT NULL DEFAULT '{}'::JSONB,
  value      BIGINT NOT NULL DEFAULT 1,
  bucket     TIMESTAMPTZ NOT NULL DEFAULT date_trunc('minute', NOW()),
  UNIQUE (name, tags, bucket)
);

CREATE INDEX IF NOT EXISTS idx_metric_counters_name_bucket
  ON metric_counters (name, bucket DESC);

CREATE TABLE IF NOT EXISTS device_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  apns_token   TEXT NOT NULL,
  bundle_id    TEXT NOT NULL DEFAULT 'com.aegisdial.app',
  environment  TEXT NOT NULL CHECK (environment IN ('sandbox','production')) DEFAULT 'sandbox',
  device_model TEXT,
  app_version  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invalidated_at TIMESTAMPTZ,
  UNIQUE (user_id, apns_token)
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user_active
  ON device_tokens (user_id) WHERE invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS email_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  to_email      TEXT NOT NULL,
  template      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  provider_id   TEXT,  -- Resend message id
  status        TEXT NOT NULL CHECK (status IN ('queued','sent','failed','bounced','complained')) DEFAULT 'queued',
  error         TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_email_messages_user_time
  ON email_messages (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_status
  ON email_messages (status, created_at DESC);

CREATE TABLE IF NOT EXISTS analytics_events (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id TEXT,   -- used pre-signup
  event        TEXT NOT NULL,
  properties   JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_user_time
  ON analytics_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_time
  ON analytics_events (event, created_at DESC);

-- Retention: trim analytics > 180d, metrics > 30d. A cleanup job can
-- own this once we have one. Not enforced at schema level.
