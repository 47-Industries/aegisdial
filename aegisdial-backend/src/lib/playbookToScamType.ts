import { PLAYBOOKS_BY_ID, type PlaybookId } from '../data/playbooks.js';
import type { ScamType } from './recoverySteps.js';

// Live Shield v4 — Phase 9 — playbook → scam_type mapping for the
// recovery flow.
//
// The recovery step catalog (src/lib/recoverySteps.ts) is keyed on a
// 52-value ScamType union, calibrated long before v4 existed. The v4
// classifier emits a 14-value PlaybookId. Most playbook ids overlap
// directly with a scam_type literal (irs_impersonation → irs_impersonation),
// but several need a calibrated mapping (tech_support_scam → tech_support,
// grandparent_scam → grandchild_emergency).
//
// This map lets the /end-route auto-handoff prefer a v4-derived
// scam_type when v4 has classified the call with sufficient confidence,
// SO the recovery_sessions row lands with a concrete scam_type the
// step-seeder can use — instead of 'unknown_triage' that defers all
// step-content decisions to the user picking during triage resolve.
//
// Calibration rationale (per mapping):
//   - Direct overlaps used wherever the playbook name is also a
//     scam_type literal in the catalog
//   - tech_support_scam → tech_support (drops the _scam suffix to match
//     the canonical scam_type)
//   - grandparent_scam → grandchild_emergency (recovery catalog's
//     family-emergency bucket already exists; same step sequence)
//   - gift_card_payment_scam → gift_card_scam (catalog uses _scam)
//   - crypto_investment_scam → crypto_scam (vs. investment_scam; crypto-
//     specific catalog steps include exchange-side recovery paths the
//     generic investment one lacks)
//   - sweepstakes_lottery_scam → lottery_sweepstakes (catalog field order)
//   - job_offer_scam → employment_scam
//   - charity_disaster_scam → charity_scam (broader than the disaster-
//     specific bucket; covers both seasonal and event-triggered cases)
//   - utility_shutoff_scam → utility_shutoff
//   - police_warrant_scam → law_enforcement_impersonation

const MAP: Record<PlaybookId, ScamType> = {
  bank_impersonation: 'bank_impersonation',
  irs_impersonation: 'irs_impersonation',
  ssa_impersonation: 'ssa_impersonation',
  medicare_impersonation: 'medicare_impersonation',
  tech_support_scam: 'tech_support',
  grandparent_scam: 'grandchild_emergency',
  romance_scam: 'romance_scam',
  gift_card_payment_scam: 'gift_card_scam',
  crypto_investment_scam: 'crypto_scam',
  sweepstakes_lottery_scam: 'lottery_sweepstakes',
  job_offer_scam: 'employment_scam',
  charity_disaster_scam: 'charity_scam',
  utility_shutoff_scam: 'utility_shutoff',
  police_warrant_scam: 'law_enforcement_impersonation',
};

/**
 * Map a v4 playbook id to the recovery catalog's scam_type. Total —
 * every PlaybookId has a mapping. Accepts raw `string | null` from a
 * DB column read; validates against PLAYBOOKS_BY_ID before mapping
 * (HIGH-1 adversarial fix — defense-in-depth pattern matches the rest
 * of the v4 read sites: v4Coaching, sentinelMatcher, stageClassifier
 * all gate on PLAYBOOKS_BY_ID.has before treating a string as a
 * PlaybookId).
 *
 * Returns null when:
 *   - input is null / undefined / empty
 *   - input doesn't validate as a PlaybookId (stale data after
 *     rollback, off-taxonomy value from a manual ops UPDATE)
 */
export function playbookIdToScamType(
  playbook_id: string | null | undefined,
): ScamType | null {
  if (!playbook_id) return null;
  if (!PLAYBOOKS_BY_ID.has(playbook_id as PlaybookId)) return null;
  return MAP[playbook_id as PlaybookId] ?? null;
}
