-- Adds a status column to monitored_identifiers so callers can tell
-- "actively monitoring" apart from "the provider hasn't shipped phone
-- coverage yet." Needed because lookupExposuresWithStatus can return a
-- sentinel (disabled: true) for phone identifiers today; previously we
-- had nowhere to persist that state, so iOS rendered "no exposures"
-- (false all-clear) on every phone the user added.
--
-- Values (TEXT instead of enum so future additions don't need a type
-- alter):
--   'active'            — normal; last_scanned_at is a real scan
--   'provider_disabled' — phone monitor, Enzoic phone coverage off;
--                          last scan short-circuited with 0 exposures
--   'paused'            — future; user-initiated temporary pause

ALTER TABLE monitored_identifiers
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_monitored_identifiers_status
  ON monitored_identifiers (user_id, status);
