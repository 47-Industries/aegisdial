import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Recovery Shield — R-P3b crypto-trace agent tests.
//
// Stubs:
//   - db.pool.query — minimal in-memory recovery_plus_purchases +
//     crypto_trace_cases store with the same INSERT / SELECT / UPDATE
//     shapes as the live migration.
//   - chainFetchFn — synthetic outbound tx graphs (so we don't hit
//     Etherscan / Blockchair).
//   - exchangeTaggerFn — synthetic tag map (so we don't depend on
//     the hardcoded corpus drifting).
//   - llmFn — deterministic petition output (no Anthropic round-trip).
//
// Coverage (matches the R-P3b prompt deliverables):
//   1. startCryptoTraceCase happy path
//   2. startCryptoTraceCase without Recovery Plus → throws
//   3. runTraceHops on a 2-hop path that ends at Binance → state='exchange_identified'
//   4. runTraceHops 5 hops, no tag → state='tracing', exchange_tagged=null
//   5. runTraceHops respects max_hops (max_hops=2, exchange at hop 3 → no match)
//   6. generateExchangePetition success — LLM called, ciphertext stored, disclaimer present
//   7. generateExchangePetition before exchange identified → InvalidStateError
//   8. advanceCryptoTraceCase rejects illegal transitions
//   9. Cross-user access → null / throws
//  10. petition_text in DB is ciphertext (v1: prefix)
//  11. trace_report_jsonb stores the hop graph correctly
//  12. Chain-API-missing-key path: chainFetchFn returns [] → hops_analyzed=0
//  13. amount_native (string) preserved verbatim (no float loss)
//  14. amount_usd_cents_at_send bigint handled correctly

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-crypto-trace';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://crypto-trace';
process.env.APPLE_BUNDLE_ID ||= 'com.aegisdial.app';

const db = await import('../src/lib/db.ts');
const agent = await import('../src/services/recovery/cryptoTraceAgent.ts');
import type { ChainFetchFn, ChainTx } from '../src/lib/chainFetch.ts';
import type { ExchangeTaggerFn } from '../src/lib/exchangeTagger.ts';
import type { CryptoTraceCaseRow } from '../src/services/recovery/types.ts';

// ----------------------------------------------------------------
// In-memory stub DB
// ----------------------------------------------------------------

interface FakePurchase {
  id: string;
  user_id: string;
  recovery_session_id: string | null;
  apple_transaction_id: string;
  purchase_amount_cents: number;
  refunded_at: Date | null;
  purchased_at: Date;
}

interface FakeCase {
  id: string;
  user_id: string;
  recovery_session_id: string;
  source_wallet: string;
  destination_wallet: string;
  chain: string;
  amount_native: string;
  amount_usd_cents_at_send: string;
  hops_analyzed: number;
  exchange_tagged: string | null;
  trace_report_jsonb: unknown;
  state: string;
  petition_text: string | null;
  state_changed_at: Date;
  created_at: Date;
}

