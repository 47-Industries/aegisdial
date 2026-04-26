-- Support tickets. Lightweight CRM so we can reply to user feedback
-- from a single admin dashboard without needing a Zendesk-style tool
-- at MVP. Apple App Store requires a working support URL + contact path.

CREATE TABLE IF NOT EXISTS support_tickets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  email        TEXT,              -- set when anonymous sender or for replies
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('question','bug','billing','feature','other')) DEFAULT 'other',
  status       TEXT NOT NULL CHECK (status IN ('open','in_progress','resolved','closed','spam')) DEFAULT 'open',
  app_version  TEXT,
  device_model TEXT,
  ios_version  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user
  ON support_tickets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_open
  ON support_tickets (created_at DESC) WHERE status IN ('open','in_progress');
