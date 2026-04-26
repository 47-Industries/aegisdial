-- 030_users_app_account_token.sql
--
-- Adds `app_account_token` to `users` — a stable per-user UUID that the
-- iOS client sets on StoreKit Product.purchase(options:) via
-- .appAccountToken(UUID). Apple signs that value into the transaction
-- JWS so the backend can verify the transaction actually belongs to the
-- caller and reject replay attempts where user B submits user A's JWS.
--
-- Values are generated server-side on first /subscription/apple/verify
-- call that lacks one, then returned to the iOS client via
-- /subscription/status so subsequent purchases include it.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS app_account_token UUID
    NOT NULL DEFAULT gen_random_uuid();

-- Case-insensitive uniqueness — Apple may return the UUID in upper or
-- lower case depending on the SDK version.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_app_account_token_ci
  ON users (LOWER(app_account_token::text));

COMMENT ON COLUMN users.app_account_token IS
  'Per-user UUID bound to StoreKit transactions via appAccountToken. Do not expose to other users.';
