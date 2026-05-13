-- Recovery Shield — P3b: crypto-trace case + on-chain hop analysis.
--
-- One row per crypto-trace case. Recovery Plus users start one of
-- these when they sent crypto to a scammer wallet. The cryptoTraceAgent
-- (P3b) pulls transaction history from chain RPC (Etherscan / Blockchair),
-- walks forward N=5 hops from destination_wallet, and tags exchange-
-- deposit addresses (Arkham Intel API or maintained mapping). When a
-- hop lands on a tagged exchange, the agent halts and generates a
-- freeze-of-funds petition addressed to that exchange's legal dept.
--
-- CHAIN COVERAGE (v1):
--   ethereum, bitcoin, tron, polygon, bsc, solana, arbitrum, optimism,
--   base. ~95% of retail-victim coverage. Other chains (avalanche,
--   ftm, cosmos, near) deferred to v2 — the LLM petition template is
--   chain-agnostic but the RPC adapter isn't.
--
-- WHY string-encoded amount_native:
--   Crypto amounts have wider dynamic range than JS / pg numeric. A
--   typical ETH amount is 1.234567890123456789 (18 decimals) and BTC
--   is 0.00012345 (8 decimals). NUMERIC(38,18) would cover most but
--   we'd still risk floating-point loss on the JS bridge. Storing
--   the canonical decimal string from the chain RPC ("12345678" in
--   wei, "12345" in satoshi) and converting at the API boundary
--   removes the entire class of float-precision bug.
--
-- WHY amount_usd_cents_at_send (BIGINT):
--   Pricing snapshot at the time of the send, for case-value
--   reporting + admin revenue dashboard ("how much loss are our
--   crypto cases trying to recover?"). BIGINT cents lets us cover
--   cases >$21M without overflow — important for the rare
--   institutional-victim case that lands in the consumer flow.
--
-- TRACE REPORT:
--   trace_report_jsonb stores the full hop graph + exchange
--   interaction breakdown. Shape (versioned in cryptoTraceAgent.ts):
--     { hops: [{ from, to, value, tx_hash, timestamp }],
--       exchange_hits: [{ hop_index, exchange, deposit_addr }],
--       analyzed_at, chain_rpc_provider }
--   Stored as JSONB so we can slice/query without schema churn as
--   the trace-report shape evolves.
--
-- STATE MACHINE:
--   intake               — case opened, user supplying wallets
--   tracing              — RPC hops in flight (async; can take min)
--   exchange_identified  — trace landed on a tagged exchange
--   petition_drafted     — LLM generated the freeze petition
--   user_sent            — user sent petition to exchange legal
--   exchange_acked       — exchange confirmed receipt
--   frozen               — terminal: funds frozen (rare, ~3-5%)
--   denied               — terminal: exchange refused
--   closed               — terminal: user closed, untraceable, etc.
--
-- PRIVACY POSTURE:
--   - source_wallet / destination_wallet are on-chain public data.
--     Plaintext. The user owns the source; the destination is the
--     scammer's address (public knowledge once the tx hit the chain).
--   - amount_native + amount_usd_cents_at_send: not strictly PII but
--     correlatable to identity in some cases (rare large transfer
--     from a known wallet). Plaintext acceptable given the on-chain
--     trail is public anyway.
--   - petition_text: envelope-encrypted. Contains the user's narrative,
--     case ID, dollar value at send. Same sensitivity tier as the
--     wire-trace dispute letter.
--   - trace_report_jsonb: plaintext. Pure on-chain data; user identity
--     is in the row's user_id FK, not in the JSON.
--
-- RETENTION: 365 days from created_at (same logic as wire_trace_cases —
-- crypto cases can drag in legal proceedings; legal_documents references
-- this case_id and we don't want a stale FK).
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS crypto_trace_cases (
  id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recovery_session_id       UUID         NOT NULL REFERENCES recovery_sessions(id) ON DELETE CASCADE,
  -- Victim's wallet (consented sharing — they supplied it). On-chain
  -- public data; plaintext acceptable.
  source_wallet             TEXT         NOT NULL,
  -- Scammer's wallet, on-chain public.
  destination_wallet        TEXT         NOT NULL,
  -- Chain enum. CHECK pins to the v1 coverage set; v2 expansions
  -- require both an RPC adapter + a migration to extend the CHECK.
  chain                     TEXT         NOT NULL CHECK (chain IN
    ('ethereum','bitcoin','tron','polygon','bsc','solana','arbitrum','optimism','base')),
  -- Native amount as a decimal string (in the chain's base unit —
  -- wei for eth, satoshi for btc, lamports for solana). String-
  -- encoded to avoid float-precision loss on the JS bridge.
  amount_native             TEXT         NOT NULL,
  -- USD pricing snapshot at send time, BIGINT cents. Wide enough
  -- for the rare institutional-victim case ($21M+).
  amount_usd_cents_at_send  BIGINT       NOT NULL,
  -- Hops walked forward from destination_wallet. The trace halts at
  -- the first tagged exchange (typically 1-5 hops); some cases
  -- exhaust max_hops without landing on a tag.
  hops_analyzed             INTEGER      NOT NULL DEFAULT 0,
  -- Tagged exchange name if the trace identified one
  -- ("Binance Hot Wallet", "Coinbase Custody", "Kraken Deposit").
  -- NULL if the trace exhausted max_hops without a hit.
  exchange_tagged           TEXT,
  -- Full hop graph + exchange interactions. Plaintext (on-chain
  -- data is public).
  trace_report_jsonb        JSONB,
  -- State machine. Transition rules enforced in cryptoTraceAgent.ts.
  state                     TEXT         NOT NULL CHECK (state IN
    ('intake','tracing','exchange_identified','petition_drafted','user_sent','exchange_acked','frozen','denied','closed')),
  -- Generated freeze-of-funds petition, envelope-encrypted. Contains
  -- the user's narrative, dollar value, case ID. Same sensitivity
  -- tier as the wire-trace dispute letter.
  petition_text             TEXT,
  state_changed_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Hot path: "show me my crypto-trace cases" for the iOS dashboard.
CREATE INDEX IF NOT EXISTS idx_crypto_trace_user
  ON crypto_trace_cases (user_id, created_at DESC);

-- Recovery session drill-down.
CREATE INDEX IF NOT EXISTS idx_crypto_trace_session
  ON crypto_trace_cases (recovery_session_id);

COMMENT ON TABLE crypto_trace_cases IS
  'Recovery Shield — crypto-trace case. cryptoTraceAgent.ts walks N=5 hops from destination_wallet via chain RPC, tags exchange-deposit addresses, generates freeze petition. petition_text envelope-encrypted; trace_report_jsonb plaintext (on-chain data is public).';

COMMENT ON COLUMN crypto_trace_cases.amount_native IS
  'Native amount as a decimal string in the chain''s base unit (wei / satoshi / lamports). String-encoded to avoid float-precision loss; converted at the API boundary.';

COMMENT ON COLUMN crypto_trace_cases.trace_report_jsonb IS
  'Full hop graph + exchange interactions. Shape: { hops: [{from,to,value,tx_hash,timestamp}], exchange_hits: [{hop_index,exchange,deposit_addr}], analyzed_at, chain_rpc_provider }. Versioned in cryptoTraceAgent.ts.';

COMMENT ON COLUMN crypto_trace_cases.petition_text IS
  'Freeze-of-funds petition addressed to the tagged exchange''s legal department. Envelope-encrypted (v1:<iv>:<tag>:<ct>).';

COMMENT ON COLUMN crypto_trace_cases.state IS
  'State machine: intake → tracing → exchange_identified → petition_drafted → user_sent → exchange_acked → (frozen|denied|closed). Transition rules in cryptoTraceAgent.ts.';
