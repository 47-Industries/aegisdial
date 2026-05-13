# Recovery Shield — Engineering Spec

**Strategy reference:** `RECOVERY_AND_IDENTITY_SHIELDS.md` (positioning, pricing, loop, fundraise frame).
**This doc:** phase-by-phase build plan, table schemas, file deliverables, test expectations.

Mirrors the Email Shield P1-P25 pattern: each phase is a coherent, commit-able slice with a clear test bar. Adversarial pass between phases as needed.

---

## Phase ledger

| Phase | Scope | Effort | Parallelizable? |
|---|---|---|---|
| **R-P1** | Migrations 062–067 + types | S | No (numbering sensitive) |
| **R-P2** | Recovery Plus entitlement service + Apple IAP verify | M | No (foundation) |
| **R-P3a** | Wire-trace agent | L | **Yes** (parallel with P3b, P3c) |
| **R-P3b** | Crypto-trace agent | L | **Yes** |
| **R-P3c** | Legal-packet generator | M | **Yes** |
| **R-P4** | Specialist marketplace + referral tracking | M | No (sequences after P1) |
| **R-P5** | `/v1/recovery/*` route surface (trace, documents, plus/purchase, specialists/refer) | M | No (wires P2+P3+P4) |
| **R-P6** | Admin dashboard `/v1/admin/recovery-shield/*` | M | **Yes** (with I-P6) |
| **R-P7** | Adversarial review pass | S | **Yes** (with I-P7) |
| **R-P8** | E2E scenario test + operator runbook + commit | M | No |

**Total: ~6 phases of build work + 2 phases of polish.** ~3–4 weeks single-engineer; ~2 weeks with 3-agent fan-out at P3.

---

## R-P1 — Migrations + types

Six new tables. Numbering reserved 062–067 (Identity Shield reserves 068–074).

### 062_recovery_plus_purchases.sql
```sql
CREATE TABLE recovery_plus_purchases (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recovery_session_id       UUID REFERENCES recovery_sessions(id),  -- nullable: pre-purchase unlock
  apple_transaction_id      TEXT NOT NULL UNIQUE,                   -- replay protection
  apple_receipt_data        TEXT NOT NULL,                          -- verified receipt blob
  purchase_amount_cents     INTEGER NOT NULL,                       -- $249 = 24900
  currency                  TEXT NOT NULL DEFAULT 'USD',
  purchased_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refunded_at               TIMESTAMPTZ                             -- Apple refunds reverse the entitlement
);
CREATE INDEX idx_recovery_plus_user ON recovery_plus_purchases(user_id, purchased_at DESC);
```

### 063_wire_trace_cases.sql
```sql
CREATE TABLE wire_trace_cases (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recovery_session_id       UUID NOT NULL REFERENCES recovery_sessions(id) ON DELETE CASCADE,
  source_bank               TEXT NOT NULL,            -- "Chase", "BofA", "Wells Fargo", ...
  destination_account_hint  TEXT,                     -- last-4 if user knows it (envelope-encrypted)
  wire_amount_cents         BIGINT NOT NULL,
  wire_sent_at              TIMESTAMPTZ NOT NULL,
  state                     TEXT NOT NULL CHECK (state IN
    ('intake','letter_drafted','user_sent','bank_acknowledged','recalled','denied','closed')),
  dispute_letter_text       TEXT,                     -- envelope-encrypted
  bank_response_text        TEXT,                     -- envelope-encrypted
  state_changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_wire_trace_user ON wire_trace_cases(user_id, created_at DESC);
CREATE INDEX idx_wire_trace_session ON wire_trace_cases(recovery_session_id);
```

