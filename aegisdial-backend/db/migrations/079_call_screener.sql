-- Call Screener: Twilio-powered AI call screening for forwarded calls.
-- Each Pro user can provision one Twilio number; unanswered calls
-- forward to it, the AI greets the caller, transcribes, and classifies.

CREATE TABLE IF NOT EXISTS screener_numbers (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  twilio_sid    TEXT NOT NULL,              -- Twilio IncomingPhoneNumber SID
  phone_e164    TEXT NOT NULL,              -- e.g. +12125551234
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at   TIMESTAMPTZ,
  UNIQUE (user_id, active)                 -- one active number per user
);

CREATE INDEX idx_screener_numbers_user ON screener_numbers (user_id) WHERE active;
CREATE UNIQUE INDEX idx_screener_numbers_e164 ON screener_numbers (phone_e164) WHERE active;

CREATE TABLE IF NOT EXISTS screened_calls (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  twilio_call_sid TEXT NOT NULL UNIQUE,
  from_e164     TEXT NOT NULL,              -- caller's number
  to_e164       TEXT NOT NULL,              -- the screener number
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  duration_secs INTEGER,
  -- AI analysis results
  transcript_ct TEXT,                       -- encrypted full transcript
  risk_score    INTEGER,                    -- 0-100 from scam pipeline
  risk_level    TEXT,                       -- low/medium/high/critical
  scam_type     TEXT,                       -- playbook id if detected
  verdict       TEXT NOT NULL DEFAULT 'pending', -- pending/safe/scam/unknown
  summary       TEXT,                       -- human-readable 1-line summary
  -- Outcome
  forwarded     BOOLEAN NOT NULL DEFAULT false,
  forwarded_at  TIMESTAMPTZ,
  caller_name   TEXT,                       -- extracted from greeting
  caller_purpose TEXT,                      -- extracted from greeting
  -- Push notification
  push_sent     BOOLEAN NOT NULL DEFAULT false,
  push_sent_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_screened_calls_user ON screened_calls (user_id, created_at DESC);
CREATE INDEX idx_screened_calls_pending ON screened_calls (verdict) WHERE verdict = 'pending';
