-- Envelope-encrypt Live Shield transcripts and matched phrases.
--
-- transcript_events.text contains the user's live call transcription —
-- highest-sensitivity data in the system. Phrase detection happens on the
-- server against the plaintext, then we persist only the ciphertext.
--
-- scam_phrase_hits.matched_text is the specific phrase that tripped a
-- pattern. That's a direct substring of the caller's speech; same
-- sensitivity class.
--
-- Migration 018 already added display_value_ct + payload_ct. This follows
-- the same pattern: new _ct columns, plaintext columns made nullable, new
-- writes go to ct, old rows stay readable until sweeper removes them.

ALTER TABLE transcript_events
  ADD COLUMN IF NOT EXISTS text_ct TEXT;

ALTER TABLE transcript_events
  ALTER COLUMN text DROP NOT NULL;

COMMENT ON COLUMN transcript_events.text_ct IS
  'AES-256-GCM envelope ciphertext of transcript text (v1:<iv>:<tag>:<ct>). Readable only via src/lib/crypto.ts.';

ALTER TABLE scam_phrase_hits
  ADD COLUMN IF NOT EXISTS matched_text_ct TEXT;

ALTER TABLE scam_phrase_hits
  ALTER COLUMN matched_text DROP NOT NULL;

COMMENT ON COLUMN scam_phrase_hits.matched_text_ct IS
  'AES-256-GCM envelope ciphertext of matched phrase (v1:<iv>:<tag>:<ct>). Readable only via src/lib/crypto.ts.';
