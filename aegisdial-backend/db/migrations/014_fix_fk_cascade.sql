-- Fix the one FK to users(id) that lacks an ON DELETE action.
-- family_invites.accepted_by_user_id blocks DELETE /v1/users/me today
-- because the user who accepted the invite keeps a hard reference.
-- Switch to SET NULL so the audit trail is preserved but the user row
-- can cascade away on account deletion.

ALTER TABLE family_invites
  DROP CONSTRAINT IF EXISTS family_invites_accepted_by_user_id_fkey;

ALTER TABLE family_invites
  ADD CONSTRAINT family_invites_accepted_by_user_id_fkey
    FOREIGN KEY (accepted_by_user_id)
    REFERENCES users(id)
    ON DELETE SET NULL;
