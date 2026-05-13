# Recovery Shield — Operator Runbook

**Audience:** anyone deploying, troubleshooting, or auditing Recovery Shield in prod or staging.
**Prereq:** Migrations 062–067 applied; the Recovery Shield routes (`src/routes/recoveryShield.ts`) and admin routes (`src/routes/adminRecoveryShield.ts`) registered in `src/server.ts`.

Recovery Shield is Pro-tier-gated for read surfaces and Pro+Plus-gated for every mutation surface (case creation, document generation, specialist referral). The $249 Recovery Plus IAP is a per-recovery-session unlock — buying Plus for one scam does NOT unlock the next. This runbook is what you need to keep the lights on.

---

## 1. Mental model

Recovery Shield has three pillars (Trace + Document + Refer) plus two deferred-for-v2 pillars (Coach + Restore). Each is independently degradable: a Pillar 2 LLM failure does not take Pillar 1's state machine down with it.

| Pillar | Surface | What it does | Dependencies |
|---|---|---|---|
| **1 — Trace** | `POST /v1/recovery/trace/wire*`, `POST /v1/recovery/trace/crypto*` | Wire-recall state machine + crypto-trace hop walk + exchange-tagger | Bank scaffold library, chain RPC providers, exchange tagger, Anthropic LLM |
| **2 — Document** | `POST /v1/recovery/documents/generate`, `GET /v1/recovery/documents*` | Multi-doc legal packet (IC3, FTC, CFPB, state AG, affidavit, demand, credit-freeze, police-report) | Anthropic LLM, `stateAgComplaintForms.ts` template library |
| **3 — Refer** | `GET /v1/recovery/specialists*`, `POST /v1/recovery/specialists/refer`, `GET /v1/recovery/referrals` | Vetted specialist marketplace + referral lifecycle | `specialists` table populated by admin, no external API |
| 4 — Coach (v2) | deferred | In-app guided playbooks per scam type | — |
| 5 — Restore (v2) | deferred | Identity-restoration coordination across credit bureaus + carriers | — |

Plus the entitlement layer that gates all three pillars:

| **Recovery Plus** | `POST /v1/recovery/plus/purchase`, `GET /v1/recovery/plus/status` | $249 per-session unlock; Apple JWS verified; refundable via S2S webhook | Apple StoreKit 2, `verifyAppleTransactionJws` |

**Per-session entitlement model.** A user who buys Plus for `session_A` does NOT get Plus for `session_B`. Every scam is its own incident; the pricing reflects that (admin reviews + legal-packet generation + specialist marketplace access are per-case work). The `recovery_plus_purchases.recovery_session_id` column binds the unlock at purchase time; if NULL on insert, the first `hasRecoveryPlus(user, session)` call atomically binds it (pre-purchase upsell flow).

**Ethics posture — "never take a cut of recovered funds."** AegisDial does not charge a contingency fee on recovered money. The $249 is paid up-front. The specialist marketplace has commission percentages (`specialists.commission_pct`), but those are between the user and the specialist — AegisDial does not skim. The runbook below documents the operational guarantees that keep this posture honest.

---

## 2. Required env vars

Set on Fly via `fly secrets set ... -a <app>` (mirrors the V4 + Email Shield pattern).

