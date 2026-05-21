-- 078_password_reset_codes.sql
--
-- Single-use 6-digit codes for the "Forgot password" flow on the
-- email auth path. Apple Sign In users don't touch this — Apple
-- handles their credential recovery.
--
-- Flow:
--   1. User taps "Forgot password" → POST /auth/email/forgot-password
--   2. Backend inserts a row here with a 6-digit code, sends it via
--      Resend (template = password_reset_code).
--   3. User receives code, enters it + new password →
--      POST /auth/email/reset-password
--   4. Backend matches code, marks row used_at = NOW(), updates
--      users.email_hash to bcrypt(new_password).
--
-- Codes expire in 15 minutes. Each user can only have ONE unused
-- code at a time (the UNIQUE partial index below) — a second
-- forgot-password request invalidates the first.

CREATE TABLE password_reset_codes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash     TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only ONE unused, unexpired code per user at a time. A new
-- forgot-password request will UPDATE the existing row (or the route
-- will invalidate the prior one first) so old codes can't pile up.
CREATE UNIQUE INDEX password_reset_codes_one_unused_per_user
  ON password_reset_codes (user_id)
  WHERE used_at IS NULL;

CREATE INDEX password_reset_codes_expires_at
  ON password_reset_codes (expires_at)
  WHERE used_at IS NULL;
