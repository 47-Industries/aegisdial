-- SMS / iMessage filter classifications. The iOS ILMessageFilterExtension
-- calls the backend for each unknown-sender message; we run the text
-- through the scam-phrase detector + URL reputation check and return
-- an action (allow | junk | promotion | transaction).
--
-- We store a SHA-256 hash of the text, never the plaintext body — SMS
-- content is sensitive PII and we don't need to re-read it once
-- scoring is complete. Sender is stored as-is (already in the metadata
-- layer the user sees on their own device).

CREATE TABLE IF NOT EXISTS sms_classifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  sender           TEXT,
  text_hash        TEXT NOT NULL,
  text_length      INT NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('allow', 'junk', 'promotion', 'transaction')),
  risk_score       INT NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  risk_level       TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  phrase_hits      TEXT[] NOT NULL DEFAULT '{}',
  url_hits         JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_classifications_user_time
  ON sms_classifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_classifications_sender
  ON sms_classifications (sender) WHERE sender IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_classifications_hash
  ON sms_classifications (text_hash);

-- URL reputation cache. Google Safe Browsing lookups aren't free (quota)
-- and we'll see the same shortlinks across users. Cache the result for
-- 6 hours (configurable in code).
CREATE TABLE IF NOT EXISTS url_reputations (
  url_hash         TEXT PRIMARY KEY,
  url              TEXT NOT NULL,
  is_malicious     BOOLEAN NOT NULL,
  threat_types     TEXT[] NOT NULL DEFAULT '{}',
  source           TEXT NOT NULL,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_url_reputations_checked
  ON url_reputations (checked_at DESC);
