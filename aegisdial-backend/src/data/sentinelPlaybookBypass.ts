import type { PlaybookId } from './playbooks.js';

// Live Shield v4 — Phase 8 — B3 sentinel playbook gate-bypass map.
//
// Today every B3 sentinel pattern with a `required_scammer_context_regex`
// gates firing on having heard a matching scammer-side phrase within
// the rolling context window (e.g. ssn_spoken_aloud only fires if the
// scammer said "social security number" or "tax ID" in the past 60s).
// This gate prevents false positives when Mom voluntarily mentions an
// SSN in a non-scam call.
//
// But: by the time v4 has LOCKED ON to a playbook like irs_impersonation
// at confidence ≥ V4_PLAYBOOK_MIN_CONFIDENCE (0.55), the playbook itself
// IS the context — the entire call has been classified as IRS-related.
// Requiring an additional scammer-context phrase within the recent
// window is redundant and can MISS real takeover triggers (scammer
// established context 70 seconds ago, Mom voluntarily discloses now —
// the rolling buffer pruned the trigger phrase).
//
// This map names, per pattern, which playbook-ids should bypass the
// scammer-context gate. When the session's v4_playbook_id is in the
// bypass list AND the V4_PLAYBOOK_B3_GATE_BYPASS_ENABLED flag is on,
// the matcher skips the context-gate check and fires on pattern match
// alone.
//
// Calibrated conservatively:
//   - Only the patterns + playbooks where context is INHERENT to the
//     playbook's authority claim
//   - Patterns WITHOUT a context gate (voluntary_*) are untouched —
//     they already fire unconditionally
//   - Patterns where the context phrase is required for false-positive
//     defense across ALL playbooks (e.g. mfa_code_spoken_aloud needs
//     'code' context regardless of playbook to disambiguate from
//     "I'll be there in 6 minutes") get a TIGHTER bypass set

export const SENTINEL_PLAYBOOK_BYPASS: Record<string, ReadonlyArray<PlaybookId>> = {
  // Scammer asking for SSN/tax-ID is the defining feature of these
  // playbooks. The context phrase ("your social security number")
  // is in the playbook's authority-stage seed; if the classifier
  // has committed to one of these, the context exists by definition.
  ssn_spoken_aloud: [
    'irs_impersonation',
    'ssa_impersonation',
    'medicare_impersonation',
    'police_warrant_scam',
  ],

  // Card disclosure is the defining ask of these playbooks. Bank
  // impersonators ALWAYS get to the "read me your card number" ask.
  // Gift-card scams require Mom to read the card numbers off the
  // back of physical cards. Tech-support and utility-shutoff both
  // demand card-based payment.
  card_number_spoken_aloud: [
    'bank_impersonation',
    'gift_card_payment_scam',
    'irs_impersonation',
    'tech_support_scam',
    'utility_shutoff_scam',
  ],

  // MFA-code exfiltration is the bank-fraud playbook's signature.
  // Only bypass for bank_impersonation — other playbooks rarely ask
  // for MFA codes specifically, and the 6-digit ambiguity ("I'll be
  // there in 6 minutes") needs the existing context-gate defense
  // in non-bank playbooks.
  mfa_code_spoken_aloud: ['bank_impersonation'],

  // affirms_payment_authorization — Mom explicitly saying "yes, send
  // it" / "go ahead and transfer" is the close-stage commitment in
  // ANY payment-demanding playbook. Bypass on the full set of
  // payment-demanding playbooks (12 of the 14 — only romance and
  // crypto have non-immediate-payment "ask" stages that don't always
  // close with a verbal authorization).
  //
  // MEDIUM-1 fix: previously omitted grandparent, police_warrant,
  // medicare, charity_disaster, sweepstakes_lottery, job_offer. Each
  // of those has explicit payment-demanding `ask` stage phrases
  // (grandparent: "wire the money", police_warrant: "buy gift cards
  // to clear this", medicare: "the routing number for the new card",
  // etc.) — the bypass should symmetrically apply.
  affirms_payment_authorization: [
    'bank_impersonation',
    'irs_impersonation',
    'ssa_impersonation',
    'medicare_impersonation',
    'gift_card_payment_scam',
    'tech_support_scam',
    'utility_shutoff_scam',
    'crypto_investment_scam',
    'romance_scam',
    'grandparent_scam',
    'sweepstakes_lottery_scam',
    'job_offer_scam',
    'charity_disaster_scam',
    'police_warrant_scam',
  ],
};

/**
 * True when the active playbook bypasses the scammer-context gate
 * for this sentinel pattern. Returns FALSE when:
 *   - playbook_id is null (no v4 lock)
 *   - pattern_name not in the bypass map
 *   - playbook not listed for this pattern
 */
export function isSentinelGateBypassed(
  pattern_name: string,
  playbook_id: PlaybookId | null,
): boolean {
  if (!playbook_id) return false;
  const allowed = SENTINEL_PLAYBOOK_BYPASS[pattern_name];
  if (!allowed) return false;
  return allowed.includes(playbook_id);
}
