-- SMS Shield — manual-paste scan audit log.
--
-- One row per /v1/sms/score call. Used for:
--   1. User's own scan history (iOS recap of "what I checked")
--   2. Family Plan visibility (parent sees Mom's flagged scans)
--   3. Retroactive calibration (was the user-reported scam something
--      we'd have flagged auto-side too?)
--
-- Privacy posture:
--   - body_sha256: SHA-256 of the message body, NOT the plaintext.
--     Aligns with services/smsClassify.ts which also stores only the
--     hash from the unauthenticated Apple-filter path. Manual-paste
--     is authenticated and the user typed it themselves, but storing
--     plaintext on the server creates an exfiltration surface the
--     product promise doesn't require.
--   - body_excerpt: first 80 chars, redacted by the route layer
--     (digit sequences scrubbed). Lets the user say "show me what
--     I scanned" without round-tripping the full message.
--   - sender_e164: nullable; user often pastes a body without sender
--     context, and an iOS Messages Filter Extension can't always
--     extract it cleanly.
--
-- Retention: handled by retentionSweeper. Bucket at 30 days alongside
-- other PII-adjacent audit tables. Family Plan visibility requires
-- the parent fetch within that window.

CREATE TABLE IF NOT EXISTS sms_scans (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Stable hash of the message body for dedup + audit. SHA-256.
  body_sha256     TEXT         NOT NULL,
  -- First 80 chars after digit redaction. Surfaced to the user in
  -- their own scan history; surfaced to Family Plan parents per
  -- the Family Plan ACL.
  body_excerpt    TEXT         NOT NULL,
  sender_e164     TEXT,
  -- 0..100, same scale as Live Shield risk_score.
  fraud_score     SMALLINT     NOT NULL CHECK (fraud_score BETWEEN 0 AND 100),
  -- 'safe' | 'suspicious' | 'fraud'.
  verdict         TEXT         NOT NULL CHECK (verdict IN ('safe', 'suspicious', 'fraud')),
  -- Categories matched (smishing_bait, time_pressure, etc.). JSONB
  -- so we can slice in SQL later without per-category schema churn.
  triggered_categories JSONB   NOT NULL DEFAULT '[]'::jsonb,
  -- Reasons surfaced to the user, capped at 8 strings.
  reasons         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- URL findings, including which URLs were flagged. JSONB.
  url_findings    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- How the scan was triggered:
  --   'manual'        : user pasted into the app
  --   'auto_filter'   : Apple Message Filter Extension (future —
  --                     today /v1/sms-classify doesn't persist
  --                     per-user because it's unauthenticated by
  --                     Apple's design)
  source          TEXT         NOT NULL CHECK (source IN ('manual', 'auto_filter')) DEFAULT 'manual',
  scanned_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Hot path: "show me this user's recent scans, newest first".
CREATE INDEX IF NOT EXISTS idx_sms_scans_user_time
  ON sms_scans (user_id, scanned_at DESC);

-- Family Plan: "show me a member's flagged scans (fraud + suspicious)
-- in the last N days". Partial index keeps it small — `safe` rows
-- never need to surface to a family member because there's nothing
-- to act on.
CREATE INDEX IF NOT EXISTS idx_sms_scans_user_flagged_time
  ON sms_scans (user_id, scanned_at DESC)
  WHERE verdict IN ('suspicious', 'fraud');

COMMENT ON TABLE sms_scans IS
  'SMS Shield — manual-paste scan audit log. One row per /v1/sms/score call. Body stored as SHA-256 + 80-char digit-redacted excerpt only — no plaintext at rest.';