### 064_crypto_trace_cases.sql
```sql
CREATE TABLE crypto_trace_cases (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recovery_session_id       UUID NOT NULL REFERENCES recovery_sessions(id) ON DELETE CASCADE,
  source_wallet             TEXT NOT NULL,            -- victim's wallet (consented sharing)
  destination_wallet        TEXT NOT NULL,            -- scammer's wallet
  chain                     TEXT NOT NULL CHECK (chain IN
    ('ethereum','bitcoin','tron','polygon','bsc','solana','arbitrum','optimism','base')),
  amount_native             TEXT NOT NULL,            -- string-encoded to avoid float loss
  amount_usd_cents_at_send  BIGINT NOT NULL,
  hops_analyzed             INTEGER NOT NULL DEFAULT 0,
  exchange_tagged           TEXT,                     -- "Binance Hot Wallet", "Coinbase Custody", null
  trace_report_jsonb        JSONB,                    -- full hop graph, exchange interactions
  state                     TEXT NOT NULL CHECK (state IN
    ('intake','tracing','exchange_identified','petition_drafted','user_sent','exchange_acked','frozen','denied','closed')),
  petition_text             TEXT,                     -- envelope-encrypted
  state_changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_crypto_trace_user ON crypto_trace_cases(user_id, created_at DESC);
CREATE INDEX idx_crypto_trace_session ON crypto_trace_cases(recovery_session_id);
```

### 065_legal_documents.sql
```sql
CREATE TABLE legal_documents (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recovery_session_id       UUID NOT NULL REFERENCES recovery_sessions(id) ON DELETE CASCADE,
  doc_kind                  TEXT NOT NULL CHECK (doc_kind IN
    ('ic3_complaint','ftc_complaint','cfpb_complaint','state_ag_complaint',
     'affidavit','demand_letter','credit_freeze_request','police_report_draft',
     'exchange_petition','insurance_claim')),
  state_jurisdiction        TEXT,                     -- ISO-3166-2 (e.g., 'US-FL') when doc_kind is state-AG
  body_markdown             TEXT NOT NULL,            -- envelope-encrypted, generated content
  pdf_url                   TEXT,                     -- S3 pre-signed URL (nullable until rendered)
  generated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_acknowledged_disclaimer_at TIMESTAMPTZ        -- legal-advice disclaimer accepted timestamp
);
CREATE INDEX idx_legal_docs_user ON legal_documents(user_id, generated_at DESC);
CREATE INDEX idx_legal_docs_session ON legal_documents(recovery_session_id);
```

### 066_specialists.sql
```sql
CREATE TABLE specialists (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name              TEXT NOT NULL,
  category                  TEXT NOT NULL CHECK (category IN
    ('asset_recovery_attorney','blockchain_forensics','identity_restoration',
     'cyber_insurance_consult','tax_professional_loss_writeoff')),
  jurisdictions             TEXT[] NOT NULL,          -- ISO-3166-2 codes
  capabilities              TEXT[] NOT NULL,          -- 'crypto', 'wire_recall', 'ssn_compromise', ...
  commission_pct            NUMERIC(4,2) NOT NULL,    -- 10.00 = 10%
  contact_email             TEXT NOT NULL,            -- their legal/intake email
  contact_phone             TEXT,
  bar_number                TEXT,                     -- for attorneys; verification artifact
  status                    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','active','suspended','retired')),
  vetted_at                 TIMESTAMPTZ,
  vetted_by                 UUID REFERENCES users(id),
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_specialists_active ON specialists(category) WHERE status = 'active';
```

### 067_specialist_referrals.sql
```sql
CREATE TABLE specialist_referrals (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  specialist_id             UUID NOT NULL REFERENCES specialists(id),
  recovery_session_id       UUID NOT NULL REFERENCES recovery_sessions(id) ON DELETE CASCADE,
  referred_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  specialist_acknowledged_at TIMESTAMPTZ,
  engagement_status         TEXT NOT NULL DEFAULT 'referred' CHECK (engagement_status IN
    ('referred','specialist_contacted_user','user_engaged','case_active','case_closed_won','case_closed_lost','user_declined')),
  fee_owed_cents            BIGINT,                   -- populated when specialist reports outcome
  fee_paid_at               TIMESTAMPTZ,
  outcome_notes             TEXT
);
CREATE INDEX idx_referrals_user ON specialist_referrals(user_id, referred_at DESC);
CREATE INDEX idx_referrals_specialist ON specialist_referrals(specialist_id, referred_at DESC);
CREATE INDEX idx_referrals_session ON specialist_referrals(recovery_session_id);
```

### Types file
`src/services/recovery/types.ts` — exports TS interfaces matching each table.

**Test bar for R-P1:** migrations apply cleanly (idempotent re-run = no-op); CHECK constraints validated; FK cascades exercised.

