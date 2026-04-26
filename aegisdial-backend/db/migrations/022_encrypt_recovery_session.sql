-- Envelope-encrypt the free-form user-entered fields on recovery_sessions.
-- `description` is whatever the victim typed about the scam. `scam_e164` is
-- the number they were contacted from. Both are PII / incident-sensitive.
--
-- scam_type and amount_lost_cents stay in plaintext — non-identifying and
-- needed for server-side step selection + cohort analytics.

ALTER TABLE recovery_sessions
  ADD COLUMN IF NOT EXISTS description_ct TEXT,
  ADD COLUMN IF NOT EXISTS scam_e164_ct TEXT;

COMMENT ON COLUMN recovery_sessions.description_ct IS
  'AES-256-GCM ciphertext of description. Readable via src/lib/crypto.ts.';
COMMENT ON COLUMN recovery_sessions.scam_e164_ct IS
  'AES-256-GCM ciphertext of the scammer-side phone number.';
