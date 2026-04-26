-- Paid-subscription-only product. Drop the free + trial tiers; add the state
-- columns we need to track an active subscription from either App Store
-- StoreKit 2 (iOS purchases) or Stripe (email-user purchases).

-- 1. Drop the CHECK constraint bound to the old enum and replace.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tier_check;
ALTER TABLE users
  ALTER COLUMN tier DROP DEFAULT,
  ALTER COLUMN tier SET DEFAULT 'pending';
UPDATE users SET tier = 'pending' WHERE tier IN ('free', 'trial');
ALTER TABLE users
  ADD CONSTRAINT users_tier_check CHECK (tier IN ('pending', 'pro', 'expired', 'cancelled'));

-- 2. Per-user subscription state. Separate table so we can hold history
--    once we wire renewals / refunds / upgrades without bloating `users`.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider               TEXT NOT NULL CHECK (provider IN ('apple_storekit', 'stripe')),
  provider_product_id    TEXT NOT NULL,
  provider_transaction_id TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('active', 'in_grace', 'expired', 'revoked', 'cancelled')),
  current_period_start   TIMESTAMPTZ NOT NULL,
  current_period_end     TIMESTAMPTZ NOT NULL,
  auto_renew             BOOLEAN NOT NULL DEFAULT TRUE,
  raw_payload            JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_active
  ON subscriptions (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_subscriptions_expiry
  ON subscriptions (current_period_end) WHERE status = 'active';

-- 3. Remove the guest auth option entirely — keep the column but tighten
--    the allowed values for future signups.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_method_check;
ALTER TABLE users
  ADD CONSTRAINT users_auth_method_check CHECK (auth_method IN ('apple', 'email'));
