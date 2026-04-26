-- Envelope-encrypt the reply-to email on support tickets. Historically
-- we stored `email` in plaintext because staff need it to reply — but
-- the ticket subject + body are already encrypted at rest, so keeping
-- email plaintext is the one remaining PII leak on this table. Staff
-- still get the plaintext via the forwarded ops email + /auth/export.
--
-- Pattern (matches migrations 018 / 021 / 022): add a new `email_ct`
-- column, drop the legacy NOT NULL so dual-writes can land, and keep
-- the old column populated for the brief transitional window. A later
-- migration (tracked in TODO.md under Phase 2) will drop the plaintext
-- column once no legacy rows remain.

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS email_ct TEXT;

-- `email` may already be null for signed-in users (we fall back to the
-- user row). Leave the column as-is — the writer picks which side to
-- fill. We don't need to drop a NOT NULL because none was set.

COMMENT ON COLUMN support_tickets.email_ct IS
  'AES-256-GCM envelope ciphertext of reply-to email (v1:<iv>:<tag>:<ct>). Readable only via src/lib/crypto.ts.';
