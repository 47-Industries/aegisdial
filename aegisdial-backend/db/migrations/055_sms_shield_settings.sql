-- SMS Shield — onboarding mode + per-user settings.
--
-- The user picks during onboarding (or in settings later) how they
-- want SMS to be scanned:
--   'disabled'    — user opted out. iOS does not show the paste UI
--                   and does not register the ILMessageFilterExtension.
--   'manual_only' — paste-only. iOS shows the paste UI. No
--                   ILMessageFilterExtension permission requested.
--   'auto'        — paste UI + iOS prompts to enable the Messages
--                   Filter Extension. Once enabled in iOS Settings,
--                   Apple silently POSTs unknown-sender messages to
--                   /v1/sms-classify before delivery.
--
-- ENFORCEMENT MODEL (adversarial-review H1 clarification):
-- This setting is iOS-READABLE STATE, NOT a backend gate. The
-- backend cannot reject auto-scan requests by mode because Apple's
-- ILMessageFilterExtension architecture posts UNAUTHENTICATED
-- requests from Apple's edge CDN — there is no bearer, no JWT,
-- and the user_id is not derivable from the request. The actual
-- gate is the iOS-side permission registration; the iOS app reads
-- this column to decide:
--   (a) whether to display the paste UI on app launch
--   (b) whether to prompt the user to enable the filter extension
-- A user who flips to 'disabled' must rely on iOS to ALSO disable
-- the ILMessageFilterExtension in Settings → Messages → Unknown
-- & Spam. The iOS app spec for Dean has to enforce this round-trip.
--
-- Default is 'manual_only' — least surprise: paste UI works, no
-- iOS permission prompt unless the user explicitly chooses 'auto'.
--
-- Idempotent + additive. Safe against a production DB.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sms_scan_mode TEXT
    CHECK (sms_scan_mode IN ('disabled', 'manual_only', 'auto'))
    NOT NULL DEFAULT 'manual_only';

COMMENT ON COLUMN users.sms_scan_mode IS
  'SMS Shield onboarding selection — disabled / manual_only / auto. Set during onboarding via /v1/sms/settings; iOS reads this to know whether to prompt for ILMessageFilterExtension permission.';
