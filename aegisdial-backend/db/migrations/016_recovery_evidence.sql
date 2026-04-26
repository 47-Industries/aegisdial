-- Recovery evidence locker. Victims forget details quickly (names,
-- timestamps, amounts, wallet addresses) but later — at the bank,
-- police station, or in court — they're asked for exactly those
-- things. This table is their encrypted pocket notebook.
--
-- kind values:
--   note          — free-form text (what was said, when, pressure tactics)
--   amount        — dollar amount lost, in cents
--   photo         — screenshot URL (stored in iOS app's document dir;
--                    backend only tracks hash + size + description)
--   phone         — phone number involved
--   wallet        — crypto wallet address
--   account       — bank account / routing number
--   transaction   — wire confirmation, timestamp, transaction id

CREATE TABLE IF NOT EXISTS recovery_evidence (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID NOT NULL REFERENCES recovery_sessions(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN (
    'note','amount','photo','phone','wallet','account','transaction'
  )),
  -- Free-form typed payload. For photo items the iOS client stores the
  -- image locally and sends a SHA-256 hash + dimensions + caption; the
  -- raw bytes never hit this table.
  payload            JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recovery_evidence_session
  ON recovery_evidence (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recovery_evidence_user
  ON recovery_evidence (user_id, created_at DESC);