let fakePurchases: FakePurchase[] = [];
let fakeCases: FakeCase[] = [];
let caseSeq = 1;

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const trimmed = text.trim().replace(/\s+/g, ' ');

  // ---- recovery_plus_purchases (for hasRecoveryPlus gate) ----
  if (
    /^UPDATE recovery_plus_purchases SET recovery_session_id = \$2 WHERE id = \( SELECT id FROM recovery_plus_purchases WHERE user_id = \$1 AND recovery_session_id IS NULL/i.test(
      trimmed,
    )
  ) {
    const [user_id, session_id] = params as [string, string];
    const candidate = fakePurchases.find(
      (p) => p.user_id === user_id && p.recovery_session_id === null && p.refunded_at === null,
    );
    if (!candidate) return { rows: [], rowCount: 0 };
    candidate.recovery_session_id = session_id;
    return { rows: [{ id: candidate.id }], rowCount: 1 };
  }
  if (
    /^SELECT id FROM recovery_plus_purchases WHERE user_id = \$1 AND recovery_session_id = \$2 AND refunded_at IS NULL/i.test(
      trimmed,
    )
  ) {
    const [user_id, session_id] = params as [string, string];
    const row = fakePurchases.find(
      (p) =>
        p.user_id === user_id &&
        p.recovery_session_id === session_id &&
        p.refunded_at === null,
    );
    return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // ---- crypto_trace_cases INSERT ----
  if (/^INSERT INTO crypto_trace_cases/i.test(trimmed)) {
    const [
      user_id,
      recovery_session_id,
      source_wallet,
      destination_wallet,
      chain,
      amount_native,
      amount_usd_cents_at_send,
    ] = params as [string, string, string, string, string, string, string];
    const row: FakeCase = {
      id: `case-${caseSeq++}`,
      user_id,
      recovery_session_id,
      source_wallet,
      destination_wallet,
      chain,
      amount_native,
      amount_usd_cents_at_send,
      hops_analyzed: 0,
      exchange_tagged: null,
      trace_report_jsonb: null,
      state: 'intake',
      petition_text: null,
      state_changed_at: new Date(),
      created_at: new Date(),
    };
    fakeCases.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // ---- crypto_trace_cases SELECT (by id + user_id) ----
  if (/^SELECT id, user_id, recovery_session_id, source_wallet/i.test(trimmed)) {
    const [case_id, user_id] = params as [string, string];
    const row = fakeCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [
        {
          id: row.id,
          user_id: row.user_id,
          recovery_session_id: row.recovery_session_id,
          source_wallet: row.source_wallet,
          destination_wallet: row.destination_wallet,
          chain: row.chain,
          amount_native: row.amount_native,
          amount_usd_cents_at_send: row.amount_usd_cents_at_send,
          hops_analyzed: row.hops_analyzed,
          exchange_tagged: row.exchange_tagged,
          trace_report_jsonb: row.trace_report_jsonb,
          state: row.state,
          petition_text: row.petition_text,
          state_changed_at: row.state_changed_at,
          created_at: row.created_at,
        },
      ],
      rowCount: 1,
    };
  }

  // ---- crypto_trace_cases UPDATE (post-hops) ----
  if (
    /^UPDATE crypto_trace_cases SET hops_analyzed = \$1, exchange_tagged = \$2, trace_report_jsonb = \$3::jsonb/i.test(
      trimmed,
    )
  ) {
    const [hops_analyzed, exchange_tagged, trace_report_jsonb, state, case_id, user_id] =
      params as [number, string | null, string, string, string, string];
    const row = fakeCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    // R-M2: SQL-layer state guard mirrors the live UPDATE's
    // `AND state IN ('intake', 'tracing')` clause. If the row already
    // advanced past trace phase, the UPDATE no-ops (rowCount=0).
    if (row.state !== 'intake' && row.state !== 'tracing') {
      return { rows: [], rowCount: 0 };
    }
    row.hops_analyzed = hops_analyzed;
    row.exchange_tagged = exchange_tagged;
    row.trace_report_jsonb = JSON.parse(trace_report_jsonb);
    row.state = state;
    row.state_changed_at = new Date();
    return { rows: [], rowCount: 1 };
  }

  // ---- crypto_trace_cases UPDATE (petition) ----
  if (
    /^UPDATE crypto_trace_cases SET petition_text = \$1, state = 'petition_drafted'/i.test(
      trimmed,
    )
  ) {
    const [petition_text, case_id, user_id] = params as [string, string, string];
    const row = fakeCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    row.petition_text = petition_text;
    row.state = 'petition_drafted';
    row.state_changed_at = new Date();
    return { rows: [], rowCount: 1 };
  }

  // ---- crypto_trace_cases UPDATE (advance state) ----
  if (/^UPDATE crypto_trace_cases SET state = \$1, state_changed_at = NOW\(\)/i.test(trimmed)) {
    const [state, case_id, user_id] = params as [string, string, string];
    const row = fakeCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    row.state = state;
    row.state_changed_at = new Date();
    return { rows: [], rowCount: 1 };
  }

  // ---- metric_counters UPSERT (swallow) ----
  if (/^INSERT INTO metric_counters/i.test(trimmed)) {
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`unstubbed SQL: ${trimmed.slice(0, 180)}`);
};

// ----------------------------------------------------------------
// Constants + helpers
// ----------------------------------------------------------------

const USER_A = '00000000-0000-0000-0000-00000000000a';
const USER_B = '00000000-0000-0000-0000-00000000000b';
const SESSION_A = '11111111-1111-1111-1111-11111111111a';

const SCAMMER_WALLET = '0xSCAMMER_AAAA0000000000000000000000000001';
const HOP1_WALLET    = '0xH1_BBBB000000000000000000000000000000002';
const HOP2_WALLET    = '0xH2_CCCC000000000000000000000000000000003';
const HOP3_WALLET    = '0xH3_DDDD000000000000000000000000000000004';
const BINANCE_HOT    = '0xBINANCE_HOTWALLET000000000000000000000000';

function grantPlus(userId: string, sessionId: string): void {
  fakePurchases.push({
    id: `purchase-${userId}-${sessionId}`,
    user_id: userId,
    recovery_session_id: sessionId,
    apple_transaction_id: `tx-${userId}-${sessionId}`,
    purchase_amount_cents: 24900,
    refunded_at: null,
    purchased_at: new Date(),
  });
}

function tx(from: string, to: string, value: string, hash: string): ChainTx {
  return {
    tx_hash: hash,
    from,
    to,
    value_native: value,
    timestamp: new Date('2026-05-01T00:00:00Z'),
  };
}

beforeEach(() => {
  fakePurchases = [];
  fakeCases = [];
  caseSeq = 1;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

// ----------------------------------------------------------------
// 1. startCryptoTraceCase happy path
// ----------------------------------------------------------------

describe('startCryptoTraceCase', () => {
  it('happy path — Recovery Plus user → row inserted in intake state', async () => {
    grantPlus(USER_A, SESSION_A);
    const result = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '500000000000000000', // 0.5 ETH in wei
      amount_usd_cents_at_send: 150_000n, // $1500.00
    });
    assert.equal(result.state, 'intake');
    assert.ok(result.case_id);
    assert.equal(fakeCases.length, 1);
    assert.equal(fakeCases[0]!.state, 'intake');
    assert.equal(fakeCases[0]!.amount_native, '500000000000000000');
    assert.equal(fakeCases[0]!.amount_usd_cents_at_send, '150000');
    assert.equal(fakeCases[0]!.destination_wallet, SCAMMER_WALLET);
  });

  it('without Recovery Plus → throws RecoveryPlusRequiredError, no row written', async () => {
    await assert.rejects(
      agent.startCryptoTraceCase({
        user_id: USER_A,
        recovery_session_id: SESSION_A,
        source_wallet: '0xVICTIM',
        destination_wallet: SCAMMER_WALLET,
        chain: 'ethereum',
        amount_native: '500000000000000000',
        amount_usd_cents_at_send: 150_000n,
      }),
      (err: unknown) => err instanceof agent.RecoveryPlusRequiredError,
    );
    assert.equal(fakeCases.length, 0);
  });

  it('amount_native preserved verbatim (no float loss)', async () => {
    grantPlus(USER_A, SESSION_A);
    // 18 decimals of precision — would round on JS Number.
    const huge = '1234567890123456789';
    await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: huge,
      amount_usd_cents_at_send: 999_999_999n,
    });
    assert.equal(fakeCases[0]!.amount_native, huge);
  });

  it('amount_usd_cents_at_send bigint handled correctly (institutional case)', async () => {
    grantPlus(USER_A, SESSION_A);
    // > MAX_SAFE_INTEGER cents to stress the bigint path.
    const bigCents = 9_007_199_254_740_993n; // 2^53 + 1
    await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '1',
      amount_usd_cents_at_send: bigCents,
    });
    assert.equal(fakeCases[0]!.amount_usd_cents_at_send, bigCents.toString());
  });
});