```bash
# Apple StoreKit — required for Plus purchase verification.
fly secrets set APPLE_APP_BUNDLE_ID=com.aegisdial.app -a <app>      # existing
fly secrets set APPLE_STOREKIT_ENV=production -a <app>              # 'production' or 'sandbox'

# Chain RPC keys. All OPTIONAL — feature degrades per-chain when a key is missing.
# Specifically: defaultChainFetch returns [] for the missing chain, the hop
# walk records halt_reason='no_outbound_txs', and the case row persists
# with hops_analyzed=0. Operator-visible via /v1/admin/recovery-shield/summary.
fly secrets set ETHERSCAN_API_KEY=...    -a <app>   # ethereum
fly secrets set ARBSCAN_API_KEY=...      -a <app>   # arbitrum
fly secrets set OPTIMISM_API_KEY=...     -a <app>   # optimism
fly secrets set BASESCAN_API_KEY=...     -a <app>   # base
fly secrets set POLYGONSCAN_API_KEY=...  -a <app>   # polygon
fly secrets set BSCSCAN_API_KEY=...      -a <app>   # bsc
fly secrets set BLOCKCHAIR_API_KEY=...   -a <app>   # bitcoin (UTXO; Blockchair flattens to tx list)
fly secrets set TRONSCAN_API_KEY=...     -a <app>   # tron
fly secrets set SOLANA_RPC_URL=...       -a <app>   # solana (full URL — Helius / Solscan / Triton)

# LLM — required for dispute letters, exchange petitions, legal packet docs.
# Without ANTHROPIC_API_KEY every LLM-driven route returns 502 trace_unavailable;
# the state-machine routes (trace/wire/advance, trace/crypto/advance) and the
# specialist marketplace continue to work.
fly secrets set ANTHROPIC_API_KEY=... -a <app>
```

**No HIBP / OAuth secrets** — those are Email Shield's surface and do not apply here.

**Per-chain key absence is not a hard failure.** The `defaultChainFetch` helper logs once on cold start when each key is missing and returns `[]` for that chain. The operator dashboard's `top_refund_window` panel (Email Shield) doesn't apply; the equivalent here is reading the `recovery_shield.crypto_trace_hops` metric grouped by `chain` — a chain with persistent `hops_analyzed=0` results means a missing/rate-limited key.

---

## 3. Admin dashboards

All routes are bearer-auth via `requireBearer` (shared secret = `$API_SHARED_SECRET`). All time-bounded; no per-user PII; aggregate-only. Specialists' `display_name` + `category` ARE surfaced because they are marketplace-public B2B partner records (migration 066 — SHARED resources, not user-owned).

| Endpoint | Returns |
|---|---|
| `GET /v1/admin/recovery-shield/summary` | Open Plus purchases 30d, total revenue 30d (cents), wire-cases-by-state, crypto-cases-by-state, open-cases counts, legal-docs 30d count, referrals-by-status 30d |
| `GET /v1/admin/recovery-shield/cases-timeline` | Per-day buckets 30d UTC: `{date, wire_cases_opened, crypto_cases_opened, legal_packets_generated, referrals_created}` |
| `GET /v1/admin/recovery-shield/specialist-performance` | Per-specialist leaderboard 90d: referrals_count, won/lost counts, conversion_pct, fee_owed_total_cents, fee_paid_total_cents |
| `GET /v1/admin/recovery-shield/document-quality` | Per-doc_kind 30d: generated_count, avg_body_length (ciphertext-byte proxy), disclaimer_acknowledgement_rate |
| `GET /v1/admin/recovery-shield/refund-rate` | total_purchases_30d, refunded_30d, refund_pct, top_refund_window {within_24h, within_7d, after_7d} — IAP-fraud detector |

Quick health probe (paste-and-run):

```bash
curl -H "Authorization: Bearer $API_SHARED_SECRET" \
  https://<app>.fly.dev/v1/admin/recovery-shield/summary | jq .
```

If this returns 200 with non-empty (or all-zero) counters and no 5xx, the migrations are applied and `adminRecoveryShieldRoutes` is registered in `server.ts`. Any 5xx with `error: 'admin_route_failed'` means a pg error inside the handler — grep server logs for the correlation_id in the response body.

---

## 4. Cutover playbook

### Stage A — migrations

```bash
# Apply 062-067 in order:
psql $DATABASE_URL -f db/migrations/062_recovery_plus_purchases.sql
psql $DATABASE_URL -f db/migrations/063_wire_trace_cases.sql
psql $DATABASE_URL -f db/migrations/064_crypto_trace_cases.sql
psql $DATABASE_URL -f db/migrations/065_legal_documents.sql
psql $DATABASE_URL -f db/migrations/066_specialists.sql
psql $DATABASE_URL -f db/migrations/067_specialist_referrals.sql
```

