-- Envelope-encrypt PII at rest. Two columns hold user-provided sensitive
-- data: monitored_identifiers.display_value (emails / phones we watch for
-- breaches) and recovery_evidence.payload (notes, wallet addrs, amounts,
-- transaction IDs entered during a scam recovery). We encrypt both at the
-- app layer with AES-256-GCM so a Postgres snapshot / Neon PITR leak would
-- yield only ciphertext.
--
-- Strategy: add new ciphertext columns alongside the old plaintext ones,
-- switch writes first, then flip reads, then drop the plaintext columns in
-- a follow-up migration once no old rows remain. (We're pre-launch so the
-- intermediate state is very short, but we follow the pattern anyway.)

ALTER TABLE monitored_identifiers
  ADD COLUMN IF NOT EXISTS display_value_ct TEXT;

COMMENT ON COLUMN monitored_identifiers.display_value_ct IS
  'AES-256-GCM envelope ciphertext of display_value (v1:<iv>:<tag>:<ct>). Readable only via src/lib/crypto.ts.';

ALTER TABLE recovery_evidence
  ADD COLUMN IF NOT EXISTS payload_ct TEXT;

COMMENT ON COLUMN recovery_evidence.payload_ct IS
  'AES-256-GCM envelope ciphertext of payload JSON. Readable only via src/lib/crypto.ts.';

-- payload loses its NOT NULL because writers fill payload_ct instead; keep
-- the default for readers that hit the old column while the migration is
-- rolling out.
ALTER TABLE recovery_evidence
  ALTER COLUMN payload DROP NOT NULL;