// ----------------------------------------------------------------
// 3. runTraceHops on a 2-hop path ending at Binance
// ----------------------------------------------------------------

describe('runTraceHops', () => {
  it('walks 2 hops to a tagged Binance hot wallet → state=exchange_identified', async () => {
    grantPlus(USER_A, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '500000000000000000',
      amount_usd_cents_at_send: 150_000n,
    });

    const fetchFn: ChainFetchFn = async (_chain, address) => {
      if (address.toLowerCase() === SCAMMER_WALLET.toLowerCase()) {
        return [tx(address, HOP1_WALLET, '450000000000000000', 'h0')];
      }
      if (address.toLowerCase() === HOP1_WALLET.toLowerCase()) {
        // Hop 1's outbound: Binance + a small dust to elsewhere.
        return [
          tx(address, BINANCE_HOT, '400000000000000000', 'h1a'),
          tx(address, HOP2_WALLET, '10000000000000000', 'h1b'),
        ];
      }
      return [];
    };
    const taggerFn: ExchangeTaggerFn = async (_chain, address) => {
      if (address.toLowerCase() === BINANCE_HOT.toLowerCase()) {
        return { exchange: 'Binance Hot Wallet', tagged_address: address.toLowerCase() };
      }
      return { exchange: null, tagged_address: null };
    };

    const result = await agent.runTraceHops({
      case_id: start.case_id,
      user_id: USER_A,
      opts: { chainFetchFn: fetchFn, exchangeTaggerFn: taggerFn },
    });

    assert.equal(result.exchange_tagged, 'Binance Hot Wallet');
    assert.equal(result.hops_analyzed, 2);
    assert.equal(fakeCases[0]!.state, 'exchange_identified');
    assert.equal(fakeCases[0]!.exchange_tagged, 'Binance Hot Wallet');
  });

  it('5 hops without a tag → state stays tracing, exchange_tagged=null', async () => {
    grantPlus(USER_A, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '500000000000000000',
      amount_usd_cents_at_send: 150_000n,
    });

    let counter = 0;
    const fetchFn: ChainFetchFn = async (_chain, address) => {
      counter++;
      // Always forward to a brand-new wallet — never tagged.
      return [tx(address, `0xnewwallet${counter}`, '1000000000000000', `tx${counter}`)];
    };
    const taggerFn: ExchangeTaggerFn = async () => ({
      exchange: null,
      tagged_address: null,
    });

    const result = await agent.runTraceHops({
      case_id: start.case_id,
      user_id: USER_A,
      opts: { chainFetchFn: fetchFn, exchangeTaggerFn: taggerFn },
    });

    assert.equal(result.exchange_tagged, null);
    assert.equal(result.hops_analyzed, 5);
    assert.equal(fakeCases[0]!.state, 'tracing');
    assert.equal(fakeCases[0]!.exchange_tagged, null);
  });

  it('respects max_hops parameter — exchange at hop 3 with max_hops=2 → no match', async () => {
    grantPlus(USER_A, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '1',
      amount_usd_cents_at_send: 100n,
    });

    const fetchFn: ChainFetchFn = async (_chain, address) => {
      if (address.toLowerCase() === SCAMMER_WALLET.toLowerCase()) {
        return [tx(address, HOP1_WALLET, '100', 'a')];
      }
      if (address.toLowerCase() === HOP1_WALLET.toLowerCase()) {
        return [tx(address, HOP2_WALLET, '100', 'b')];
      }
      if (address.toLowerCase() === HOP2_WALLET.toLowerCase()) {
        return [tx(address, BINANCE_HOT, '100', 'c')];
      }
      return [];
    };
    const taggerFn: ExchangeTaggerFn = async (_chain, address) => {
      if (address.toLowerCase() === BINANCE_HOT.toLowerCase()) {
        return { exchange: 'Binance Hot Wallet', tagged_address: address.toLowerCase() };
      }
      return { exchange: null, tagged_address: null };
    };

    const result = await agent.runTraceHops({
      case_id: start.case_id,
      user_id: USER_A,
      max_hops: 2,
      opts: { chainFetchFn: fetchFn, exchangeTaggerFn: taggerFn },
    });

    assert.equal(result.exchange_tagged, null, 'halts before reaching Binance at hop 3');
    assert.equal(result.hops_analyzed, 2);
    assert.equal(fakeCases[0]!.state, 'tracing');
  });

  it('trace_report_jsonb stores the hop graph correctly', async () => {
    grantPlus(USER_A, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '1',
      amount_usd_cents_at_send: 100n,
    });
    const fetchFn: ChainFetchFn = async (_chain, address) => {
      if (address.toLowerCase() === SCAMMER_WALLET.toLowerCase()) {
        return [tx(address, BINANCE_HOT, '100', 'fast-cashout')];
      }
      return [];
    };
    const taggerFn: ExchangeTaggerFn = async (_c, a) =>
      a.toLowerCase() === BINANCE_HOT.toLowerCase()
        ? { exchange: 'Binance Hot Wallet', tagged_address: a.toLowerCase() }
        : { exchange: null, tagged_address: null };

    await agent.runTraceHops({
      case_id: start.case_id,
      user_id: USER_A,
      opts: { chainFetchFn: fetchFn, exchangeTaggerFn: taggerFn },
    });

    const report = fakeCases[0]!.trace_report_jsonb as {
      schema_version: number;
      hops: Array<{ level: number; address: string; exchange_tagged?: string }>;
      exchange_path: string[];
      halt_reason: string;
    };
    assert.equal(report.schema_version, 1);
    assert.equal(report.halt_reason, 'exchange_identified');
    assert.equal(report.hops.length, 1);
    assert.equal(report.hops[0]!.level, 0);
    assert.equal(report.hops[0]!.address, SCAMMER_WALLET);
    assert.equal(report.hops[0]!.exchange_tagged, 'Binance Hot Wallet');
    assert.deepEqual(report.exchange_path, [SCAMMER_WALLET, BINANCE_HOT]);
  });

  it('chain-api missing key path: chainFetchFn returns [] → hops_analyzed=0, halt_reason=no_outbound_txs', async () => {
    grantPlus(USER_A, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'solana',
      amount_native: '500000',
      amount_usd_cents_at_send: 10_000n,
    });
    // Simulates the no-API-key degraded path from defaultChainFetch.
    const fetchFn: ChainFetchFn = async () => [];
    const taggerFn: ExchangeTaggerFn = async () => ({
      exchange: null,
      tagged_address: null,
    });
    const result = await agent.runTraceHops({
      case_id: start.case_id,
      user_id: USER_A,
      opts: { chainFetchFn: fetchFn, exchangeTaggerFn: taggerFn },
    });
    // Per R-P3b spec: no-data first fetch → hops_analyzed=0, no
    // exchange tag, state stays at 'tracing'. trace_report_jsonb
    // records halt_reason='no_outbound_txs' so the admin surface
    // distinguishes "blocked at API layer" from "exhausted max_hops".
    assert.equal(result.exchange_tagged, null);
    assert.equal(result.hops_analyzed, 0);
    assert.equal(fakeCases[0]!.state, 'tracing');
    const report = fakeCases[0]!.trace_report_jsonb as {
      halt_reason: string;
      hops: unknown[];
    };
    assert.equal(report.halt_reason, 'no_outbound_txs');
    assert.equal(report.hops.length, 0);
  });

  it('cross-user access → throws CryptoTraceCaseNotFoundError', async () => {
    grantPlus(USER_A, SESSION_A);
    grantPlus(USER_B, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '1',
      amount_usd_cents_at_send: 100n,
    });
    await assert.rejects(
      agent.runTraceHops({
        case_id: start.case_id,
        user_id: USER_B, // user B trying to drive user A's case
        opts: {
          chainFetchFn: async () => [],
          exchangeTaggerFn: async () => ({ exchange: null, tagged_address: null }),
        },
      }),
      (err: unknown) => err instanceof agent.CryptoTraceCaseNotFoundError,
    );
  });

  // R-M2 (adversarial-review): regression guard. A re-call of
  // runTraceHops on a case that already advanced past 'tracing'
  // (here: petition_drafted with a stored petition_text) MUST
  // throw InvalidStateError and MUST NOT regress the state or
  // overwrite petition_text via the underlying UPDATE.
  it('R-M2: re-running hops on a petition_drafted case throws and does not regress state', async () => {
    grantPlus(USER_A, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '500000000000000000',
      amount_usd_cents_at_send: 150_000n,
    });

    // Seed: simulate that the case has already walked through trace +
    // petition draft phases. Mutating the in-memory fake row directly
    // is faithful to what would be on disk after the real workflow.
    const seeded = fakeCases.find((c) => c.id === start.case_id)!;
    seeded.state = 'petition_drafted';
    seeded.exchange_tagged = 'Binance Hot Wallet';
    seeded.hops_analyzed = 2;
    seeded.petition_text = 'v1:CIPHERTEXT_PETITION_DO_NOT_OVERWRITE';
    seeded.trace_report_jsonb = {
      schema_version: 1,
      hops: [{ level: 0, address: SCAMMER_WALLET, outbound_count: 1, txs_sampled: [] }],
      exchange_path: [SCAMMER_WALLET, BINANCE_HOT],
      halt_reason: 'exchange_identified',
      analyzed_at: '2026-05-01T00:00:00Z',
    };

    // A fetch that WOULD walk to Binance if the guard wasn't there —
    // proves the guard fires before any work overwrites state.
    const fetchFn: ChainFetchFn = async (_c, address) =>
      address.toLowerCase() === SCAMMER_WALLET.toLowerCase()
        ? [tx(address, BINANCE_HOT, '100', 'rerun')]
        : [];
    const taggerFn: ExchangeTaggerFn = async (_c, a) =>
      a.toLowerCase() === BINANCE_HOT.toLowerCase()
        ? { exchange: 'Binance Hot Wallet', tagged_address: a.toLowerCase() }
        : { exchange: null, tagged_address: null };

    await assert.rejects(
      agent.runTraceHops({
        case_id: start.case_id,
        user_id: USER_A,
        opts: { chainFetchFn: fetchFn, exchangeTaggerFn: taggerFn },
      }),
      (err: unknown) =>
        err instanceof agent.InvalidStateError &&
        /already advanced past trace phase/.test((err as Error).message),
    );

    // State must be unchanged.
    assert.equal(fakeCases[0]!.state, 'petition_drafted');
    // petition_text must be unchanged.
    assert.equal(fakeCases[0]!.petition_text, 'v1:CIPHERTEXT_PETITION_DO_NOT_OVERWRITE');
    // hops_analyzed must be unchanged.
    assert.equal(fakeCases[0]!.hops_analyzed, 2);
  });
});

