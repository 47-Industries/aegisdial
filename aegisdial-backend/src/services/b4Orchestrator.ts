import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { emitMetric } from '../lib/observability.js';
import { subscribeTranscript, type TranscriptChunkEvent } from './v3SessionEvents.js';
import {
  extract,
  persistClaims,
  shouldExtract,
  type ExtractedClaim,
} from './claimExtractor.js';
import { PLAYBOOKS_BY_ID, type PlaybookId } from '../data/playbooks.js';
import { isClaimTypeExpected } from '../lib/playbookClaimCoverage.js';
import { verify, persistFinding, type Finding } from './b4Verifier.js';
import {
  emitSystemEvent,
  b4FindingContradicted,
  b4TakeoverFired,
} from './transcriptEvents.js';
import { enqueueCriticalTakeoverPush } from './v3PushDispatcher.js';

// Live Shield v3 — B4 orchestrator.
//
// Singleton subscriber that coordinates the full B4 pipeline per
// scammer-side transcript chunk:
//
//   1. extract() — Claude #2 returns 0..N structured claims
//   2. persistClaims() — write to b4_extracted_claims
//   3. For each claim: verify() — curated lookup or web search
//   4. persistFinding() — write to b4_findings
//   5. Dispatch logic:
//        - contradicted ≥ V3_B4_TAKEOVER_THRESHOLD → fire takeover
//          (gated by per-(session, claim_type) cap via UNIQUE PK
//          on b4_takeover_dispatched)
//        - lower-confidence contradicted → log + transcript marker,
//          no takeover (TODO Phase 3+: also score-boost)
//        - cannot_verify → log only
//        - consistent → silently drop (locked security rule)
//
// One subscriber per process. Idempotency for takeover dispatch is
// enforced atomically via INSERT INTO b4_takeover_dispatched —
// duplicate (session_id, claim_type) inserts fail and we suppress.
//
// Per-session rolling 60s scammer-side context buffer lives here for
// grounding the claim extractor's input (avoids each chunk having
// to fetch its own context from DB). Bounded by the session's
// duration; cleaned up via endSession() called from the live-shield
// session-end route (Phase 5 second-pass adversarial fix — the first
// pass claimed this was wired but it wasn't, leading to monotonic Map
// growth on long-running prod processes).

interface SessionContext {
  rolling_text: Array<{ text: string; spoken_at: Date }>;
}
const sessionContexts = new Map<string, SessionContext>();

let unsubscribe: (() => void) | null = null;
let userAccountLast4Cache = new Map<string, string | null>();

/**
 * Drop per-session in-memory state. Called from the live-shield
 * session-end route so prod processes don't accumulate unbounded
 * `sessionContexts` entries over time. Idempotent — fine to call on
 * a session that already ended or never had any B4 activity.
 *
 * Does NOT drop `userAccountLast4Cache` (keyed by user_id, bounded by
 * subscriber count). If/when account_tail collection ships and that
 * cache grows real entries, add an LRU bound instead.
 */
export function endSession(session_id: string): void {
  sessionContexts.delete(session_id);
}

/**
 * Wire the orchestrator up at app startup. Subscribes to scammer-side
 * chunks via v3SessionEvents and runs each through the B4 pipeline.
 *
 * No-op if V3_B4_ENABLED is off.
 */
