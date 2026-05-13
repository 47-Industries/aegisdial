-- Identity Shield — adversarial-review I-M3 (2026-05-12): user-phone /
-- user-email poisoning defense for the Telegram chatter listener.
--
-- ATTACK: A hostile channel can post a message like
--   "Burner number for sale, freshly carded: +1-415-555-0100"
-- where +1-415-555-0100 is a REAL user's actual phone. The classifier
-- emits the artifact with high confidence; the listener ingests it as
-- a caution/warning into active_threats; from that point on the target
-- user's OWN outbound calls get flagged by Live Shield's scorer hot
-- path. This is a single-message-low-cost denial-of-service against
-- arbitrary users — the most attractive poisoning vector in the entire
-- threat catalog.
--
-- DEFENSE: src/workers/telegramChatterListener.ts cross-checks each
-- inbound phone_e164 / email_address artifact against the users table
-- BEFORE ingestion. On a match the artifact is routed here (NOT into
-- active_threats) for admin review. The active_threats row is never
-- written; the scorer hot path never sees the poisoned identifier.
--
-- DESIGN NOTES:
--   - One row per (artifact, matched_user, provenance) chain. The
--     admin queue groups by artifact_value for triage.
--   - decision = 'approved' lets the admin push the row through to
--     active_threats out-of-band (a legitimate scammer who happens to
--     reuse a victim's old SIM, etc.). decision = 'rejected' is the
--     default expected outcome — the artifact was a poisoning attempt.
--   - matched_user_id FK with ON DELETE CASCADE so user-deletion
--     sweeps the queue clean (GDPR-friendly + retention-sweeper
--     compatible).
--   - artifact_kind CHECK pins the two kinds the listener routes
--     through this gate. crypto_wallet / url_host / ip_address are
--     not user-PII-shaped and don't go through this defense.
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS telegram_artifact_pending_review (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which classifier-emitted artifact kind tripped the user-match gate.
  artifact_kind         TEXT NOT NULL CHECK (artifact_kind IN ('phone_e164', 'email_address')),
  -- Normalized artifact value (E.164 / lowercased email). Same shape
  -- the active_threats partial index uses — admins can compare across.
  artifact_value        TEXT NOT NULL,
  -- The user whose identifier the artifact would have falsely flagged.
  matched_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Severity the classifier assigned (caution / warning). Tracked so
  -- the admin can see how aggressive the original ingest would have
  -- been. confirmed_scammer is impossible from the chatter path
  -- (severityFor() caps at warning) but the column accepts any value
  -- for future-compat.
  classified_severity   TEXT NOT NULL,
  -- telegram_channel:<channel_id>:<message_id> — same provenance
  -- string the active_threats row would have carried. Admins use this
  -- to trace back to the originating message in the chatter UI.
  provenance            TEXT NOT NULL,
  discovered_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Admin decision. NULL = pending; 'approved' = let it through to
  -- active_threats out of band; 'rejected' = poisoning confirmed.
  decision              TEXT CHECK (decision IN ('approved', 'rejected')),
  decided_at            TIMESTAMPTZ
);

-- Admin queue index — pending rows surface first, newest pending at
-- the top. Decided rows fall to the bottom and are sweep-eligible.
CREATE INDEX IF NOT EXISTS idx_telegram_artifact_pending_review_decision
  ON telegram_artifact_pending_review(decision, discovered_at DESC)
  WHERE decision IS NULL;

-- Reverse lookup: "which artifacts targeted this user?" — used by the
-- admin user-detail page to show all pending poisoning attempts.
CREATE INDEX IF NOT EXISTS idx_telegram_artifact_pending_review_user
  ON telegram_artifact_pending_review(matched_user_id);

COMMENT ON TABLE telegram_artifact_pending_review IS
  'Identity Shield I-M3 defense: telegram chatter artifacts that matched a real user (likely poisoning attempt). Held for admin review before any active_threats insert.';

COMMENT ON COLUMN telegram_artifact_pending_review.decision IS
  'NULL = pending. approved = admin pushed to active_threats out of band. rejected = confirmed poisoning attempt; do not ingest.';
