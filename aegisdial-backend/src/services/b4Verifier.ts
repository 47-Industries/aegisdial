import { config } from '../config.js';
import { emitMetric } from '../lib/observability.js';
import type { ExtractedClaim } from './claimExtractor.js';

// Live Shield v3 — B4 verifier service (Phase 3 scaffold).
//
// Consumes ExtractedClaim values from claimExtractor.ts and runs each
// through a layered verification pipeline:
//
//   Layer 1 — AegisDial curated directory (high-precision, low-coverage)
//             Top-50 banks' published outbound number ranges,
//             federal-agency contact channels, account-tail compare,
//             known-scam-script phrases. Source seed in
//             src/data/curatedB4Directory.json + runtime overrides
//             from b4_curated_overrides.
//
//   Layer 2 — Live web search via Claude tool-use against Serper
//             (existing A1 integration). Broader coverage, lower
//             precision; Claude reads search results and decides
//             whether the claim checks out.
//
// Locked rule: only `result === 'contradicted'` findings produce
// user-facing UI. `consistent` findings produce nothing (we never
// validate the scammer — that's a trust attack surface). `cannot_verify`
// findings boost the Live Shield score quietly but stay silent.
//
// Phase 0 status: interface FINAL, layered orchestrator stubbed,
// curated directory loader stubbed (seed JSON populated separately
// in Phase 3 day 1).

export interface Finding {
  claim: ExtractedClaim;
  result: 'contradicted' | 'cannot_verify' | 'consistent';
  // 0..1; B4_TAKEOVER_THRESHOLD gates which contradicted findings fire
  // a B3-style takeover. Lower-confidence findings boost score only.
  confidence: number;
  // One-sentence Claude-authored explanation (or curated rationale).
  reasoning: string;
  // Which layer produced the finding.
  source_layer: 'curated' | 'web_search';
  // Provenance — every finding carries a tappable receipt. Either a
  // web-search result URL+snippet (Layer 2) or a curated-entry id
  // (Layer 1). Mom can tap to verify.
  source_url: string | null;
  source_snippet: string | null;
  source_curated_entry_id: string | null;
}

export interface VerifyInput {
  claim: ExtractedClaim;
  // For account_tail comparison — looked up from the user's profile
  // when claim.type === 'account_tail'. Null if user didn't opt in to
  // account-tail collection.
  user_account_last_4: string | null;
}

/**
 * Verify a single claim. Returns a Finding regardless of outcome
 * (contradicted | cannot_verify | consistent) — caller decides what
 * to do with it.
 *
 * Phase 0 scaffold — Layer 1 lookup and Layer 2 fallback are TODOs.
 * The function returns a `cannot_verify` placeholder for every
 * claim today so callers (B4 takeover dispatcher, score booster)
 * can be written and tested against the interface.
 */
export async function verify(input: VerifyInput): Promise<Finding> {
  if (!config.V3_B4_ENABLED) {
    return cannotVerifyPlaceholder(input.claim);
  }

  const started = Date.now();

  // TODO(Phase 3): Layer 1 — curated directory lookup.
  // Examples by claim_type:
  //   bank_affiliation     → check whether the calling number is
  //                          on the named bank's published outbound
  //                          list (loaded from curated JSON +
  //                          b4_curated_overrides)
  //   agency_affiliation   → check the named agency's
  //                          "we don't cold-call about X" rules
  //   account_tail         → compare claimed last_4 against
  //                          user_account_last_4 (if user opted in)
  //
  // Layer 1 is fast (in-memory lookup, ~5ms). If it produces a
  // definitive contradicted/consistent answer, return immediately.
  // Layer 2 (Serper web search via Claude tool-use) is the fallback
  // for claim types Layer 1 can't answer — case_number,
  // employee_identity, geographic_location, novel agencies.

  const placeholder = cannotVerifyPlaceholder(input.claim);

  const latency_ms = Date.now() - started;
  emitMetric('v3.b4.verification_completed', {
    result: placeholder.result,
    source_layer: placeholder.source_layer,
  });
  emitMetric('v3.b4.verifier_latency_ms', {}, latency_ms);

  return placeholder;
}

function cannotVerifyPlaceholder(claim: ExtractedClaim): Finding {
  return {
    claim,
    result: 'cannot_verify',
    confidence: 0,
    reasoning: 'Verifier scaffold; full implementation lands in Phase 3.',
    source_layer: 'curated',
    source_url: null,
    source_snippet: null,
    source_curated_entry_id: null,
  };
}
