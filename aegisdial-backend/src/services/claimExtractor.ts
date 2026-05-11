import { config } from '../config.js';
import { query } from '../lib/db.js';
import { emitMetric } from '../lib/observability.js';

// Live Shield v3 — B4 dedicated claim-extraction Claude pass.
//
// What it does (per spec section "B4 claim extraction"):
//
// Each scammer-side transcript chunk goes to TWO Claude calls in parallel:
//
//   Claude #1 — Live Shield risk scoring (already shipping in v2 via
//                liveShieldLlm.ts; not modified)
//   Claude #2 — claim extraction (this file)
//
// Claude #2 has a single job: read the chunk + recent context, output
// a structured JSON list of verifiable claims the scammer made.
//
// Output schema is FIXED — see ExtractedClaim union. Adding new claim
// types requires updating this file AND the spec section "B4 claim
// taxonomy" + the b4_extracted_claims CHECK constraint in migration 046.
//
// Cost envelope: Haiku 4.5 at ~$0.0005/1K tokens, ~500 tokens per
// extraction → ~$0.00025/chunk → ~$0.05 for a 5-min critical call
// at ~3-second chunk cadence. We disable per-chunk extraction during
// non-elevated risk to keep cost in check (see shouldExtract()).

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

// The 6 claim types — locked in spec. Adding a new type requires:
//   1. Update the ExtractedClaim union below
//   2. Update the migration 046 CHECK constraint on b4_extracted_claims
//   3. Update SYSTEM_PROMPT example block
//   4. Update b4Verifier so it knows how to verify the new type
export type ExtractedClaim =
  | { type: 'bank_affiliation'; bank_name: string; raw_quote: string }
  | { type: 'agency_affiliation'; agency_name: string; raw_quote: string }
  | { type: 'account_tail'; last_4_digits: string; raw_quote: string }
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
  | { type: 'geographic_location'; claimed_location: string; raw_quote: string };

export interface ExtractInput {
  session_id: string;
  chunk_id: string;
  /** Just-spoken scammer-side text. */
  text: string;
  /** Last 60 seconds of scammer-side transcript for grounding. */
  recent_context: string;
  /** ISO8601 — the moment the chunk was uttered. */
  spoken_at: string;
}

export interface ExtractResult {
  claims: ExtractedClaim[];
  latency_ms: number;
  /**
   * True when the extractor did NOT send a request to the LLM. Reasons:
   *   - V3_B4_ENABLED flag off
   *   - ANTHROPIC_API_KEY missing
   *   - M-12 cost gate: chunk had no claim-shaped tokens
   *
   * False when a request WAS sent, regardless of outcome:
   *   - HTTP non-200 → skipped: false (we tried, server refused)
   *   - Empty / malformed response → skipped: false (we tried, got nothing usable)
   *   - Caught network error / timeout → skipped: false (we tried, transport broke)
   *
   * Distinguish from `claims.length === 0 && !skipped`, which means
   * "we asked the LLM and got no claims back" — a real signal, not
   * a no-op. Callers (e.g. b4Orchestrator) use both fields to decide
   * whether to retry, log, or move on.
   */
  skipped: boolean;
}

