import { query } from '../../lib/db.js';
import { encryptString } from '../../lib/crypto.js';
import { emitMetric, captureError } from '../../lib/observability.js';
import { callLLM } from '../../lib/llm.js';
import { hasRecoveryPlus } from './recoveryPlusEntitlement.js';
import {
  defaultChainFetch,
  type ChainFetchFn,
  type ChainTx,
} from '../../lib/chainFetch.js';
import {
  defaultExchangeTagger,
  type ExchangeTaggerFn,
} from '../../lib/exchangeTagger.js';
import type { CryptoTraceCaseRow } from './types.js';

// Recovery Shield — R-P3b: crypto-trace agent.
//
// Walks forward N hops from the scammer's destination_wallet via the
// chain-explorer API, looking for a transfer that lands at a known
// exchange hot wallet. When the trace hits an exchange we halt and
// generate a freeze-of-funds petition addressed to that exchange's
// legal team. The petition is a starting template — most exchanges
// require these filed through licensed counsel, which Recovery Shield
// surfaces via the specialist marketplace (R-P4).
//
// FLOW:
//
//   1. startCryptoTraceCase — INSERTs the case row in state='intake'.
//      Recovery Plus gate runs FIRST; non-Plus users get 402'd before
//      any state lands in the DB.
//
//   2. runTraceHops — walks the chain forward up to max_hops=5 from
//      destination_wallet. At each hop we (a) pull outbound txs via
//      chainFetchFn, (b) check each outbound counterparty via
//      exchangeTaggerFn, (c) if a tag hits, halt and persist the
//      trace report + state='exchange_identified'. If we exhaust
//      max_hops without a tag, persist the partial graph with
//      state='tracing' and exchange_tagged=null. Operator UI can
//      then route the case to a specialist for off-chain pursuit.
//
//   3. generateExchangePetition — only valid in state='exchange_
//      identified'. Composes a Bank-style + crypto-exchange-style
//      freeze-petition via callLLM, envelope-encrypts the result,
//      stores it on petition_text, and transitions to state='petition_
//      drafted'.
//
//   4. advanceCryptoTraceCase — operator-side state transitions
//      (user_sent, exchange_acked, frozen, denied, closed). Illegal
//      transitions throw InvalidStateError.
//
//   5. getCryptoTraceCase — read-only access for the iOS dashboard,
//      always filters by (id, user_id) so cross-user reads return null.
//
// STATE MACHINE:
//   intake → tracing → exchange_identified → petition_drafted →
//   user_sent → exchange_acked → (frozen | denied) → closed
//
//   `closed` is also reachable from any non-terminal state (operator
//   close on a stalled case). `denied` and `frozen` are terminal-
//   except-`closed`. The validated transitions are pinned in
//   STATE_TRANSITIONS below; the DB CHECK only pins the vocabulary.
//
// CROSS-USER SAFETY:
//
//   Every read / write filters by (id, user_id). The Recovery Plus
//   gate also runs first on every mutating call, so a user without
//   the entitlement can't even reach a state where cross-user data
//   would be relevant. Tests cover the cross-user-access-returns-
//   null contract explicitly.
//
// FLOAT-PRECISION INVARIANT:
//
//   amount_native is a STRING throughout. Chain RPCs return decimal
//   strings (wei, satoshi, lamports); we never parse those as Number.
//   amount_usd_cents_at_send is BIGINT cents on the wire; we accept
//   bigint at the type level and cast to .toString() for the SQL
//   parameter so pg's bigint serialization stays exact.

/** Supported chain vocabulary. Pinned to CHECK on migration 064. */
export type ChainName =
  | 'ethereum'
  | 'bitcoin'
  | 'tron'
  | 'polygon'
  | 'bsc'
  | 'solana'
  | 'arbitrum'
  | 'optimism'
  | 'base';

export type CryptoTraceState = CryptoTraceCaseRow['state'];