---

## R-P2 — Recovery Plus entitlement service

`src/services/recovery/recoveryPlusEntitlement.ts`:

```ts
export async function purchaseRecoveryPlus(
  userId: string,
  appleReceipt: string,
  sessionId?: string
): Promise<{ purchase_id: string; entitled: true }>;

export async function hasRecoveryPlus(userId: string, sessionId: string): Promise<boolean>;

export async function revokeOnRefund(appleTransactionId: string): Promise<void>;
```

Verifies the receipt via Apple's `verifyReceipt` endpoint (sandbox + production fallback). Stores transaction id with UNIQUE constraint for replay protection. iOS calls `/v1/recovery/plus/purchase` after a successful StoreKit purchase; backend verifies + writes the row + flips entitlement.

Entitlement model: **per-recovery-session.** A user who buys Recovery Plus for one case doesn't get it free for the next — keeps pricing honest (each scam is its own incident). `purchaseRecoveryPlus(userId, receipt, sessionId)` binds the unlock to that session; subsequent purchases for new sessions are normal.

**Test bar:** receipt-replay rejected; refunded purchases lose entitlement; cross-user purchase attempts 401.

---

## R-P3a — Wire-trace agent (PARALLEL with P3b, P3c)

`src/services/recovery/wireTraceAgent.ts` — multi-turn LLM agent with state machine.

**Flow:**
1. Intake: source bank + destination hint + amount + send-time.
2. LLM drafts the dispute letter using bank-specific template (top 8 US banks have written templates in `src/data/wireDisputeTemplates.ts`).
3. User reviews → backend stores ciphertext.
4. iOS shows "Mail this to bank fraud line" with bank-specific contact details.
5. User reports bank ack/denial; state advances.

**Bank-specific knowledge:** Chase requires Reg-E language; Wells Fargo prefers SWIFT message format; BofA accepts email + form; etc. Codify in `wireDisputeTemplates.ts`.

**Test bar:** state-machine transitions covered; bank-specific template selection works; ciphertext round-trips; cross-user wire-case access 404s.

---

## R-P3b — Crypto-trace agent (PARALLEL)

`src/services/recovery/cryptoTraceAgent.ts` — chain analysis + exchange tagging.

**Chains supported v1:** Ethereum, Bitcoin, Tron, Polygon, BSC, Solana, Arbitrum, Optimism, Base. ~95% of retail-victim coverage.

**Hop analysis:**
- Pull tx history from chain RPC (Etherscan / Blockchair API).
- Walk forward N=5 hops from destination_wallet.
- At each hop, check against the exchange-deposit-address corpus (Arkham Intel API or maintained mapping).
- When a hop lands on a tagged exchange, halt — generate the petition.

**Exchange petition:** LLM-generated freeze-of-funds petition addressed to that exchange's legal department. Includes the trace JSON, dollar value at send, on-chain proof, AegisDial case ID. Petition is a starting point — user typically routes through their attorney from the specialist marketplace.

**Test bar:** mock chain RPC; exchange-tag corpus reads correctly; petition generation produces well-formed letter; cross-user crypto-case access 404s.

---

## R-P3c — Legal-packet generator (PARALLEL)

`src/services/recovery/legalPacketGenerator.ts` — multi-doc orchestrator.

For each recovery session, generates the full packet on Recovery-Plus purchase:
- IC3 complaint
- FTC complaint
- CFPB complaint (if bank-side failure)
- State AG complaint (50-state form library at `src/data/stateAgComplaintForms.ts`)
- Affidavit template (for insurance)
- Demand letter (if recoverable entity exists)
- Credit-freeze + fraud-alert request letters

LLM stitches the user's case details into each template. **Strict disclaimer at top of every doc:** "AegisDial is not your attorney. This document is a starting template; consult a licensed attorney before filing or sending." Disclaimer acknowledgement is logged in the table.

**Test bar:** all 7+ doc kinds generate; disclaimer present in every output; placeholder substitution works for state-specific docs.

---

## R-P4 — Specialist marketplace + referral tracking

