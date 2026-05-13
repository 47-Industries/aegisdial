// Recovery Shield — row types for migrations 062–067.
//
// One interface per row in the six R-P1 tables. These are the
// raw-row shapes as returned by pg's node driver (column names match
// the SQL exactly; JSONB columns surface as `unknown` until validated
// by the service layer; envelope-encrypted ciphertext columns surface
// as `string` with the `_ct` suffix called out in the comment).
//
// API-boundary DTOs live alongside the route handlers in
// src/routes/recoveryShield.ts (P5); those DTOs translate from these
// row types and apply the redaction / decryption / camel-case
// transforms before responding to the client.
//
// INVARIANTS the service layer guarantees:
//   - All `*_text` ciphertext columns are v1:<iv>:<tag>:<ct> envelope
//     ciphertext (the format documented in src/lib/crypto.ts).
//     Decrypt via decryptEnvelope() before surfacing to the user.
//   - amount_native on CryptoTraceCaseRow is a decimal string in the
//     chain's base unit (wei / satoshi / lamports). Convert at the
//     API boundary; never compare as Number.
//   - state / engagement_status / status / doc_kind / category / chain
//     enums match the CHECK-constraint vocabulary in the migration
//     verbatim. Add an entry → migrate the CHECK too.
//   - jurisdictions / capabilities on SpecialistRow are TEXT[] in
//     Postgres; pg returns them as string[] via the default parser.

/**
 * Row in `recovery_plus_purchases` (migration 062).
 *
 * One row per successful Recovery Plus IAP purchase. apple_transaction_id
 * is UNIQUE — the primary replay-protection mechanism. refunded_at is
 * set by the Apple server-to-server refund webhook; the entitlement
 * check (hasRecoveryPlus) filters WHERE refunded_at IS NULL.
 */
export interface RecoveryPlusPurchaseRow {
  id: string;
  user_id: string;
  /**
   * Nullable for the pre-purchase unlock flow — iOS may surface Plus
   * before the recovery session exists. Route layer binds it once
   * the session is created. NOT cascade-deleted on session delete.
   */
  recovery_session_id: string | null;
  /** Apple original_transaction_id. UNIQUE. */
  apple_transaction_id: string;
  /** Full verified receipt blob (base64). Kept for re-verification on refund / chargeback / support. */
  apple_receipt_data: string;
  /** Denormalized from receipt — $249 = 24900. INTEGER cents. */
  purchase_amount_cents: number;
  currency: string;
  purchased_at: Date;
  /** Set by the Apple refund webhook. Row is kept; entitlement check filters. */
  refunded_at: Date | null;
}

/**
 * Row in `wire_trace_cases` (migration 063).
 *
 * State machine row. dispute_letter_text and bank_response_text are
 * envelope-encrypted ciphertext; destination_account_hint is too
 * (last-4 + bank + amount + timing correlates to one account).
 *
 * State transitions:
 *   intake → letter_drafted → user_sent → bank_acknowledged → recalled
 *                                                            → denied
 *                                                            → closed
 * Enforce in wireTraceAgent.ts; the CHECK only pins the vocabulary.
 */
export interface WireTraceCaseRow {
  id: string;
  user_id: string;
  recovery_session_id: string;
  source_bank: string;
  /**
   * Envelope-encrypted last-4 of destination account. Decrypt via
   * decryptEnvelope() before surfacing.
   */
  destination_account_hint: string | null;
  /** BIGINT cents — pg's bigint comes back as string by default; recovery layer parses. */
  wire_amount_cents: string;
  wire_sent_at: Date;
  state:
    | 'intake'
    | 'letter_drafted'
    | 'user_sent'
    | 'bank_acknowledged'
    | 'recalled'
    | 'denied'
    | 'closed';
  /** Envelope-encrypted dispute letter body. v1:<iv>:<tag>:<ct>. */
  dispute_letter_text: string | null;
  /** Envelope-encrypted bank response. v1:<iv>:<tag>:<ct>. */
  bank_response_text: string | null;
  state_changed_at: Date;
  created_at: Date;
}

/**
 * Row in `crypto_trace_cases` (migration 064).
 *
 * On-chain trace state machine. petition_text is envelope-encrypted;
 * source_wallet / destination_wallet / amount_native / trace_report_jsonb
 * are plaintext (all on-chain public data).
 *
 * amount_native is a decimal STRING in the chain's base unit
 * (wei / satoshi / lamports) — converted at the API boundary to
 * avoid float-precision loss on the JS bridge.
 */
