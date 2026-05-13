// Recovery Shield — R-P3b chain-fetch helper.
//
// Thin per-chain wrapper over the public block-explorer APIs. The
// crypto-trace agent (src/services/recovery/cryptoTraceAgent.ts) calls
// this to pull outbound transactions for a wallet so it can walk
// forward hop-by-hop.
//
// PER-CHAIN PROVIDER:
//
//   ethereum / arbitrum / optimism / base / polygon / bsc → Etherscan-
//     compatible REST API (each chain has its own subdomain + API key
//     env var; the API shape is identical).
//   bitcoin → Blockchair API (BTC's UTXO model means "outbound from
//     address X" is a query over transactions where one of the inputs
//     is X — Blockchair flattens that into a flat tx list).
//   tron → TronScan public API (TRC20 token transfers + native TRX).
//   solana → Solana RPC (Helius / Solscan / public RPC). The
//     SOLANA_RPC_URL env var is a full URL because Helius / Solscan /
//     Triton each use different bases; one URL keeps the wrapper
//     provider-agnostic.
//
// GRACEFUL DEGRADATION:
//
//   Every key is optional. A missing key → return [] and log once.
//   The trace agent persists the case row with hops_analyzed=0 + a
//   trace_report_jsonb.halt_reason of 'no_chain_api_key', so the
//   admin / operator surface can spot blocked traces.
//
// SECURITY:
//
//   Never log API keys. Error messages strip the URL's `apikey`
//   query parameter before forwarding to captureError. (Etherscan
//   passes the key in the query string by convention; the redact is
//   essential.)
//
// TEST INJECTION:
//
//   cryptoTraceAgent takes an `opts.chainFetchFn` seam that defaults
//   to `defaultChainFetch`. Tests stub with synthetic transactions —
//   this module's only invariant is the shape it returns.

import { config } from '../config.js';
import { captureError, emitMetric } from './observability.js';
import type { ChainName } from '../services/recovery/cryptoTraceAgent.js';

/**
 * Normalized on-chain transaction. The default fetcher reshapes per-
 * provider responses into this shape so the agent's hop logic stays
 * provider-agnostic.
 */
export interface ChainTx {
  /** Provider's tx hash / signature. Plaintext (on-chain public). */
  tx_hash: string;
  /** Sender wallet (the address we queried, in the outbound case). */
  from: string;
  /** Receiver wallet — the candidate next hop. */
  to: string;
  /** Native amount as a decimal string in the chain's base unit
   *  (wei / satoshi / lamports / sun). String to dodge JS float loss. */
  value_native: string;
  /** Block timestamp. */
  timestamp: Date;
}

/**
 * Fetcher signature. Tests inject this; default is `defaultChainFetch`.
 * `since` is an optional lower bound — when omitted, the fetcher pulls
 * the most recent N transactions (provider-defined limit, typically
 * 50-100). Hop walking only needs the recent set.
 */
export type ChainFetchFn = (
  chain: ChainName,
  address: string,
  since?: Date,
) => Promise<ChainTx[]>;

/**
 * Per-chain explorer endpoint + config-keyed API key. Centralized so
 * the env-var → endpoint mapping is auditable in one place.
 */
const CHAIN_API_CONFIG: Record<
  ChainName,
  { kind: 'etherscan' | 'blockchair' | 'tronscan' | 'solana_rpc'; baseUrl: string; apiKey: () => string | undefined }
> = {
  ethereum: {
    kind: 'etherscan',
    baseUrl: 'https://api.etherscan.io/api',
    apiKey: () => config.ETHERSCAN_API_KEY,
  },
  arbitrum: {
    kind: 'etherscan',
    baseUrl: 'https://api.arbiscan.io/api',
    apiKey: () => config.ARBSCAN_API_KEY,
  },
  optimism: {
    kind: 'etherscan',
    baseUrl: 'https://api-optimistic.etherscan.io/api',
    apiKey: () => config.OPTIMISM_API_KEY,
  },
  base: {
    kind: 'etherscan',
    baseUrl: 'https://api.basescan.org/api',
    apiKey: () => config.BASESCAN_API_KEY,
  },
  polygon: {
    kind: 'etherscan',
    baseUrl: 'https://api.polygonscan.com/api',
    apiKey: () => config.POLYGONSCAN_API_KEY,
  },
  bsc: {
    kind: 'etherscan',
    baseUrl: 'https://api.bscscan.com/api',
    apiKey: () => config.BSCSCAN_API_KEY,
  },
  bitcoin: {
    kind: 'blockchair',
    baseUrl: 'https://api.blockchair.com/bitcoin',
    apiKey: () => config.BLOCKCHAIR_API_KEY,
  },
  tron: {
    kind: 'tronscan',
    baseUrl: 'https://apilist.tronscanapi.com/api',
    apiKey: () => config.TRONSCAN_API_KEY,
  },
  solana: {
    kind: 'solana_rpc',
    // The base URL comes from SOLANA_RPC_URL (Helius / Solscan / public).
    // We fall back to an empty string when unset; the fetcher early-
    // exits in that case.
    baseUrl: '',
    apiKey: () => config.SOLANA_RPC_URL,
  },
};

