-- Live Shield v2: per-user privacy preference for family-plan alerts.
-- Mom controls how much her family sees when Live Shield fires a critical alert:
--   minimal — risk score + scam type only       ("Mom: 87/100 — IRS impersonation")
--   default — risk score + matched red flags    ("...caller said: gift cards, pay now, IRS")
--   open    — risk score + live transcript link
--
-- Default preference for users who haven't picked one is 'default' (the
-- middle ground). UI explicitly invites Mom to choose during family-plan
-- onboarding, but the backend never blocks an alert on the absence of a row.

CREATE TABLE IF NOT EXISTS family_alert_preferences (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  privacy_level  TEXT NOT NULL DEFAULT 'default'
                 CHECK (privacy_level IN ('minimal', 'default', 'open')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