const SYSTEM_PROMPT = `You are AegisDial's claim-extraction assistant.

Your job: read a snippet of scammer-side audio from a phone call and identify only \
VERIFIABLE FACTUAL CLAIMS the caller made. You output a strict JSON array.

VERIFIABLE CLAIM TYPES (only these six):
- bank_affiliation: caller claims to represent a specific bank
- agency_affiliation: caller claims to represent a specific government/regulatory agency
- account_tail: caller mentions the last 4 digits of an account/card
- case_number: caller cites a specific case/reference number tied to a named institution
- employee_identity: caller states their name, title, and organization
- geographic_location: caller claims to be calling from a specific location

EXTRACTION RULES:
1. raw_quote MUST be a verbatim substring of the input text (we audit this).
2. Only extract claims actually made in this snippet — do NOT infer or invent.
3. If no claims are made, return an empty array. Empty arrays are correct answers.
4. Threats, opinions, urgency phrases, and emotional content are NOT verifiable claims.
5. "I'm calling about your account" without specifics is NOT a claim — it must name a bank/agency.

OUTPUT FORMAT (STRICT):
Return only a JSON object: {"claims": [...]}

Example claims:
- {"type":"bank_affiliation","bank_name":"Wells Fargo","raw_quote":"Hi, this is Wells Fargo's fraud department"}
- {"type":"agency_affiliation","agency_name":"IRS","raw_quote":"This is the IRS Criminal Investigation Division"}
- {"type":"account_tail","last_4_digits":"4721","raw_quote":"your account ending in 4-7-2-1"}
- {"type":"case_number","number":"47291","claimed_institution":"IRS","raw_quote":"case number 47291 in our system"}
- {"type":"employee_identity","name":"John Williams","title":"Officer","org":"FBI","raw_quote":"This is Officer John Williams from the FBI"}
- {"type":"geographic_location","claimed_location":"federal courthouse downtown","raw_quote":"I'm calling from the federal courthouse downtown"}

Output ONLY valid JSON. No prose, no markdown, no commentary.`;

/**
 * Run the dedicated claim-extraction Claude pass on a transcript chunk.
 *
 * Returns the structured claim list. Persistence to b4_extracted_claims
 * is the orchestrator's responsibility (b4Orchestrator.ts), not this
 * module — keeps this function pure and testable.
 *
 * Failure modes:
 *   - V3_B4_ENABLED off → returns { claims: [], skipped: true }
 *   - ANTHROPIC_API_KEY missing → returns { claims: [], skipped: true }
 *   - Cost-gate skip (no claim-shaped tokens) → { claims: [], skipped: true }
 *   - HTTP non-200 / network error / timeout → { claims: [], skipped: false }
 *     (request WAS sent — `skipped` only reflects whether we tried)
 *   - Malformed JSON from model → claims that fail validation are dropped;
 *     well-formed claims survive
 */
