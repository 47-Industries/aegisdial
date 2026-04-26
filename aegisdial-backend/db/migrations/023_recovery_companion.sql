-- Recovery Companion — the AI chat layer that sits inside every recovery
-- session. Victims frequently can't or won't tell family immediately
-- after a scam. The companion is a trauma-informed conversational guide
-- that (a) validates their feelings, (b) walks them through the next
-- concrete step in their plan, (c) detects crisis language and pivots
-- to 988, (d) never gives legal or financial advice beyond our verified
-- step catalog.
--
-- Messages are the most sensitive data in the system — victims admit
-- details they'd never tell a human. Store encrypted at rest + short
-- retention (30 days).

CREATE TABLE IF NOT EXISTS recovery_companion_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID NOT NULL REFERENCES recovery_sessions(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  -- content_ct is the v1:<iv>:<tag>:<ct> envelope (src/lib/crypto.ts).
  -- Plaintext column kept empty-string for legacy-reader compatibility;
  -- the real text only lives in content_ct.
  content          TEXT,
  content_ct       TEXT NOT NULL,
  tokens_in        INT,
  tokens_out       INT,
  crisis_detected  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_companion_messages_session
  ON recovery_companion_messages (session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_companion_messages_user
  ON recovery_companion_messages (user_id, created_at DESC);

-- Outcome table — the flywheel. When a session completes or after the
-- T+7d follow-up, capture what actually worked. Feed it back into step
-- ordering over time.
CREATE TABLE IF NOT EXISTS recovery_outcomes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID NOT NULL UNIQUE REFERENCES recovery_sessions(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Was any money recovered? NULL = not asked yet, true/false after response
  recovered_any       BOOLEAN,
  recovered_cents     INT,
  -- Free-form text: "what worked / what didn't", encrypted at rest.
  notes               TEXT,
  notes_ct            TEXT,
  -- Per-step rating: which steps were helpful, which weren't. JSON object
  -- keyed by step_key → {helpful: bool, note?: string}. Encrypted.
  step_feedback_ct    TEXT,
  -- Lightweight mood check (1–5) for emotional outcome tracking.
  mood_before         SMALLINT CHECK (mood_before IS NULL OR (mood_before BETWEEN 1 AND 5)),
  mood_after          SMALLINT CHECK (mood_after IS NULL OR (mood_after BETWEEN 1 AND 5)),
  told_family         BOOLEAN,
  reported_to_police  BOOLEAN,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recovery_outcomes_user
  ON recovery_outcomes (user_id, created_at DESC);

-- Session additions: named guardian + companion-warmed flags.
ALTER TABLE recovery_sessions
  ADD COLUMN IF NOT EXISTS named_guardian_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS companion_opened_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS companion_last_at      TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_recovery_sessions_named_guardian
  ON recovery_sessions (named_guardian_user_id) WHERE named_guardian_user_id IS NOT NULL;
