-- Recovery Shield — P4: specialist-referral tracking + fee ledger.
--
-- One row per referral the user makes from the in-app marketplace to
-- a vetted specialist. Recovery Plus users get the first referral
-- included in the $249 unlock; subsequent referrals route directly
-- to the specialist at their normal rate (no additional AegisDial
-- charge to the user — the specialist owes us the commission).
--
-- LIFECYCLE:
--   referred                     — referral created, email fired to
--                                  specialist's intake address
--   specialist_contacted_user    — specialist reached out to user
--   user_engaged                 — user retained the specialist
--   case_active                  — engagement in flight
--   case_closed_won              — recovery successful (rare in
--                                  crypto, more common in wires)
--   case_closed_lost             — no recovery
--   user_declined                — user passed on the specialist
--
-- FEE LEDGER:
--   fee_owed_cents populated when the specialist self-reports the
--   case outcome (admin-mediated at v1; webhook-driven at v2).
--   fee_paid_at flips when AegisDial receives the commission. Both
--   are NULL until the specialist reports.
--
-- ANTI-FRAUD SURFACE (adversarial-review item E):
--   A malicious specialist could self-report inflated fees. At v1
--   the admin (Jesiah / Dean) reviews every fee report before
--   invoicing — Big Red admin button in the dashboard. At v2 we
--   need a stronger proof signal:
--     - signed retainer doc upload from specialist
--     - dual confirmation (user confirms engagement in iOS)
--     - cap on fee_owed_cents per referral (refuses >$50k without
--       admin override)
--
-- CROSS-USER LEAKAGE GUARD:
--   user_id is on the row even though it's reachable via
--   recovery_session_id — denormalized for the WHERE clause on
--   /v1/recovery/specialists/refer/:id (and the GET equivalent).
--   The route layer's authZ check uses this column directly. Belt-
--   and-suspenders: a routing bug that forgot to scope by user
--   would still be caught at the row-level access.
--
-- FK CASCADES:
--   - user delete cascades (user has the right to be forgotten)
--   - recovery_session delete cascades (same)
--   - specialist DOES NOT cascade. Retiring or deleting a specialist
--     record (rare; we usually status='retired' instead) must NOT
--     wipe out the historic referrals — those rows are fee-ledger
--     records.
--
-- PRIVACY POSTURE:
--   outcome_notes is admin-written summary of case progression.
--   Plaintext. Visible only on /v1/admin/recovery-shield/*; never
--   surfaced to the user (it's our internal fee-tracking commentary).
--
-- RETENTION: Forever. Fee ledger is a financial record.
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS specialist_referrals (
  id                         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NO CASCADE on specialist FK — see fee-ledger rationale above.
  specialist_id              UUID         NOT NULL REFERENCES specialists(id),
  recovery_session_id        UUID         NOT NULL REFERENCES recovery_sessions(id) ON DELETE CASCADE,
  referred_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Set when the specialist's intake webhook fires (or admin marks
  -- manually). Drives the "specialist hasn't acked yet" stale-
  -- referral admin dashboard.
  specialist_acknowledged_at TIMESTAMPTZ,
  -- Engagement lifecycle. CHECK pins vocabulary; transition rules
  -- enforced in specialistMarketplace.ts.
  engagement_status          TEXT         NOT NULL DEFAULT 'referred' CHECK (engagement_status IN
    ('referred','specialist_contacted_user','user_engaged','case_active','case_closed_won','case_closed_lost','user_declined')),
  -- Fee owed to AegisDial from the specialist on case completion.
  -- BIGINT cents (a case_closed_won on a large wire-recall can
  -- generate a five-figure commission). NULL until the specialist
  -- reports outcome.
  fee_owed_cents             BIGINT,
  fee_paid_at                TIMESTAMPTZ,
  -- Admin-written commentary. Plaintext, admin-only visibility.
  outcome_notes              TEXT
);

-- Hot path: "show me my referrals" for the iOS dashboard.
CREATE INDEX IF NOT EXISTS idx_referrals_user
  ON specialist_referrals (user_id, referred_at DESC);

-- Specialist-performance admin dashboard: "show me all referrals to
-- this specialist, newest first" — drives conversion-rate + fee-owed
-- metrics per specialist.
CREATE INDEX IF NOT EXISTS idx_referrals_specialist
  ON specialist_referrals (specialist_id, referred_at DESC);

-- Recovery session drill-down: "show all specialist referrals
-- under this session".
CREATE INDEX IF NOT EXISTS idx_referrals_session
  ON specialist_referrals (recovery_session_id);

COMMENT ON TABLE specialist_referrals IS
  'Recovery Shield — referral + fee-ledger tracking. specialist_id is NOT cascade-deleted (retiring a specialist must not wipe historic fee records). user_id denormalized for belt-and-suspenders authZ scoping.';

COMMENT ON COLUMN specialist_referrals.user_id IS
  'Denormalized from recovery_session for direct authZ scoping. A routing bug that forgot to filter by user is still caught at the row-level access check.';

COMMENT ON COLUMN specialist_referrals.engagement_status IS
  'Lifecycle: referred → specialist_contacted_user → user_engaged → case_active → (case_closed_won|case_closed_lost|user_declined). Transition rules in specialistMarketplace.ts.';

COMMENT ON COLUMN specialist_referrals.fee_owed_cents IS
  'Commission AegisDial bills the specialist on case completion. BIGINT cents (large wire-recalls can produce five-figure commissions). NULL until specialist self-reports outcome; admin reviews before invoicing.';

COMMENT ON COLUMN specialist_referrals.outcome_notes IS
  'Admin commentary on case progression. Plaintext, admin-only — never surfaced in user-facing routes.';
