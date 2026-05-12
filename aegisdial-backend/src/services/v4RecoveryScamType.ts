import { config } from '../config.js';
import { playbookIdToScamType } from '../lib/playbookToScamType.js';

// Live Shield v4 — Phase 9 — resolver for the recovery scam_type
// substitution. Pure function over (v4_playbook_id, v4_stage_confidence,
// llm_scam_type). All gate composition lives here so the route is a
// thin caller and the gate is unit-testable.
//
// Behavior (per MED-3 adversarial fix):
//   - v4 is a BACKFILL signal, not an override. v4's playbook taxonomy
//     is structurally coarser than the LLM's scam_type taxonomy (14 vs
//     52 buckets). When the LLM has committed to a specific scam_type,
//     v4 must NOT override it — the LLM saw the full transcript with
//     its longer-cycle context, and several LLM-only buckets (e.g.
//     fema_disaster_relief_fraud, pig_butchering, digital_arrest,
//     fbi_dea_impersonation) carry recovery-step content that v4's
//     coarser mapping would silently lose.
//
//   - v4 substitutes ONLY when the LLM signal is absent or vague:
//     llm_scam_type ∈ {null, '', 'unknown_triage', 'generic'}
//
//   - Substitution still requires:
//     * V4_PLAYBOOK_RECOVERY_SCAM_TYPE_ENABLED flag on
//     * v4_playbook_id resolves via PLAYBOOKS_BY_ID
//     * v4_stage_confidence_pct >= floor (column-scale comparison —
//       column is SMALLINT 0..100, floor lives in float-space as
//       V4_PLAYBOOK_RECOVERY_SCAM_TYPE_MIN_CONFIDENCE × 100)

const LLM_VAGUE_SCAM_TYPES: ReadonlySet<string> = new Set([
  '',
  'unknown_triage',
  'generic',
]);

export interface ResolveScamTypeInput {
  /** v4_playbook_id raw value from call_sessions. */
  v4_playbook_id: string | null;
  /** v4_stage_confidence raw value from call_sessions (0..100 int). */
  v4_stage_confidence_pct: number | null;
  /** llm_scam_type raw value from call_sessions. */
  llm_scam_type: string | null;
}

export interface ResolveScamTypeOutput {
  /** The scam_type to persist on the recovery_sessions row. */
  scam_type: string;
  /** True when the substitution applied — useful for metrics + audit. */
  from_playbook: boolean;
}

/**
 * Resolve the effective scam_type for a /end-route recovery handoff.
 * Pure, deterministic, no DB. Tests pin all gate-composition cases
 * against this function directly.
 */
export function resolveEffectiveScamType(
  input: ResolveScamTypeInput,
): ResolveScamTypeOutput {
  const fallback = input.llm_scam_type ?? 'unknown_triage';

  // Gate 1 — flag must be on.
  if (!config.V4_PLAYBOOK_RECOVERY_SCAM_TYPE_ENABLED) {
    return { scam_type: fallback, from_playbook: false };
  }
  // Gate 2 — v4 must have classified.
  if (!input.v4_playbook_id || input.v4_stage_confidence_pct == null) {
    return { scam_type: fallback, from_playbook: false };
  }
  // Gate 3 — confidence must clear the floor. Column-scale comparison
  // (MED-1 adversarial fix) so future floor values like 0.85 don't hit
  // IEEE-754 boundary noise when divided to float for comparison.
  const floorPct = Math.round(
    config.V4_PLAYBOOK_RECOVERY_SCAM_TYPE_MIN_CONFIDENCE * 100,
  );
  if (input.v4_stage_confidence_pct < floorPct) {
    return { scam_type: fallback, from_playbook: false };
  }
  // Gate 4 (MED-3 fix) — only substitute when LLM signal is absent or
  // vague. If the LLM committed to a SPECIFIC scam_type, trust it over
  // the coarser v4 mapping. v4's job here is to BACKFILL, not override.
  const llmIsVague = input.llm_scam_type === null || LLM_VAGUE_SCAM_TYPES.has(input.llm_scam_type);
  if (!llmIsVague) {
    return { scam_type: fallback, from_playbook: false };
  }
  // Gate 5 — playbook must validate + map. playbookIdToScamType handles
  // PLAYBOOKS_BY_ID validation internally (HIGH-1 fix).
  const mapped = playbookIdToScamType(input.v4_playbook_id);
  if (!mapped) {
    return { scam_type: fallback, from_playbook: false };
  }

  return { scam_type: mapped, from_playbook: true };
}
