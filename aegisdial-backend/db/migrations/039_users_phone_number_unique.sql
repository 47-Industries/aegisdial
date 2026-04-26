-- 039_users_phone_number_unique.sql
--
-- Users.phone_number needs to be UNIQUE so two users can't register the
-- same number. Without this, the SMS-escalation worker (looks up a
-- guardian by phone) could route a scam-in-progress ping to the wrong
-- phone — if user A and user B both claimed +1-415-555-0001, an alert
-- to A's guardian might end up on B's device, or vice versa.
--
-- Partial index (WHERE phone_number IS NOT NULL) so NULLs don't collide
-- via the unique constraint.

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone_number
  ON users (phone_number)
  WHERE phone_number IS NOT NULL;

COMMENT ON INDEX uq_users_phone_number IS
  'Prevents two users from claiming the same phone — protects SMS alert '
  'routing (guardianAlertEscalator) and the named-guardian phone→user '
  'resolver (recovery.ts isNamedGuardian).';
