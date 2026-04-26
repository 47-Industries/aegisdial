-- Allow subscriptions.provider = 'admin_grant' so Kyle can manually grant a
-- 30-day Recovery Pro window to users he meets via r/Scams, AARP partnerships,
-- conference-floor conversations, etc. — bypassing StoreKit entirely.
--
-- The existing CHECK constraint (migration 003) only allowed 'apple_storekit'
-- and 'stripe'. Drop + recreate with 'admin_grant' added. currentTier() is
-- provider-agnostic — it reads status + current_period_end only — so no code
-- path needs to learn about the new value beyond the INSERT in the admin
-- route that now writes it.

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_provider_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_provider_check
  CHECK (provider IN ('apple_storekit', 'stripe', 'admin_grant'));