export function startB4Orchestrator(): void {
  if (!config.V3_B4_ENABLED) return;
  if (unsubscribe) return; // already started

  unsubscribe = subscribeTranscript((event) => {
    if (event.speaker !== 'caller') return; // only scammer-side claims are interesting
    void handleScammerChunk(event).catch((err) => {
      emitMetric('v3.b4.orchestrator_threw', {});
      // eslint-disable-next-line no-console
      console.error('[b4Orchestrator] handler threw', {
        session_id: event.session_id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  });

  emitMetric('v3.b4.orchestrator_started', {});
}

export function stopB4Orchestrator(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  sessionContexts.clear();
  userAccountLast4Cache.clear();
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function handleScammerChunk(event: TranscriptChunkEvent): Promise<void> {
  // Maintain rolling 60s context per session.
  const ctx = appendToSessionContext(event);

  // Generate a chunk_id for this transcript event. v2's transcript
  // route persists chunks but doesn't emit the row id; we synthesize
  // a UUID here so downstream rows correlate within v3 even if they
  // can't join back to transcript_events.id.
  const chunk_id = randomUUID();

  const recent_context = ctx.rolling_text
    .map((e) => e.text)
    .join(' ')
    .slice(-2000); // hard cap for prompt size

  // Cost-gate check INLINED here (extract() also runs it internally).
  // Inlining externally lets us short-circuit BEFORE the getSessionContext
  // DB SELECT — without this, every filler chunk ("uh huh", "yeah")
  // would pay one round-trip just to discover it doesn't need
  // playbook grounding. shouldExtract is pure text math, so the
  // duplicate call is cheap.
  //
  // We DO emit the cost-gate metric here to keep totals comparable
  // with prior versions (where extract()'s inner gate was the only
  // emitter). Same tag shape so dashboards don't fragment.
  if (!shouldExtract(event.text)) {
    emitMetric('v3.b4.claim_extractor_cost_gate_skip', {
      chunk_length: String(event.text.length),
    });
    return;
  }

  // v4 Phase 5 — fetch playbook context BEFORE extract so the LLM
  // call can include the playbook-grounding bias. Combined with
  // peer_e164 in a single SELECT to avoid an extra round-trip later
  // for the affiliation verifiers.
  const sessCtx = await getSessionContext(event.session_id);

  const result = await extract({
    session_id: event.session_id,
    chunk_id,
    text: event.text,
    recent_context,
    spoken_at: event.spoken_at.toISOString(),
    v4_playbook_id: sessCtx.v4_playbook_id,
  });

  if (result.skipped || result.claims.length === 0) return;

  // v4 Phase 12 — claim-expectation diff telemetry. The admin coverage
  // view (GET /admin/v4/claim-coverage) aggregates these emissions
  // into a per-playbook gap/surprise table — the calibration gate
  // before any V4_PLAYBOOK_*_ENABLED flag flips ON in prod.
  //
  // Intentional skew: emit BEFORE persistClaims, so the metric
  // reflects "what the LLM extracted" not "what the DB stored". If
  // a per-row INSERT fails (CHECK constraint, conflict, etc.) the
  // operator should still see what the LLM thought it found —
  // that's a calibration signal regardless of storage outcome.
  // Audit cross-reference is v3.b4.claim_persist_failed if anyone
  // wants to reconcile.
  emitClaimCoverageMetricsForChunk(sessCtx.v4_playbook_id, result.claims);

  const persisted = await persistClaims(
    event.session_id,
    chunk_id,
    event.spoken_at,
    result.claims,
  );

  // Look up the user's on-file account last-4 once per session and
  // cache. account_tail verification needs this; other claim types
  // ignore it.
  const userLast4 = await getUserAccountLast4(event.user_id);
  const callingNumber = sessCtx.peer_e164;

  for (const { id: claim_id, claim } of persisted) {
    const finding = await verify({
      claim,
      user_account_last_4: userLast4,
      calling_number_e164: callingNumber,
      session_id: event.session_id,
      // v4 Phase 6 — thread the locked-on playbook into the verifier
      // so Layer 2's Claude prompt can include playbook context as
      // background. NULL when v4 is off or hasn't classified yet —
      // verifier falls through to its legacy prompt shape.
      v4_playbook_id: sessCtx.v4_playbook_id,
    });

    let finding_id: string | null = null;
    try {
      finding_id = await persistFinding(claim_id, event.session_id, finding);
    } catch (err) {
      emitMetric('v3.b4.finding_persist_failed', {});
      // eslint-disable-next-line no-console
      console.warn('[b4Orchestrator] persistFinding failed', {
        session_id: event.session_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    await dispatchFinding(event, claim, finding, finding_id);
  }
}

/**
 * v4 Phase 12 — emit claim-coverage telemetry for the chunk's
 * extracted claims. Pure gate composition; extracted from the inline
 * handler so the gate logic is testable without mocking Anthropic
 * (same MEDIUM-2 lesson Phase 10 caught).
 *
 * Skips when:
 *   - V4_B4_CLAIM_COVERAGE_TELEMETRY_ENABLED is off
 *   - master V4_PLAYBOOK_AWARE_ENABLED is off (no lock to attribute)
 *   - playbook_id is null (classifier hasn't locked yet)
 *
 * Per-claim: skips emission when isClaimTypeExpected returns null
 * (un-classifiable inputs — would only pollute dropped_off_taxonomy
 * downstream).
 */
function emitClaimCoverageMetricsForChunk(
  playbook_id: PlaybookId | null,
  claims: readonly ExtractedClaim[],
): void {
  if (!config.V4_B4_CLAIM_COVERAGE_TELEMETRY_ENABLED) return;
  if (!config.V4_PLAYBOOK_AWARE_ENABLED) return;
  if (!playbook_id) return;
  for (const claim of claims) {
    const expected = isClaimTypeExpected(playbook_id, claim.type);
    // MUST stay `=== null`. The predicate returns boolean | null;
    // `false` means "valid type, not in this playbook's expectation
    // list" — that's the SURPRISE branch and we WANT to emit it.
    // A naive `!expected` simplification would drop every surprise
    // emission and silently empty the actionable half of the
    // coverage dashboard.
    if (expected === null) continue;
    emitMetric('v4.b4.claim_extracted_vs_playbook', {
      playbook_id,
      claim_type: claim.type,
      expected: expected ? 'true' : 'false',
    });
  }
}

function appendToSessionContext(event: TranscriptChunkEvent): SessionContext {
  let ctx = sessionContexts.get(event.session_id);
  if (!ctx) {
    ctx = { rolling_text: [] };
    sessionContexts.set(event.session_id, ctx);
  }
  ctx.rolling_text.push({ text: event.text, spoken_at: event.spoken_at });

  // Prune entries older than 60s.
  const cutoff = Date.now() - 60_000;
  while (
    ctx.rolling_text.length > 0 &&
    ctx.rolling_text[0]!.spoken_at.getTime() < cutoff
  ) {
    ctx.rolling_text.shift();
  }

  return ctx;
}

async function dispatchFinding(
  event: TranscriptChunkEvent,
  claim: ExtractedClaim,
  finding: Finding,
  finding_id: string | null,
): Promise<void> {
  emitMetric('v3.b4.finding_dispatched', {
    result: finding.result,
    confidence_bucket: bucketB4Confidence(finding.confidence),
  });

  // Locked security rule: NEVER surface consistent findings to UI or
  // to the score. They produce nothing.
  if (finding.result === 'consistent') return;

  // cannot_verify findings: small additive score boost (Gap #3). The
  // verifier couldn't decide either way — mildly suspicious but a
  // single such finding shouldn't escalate alone. The transcript
  // route reads call_sessions.b4_score_boost and merges it into
  // the running risk_score, so multiple weak signals stack.
  if (finding.result === 'cannot_verify') {
    const boost = Math.round(
      config.V3_B4_SCORE_BOOST_CANNOT_VERIFY_WEIGHT * finding.confidence * 100,
    );
    if (boost > 0) {
      await applyB4ScoreBoost(event.session_id, boost);
      emitMetric('v3.b4.cannot_verify_score_boost', {
        claim_type: claim.type,
        boost: String(boost),
      });
    }
    return;
  }

  // contradicted — emit transcript marker regardless of confidence so
  // the family-plan member sees it land.
  if (finding_id) {
    void emitSystemEvent(
      b4FindingContradicted(event.session_id, event.user_id, {
        claim_type: claim.type,
        raw_quote: claim.raw_quote,
        confidence: finding.confidence,
        source_layer: finding.source_layer,
      }),
    );
  }

  // Below-threshold contradictions: score-boost (Gap #3 fix).
  // V3_B4_SCORE_BOOST_LOW_CONF_WEIGHT * confidence as integer
  // points, additive on call_sessions.b4_score_boost. Multiple
  // weak contradictions stack toward critical without any single
  // one needing to clear the takeover threshold.
  if (finding.confidence < config.V3_B4_TAKEOVER_THRESHOLD) {
    emitMetric('v3.b4.contradiction_below_threshold', {
      claim_type: claim.type,
    });
    const boost = Math.round(
      config.V3_B4_SCORE_BOOST_LOW_CONF_WEIGHT * finding.confidence * 100,
    );
    if (boost > 0) {
      await applyB4ScoreBoost(event.session_id, boost);
      emitMetric('v3.b4.low_conf_score_boost', {
        claim_type: claim.type,
        boost: String(boost),
      });
    }
    return;
  }

  // Above threshold — try to claim takeover dispatch. The UNIQUE PK
  // on b4_takeover_dispatched (session_id, claim_type) is the cap.
  if (!finding_id) return; // can't track without a finding row
  const claimed = await claimTakeoverDispatch(event.session_id, claim.type, finding_id);
  if (!claimed) {
    emitMetric('v3.b4.takeover_suppressed_by_cap', { claim_type: claim.type });
    return;
  }

  // Atomically claim b3_takeover_fired_at on the call session — same
  // pattern B3 uses. The takeover view is shared (CriticalInterruptView);
  // B4 just reuses the same dispatch path with different copy.
  //
  // CRITICAL bug fix from the second adversarial-review pass: the prior
  // version used `SET b3_takeover_fired_at = COALESCE(...)` which always
  // succeeded for an existing session and made the enqueue
  // unconditional. A scammer who landed contradicted claims of two
  // different `claim_type`s (e.g. bank_affiliation + agency_affiliation)
  // would punch through `claimTakeoverDispatch` twice (different PK
  // rows) and produce two critical-priority pushes per call. The
  // WHERE-guard below restores the wasFirstTakeover semantics the B3
  // route uses; subsequent B4 findings still record their audit row
  // via the b4_takeover_dispatched table but don't re-fire APNs.
  const claimSession = await query(
    `UPDATE call_sessions
        SET b3_takeover_fired_at = NOW()
      WHERE id = $1 AND b3_takeover_fired_at IS NULL`,
    [event.session_id],
  );
  const wasFirstTakeover = (claimSession.rowCount ?? 0) > 0;

  emitMetric('v3.b4.takeover_fired', {
    claim_type: claim.type,
    confidence_bucket: bucketB4Confidence(finding.confidence),
    was_first: wasFirstTakeover,
  });

  void emitSystemEvent(
    b4TakeoverFired(event.session_id, event.user_id, {
      claim_type: claim.type,
      finding_id,
    }),
  );

  // Phase 5 — enqueue the actual APNs critical-priority push, gated
  // on wasFirstTakeover. The iOS CriticalInterruptView renders the
  // verbatim-quote + tap-to-source UX from the payload context.
  // When wasFirstTakeover is false a B3-side takeover already won the
  // race; the user is already looking at the takeover and a second
  // critical push would just churn the UI. We still record the
  // findings audit-trail (via claimTakeoverDispatch above) and emit
  // the transcript event.
  if (wasFirstTakeover) {
    void enqueueCriticalTakeoverPush({
      session_id: event.session_id,
      user_id: event.user_id,
      trigger_path: 'b4_finding',
      risk_score: Math.round(finding.confidence * 100),
      context: {
        claim_type: claim.type,
        raw_quote: claim.raw_quote,
        reasoning: finding.reasoning,
        finding_id,
        source_url: finding.source_url,
        source_snippet: finding.source_snippet,
        source_layer: finding.source_layer,
      },
    });
  }
}

async function claimTakeoverDispatch(
  session_id: string,
  claim_type: string,
  finding_id: string,
): Promise<boolean> {
  try {
    const res = await query(
      `INSERT INTO b4_takeover_dispatched (session_id, claim_type, finding_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id, claim_type) DO NOTHING`,
      [session_id, claim_type, finding_id],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    emitMetric('v3.b4.takeover_dispatch_claim_failed', {});
    // eslint-disable-next-line no-console
    console.warn('[b4Orchestrator] takeover-dispatch claim threw', {
      session_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function getUserAccountLast4(user_id: string): Promise<string | null> {
  if (userAccountLast4Cache.has(user_id)) {
    return userAccountLast4Cache.get(user_id) ?? null;
  }
  // For v3 we do NOT yet collect account-tail at onboarding (R5 in
  // risk register documents this gap). Users who haven't supplied
  // last-4 → cannot_verify on account_tail claims. Return null.
  // When the onboarding-redesign ships in v3.5, query users.account_last_4
  // (or wherever it lands) here.
  userAccountLast4Cache.set(user_id, null);
  return null;
}

/**
 * Fetch the per-session context B4 needs in one round-trip:
 *   - peer_e164: used by Layer 1 affiliation verifiers
 *   - v4_playbook_id: used by claim extractor's playbook-grounding bias
 *     (Phase 5). NULL until v4 classifier locks on (or when v4 is off).
 *
 * Returns a clean shape on any error path — the caller treats both
 * fields as best-effort. A missing playbook just means no extra bias
 * in the extractor prompt.
 */
async function getSessionContext(
  session_id: string,
): Promise<{ peer_e164: string | null; v4_playbook_id: PlaybookId | null }> {
  try {
    const res = await query<{ peer_e164: string | null; v4_playbook_id: string | null }>(
      `SELECT peer_e164, v4_playbook_id FROM call_sessions WHERE id = $1`,
      [session_id],
    );
    const row = res.rows[0];
    if (!row) return { peer_e164: null, v4_playbook_id: null };
    // Defense-in-depth: if a column ever holds an off-taxonomy
    // playbook_id (manual ops UPDATE, code rollback with stale rows),
    // treat as null rather than passing junk into the extractor prompt.
    const pbId = row.v4_playbook_id;
    const valid = pbId && PLAYBOOKS_BY_ID.has(pbId as PlaybookId) ? (pbId as PlaybookId) : null;
    return { peer_e164: row.peer_e164 ?? null, v4_playbook_id: valid };
  } catch {
    return { peer_e164: null, v4_playbook_id: null };
  }
}

// B4-specific bucketing — DELIBERATELY different from
// src/lib/confidenceBuckets.ts (which the v4 stage classifier and
// Phase 13 dashboard share). B4 findings use 'very_high' through
// 'very_low' with different boundaries because takeover-gate
// dashboards historically used these labels. Renamed from
// `bucketConfidence` (Phase 13 H1 adversarial fix) to make the
// collision impossible to hit by copy-paste.
function bucketB4Confidence(c: number): string {
  if (c >= 0.95) return 'very_high';
  if (c >= 0.85) return 'high';
  if (c >= 0.7) return 'medium';
  if (c >= 0.5) return 'low';
  return 'very_low';
}

// ---------------------------------------------------------------------------
/**
 * Apply an additive integer boost to the session's b4_score_boost
 * accumulator. The transcript route reads this column in its
 * score-merge pipeline. Capped at 100 (the column's CHECK
 * constraint) via LEAST() — defense-in-depth in case a runaway
 * confidence value tries to push the column out of range.
 *
 * Idempotency: torn write only undercounts by `boost`, same loss
 * tolerance as the existing b4_findings_count UPDATE. We don't
 * wrap in withTx because the orchestrator's caller doesn't open
 * a transaction either.
 */
async function applyB4ScoreBoost(session_id: string, boost: number): Promise<void> {
  try {
    await query(
      `UPDATE call_sessions
          SET b4_score_boost = LEAST(100, b4_score_boost + $2),
              updated_at = NOW()
        WHERE id = $1`,
      [session_id, boost],
    );
  } catch (err) {
    emitMetric('v3.b4.score_boost_update_failed', {});
    // eslint-disable-next-line no-console
    console.error('[b4Orchestrator] applyB4ScoreBoost failed', {
      session_id,
      boost,
      err: err instanceof Error ? err.message : String(err),
    });
    // Swallow — boost is best-effort. A failure here means the next
    // chunk's risk merge sees an undercounted boost; not catastrophic.
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function _resetForTests(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  sessionContexts.clear();
  userAccountLast4Cache.clear();
}

/** Test-only — exercise the score-boost UPDATE in isolation. */
export async function _applyB4ScoreBoostForTests(session_id: string, boost: number): Promise<void> {
  await applyB4ScoreBoost(session_id, boost);
}

/** Test-only — exercise dispatchFinding's branching directly. Lets
 * unit tests pin which branch (takeover / cannot_verify boost /
 * sub-threshold boost / consistent no-op) fires for a given
 * (claim, finding) pair without needing Anthropic/Serper mocks.
 */
export async function _dispatchFindingForTests(
  event: TranscriptChunkEvent,
  claim: ExtractedClaim,
  finding: Finding,
  finding_id: string | null,
): Promise<void> {
  await dispatchFinding(event, claim, finding, finding_id);
}

/** Test-only — drive the pipeline directly without going through the subscriber. */
export async function _handleScammerChunkForTests(event: TranscriptChunkEvent): Promise<void> {
  await handleScammerChunk(event);
}

/**
 * Test-only — exercise the Phase 12 claim-coverage emit-gate
 * directly. Without this, the gate logic was only reachable through
 * a successful extract() — which is gated on ANTHROPIC_API_KEY being
 * set, so tests would have to mock the API to drive even one branch.
 */
export function _emitClaimCoverageMetricsForChunkForTests(
  playbook_id: PlaybookId | null,
  claims: readonly ExtractedClaim[],
): void {
  emitClaimCoverageMetricsForChunk(playbook_id, claims);
}
