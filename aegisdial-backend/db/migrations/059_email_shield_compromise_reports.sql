-- Email Shield — Pillar 3: account-compromise report log.
--
-- One row per /v1/email/compromise-check run. The compromise check is
-- the differentiator that nothing consumer-grade does today: a
-- real-time audit of inbox-rule tampering, OAuth grants, sent-folder
-- anomalies, login anomalies, and HIBP exposure.
--
-- The findings JSONB carries the typed result from each detector
-- (inbox_rules, oauth_grants, suspicious_sent, login_anomalies,
-- breach_exposure). The overall_verdict is the composite:
--   'clean'       — no findings worth surfacing
--   'concerns'    — at least one finding but ambiguous
--   'compromised' — high-confidence signal (e.g., external forward
--                   rule + recent sent-folder wire request)
--
-- RETENTION: 90 days. Reports are higher-value than per-message scans
-- (a user might re-check a month later and want to see the historic
-- baseline). Family Plan visibility requires the parent fetch within
-- that window.
--
-- PRIVACY POSTURE:
--   - findings are descriptive (rule action types, app names, login
--     city/country, breach domain names) — never raw payloads (email
--     bodies, OAuth tokens, IP addresses)
--   - app names are stored plaintext because they're public Google /
--     Microsoft app registry identifiers
--   - breach exposure stores breach domain names; the user's email
--     itself is implied by the row's user_id and never duplicated
--     into findings
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS email_compromise_reports (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_account_id         UUID         NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  -- Composite verdict across all five detectors.
  overall_verdict          TEXT         NOT NULL CHECK (overall_verdict IN ('clean', 'concerns', 'compromised')),
  -- Typed findings. Shape:
  --   {
  --     inbox_rules: { external_forwards: [...], hide_rules: [...] },
  --     oauth_grants: { unrecognized: [...], excessive_scope: [...] },
  --     suspicious_sent: { wire_request_drafts: [...], invoice_redirects: [...] },
  --     login_anomalies: { unusual_geo: [...], unusual_device: [...] },
  --     breach_exposure: { breaches: [{ domain, leaked_at }] }
  --   }
  -- Each detector contributes its own slice; missing keys = clean.
  findings                 JSONB        NOT NULL DEFAULT '{}'::jsonb,
  generated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Hot path: "show me my compromise check history" for this user +
-- account, newest first.
CREATE INDEX IF NOT EXISTS idx_email_compromise_reports_user_time
  ON email_compromise_reports (user_id, generated_at DESC);

-- Per-account drill-down: "show me reports for this specific inbox".
-- Used when a user has multiple linked accounts and wants to see one
-- inbox's compromise history.
CREATE INDEX IF NOT EXISTS idx_email_compromise_reports_account_time
  ON email_compromise_reports (email_account_id, generated_at DESC);

-- Retention sweep DELETE.
CREATE INDEX IF NOT EXISTS idx_email_compromise_reports_generated_at
  ON email_compromise_reports (generated_at);

COMMENT ON TABLE email_compromise_reports IS
  'Email Shield — account-compromise audit reports. One row per /v1/email/compromise-check run. Composite verdict across inbox-rule, OAuth-grant, suspicious-sent, login-anomaly, and HIBP-exposure detectors.';

COMMENT ON COLUMN email_compromise_reports.findings IS
  'Typed findings JSONB. Keys: inbox_rules, oauth_grants, suspicious_sent, login_anomalies, breach_exposure. Missing key = detector found nothing.';