export interface CryptoTraceCaseRow {
  id: string;
  user_id: string;
  recovery_session_id: string;
  source_wallet: string;
  destination_wallet: string;
  chain:
    | 'ethereum'
    | 'bitcoin'
    | 'tron'
    | 'polygon'
    | 'bsc'
    | 'solana'
    | 'arbitrum'
    | 'optimism'
    | 'base';
  /** Decimal string in chain base unit. NEVER parse as Number. */
  amount_native: string;
  /** BIGINT cents; pg surfaces bigint as string. */
  amount_usd_cents_at_send: string;
  hops_analyzed: number;
  /** e.g. "Binance Hot Wallet". NULL if the trace exhausted max_hops without a tag. */
  exchange_tagged: string | null;
  /**
   * Full hop graph + exchange interactions. Plaintext. Versioned shape:
   *   { hops: [{from,to,value,tx_hash,timestamp}],
   *     exchange_hits: [{hop_index,exchange,deposit_addr}],
   *     analyzed_at, chain_rpc_provider }
   * Surfaces as `unknown` here; the service layer Zod-validates.
   */
  trace_report_jsonb: unknown;
  state:
    | 'intake'
    | 'tracing'
    | 'exchange_identified'
    | 'petition_drafted'
    | 'user_sent'
    | 'exchange_acked'
    | 'frozen'
    | 'denied'
    | 'closed';
  /** Envelope-encrypted freeze petition. v1:<iv>:<tag>:<ct>. */
  petition_text: string | null;
  state_changed_at: Date;
  created_at: Date;
}

/**
 * Row in `legal_documents` (migration 065).
 *
 * Generated legal-packet document. body_markdown is envelope-encrypted;
 * full SSN / full account numbers MUST be redacted by the generator
 * BEFORE encryption (per adversarial-review item D).
 *
 * PDF download route refuses to serve when user_acknowledged_disclaimer_at
 * is NULL — enforces the not-your-attorney disclaimer at the byte level.
 */
export interface LegalDocumentRow {
  id: string;
  user_id: string;
  recovery_session_id: string;
  doc_kind:
    | 'ic3_complaint'
    | 'ftc_complaint'
    | 'cfpb_complaint'
    | 'state_ag_complaint'
    | 'affidavit'
    | 'demand_letter'
    | 'credit_freeze_request'
    | 'police_report_draft'
    | 'exchange_petition'
    | 'insurance_claim';
  /** ISO-3166-2 (e.g., 'US-FL'). NULL for federal / non-jurisdictional. */
  state_jurisdiction: string | null;
  /** Envelope-encrypted markdown body. v1:<iv>:<tag>:<ct>. */
  body_markdown: string;
  /** S3 pre-signed URL cache. Re-signed on every download request. */
  pdf_url: string | null;
  generated_at: Date;
  /**
   * Set when the user taps "I understand" on the disclaimer modal.
   * PDF download refuses to serve when this is NULL.
   */
  user_acknowledged_disclaimer_at: Date | null;
}

/**
 * Row in `specialists` (migration 066).
 *
 * Vetted marketplace specialist. SHARED across users — NOT cascade-
 * deleted on user delete. vetted_by FK to admin user is ON DELETE
 * SET NULL — losing the admin doesn't lose the specialist record.
 *
 * status='pending' on INSERT until an admin promotes to 'active';
 * the marketplace query filters WHERE status = 'active'.
 */
export interface SpecialistRow {
  id: string;
  display_name: string;
  category:
    | 'asset_recovery_attorney'
    | 'blockchain_forensics'
    | 'identity_restoration'
    | 'cyber_insurance_consult'
    | 'tax_professional_loss_writeoff';
  /** ISO-3166-2 codes. pg surfaces TEXT[] as string[]. */
  jurisdictions: string[];
  /**
   * Free-text capability tags. Controlled vocabulary lives in admin
   * docs (crypto, wire_recall, ssn_compromise, gmail_takeover,
   * apple_id_takeover, …); NOT CHECK-constrained.
   */
  capabilities: string[];
  /** NUMERIC(4,2). pg surfaces as string by default. 10.00 = 10%. */
  commission_pct: string;
  /** Specialist's intake email. NOT UNIQUE (firms share inboxes). */
  contact_email: string;
  contact_phone: string | null;
  /** Required for asset_recovery_attorney; nullable for other categories. */
  bar_number: string | null;
  status: 'pending' | 'active' | 'suspended' | 'retired';
  vetted_at: Date | null;
  /** Admin user who approved. ON DELETE SET NULL on the users FK. */
  vetted_by: string | null;
  notes: string | null;
  created_at: Date;
}

/**
 * Row in `specialist_referrals` (migration 067).
 *
 * Referral + fee-ledger record. specialist_id is NOT cascade-deleted
 * (retiring a specialist must not wipe historic fee records).
 * user_id is denormalized from the parent recovery_session for
 * belt-and-suspenders authZ scoping.
 */
export interface SpecialistReferralRow {
  id: string;
  user_id: string;
  specialist_id: string;
  recovery_session_id: string;
  referred_at: Date;
  /** Set when the specialist's intake webhook fires (or admin marks). */
  specialist_acknowledged_at: Date | null;
  engagement_status:
    | 'referred'
    | 'specialist_contacted_user'
    | 'user_engaged'
    | 'case_active'
    | 'case_closed_won'
    | 'case_closed_lost'
    | 'user_declined';
  /** BIGINT cents; pg surfaces as string. NULL until specialist self-reports. */
  fee_owed_cents: string | null;
  fee_paid_at: Date | null;
  /** Admin-only commentary. Never surfaced in user-facing routes. */
  outcome_notes: string | null;
}
