CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS numbers (
  e164                       TEXT PRIMARY KEY,
  first_seen                 TIMESTAMPTZ DEFAULT NOW(),
  last_seen                  TIMESTAMPTZ DEFAULT NOW(),
  mention_count_all          INT NOT NULL DEFAULT 0,
  mention_count_30d          INT NOT NULL DEFAULT 0,
  sources                    JSONB,
  sentiment_avg              REAL NOT NULL DEFAULT 0,
  sentiment_neg_ratio        REAL NOT NULL DEFAULT 0,
  scam_categories            TEXT[],
  stir_shaken_attestation    CHAR(1),
  line_type                  TEXT NOT NULL DEFAULT 'unknown',
  carrier                    TEXT,
  number_age_days            INT,
  business_match             JSONB,
  spoof_reports_30d          INT NOT NULL DEFAULT 0,
  trust_score                SMALLINT,
  verdict                    TEXT,
  summary                    TEXT,
  score_computed_at          TIMESTAMPTZ,
  score_version              INT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_numbers_last_seen ON numbers (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_numbers_score ON numbers (trust_score) WHERE trust_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_numbers_score_computed ON numbers (score_computed_at NULLS FIRST);

CREATE TABLE IF NOT EXISTS mentions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  e164            TEXT NOT NULL,
  source          TEXT NOT NULL,
  source_ref      TEXT,
  url             TEXT,
  snippet         TEXT,
  sentiment       TEXT CHECK (sentiment IN ('positive','neutral','negative')),
  scam_category   TEXT,
  severity        SMALLINT,
  weight          REAL NOT NULL DEFAULT 0.5,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mentions_e164_created ON mentions (e164, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mentions_source ON mentions (source, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mentions_source_ref ON mentions (source, source_ref)
  WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  e164        TEXT NOT NULL,
  category    TEXT NOT NULL,
  note        TEXT,
  device_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_e164 ON reports (e164, created_at DESC);

CREATE TABLE IF NOT EXISTS feedback (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  e164           TEXT NOT NULL,
  user_verdict   TEXT NOT NULL,
  device_id      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_e164 ON feedback (e164, created_at DESC);

CREATE TABLE IF NOT EXISTS spoof_targets (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  category            TEXT NOT NULL,
  verified_numbers    TEXT[] NOT NULL,
  spoof_message       TEXT NOT NULL,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spoof_targets_numbers ON spoof_targets USING GIN (verified_numbers);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