/** Valid forward transitions. Anything outside this map throws. */
const STATE_TRANSITIONS: Record<CryptoTraceState, CryptoTraceState[]> = {
  intake: ['tracing', 'closed'],
  tracing: ['exchange_identified', 'closed'],
  exchange_identified: ['petition_drafted', 'closed'],
  petition_drafted: ['user_sent', 'closed'],
  user_sent: ['exchange_acked', 'denied', 'closed'],
  exchange_acked: ['frozen', 'denied', 'closed'],
  frozen: ['closed'],
  denied: ['closed'],
  closed: [],
};

export class RecoveryPlusRequiredError extends Error {
  constructor(user_id: string, recovery_session_id: string) {
    super(
      `Recovery Plus entitlement required (user_id=${user_id} recovery_session_id=${recovery_session_id})`,
    );
    this.name = 'RecoveryPlusRequiredError';
  }
}

export class CryptoTraceCaseNotFoundError extends Error {
  constructor(case_id: string) {
    super(`crypto-trace case ${case_id} not found`);
    this.name = 'CryptoTraceCaseNotFoundError';
  }
}

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateError';
  }
}

// --------------------------------------------------------------------
// Intake
// --------------------------------------------------------------------

export interface CryptoTraceIntake {
  user_id: string;
  recovery_session_id: string;
  /** Victim's wallet (they supplied — on-chain public). */
  source_wallet: string;
  /** Scammer's wallet — on-chain public. */
  destination_wallet: string;
  chain: ChainName;
  /** String-encoded decimal in the chain's base unit (wei / satoshi / lamports). */
  amount_native: string;
  /** Pricing snapshot. bigint here keeps the wire shape exact. */
  amount_usd_cents_at_send: bigint;
}

/**
 * INSERT a new crypto-trace case in state='intake'. Gates on
 * Recovery Plus entitlement BEFORE any DB writes.
 */
export async function startCryptoTraceCase(
  intake: CryptoTraceIntake,
): Promise<{ case_id: string; state: 'intake' }> {
  const ok = await hasRecoveryPlus(intake.user_id, intake.recovery_session_id);
  if (!ok) {
    throw new RecoveryPlusRequiredError(intake.user_id, intake.recovery_session_id);
  }

  const ins = await query<{ id: string }>(
    `INSERT INTO crypto_trace_cases (
       user_id, recovery_session_id, source_wallet, destination_wallet,
       chain, amount_native, amount_usd_cents_at_send, hops_analyzed,
       exchange_tagged, trace_report_jsonb, state, petition_text
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL, NULL, 'intake', NULL)
     RETURNING id`,
    [
      intake.user_id,
      intake.recovery_session_id,
      intake.source_wallet,
      intake.destination_wallet,
      intake.chain,
      intake.amount_native,
      // pg bigint param-binding: send as string. The BIGINT column
      // parses it back without float loss.
      intake.amount_usd_cents_at_send.toString(),
    ],
  );
  const case_id = ins.rows[0]!.id;
  void emitMetric('recovery_shield.crypto_trace_started', { chain: intake.chain });
  return { case_id, state: 'intake' };
}

// --------------------------------------------------------------------
// Hop walking
// --------------------------------------------------------------------

/**
 * Shape persisted to trace_report_jsonb. Versioned via the
 * `schema_version` field so future changes can be inspected by an
 * admin without breaking older rows.
 */
export interface TraceReportV1 {
  schema_version: 1;
  hops: Array<{
    level: number;
    address: string;
    outbound_count: number;
    txs_sampled: Array<{
      tx_hash: string;
      to: string;
      value_native: string;
      timestamp: string;
    }>;
    exchange_tagged?: string;
  }>;
  exchange_path: string[];
  halt_reason: 'exchange_identified' | 'max_hops_reached' | 'no_outbound_txs';
  analyzed_at: string;
}

const DEFAULT_MAX_HOPS = 5;
const TXS_PER_HOP_SAMPLE = 5;

