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
  /** When the extractor short-circuited (no API key, flag off, etc.). */
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
 *   - Network error / timeout → returns { claims: [], skipped: true }
 *   - Malformed JSON from model → claims that fail validation are dropped;
 *     well-formed claims survive
 */
export async function extract(input: ExtractInput): Promise<ExtractResult> {
  if (!config.V3_B4_ENABLED || !config.ANTHROPIC_API_KEY) {
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
  switch (c.type) {
    case 'bank_affiliation':
      if (typeof c.bank_name !== 'string' || c.bank_name.length === 0) return null;
      return { type: 'bank_affiliation', bank_name: c.bank_name, raw_quote };
    case 'agency_affiliation':
      if (typeof c.agency_name !== 'string' || c.agency_name.length === 0) return null;
      return { type: 'agency_affiliation', agency_name: c.agency_name, raw_quote };
    case 'account_tail':
      if (typeof c.last_4_digits !== 'string' || !/^\d{4}$/.test(c.last_4_digits)) return null;
      return { type: 'account_tail', last_4_digits: c.last_4_digits, raw_quote };
    case 'case_number':
      if (typeof c.number !== 'string' || typeof c.claimed_institution !== 'string') return null;
      return {
        type: 'case_number',
        number: c.number,
        claimed_institution: c.claimed_institution,
        raw_quote,
      };
    case 'employee_identity':
      if (
        typeof c.name !== 'string' ||
        typeof c.title !== 'string' ||
        typeof c.org !== 'string'
      ) {
        return null;
      }
      return {
        type: 'employee_identity',
        name: c.name,
        title: c.title,
        org: c.org,
        raw_quote,
      };
    case 'geographic_location':
      if (typeof c.claimed_location !== 'string' || c.claimed_location.length === 0) return null;
      return {
        type: 'geographic_location',
        claimed_location: c.claimed_location,
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