All six migrations use `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` + idempotent `ALTER TABLE` guards. Re-running is a no-op.

### Stage B — Apple IAP product

Configure the Recovery Plus IAP in App Store Connect:

- Product ID: `recovery_plus_one_time` (the constant `RECOVERY_PLUS_PRODUCT_ID` in `recoveryPlusEntitlement.ts`)
- Type: Non-Consumable (one Apple ID can only buy once — replay protection works via Apple as well as via `apple_transaction_id UNIQUE`)
- Price: $249 USD (24900 cents — matches `RECOVERY_PLUS_PRICE_CENTS`)

If the product ID does not match, `purchaseRecoveryPlus` throws `InvalidProductError` and the route returns `400 invalid_product`. If the price doesn't match, `InvalidPriceError` → `400 invalid_price`. Both are cheap fast-fails before the JWS verifier runs.

### Stage C — env vars

Set per §2 above. Fly restarts the app on each `fly secrets set`. Confirm with:

```bash
fly secrets list -a <app> | grep -E '(APPLE_|ETHERSCAN|ARBSCAN|OPTIMISM|BASESCAN|POLYGONSCAN|BSCSCAN|BLOCKCHAIR|TRONSCAN|SOLANA_RPC|ANTHROPIC)'
```

### Stage D — seed the specialists table

There is **no admin route to populate specialists** at v1. BD onboards 8–12 vetted specialists pre-launch; engineering inserts them by hand:

```sql
INSERT INTO specialists (
  display_name, category, jurisdictions, capabilities,
  commission_pct, contact_email, contact_phone, bar_number,
  status, vetted_at, vetted_by, notes
) VALUES (
  'Acme Asset Recovery LLP',
  'asset_recovery_attorney',
  ARRAY['US-FL', 'US-CA']::TEXT[],
  ARRAY['wire_recall', 'crypto']::TEXT[],
  10.00,
  'intake@acme.example',
  '+1-555-0199',
  'FL-12345',
  'active',
  NOW(),
  '<admin-user-uuid>',
  'BD vetted 2026-05-09; bar# verified.'
);
```

Repeat per specialist. The marketplace filter only surfaces `status='active'` rows. `status='pending'` is the safe default if you accidentally insert without setting it — the row sits invisible until an admin promotes it.

**Open / pre-prod gate:** legal review of generated docs. Counsel sign-off on `LEGAL_PACKET_DISCLAIMER` and the per-doc-kind prompts is a hard requirement before flipping the iOS surface live. The disclaimer text in `legalPacketGenerator.ts` is a placeholder.

### Stage E — verify routes

```bash
# Admin summary — should be 200 with all-zero counters on a fresh deploy:
curl -H "Authorization: Bearer $API_SHARED_SECRET" \
  https://<app>.fly.dev/v1/admin/recovery-shield/summary | jq .

# Plus status (synthetic dev bearer — only works with ALLOW_DEV_BEARER=true and NODE_ENV != production):
curl -H "Authorization: Bearer $API_SHARED_SECRET" \
  'https://<app>.fly.dev/v1/recovery/plus/status?recovery_session_id=00000000-0000-0000-0000-000000000000' | jq .
```

A 5xx on the admin route means migrations didn't apply or `adminRecoveryShieldRoutes` isn't registered in `server.ts`. A 401 on the Plus-status route means `ALLOW_DEV_BEARER` is unset (correct for prod).

### Stage F — smoke a purchase end-to-end (sandbox)

With `APPLE_STOREKIT_ENV=sandbox` set and a sandbox iOS build:

1. Run the iOS Recovery Plus IAP flow.
2. iOS posts the signedTransactionInfo JWS to `POST /v1/recovery/plus/purchase`.
3. Backend verifies via `verifyAppleTransactionJws`, inserts the row, returns `201 { purchase_id, entitled_session_id, is_new: true }`.
4. iOS calls `GET /v1/recovery/plus/status?recovery_session_id=...` → `{ entitled: true }`.

If step 3 returns `400 invalid_bundle`, the JWS came from a different app (typically wrong sandbox app vs. prod app). If `400 invalid_product`, the IAP wasn't `recovery_plus_one_time`. If `400 receipt_verification_failed`, the JWS signature didn't validate — typically a sandbox/prod env mismatch.

---

## 5. Common failure modes

### Apple receipt verification fails

Symptom: `POST /v1/recovery/plus/purchase` returns `400 receipt_verification_failed`.

Causes & fixes:

1. **Bundle ID mismatch.** The JWS payload's `bundleId` doesn't match `config.APPLE_BUNDLE_ID`. Confirm `fly secrets get APPLE_APP_BUNDLE_ID` matches the value baked into the iOS build.
2. **Sandbox/prod env mismatch.** A sandbox JWS into a `APPLE_STOREKIT_ENV=production` deploy (or vice versa) fails signature validation. The `SignedDataVerifier` is per-env. Flip the env var and restart.
3. **Expired Apple root certs.** The certs in `certs/AppleIncRootCertificate.cer` + `AppleRootCA-G2.cer` + `AppleRootCA-G3.cer` are baked into the image. If Apple rotates a root (rare; multi-year cadence), re-fetch from `https://www.apple.com/certificateauthority/` and rebuild.
4. **`originalTransactionId` empty.** StoreKit 1 fallback edge case. Service falls back to `transactionId` and emits `recovery_shield.plus_purchased` with `result='missing_original_transaction_id'`. Monitor the metric — if it climbs above zero, escalate (Apple's docs do not document when this happens).

### Chain RPC 429 / rate limit

Symptom: `POST /v1/recovery/trace/crypto/:case_id/hops` returns a case with `hops_analyzed=0` and `trace_report_jsonb.halt_reason='no_outbound_txs'` despite the destination wallet clearly having outbound activity.

Cause: per-chain rate limit (Etherscan free tier: 5 req/s, 100k/day). Bursty hop walks from many concurrent cases blow through it.

Fix: `safeChainFetch` swallows the error and logs via `captureError`. The trace_report records the partial graph. iOS surfaces "trace paused — retry" to the user. Upgrade the per-chain key tier OR add per-(user, case) hop walk rate-limit at the route layer. The current route-level limit is 5/min per user; tighten if a single user is launching many crypto cases.

### LLM unavailable

Symptom: `POST /v1/recovery/trace/wire/:case_id/letter`, `POST /v1/recovery/trace/crypto/:case_id/petition`, or `POST /v1/recovery/documents/generate` returns `502 trace_unavailable`.

Causes & fixes:

1. **`ANTHROPIC_API_KEY` missing or revoked.** `callLLM` throws `LLMUnavailableError('ANTHROPIC_API_KEY not configured')` or `LLMUnavailableError('http 401: ...')`. Confirm `fly secrets get ANTHROPIC_API_KEY`.
2. **Anthropic 5xx or timeout (30s default).** Transient. The route surfaces 502; iOS retries. Spike in `llm.call_failed{status=*}` metric signals systemic.
3. **Model output not valid JSON for legal-packet path.** `legalPacketLlmFn` parses the model's wrapper; non-JSON output throws and the per-doc try/catch in `generateLegalPacket` surfaces it. With 1/8 docs failing, the whole packet fails (v1 doesn't partial-settle; explicit design choice — `generateLegalPacket` comment).

### Specialist webhook fee fraud

Symptom: a referral has a suspiciously high `fee_owed_cents` (e.g., $99k on a $1k recovery).