/**
 * Walk forward from destination_wallet up to max_hops, halting when
 * a hop's counterparty is a tagged exchange.
 *
 * Strategy at each hop:
 *   - fetch outbound txs via chainFetchFn
 *   - for each unique counterparty `to`, check exchangeTaggerFn
 *   - if any counterparty is tagged → halt, persist
 *     state='exchange_identified', exchange_tagged=<name>
 *   - otherwise pick the highest-value outbound counterparty as the
 *     next hop (heuristic: scammers typically forward the bulk;
 *     change/dust returns to mixer-style addresses don't move us
 *     toward an exchange)
 *
 * If max_hops is exhausted: state stays 'tracing', exchange_tagged
 * stays NULL, partial graph persists to trace_report_jsonb.
 */
export async function runTraceHops(input: {
  case_id: string;
  user_id: string;
  max_hops?: number;
  opts?: {
    chainFetchFn?: ChainFetchFn;
    exchangeTaggerFn?: ExchangeTaggerFn;
  };
}): Promise<{ hops_analyzed: number; exchange_tagged: string | null }> {
  // Load the case row, scoped by user. Cross-user calls return null
  // → throw not-found so a malicious user can't even probe for
  // existence of a peer's case.
  const row = await loadCase(input.case_id, input.user_id);
  if (!row) throw new CryptoTraceCaseNotFoundError(input.case_id);
  const ok = await hasRecoveryPlus(row.user_id, row.recovery_session_id);
  if (!ok) {
    throw new RecoveryPlusRequiredError(row.user_id, row.recovery_session_id);
  }

  // R-M2 (adversarial-review): state-machine guard. Without this check
  // a user could POST /trace/crypto/:case_id/hops on a case that has
  // already advanced past 'tracing' (petition_drafted / user_sent /
  // exchange_acked / frozen / denied / closed) and the UPDATE below
  // would silently regress state + clobber petition_text workflow
  // progress. Hops are only meaningful in {intake, tracing}; anything
  // beyond that has already consumed the trace report. We choose the
  // hard-throw path over silent idempotent return because the operator
  // should never be re-running hops on a post-trace case — the right
  // recovery is start a fresh case, not mutate the in-flight one.
  if (row.state !== 'intake' && row.state !== 'tracing') {
    throw new InvalidStateError(
      `Cannot re-run hops; case ${input.case_id} has already advanced past trace phase (state=${row.state}).`,
    );
  }

  const maxHops = input.max_hops ?? DEFAULT_MAX_HOPS;
  const chainFetch = input.opts?.chainFetchFn ?? defaultChainFetch;
  const tagger = input.opts?.exchangeTaggerFn ?? defaultExchangeTagger;

  const hops: TraceReportV1['hops'] = [];
  const exchangePath: string[] = [];
  let currentAddress = row.destination_wallet;
  let exchangeTagged: string | null = null;
  let haltReason: TraceReportV1['halt_reason'] = 'max_hops_reached';

  for (let level = 0; level < maxHops; level++) {
    const txs = await safeChainFetch(chainFetch, row.chain, currentAddress);
    const outbound = txs.filter(
      (t) => t.from.toLowerCase() === currentAddress.toLowerCase(),
    );
    const sample = outbound
      .slice(0, TXS_PER_HOP_SAMPLE)
      .map((t) => ({
        tx_hash: t.tx_hash,
        to: t.to,
        value_native: t.value_native,
        timestamp: t.timestamp.toISOString(),
      }));

    if (outbound.length === 0) {
      // Dead end — no outbound txs. Persist the graph with this hop
      // recorded for diagnostic value, but ONLY when we already walked
      // at least one prior hop. The level=0 dead end (typically the
      // no-API-key degraded path) records hops_analyzed=0 per the
      // R-P3b contract — caller sees "no progress" and the trace_report
      // halt_reason='no_outbound_txs' distinguishes it from "exhausted
      // max_hops".
      if (level > 0) {
        hops.push({
          level,
          address: currentAddress,
          outbound_count: 0,
          txs_sampled: [],
        });
      }
      haltReason = 'no_outbound_txs';
      break;
    }

    // Check counterparties for exchange tags before picking the
    // next-hop address. Order matters: a tagged hit halts the trace
    // even if it's not the highest-value counterparty.
    let taggedHit: { exchange: string; to: string } | null = null;
    const uniqueTos = Array.from(new Set(outbound.map((t) => t.to)));
    for (const to of uniqueTos) {
      const t = await tagger(row.chain, to);
      if (t.exchange) {
        taggedHit = { exchange: t.exchange, to };
        break;
      }
    }

    if (taggedHit) {
      hops.push({
        level,
        address: currentAddress,
        outbound_count: outbound.length,
        txs_sampled: sample,
        exchange_tagged: taggedHit.exchange,
      });
      exchangePath.push(currentAddress, taggedHit.to);
      exchangeTagged = taggedHit.exchange;
      haltReason = 'exchange_identified';
      break;
    }

    hops.push({
      level,
      address: currentAddress,
      outbound_count: outbound.length,
      txs_sampled: sample,
    });

    // Pick the highest-value counterparty as the next hop. Tie-break
    // on first-seen (provider order is recent-first; tied values get
    // the more-recent address, which is closer to a still-active
    // forwarder).
    const nextHop = outbound.reduce<ChainTx | null>((best, cur) => {
      if (!best) return cur;
      // Compare as BigInt to dodge float precision. value_native is
      // a decimal string in the chain's base unit; BigInt parses
      // that exactly.
      try {
        return BigInt(cur.value_native) > BigInt(best.value_native) ? cur : best;
      } catch {
        return best;
      }
    }, null);
    if (!nextHop) {
      haltReason = 'no_outbound_txs';
      break;
    }
    currentAddress = nextHop.to;
  }

  const nextState: CryptoTraceState =
    exchangeTagged !== null ? 'exchange_identified' : 'tracing';

  const traceReport: TraceReportV1 = {
    schema_version: 1,
    hops,
    exchange_path: exchangePath,
    halt_reason: haltReason,
    analyzed_at: new Date().toISOString(),
  };

  // R-M2: belt-and-suspenders state guard at the SQL layer. The
  // in-memory check above already throws if state has advanced past
  // 'tracing'; this WHERE clause defends against a concurrent advance
  // (operator close, denied, etc.) that lands between the load and the
  // UPDATE. If the row's state changed under us we silently no-op
  // the write — the in-flight hop graph computed above is discarded.
  await query(
    `UPDATE crypto_trace_cases
        SET hops_analyzed = $1,
            exchange_tagged = $2,
            trace_report_jsonb = $3::jsonb,
            state = $4,
            state_changed_at = NOW()
      WHERE id = $5
        AND user_id = $6
        AND state IN ('intake', 'tracing')`,
    [
      hops.length,
      exchangeTagged,
      JSON.stringify(traceReport),
      nextState,
      input.case_id,
      input.user_id,
    ],
  );

  void emitMetric('recovery_shield.crypto_trace_hops', {
    final_hops_count: String(hops.length),
  });
  if (exchangeTagged) {
    void emitMetric('recovery_shield.crypto_trace_exchange_tagged', {
      exchange: exchangeTagged,
    });
  }

  return { hops_analyzed: hops.length, exchange_tagged: exchangeTagged };
}

