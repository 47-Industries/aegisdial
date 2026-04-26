-- Every customer-entered field in Recovery Concierge should be
-- envelope-encrypted at rest. Amounts are sensitive financial data —
-- "Alice lost $50,000" combined with a user_id is embarrassing in a
-- DB leak and is personally-identifying financial info under GDPR +
-- CCPA. Encrypt both the amount the victim reports losing and any
-- amount they later recover.
--
-- The plaintext columns stay for backward-compat with legacy rows;
-- new writes set plaintext to NULL and only populate the _ct column.
-- Aggregation consumers (bulkCrimeReporter) decrypt + sum in-app.

ALTER TABLE recovery_sessions
  ADD COLUMN IF NOT EXISTS amount_lost_cents_ct TEXT;

COMMENT ON COLUMN recovery_sessions.amount_lost_cents_ct IS
  'AES-256-GCM ciphertext of amount_lost_cents, stored as "<integer cents>". Readable via src/lib/crypto.ts.';

ALTER TABLE recovery_outcomes
  ADD COLUMN IF NOT EXISTS recovered_cents_ct TEXT;

COMMENT ON COLUMN recovery_outcomes.recovered_cents_ct IS
  'AES-256-GCM ciphertext of recovered_cents. Readable via src/lib/crypto.ts.';
