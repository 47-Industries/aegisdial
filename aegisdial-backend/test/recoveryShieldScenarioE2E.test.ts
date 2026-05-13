import { describe, it, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

// Recovery Shield — end-to-end scenario test (R-P8 ship-readiness).
//
// Walks the FULL Recovery Plus happy path through real code paths,
// stubbing only at the boundary layers. Mirrors the structure of
// emailShieldScenarioE2E.test.ts.
//
// SCENARIO:
//   1. Pro user (no Plus yet) sits on a recovery session.
//   2. User buys Recovery Plus via POST /v1/recovery/plus/purchase.
//   3. Plus entitlement gate now returns true for that session.
//   4. User starts a wire-trace case via /v1/recovery/trace/wire.
//   5. LLM generates a bank-specific dispute letter — disclaimer
//      pinned, envelope-encrypted at rest, decrypted on the route
//      response.
//   6. Operator walks the wire case through the full state machine:
//      intake → letter_drafted → user_sent → bank_acknowledged → recalled.
//   7. User opens a SECOND case — crypto-trace — on the SAME session
//      (the entitlement is per-session, not per-case; both belong to
//      this incident).
//   8. Hop walk reaches exchange_identified on hop 1 (the tagger fixture
//      flags the destination directly).
//   9. Exchange petition generated against the tagged exchange.
//  10. User browses /v1/recovery/specialists, picks one (active +
//      asset_recovery_attorney + jurisdiction match), creates a referral.
//  11. User generates the 7-doc legal packet (disclaimer ack=true). The
//      packet skips two kinds by design (exchange_petition belongs to
//      the crypto agent; insurance_claim is v2-deferred). The CFPB
//      doc generates because the scam_type contains a CFPB-qualifying
//      substring; the demand_letter generates because scam_actor_contact
//      is supplied. Net: 7 generated, 2 skipped (exchange_petition +
//      insurance_claim aren't in the default 8-doc packet anyway).
//  12. Admin /v1/admin/recovery-shield/summary reflects the lot:
//      1 unrefunded purchase, 1 wire case in `recalled`, 1 crypto case in
//      `exchange_identified` (we deliberately stop short of `petition_drafted`
//      so the petition-state transition is observable in the summary —
//      actually we DO drive it to `petition_drafted` because the
//      petition route flips it; we assert on the resulting bucket),
//      7 legal docs, 1 referral.
//  13. Apple S2S REFUND notification arrives → revokeOnRefund flips
//      refunded_at → hasRecoveryPlus returns false → a fresh
//      /v1/recovery/trace/wire attempt for a NEW case returns 402
//      recovery_plus_required.
//
// WHAT'S STUBBED:
//   - DB pool — in-memory tables (7 surfaces: recovery_plus_purchases,
//     wire_trace_cases, crypto_trace_cases, legal_documents,
//     specialists, specialist_referrals, recovery_sessions, plus the
//     read-side admin aggregation queries on those same tables).
//   - Apple JWS — SignedDataVerifier.prototype.verifyAndDecodeTransaction
//     swap; same idiom recoveryShieldRoutes.test.ts uses.
//   - LLM — globalThis.fetch stub for the Anthropic Messages API.
//     Returns text-mode for wire-letter / petition prompts, JSON-mode
//     for legalPacketGenerator prompts (they ask the model for
//     `{ body_markdown }`).
//   - Chain RPC — chainFetchFn injected directly into runTraceHops via
//     the test's intermediate call (we hit the agent rather than the
//     route for the hop step because the route doesn't take the
//     injection seam — the test calls into the service for hops to
//     pin the tagger fixture without piping it through a real provider).
//   - Exchange tagger — same seam; default would have to be a
//     hard-coded Etherscan address, so we inject a known hit.
//
// WHAT'S NOT STUBBED:
//   - recoveryPlusEntitlement (purchase + replay + revoke).
//   - wireTraceAgent (state machine + LLM dispatch + ensureDisclaimer).
//   - cryptoTraceAgent (hop walking + petition LLM + state machine).
//   - legalPacketGenerator (the full multi-doc orchestrator including
//     redactInjectionTriggers + disclaimer prepend + Promise.all
//     fan-out across 8 doc kinds).
//   - specialistMarketplace (listSpecialistsFor + createReferral).
//   - All route registration via real Fastify app.inject().
//   - Admin route + bearer-auth via requireBearer + withAdminAudit.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-recovery-shield-e2e';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://recovery-shield-e2e';
process.env.APPLE_BUNDLE_ID ||= 'com.aegisdial.app';
process.env.APPLE_STOREKIT_ENV ||= 'sandbox';
process.env.ANTHROPIC_API_KEY ||= 'sk-ant-test-recovery-shield-e2e';
process.env.ALLOW_DEV_BEARER = 'true';

const Fastify = (await import('fastify')).default;
const fastifyRateLimit = (await import('@fastify/rate-limit')).default;
const db = await import('../src/lib/db.ts');
const crypto = await import('../src/lib/crypto.ts');
const appleSdk = await import('@apple/app-store-server-library');
const { recoveryShieldRoutes } = await import('../src/routes/recoveryShield.ts');
const { adminRecoveryShieldRoutes } = await import(
  '../src/routes/adminRecoveryShield.ts'
);
const cryptoAgent = await import('../src/services/recovery/cryptoTraceAgent.ts');
const entitlement = await import('../src/services/recovery/recoveryPlusEntitlement.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;
const PRO_BEARER = `Bearer ${SHARED_SECRET}`;
const ADMIN_BEARER = `Bearer ${SHARED_SECRET}`;
const USER_ID = '00000000-0000-0000-0000-000000000000';
const OTHER_USER_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NEW_SESSION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SPECIALIST_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ----------------------------------------------------------------
// In-memory tables
// ----------------------------------------------------------------

interface FakePlusPurchase {
  id: string;
  user_id: string;
  recovery_session_id: string | null;
  apple_transaction_id: string;
  apple_receipt_data: string;
  purchase_amount_cents: number;
  currency: string;
  purchased_at: Date;
  refunded_at: Date | null;
}

interface FakeWireCase {
  id: string;
  user_id: string;
  recovery_session_id: string;
  source_bank: string;
  destination_account_hint: string | null;
  wire_amount_cents: bigint;
  wire_sent_at: Date;
  state:
    | 'intake'
    | 'letter_drafted'
    | 'user_sent'
    | 'bank_acknowledged'
    | 'recalled'
    | 'denied'
    | 'closed';
  dispute_letter_text: string | null;
  bank_response_text: string | null;
  state_changed_at: Date;
  created_at: Date;
}

interface FakeCryptoCase {
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
  petition_text: string | null;
  state_changed_at: Date;
  created_at: Date;
}

interface FakeLegalDocument {
  id: string;
  user_id: string;
  recovery_session_id: string;
  doc_kind: string;
  state_jurisdiction: string | null;
  body_markdown: string;
  pdf_url: string | null;
  generated_at: Date;
  user_acknowledged_disclaimer_at: Date | null;
}

interface FakeSpecialist {
  id: string;
  display_name: string;
  category: string;
  jurisdictions: string[];
  capabilities: string[];
  commission_pct: string;
  contact_email: string;
  contact_phone: string | null;
  bar_number: string | null;
  status: 'pending' | 'active' | 'suspended' | 'retired';
  vetted_at: Date | null;
  vetted_by: string | null;
  notes: string | null;
  created_at: Date;
}

interface FakeReferral {
  id: string;
  user_id: string;
  specialist_id: string;
  recovery_session_id: string;
  referred_at: Date;
  specialist_acknowledged_at: Date | null;
  engagement_status:
    | 'referred'
    | 'specialist_contacted_user'
    | 'user_engaged'
    | 'case_active'
    | 'case_closed_won'
    | 'case_closed_lost'
    | 'user_declined';
  fee_owed_cents: string | null;
  fee_paid_at: Date | null;
  outcome_notes: string | null;
}

interface FakeSession {
  id: string;
  user_id: string;
}

let fakePurchases: FakePlusPurchase[] = [];
let fakeWireCases: FakeWireCase[] = [];
let fakeCryptoCases: FakeCryptoCase[] = [];
let fakeLegalDocs: FakeLegalDocument[] = [];
let fakeSpecialists: FakeSpecialist[] = [];
let fakeReferrals: FakeReferral[] = [];
let fakeSessions: FakeSession[] = [];
let nextPurchaseSeq = 1;
let nextWireSeq = 1;
let nextCryptoSeq = 1;
let nextDocSeq = 1;
let nextReferralSeq = 1;

// ----------------------------------------------------------------
// SQL router
// ----------------------------------------------------------------

function specialistRowOut(s: FakeSpecialist): Record<string, unknown> {
  return {
    id: s.id,
    display_name: s.display_name,
    category: s.category,
    jurisdictions: s.jurisdictions,
    capabilities: s.capabilities,
    commission_pct: s.commission_pct,
    contact_email: s.contact_email,
    contact_phone: s.contact_phone,
    bar_number: s.bar_number,
    status: s.status,
    vetted_at: s.vetted_at,
    vetted_by: s.vetted_by,
    notes: s.notes,
    created_at: s.created_at,
  };
}

function referralRowOut(r: FakeReferral): Record<string, unknown> {
  return {
    id: r.id,
    user_id: r.user_id,
    specialist_id: r.specialist_id,
    recovery_session_id: r.recovery_session_id,
    referred_at: r.referred_at,
    specialist_acknowledged_at: r.specialist_acknowledged_at,
    engagement_status: r.engagement_status,
    fee_owed_cents: r.fee_owed_cents,
    fee_paid_at: r.fee_paid_at,
    outcome_notes: r.outcome_notes,
  };
}

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const trimmed = text.trim().replace(/\s+/g, ' ');

  // metric_counters UPSERT — swallow.
  if (/^INSERT INTO metric_counters/i.test(trimmed)) {
    return { rows: [], rowCount: 1 };
  }

  // ====== recovery_plus_purchases ======

  if (/^INSERT INTO recovery_plus_purchases/i.test(trimmed)) {
    const [
      user_id,
      recovery_session_id,
      apple_transaction_id,
      apple_receipt_data,
      purchase_amount_cents,
      currency,
    ] = params as [string, string | null, string, string, number, string];
    if (fakePurchases.some((p) => p.apple_transaction_id === apple_transaction_id)) {
      return { rows: [], rowCount: 0 };
    }
    const row: FakePlusPurchase = {
      id: `pur-${nextPurchaseSeq++}`,
      user_id,
      recovery_session_id,
      apple_transaction_id,
      apple_receipt_data,
      purchase_amount_cents,
      currency,
      purchased_at: new Date(),
      refunded_at: null,
    };
    fakePurchases.push(row);
    return {
      rows: [{ id: row.id, recovery_session_id: row.recovery_session_id }],
      rowCount: 1,
    };
  }

  if (
    /^SELECT id, recovery_session_id FROM recovery_plus_purchases WHERE apple_transaction_id = \$1/i.test(
      trimmed,
    )
  ) {
    const [txId] = params as [string];
    const row = fakePurchases.find((p) => p.apple_transaction_id === txId);
    return row
      ? {
          rows: [{ id: row.id, recovery_session_id: row.recovery_session_id }],
          rowCount: 1,
        }
      : { rows: [], rowCount: 0 };
  }

  if (/^SELECT user_id FROM recovery_plus_purchases WHERE id = \$1/i.test(trimmed)) {
    const [id] = params as [string];
    const row = fakePurchases.find((p) => p.id === id);
    return row
      ? { rows: [{ user_id: row.user_id }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // hasRecoveryPlus — NULL-session bind UPDATE
  if (
    /^UPDATE recovery_plus_purchases SET recovery_session_id = \$2 WHERE id = \( SELECT id FROM recovery_plus_purchases WHERE user_id = \$1 AND recovery_session_id IS NULL/i.test(
      trimmed,
    )
  ) {
    const [user_id, session_id] = params as [string, string];
    const candidates = fakePurchases
      .filter(
        (p) =>
          p.user_id === user_id &&
          p.recovery_session_id === null &&
          p.refunded_at === null,
      )
      .sort((a, b) => b.purchased_at.getTime() - a.purchased_at.getTime());
    if (candidates.length === 0) return { rows: [], rowCount: 0 };
    candidates[0]!.recovery_session_id = session_id;
    return { rows: [{ id: candidates[0]!.id }], rowCount: 1 };
  }

  // hasRecoveryPlus — exact-match SELECT
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

  // revokeOnRefund
  if (
    /^UPDATE recovery_plus_purchases SET refunded_at = COALESCE\(refunded_at, NOW\(\)\) WHERE apple_transaction_id = \$1/i.test(
      trimmed,
    )
  ) {
    const [txId] = params as [string];
    const row = fakePurchases.find((p) => p.apple_transaction_id === txId);
    if (!row) return { rows: [], rowCount: 0 };
    if (!row.refunded_at) row.refunded_at = new Date();
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // ====== wire_trace_cases ======

  if (/^INSERT INTO wire_trace_cases/i.test(trimmed)) {
    const [
      user_id,
      recovery_session_id,
      source_bank,
      destination_account_hint,
      wire_amount_cents,
      wire_sent_at,
    ] = params as [string, string, string, string | null, bigint | string, Date];
    const row: FakeWireCase = {
      id: `00000000-0000-0000-1000-${String(nextWireSeq++).padStart(12, '0')}`,
      user_id,
      recovery_session_id,
      source_bank,
      destination_account_hint,
      wire_amount_cents:
        typeof wire_amount_cents === 'bigint'
          ? wire_amount_cents
          : BigInt(wire_amount_cents),
      wire_sent_at,
      state: 'intake',
      dispute_letter_text: null,
      bank_response_text: null,
      state_changed_at: new Date(),
      created_at: new Date(),
    };
    fakeWireCases.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  if (
    /^SELECT id, user_id, recovery_session_id, source_bank, destination_account_hint, wire_amount_cents, wire_sent_at, state, dispute_letter_text, bank_response_text, state_changed_at, created_at FROM wire_trace_cases WHERE id = \$1 AND user_id = \$2/i.test(
      trimmed,
    )
  ) {
    const [case_id, user_id] = params as [string, string];
    const row = fakeWireCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [
        {
          ...row,
          wire_amount_cents: row.wire_amount_cents.toString(),
        },
      ],
      rowCount: 1,
    };
  }

  if (
    /^SELECT state, recovery_session_id FROM wire_trace_cases WHERE id = \$1 AND user_id = \$2/i.test(
      trimmed,
    )
  ) {
    const [case_id, user_id] = params as [string, string];
    const row = fakeWireCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [{ state: row.state, recovery_session_id: row.recovery_session_id }],
      rowCount: 1,
    };
  }

  if (/^UPDATE wire_trace_cases SET dispute_letter_text = \$3,/i.test(trimmed)) {
    const [case_id, user_id, ct] = params as [string, string, string];
    const row = fakeWireCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    row.dispute_letter_text = ct;
    if (row.state === 'intake') {
      row.state = 'letter_drafted';
      row.state_changed_at = new Date();
    }
    return { rows: [], rowCount: 1 };
  }

  if (
    /^UPDATE wire_trace_cases SET state = \$3, state_changed_at = NOW\(\), bank_response_text = COALESCE\(\$4, bank_response_text\) WHERE id = \$1 AND user_id = \$2/i.test(
      trimmed,
    )
  ) {
    const [case_id, user_id, next_state, bank_response] = params as [
      string,
      string,
      FakeWireCase['state'],
      string | null,
    ];
    const row = fakeWireCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    row.state = next_state;
    row.state_changed_at = new Date();
    if (bank_response !== null) row.bank_response_text = bank_response;
    return { rows: [], rowCount: 1 };
  }

  // ====== crypto_trace_cases ======

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
    const row: FakeCryptoCase = {
      id: `00000000-0000-0000-2000-${String(nextCryptoSeq++).padStart(12, '0')}`,
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
    fakeCryptoCases.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  if (/^SELECT id, user_id, recovery_session_id, source_wallet/i.test(trimmed)) {
    const [case_id, user_id] = params as [string, string];
    const row = fakeCryptoCases.find((c) => c.id === case_id && c.user_id === user_id);
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

  if (
    /^UPDATE crypto_trace_cases SET hops_analyzed = \$1, exchange_tagged = \$2, trace_report_jsonb = \$3::jsonb/i.test(
      trimmed,
    )
  ) {
    const [hops_analyzed, exchange_tagged, trace_report_jsonb, state, case_id, user_id] =
      params as [number, string | null, string, string, string, string];
    const row = fakeCryptoCases.find(
      (c) =>
        c.id === case_id &&
        c.user_id === user_id &&
        (c.state === 'intake' || c.state === 'tracing'),
    );
    if (!row) return { rows: [], rowCount: 0 };
    row.hops_analyzed = hops_analyzed;
    row.exchange_tagged = exchange_tagged;
    row.trace_report_jsonb = JSON.parse(trace_report_jsonb);
    row.state = state as FakeCryptoCase['state'];
    row.state_changed_at = new Date();
    return { rows: [], rowCount: 1 };
  }

  if (
    /^UPDATE crypto_trace_cases SET petition_text = \$1, state = 'petition_drafted'/i.test(
      trimmed,
    )
  ) {
    const [petition_text, case_id, user_id] = params as [string, string, string];
    const row = fakeCryptoCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    row.petition_text = petition_text;
    row.state = 'petition_drafted';
    row.state_changed_at = new Date();
    return { rows: [], rowCount: 1 };
  }

  if (
    /^UPDATE crypto_trace_cases SET state = \$1, state_changed_at = NOW\(\)/i.test(trimmed)
  ) {
    const [state, case_id, user_id] = params as [string, string, string];
    const row = fakeCryptoCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    row.state = state as FakeCryptoCase['state'];
    row.state_changed_at = new Date();
    return { rows: [], rowCount: 1 };
  }

  // ====== legal_documents ======

  if (/^INSERT INTO legal_documents/i.test(trimmed)) {
    const [user_id, recovery_session_id, doc_kind, state_jurisdiction, body_markdown] =
      params as [string, string, string, string | null, string];
    const row: FakeLegalDocument = {
      id: `00000000-0000-0000-3000-${String(nextDocSeq++).padStart(12, '0')}`,
      user_id,
      recovery_session_id,
      doc_kind,
      state_jurisdiction,
      body_markdown,
      pdf_url: null,
      generated_at: new Date(),
      user_acknowledged_disclaimer_at: new Date(),
    };
    fakeLegalDocs.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  if (
    /^SELECT id, user_id, recovery_session_id, doc_kind, state_jurisdiction, body_markdown, pdf_url, generated_at, user_acknowledged_disclaimer_at FROM legal_documents WHERE user_id = \$1 AND recovery_session_id = \$2/i.test(
      trimmed,
    )
  ) {
    const [user_id, session_id] = params as [string, string];
    const matches = fakeLegalDocs
      .filter((d) => d.user_id === user_id && d.recovery_session_id === session_id)
      .sort((a, b) => b.generated_at.getTime() - a.generated_at.getTime());
    return { rows: matches, rowCount: matches.length };
  }

  if (
    /^SELECT id, user_id, recovery_session_id, doc_kind, state_jurisdiction, body_markdown, pdf_url, generated_at, user_acknowledged_disclaimer_at FROM legal_documents WHERE user_id = \$1 ORDER BY generated_at DESC/i.test(
      trimmed,
    )
  ) {
    const [user_id] = params as [string];
    const matches = fakeLegalDocs
      .filter((d) => d.user_id === user_id)
      .sort((a, b) => b.generated_at.getTime() - a.generated_at.getTime());
    return { rows: matches, rowCount: matches.length };
  }

  if (
    /^SELECT id, user_id, recovery_session_id, doc_kind, state_jurisdiction, body_markdown, pdf_url, generated_at, user_acknowledged_disclaimer_at FROM legal_documents WHERE id = \$1 AND user_id = \$2 LIMIT 1/i.test(
      trimmed,
    )
  ) {
    const [doc_id, user_id] = params as [string, string];
    const row = fakeLegalDocs.find((d) => d.id === doc_id && d.user_id === user_id);
    return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // ====== specialists ======

  if (
    /^SELECT id, display_name, category, jurisdictions, capabilities, commission_pct, contact_email, contact_phone, bar_number, status, vetted_at, vetted_by, notes, created_at FROM specialists WHERE/i.test(
      trimmed,
    )
  ) {
    if (/WHERE id = \$1 AND status = 'active'/i.test(trimmed)) {
      const [id] = params as [string];
      const row = fakeSpecialists.find((s) => s.id === id && s.status === 'active');
      return row
        ? { rows: [specialistRowOut(row)], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    let pos = 0;
    let categoryFilter: string | null = null;
    let jurisdictionFilter: string | null = null;
    let capabilitiesFilter: string[] | null = null;
    if (/category = \$/.test(trimmed)) categoryFilter = params[pos++] as string;
    if (/= ANY\(jurisdictions\)/.test(trimmed)) {
      jurisdictionFilter = params[pos++] as string;
    }
    if (/capabilities @> \$/.test(trimmed)) {
      capabilitiesFilter = params[pos++] as string[];
    }
    const limit = params[pos++] as number;

    let candidates = fakeSpecialists.filter((s) => s.status === 'active');
    if (categoryFilter) {
      candidates = candidates.filter((s) => s.category === categoryFilter);
    }
    if (jurisdictionFilter) {
      candidates = candidates.filter((s) =>
        s.jurisdictions.includes(jurisdictionFilter!),
      );
    }
    if (capabilitiesFilter) {
      candidates = candidates.filter((s) =>
        capabilitiesFilter!.every((c) => s.capabilities.includes(c)),
      );
    }
    candidates.sort((a, b) => {
      if (a.category !== b.category) return a.category < b.category ? -1 : 1;
      return a.display_name < b.display_name ? -1 : 1;
    });
    const sliced = candidates.slice(0, limit);
    return { rows: sliced.map(specialistRowOut), rowCount: sliced.length };
  }

  if (/^SELECT category FROM specialists WHERE id = \$1 AND status = 'active'/i.test(trimmed)) {
    const [id] = params as [string];
    const row = fakeSpecialists.find((s) => s.id === id && s.status === 'active');
    return row
      ? { rows: [{ category: row.category }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // ====== recovery_sessions ======

  if (
    /^SELECT 1 AS exists_marker FROM recovery_sessions WHERE id = \$1 AND user_id = \$2/i.test(
      trimmed,
    )
  ) {
    const [id, user_id] = params as [string, string];
    const row = fakeSessions.find((s) => s.id === id && s.user_id === user_id);
    return row
      ? { rows: [{ exists_marker: 1 }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // ====== specialist_referrals ======

  if (
    /^SELECT id FROM specialist_referrals WHERE user_id = \$1 AND specialist_id = \$2 AND recovery_session_id = \$3 AND engagement_status = ANY\(\$4\)/i.test(
      trimmed,
    )
  ) {
    const [user_id, specialist_id, session_id, statuses] = params as [
      string,
      string,
      string,
      FakeReferral['engagement_status'][],
    ];
    const matches = fakeReferrals
      .filter(
        (r) =>
          r.user_id === user_id &&
          r.specialist_id === specialist_id &&
          r.recovery_session_id === session_id &&
          statuses.includes(r.engagement_status),
      )
      .sort((a, b) => b.referred_at.getTime() - a.referred_at.getTime());
    return matches.length > 0
      ? { rows: [{ id: matches[0]!.id }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  if (/^INSERT INTO specialist_referrals/i.test(trimmed)) {
    const [user_id, specialist_id, session_id] = params as [string, string, string];
    const row: FakeReferral = {
      id: `00000000-0000-0000-4000-${String(nextReferralSeq++).padStart(12, '0')}`,
      user_id,
      specialist_id,
      recovery_session_id: session_id,
      referred_at: new Date(),
      specialist_acknowledged_at: null,
      engagement_status: 'referred',
      fee_owed_cents: null,
      fee_paid_at: null,
      outcome_notes: null,
    };
    fakeReferrals.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  if (
    /^SELECT id, user_id, specialist_id, recovery_session_id, referred_at, specialist_acknowledged_at, engagement_status, fee_owed_cents, fee_paid_at, outcome_notes FROM specialist_referrals WHERE user_id = \$1 AND recovery_session_id = \$2 ORDER BY referred_at DESC/i.test(
      trimmed,
    )
  ) {
    const [user_id, session_id] = params as [string, string];
    const matches = fakeReferrals
      .filter((r) => r.user_id === user_id && r.recovery_session_id === session_id)
      .sort((a, b) => b.referred_at.getTime() - a.referred_at.getTime());
    return { rows: matches.map(referralRowOut), rowCount: matches.length };
  }

  if (
    /^SELECT id, user_id, specialist_id, recovery_session_id, referred_at, specialist_acknowledged_at, engagement_status, fee_owed_cents, fee_paid_at, outcome_notes FROM specialist_referrals WHERE user_id = \$1 ORDER BY referred_at DESC$/i.test(
      trimmed,
    )
  ) {
    const [user_id] = params as [string];
    const matches = fakeReferrals
      .filter((r) => r.user_id === user_id)
      .sort((a, b) => b.referred_at.getTime() - a.referred_at.getTime());
    return { rows: matches.map(referralRowOut), rowCount: matches.length };
  }

  // ====== admin /recovery-shield/summary aggregations ======

  // (a) recovery_plus_purchases — open count + revenue 30d
  if (
    /^SELECT COUNT\(\*\)::TEXT AS open_count, COALESCE\(SUM\(purchase_amount_cents\) FILTER \(WHERE refunded_at IS NULL\), 0\)::TEXT AS revenue_cents FROM recovery_plus_purchases/i.test(
      trimmed,
    )
  ) {
    const open = fakePurchases.filter((p) => p.refunded_at === null);
    const revenue = open.reduce((acc, p) => acc + p.purchase_amount_cents, 0);
    return {
      rows: [
        {
          open_count: String(open.length),
          revenue_cents: String(revenue),
        },
      ],
      rowCount: 1,
    };
  }

  // (b) wire-trace by state
  if (
    /^SELECT state, COUNT\(\*\)::TEXT AS count FROM wire_trace_cases/i.test(trimmed)
  ) {
    const counts = new Map<string, number>();
    for (const c of fakeWireCases) {
      counts.set(c.state, (counts.get(c.state) ?? 0) + 1);
    }
    return {
      rows: Array.from(counts.entries()).map(([state, n]) => ({
        state,
        count: String(n),
      })),
      rowCount: counts.size,
    };
  }

  // (c) crypto-trace by state
  if (
    /^SELECT state, COUNT\(\*\)::TEXT AS count FROM crypto_trace_cases/i.test(trimmed)
  ) {
    const counts = new Map<string, number>();
    for (const c of fakeCryptoCases) {
      counts.set(c.state, (counts.get(c.state) ?? 0) + 1);
    }
    return {
      rows: Array.from(counts.entries()).map(([state, n]) => ({
        state,
        count: String(n),
      })),
      rowCount: counts.size,
    };
  }

  // (d) legal_documents 30d count
  if (
    /^SELECT COUNT\(\*\)::TEXT AS count FROM legal_documents WHERE generated_at/i.test(
      trimmed,
    )
  ) {
    return { rows: [{ count: String(fakeLegalDocs.length) }], rowCount: 1 };
  }

  // (e) specialist_referrals by status 30d
  if (
    /^SELECT engagement_status, COUNT\(\*\)::TEXT AS count FROM specialist_referrals/i.test(
      trimmed,
    )
  ) {
    const counts = new Map<string, number>();
    for (const r of fakeReferrals) {
      counts.set(r.engagement_status, (counts.get(r.engagement_status) ?? 0) + 1);
    }
    return {
      rows: Array.from(counts.entries()).map(([engagement_status, n]) => ({
        engagement_status,
        count: String(n),
      })),
      rowCount: counts.size,
    };
  }

  throw new Error(`E2E unstubbed SQL: ${trimmed.slice(0, 160)}`);
};

// ----------------------------------------------------------------
// Apple JWS verifier stub
// ----------------------------------------------------------------

interface StubAppleTx {
  transactionId: string;
  productId: string;
  bundleId: string;
  environment: string;
  purchaseDate: number;
}

let stubAppleTxOverride: Partial<StubAppleTx> | 'throw' | null = null;

const SDK = appleSdk as unknown as {
  SignedDataVerifier: { prototype: Record<string, unknown> };
};
const originalVerify = SDK.SignedDataVerifier.prototype.verifyAndDecodeTransaction;

function installAppleStub(): void {
  SDK.SignedDataVerifier.prototype.verifyAndDecodeTransaction = async function (
    _jws: string,
  ) {
    if (stubAppleTxOverride === 'throw') {
      throw new Error('synthetic verifier failure');
    }
    const o = stubAppleTxOverride ?? {};
    return {
      transactionId: o.transactionId ?? 'tx-e2e-100001',
      originalTransactionId: o.transactionId ?? 'tx-e2e-100001',
      productId: o.productId ?? 'recovery_plus_one_time',
      bundleId: o.bundleId ?? 'com.aegisdial.app',
      purchaseDate: o.purchaseDate ?? 1_700_000_000_000,
      type: 'Non-Consumable',
      environment: o.environment ?? 'Sandbox',
      appAccountToken: null,
    };
  };
}

// ----------------------------------------------------------------
// LLM fetch stub
// ----------------------------------------------------------------

const originalFetch = globalThis.fetch;
let llmCallCount = 0;

function installFetchStub(): void {
  llmCallCount = 0;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const u =
      typeof url === 'string' ? url : (url as { toString(): string }).toString();
    if (u.includes('api.anthropic.com')) {
      llmCallCount++;
      const body = init?.body ?? '';
      // legalPacketGenerator prompts ask for JSON `{ body_markdown: ... }`;
      // wire dispute / crypto petition prompts expect plain text.
      const wantsJsonBody =
        /\\"body_markdown\\":/.test(body) || /"body_markdown":/.test(body);
      const responseText = wantsJsonBody
        ? JSON.stringify({
            body_markdown:
              '> **LEGAL DISCLAIMER**\n>\n> AegisDial is not your attorney. AI-generated stub.\n\n# Recovery Shield E2E generated doc\n\nBody narrative referencing the case.',
          })
        : "NOTE: This draft is a starting template. Consult your bank's fraud department or a licensed attorney before sending.\n\nDear Fraud Department,\n\n[stub generated body]\n";
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: responseText }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return originalFetch(url as never, init as never);
  }) as typeof fetch;
}

// ----------------------------------------------------------------
// Test scaffolding
// ----------------------------------------------------------------

beforeEach(() => {
  fakePurchases = [];
  fakeWireCases = [];
  fakeCryptoCases = [];
  fakeLegalDocs = [];
  fakeSpecialists = [];
  fakeReferrals = [];
  fakeSessions = [];
  nextPurchaseSeq = 1;
  nextWireSeq = 1;
  nextCryptoSeq = 1;
  nextDocSeq = 1;
  nextReferralSeq = 1;
  stubAppleTxOverride = null;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
  installAppleStub();
  installFetchStub();
});

afterEach(() => {
  SDK.SignedDataVerifier.prototype.verifyAndDecodeTransaction = originalVerify;
  globalThis.fetch = originalFetch;
});

let app: ReturnType<typeof Fastify>;

before(async () => {
  app = Fastify();
  await app.register(fastifyRateLimit, {
    global: false,
    max: 9999,
    timeWindow: '1 minute',
  });
  await app.register(recoveryShieldRoutes);
  await app.register(adminRecoveryShieldRoutes);
});

after(async () => {
  await app.close();
});

// ----------------------------------------------------------------
// Scenario
// ----------------------------------------------------------------

describe('Recovery Shield E2E — purchase → wire + crypto trace → docs → referral → admin → refund', () => {
  it('walks the full happy path through real code, then verifies refund revokes entitlement', async () => {
    // ----------------------------------------------------------------
    // Phase 1: Seed the recovery session + the marketplace specialist.
    // ----------------------------------------------------------------
    fakeSessions.push({ id: SESSION_ID, user_id: USER_ID });
    fakeSpecialists.push({
      id: SPECIALIST_ID,
      display_name: 'Acme Asset Recovery LLP',
      category: 'asset_recovery_attorney',
      jurisdictions: ['US-FL', 'US-CA'],
      capabilities: ['wire_recall', 'crypto'],
      commission_pct: '10.00',
      contact_email: 'intake@acme.example',
      contact_phone: null,
      bar_number: 'FL-12345',
      status: 'active',
      vetted_at: new Date(),
      vetted_by: null,
      notes: null,
      created_at: new Date(),
    });

    // Sanity: starting Plus-status should be entitled=false.
    const statusBefore = await app.inject({
      method: 'GET',
      url: `/v1/recovery/plus/status?recovery_session_id=${SESSION_ID}`,
      headers: { authorization: PRO_BEARER },
    });
    assert.equal(statusBefore.statusCode, 200);
    assert.deepEqual(statusBefore.json(), { entitled: false });

    // ----------------------------------------------------------------
    // Phase 2: Purchase Recovery Plus. Verifies the route layer's
    // Apple JWS dispatch + the entitlement INSERT.
    // ----------------------------------------------------------------
    stubAppleTxOverride = { transactionId: 'tx-e2e-purchase-1' };
    const purchaseRes = await app.inject({
      method: 'POST',
      url: '/v1/recovery/plus/purchase',
      headers: { authorization: PRO_BEARER },
      payload: {
        apple_receipt: 'A'.repeat(64),
        apple_transaction_id: 'tx-e2e-purchase-1',
        recovery_session_id: SESSION_ID,
        purchase_amount_cents: 24900,
      },
    });
    assert.equal(purchaseRes.statusCode, 201);
    const purchaseBody = purchaseRes.json() as {
      purchase_id: string;
      is_new: boolean;
      entitled_session_id: string;
    };
    assert.equal(purchaseBody.is_new, true);
    assert.equal(purchaseBody.entitled_session_id, SESSION_ID);
    assert.equal(fakePurchases.length, 1);
    assert.equal(fakePurchases[0]!.user_id, USER_ID);

    // ----------------------------------------------------------------
    // Phase 3: Plus-status should now flip to true.
    // ----------------------------------------------------------------
    const statusAfter = await app.inject({
      method: 'GET',
      url: `/v1/recovery/plus/status?recovery_session_id=${SESSION_ID}`,
      headers: { authorization: PRO_BEARER },
    });
    assert.deepEqual(statusAfter.json(), { entitled: true });

    // ----------------------------------------------------------------
    // Phase 4: Start a wire-trace case.
    // ----------------------------------------------------------------
    const wireStart = await app.inject({
      method: 'POST',
      url: '/v1/recovery/trace/wire',
      headers: { authorization: PRO_BEARER },
      payload: {
        source_bank: 'Chase',
        destination_account_hint: '1234',
        wire_amount_cents: 4500000, // $45,000
        wire_sent_at: new Date().toISOString(),
        recovery_session_id: SESSION_ID,
      },
    });
    assert.equal(wireStart.statusCode, 201);
    const wireStartBody = wireStart.json() as { case_id: string; state: string };
    assert.equal(wireStartBody.state, 'intake');
    assert.equal(fakeWireCases.length, 1);
    // destination_account_hint must land as ciphertext (envelope-encrypted).
    const wireRow = fakeWireCases[0]!;
    assert.ok(
      wireRow.destination_account_hint?.startsWith('v1:'),
      `destination_account_hint must be envelope-encrypted, got: ${wireRow.destination_account_hint}`,
    );
    const wireCaseId = wireStartBody.case_id;

    // ----------------------------------------------------------------
    // Phase 5: Generate the dispute letter via the real LLM dispatch
    // path. The fetch stub returns the canned plaintext; the service
    // prepends the disclaimer if missing and envelope-encrypts at rest.
    // ----------------------------------------------------------------
    const letterRes = await app.inject({
      method: 'POST',
      url: `/v1/recovery/trace/wire/${wireCaseId}/letter`,
      headers: { authorization: PRO_BEARER },
      payload: { recovery_session_id: SESSION_ID },
    });
    assert.equal(letterRes.statusCode, 200);
    const letterBody = letterRes.json() as { letter_text: string };
    assert.ok(
      letterBody.letter_text.includes('NOTE: This draft is a starting template'),
      'disclaimer must appear in the response',
    );
    // At-rest column must be ciphertext.
    assert.ok(
      fakeWireCases[0]!.dispute_letter_text?.startsWith('v1:'),
      'dispute_letter_text must be envelope-encrypted at rest',
    );
    // State advanced from intake → letter_drafted by the same call.
    assert.equal(fakeWireCases[0]!.state, 'letter_drafted');

    // ----------------------------------------------------------------
    // Phase 6: Walk the wire case through the full state machine.
    //   letter_drafted → user_sent → bank_acknowledged → recalled
    // ----------------------------------------------------------------
    for (const nextState of ['user_sent', 'bank_acknowledged', 'recalled'] as const) {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/recovery/trace/wire/${wireCaseId}/advance`,
        headers: { authorization: PRO_BEARER },
        payload: {
          next_state: nextState,
          recovery_session_id: SESSION_ID,
          ...(nextState === 'bank_acknowledged'
            ? { bank_response_text: 'Acknowledged; investigating.' }
            : {}),
        },
      });
      assert.equal(r.statusCode, 200, `${nextState} transition should succeed`);
      assert.equal(
        (r.json() as { state: string }).state,
        nextState,
      );
    }
    assert.equal(fakeWireCases[0]!.state, 'recalled');
    // bank_response_text was supplied on the bank_acknowledged step → ciphertext.
    assert.ok(
      fakeWireCases[0]!.bank_response_text?.startsWith('v1:'),
      'bank_response_text must be envelope-encrypted at rest',
    );

    // ----------------------------------------------------------------
    // Phase 7: Start a crypto-trace case on the SAME recovery session.
    // ----------------------------------------------------------------
    const cryptoStart = await app.inject({
      method: 'POST',
      url: '/v1/recovery/trace/crypto',
      headers: { authorization: PRO_BEARER },
      payload: {
        source_wallet: '0xVICTIMVICTIMVICTIMVICTIMVICTIMVICTIM0001',
        destination_wallet: '0xSCAMMER1SCAMMER1SCAMMER1SCAMMER1SCAM0002',
        chain: 'ethereum',
        amount_native: '4500000000000000000',
        amount_usd_cents_at_send: 1500000, // $15,000
        recovery_session_id: SESSION_ID,
      },
    });
    assert.equal(cryptoStart.statusCode, 201);
    const cryptoStartBody = cryptoStart.json() as { case_id: string; state: string };
    assert.equal(cryptoStartBody.state, 'intake');
    const cryptoCaseId = cryptoStartBody.case_id;
    assert.equal(fakeCryptoCases.length, 1);

    // ----------------------------------------------------------------
    // Phase 8: Run hops via the agent directly so we can inject the
    // chain RPC + tagger fixtures. The route surface intentionally
    // doesn't take these — they're production-wired to live providers.
    // The agent path is fully real here (hop-walk algorithm + state
    // transition + JSONB persistence).
    // ----------------------------------------------------------------
    const chainFetchFn = async (_chain: string, address: string) => {
      // Single outbound from the scammer's wallet to an exchange wallet.
      if (
        address === '0xSCAMMER1SCAMMER1SCAMMER1SCAMMER1SCAM0002'
      ) {
        return [
          {
            tx_hash: '0xabc123',
            from: address,
            to: '0xEXCHANGEHOTWALLETEXCHANGEHOTWALL0003',
            value_native: '4500000000000000000',
            timestamp: new Date(),
          },
        ];
      }
      return [];
    };
    const exchangeTaggerFn = async (_chain: string, address: string) => {
      if (address === '0xEXCHANGEHOTWALLETEXCHANGEHOTWALL0003') {
        return { exchange: 'Binance Hot Wallet', tagged_address: address };
      }
      return { exchange: null, tagged_address: null };
    };
    const hopsResult = await cryptoAgent.runTraceHops({
      case_id: cryptoCaseId,
      user_id: USER_ID,
      opts: { chainFetchFn, exchangeTaggerFn },
    });
    assert.equal(hopsResult.exchange_tagged, 'Binance Hot Wallet');
    assert.equal(fakeCryptoCases[0]!.state, 'exchange_identified');
    assert.equal(fakeCryptoCases[0]!.exchange_tagged, 'Binance Hot Wallet');

    // ----------------------------------------------------------------
    // Phase 9: Generate the exchange petition via the route. Hits the
    // LLM (fetch stub returns text-mode) + writes ciphertext +
    // transitions state to petition_drafted.
    // ----------------------------------------------------------------
    const petitionRes = await app.inject({
      method: 'POST',
      url: `/v1/recovery/trace/crypto/${cryptoCaseId}/petition`,
      headers: { authorization: PRO_BEARER },
      payload: { recovery_session_id: SESSION_ID },
    });
    assert.equal(petitionRes.statusCode, 200);
    const petitionBody = petitionRes.json() as { petition_text: string };
    assert.ok(
      petitionBody.petition_text.includes(
        'NOTE: This is a draft starting template',
      ),
      'petition disclaimer must appear',
    );
    assert.equal(fakeCryptoCases[0]!.state, 'petition_drafted');
    assert.ok(
      fakeCryptoCases[0]!.petition_text?.startsWith('v1:'),
      'petition_text must be envelope-encrypted at rest',
    );

    // ----------------------------------------------------------------
    // Phase 10: Browse specialists, then create a referral.
    // ----------------------------------------------------------------
    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/recovery/specialists?category=asset_recovery_attorney&jurisdiction=US-FL',
      headers: { authorization: PRO_BEARER },
    });
    assert.equal(listRes.statusCode, 200);
    const listBody = listRes.json() as {
      specialists: Array<{ id: string; display_name: string }>;
    };
    assert.equal(listBody.specialists.length, 1);
    assert.equal(listBody.specialists[0]!.id, SPECIALIST_ID);

    const referRes = await app.inject({
      method: 'POST',
      url: '/v1/recovery/specialists/refer',
      headers: { authorization: PRO_BEARER },
      payload: {
        specialist_id: SPECIALIST_ID,
        recovery_session_id: SESSION_ID,
      },
    });
    assert.equal(referRes.statusCode, 201);
    assert.equal(fakeReferrals.length, 1);
    assert.equal(fakeReferrals[0]!.engagement_status, 'referred');

    // ----------------------------------------------------------------
    // Phase 11: Generate the legal packet. The 8 default doc_kinds
    // shake out to 7 generated docs (CFPB qualifies because scam_type
    // contains 'wire_recall_denied'; demand_letter generates because
    // scam_actor_contact is supplied; the rest are unconditional).
    // exchange_petition + insurance_claim are NOT in the default list
    // — they're explicitly excluded by DEFAULT_PACKET_DOC_KINDS.
    // ----------------------------------------------------------------
    const docsRes = await app.inject({
      method: 'POST',
      url: '/v1/recovery/documents/generate',
      headers: { authorization: PRO_BEARER },
      payload: {
        recovery_session_id: SESSION_ID,
        state_jurisdiction: 'US-FL',
        user_acknowledged_disclaimer: true,
        case_facts: {
          scam_type: 'bank_employee_impersonation_with_wire_recall_denied',
          amount_lost_cents: 4500000,
          scam_actor_descriptor: 'caller claimed to be Chase fraud dept',
          scam_actor_contact: '+1-555-FAKEBANK',
          incident_date: new Date().toISOString(),
          description_summary:
            'Scammer impersonated bank fraud team and pressured wire to "safe account".',
        },
      },
    });
    assert.equal(docsRes.statusCode, 201);
    const docsBody = docsRes.json() as {
      generated: Array<{ document_id: string; doc_kind: string }>;
      skipped: Array<{ doc_kind: string; reason: string }>;
    };
    // Default packet has 8 entries; CFPB qualifies and demand_letter has a
    // contact — all 8 generate. (exchange_petition + insurance_claim are
    // NOT in DEFAULT_PACKET_DOC_KINDS, so they never enter the funnel.)
    assert.equal(
      docsBody.generated.length,
      8,
      `expected 8 generated docs, got ${docsBody.generated.length}; skipped=${JSON.stringify(docsBody.skipped)}`,
    );
    assert.equal(docsBody.skipped.length, 0);
    assert.equal(fakeLegalDocs.length, 8);
    // Disclaimer enforcement — every stored body must be ciphertext.
    for (const d of fakeLegalDocs) {
      assert.ok(
        d.body_markdown.startsWith('v1:'),
        'every legal_documents.body_markdown must be envelope-encrypted',
      );
      assert.ok(
        d.user_acknowledged_disclaimer_at instanceof Date,
        'disclaimer ack timestamp must be set on every generated doc',
      );
    }

    // ----------------------------------------------------------------
    // Phase 12: Admin summary reflects the full session lifecycle.
    // ----------------------------------------------------------------
    const adminSummary = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/summary',
      headers: { authorization: ADMIN_BEARER },
    });
    assert.equal(adminSummary.statusCode, 200);
    const summary = adminSummary.json() as {
      open_purchases_30d: number;
      total_revenue_30d_cents: number;
      wire_cases_by_state: Record<string, number>;
      crypto_cases_by_state: Record<string, number>;
      open_wire_cases: number;
      open_crypto_cases: number;
      legal_docs_generated_30d: number;
      referrals_30d_by_status: Record<string, number>;
      total_referrals_30d: number;
    };
    assert.equal(summary.open_purchases_30d, 1);
    assert.equal(summary.total_revenue_30d_cents, 24900);
    assert.equal(summary.wire_cases_by_state.recalled, 1);
    assert.equal(summary.open_wire_cases, 0); // recalled is terminal
    assert.equal(summary.crypto_cases_by_state.petition_drafted, 1);
    assert.equal(summary.open_crypto_cases, 1); // petition_drafted is non-terminal
    assert.equal(summary.legal_docs_generated_30d, 8);
    assert.equal(summary.referrals_30d_by_status.referred, 1);
    assert.equal(summary.total_referrals_30d, 1);

    // ----------------------------------------------------------------
    // Phase 13: Apple S2S REFUND. revokeOnRefund flips refunded_at;
    // hasRecoveryPlus now returns false; a fresh wire-trace start for
    // a NEW session returns 402 recovery_plus_required.
    // ----------------------------------------------------------------
    const revoke = await entitlement.revokeOnRefund('tx-e2e-purchase-1');
    assert.deepEqual(revoke, { revoked: true });
    assert.ok(fakePurchases[0]!.refunded_at instanceof Date);

    // Status flip:
    const statusAfterRefund = await app.inject({
      method: 'GET',
      url: `/v1/recovery/plus/status?recovery_session_id=${SESSION_ID}`,
      headers: { authorization: PRO_BEARER },
    });
    assert.deepEqual(statusAfterRefund.json(), { entitled: false });

    // Mutation gate fires — fresh case on a fresh session should be 402.
    fakeSessions.push({ id: NEW_SESSION_ID, user_id: USER_ID });
    const blockedWire = await app.inject({
      method: 'POST',
      url: '/v1/recovery/trace/wire',
      headers: { authorization: PRO_BEARER },
      payload: {
        source_bank: 'Wells Fargo',
        wire_amount_cents: 1000000,
        wire_sent_at: new Date().toISOString(),
        recovery_session_id: NEW_SESSION_ID,
      },
    });
    assert.equal(blockedWire.statusCode, 402);
    assert.equal(
      (blockedWire.json() as { error: string }).error,
      'recovery_plus_required',
    );
  });

  it('rejects a cross-user replay of the same Apple transaction during purchase', async () => {
    // Adversarial: a leaked / log-mined JWS receipt belonging to OTHER_USER_ID
    // is replayed by the synthetic dev-bearer user. Service inserts as the
    // original owner; route layer detects the user mismatch via the
    // SELECT user_id FROM recovery_plus_purchases lookup and 409s without
    // entitling the wrong user.
    fakePurchases.push({
      id: 'pur-seed-other',
      user_id: OTHER_USER_ID,
      recovery_session_id: SESSION_ID,
      apple_transaction_id: 'tx-e2e-cross-user-replay',
      apple_receipt_data: 'seed-receipt',
      purchase_amount_cents: 24900,
      currency: 'USD',
      purchased_at: new Date(),
      refunded_at: null,
    });
    nextPurchaseSeq = 2;
    stubAppleTxOverride = { transactionId: 'tx-e2e-cross-user-replay' };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/recovery/plus/purchase',
      headers: { authorization: PRO_BEARER },
      payload: {
        apple_receipt: 'B'.repeat(64),
        apple_transaction_id: 'tx-e2e-cross-user-replay',
        recovery_session_id: SESSION_ID,
        purchase_amount_cents: 24900,
      },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(
      (res.json() as { error: string }).error,
      'transaction_id_already_used',
    );
    // Synthetic user is NOT entitled — verify via status probe.
    const status = await app.inject({
      method: 'GET',
      url: `/v1/recovery/plus/status?recovery_session_id=${SESSION_ID}`,
      headers: { authorization: PRO_BEARER },
    });
    assert.deepEqual(status.json(), { entitled: false });
    // No extra row inserted — the original owner's purchase is intact.
    assert.equal(fakePurchases.length, 1);
    assert.equal(fakePurchases[0]!.user_id, OTHER_USER_ID);
  });
});

// Silence the "unused" lint on the crypto helper. We re-export to make
// sure module-load wires the encryption code path — the at-rest
// ciphertext checks above depend on the same v1:<iv>:<tag>:<ct> format
// crypto.ts emits.
void crypto;
