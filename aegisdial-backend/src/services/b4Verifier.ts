import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { emitMetric } from '../lib/observability.js';
import type { ExtractedClaim } from './claimExtractor.js';
import { verifyClaimViaLayer2 } from './b4Layer2.js';

// Live Shield v3 — B4 verifier service (real implementation).
//
// Consumes ExtractedClaim values from claimExtractor.ts and runs each
// through a layered verification pipeline:
//
//   Layer 1 — AegisDial curated directory (high-precision, low-coverage)
//             Top banks' outbound-calling rules, federal-agency
//             contact channels, account-tail compare against user's
//             on-file last-4, known-scam-script phrases.
//             Source seed at src/data/curatedB4Directory.json,
//             plus runtime overrides from b4_curated_overrides.
//
//   Layer 2 — Live web search via Claude tool-use against Serper.
//             SCAFFOLDED in this PR; Phase 3+ wires the actual
//             Claude tool-call. Returns cannot_verify for now —
//             which is the correct fallback shape.
//
// Locked rule (security): only `result === 'contradicted'` findings
// produce user-facing UI. `consistent` findings produce nothing —
// surfacing "verified true" creates a trust attack surface where a
// sophisticated scammer crafts claims that pass our verifier to
// manufacture trust. We never validate the scammer.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Finding {
  claim: ExtractedClaim;
  result: 'contradicted' | 'cannot_verify' | 'consistent';
  /** 0..1; V3_B4_TAKEOVER_THRESHOLD (default 0.95) gates takeover firing. */
  confidence: number;
  /** One-sentence explanation. Surfaced to users when result is contradicted. */
  reasoning: string;
  source_layer: 'curated' | 'web_search';
  source_url: string | null;
  source_snippet: string | null;
  source_curated_entry_id: string | null;
}

export interface VerifyInput {
  claim: ExtractedClaim;
  /** From the user's profile when claim.type === 'account_tail'. Null = user did not opt in to account-tail collection. */
  user_account_last_4: string | null;
  /** From v2's call_sessions.peer_e164 — the actual calling number. Used by bank/agency outbound-rule checks. */
  calling_number_e164: string | null;
  /** The active session id — Layer 2 uses this for its per-session
   * verification-budget cap so a single call can't burn the daily
   * Serper budget on bursty extraction. */
  session_id: string;
}

// ---------------------------------------------------------------------------
// Curated directory — loaded with a 5-minute TTL (see DIRECTORY_CACHE_TTL_MS
// below) and refreshed from b4_curated_overrides on each reload.
// ---------------------------------------------------------------------------

interface CuratedBankEntry {
  id: string;
  name: string;
  aliases: string[];
  outbound_calling_rule: string;
  published_outbound_numbers: string[];
}
interface CuratedAgencyEntry {
  id: string;
  name: string;
  aliases: string[];
  outbound_calling_rule: string;
  published_contact_channels: string[];
}
interface CuratedScriptRule {
  id: string;
  pattern: string;
  rationale: string;
}
interface CuratedDirectory {
  banks: CuratedBankEntry[];
  agencies: CuratedAgencyEntry[];
  scam_script_phrases: CuratedScriptRule[];
}

// 5-minute TTL on the curated directory cache. The original
// implementation cached forever (only `_resetDirectoryCacheForTests`
// would clear it), which meant any admin curation change required a
// process restart to take effect — slow rollback path in a live scam
// campaign. Five minutes is the same cadence we use elsewhere for
// admin-driven config (Company OS view refresh) and matches the
// adversarial-review HIGH #10 recommendation.
//
// The TTL window is also why the loader caches `Promise<CuratedDirectory>`
// rather than the resolved value — under burst load (multiple concurrent
// verify() calls right after TTL expiry), a single Promise gets shared
// instead of N parallel DB roundtrips that would each lose the cache race.
const DIRECTORY_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedDirectoryAt = 0;
let cachedDirectoryPromise: Promise<CuratedDirectory> | null = null;