/**
 * Wrap chainFetchFn so a thrown error doesn't kill the entire trace.
 * Hop walking is best-effort — if one provider 503s mid-walk we
 * persist what we have and let the operator retry.
 */
async function safeChainFetch(
  fn: ChainFetchFn,
  chain: ChainName,
  address: string,
): Promise<ChainTx[]> {
  try {
    return await fn(chain, address);
  } catch (err) {
    captureError(err, {
      component: 'cryptoTraceAgent.safeChainFetch',
      chain,
      address_prefix: address.slice(0, 8),
    });
    return [];
  }
}

// --------------------------------------------------------------------
// Petition generation
// --------------------------------------------------------------------

/**
 * Disclaimer prepended to every petition. Locked copy — adversarial
 * review requires this exact wording so the iOS surface can rely on
 * substring detection if needed.
 */
export const PETITION_DISCLAIMER =
  'NOTE: This is a draft starting template. Most exchanges require this to be filed through licensed counsel — see Recovery Shield specialist marketplace for vetted partners.';

const PETITION_SYSTEM_PROMPT = `You are AegisDial's Recovery Shield crypto-petition drafter. You compose freeze-of-funds petition letters addressed to a centralized cryptocurrency exchange's legal department.

OUTPUT RULES:
1. Begin the letter with the supplied DISCLAIMER verbatim, on its own line.
2. Format as a formal legal letter — RE: line, salutation, body paragraphs, closing.
3. Include the trace summary (hop graph), the dollar amount lost at the time of the transfer, the AegisDial case ID, the specific on-chain tx hashes, and a clear ask: freeze deposits to the tagged address pending investigation.
4. Cite the exchange's typical legal-process procedure (subpoena / court order via the exchange's legal-process portal) — language is bank-style + crypto-exchange-style.
5. End with placeholders for: victim signature, victim contact, attorney signature/contact, date.
6. NEVER invent law-enforcement case numbers, judicial subpoenas, or attorney bar numbers. Use [BRACKETED PLACEHOLDERS].
7. Keep the letter under 600 words.

Output the letter body only — no explanation, no preamble, no markdown headers beyond the RE: line.`;

