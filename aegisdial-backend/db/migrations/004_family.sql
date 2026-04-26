-- Family plans: one subscriber pays, up to (included_lines + addon_lines) total
-- seats can be filled with invited members. Members don't have their own
-- subscriptions row — their tier is inherited from the plan owner.

CREATE TABLE IF NOT EXISTS family_plans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  included_lines    INT NOT NULL DEFAULT 3,
  addon_lines       INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_user_id)
);

CREATE INDEX IF NOT EXISTS idx_family_plans_owner ON family_plans (owner_user_id);

-- Membership. A user can be on at most one plan — either as owner (role='owner')
-- or as an invited member (role='member'). Owner row is inserted automatically
-- when the plan is created, via the /v1/family/invite endpoint on first invite.
CREATE TABLE IF NOT EXISTS family_members (
  family_plan_id    UUID NOT NULL REFERENCES family_plans(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  label             TEXT,
  added_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (family_plan_id, user_id),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_family_members_plan ON family_members (family_plan_id);

-- Invites. Owner creates → code is shown / shared. Another user enters the
-- code in their app → /v1/family/accept consumes it. Codes expire after 7 days.
CREATE TABLE IF NOT EXISTS family_invites (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_plan_id    UUID NOT NULL REFERENCES family_plans(id) ON DELETE CASCADE,
  code              TEXT NOT NULL,
  label             TEXT,
  invited_contact   TEXT,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')) DEFAULT 'pending',
  expires_at        TIMESTAMPTZ NOT NULL,
  accepted_by_user_id UUID REFERENCES users(id),
  accepted_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pending codes must be globally unique so `/v1/family/accept` can look them up
-- by code alone. Accepted / expired / revoked codes can recycle without issue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_family_invites_pending_code
  ON family_invites (code) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_family_invites_plan_status
  ON family_invites (family_plan_id, status);
CREATE INDEX IF NOT EXISTS idx_family_invites_expires
  ON family_invites (expires_at) WHERE status = 'pending';
