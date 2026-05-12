import type { UserAgeBand } from '../services/stageClassifier.js';

// Live Shield v4 — Phase 7 — age-band helper.
//
// Maps users.dob_year (SMALLINT, 1900..2100) into a 3-bucket age band
// matching the demographic_priors keys on every playbook seed:
//
//   elderly         age >= 65
//   working_adult   age 30..64
//   young           age <  30
//
// Cutoffs chosen to match the playbook seeds' demographic targeting:
//   - 65+ aligns with the elderly-targeted playbooks (sweepstakes,
//     grandparent, medicare)
//   - <30 aligns with the youth-targeted playbooks (job_offer,
//     crypto_investment, romance long-cycle)
//   - 30-64 is everyone else; many playbooks land here
//
// `now` parameter lets tests pin "today" without mocking Date.

/**
 * Map a dob_year + reference year to an age band. Returns NULL when:
 *   - dob_year is null / undefined (pre-migration account)
 *   - dob_year is outside the plausible range [1900, 2100] (defensive
 *     — the DB CHECK constraint enforces this but the helper validates
 *     anyway so callers don't have to)
 *   - The computed age is negative (future birth year — corruption)
 *
 * ACCURACY NOTE: we only store year, not full DOB (COPPA-friendly,
 * minimal-PII). Computed `age = currentYear - dob_year` is accurate
 * within ±1 year — a December-1961 person counts as elderly from
 * Jan 1, 2026 even though their 65th birthday isn't until December.
 * Acceptable because demographic priors are tie-break-only signals;
 * a ±1-year boundary slip flips someone elderly↔working_adult or
 * working_adult↔young by ~11 months at most. The classifier is
 * instructed to use priors only when chunk evidence is genuinely
 * ambiguous, so the boundary noise doesn't drive false detections.
 *
 * The caller (classifier orchestrator) treats NULL as "skip
 * demographic priors entirely for this call" and the classifier user
 * prompt omits the age-band line.
 */
export function dobYearToAgeBand(
  dob_year: number | null | undefined,
  /** Reference year, default = today. Pass explicit value in tests. */
  now: Date = new Date(),
): UserAgeBand | null {
  if (dob_year == null) return null;
  if (!Number.isInteger(dob_year)) return null;
  if (dob_year < 1900 || dob_year > 2100) return null;
  const currentYear = now.getUTCFullYear();
  const age = currentYear - dob_year;
  if (age < 0) return null;
  if (age >= 65) return 'elderly';
  if (age < 30) return 'young';
  return 'working_adult';
}
