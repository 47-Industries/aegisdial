import { config } from '../config.js';

// Live Shield — adaptive transcript-flush cadence.
//
// The iOS app sends transcript chunks to /v1/live-shield/:id/transcript
// at a server-driven cadence. The response body carries a
// `next_flush_ms` value the client uses to schedule its next POST.
//
// Static cadence (v2) was 8 seconds for every call regardless of risk.
// That paid full battery + LLM cost on legitimate calls, and capped
// best-case scam-detection latency at ~8 seconds even for clear
// critical events. This module computes the right cadence based on
// the session's current risk state.
//
// Threshold table (defaults — all four are env-tunable):
//   risk_level=low,     no B4 activity   → V3_FLUSH_MS_LOW       (8000 ms)
//   risk_level=low,     has B4 claims    → V3_FLUSH_MS_MEDIUM    (5000 ms)
//   risk_level=medium                    → V3_FLUSH_MS_MEDIUM    (5000 ms)
//   risk_level=high                      → V3_FLUSH_MS_HIGH      (3000 ms)
//   risk_level=critical                  → V3_FLUSH_MS_CRITICAL  (2000 ms)
//
// Why the B4-activity floor matters: a scammer can keep red-flag
// PHRASES out of the first 30 seconds (chatting about weather, asking
// "did you get my email"). Score stays low. But if they've already
// CLAIMED an identity ("I'm calling from Acme Bank") the B4 verifier
// is racing to fact-check that claim. We want a tighter loop so the
// verification round-trip catches up faster — otherwise the slow
// cadence wastes the time we earned by extracting the claim.

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface CadenceInput {
  risk_level: RiskLevel;
  /** At least one B4 finding has been persisted for this session
   *  (contradicted, cannot_verify, OR consistent — counted by
   *  call_sessions.b4_findings_count, which b4Verifier.persistFinding
   *  increments on every finding regardless of result).
   *
   *  When true and risk_level is still 'low', cadence tightens to
   *  medium. Rationale: a fact-check-rich call has signal even
   *  before the rule-based scorer notices, so a tighter loop keeps
   *  Mom's takeover window short if a contradicted finding lands
   *  later in the call. */
  has_any_b4_finding: boolean;
}

export function pickFlushCadenceMs(input: CadenceInput): number {
  switch (input.risk_level) {
    case 'critical':
      return config.V3_FLUSH_MS_CRITICAL;
    case 'high':
      return config.V3_FLUSH_MS_HIGH;
    case 'medium':
      return config.V3_FLUSH_MS_MEDIUM;
    case 'low':
      // B4-activity floor — see CadenceInput.has_any_b4_finding docs.
      return input.has_any_b4_finding
        ? config.V3_FLUSH_MS_MEDIUM
        : config.V3_FLUSH_MS_LOW;
    default: {
      // Defensive fallback for any future risk_level value that
      // bypasses the union (manual DB edit, schema drift). Returns
      // the slow cadence rather than `undefined` (which would drop
      // the JSON field and silently revert iOS to its compiled-in
      // default). L1 from the adversarial review.
      const _exhaustive: never = input.risk_level;
      void _exhaustive;
      return config.V3_FLUSH_MS_LOW;
    }
  }
}
