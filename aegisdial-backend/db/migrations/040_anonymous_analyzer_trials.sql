-- 040_anonymous_analyzer_trials.sql
--
-- Tracks the 3-day free-trial window for anonymous (unauthed) users of
-- the Paste-a-Text scam analyzer. The wedge: a stranger downloads the
-- app or hits the web checker, pastes texts for 3 days, then we ask
-- them to sign up free to keep going (or convert to Pro / one-time
-- Recovery).
--
-- Anonymous identity is the iOS Keychain-stored UUID the client sends
-- as `anonymous_id` on every analyze-text request. Determined users
-- can wipe the keychain and get another 3 days — that's acceptable
-- bleed for a free top-of-funnel.

CREATE TABLE IF NOT EXISTS anonymous_analyzer_trials (
  anonymous_id   TEXT PRIMARY KEY,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_count  INTEGER NOT NULL DEFAULT 0
);

-- Used by the retention sweeper — anonymous trials older than 30 days
-- are deletable since the 3-day trial has long expired.
CREATE INDEX IF NOT EXISTS idx_anonymous_analyzer_trials_first_seen
  ON anonymous_analyzer_trials (first_seen_at);

COMMENT ON TABLE anonymous_analyzer_trials IS
  'Tracks first-use timestamp per anonymous_id for the 3-day Paste-a-Text '
  'free trial. After NOW() - first_seen_at > 3 days, the analyze-text '
  'endpoint returns 402 anonymous_trial_expired and iOS prompts signup.';
