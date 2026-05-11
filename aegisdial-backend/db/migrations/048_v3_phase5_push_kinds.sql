-- Live Shield v3 — Phase 5 push-kind expansion.
--
-- The existing guardian_alerts.kind CHECK constraint pre-dates v3 and
-- does not include the new kinds Phase 2 + Phase 5 introduced:
--
--   shield_post_dismiss   — B3 post-dismiss family-alert escalation
--                           (this was a LATENT BUG in Phase 2: the
--                            TypeScript GuardianAlertKind union was
--                            extended but the SQL CHECK was not.
--                            firePostDismissFamilyAlert would have
--                            failed at the DB level in production
--                            with V3_B3_ENABLED=true.)
--   shield_takeover        — B3 + B4 critical-takeover delivery to the
--                            subject user (Mom's phone). Both features
--                            use the same kind; trigger_path in payload
--                            distinguishes B3 vs B4 for iOS routing.
--   block_retry            — A2: a previously-blocked number tried to
--                            call again. Low-priority push to the
--                            subject user.
--
-- Migration is additive-only via DROP-and-recreate of the constraint.
-- Safe to run against a live database; the recreate is atomic.

ALTER TABLE guardian_alerts DROP CONSTRAINT IF EXISTS guardian_alerts_kind_check;

ALTER TABLE guardian_alerts ADD CONSTRAINT guardian_alerts_kind_check
  CHECK (kind IN (
    -- v2 kinds (do not remove without compatibility check on existing rows)
    'shield_critical',
    'shield_family_emergency',
    'safe_word_failed',
    'breach_new',
    'recovery_started',
    -- v3 Phase 2 — B3 post-dismiss escalation
    'shield_post_dismiss',
    -- v3 Phase 5 — critical takeover delivery + A2 block-retry
    'shield_takeover',
    'block_retry'
  ));
