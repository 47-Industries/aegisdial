-- Identity Shield — per-user per-breach match record.
--
-- The join between identity_monitors (what we watch) and
-- identity_breaches (what's been exposed). One row per (user_id,
-- monitor_id, breach_id) triple. INSERT-once; the only UPDATE paths
-- are the user acknowledgment and remediation completion timestamps.
--
-- LIFECYCLE:
--   INSERT  — ingest worker discovers a monitor↔breach match
--   UPDATE  — user_acknowledged_at: user tapped through the alert
--   UPDATE  — remediation_completed_at: user followed the linked
--             Recovery flow and marked it done
--   DELETE  — only via CASCADE (user-delete or monitor-delete) or
--             retention sweep (cf. operator runbook for cadence)
--
-- SEVERITY VOCABULARY:
--   'informational'  — breach exposure only (email in a dump, no
--                       credential / SSN). User awareness, no action.
--   'caution'        — credential-pair match (email + hashed password),
--                       or sensitive class (DOB, address). Recommended
--                       action: rotate password, enable 2FA.
--   'critical'       — SSN exposure, ATO-grade combo (email + password
--                       + DOB), or active scammer-target listing.
--                       Push notification fires. Linked Recovery flow.
--
-- Severity is computed at INSERT time from the breach's data_classes
-- × monitor_kind matrix; a future re-evaluation pass MAY upgrade a
-- finding (e.g., new breach data discovered after initial insert
-- shows SSN was in the same dump).
--
-- PRIVACY POSTURE:
-- This table holds NO secrets — only references. The actual leaked
-- credential never crosses into our storage. Surfaced details come
-- from identity_breaches.data_classes + identity_breaches.breach_name
-- on read.
--
-- RETENTION: 90 days after remediation_completed_at; indefinite
-- otherwise (the user might come back to a 2-year-old breach when
-- a related new finding surfaces).
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS identity_breach_findings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The monitor row that matched. CASCADE on delete: removing a
  -- monitor takes its historical findings with it (the user's intent
  -- when DELETing a monitor is "stop watching AND forget").
  monitor_id                UUID NOT NULL REFERENCES identity_monitors(id) ON DELETE CASCADE,
  -- The breach row that contained the match. CASCADE on delete: if
  -- we ever drop a breach catalog row (retracted by provider), its
  -- findings go too — avoids dangling references on the iOS detail
  -- card.
  breach_id                 UUID NOT NULL REFERENCES identity_breaches(id) ON DELETE CASCADE,
  severity                  TEXT NOT NULL CHECK (severity IN ('informational','caution','critical')),
  -- When the ingest worker discovered the match.
  surfaced_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When the user opened the alert detail. NULL = unread.
  user_acknowledged_at      TIMESTAMPTZ,
  -- When the user completed the linked Recovery flow (e.g., rotated
  -- the password, froze the credit, requested an SSN trace). NULL =
  -- not yet remediated. Drives the dashboard "open findings" counter.
  remediation_completed_at  TIMESTAMPTZ,
  -- Dedup constraint: one finding per (user, monitor, breach) triple.
  -- The ingest worker may re-discover the same match on subsequent
  -- runs (HIBP re-sync, Enzoic re-check); ON CONFLICT DO NOTHING.
  UNIQUE (user_id, monitor_id, breach_id)
);

-- Hot path: iOS pulls "what new findings do I have?" — list view
-- ordered most-recent-first, filtered to unacknowledged. Partial
-- index keeps the working set small (acknowledged findings move out
-- of the hot index).
CREATE INDEX IF NOT EXISTS idx_findings_user_new
  ON identity_breach_findings(user_id, surfaced_at DESC)
  WHERE user_acknowledged_at IS NULL;

COMMENT ON TABLE identity_breach_findings IS
  'Identity Shield — per-user per-breach match record. INSERT-once on discovery; UPDATEs flip acknowledgment / remediation timestamps. UNIQUE(user_id, monitor_id, breach_id) prevents re-discovery duplicates on ingest re-runs.';

COMMENT ON COLUMN identity_breach_findings.severity IS
  'Computed at INSERT from breach data_classes × monitor_kind. May be upgraded by a later re-evaluation pass if a related breach exposes a more sensitive class (e.g., SSN).';

COMMENT ON COLUMN identity_breach_findings.remediation_completed_at IS
  'Set when the user finishes the linked Recovery flow (password rotation, credit freeze, SSN trace). Drives the dashboard "open findings" counter and the retention sweep window (90d post-completion).';