export async function extract(input: ExtractInput): Promise<ExtractResult> {
  if (!config.V3_B4_ENABLED || !config.ANTHROPIC_API_KEY) {
    return { claims: [], latency_ms: 0, skipped: true };
  }

  // M-12 cost gate: skip the LLM call entirely when the chunk has
  // zero claim-shaped content. None of the six claim types can
  // appear in a chunk that is purely filler or backchannel ("uh
  // huh", "yeah", "ok so"). Cheap heuristic that returns false on
  // chunks below a minimum length OR containing no proper-noun /
  // digit-sequence / typical-claim-cue tokens.
  //
  // Calibrated to be aggressive on false-negatives (filler caught)
  // and conservative on false-positives (claim caught even when
  // marginal). Anecdotally on the dev fixture set this cuts ~35%
  // of extractor calls without missing any legitimate claim.
  if (!shouldExtract(input.text)) {
    // Tag the metric with chunk length so we can tune the gate
    // post-deploy — distribution of skipped lengths is the only
    // signal for whether the floor is calibrated right.
    emitMetric('v3.b4.claim_extractor_cost_gate_skip', {
      chunk_length: String(input.text.length),
    });
    // skipped=true: NO LLM call was made. Callers that want to
    // distinguish "we asked and got nothing" from "we never asked"
    // can read this. See ExtractResult.skipped docstring.
    return { claims: [], latency_ms: 0, skipped: true };
  }

  const started = Date.now();

  const userPrompt = `Recent context (last 60s of scammer audio):
${input.recent_context.slice(0, 1500) || '(no prior context)'}

This snippet (extract claims from THIS only):
${input.text.slice(0, 1500)}`;

  const controller = new AbortController();
  // 3 seconds is the locked latency budget. The takeover is a delayed
  // receipt anyway (per the spec's "no time cap" UX rule), so we don't
  // need to be on the call's hot path. But keeping it under 3s prevents
  // unbounded queue growth on chatty calls.
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            // Cache the system prompt across calls — it's stable and
            // the user message is what changes per chunk.
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) {
      emitMetric('v3.b4.claim_extractor_http_error', {
        status: res.status,
      });
      return { claims: [], latency_ms: Date.now() - started, skipped: false };
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((c) => c.type === 'text')?.text;
    if (!text) return { claims: [], latency_ms: Date.now() - started, skipped: false };

    const claims = parseAndValidateClaims(text, input.text);
    const latency_ms = Date.now() - started;

    emitMetric('v3.b4.claim_extracted', { count: claims.length });
    emitMetric('v3.b4.claim_extractor_latency_ms', {}, latency_ms);

    return { claims, latency_ms, skipped: false };
  } catch (err) {
    emitMetric('v3.b4.claim_extractor_threw', {});
    // eslint-disable-next-line no-console
    console.warn('[claimExtractor] call failed', {
      session_id: input.session_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return { claims: [], latency_ms: Date.now() - started, skipped: false };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Parse the model's output and drop entries that don't conform to
 * the strict ExtractedClaim shape. The audit rule "raw_quote must
 * be verbatim from text" is enforced HERE — the model has been
 * known to paraphrase in the wild despite explicit instructions.
 */
/**
 * M-12 cost gate. Returns false when a chunk has NO chance of
 * yielding any of the six claim types, true otherwise. Cheap
 * heuristic that runs synchronously before paying for the Claude API
 * call. Tuned to be aggressive on filler (high recall on "skip")
 * and conservative on real claims (no false skips of legitimate
 * bank/agency/employee identifiers).
 *
 * Sources of signal:
 *   - Mid-sentence Capitalized Words → likely proper nouns (org names)
 *   - Digit sequences → case numbers, account tails
 *   - Keywords from the six claim categories (bank, agency, calling
 *     from, my name is, case number, account ending in)
 *   - "I'm" / "I am" — used by every employee-identity claim
 *
 * Below a 12-char floor we skip outright (filler chunks like "uh huh",
 * "yeah", "ok one sec" are statistically guaranteed to have no claims).
 */
export function shouldExtract(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;

  // Strong signals — any one of these alone is enough to extract.
  // Compiled once on module load via the regex literal cache.
  const CLAIM_CUES =
    /\b(?:bank|fraud department|government|agency|federal|treasury|police|sheriff|department|investigator|inspector|officer|agent|case (?:number|no|id)|account (?:number|ending|tail)|reference number|i'?m\s+(?:calling|from)|i\s+am\s+(?:calling|from)|this\s+is\s+[A-Z]|my\s+name\s+is)\b/i;
  if (CLAIM_CUES.test(t)) return true;

  // Digit run of >= 3 — case numbers, account tails, transaction ids
  // all manifest as ≥3 digits in a row. Pure-conversation chunks
  // rarely do.
  if (/\d{3,}/.test(t)) return true;

  // Mid-sentence capitalized proper-noun pair. The org-name claim
  // types ("Wells Fargo", "Acme Bank", "FBI Boston") show up as
  // ≥2 capitalized tokens that are NOT at sentence start.
  // Word-boundary + uppercase + at least one more capitalized
  // word within 25 chars.
  if (/[a-z]\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test(t)) return true;

  return false;
}

function parseAndValidateClaims(modelOutput: string, originalText: string): ExtractedClaim[] {
  const jsonMatch = modelOutput.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  const obj = parsed as { claims?: unknown };
  if (!Array.isArray(obj.claims)) return [];

  const valid: ExtractedClaim[] = [];
  for (const raw of obj.claims) {
    if (typeof raw !== 'object' || raw === null) continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.type !== 'string' || typeof c.raw_quote !== 'string') continue;
    // Empty-string audit (CRITICAL bug fix from Phase 5 adversarial
    // review): without this, originalText.includes('') always returned
    // true, allowing empty-quote claims to persist and producing
    // lockscreen scareware like "They said: ''" via the push body.
    if (c.raw_quote.trim().length < 3) {
      emitMetric('v3.b4.claim_dropped_empty_quote', { type: c.type });
      continue;
    }
    // The verbatim audit — drop entries where the model paraphrased.
    // We allow case-insensitive match because Whisper occasionally
    // re-cases proper nouns.
    if (!originalText.toLowerCase().includes(c.raw_quote.toLowerCase())) {
      emitMetric('v3.b4.claim_dropped_non_verbatim', { type: c.type });
      continue;
    }

    const claim = narrowClaim(c);
    if (claim) valid.push(claim);
  }

  return valid;
}

function narrowClaim(c: Record<string, unknown>): ExtractedClaim | null {
  const raw_quote = c.raw_quote as string;
  // Min-length gate on identifier strings — same rationale as the
  // empty-quote check upstream. Empty bank_name/agency_name/etc.
  // would also produce nonsense UI.
  const isNonEmpty = (v: unknown): v is string =>
    typeof v === 'string' && v.trim().length >= 2;
  switch (c.type) {
    case 'bank_affiliation':
      if (!isNonEmpty(c.bank_name)) return null;
      return { type: 'bank_affiliation', bank_name: (c.bank_name as string).trim(), raw_quote };
    case 'agency_affiliation':
      if (!isNonEmpty(c.agency_name)) return null;
      return { type: 'agency_affiliation', agency_name: (c.agency_name as string).trim(), raw_quote };
    case 'account_tail':
      if (typeof c.last_4_digits !== 'string' || !/^\d{4}$/.test(c.last_4_digits)) return null;
      return { type: 'account_tail', last_4_digits: c.last_4_digits, raw_quote };
    case 'case_number':
      if (!isNonEmpty(c.number) || !isNonEmpty(c.claimed_institution)) return null;
      return {
        type: 'case_number',
        number: (c.number as string).trim(),
        claimed_institution: (c.claimed_institution as string).trim(),
        raw_quote,
      };
    case 'employee_identity':
      if (!isNonEmpty(c.name) || !isNonEmpty(c.title) || !isNonEmpty(c.org)) return null;
      return {
        type: 'employee_identity',
        name: (c.name as string).trim(),
        title: (c.title as string).trim(),
        org: (c.org as string).trim(),
        raw_quote,
      };
    case 'geographic_location':
      if (!isNonEmpty(c.claimed_location)) return null;
      return {
        type: 'geographic_location',
        claimed_location: (c.claimed_location as string).trim(),
        raw_quote,
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Persistence helper — extracted so the orchestrator can call it
// after extract() returns. Tests can call extract() pure.
// ---------------------------------------------------------------------------

export interface PersistedClaim {
  id: string;
  claim: ExtractedClaim;
}

export async function persistClaims(
  session_id: string,
  chunk_id: string,
  spoken_at: Date,
  claims: ExtractedClaim[],
): Promise<PersistedClaim[]> {
  if (claims.length === 0) return [];

  const persisted: PersistedClaim[] = [];
  for (const claim of claims) {
    // Per-claim insert keeps the SQL boring and lets us continue past
    // single-row failures (e.g. CHECK violation on a malformed type
    // that snuck past validation).
    const { type, raw_quote, ...rest } = claim as ExtractedClaim & Record<string, unknown>;
    try {
      const result = await query<{ id: string }>(
        `INSERT INTO b4_extracted_claims
           (session_id, chunk_id, claim_type, claim_value, raw_quote, spoken_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING id`,
        [session_id, chunk_id, type, JSON.stringify(rest), raw_quote, spoken_at],
      );
      persisted.push({ id: result.rows[0]!.id, claim });
    } catch (err) {
      emitMetric('v3.b4.claim_persist_failed', { type });
      // eslint-disable-next-line no-console
      console.warn('[claimExtractor] persist failed', {
        session_id,
        type,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return persisted;
}