`src/services/recovery/specialistMarketplace.ts`:
- `listSpecialistsFor(category, jurisdiction, capabilities): Specialist[]`
- `createReferral(userId, specialistId, sessionId): SpecialistReferral`
- `updateReferralStatus(referralId, status, outcomeNotes): void` (admin-only or specialist-webhook)
- `reportFee(referralId, feeOwedCents): void` (admin or specialist API)

Webhook endpoint for specialists to self-report case progression (so we can track referral conversion + fee owed). Eventually self-serve specialist portal at v2; v1 is admin-mediated.

**Test bar:** referral creates correctly; cross-user referral access 404s; fee tracking accurate; admin can flip status.

---

## R-P5 — Routes

`src/routes/recoveryShield.ts` (new — separate from existing `recovery.ts`):

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/recovery/plus/purchase` | Pro | Verify Apple receipt, write `recovery_plus_purchases`, return entitlement |
| `GET  /v1/recovery/plus/status?session_id=...` | Pro | Returns whether session is unlocked |
| `POST /v1/recovery/trace/wire` | Pro+Plus | Start/advance wire-trace case |
| `GET  /v1/recovery/trace/wire/:id` | Pro+Plus | Read state |
| `POST /v1/recovery/trace/crypto` | Pro+Plus | Start/advance crypto-trace case |
| `GET  /v1/recovery/trace/crypto/:id` | Pro+Plus | Read state |
| `POST /v1/recovery/documents/generate` | Pro+Plus | Generate full legal packet |
| `GET  /v1/recovery/documents` | Pro | List user's generated docs |
| `GET  /v1/recovery/documents/:id/pdf` | Pro | Download PDF |
| `GET  /v1/recovery/specialists` | Pro+Plus | Marketplace listing (filterable) |
| `POST /v1/recovery/specialists/refer` | Pro+Plus | Create referral, fires email to specialist |

`requireRecoveryPlus` middleware checks the entitlement via `hasRecoveryPlus(userId, sessionId)`.

**Test bar:** every route 401s without auth, 402s without Pro, 403s without Plus when required, 404s on cross-user IDs.

---

## R-P6 — Admin dashboard

`src/routes/adminRecoveryShield.ts` — bearer-auth, aggregate metrics:
- `GET /v1/admin/recovery-shield/summary` — open cases by type, conversion %, revenue
- `GET /v1/admin/recovery-shield/cases-timeline` — daily case-open counts 30d
- `GET /v1/admin/recovery-shield/specialist-performance` — referral conversion + fees owed per specialist
- `GET /v1/admin/recovery-shield/document-quality` — generated-doc count + LLM-eval scores

**Test bar:** all routes 401 without bearer; aggregate-only (no per-user PII); time-bounded queries.

---

## R-P7 — Adversarial review

Spawn a verification agent reading every R-P file, looking for:
- Cross-user data leakage in trace cases
- Receipt-replay or refund-reversal bugs
- LLM-prompt-injection through user-supplied case fields
- PII in generated documents (full SSN, full account numbers — must be redacted server-side before storage)
- Specialist-fee fraud surface (can a malicious specialist self-report a $999 referral fee?)
- Disclaimer-acceptance enforcement (can a user download a legal doc without acknowledging?)

---

## R-P8 — E2E test + runbook + commit

`test/recoveryShieldScenarioE2E.test.ts`: scam reported → Pro user opens recovery → buys Plus → wire-trace + crypto-trace + legal packet generate → specialist referred → admin dashboard reflects it → fee paid.

`docs/RECOVERY_SHIELD_OPERATOR_RUNBOOK.md`: env vars (Apple shared-secret for receipt verify, Etherscan/Blockchair API keys, Arkham API key), Apple IAP product config, specialist onboarding workflow, retention model.

Commit: "Recovery Shield R-P1 through R-P8 — Pro-tier post-incident trace + document + refer engine".

---

## Open / blocked

- **Specialist sourcing.** R-P4 launches with 8-12 vetted specialists; BD work happens in parallel with engineering. NOT a code blocker — table is empty at first commit, admin populates it.
- **Apple IAP product configuration.** Setup happens in App Store Connect; engineering needs the product_id at R-P2 commit time. Use `recovery_plus_one_time` as the agreed identifier.
- **Legal review of generated docs.** Counsel sign-off on disclaimer language is a hard gate for prod cutover, not commit.