// ----------------------------------------------------------------
// 6, 7, 10: petition generation
// ----------------------------------------------------------------

describe('generateExchangePetition', () => {
  async function seedExchangeIdentifiedCase(): Promise<string> {
    grantPlus(USER_A, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '500000000000000000',
      amount_usd_cents_at_send: 150_000n,
    });
    const fetchFn: ChainFetchFn = async (_c, address) =>
      address.toLowerCase() === SCAMMER_WALLET.toLowerCase()
        ? [tx(address, BINANCE_HOT, '100', 't')]
        : [];
    const taggerFn: ExchangeTaggerFn = async (_c, a) =>
      a.toLowerCase() === BINANCE_HOT.toLowerCase()
        ? { exchange: 'Binance Hot Wallet', tagged_address: a.toLowerCase() }
        : { exchange: null, tagged_address: null };
    await agent.runTraceHops({
      case_id: start.case_id,
      user_id: USER_A,
      opts: { chainFetchFn: fetchFn, exchangeTaggerFn: taggerFn },
    });
    return start.case_id;
  }

  it('happy path — LLM called, ciphertext stored, disclaimer present', async () => {
    const caseId = await seedExchangeIdentifiedCase();
    let llmCalled = false;
    const llmFn = (async (input: { system: string; user: string }) => {
      llmCalled = true;
      // Model returns a draft WITHOUT the disclaimer; agent must prepend.
      assert.ok(input.system.length > 0);
      assert.ok(input.user.includes('Binance Hot Wallet'));
      return 'RE: Freeze of Funds — Case ' + caseId + '\n\nDear Legal,\n\nWe are writing on behalf of a victim of an on-chain fraud incident. The funds...\n\n[VICTIM SIGNATURE]';
    }) as unknown as typeof import('../src/lib/llm.ts').callLLM;

    const result = await agent.generateExchangePetition({
      case_id: caseId,
      user_id: USER_A,
      opts: { llmFn },
    });

    assert.equal(llmCalled, true);
    // Disclaimer present in the returned plaintext.
    assert.ok(result.petition_text.includes(agent.PETITION_DISCLAIMER));
    // Stored value is ciphertext, NOT the plaintext.
    const stored = fakeCases[0]!.petition_text!;
    assert.ok(stored.startsWith('v1:'), 'petition_text in DB must be envelope ciphertext');
    assert.ok(!stored.includes(agent.PETITION_DISCLAIMER), 'plaintext disclaimer must not leak into stored row');
    // State advanced.
    assert.equal(fakeCases[0]!.state, 'petition_drafted');
  });

  it('idempotent disclaimer — when LLM includes it, we do not double-prepend', async () => {
    const caseId = await seedExchangeIdentifiedCase();
    const llmFn = (async () =>
      `${agent.PETITION_DISCLAIMER}\n\nRE: Freeze of Funds\n\nDear Legal,\n\n...`) as unknown as typeof import('../src/lib/llm.ts').callLLM;
    const result = await agent.generateExchangePetition({
      case_id: caseId,
      user_id: USER_A,
      opts: { llmFn },
    });
    // Count occurrences — must be exactly 1.
    const count = result.petition_text.split(agent.PETITION_DISCLAIMER).length - 1;
    assert.equal(count, 1, 'disclaimer must appear exactly once');
  });

  it('before exchange identified → throws InvalidStateError', async () => {
    grantPlus(USER_A, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '1',
      amount_usd_cents_at_send: 100n,
    });
    // state is 'intake' — still need to runTraceHops first.
    await assert.rejects(
      agent.generateExchangePetition({
        case_id: start.case_id,
        user_id: USER_A,
        opts: { llmFn: (async () => 'irrelevant') as unknown as typeof import('../src/lib/llm.ts').callLLM },
      }),
      (err: unknown) =>
        err instanceof agent.InvalidStateError &&
        /Cannot generate petition before exchange is identified/.test((err as Error).message),
    );
  });

  it('cross-user → CryptoTraceCaseNotFoundError', async () => {
    const caseId = await seedExchangeIdentifiedCase();
    grantPlus(USER_B, SESSION_A);
    await assert.rejects(
      agent.generateExchangePetition({
        case_id: caseId,
        user_id: USER_B,
        opts: { llmFn: (async () => 'irrelevant') as unknown as typeof import('../src/lib/llm.ts').callLLM },
      }),
      (err: unknown) => err instanceof agent.CryptoTraceCaseNotFoundError,
    );
  });
});

