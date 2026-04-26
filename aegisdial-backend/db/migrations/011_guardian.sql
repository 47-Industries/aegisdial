-- Guardian mode. Inside a family plan, members can mark one or more
-- adult children / caregivers as guardians. When anything scary
-- happens on the protected member's phone (shield escalates to
-- critical, safe-word verify fails, new breach exposure lands) the
-- guardian gets a row in guardian_alerts.
--
-- We deliberately don't put the notification transport (APNs) here —
-- this table is the source of truth for what SHOULD be pushed. A
-- separate worker reads it and calls APNs when we have a push token.
-- Until then the iOS app polls the unseen list on launch.

CREATE TABLE IF NOT EXISTS guardian_alerts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The family member the alert is about. For alerts about the
  -- guardian themselves (e.g. a test), this may equal guardian_user_id.
  subject_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_plan_id     UUID REFERENCES family_plans(id) ON DELETE SET NULL,
  kind               TEXT NOT NULL CHECK (kind IN (
                          'shield_critical',
                          'shield_family_emergency',
                          'safe_word_failed',
                          'breach_new',
                          'recovery_started'
                      )),
  severity           TEXT NOT NULL CHECK (severity IN ('info','warning','critical')) DEFAULT 'warning',
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_at            TIMESTAMPTZ,
  pushed_at          TIMESTAMPTZ  -- set when the APNs worker has delivered it
);

CREATE INDEX IF NOT EXISTS idx_guardian_alerts_unseen
  ON guardian_alerts (guardian_user_id, created_at DESC) WHERE seen_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_guardian_alerts_all
  ON guardian_alerts (guardian_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guardian_alerts_push_pending
  ON guardian_alerts (created_at) WHERE pushed_at IS NULL;
