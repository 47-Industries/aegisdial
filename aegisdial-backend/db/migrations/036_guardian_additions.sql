-- 036_guardian_additions.sql
--
-- Guardian & family-plan correctness additions:
--   (a) users.phone_number      — optional E.164 phone for the account
--                                  owner. Used by the SMS escalation
--                                  worker to ping guardians when a
--                                  critical alert has gone unread for
--                                  15+ minutes, and by R20 to resolve a
--                                  named_guardian_user_id back to a
--                                  family_contacts.phone_e164 with
--                                  is_guardian=TRUE.
--   (b) guardian_alerts.escalated_at — set by the SMS escalator worker
--                                      when it has attempted (or at least
--                                      decided not to attempt) an SMS
--                                      fallback. Gates re-escalation —
--                                      once a row is escalated we never
--                                      touch it again.
--   (c) guardian_challenges      — short-lived challenges fired from
--                                  guardian → subject. "Prove it's you"
--                                  after the guardian sees something
--                                  sketchy on the subject's activity.
--   (d) family_ownership_transfers — two-step handoff of a family plan
--                                    from one owner to another existing
--                                    plan member.

-- (a) users.phone_number ------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_number TEXT;

-- Plaintext is fine here — the account owner opts into this explicitly,
-- it's low-sensitivity compared to recovery PII, and the SMS worker
-- + named-guardian resolver both need an indexable E.164 string.
CREATE INDEX IF NOT EXISTS idx_users_phone_number
  ON users (phone_number) WHERE phone_number IS NOT NULL;

COMMENT ON COLUMN users.phone_number IS
  'Optional E.164 phone number. Used for SMS escalation of unread '
  'critical guardian alerts and for mapping named guardians to '
  'family_contacts entries (is_guardian=TRUE).';

-- (b) guardian_alerts.escalated_at -------------------------------------
ALTER TABLE guardian_alerts
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;

-- Partial index: the escalator only ever scans rows that haven't been
-- touched yet. Keep the index tiny by excluding resolved/escalated rows.
CREATE INDEX IF NOT EXISTS idx_guardian_alerts_pending_escalation
  ON guardian_alerts (created_at)
  WHERE escalated_at IS NULL AND seen_at IS NULL AND severity = 'critical';

COMMENT ON COLUMN guardian_alerts.escalated_at IS
  'Timestamp when the SMS escalator worker processed this alert. '
  'NULL means the worker has not yet considered it; once set, the alert '
  'is frozen from further escalation regardless of SMS delivery outcome.';

-- (c) guardian_challenges ---------------------------------------------
-- Short-lived "prove it's really you" challenges. A guardian sees
-- suspicious activity on a subject's device and fires this — the
-- subject's phone receives a push ("Your family member wants to verify
-- it's really you. Tap to answer.") and they type the shared safe word.
-- The response is bcrypt-compared against family_contacts.safe_word_hash
-- for the row linking subject → guardian (by phone). Match sets
-- resolved_at and records success; mismatch records success=false.
CREATE TABLE IF NOT EXISTS guardian_challenges (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  initiated_by_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_prompt      TEXT,
  expires_at            TIMESTAMPTZ NOT NULL,
  resolved_at           TIMESTAMPTZ,
  resolved_success      BOOLEAN,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guardian_challenges_subject_open
  ON guardian_challenges (subject_user_id, created_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_guardian_challenges_initiator
  ON guardian_challenges (initiated_by_user_id, created_at DESC);

-- (d) family_ownership_transfers --------------------------------------
-- Two-step owner handoff. Current owner POSTs /v1/family/transfer/request
-- naming another existing plan member — we mint a token, shove a row in
-- here, hand the token back to the iOS app so the app can display a
-- confirmation or share the raw token out-of-band. The receiving user
-- then POSTs /v1/family/transfer/accept with that token; we verify (a)
-- not expired, (b) both users still on the plan, (c) the accepting
-- caller matches to_user_id. On accept, family_plans.owner_user_id is
-- updated and member roles are swapped inside a transaction.
-- We store a SHA-256 hash of the token, NOT the raw value. The raw
-- token is returned ONCE to the caller that requested the transfer;
-- they share it out-of-band with the new owner (text message / in
-- person / iOS share sheet). On accept we hash the submitted token and
-- look up by hash — so a DB read (support tool, leaked backup, SQL
-- injection elsewhere) cannot be used to accept pending transfers.
CREATE TABLE IF NOT EXISTS family_ownership_transfers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_plan_id UUID NOT NULL REFERENCES family_plans(id) ON DELETE CASCADE,
  from_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  expires_at     TIMESTAMPTZ NOT NULL,
  accepted_at    TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A plan can have at most one pending transfer at a time (both sides
-- need to know exactly which transfer to reason about). Enforced via
-- partial unique index on plan_id where accepted_at + cancelled_at are
-- NULL and the transfer hasn't expired at migration-time — Postgres
-- can't reference NOW() in a partial index predicate, so we restrict
-- purely to the two nullable columns and rely on app-level
-- expires_at filtering when minting a new one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_family_ownership_transfers_pending
  ON family_ownership_transfers (family_plan_id)
  WHERE accepted_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_family_ownership_transfers_to
  ON family_ownership_transfers (to_user_id, created_at DESC);
