-- Email Shield — inbox-tamper alerts.
--
-- Detects the BEC attacker move that the inbox-rule audit can't see:
-- manually deleting incoming mail from a hijacked session. The
-- attacker logs in, sees a wire-confirmation email arrive, deletes
-- it before the victim notices, then keeps the BEC thread alive on
-- their side. No forwarding rule, no filter — just keyboard +
-- mouse.
--
-- Detection signal: an email_scans row exists for a message that's
-- since been deleted from the user's inbox WITHIN N minutes of
-- arrival. The polling worker observes the delete event (Gmail
-- history.list messageDeleted, Graph delta tombstones, IMAP UID
-- gone) and calls inboxTamperDetector. If the message was benign
-- ('safe' verdict — the user has no obvious reason to delete it)
-- and the delete-after-arrival window is short, we INSERT a row
-- here and push "Did you delete this?" to the user.
--
-- User responds via /v1/email/tamper-alerts/:id/respond:
--   - 'confirmed' (yes I deleted it)        — false positive, dismissed
--   - 'denied'    (no, I didn't delete it)  — strong compromise signal
--   - 'expired'                             — 72h passed without response
--
-- A 'denied' response triggers a new email_compromise_reports row
-- with overall_verdict='compromised', so the existing iOS
-- compromise-check UI surfaces it.
--
-- PRIVACY: we store a reference to the email_scans row (which
-- already redacted body to subject_excerpt). No additional PII.
-- The push body is intentionally GENERIC ("an email was deleted
-- shortly after it arrived"); sender_domain + subject_excerpt are
-- carried in the APNs `data` payload and rendered only inside the
-- unlocked app. This avoids leaking inbox identity to lock screen,
-- CarPlay, watchOS, and macOS Continuity mirrors.
--
-- RETENTION: ceiling is 90 days (retentionSweeper.ts), but the
-- FK to email_scans has ON DELETE CASCADE — and email_scans is
-- swept at 30 days. Effective tamper-alert retention is therefore
-- ~30 days for the common case, with the 90d ceiling only mattering
-- when an open recovery session pins the parent scan row.
-- Pending alerts auto-flip to 'expired' at 72h via the
-- expireStaleTamperAlerts() step inside the daily retention cron.
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS email_tamper_alerts (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_account_id         UUID         NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  -- The scan that originally observed the message. Foreign-key so
  -- ON DELETE CASCADE handles retention sweep of email_scans
  -- (scans expire at 30d; alerts at 90d — alerts referencing a
  -- swept scan get dropped at the same time).
  scan_id                  UUID         NOT NULL REFERENCES email_scans(id) ON DELETE CASCADE,
  -- Sender domain (eTLD+1) for the push notification copy. We
  -- duplicate it here from email_scans so the push dispatcher
  -- doesn't need to join.
  sender_domain            TEXT         NOT NULL,
  -- subject_excerpt was already digit-redacted on insert into
  -- email_scans. Carry the same value forward — iOS renders it on
  -- the alert detail screen so the user knows which message we're
  -- asking about.
  subject_excerpt          TEXT         NOT NULL,
  -- How long after arrival the delete was observed, in seconds.
  -- The detector caps at WINDOW (~10 min by default); higher
  -- values are not flagged. Stored for operator dashboarding so
  -- we can tune the window after launch.
  delete_after_seconds     INTEGER      NOT NULL CHECK (delete_after_seconds >= 0),
  -- Status of the alert. State machine:
  --   pending   → confirmed | denied | expired
  --   confirmed / denied / expired are terminal.
  status                   TEXT         NOT NULL
    CHECK (status IN ('pending', 'confirmed', 'denied', 'expired'))
    DEFAULT 'pending',
  -- When the user actually tapped Confirm or Denied. NULL while
  -- pending AND for cron-expired rows (where no user response
  -- happened — the cron flips status to 'expired' but does NOT
  -- write a fake responded_at; created_at gives the timeline).
  responded_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Hot path: iOS pulls /v1/email/tamper-alerts?status=pending —
-- this query needs to be cheap. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS idx_email_tamper_alerts_user_pending
  ON email_tamper_alerts (user_id, created_at DESC)
  WHERE status = 'pending';

-- Cron sweep: find pending alerts older than 72h and mark expired.
CREATE INDEX IF NOT EXISTS idx_email_tamper_alerts_pending_age
  ON email_tamper_alerts (created_at)
  WHERE status = 'pending';

-- Retention sweep DELETE WHERE created_at < cutoff.
CREATE INDEX IF NOT EXISTS idx_email_tamper_alerts_created_at
  ON email_tamper_alerts (created_at);

-- Dedup constraint: one pending alert per (scan_id) max. If the
-- polling worker observes a delete event twice (history page
-- replay), the second INSERT is silently ignored via ON CONFLICT
-- DO NOTHING in the detector service.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_tamper_alerts_scan
  ON email_tamper_alerts (scan_id);

COMMENT ON TABLE email_tamper_alerts IS
  'Email Shield — "did you delete this?" alerts. Fired when the polling worker observes an email being deleted within N minutes of arrival. User response (confirmed/denied) feeds the compromise-check engine.';

COMMENT ON COLUMN email_tamper_alerts.delete_after_seconds IS
  'Seconds between message arrival (email_scans.scanned_at) and the observed delete event. Capped at the detector window (~600s by default). Stored for operator threshold tuning.';
