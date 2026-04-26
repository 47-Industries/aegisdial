-- Daily verification log for HIGH_SPOOF_TARGETS. We scrape each institution's
-- contact page, extract phone numbers, and compare against what's in our
-- registry. A wrong number in the registry is the single worst failure mode
-- of the product (would mark a scammer-spoofed call as "trusted"), so this
-- job runs daily and alerts on drift.
--
-- We keep 90 days of history so anyone can answer "did Chase's fraud line
-- change mid-quarter?" without re-scraping.

CREATE TABLE IF NOT EXISTS spoof_target_verifications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_name           TEXT NOT NULL,
  target_category       TEXT NOT NULL,
  contact_url           TEXT NOT NULL,
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  http_status           INT,
  numbers_on_page       TEXT[] NOT NULL DEFAULT '{}',
  numbers_expected      TEXT[] NOT NULL DEFAULT '{}',
  numbers_verified      TEXT[] NOT NULL DEFAULT '{}',
  numbers_drift_missing TEXT[] NOT NULL DEFAULT '{}',
  numbers_drift_new     TEXT[] NOT NULL DEFAULT '{}',
  status                TEXT NOT NULL CHECK (status IN ('verified', 'drift', 'fetch_failed', 'no_numbers_on_page')),
  error_message         TEXT
);

CREATE INDEX IF NOT EXISTS idx_spoof_verif_target_time
  ON spoof_target_verifications (target_name, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_spoof_verif_status_time
  ON spoof_target_verifications (status, fetched_at DESC)
  WHERE status IN ('drift', 'fetch_failed');