Cause: there is **no specialist-side webhook for fee reporting** at v1. `reportSpecialistFee` requires `is_admin_actor=true`. If a fee landed via any other path, it's a bug — file an incident.

Fix: admin reviews the specialist's invoice manually + flips `fee_owed_cents` via direct DB write or a future admin route. The R-P6 dashboard `specialist-performance` panel surfaces aggregated fees per specialist; a Big-Red-Button operator confirm for values > $5k is the v2 add.

### Disclaimer not acknowledged

Symptom: `POST /v1/recovery/documents/generate` returns `400 disclaimer_not_acknowledged`.

Cause: client sent `user_acknowledged_disclaimer: false` or omitted it. iOS must surface the `LEGAL_PACKET_DISCLAIMER` modal first and only post `true` after the user taps "I understand."

Fix: client bug. The server defense is correct — `legalPacketGenerator` re-checks and the PDF download route refuses to serve when `user_acknowledged_disclaimer_at IS NULL`.

### Case state stuck at `tracing`

Symptom: a crypto case's `state` stays `tracing` and `exchange_tagged` stays NULL even after multiple `/hops` calls.

Cause: the hop walk exhausted `max_hops=5` (default) without hitting a tagged exchange. The destination address chain either (a) dead-ended (no outbound), (b) flowed into a non-tagged address (regional CEX outside the v1 corpus, or a DEX/bridge), or (c) is in a chain with a missing API key.

Fix: operator routes the case to a specialist for off-chain pursuit. The trace_report_jsonb has the partial graph; the petition generator still won't fire (`InvalidStateError` — state must be `exchange_identified`).

---

## 6. Retention model

| Table | Retention | Sweeper |
|---|---|---|
| `recovery_plus_purchases` | **Indefinite** (audit trail) | None — `refunded_at` flag preserved; the admin revenue + refund-rate dashboards depend on the row staying queryable |
| `wire_trace_cases` | Cascaded with parent `recovery_sessions` | FK CASCADE on `recovery_session_id` |
| `crypto_trace_cases` | Cascaded with parent `recovery_sessions` | FK CASCADE on `recovery_session_id` |
| `legal_documents` | Cascaded with parent `recovery_sessions` | FK CASCADE on `recovery_session_id` |
| `specialists` | **Indefinite** (admin-managed) | None — retired specialists set `status='retired'`; row stays for the referral-history join |
| `specialist_referrals` | **730 days** (cascaded from `recovery_sessions`) | `retentionSweeper.ts` plus FK CASCADE on session delete |

`recovery_plus_purchases` is deliberately exempt from the 90d retention sweep. The refund-rate metric (R-P6 panel 5) needs to bucket refunds within_24h / within_7d / after_7d, and `after_7d` only resolves meaningfully against an indefinite history. The trade-off: the table grows linearly with purchase count, which for a Plus product at $249 is small enough (a 10k purchases/year cadence = ~10MB/year including the receipt blob).

`specialists` is also exempt — retiring a specialist must not break the historical fee-paid ledger that the dashboard's specialist-performance panel queries.

---

## 7. Rate limits

Per-route, per-user, keyed via `userKeyedLimit` (matches Email Shield + Identity Shield).

