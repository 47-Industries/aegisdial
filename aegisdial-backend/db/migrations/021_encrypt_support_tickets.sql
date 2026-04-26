-- Envelope-encrypt user-submitted support-ticket text. Users often paste
-- account numbers, phone numbers, and incident details into ticket
-- bodies — we shouldn't hold that in plaintext at rest.
--
-- We encrypt `body` (and `subject` in case the user puts sensitive context
-- there too). Staff need plaintext to reply, so the admin route decrypts
-- on read via src/lib/crypto.ts.

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS body_ct TEXT;

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS subject_ct TEXT;

ALTER TABLE support_tickets
  ALTER COLUMN body DROP NOT NULL;

ALTER TABLE support_tickets
  ALTER COLUMN subject DROP NOT NULL;

COMMENT ON COLUMN support_tickets.body_ct IS
  'AES-256-GCM envelope ciphertext of body (v1:<iv>:<tag>:<ct>). Readable only via src/lib/crypto.ts.';
COMMENT ON COLUMN support_tickets.subject_ct IS
  'AES-256-GCM envelope ciphertext of subject (v1:<iv>:<tag>:<ct>).';
