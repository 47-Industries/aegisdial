-- Recovery Shield — P3c: generated legal-packet document store.
--
-- One row per generated legal document. The legalPacketGenerator
-- (P3c) is a multi-doc orchestrator that, on Recovery-Plus purchase,
-- emits the full packet for a recovery session:
--   ic3_complaint           — FBI IC3 complaint
--   ftc_complaint           — FTC ReportFraud
--   cfpb_complaint          — CFPB (bank-side failures)
--   state_ag_complaint      — 50-state AG (state-specific form lib)
--   affidavit               — notarized affidavit template (insurance)
--   demand_letter           — to recoverable entity (LLC / exchange /
--                             payment processor)
--   credit_freeze_request   — three-bureau credit freeze letter
--   police_report_draft     — state-specific form auto-fill
--   exchange_petition       — freeze-of-funds petition (also written
--                             by cryptoTraceAgent — stored here for
--                             admin packet visibility)
--   insurance_claim         — cyber/homeowner's policy claim draft
--
-- DISCLAIMER ENFORCEMENT:
--   Every generated doc has a strict top-of-page legal disclaimer:
--   "AegisDial is not your attorney. This document is a starting
--    template; consult a licensed attorney before filing or sending."
--   The user MUST tap "I understand" before a download URL is
--   produced — that timestamp is captured in
--   user_acknowledged_disclaimer_at. The PDF route refuses to serve
--   the file when the column is NULL. Adversarial-review surface:
--   make sure no code path bypasses this (legal liability is the
--   whole reason the disclaimer exists).
--
-- WHY state_jurisdiction:
--   doc_kind = 'state_ag_complaint' needs to know WHICH state AG.
--   The 50-state form library at src/data/stateAgComplaintForms.ts
--   keys on ISO-3166-2 ('US-FL', 'US-CA', etc.). Nullable for
--   doc_kinds where it doesn't apply (IC3, FTC are federal).
--
-- PDF STORAGE:
--   body_markdown is the canonical generated content (envelope-
--   encrypted because it carries the user's case narrative + PII).
--   pdf_url is an S3 pre-signed URL pointing to the rendered PDF
--   (nullable until the rendering worker produces it). PDFs are
--   re-renderable from the markdown if S3 ever drops one.
--
-- PII REDACTION:
--   The user's full SSN and full bank account numbers MUST be
--   redacted server-side BEFORE body_markdown is encrypted (per
--   adversarial-review item D). The generator collects last-4 only
--   into the document; full values never reach this table.
--
-- PRIVACY POSTURE:
--   - body_markdown: envelope-encrypted (v1:<iv>:<tag>:<ct>).
--     Contains case narrative + last-4 financial identifiers + the
--     user's name + address (the documents need this to be valid
--     filings).
--   - pdf_url: S3 pre-signed, ephemeral (15-min TTL). Re-issued on
--     each download request — the column stores the most recent
--     URL for convenience but the route always re-signs.
--
-- RETENTION: 365 days. Same logic as the trace cases — generated
-- documents may be referenced months later in legal proceedings.
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS legal_documents (
  id                              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recovery_session_id             UUID         NOT NULL REFERENCES recovery_sessions(id) ON DELETE CASCADE,
  -- doc_kind vocabulary. CHECK pins it; legalPacketGenerator.ts
  -- branches on this to pick the template + renderer.
  doc_kind                        TEXT         NOT NULL CHECK (doc_kind IN
    ('ic3_complaint','ftc_complaint','cfpb_complaint','state_ag_complaint',
     'affidavit','demand_letter','credit_freeze_request','police_report_draft',
     'exchange_petition','insurance_claim')),
  -- ISO-3166-2 jurisdiction code (e.g., 'US-FL'). NULL for federal
  -- doc_kinds (IC3, FTC) and for non-jurisdictional docs.
  state_jurisdiction              TEXT,
  -- Generated markdown body. ENVELOPE-ENCRYPTED. The packet
  -- generator emits markdown; the PDF renderer downstream
  -- decrypts → renders → uploads to S3.
  body_markdown                   TEXT         NOT NULL,
  -- S3 pre-signed URL. Nullable until the PDF renderer worker
  -- runs. The route layer re-signs on every download request; this
  -- column is a convenience cache.
  pdf_url                         TEXT,
  generated_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Legal-advice disclaimer acknowledgement. The PDF download
  -- route REFUSES to serve the file when this is NULL. Set by
  -- POST /v1/recovery/documents/:id/acknowledge.
  user_acknowledged_disclaimer_at TIMESTAMPTZ
);

-- Hot path: "show me my generated documents" for the iOS dashboard.
CREATE INDEX IF NOT EXISTS idx_legal_docs_user
  ON legal_documents (user_id, generated_at DESC);

-- Recovery session drill-down.
CREATE INDEX IF NOT EXISTS idx_legal_docs_session
  ON legal_documents (recovery_session_id);

COMMENT ON TABLE legal_documents IS
  'Recovery Shield — generated legal-packet documents (IC3 / FTC / CFPB / state AG / affidavit / demand letter / credit freeze / police report / exchange petition / insurance claim). body_markdown envelope-encrypted. PDF download requires user_acknowledged_disclaimer_at to be set.';

COMMENT ON COLUMN legal_documents.body_markdown IS
  'Generated markdown body, envelope-encrypted (v1:<iv>:<tag>:<ct>). Carries user narrative + last-4 financial identifiers + name/address. Full SSN / full account numbers redacted by the generator BEFORE encryption.';

COMMENT ON COLUMN legal_documents.state_jurisdiction IS
  'ISO-3166-2 code (e.g., US-FL) for state-specific docs. NULL for federal (IC3, FTC) and non-jurisdictional doc_kinds.';

COMMENT ON COLUMN legal_documents.user_acknowledged_disclaimer_at IS
  'Set when the user taps "I understand" on the legal-advice disclaimer modal. PDF download route refuses to serve the file when this is NULL — enforces the not-your-attorney disclaimer at the byte level.';