| Route | Limit | Purpose |
|---|---|---|
| `POST /v1/recovery/plus/purchase` | 5/min | IAP retry-storm guard |
| `GET /v1/recovery/plus/status` | 60/min | iOS polling |
| `POST /v1/recovery/trace/wire` | 10/min | Case creation |
| `GET /v1/recovery/trace/wire/:id` | 60/min | iOS dashboard scroll |
| `POST /v1/recovery/trace/wire/:id/advance` | 30/min | State-machine churn |
| `POST /v1/recovery/trace/wire/:id/letter` | 5/min | **LLM cost defense** |
| `POST /v1/recovery/trace/crypto` | 10/min | Case creation |
| `GET /v1/recovery/trace/crypto/:id` | 60/min | iOS dashboard scroll |
| `POST /v1/recovery/trace/crypto/:id/hops` | 5/min | **Chain RPC cost defense** |
| `POST /v1/recovery/trace/crypto/:id/petition` | 5/min | **LLM cost defense** |
| `POST /v1/recovery/trace/crypto/:id/advance` | 30/min | State-machine churn |
| `POST /v1/recovery/documents/generate` | 5/min | **LLM cost defense (8 parallel LLM calls per request)** |
| `GET /v1/recovery/documents`, `/v1/recovery/documents/:id` | 60/min | iOS dashboard |
| `GET /v1/recovery/specialists`, `/v1/recovery/specialists/:id` | 60/min | Marketplace scroll |
| `POST /v1/recovery/specialists/refer` | 10/min | Referral creation |
| `GET /v1/recovery/referrals` | 60/min | iOS dashboard |

The LLM-heavy routes (5/min) are the cost-defense bottleneck. `documents/generate` fans out 8 LLM calls in parallel per request — a 5/min limit caps a single user at 40 LLM calls/min worst case.

The `userKeyedLimit` hook is `preHandler` so it runs AFTER `requireAppUser` populates `req.appUser` (adversarial-review item H1 from the broader app — `fastify-rate-limit` defaults to `onRequest`/IP-keyed, which would defeat the per-user quota).

---

## 8. Privacy posture

| What we store at rest | Where | Notes |
|---|---|---|
| Apple receipt blob | `recovery_plus_purchases.apple_receipt_data` | Plaintext base64; kept for re-verification on refund / chargeback / support |
| `apple_transaction_id` | `recovery_plus_purchases` | Plaintext; UNIQUE; primary replay-protection key |
| Wire destination account hint | `wire_trace_cases.destination_account_hint` | **Envelope-encrypted** `v1:<iv>:<tag>:<ct>` (last-4 + bank + amount + timing correlates to one account) |
| Dispute letter body | `wire_trace_cases.dispute_letter_text` | **Envelope-encrypted** |
| Bank response text | `wire_trace_cases.bank_response_text` | **Envelope-encrypted** |
| Exchange petition body | `crypto_trace_cases.petition_text` | **Envelope-encrypted** |
| Source / destination wallet | `crypto_trace_cases.{source_wallet,destination_wallet}` | Plaintext (on-chain public; no privacy gain from encrypting public addresses) |
| Trace hop graph | `crypto_trace_cases.trace_report_jsonb` | Plaintext (on-chain public) |
| Legal-doc body markdown | `legal_documents.body_markdown` | **Envelope-encrypted** AFTER `postProcessBody` (disclaimer prepend + digit-run redaction + injection-trigger redaction) |
| Specialist contact info | `specialists.{contact_email,contact_phone,bar_number}` | Plaintext — B2B marketplace-public records |
| Outcome notes | `specialist_referrals.outcome_notes` | Plaintext, admin-only; NEVER surfaced via user-facing route |

What we do NOT store: full SSN (`redactDigitRuns` reduces 9-16 digit runs to `***NNNN` before encryption), full account numbers (same regex), unencrypted dispute letters / petitions / legal-doc bodies.

**Disclaimer enforcement at the byte level.** `legalPacketGenerator.postProcessBody` runs three defense-in-depth passes before encryption: disclaimer prepend (`ensureDisclaimerHeader`), PII redaction (`redactDigitRuns`), and prompt-injection trigger redaction (`redactInjectionTriggers`). The wire-trace letter generator has its own `ensureDisclaimer` pass; the crypto-trace petition has its own `PETITION_DISCLAIMER` prepend. Each pillar enforces independently.

**No success fee.** Recovery Shield does NOT take a percentage of recovered funds. The $249 is paid up-front. There is no row in any table that tracks "recovered amount × percentage = AegisDial fee" — by design.

