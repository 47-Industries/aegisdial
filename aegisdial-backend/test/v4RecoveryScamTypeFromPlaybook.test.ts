import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 9 — playbook → recovery scam_type tests.
//
// Two surfaces pinned:
//
//   1. playbookIdToScamType (src/lib/playbookToScamType.ts) — pure
//      mapping. Every PlaybookId returns a known ScamType from the
//      recovery catalog. Null/undefined input → null.
//
//   2. Mapping content invariants:
//      - Every PlaybookId in the canonical union has a mapping entry
//      - Every mapped ScamType is in the recovery catalog's union
//        (no drift between mapping and catalog after a future ScamType
//        rename or playbook addition)

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-recovery-scam-type';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-recovery-scam-type';

const { playbookIdToScamType } = await import('../src/lib/playbookToScamType.ts');
const playbooks = await import('../src/data/playbooks.ts');

// The 52 valid ScamType values from src/lib/recoverySteps.ts. Mirror
// here so a future ScamType taxonomy change forces this test to
// be updated alongside the mapping.
const VALID_SCAM_TYPES: ReadonlySet<string> = new Set([
  'bank_impersonation',
  'bank_employee_impersonation',
  'irs_impersonation',
  'irs_refund_bait',
  'ssa_impersonation',
  'law_enforcement_impersonation',
  'fbi_dea_impersonation',
  'uscis_ice_impersonation',
  'digital_arrest',
  'medicare_impersonation',
  'medicare_advantage_switch',
  'utility_shutoff',
  'tech_support',
  'fake_refund_scam',
  'apple_icloud_locked',
  'google_account_takeover',
  'sim_swap_port_out',
  'banking_app_push_bombing',
  'quishing_qr_phishing',
  'clickfix_malware',
  'coinbase_support_spoof',
  'grandchild_emergency',
  'ai_voice_clone_family',
  'virtual_kidnapping',
  'sextortion',
  'romance_scam',
  'pig_butchering',
  'parent_teacher_spoof',
  'zelle_venmo_support_scam',
  'bitcoin_atm_scam',
  'gift_card_scam',
  'investment_scam',
  'crypto_scam',
  'brokerage_401k_phishing',
  'debt_collection_phantom',
  'car_warranty_expiration',
  'home_warranty_scam',
  'subscription_trap',
  'advance_fee_inheritance',
  'lottery_sweepstakes',
  'employment_scam',
  'rental_scam',
  'timeshare_resale',
  'solar_panel_scam',
  'moving_company_hostage',
  'home_repair_storm_chaser',
  'funeral_cremation_scam',
  'pet_scam',
  'student_loan_forgiveness',
  'veterans_benefits_buyout',
  'affordable_care_act_scam',
  'tax_prep_identity_theft',
  'charity_scam',
  'political_donation_scam_pac',
  'census_survey_scam',
  'fema_disaster_relief_fraud',
  'package_redelivery',
  'unpaid_toll',
  'recovery_scam_secondary',
  'unknown_triage',
  'generic',
  'romance',
  'investment',
]);

describe('playbookIdToScamType — null/undefined fallback', () => {
  it('returns null for null', () => {
    assert.equal(playbookIdToScamType(null), null);
  });

  it('returns null for undefined', () => {
    assert.equal(playbookIdToScamType(undefined), null);
  });

  it('returns null for empty string', () => {
    assert.equal(playbookIdToScamType(''), null);
  });

  it('returns null for unknown playbook id (HIGH-1 PLAYBOOKS_BY_ID validation)', () => {
    // Pre-fix: the helper trusted the cast and `MAP['unknown_xyz']`
    // returned undefined → null via `?? null`. Post-fix: the helper
    // validates against PLAYBOOKS_BY_ID first, so the unknown path
    // short-circuits before MAP lookup. Same observable result but
    // pinned with explicit intent.
    assert.equal(playbookIdToScamType('unknown_xyz'), null);
    assert.equal(playbookIdToScamType('not_a_playbook'), null);
  });
});

describe('playbookIdToScamType — direct overlap mappings', () => {
  // The 14 playbook ids that have an obvious mapping target. These are
  // pinned as canonical and should not drift; if a future refactor
  // changes one, the change must be deliberate.
  const cases: Array<[playbooks.PlaybookId, string]> = [
    ['bank_impersonation', 'bank_impersonation'],
    ['irs_impersonation', 'irs_impersonation'],
    ['ssa_impersonation', 'ssa_impersonation'],
    ['medicare_impersonation', 'medicare_impersonation'],
    ['romance_scam', 'romance_scam'],
    ['utility_shutoff_scam', 'utility_shutoff'],
  ];

  for (const [pid, expected] of cases) {
    it(`${pid} maps to ${expected}`, () => {
      assert.equal(playbookIdToScamType(pid), expected);
    });
  }
});

describe('playbookIdToScamType — calibrated mappings', () => {
  // Non-obvious mappings where the playbook name + scam_type name
  // diverge. Pin them explicitly so a calibration change is loud.
  const cases: Array<[playbooks.PlaybookId, string]> = [
    ['tech_support_scam', 'tech_support'],
    ['grandparent_scam', 'grandchild_emergency'],
    ['gift_card_payment_scam', 'gift_card_scam'],
    ['crypto_investment_scam', 'crypto_scam'],
    ['sweepstakes_lottery_scam', 'lottery_sweepstakes'],
    ['job_offer_scam', 'employment_scam'],
    ['charity_disaster_scam', 'charity_scam'],
    ['police_warrant_scam', 'law_enforcement_impersonation'],
  ];

  for (const [pid, expected] of cases) {
    it(`${pid} maps to ${expected}`, () => {
      assert.equal(playbookIdToScamType(pid), expected);
    });
  }
});

describe('playbookIdToScamType — completeness + validity', () => {
  it('every PlaybookId in the canonical union returns a non-null mapping', () => {
    for (const p of playbooks.PLAYBOOKS) {
      const mapped = playbookIdToScamType(p.id);
      assert.ok(
        mapped !== null,
        `playbook ${p.id} has no scam_type mapping — recovery would default to llmScamType / unknown_triage`,
      );
    }
  });

  it('every mapped scam_type is a valid recovery-catalog ScamType', () => {
    for (const p of playbooks.PLAYBOOKS) {
      const mapped = playbookIdToScamType(p.id);
      assert.ok(
        mapped !== null && VALID_SCAM_TYPES.has(mapped),
        `playbook ${p.id} → ${mapped} is NOT a valid ScamType — drift between mapping and recovery catalog`,
      );
    }
  });
});