async function loadDirectory(): Promise<CuratedDirectory> {
  const now = Date.now();
  if (cachedDirectoryPromise && (now - cachedDirectoryAt) < DIRECTORY_CACHE_TTL_MS) {
    return cachedDirectoryPromise;
  }

  // Stamp the start time BEFORE awaiting so concurrent callers
  // share the same in-flight load.
  cachedDirectoryAt = now;

  // Build the loader Promise locally. The .catch must compare against
  // this specific local reference rather than the module-level
  // `cachedDirectoryPromise` — that way a pathological load that
  // resolves AFTER a newer load has replaced the module pointer
  // doesn't clobber the newer reference. Without the aliasing guard,
  // an in-flight P1 that fails right after P2 is assigned would null
  // out P2's reference and force a wasted retry on the next caller.
  const localPromise: Promise<CuratedDirectory> = (async (): Promise<CuratedDirectory> => {
    const here = dirname(fileURLToPath(import.meta.url));
    const seedPath = resolve(here, '..', 'data', 'curatedB4Directory.json');
    const seedRaw = await readFile(seedPath, 'utf8');
    const seed = JSON.parse(seedRaw) as CuratedDirectory;

    // Apply runtime overrides from b4_curated_overrides. These can add
    // entries OR (in v3.5) replace existing entries by id; for v3 we
    // append-only since the seed entries are stable.
    try {
      const overrides = await query<{
        entry_type: string;
        org_name: string;
        data: Record<string, unknown>;
      }>(
        `SELECT entry_type, org_name, data
           FROM b4_curated_overrides
          WHERE enabled = TRUE`,
      );
      for (const ov of overrides.rows) {
        if (ov.entry_type === 'bank') {
          seed.banks.push(ov.data as unknown as CuratedBankEntry);
        } else if (ov.entry_type === 'agency') {
          seed.agencies.push(ov.data as unknown as CuratedAgencyEntry);
        } else if (ov.entry_type === 'rule') {
          seed.scam_script_phrases.push(ov.data as unknown as CuratedScriptRule);
        }
      }
      emitMetric('v3.b4.curated_directory_loaded', {
        bank_count: seed.banks.length,
        agency_count: seed.agencies.length,
        rule_count: seed.scam_script_phrases.length,
        override_count: overrides.rows.length,
      });
    } catch (err) {
      // DB unavailable at refresh — proceed with seed only.
      emitMetric('v3.b4.curated_overrides_load_failed', {});
      // eslint-disable-next-line no-console
      console.warn('[b4Verifier] failed to load curated overrides; using seed only', {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return seed;
  })();

  // Wrapped promise + aliasing guard. On rejection, only clear the
  // module-level pointer if it STILL references this exact promise.
  // A newer load (after TTL re-entry) replaces the pointer first;
  // this older promise's later rejection must not undo that.
  const wrappedPromise = localPromise.catch((err) => {
    if (cachedDirectoryPromise === wrappedPromise) {
      cachedDirectoryPromise = null;
      cachedDirectoryAt = 0;
    }
    throw err;
  });
  cachedDirectoryPromise = wrappedPromise;
  return wrappedPromise;
}

/**
 * Test-only — clear the directory cache so tests can swap fixtures
 * between runs.
 */
export function _resetDirectoryCacheForTests(): void {
  cachedDirectoryPromise = null;
  cachedDirectoryAt = 0;
}

// ---------------------------------------------------------------------------
// Verify entry point
// ---------------------------------------------------------------------------

/**
 * Verify a single claim. Returns a Finding regardless of outcome
 * (contradicted | cannot_verify | consistent) — caller decides what
 * to do with it.
 */
export async function verify(input: VerifyInput): Promise<Finding> {
  if (!config.V3_B4_ENABLED) {
    return cannotVerifyFinding(input.claim, 'feature_disabled');
  }

  const started = Date.now();
  const directory = await loadDirectory().catch((err) => {
    emitMetric('v3.b4.directory_load_failed', {});
    // eslint-disable-next-line no-console
    console.error('[b4Verifier] directory load failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  if (!directory) {
    return cannotVerifyFinding(input.claim, 'directory_unavailable');
  }

  let finding: Finding;
  switch (input.claim.type) {
    case 'bank_affiliation':
      finding = verifyBankAffiliation(input, directory);
      break;
    case 'agency_affiliation':
      finding = verifyAgencyAffiliation(input, directory);
      break;
    case 'account_tail':
      finding = verifyAccountTail(input);
      break;
    case 'case_number':
    case 'employee_identity':
    case 'geographic_location':
      // Layer 2 territory by default — these never hit the curated
      // directory (no curated case-number formats, employee rosters,
      // or location verifiers in v3). Goes straight to Serper + Claude.
      finding = await verifyViaWebSearch(input, directory);
      break;
  }

  // Layer 2 fallback for bank/agency claims that missed the curated
  // directory. Without this, "Acme Insurance" (not in our list of ~50
  // banks) always returned cannot_verify, defeating the point of L2.
  // Only fall through when L1 specifically said "not in directory" —
  // we trust L1's contradicted/consistent verdicts and don't re-search.
  if (
    finding.result === 'cannot_verify' &&
    finding.source_layer === 'curated' &&
    (input.claim.type === 'bank_affiliation' ||
      input.claim.type === 'agency_affiliation')
  ) {
    const l2 = await verifyViaWebSearch(input, directory);
    // Only promote L2 over L1 when L2 reached an actual verdict.
    // A cannot_verify result either way means we keep L1's metadata
    // (which already says "not in directory") so reasoning stays
    // honest about the path.
    if (l2.result !== 'cannot_verify') {
      finding = l2;
    }
  }

  const latency_ms = Date.now() - started;
  emitMetric('v3.b4.verification_completed', {
    result: finding.result,
    source_layer: finding.source_layer,
    claim_type: input.claim.type,
  });
  emitMetric('v3.b4.verifier_latency_ms', {}, latency_ms);

  return finding;
}

// ---------------------------------------------------------------------------
// Layer 1 — curated verifications
// ---------------------------------------------------------------------------

function verifyBankAffiliation(input: VerifyInput, dir: CuratedDirectory): Finding {
  if (input.claim.type !== 'bank_affiliation') {
    return cannotVerifyFinding(input.claim, 'wrong_type');
  }

  const claimedName = input.claim.bank_name.toLowerCase();
  const entry = dir.banks.find((b) =>
    b.aliases.some((a) => claimedName.includes(a.toLowerCase())),
  );

  if (!entry) {
    return {
      claim: input.claim,
      result: 'cannot_verify',
      confidence: 0,
      reasoning: 'Bank not in our curated directory; web-search fallback (Layer 2) not yet wired.',
      source_layer: 'curated',
      source_url: null,
      source_snippet: null,
      source_curated_entry_id: null,
    };
  }

  // If we have a published outbound list AND a calling number,
  // contradicted = high confidence. Otherwise the outbound rule
  // string itself is the qualitative ground truth.
  if (
    entry.published_outbound_numbers.length > 0 &&
    input.calling_number_e164 &&
    !entry.published_outbound_numbers.includes(input.calling_number_e164)
  ) {
    return {
      claim: input.claim,
      result: 'contradicted',
      confidence: 0.97,
      reasoning: `${entry.name} does not call from ${input.calling_number_e164}. Their published outbound numbers do not include this one.`,
      source_layer: 'curated',
      source_url: null,
      source_snippet: entry.outbound_calling_rule,
      source_curated_entry_id: entry.id,
    };
  }

  // Even without a published outbound list, the outbound_calling_rule
  // is itself a soft ground truth — banks don't cold-call about fraud,
  // they ask you to call them back. We mark this as contradicted at
  // moderate confidence so it bumps the Live Shield score but does
  // NOT trigger a takeover (below the 0.95 threshold).
  return {
    claim: input.claim,
    result: 'contradicted',
    confidence: 0.7,
    reasoning: entry.outbound_calling_rule,
    source_layer: 'curated',
    source_url: null,
    source_snippet: entry.outbound_calling_rule,
    source_curated_entry_id: entry.id,
  };
}

function verifyAgencyAffiliation(input: VerifyInput, dir: CuratedDirectory): Finding {
  if (input.claim.type !== 'agency_affiliation') {
    return cannotVerifyFinding(input.claim, 'wrong_type');
  }

  const claimedName = input.claim.agency_name.toLowerCase();
  const entry = dir.agencies.find((a) =>
    a.aliases.some((alias) => claimedName.includes(alias.toLowerCase())),
  );

  if (!entry) {
    return {
      claim: input.claim,
      result: 'cannot_verify',
      confidence: 0,
      reasoning: 'Agency not in our curated directory.',
      source_layer: 'curated',
      source_url: null,
      source_snippet: null,
      source_curated_entry_id: null,
    };
  }

  // Government agencies are a stronger signal than banks because the
  // outbound-calling rules are categorical (the IRS literally does not
  // initiate cold collection calls — that's not a tendency, that's a
  // policy). We mark these as contradicted at HIGH confidence.
  return {
    claim: input.claim,
    result: 'contradicted',
    confidence: 0.97,
    reasoning: entry.outbound_calling_rule,
    source_layer: 'curated',
    source_url: entry.published_contact_channels[0] ?? null,
    source_snippet: entry.outbound_calling_rule,
    source_curated_entry_id: entry.id,
  };
}

function verifyAccountTail(input: VerifyInput): Finding {
  if (input.claim.type !== 'account_tail') {
    return cannotVerifyFinding(input.claim, 'wrong_type');
  }

  if (!input.user_account_last_4) {
    // User did not opt in to account-tail collection. Cannot verify;
    // do not surface anything to the UI (R5 in risk register).
    return {
      claim: input.claim,
      result: 'cannot_verify',
      confidence: 0,
      reasoning: 'Account-tail comparison requires the user to have opted in to last-4 collection.',
      source_layer: 'curated',
      source_url: null,
      source_snippet: null,
      source_curated_entry_id: null,
    };
  }

  if (input.claim.last_4_digits === input.user_account_last_4) {
    // Matches — but per the locked rule we do NOT surface "consistent"
    // findings (security: never validate the scammer).
    return {
      claim: input.claim,
      result: 'consistent',
      confidence: 0.99,
      reasoning: 'Account tail matches the user\'s on-file last-4.',
      source_layer: 'curated',
      source_url: null,
      source_snippet: null,
      source_curated_entry_id: null,
    };
  }

  return {
    claim: input.claim,
    result: 'contradicted',
    confidence: 0.99,
    reasoning: `Caller said account ending in ${input.claim.last_4_digits}; user's on-file last-4 differs.`,
    source_layer: 'curated',
    source_url: null,
    source_snippet: null,
    source_curated_entry_id: null,
  };
}

// ---------------------------------------------------------------------------
// Layer 2 — web search via Claude tool-use (SCAFFOLDED)
// ---------------------------------------------------------------------------
//
// The Phase 3+ wiring is:
//
//   1. Build a Claude tool-use prompt that lets the model call:
//      webSearch(query: string) -> { title, snippet, url }[]
//   2. Wire webSearch to the existing Serper integration
//      (src/crawlers/serper.ts) — same client A1 already uses.
//   3. After the tool call, Claude reads results and decides
//      contradicted / cannot_verify / consistent + confidence.
//   4. Map result back into the Finding shape; the search-result
//      URL + snippet become source_url + source_snippet (provenance).
//
// For this PR, the function returns cannot_verify for all Layer 2
// claim types. This is the correct fallback shape — those claims
// would have been "in the web-search fallback" anyway, so users see
// no Layer 2 findings rather than incorrect findings.

async function verifyViaWebSearch(
  input: VerifyInput,
  _dir: CuratedDirectory,
): Promise<Finding> {
  // Layer 2 — Serper web search + Claude verification.
  // See src/services/b4Layer2.ts for the implementation details
  // (per-session cap, 1h cache, sanitized search-query shapes).
  // Returns null when L2 is disabled, budget-exceeded, or both API
  // keys are absent; we surface that as cannot_verify with a
  // tagged reasoning string so the score-boost path still fires
  // through the cannot_verify weight.
  const l2 = await verifyClaimViaLayer2(input.claim, input.session_id);
  if (!l2) {
    return {
      claim: input.claim,
      result: 'cannot_verify',
      confidence: 0,
      reasoning: 'Layer 2 verifier unavailable or budget exhausted for this session.',
      source_layer: 'web_search',
      source_url: null,
      source_snippet: null,
      source_curated_entry_id: null,
    };
  }
  return {
    claim: input.claim,
    result: l2.result,
    confidence: l2.confidence,
    reasoning: l2.reasoning,
    source_layer: 'web_search',
    source_url: l2.source_url,
    source_snippet: l2.source_snippet,
    source_curated_entry_id: null,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist a Finding linked to its claim. Returns the new finding id
 * so the orchestrator can correlate takeover-dispatch with finding.
 */
export async function persistFinding(
  claim_id: string,
  session_id: string,
  finding: Finding,
): Promise<string> {
  // Two writes per finding:
  //   1. INSERT into b4_findings (the audit row)
  //   2. UPDATE call_sessions denormalized counters:
  //        b4_findings_count + 1 (always)
  //        b4_contradicted_count + 1 (only on contradicted result)
  //
  // The counters are read by the transcript-flush cadence picker
  // (adaptiveCadence.ts via has_b4_claim_activity) and by the
  // post-call recap UI. Without the increment the cadence floor
  // signal is permanently false — caught by the C1 adversarial
  // finding on the adaptive-cadence PR.
  //
  // Not wrapped in withTx because the orchestrator's call site
  // (b4Orchestrator.dispatchFinding) doesn't open a transaction
  // either — the audit + counter pair is best-effort; a torn
  // write means the counter undercounts by 1, which is
  // observationally fine. If we ever need exactly-once semantics,
  // upgrade both queries to a single withTx block.
  const result = await query<{ id: string }>(
    `INSERT INTO b4_findings
       (claim_id, session_id, result, confidence, reasoning,
        source_layer, source_url, source_snippet, source_curated_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      claim_id,
      session_id,
      finding.result,
      finding.confidence,
      finding.reasoning,
      finding.source_layer,
      finding.source_url,
      finding.source_snippet,
      finding.source_curated_entry_id,
    ],
  );

  const isContradicted = finding.result === 'contradicted';
  await query(
    `UPDATE call_sessions
        SET b4_findings_count = b4_findings_count + 1,
            b4_contradicted_count = b4_contradicted_count + $2
      WHERE id = $1`,
    [session_id, isContradicted ? 1 : 0],
  );

  return result.rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cannotVerifyFinding(claim: ExtractedClaim, reason: string): Finding {
  return {
    claim,
    result: 'cannot_verify',
    confidence: 0,
    reasoning: `Verifier returned cannot_verify (reason: ${reason}).`,
    source_layer: 'curated',
    source_url: null,
    source_snippet: null,
    source_curated_entry_id: null,
  };
}
