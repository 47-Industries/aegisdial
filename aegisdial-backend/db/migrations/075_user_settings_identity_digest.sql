-- Identity Shield I-P5 — per-user push-digest cadence preference.
--
-- The Identity Shield digest worker (src/workers/identityShieldDigest.ts)
-- fans out two cron jobs:
--   1. Daily 13:00 UTC weekdays   — pushes 'daily' digest to users with
--                                    identity_digest_cadence='daily'.
--   2. Weekly Monday 13:00 UTC    — pushes 'weekly' digest to users with
--                                    identity_digest_cadence='weekly'.
-- 'off' opts the user out entirely. The worker also de-dups via a
-- Redis-backed last-pushed gate so a cron retry within 23h (daily) or
-- 6d (weekly) is a no-op.
--
-- Why a NEW table rather than extending users / family_alert_preferences:
-- the spec's product surface for I-P5 is "per-user settings shared across
-- shields" — Identity Shield's digest cadence today, Recovery's escalation
-- prefs / Email Shield's report cadence tomorrow. Putting the column on
-- users would couple Identity Shield's iOS settings UI to the auth-row
-- schema; putting it on family_alert_preferences would imply guardian-
-- alert semantics it doesn't have. A dedicated user_settings table is
-- the cleanest place for these preference flags, one row per user.
--
-- DEFAULTS:
-- 'weekly' is the safe default — engaged-Pro detection happens inside
-- the worker (Pro tier + ≥1 active monitor + ≥1 finding in the last 7d
-- → daily cadence offered in onboarding), not in the column default.
-- A fresh user gets weekly until they explicitly bump to daily, so the
-- push-notification surface is conservative-by-default.
--
-- Idempotent + additive. Backfill: every existing users row gets a
-- user_settings row at first read via the worker's "INSERT ... ON
-- CONFLICT DO NOTHING" pattern; we DO NOT pre-populate during the
-- migration (saves a long-running INSERT on the 600k-row users table
-- in prod and keeps the migration fast).

CREATE TABLE IF NOT EXISTS user_settings (
  user_id                     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  identity_digest_cadence     TEXT NOT NULL DEFAULT 'weekly'
    CHECK (identity_digest_cadence IN ('daily','weekly','off')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cron-path lookup index: "all users with cadence X" — driven by the
-- daily / weekly fan-out loops in identityShieldDigest.ts. Partial
-- indexes per cadence keep the scan tiny (most users will be 'weekly').
CREATE INDEX IF NOT EXISTS idx_user_settings_cadence_daily
  ON user_settings(user_id) WHERE identity_digest_cadence = 'daily';
CREATE INDEX IF NOT EXISTS idx_user_settings_cadence_weekly
  ON user_settings(user_id) WHERE identity_digest_cadence = 'weekly';

COMMENT ON TABLE user_settings IS
  'Per-user preference flags shared across product surfaces. One row per user, auto-created on first preference write. Identity Shield I-P5 introduces identity_digest_cadence; future shields extend this table.';

COMMENT ON COLUMN user_settings.identity_digest_cadence IS
  'Identity Shield push-digest cadence — daily / weekly / off. Default weekly (conservative). The worker chooses cadence per cron run; mismatches (e.g., daily cron + weekly-cadence user) are silently skipped.';
