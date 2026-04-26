-- Recovery Concierge: the post-scam state machine. When a user (or someone
-- on their family plan) tells us "I just got scammed," we open a session,
-- hand them a sequence of concrete actions ranked by urgency, and track
-- which they've completed.
--
-- Steps are template-driven (see src/lib/recoverySteps.ts) — this table
-- just stores a frozen snapshot of the step kind + status per session so
-- we can evolve the template catalog without migrating old sessions.

CREATE TABLE IF NOT EXISTS recovery_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_plan_id    UUID REFERENCES family_plans(id) ON DELETE SET NULL,
  scam_e164         TEXT,
  amount_lost_cents INT,
  scam_type         TEXT,
  description       TEXT,
  status            TEXT NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')) DEFAULT 'active',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recovery_sessions_user_time
  ON recovery_sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_recovery_sessions_active
  ON recovery_sessions (user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS recovery_steps (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES recovery_sessions(id) ON DELETE CASCADE,
  step_key          TEXT NOT NULL,
  ordinal           INT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  cta_label         TEXT,
  cta_url           TEXT,
  phone_to_call     TEXT,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped')) DEFAULT 'pending',
  completed_at      TIMESTAMPTZ,
  UNIQUE (session_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_recovery_steps_session
  ON recovery_steps (session_id, ordinal);