**Specialist referral fee NEVER from user.** `specialists.commission_pct` is between the user and the specialist. AegisDial does not act as a payment intermediary. `specialist_referrals.fee_owed_cents` and `fee_paid_at` are admin-only fields tracking what the SPECIALIST owes AegisDial (referral commission), not what the user owes. End users never see those columns — the iOS surface exposes `fee_owed_cents` and `fee_paid_at` only on the `GET /v1/recovery/referrals` list as a transparency disclosure (the user can see what they're being charged by the specialist), but the write path is admin-only.

Push notifications are not used by Recovery Shield (Pillars 1–3 are all foreground iOS workflows — no asynchronous events that need lock-screen surfacing). The push pipeline that Email Shield uses for tamper alerts does NOT apply here.

---

## 9. Operational guarantees (pinned by tests)

| Property | Pinned by |
|---|---|
| Full Recovery Plus happy path (purchase → wire → crypto → docs → referral → admin → refund) composes through real code | `test/recoveryShieldScenarioE2E.test.ts` (this file's `describe('Recovery Shield E2E — purchase → ... → refund')`) |
| Cross-user replay of an Apple transaction returns 409, NEVER entitles the wrong caller | `test/recoveryShieldScenarioE2E.test.ts` (cross-user replay case) AND `test/recoveryShieldRoutes.test.ts` (R-H3 cross-user replay case) |
| Apple S2S REFUND flips `refunded_at` and revokes entitlement immediately | `test/recoveryShieldScenarioE2E.test.ts` (Phase 13) AND `test/recoveryPlusEntitlement.test.ts` |
| Replayed `apple_transaction_id` returns the existing purchase row idempotently | `test/recoveryShieldRoutes.test.ts` (`POST /v1/recovery/plus/purchase` replay) |
| Wire-trace state machine rejects illegal transitions (intake → recalled etc.) | `test/wireTraceAgent.test.ts` |
| Wire-trace cross-user `case_id` returns 404, never leaks state | `test/wireTraceAgent.test.ts` (cross-user case) |
| Dispute letter envelope-encrypted at rest; disclaimer prepended even if LLM omits it | `test/wireTraceAgent.test.ts` AND scenario E2E Phase 5 |
| Crypto-trace hop walk halts on tagged exchange and persists `state=exchange_identified` | `test/cryptoTraceAgent.test.ts` AND scenario E2E Phase 8 |
| Crypto-trace post-trace `/hops` re-run on a `petition_drafted` case throws `InvalidStateError` (R-M2) | `test/cryptoTraceAgent.test.ts` |
| Petition generation refuses pre-`exchange_identified` states | `test/cryptoTraceAgent.test.ts` |
| `redactInjectionTriggers` neutralizes "IGNORE PREVIOUS INSTRUCTIONS" + 8 variants (R-M4) | `test/legalPacketGenerator.test.ts` |
| `redactDigitRuns` reduces 9–16-digit runs to last-4 before encryption | `test/legalPacketGenerator.test.ts` |
| Disclaimer header prepended to every generated legal-doc body | `test/legalPacketGenerator.test.ts` AND scenario E2E Phase 11 |
| `user_acknowledged_disclaimer: false` returns 400 before any LLM call | `test/recoveryShieldRoutes.test.ts` (`POST /v1/recovery/documents/generate` disclaimer case) |
| Specialist marketplace returns ONLY `status='active'` rows | `test/specialistMarketplace.test.ts` |
| `createReferral` rejects cross-user `recovery_session_id` (404) | `test/specialistMarketplace.test.ts` |
| `reportSpecialistFee` rejects `is_admin_actor=false` (UnauthorizedFeeReportError) | `test/specialistMarketplace.test.ts` |
| Admin routes 401 without bearer | `test/adminRecoveryShield.test.ts` |
| Admin routes are aggregate-only (no per-user PII) | `test/adminRecoveryShield.test.ts` (response-shape assertions) |
| Plus-gate fires on POST /trace/wire when entitlement is revoked mid-flow | `test/recoveryShieldScenarioE2E.test.ts` (Phase 13 blocked-wire case) |

---

## 10. Composite verdict — NOT APPLICABLE

Email Shield ends each compromise check with a composite verdict (`clean` / `concerns` / `compromised`) computed from five detectors. Recovery Shield does **not** classify; it is an intake + workflow + document-generation engine. There is no equivalent verdict.

The closest analogue is the wire-trace and crypto-trace state machines — but those are operator/user-driven (the user reports whether the bank acknowledged; the operator confirms whether the exchange froze funds), not algorithmically decided. A wire case in state `recalled` is a SUCCESS observation, not a verdict computed from signals.

---

## 11. Phase ledger

| Phase | Surface |
|---|---|
| R-P1 | Migrations 062–067 + row types in `src/services/recovery/types.ts` |
| R-P2 | `recoveryPlusEntitlement.ts` — Apple JWS verify, replay protection, refund webhook hook |
| R-P3a | `wireTraceAgent.ts` — state machine + bank-scaffold library + dispute-letter LLM |
| R-P3b | `cryptoTraceAgent.ts` — hop walking + exchange tagger + petition LLM |
| R-P3c | `legalPacketGenerator.ts` — 8-doc orchestrator + prompt-injection defenses + PII redaction |
| R-P4 | `specialistMarketplace.ts` — listing + referral lifecycle + fee ledger |
| R-P5 | `routes/recoveryShield.ts` — `/v1/recovery/*` route surface; `requireRecoveryPlus` preHandler factory |
| R-P6 | `routes/adminRecoveryShield.ts` — `/v1/admin/recovery-shield/*` dashboards |
| R-P7 | Adversarial review pass — closed HIGH+MED findings (R-H1 refund-webhook gate, R-H3 cross-user replay 409, R-M1 specialist `notes` omission, R-M2 hop-re-run state guard, R-M3 fixed-vocab metric tags, R-M4 prompt-injection defenses) |
| R-P8 | This runbook + `test/recoveryShieldScenarioE2E.test.ts` + commit |

All on branch `feat/live-shield-v4-phase0`. Identity Shield (I-P1 through I-P9) lands on the same branch in parallel.

---

## 12. Pending production work (NOT code-blocking, but ship-blocking)

| Item | Owner | Gate |
|---|---|---|
| Apple IAP product `recovery_plus_one_time` configured in App Store Connect at $249 USD non-consumable | iOS / App Store admin | Pre-launch hard gate |
| Specialists table seeded with 8–12 vetted partners | BD | Pre-launch soft gate (marketplace surfaces empty otherwise) |
| Legal review of `LEGAL_PACKET_DISCLAIMER` wording + per-doc-kind prompt scaffolds | External counsel | Pre-launch hard gate (placeholder text in code today) |
| Chain RPC API keys (Etherscan, BscScan, etc.) provisioned on Fly | DevOps | Per-chain soft gate (feature degrades, doesn't crash) |
| `ANTHROPIC_API_KEY` set in production Fly secrets | DevOps | Hard gate — LLM-driven routes return 502 otherwise |
| Specialist BD pipeline — onboarding flow, contract templates, fee-disclosure pages | BD + Legal | Pre-launch soft gate |
| Production-side Apple S2S notification webhook URL configured in App Store Connect → routes to `revokeOnRefund` | iOS + DevOps | Hard gate — without this, refunds do not revoke entitlement |
| Admin-side specialist CRUD UI (currently DB-only) | Engineering (v2) | Operational ease, not a launch blocker |
| Specialist webhook for self-reported case progression (currently admin-mediated) | Engineering (v2) | Conversion-funnel velocity, not a launch blocker |
| Cyber-insurance / homeowner's-claim `insurance_claim` doc kind (currently deferred-v2 in `legalPacketGenerator`) | Engineering (v2) | Surface-area expansion |
