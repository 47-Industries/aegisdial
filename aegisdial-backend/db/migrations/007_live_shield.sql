-- Live Shield: in-call protection. When the user taps "Shield this call"
-- the iOS app opens a session, streams on-device transcription to the
-- backend in chunks, and we score the running transcript for scam
-- phrase patterns. The iOS app surfaces live warnings as the risk score
-- escalates.
--
-- Transcription is on-device (SFSpeechRecognizer). Two-party-consent
-- disclosure is presented before recording starts. Audio itself never
-- leaves the device — only redacted text.

CREATE TABLE IF NOT EXISTS call_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_e164        TEXT,
  direction        TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'unknown')) DEFAULT 'inbound',
  consent_given    BOOLEAN NOT NULL DEFAULT FALSE,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,
  duration_seconds INT,
  risk_score       INT NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  risk_level       TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  triggered_categories TEXT[] NOT NULL DEFAULT '{}',
  outcome          TEXT CHECK (outcome IN ('user_hung_up', 'user_completed', 'user_called_guardian', 'user_abandoned', 'unknown')),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_user_time
  ON call_sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_sessions_active
  ON call_sessions (user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_call_sessions_peer
  ON call_sessions (peer_e164) WHERE peer_e164 IS NOT NULL;

-- Each chunk of transcript the iOS app posts. Speaker is best-effort —
-- SFSpeechRecognizer doesn't diarize, so the client flags its own
-- mic-audio vs. ambient (which is primarily the caller in speakerphone).
CREATE TABLE IF NOT EXISTS transcript_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  seq           INT NOT NULL,
  speaker       TEXT NOT NULL CHECK (speaker IN ('caller', 'self', 'unknown')) DEFAULT 'unknown',
  text          TEXT NOT NULL,
  confidence    REAL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_transcript_events_session
  ON transcript_events (session_id, seq);

-- Every phrase match. Keeps per-session evidence so we can explain
-- *why* a warning fired and help the user understand the pattern.
CREATE TABLE IF NOT EXISTS scam_phrase_hits (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  transcript_event_id  UUID REFERENCES transcript_events(id) ON DELETE CASCADE,
  pattern_id           TEXT NOT NULL,
  category             TEXT NOT NULL,
  severity             INT NOT NULL CHECK (severity BETWEEN 1 AND 5),
  weight               REAL NOT NULL,
  matched_text         TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, pattern_id)
);

CREATE INDEX IF NOT EXISTS idx_scam_phrase_hits_session
  ON scam_phrase_hits (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scam_phrase_hits_pattern
  ON scam_phrase_hits (pattern_id);