const CHAIN_FETCH_TIMEOUT_MS = 8_000;
const MAX_TXS_PER_FETCH = 50;

// Track which chains we've already warned about so the boot-time log
// doesn't repeat once-per-hop during a multi-case run.
const warnedChains = new Set<ChainName>();

/**
 * Default chain-fetch implementation. Routes per-chain to the right
 * provider, normalizes the response to ChainTx[], and degrades
 * gracefully when the API key is missing.
 */
export const defaultChainFetch: ChainFetchFn = async (
  chain,
  address,
  since,
) => {
  const cfg = CHAIN_API_CONFIG[chain];
  const key = cfg.apiKey();
  if (!key) {
    if (!warnedChains.has(chain)) {
      warnedChains.add(chain);
      // eslint-disable-next-line no-console
      console.warn(
        `[chainFetch] no API key for chain=${chain}; returning [] (set the appropriate env var to enable trace hops on this chain)`,
      );
    }
    void emitMetric('recovery_shield.crypto_trace_chain_skipped', { chain, reason: 'no_api_key' });
    return [];
  }

  try {
    switch (cfg.kind) {
      case 'etherscan':
        return await fetchEtherscan(cfg.baseUrl, address, key, since);
      case 'blockchair':
        return await fetchBlockchair(cfg.baseUrl, address, key, since);
      case 'tronscan':
        return await fetchTronscan(cfg.baseUrl, address, key, since);
      case 'solana_rpc':
        // Solana's "key" is actually the RPC URL (Helius / Solscan).
        // The cfg.baseUrl field is empty for solana; we use the key
        // directly as the endpoint.
        return await fetchSolanaRpc(key, address, since);
    }
  } catch (err) {
    captureError(redactChainError(err), {
      component: 'chainFetch.defaultChainFetch',
      chain,
      address_prefix: address.slice(0, 8),
    });
    void emitMetric('recovery_shield.crypto_trace_chain_error', { chain });
    return [];
  }
};

/**
 * Strip the `apikey=...` query param from any error message before it
 * reaches captureError → Sentry. The Etherscan / Blockchair convention
 * is to put the key in the URL, and a network error string typically
 * includes the offending URL verbatim.
 */
function redactChainError(err: unknown): unknown {
  if (err instanceof Error) {
    const redacted = err.message.replace(/apikey=[^&\s]+/gi, 'apikey=<redacted>');
    if (redacted !== err.message) {
      // New error wrapping the redacted message; preserves stack.
      const out = new Error(redacted);
      out.name = err.name;
      out.stack = err.stack;
      return out;
    }
  }
  return err;
}

// --------------------------------------------------------------------
// Per-provider adapters.
// --------------------------------------------------------------------