/**
 * Compose and persist the freeze-of-funds petition. Only valid in
 * state='exchange_identified'.
 *
 * Throws:
 *  - CryptoTraceCaseNotFoundError if the case doesn't exist or
 *    belongs to a different user.
 *  - InvalidStateError if state isn't 'exchange_identified'.
 *  - RecoveryPlusRequiredError if entitlement was revoked between
 *    runTraceHops and now (refund webhook fired mid-flow).
 *  - LLMUnavailableError from callLLM bubbling up.
 */
export async function generateExchangePetition(input: {
  case_id: string;
  user_id: string;
  opts?: { llmFn?: typeof callLLM };
}): Promise<{ petition_text: string }> {
  const row = await loadCase(input.case_id, input.user_id);
  if (!row) throw new CryptoTraceCaseNotFoundError(input.case_id);
  const ok = await hasRecoveryPlus(row.user_id, row.recovery_session_id);
  if (!ok) {
    throw new RecoveryPlusRequiredError(row.user_id, row.recovery_session_id);
  }
  if (row.state !== 'exchange_identified') {
    throw new InvalidStateError(
      `Cannot generate petition before exchange is identified (state=${row.state})`,
    );
  }
  if (!row.exchange_tagged) {
    // Defensive — state=exchange_identified implies exchange_tagged
    // is set, but the migration's CHECK doesn't enforce that, so we
    // belt-and-suspenders the read.
    throw new InvalidStateError(
      'state=exchange_identified but exchange_tagged is null — refuse to generate petition',
    );
  }

  const userPrompt = buildPetitionUserPrompt(row);
  const llm = input.opts?.llmFn ?? callLLM;
  const llmRaw = await llm({
    system: PETITION_SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 1500,
  });

  // Belt-and-suspenders: ensure the disclaimer is prefixed exactly
  // once. If the model included it, leave it alone; if not, prepend.
  const petitionText = llmRaw.includes(PETITION_DISCLAIMER)
    ? llmRaw.trim()
    : `${PETITION_DISCLAIMER}\n\n${llmRaw.trim()}`;

  const ciphertext = encryptString(petitionText);

  await query(
    `UPDATE crypto_trace_cases
        SET petition_text = $1,
            state = 'petition_drafted',
            state_changed_at = NOW()
      WHERE id = $2 AND user_id = $3`,
    [ciphertext, input.case_id, input.user_id],
  );

  void emitMetric('recovery_shield.crypto_trace_petition_generated', {
    exchange: row.exchange_tagged,
  });

  return { petition_text: petitionText };
}