// ----------------------------------------------------------------
// 8. advanceCryptoTraceCase
// ----------------------------------------------------------------

describe('advanceCryptoTraceCase', () => {
  it('rejects illegal transitions (intake → frozen)', async () => {
    grantPlus(USER_A, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '1',
      amount_usd_cents_at_send: 100n,
    });
    await assert.rejects(
      agent.advanceCryptoTraceCase({
        case_id: start.case_id,
        user_id: USER_A,
        next_state: 'frozen',
      }),
      (err: unknown) => err instanceof agent.InvalidStateError,
    );
  });

  it('accepts legal transitions and persists the new state', async () => {
    grantPlus(USER_A, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '1',
      amount_usd_cents_at_send: 100n,
    });
    // intake → closed is allowed (operator close on a stalled case).
    const r = await agent.advanceCryptoTraceCase({
      case_id: start.case_id,
      user_id: USER_A,
      next_state: 'closed',
    });
    assert.equal(r.state, 'closed');
    assert.equal(fakeCases[0]!.state, 'closed');
  });

  it('cross-user advance → CryptoTraceCaseNotFoundError', async () => {
    grantPlus(USER_A, SESSION_A);
    grantPlus(USER_B, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '1',
      amount_usd_cents_at_send: 100n,
    });
    await assert.rejects(
      agent.advanceCryptoTraceCase({
        case_id: start.case_id,
        user_id: USER_B,
        next_state: 'closed',
      }),
      (err: unknown) => err instanceof agent.CryptoTraceCaseNotFoundError,
    );
  });
});

// ----------------------------------------------------------------
// 9. getCryptoTraceCase cross-user safety
// ----------------------------------------------------------------

describe('getCryptoTraceCase', () => {
  it('returns the case for the owner', async () => {
    grantPlus(USER_A, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '1',
      amount_usd_cents_at_send: 100n,
    });
    const row = await agent.getCryptoTraceCase({
      case_id: start.case_id,
      user_id: USER_A,
    });
    assert.ok(row);
    assert.equal((row as CryptoTraceCaseRow).id, start.case_id);
  });

  it('returns null on cross-user read', async () => {
    grantPlus(USER_A, SESSION_A);
    const start = await agent.startCryptoTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_A,
      source_wallet: '0xVICTIM',
      destination_wallet: SCAMMER_WALLET,
      chain: 'ethereum',
      amount_native: '1',
      amount_usd_cents_at_send: 100n,
    });
    const row = await agent.getCryptoTraceCase({
      case_id: start.case_id,
      user_id: USER_B,
    });
    assert.equal(row, null);
  });
});
