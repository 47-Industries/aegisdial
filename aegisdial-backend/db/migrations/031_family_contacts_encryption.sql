-- Encrypt the two pure-display PII columns on family_contacts —
-- `display_name` and `notes`. These are the "trusted contact dossier"
-- fields an attacker most wants to correlate: real-life first names
-- the user associates with phone numbers, plus any free-text notes
-- they've jotted down ("Grandma — don't call before 9am, ask about
-- her hip"). Encrypting them means a Neon snapshot leak no longer
-- hands an attacker a ready-made voice-cloning targeting list.
--
-- NOT encrypting `phone_e164` in this migration because liveShield.ts
-- and the by-phone lookup inside familyContacts.ts both query with
-- `WHERE phone_e164 = $1`. Moving to encrypted-at-rest phone numbers
-- would require adding a `phone_e164_hash` column everywhere those
-- reads happen, which is outside this agent's file scope (see
-- TODO.md, flagged as deferred). The current plaintext phone still
-- leaks the PII — we acknowledge this gap in TODO.md and defer the
-- full migration to a coordinated pass that touches liveShield.ts.
--
-- Pattern matches migrations 018 / 021 / 022: add *_ct columns,
-- leave the plaintext columns in place during the transitional
-- window, dual-write from the route handler, dual-read with
-- readMaybeEncrypted(). A later migration drops the plaintext
-- columns once no legacy rows remain.

ALTER TABLE family_contacts
  ADD COLUMN IF NOT EXISTS display_name_ct TEXT;

ALTER TABLE family_contacts
  ADD COLUMN IF NOT EXISTS notes_ct TEXT;

-- display_name was NOT NULL — relax it so the dual-write / eventual
-- drop-plaintext migration can land cleanly. We still enforce at the
-- app layer (zod min(1)) so no row gets inserted without a name.
ALTER TABLE family_contacts
  ALTER COLUMN display_name DROP NOT NULL;

COMMENT ON COLUMN family_contacts.display_name_ct IS
  'AES-256-GCM envelope ciphertext of display_name (v1:<iv>:<tag>:<ct>). Readable only via src/lib/crypto.ts.';
COMMENT ON COLUMN family_contacts.notes_ct IS
  'AES-256-GCM envelope ciphertext of notes (v1:<iv>:<tag>:<ct>). Readable only via src/lib/crypto.ts.';