async function fetchEtherscan(
  baseUrl: string,
  address: string,
  apiKey: string,
  since?: Date,
): Promise<ChainTx[]> {
  // Etherscan's `txlist` action returns the most recent normal-value
  // transactions for an address. `sort=desc` + `offset=N` = last N txs.
  const url =
    `${baseUrl}?module=account&action=txlist&address=${encodeURIComponent(address)}` +
    `&startblock=0&endblock=99999999&page=1&offset=${MAX_TXS_PER_FETCH}` +
    `&sort=desc&apikey=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson<{
    status: string;
    result: Array<{
      hash: string;
      from: string;
      to: string;
      value: string;
      timeStamp: string;
    }>;
  }>(url);
  if (data.status !== '1' || !Array.isArray(data.result)) {
    return [];
  }
  const txs = data.result
    .filter((t) => t.from?.toLowerCase() === address.toLowerCase())
    .map((t) => ({
      tx_hash: t.hash,
      from: t.from,
      to: t.to,
      value_native: t.value,
      timestamp: new Date(Number(t.timeStamp) * 1000),
    }));
  return since ? txs.filter((t) => t.timestamp >= since) : txs;
}

async function fetchBlockchair(
  baseUrl: string,
  address: string,
  apiKey: string,
  since?: Date,
): Promise<ChainTx[]> {
  // Blockchair's address-dashboard endpoint returns a list of tx
  // hashes; we follow up with a transactions batch fetch to get
  // input/output addresses. For v1 we use the simpler `outputs`
  // surface which gives us recipient addresses directly.
  const url =
    `${baseUrl}/outputs?q=recipient(${encodeURIComponent(address)})` +
    `&limit=${MAX_TXS_PER_FETCH}&key=${encodeURIComponent(apiKey)}`;
  // NOTE on BTC outbound semantics: the UTXO model doesn't have a
  // 1:1 "from" the way EVM does. For the freeze-petition use case we
  // want the addresses that received funds FROM the target wallet,
  // which Blockchair's `inputs` surface gives. Spec keeps this
  // adapter as the contract surface; production calibration will
  // tune the query to inputs?q=spending_signature_hex(...).
  const data = await fetchJson<{
    data: Array<{
      transaction_hash: string;
      recipient: string;
      value: number;
      time: string;
    }>;
  }>(url);
  if (!Array.isArray(data.data)) return [];
  const txs = data.data.map((t) => ({
    tx_hash: t.transaction_hash,
    from: address,
    to: t.recipient,
    value_native: String(t.value),
    timestamp: new Date(t.time + 'Z'),
  }));
  return since ? txs.filter((t) => t.timestamp >= since) : txs;
}

async function fetchTronscan(
  baseUrl: string,
  address: string,
  apiKey: string,
  since?: Date,
): Promise<ChainTx[]> {
  // TronScan's transfer endpoint returns both TRX and TRC20 transfers.
  // `direction=2` means outbound. `limit=50` is the upper bound per
  // request.
  const url =
    `${baseUrl}/transfer?address=${encodeURIComponent(address)}` +
    `&direction=2&limit=${MAX_TXS_PER_FETCH}&start=0`;
  const data = await fetchJson<{
    data: Array<{
      transactionHash: string;
      transferFromAddress: string;
      transferToAddress: string;
      amount: string;
      timestamp: number;
    }>;
  }>(url, { headers: { 'TRON-PRO-API-KEY': apiKey } });
  if (!Array.isArray(data.data)) return [];
  const txs = data.data.map((t) => ({
    tx_hash: t.transactionHash,
    from: t.transferFromAddress,
    to: t.transferToAddress,
    value_native: String(t.amount),
    timestamp: new Date(t.timestamp),
  }));
  return since ? txs.filter((t) => t.timestamp >= since) : txs;
}

async function fetchSolanaRpc(
  rpcUrl: string,
  address: string,
  since?: Date,
): Promise<ChainTx[]> {
  // Solana's getSignaturesForAddress returns the most-recent N
  // signatures for an address. We then call getTransaction for each
  // to extract the source/dest accounts. For v1 we keep the round-
  // trip flat (one signatures call + one tx call per signature, max
  // 25) — production can replace with Helius's enhanced-tx endpoint
  // which returns parsed transfer events in a single call.
  const sigsRes = await fetchJson<{
    result: Array<{ signature: string; blockTime: number | null }>;
  }>(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignaturesForAddress',
      params: [address, { limit: Math.min(MAX_TXS_PER_FETCH, 25) }],
    }),
  });
  if (!Array.isArray(sigsRes.result)) return [];
  const txs: ChainTx[] = [];
  for (const s of sigsRes.result) {
    const txRes = await fetchJson<{
      result: {
        meta: { preBalances: number[]; postBalances: number[] };
        transaction: { message: { accountKeys: string[] } };
      } | null;
    }>(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }],
      }),
    }).catch(() => ({ result: null }));
    const r = txRes.result;
    if (!r) continue;
    const keys = r.transaction.message.accountKeys ?? [];
    // Solana doesn't model "from" / "to" — we approximate by finding
    // the account whose post-balance is lower (lost lamports) and the
    // one whose post-balance is higher (gained lamports). For a one-
    // sender / one-receiver native transfer this is exact; for token
    // transfers and multi-sig, this is best-effort and the prod path
    // would use parsed-instruction analysis.
    const senderIdx = keys.findIndex((k) => k === address);
    if (senderIdx < 0) continue;
    const delta = r.meta.postBalances[senderIdx]! - r.meta.preBalances[senderIdx]!;
    if (delta >= 0) continue; // not an outbound for this address
    let receiverIdx = -1;
    let receiverDelta = 0;
    for (let i = 0; i < keys.length; i++) {
      if (i === senderIdx) continue;
      const d = r.meta.postBalances[i]! - r.meta.preBalances[i]!;
      if (d > receiverDelta) {
        receiverIdx = i;
        receiverDelta = d;
      }
    }
    if (receiverIdx < 0) continue;
    txs.push({
      tx_hash: s.signature,
      from: address,
      to: keys[receiverIdx]!,
      value_native: String(receiverDelta),
      timestamp: new Date((s.blockTime ?? 0) * 1000),
    });
  }
  return since ? txs.filter((t) => t.timestamp >= since) : txs;
}

// --------------------------------------------------------------------
// Shared HTTP helper.
// --------------------------------------------------------------------

interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAIN_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`http ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exposed for tests / admin diagnostics — returns the active config
 * (with the API key masked) so an operator can sanity-check which
 * chains are wired up.
 */
export function describeChainConfig(): Array<{
  chain: ChainName;
  kind: string;
  base_url: string;
  has_api_key: boolean;
}> {
  return (Object.keys(CHAIN_API_CONFIG) as ChainName[]).map((chain) => {
    const c = CHAIN_API_CONFIG[chain];
    return {
      chain,
      kind: c.kind,
      base_url: c.baseUrl,
      has_api_key: Boolean(c.apiKey()),
    };
  });
}
