import { config } from '../config.js';
import { emitMetric } from '../lib/observability.js';

// Live Shield v3 — B4 dedicated claim-extraction Claude pass.
//
// PHASE 3 — full implementation lands after B3 is in. This Phase 0
// scaffold establishes:
//   - The structured claim taxonomy (6 types, locked in spec)
//   - The public extract() interface against which b4Verifier wires
//   - The output schema that POST writes to b4_extracted_claims
//
// Architectural note (locked in spec section "B4 claim extraction"):
// claim extraction runs as a SECOND Claude pass IN PARALLEL with v2's
// existing risk-scoring Claude. Same transcript chunk, same model
// (Haiku 4.5), different prompt, different output shape.
//
// Why two passes vs. one: separation of concerns + independent
// evolution. The risk scorer's prompt is anchored to scoring
// behavior; the extractor's prompt is anchored to structured-output
// extraction. Coupling produces a brittle prompt that does both
// poorly. Cost is ~2x current per-chunk LLM spend; acceptable at
// Haiku 4.5 pricing.

// The 6 claim types — locked in LIVE_SHIELD_V3.md, do not extend
// without updating the spec section "B4 claim taxonomy" first.

export type ExtractedClaim =
  | {
      type: 'bank_affiliation';
      bank_name: string;
      raw_quote: string;
    }
  | {
      type: 'agency_affiliation';
      agency_name: string;
      raw_quote: string;
    }
  | {
      type: 'account_tail';
      last_4_digits: string;
      raw_quote: string;
    }
  | {
      type: 'case_number';
      number: string;
      claimed_institution: string;
      raw_quote: string;
    }
  | {
      type: 'employee_identity';
      name: string;
      title: string;
      org: string;
      raw_quote: string;
    }
  | {
      type: 'geographic_location';
      claimed_location: string;
      raw_quote: string;
    };

export interface ExtractInput {
  session_id: string;
  chunk_id: string;
  // Just-spoken scammer-side text. Already transcribed by v2's
  // pipeline; we don't re-do that work.
  text: string;
  // Recent context — last 60 seconds of scammer-side transcript.
  // Helps the LLM disambiguate phrases like "the case number" by
  // grounding which institution was referenced earlier.
  recent_context: string;
  // ISO8601 — the moment the chunk was uttered.
  spoken_at: string;
}

export interface ExtractResult {
  claims: ExtractedClaim[];
  // Diagnostic — how long the LLM call took. Surfaced via metrics
  // for cost + latency monitoring.
  latency_ms: number;
}

/**
 * Run the dedicated claim-extraction Claude pass on a transcript
 * chunk. Returns 0..N structured claims. The verifier service
 * (b4Verifier.ts) then consumes the claims and runs each against
 * its data sources.
 *
 * Phase 0 scaffold — interface is FINAL but the LLM call is a TODO.
 * The Phase 3 work is:
 *   1. Build the extraction prompt (system + user + structured
 *      output schema with one-shot examples per claim type)
 *   2. Wire to the existing Anthropic client (src/services/llm.ts)
 *   3. Parse the structured output, validate against ExtractedClaim
 *   4. Persist each claim to b4_extracted_claims keyed by
 *      (session_id, chunk_id)
 *
 * Cost envelope: Haiku 4.5 at ~$0.0005 per 1K tokens, ~500 tokens
 * per extraction → ~$0.00025 per chunk → ~$0.05 for a 5-min call
 * with 3-second chunks. Halve the chunk cadence if cost spikes.
 */
export async function extract(input: ExtractInput): Promise<ExtractResult> {
  if (!config.V3_B4_ENABLED) {
    return { claims: [], latency_ms: 0 };
  }

  const started = Date.now();

  // TODO(Phase 3): replace with the real Claude call. The contract is:
  //
  //   const response = await anthropicClient.messages.create({
  //     model: 'claude-haiku-4-5-20251001',
  //     max_tokens: 1024,
  //     system: CLAIM_EXTRACTION_SYSTEM_PROMPT,
  //     messages: [{
  //       role: 'user',
  //       content: buildUserPrompt(input)
  //     }],
  //     // structured output via tool-use OR JSON mode
  //   });
  //   const claims = parseExtractedClaims(response.content);
  //
  // The system prompt should:
  //   - Instruct: extract ONLY verifiable claims, not opinions
  //   - Provide one example per claim type
  //   - Specify: empty list if no claims (better than hallucinating)
  //   - Require: raw_quote is verbatim from text (we audit this)

  void input;
  const claims: ExtractedClaim[] = [];

  const latency_ms = Date.now() - started;
  emitMetric('v3.b4.claim_extracted', { chunk_id: input.chunk_id }, claims.length);
  emitMetric('v3.b4.claim_extractor_latency_ms', {}, latency_ms);

  return { claims, latency_ms };
}
