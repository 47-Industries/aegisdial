-- Email Shield — per-user scanning mode setting.
--
-- Mirror of migration 055 (sms_scan_mode). The iOS app reads this
-- value on app launch to decide what UI to render for Email Shield:
--   'disabled'    — user opted out. iOS does not surface the link-
--                   inbox flow or the compromise-check tab.
--   'manual_only' — link UI + compromise-check available, but the
--                   polling worker SKIPS this user's email_accounts
--                   (no background scoring). The user runs an
--                   explicit "scan now" or "check compromise"
--                   action from iOS.
--   'auto'        — link UI + compromise-check available + polling
--                   worker scans incoming mail in the background
--                   and writes verdicts to email_scans.
--
-- ENFORCEMENT MODEL (mirror of migration 055):
-- The polling worker reads this column when deciding whether to
-- dispatch a poll. The /v1/email/* routes that surface USER-
-- INITIATED actions (link, manual scan, compromise check) ignore
-- this — those work in all three modes because they're explicit
-- intents. Only background polling is gated.
--
-- Default is 'manual_only' — least surprise. The link flow works,
-- the compromise check works, but we don't read mail in the
-- background until the user explicitly opts in.
--
-- Idempotent + additive.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_scan_mode TEXT
    CHECK (email_scan_mode IN ('disabled', 'manual_only', 'auto'))
    NOT NULL DEFAULT 'manual_only';

COMMENT ON COLUMN users.email_scan_mode IS
  'Email Shield onboarding selection — disabled / manual_only / auto. Set via /v1/email/settings; iOS reads this on launch to decide what surface to render. Background-polling worker reads this to skip users in non-auto modes.';
