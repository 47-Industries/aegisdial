-- Email Shield — Pillar 1 + 2: per-message verdict audit log.
--
-- One row per scored incoming message. Used for:
--   1. User's own scan history (iOS dashboard, mirror of /v1/sms/scans)
--   2. Family Plan visibility (parent sees their kid's flagged emails)
--   3. Cross-pool sender_domain reputation rollup
--   4. Retroactive calibration (operator: "were our BEC patterns
--      catching what we should have caught?")
--
-- PRIVACY POSTURE (same shape as SMS Shield):
--   - body NEVER stored. Plaintext does NOT persist.
--   - subject_excerpt: first 80 chars of the subject after digit
--     redaction. Lets the user see "what did I scan" without
--     round-tripping the original message.
--   - from_address_hash: sha256 of normalized lowercased
--     from-address. Enables sender-volume aggregation without
--     storing a directory of every address every user receives mail
--     from.
--   - sender_domain: eTLD+1 of the from-address, plaintext. Used
--     for global sender-domain reputation (a domain that hits
--     verdict='fraud' across many users gets surfaced to all users
--     who see mail from it).
--   - external_message_id: provider-issued. Gmail: Message-ID
--     header or Gmail messageId. Graph: Graph messageId. IMAP:
--     UIDVALIDITY:UID. Used to dedupe on re-poll; safe to store as
--     the provider already revealed it to us during fetch.
--
-- RETENTION: 30 days, swept by retentionSweeper. Family Plan
-- visibility requires the parent fetch within that window.
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS email_scans (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_account_id         UUID         NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  -- Provider-issued message identifier. NOT a hash — providers
  -- already revealed this to us. Used for dedupe on re-poll
  -- (history-id rewinds, IMAP UID collisions across re-links).
  external_message_id      TEXT         NOT NULL,
  -- SHA-256 of the lowercased normalized from-address. Lets us
  -- aggregate "how often has this sender hit this user" without
  -- holding a contact-list directory.
  from_address_hash        TEXT         NOT NULL,
  -- eTLD+1 of the sender domain, plaintext. Used for global
  -- reputation rollups across users. Indexed (see below) for the
  -- /admin/email-shield/top-flagged-domains query.
  sender_domain            TEXT         NOT NULL,
  -- First 80 chars after digit redaction. Surfaced in the user's
  -- own scan history; surfaced to Family Plan parents per the
  -- Family Plan ACL.
  subject_excerpt          TEXT         NOT NULL,
  -- 0..100, same scale as SMS Shield / Live Shield.
  fraud_score              SMALLINT     NOT NULL CHECK (fraud_score BETWEEN 0 AND 100),
  -- 'safe' | 'suspicious' | 'fraud'. Same vocabulary as SMS Shield.
  verdict                  TEXT         NOT NULL CHECK (verdict IN ('safe', 'suspicious', 'fraud')),
  -- Categories matched (bec_wire_request, display_name_mismatch,
  -- lookalike_domain, etc.). JSONB to slice later without schema churn.
  triggered_categories     JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- Reasons surfaced to the user, capped at 8 strings.
  reasons                  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- Per-URL findings, same shape as smsManualScore. Reuses urlScan.ts.
  url_findings             JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- Per-attachment findings: filename_hash, content_type, size,
  -- malicious (bool), threat_types (string[]), source
  -- ('virustotal'|'heuristic'|'cache').
  attachment_findings      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  scanned_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- One scoring decision per (account, external_message_id). On
  -- re-poll Gmail/Graph may surface the same message again with a
  -- bumped history cursor; the dedupe constraint keeps the audit log
  -- single-row per message. Conflicts overwrite (latest scoring
  -- wins) via an upsert in the scoring service.
  UNIQUE (email_account_id, external_message_id)
);

-- Hot path: "show this user's recent scans, newest first" for the
-- iOS dashboard. Mirror of idx_sms_scans_user_time.
CREATE INDEX IF NOT EXISTS idx_email_scans_user_time
  ON email_scans (user_id, scanned_at DESC);

-- Family Plan + flagged-only filter: parent fetches their child's
-- fraud/suspicious emails. Partial keeps it small (most mail is safe).
CREATE INDEX IF NOT EXISTS idx_email_scans_user_flagged_time
  ON email_scans (user_id, scanned_at DESC)
  WHERE verdict IN ('suspicious', 'fraud');

-- Global sender-domain reputation. Used by the admin "top flagged
-- sender domains" dashboard AND by the cross-pool scammer-graph
-- rollup (if a domain hits fraud across N users, surface it to all
-- users seeing it). Partial — only fraud verdicts count for
-- global reputation; suspicious is noisy.
CREATE INDEX IF NOT EXISTS idx_email_scans_sender_domain_fraud
  ON email_scans (sender_domain, scanned_at DESC)
  WHERE verdict = 'fraud';

-- Retention sweep DELETE WHERE scanned_at < cutoff. Lightweight
-- time-only index, same pattern as idx_sms_scans_scanned_at.
CREATE INDEX IF NOT EXISTS idx_email_scans_scanned_at
  ON email_scans (scanned_at);

COMMENT ON TABLE email_scans IS
  'Email Shield — per-message scoring audit log. One row per scored incoming message. Body never stored — only subject_excerpt (digit-redacted, 80 chars), from_address_hash, and sender_domain (plaintext for global reputation rollup).';

COMMENT ON COLUMN email_scans.external_message_id IS
  'Provider-issued message ID. Gmail/Graph: native messageId. IMAP: UIDVALIDITY:UID. Used to dedupe on re-poll.';

COMMENT ON COLUMN email_scans.sender_domain IS
  'eTLD+1 of from-address, plaintext. Used for global sender-domain reputation. Suspicious senders flagged across many users propagate to all users seeing mail from that domain.';