function buildPetitionUserPrompt(row: CryptoTraceCaseRow): string {
  // Surface only on-chain public data to the LLM. Plaintext is fine
  // here — the response is encrypted before persistence. We pass the
  // trace report as JSON so the model can reason over the hop graph.
  return [
    `DISCLAIMER (must appear verbatim at top of letter):`,
    PETITION_DISCLAIMER,
    ``,
    `CASE FACTS:`,
    `- AegisDial case ID: ${row.id}`,
    `- Chain: ${row.chain}`,
    `- Victim wallet (source): ${row.source_wallet}`,
    `- Scammer wallet (initial destination): ${row.destination_wallet}`,
    `- Native amount sent: ${row.amount_native} (base units)`,
    `- USD value at time of send: $${(Number(row.amount_usd_cents_at_send) / 100).toFixed(2)}`,
    `- Identified exchange (final hop): ${row.exchange_tagged ?? 'unknown'}`,
    `- Hops analyzed: ${row.hops_analyzed}`,
    ``,
    `ON-CHAIN TRACE GRAPH (versioned JSONB):`,
    JSON.stringify(row.trace_report_jsonb, null, 2),
    ``,
    `Draft the petition now per the system rules.`,
  ].join('\n');
}

// --------------------------------------------------------------------
// State transitions + read
// --------------------------------------------------------------------

export async function advanceCryptoTraceCase(input: {
  case_id: string;
  user_id: string;
  next_state:
    | 'tracing'
    | 'exchange_identified'
    | 'petition_drafted'
    | 'user_sent'
    | 'exchange_acked'
    | 'frozen'
    | 'denied'
    | 'closed';
}): Promise<{ case_id: string; state: string }> {
  const row = await loadCase(input.case_id, input.user_id);
  if (!row) throw new CryptoTraceCaseNotFoundError(input.case_id);
  const ok = await hasRecoveryPlus(row.user_id, row.recovery_session_id);
  if (!ok) {
    throw new RecoveryPlusRequiredError(row.user_id, row.recovery_session_id);
  }

  const allowed = STATE_TRANSITIONS[row.state] ?? [];
  if (!allowed.includes(input.next_state)) {
    throw new InvalidStateError(
      `Illegal transition ${row.state} → ${input.next_state} (allowed: ${allowed.join(', ') || 'none — terminal'})`,
    );
  }

  await query(
    `UPDATE crypto_trace_cases
        SET state = $1, state_changed_at = NOW()
      WHERE id = $2 AND user_id = $3`,
    [input.next_state, input.case_id, input.user_id],
  );
  return { case_id: input.case_id, state: input.next_state };
}

export async function getCryptoTraceCase(input: {
  case_id: string;
  user_id: string;
}): Promise<CryptoTraceCaseRow | null> {
  return loadCase(input.case_id, input.user_id);
}

/**
 * Internal — load by (id, user_id). Used by every public function so
 * the cross-user filter lives in exactly one place.
 */
async function loadCase(
  case_id: string,
  user_id: string,
): Promise<CryptoTraceCaseRow | null> {
  const res = await query<CryptoTraceCaseRow>(
    `SELECT id, user_id, recovery_session_id, source_wallet, destination_wallet,
            chain, amount_native, amount_usd_cents_at_send::TEXT AS amount_usd_cents_at_send,
            hops_analyzed, exchange_tagged, trace_report_jsonb, state,
            petition_text, state_changed_at, created_at
       FROM crypto_trace_cases
      WHERE id = $1 AND user_id = $2
      LIMIT 1`,
    [case_id, user_id],
  );
  return res.rowCount === 1 ? res.rows[0]! : null;
}
