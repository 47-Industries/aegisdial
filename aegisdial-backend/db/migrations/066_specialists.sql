-- Recovery Shield — P4: vetted-specialist marketplace registry.
--
-- One row per vetted specialist on the AegisDial marketplace.
-- Specialists are SHARED across all users — a single asset-recovery
-- attorney can be referred from many recovery sessions. Categories
-- at v1:
--   asset_recovery_attorney        — state-licensed, bar number on file
--   blockchain_forensics           — CipherTrace / Chainalysis-tier
--   identity_restoration           — SSA / IRS / bank reissue specialist
--   cyber_insurance_consult        — consults on home/cyber policy use
--   tax_professional_loss_writeoff — handles theft-loss tax filings
--
-- WHY NOT cascade-deleted on user delete:
--   Specialists are SHARED RESOURCES, not user-owned. The vetted_by
--   FK references the admin user who approved them; if that admin's
--   user row is deleted, we ON DELETE SET NULL via the FK (admin
--   gone, but the specialist record survives). NO cascade — losing
--   a specialist row would orphan referrals from every user who'd
--   used them.
--
-- COMMISSION + ANTI-FRAUD POSTURE:
--   commission_pct (NUMERIC 4,2) is the specialist's agreed
--   referral commission — typically 10.00–20.00%. AegisDial bills
--   the specialist after the case completes; the user pays the
--   specialist directly at their normal rate. We NEVER take a cut
--   of recovered funds (regulatory + brand-integrity reasons).
--
--   Anti-fraud: specialist self-reports the case outcome and fee
--   owed, but adversarial-review item E flags this surface. The
--   admin-mediated workflow at v1 (Jesiah / Dean reviews every
--   specialist's fee report before invoicing) is the mitigation.
--   v2 self-serve specialist portal needs a stronger signal —
--   probably specialist-side proof-of-engagement (signed retainer
--   doc upload).
--
-- CONTACT EMAIL — REPLAY PROTECTION:
--   contact_email is the specialist's legal/intake email. Per the
--   adversarial-review note on replay-protection, we'd ideally
--   UNIQUE this column — but specialists sometimes share an intake
--   address across a firm (one paralegal-routed inbox for multiple
--   attorneys at the same firm). Enforcing UNIQUE would lock those
--   out. Instead the admin onboarding flow checks for collisions
--   manually + the vetting process catches the rare dup.
--
-- STATUS LIFECYCLE:
--   pending    — onboarding, not yet vetted
--   active     — approved, eligible for referrals
--   suspended  — temporarily off the marketplace (under review)
--   retired    — permanently off (left practice, etc.)
--
-- BAR NUMBER:
--   Required for asset_recovery_attorney category. Verification
--   artifact — we cross-check against state bar registries during
--   vetting. Other categories may have analogous credentials
--   (blockchain forensics: company URL; tax: CPA license number).
--   For now we store bar_number as a free-text field; v2 may
--   normalize into a separate credentials table.
--
-- JURISDICTIONS + CAPABILITIES:
--   Both are TEXT[] for fast `WHERE 'US-FL' = ANY(jurisdictions)`
--   marketplace filtering. Capabilities are free-text tags
--   ('crypto', 'wire_recall', 'ssn_compromise', 'gmail_takeover',
--   'apple_id_takeover'), maintained as a controlled vocabulary
--   in admin docs but not CHECK-constrained — the set evolves
--   faster than migrations.
--
-- PRIVACY POSTURE:
--   This table holds B2B-partner contact info, not user PII.
--   Plaintext acceptable. Notes column may carry vetting
--   commentary; admin-only access.
--
-- RETENTION: Forever. Specialists are long-lived business
-- relationships; retiring a specialist sets status='retired' but
-- does NOT delete the row.
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS specialists (
  id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name              TEXT         NOT NULL,
  -- Category enum. CHECK pins it; marketplace filter UI keys on
  -- this value.
  category                  TEXT         NOT NULL CHECK (category IN
    ('asset_recovery_attorney','blockchain_forensics','identity_restoration',
     'cyber_insurance_consult','tax_professional_loss_writeoff')),
  -- ISO-3166-2 codes (e.g., 'US-FL', 'US-CA'). TEXT[] enables
  -- ANY() filtering at marketplace query time.
  jurisdictions             TEXT[]       NOT NULL,
  -- Free-text capability tags. Controlled vocabulary lives in
  -- admin docs, not CHECK-constrained (evolves faster than
  -- migrations).
  capabilities              TEXT[]       NOT NULL,
  -- 10.00 = 10%. NUMERIC(4,2) supports up to 99.99% which is
  -- well over any realistic commission.
  commission_pct            NUMERIC(4,2) NOT NULL,
  -- Specialist's legal/intake email. NOT UNIQUE — firms share
  -- intake addresses. Onboarding flow checks collisions manually.
  contact_email             TEXT         NOT NULL,
  contact_phone             TEXT,
  -- Required for attorneys; nullable for other categories. Cross-
  -- checked against state bar during vetting.
  bar_number                TEXT,
  -- Lifecycle status. CHECK pins vocabulary. Default 'pending' so
  -- a newly-INSERTed specialist can't be referred to until an
  -- admin flips them to 'active'.
  status                    TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','active','suspended','retired')),
  vetted_at                 TIMESTAMPTZ,
  -- Admin user who approved them. ON DELETE SET NULL — losing
  -- the admin doesn't lose the specialist record.
  vetted_by                 UUID         REFERENCES users(id) ON DELETE SET NULL,
  notes                     TEXT,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Marketplace hot path: "show me active specialists in this
-- category". Partial keeps the index small — only active rows
-- count for the user-facing marketplace.
CREATE INDEX IF NOT EXISTS idx_specialists_active
  ON specialists (category)
  WHERE status = 'active';

COMMENT ON TABLE specialists IS
  'Recovery Shield — vetted-specialist marketplace registry. SHARED across all users (NOT cascade-deleted on user delete). vetted_by FK to admin user is ON DELETE SET NULL — losing the admin doesn''t lose the specialist record. status=''pending'' on INSERT until an admin promotes to ''active''.';

COMMENT ON COLUMN specialists.jurisdictions IS
  'ISO-3166-2 codes (US-FL, US-CA, …). TEXT[] enables `ANY() = $1` filtering at marketplace query time.';

COMMENT ON COLUMN specialists.capabilities IS
  'Free-text capability tags (crypto, wire_recall, ssn_compromise, gmail_takeover, apple_id_takeover). Controlled vocabulary lives in admin docs; not CHECK-constrained because it evolves faster than migrations.';

COMMENT ON COLUMN specialists.commission_pct IS
  'Referral commission % the specialist agreed to pay AegisDial (10.00 = 10%). NUMERIC(4,2). User pays specialist directly; AegisDial bills the specialist post-case.';

COMMENT ON COLUMN specialists.contact_email IS
  'Specialist''s intake email. NOT UNIQUE — firms legitimately share intake addresses across attorneys. Admin onboarding flow checks for collisions manually.';

COMMENT ON COLUMN specialists.vetted_by IS
  'Admin user who approved this specialist. ON DELETE SET NULL — losing the admin must not lose the specialist record (it''s a shared resource referenced by referrals from many users).';
