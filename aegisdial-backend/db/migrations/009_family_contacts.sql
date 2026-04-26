-- Family contacts registry. Users register trusted contacts (family,
-- bank, doctor) with their known-good phone numbers. When the Live
-- Shield detects an emergency-relative pattern ("Grandma, it's me, I'm
-- in jail and need bail money") we (a) show the saved number for
-- instant callback, and (b) let the user verify a shared safe word
-- that only the real person knows.
--
-- Safe words are stored as bcrypt hashes — we never need to know the
-- plaintext, we only need to verify a candidate matches. This is the
-- same technique as password auth.

CREATE TABLE IF NOT EXISTS family_contacts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name     TEXT NOT NULL,
  phone_e164       TEXT NOT NULL,
  relationship     TEXT CHECK (relationship IN ('parent','child','spouse','sibling','grandparent','grandchild','friend','bank','doctor','attorney','other')),
  is_guardian      BOOLEAN NOT NULL DEFAULT FALSE,
  safe_word_hash   TEXT,
  challenge_prompt TEXT,
  challenge_answer_hash TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, phone_e164)
);

CREATE INDEX IF NOT EXISTS idx_family_contacts_user
  ON family_contacts (user_id, display_name);
CREATE INDEX IF NOT EXISTS idx_family_contacts_guardian
  ON family_contacts (user_id) WHERE is_guardian = TRUE;

-- Verification attempts — audit trail for safe-word checks. Track
-- successful vs. failed so we can surface "3 failed safe-word attempts
-- on an emergency call" as its own red flag.
CREATE TABLE IF NOT EXISTS family_verifications (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_contact_id  UUID REFERENCES family_contacts(id) ON DELETE SET NULL,
  call_session_id    UUID REFERENCES call_sessions(id) ON DELETE SET NULL,
  verification_type  TEXT NOT NULL CHECK (verification_type IN ('safe_word','challenge','callback')),
  success            BOOLEAN NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_family_verifications_session
  ON family_verifications (call_session_id) WHERE call_session_id IS NOT NULL;
