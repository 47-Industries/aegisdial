-- Capture the exact Apple-reported reason we invalidated a device token.
--
-- Previously we flipped `invalidated_at` on BadDeviceToken / Unregistered /
-- TopicDisallowed without recording WHICH of those fired. That made it
-- impossible to distinguish "user uninstalled the app" (Unregistered —
-- expected churn) from "our p8 key rotated and apps need to re-provision"
-- (TopicDisallowed — incident). Adding the column lets us slice the
-- apns.token_invalidated metric stream in Postgres by reason and alert
-- on the bad ones.

ALTER TABLE device_tokens
  ADD COLUMN IF NOT EXISTS invalidation_reason TEXT;

-- Partial index on just the non-null values — the column is null for
-- every currently-active token, so filtering on it is cheap.
CREATE INDEX IF NOT EXISTS idx_device_tokens_invalidation_reason
  ON device_tokens (invalidation_reason)
  WHERE invalidation_reason IS NOT NULL;
