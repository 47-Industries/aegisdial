import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Recovery Shield R-P5 — /v1/recovery/* Pro+Plus route surface tests.
//
// Stubs:
//   - db.pool.query — selectively matches every SQL the service layer
//     emits and operates against in-memory tables for:
//       recovery_plus_purchases / wire_trace_cases / crypto_trace_cases /
//       legal_documents / specialists / specialist_referrals /
//       recovery_sessions.
//     Same idiom as identityShieldRoutes.test.ts — we exercise the route
//     + service end-to-end against an in-memory DB rather than module-
//     mocking the services (ESM named-export bindings are read-only).
//   - SignedDataVerifier.prototype.verifyAndDecodeTransaction — Apple
//     JWS verifier swap, mirroring the GmailProvider.prototype.linkAccount
//     pattern in emailShieldRoutes.test.ts. Returns a synthetic decoded
//     transaction so the purchase route's verifier never reaches Apple.
//   - globalThis.fetch — captures Anthropic LLM calls (dispute letter,
//     petition, legal-doc generators) and returns a deterministic body.
//
// Coverage matrix (per the R-P5 brief — 18 routes × happy/401/402/Plus/
// 400/404 facets):
//
//   PURCHASE / STATUS
//     1.  POST /plus/purchase happy 201
//     2.  POST /plus/purchase replay → 200 + is_new=false
//     3.  POST /plus/purchase invalid_price → 400
//     4.  POST /plus/purchase invalid_body → 400
//     5.  GET  /plus/status entitled true
//     6.  GET  /plus/status entitled false
//     7.  GET  /plus/status invalid_query → 400
//
//   WIRE TRACE
//     8.  POST /trace/wire happy 201
//     9.  POST /trace/wire without Plus → 402 recovery_plus_required
//    10.  POST /trace/wire invalid_body → 400
//    11.  GET  /trace/wire/:case_id happy + decrypted
//    12.  GET  /trace/wire/:case_id cross-user → 404
//    13.  POST /trace/wire/:case_id/advance happy
//    14.  POST /trace/wire/:case_id/advance illegal transition → 409
//    15.  POST /trace/wire/:case_id/advance not found → 404
//    16.  POST /trace/wire/:case_id/letter happy → decrypted letter
//
//   CRYPTO TRACE
//    17.  POST /trace/crypto happy 201
//    18.  POST /trace/crypto without Plus → 402
//    19.  POST /trace/crypto invalid chain → 400
//    20.  GET  /trace/crypto/:case_id happy
//    21.  GET  /trace/crypto/:case_id cross-user → 404
//    22.  POST /trace/crypto/:case_id/hops happy
//    23.  POST /trace/crypto/:case_id/petition before exchange_identified → 409
//    24.  POST /trace/crypto/:case_id/petition after exchange_identified → 200
//    25.  POST /trace/crypto/:case_id/advance happy
//    26.  POST /trace/crypto/:case_id/advance illegal → 409
//
//   DOCUMENTS
//    27.  POST /documents/generate happy → packet generated
//    28.  POST /documents/generate disclaimer not acked → 400
//    29.  POST /documents/generate without Plus → 402
//    30.  GET  /documents lists user's only
//    31.  GET  /documents/:document_id happy + decrypted
//    32.  GET  /documents/:document_id cross-user → 404
//
//   SPECIALISTS
//    33.  GET  /specialists active only
//    34.  GET  /specialists?category=blockchain_forensics filter
//    35.  GET  /specialists?capabilities=crypto filter
//    36.  GET  /specialists/:id happy
//    37.  GET  /specialists/:id non-existent → 404
//    38.  POST /specialists/refer happy 201
//    39.  POST /specialists/refer without Plus → 402
//    40.  POST /specialists/refer unknown specialist → 404
//    41.  POST /specialists/refer cross-user session → 404
//
//   REFERRALS
//    42.  GET  /referrals lists user's only
//    43.  GET  /referrals?recovery_session_id=... filter
//
//   GLOBAL
//    44–48. 401 without bearer (sample of every route family)
//    49–53. 402 invalid token (sample of every route family)

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-recovery-shield-routes';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://recovery-shield-routes';
process.env.APPLE_BUNDLE_ID ||= 'com.aegisdial.app';
process.env.APPLE_STOREKIT_ENV ||= 'sandbox';
process.env.ANTHROPIC_API_KEY ||= 'sk-ant-test-recovery-shield-routes';
process.env.ALLOW_DEV_BEARER = 'true';

const Fastify = (await import('fastify')).default;
const fastifyRateLimit = (await import('@fastify/rate-limit')).default;
const db = await import('../src/lib/db.ts');
const crypto = await import('../src/lib/crypto.ts');
const appleSdk = await import('@apple/app-store-server-library');
const { recoveryShieldRoutes } = await import('../src/routes/recoveryShield.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;
const SYNTHETIC_USER_ID = '00000000-0000-0000-0000-000000000000';
const OTHER_USER_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SPECIALIST_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SPECIALIST_ID_INACTIVE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SPECIALIST_ID_OTHER = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const PRO_BEARER = `Bearer ${SHARED_SECRET}`;

// ----------------------------------------------------------------
// In-memory tables
// ----------------------------------------------------------------

interface FakePlusPurchase {
  id: string;
  user_id: string;
  recovery_session_id: string | null;
  apple_transaction_id: string;
  refunded_at: Date | null;
  purchased_at: Date;
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
  state: string;
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
let nextWireCaseSeq = 1;
let nextCryptoCaseSeq = 1;
let nextLegalDocSeq = 1;
let nextReferralSeq = 1;

// ----------------------------------------------------------------
// SQL router — covers every query emitted by the four services
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

  // metric_counters UPSERT — emitMetric. No-op so the route layer's
  // metric emission doesn't pollute the test surface.
  if (/^INSERT INTO metric_counters/i.test(trimmed)) {
    return { rows: [], rowCount: 1 };
  }

  // --------------- recovery_plus_purchases ---------------

  // INSERT — purchaseRecoveryPlus
  if (/^INSERT INTO recovery_plus_purchases/i.test(trimmed)) {
    const [
      user_id,
      recovery_session_id,
      apple_transaction_id,
    ] = params as [string, string | null, string, string, number, string];
    if (fakePurchases.some((p) => p.apple_transaction_id === apple_transaction_id)) {
      // ON CONFLICT DO NOTHING short-circuit.
      return { rows: [], rowCount: 0 };
    }
    const row: FakePlusPurchase = {
      id: `pur-${nextPurchaseSeq++}`,
      user_id,
      recovery_session_id,
      apple_transaction_id,
      refunded_at: null,
      purchased_at: new Date(),
    };
    fakePurchases.push(row);
    return {
      rows: [{ id: row.id, recovery_session_id: row.recovery_session_id }],
      rowCount: 1,
    };
  }

  // Replay-path SELECT — second purchaseRecoveryPlus call with the
  // same transactionId.
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

  // R-H3 cross-user replay owner lookup — route layer queries this
  // after purchaseRecoveryPlus returns is_new=false to verify the
  // calling user owns the original purchase row.
  if (
    /^SELECT user_id FROM recovery_plus_purchases WHERE id = \$1/i.test(trimmed)
  ) {
    const [id] = params as [string];
    const row = fakePurchases.find((p) => p.id === id);
    return row
      ? { rows: [{ user_id: row.user_id }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // hasRecoveryPlus step 1 — atomic NULL-session bind UPDATE.
  if (
    /^UPDATE recovery_plus_purchases SET recovery_session_id = \$2 WHERE id = \( SELECT id FROM recovery_plus_purchases WHERE user_id = \$1 AND recovery_session_id IS NULL/i.test(
      trimmed,
    )
  ) {
    const [user_id, session_id] = params as [string, string];
    const candidates = fakePurchases
      .filter(
        (p) =>
          p.user_id === user_id && p.recovery_session_id === null && p.refunded_at === null,
      )
      .sort((a, b) => b.purchased_at.getTime() - a.purchased_at.getTime());
    if (candidates.length === 0) return { rows: [], rowCount: 0 };
    candidates[0]!.recovery_session_id = session_id;
    return { rows: [{ id: candidates[0]!.id }], rowCount: 1 };
  }

  // hasRecoveryPlus step 2 — exact (user, session, refunded_at IS NULL) match.
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

  // --------------- wire_trace_cases ---------------

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
      id: `00000000-0000-0000-1000-${String(nextWireCaseSeq++).padStart(12, '0')}`,
      user_id,
      recovery_session_id,
      source_bank,
      destination_account_hint,
      wire_amount_cents:
        typeof wire_amount_cents === 'bigint' ? wire_amount_cents : BigInt(wire_amount_cents),
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

  // --------------- crypto_trace_cases ---------------

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
      id: `00000000-0000-0000-2000-${String(nextCryptoCaseSeq++).padStart(12, '0')}`,
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
    const row = fakeCryptoCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    row.hops_analyzed = hops_analyzed;
    row.exchange_tagged = exchange_tagged;
    row.trace_report_jsonb = JSON.parse(trace_report_jsonb);
    row.state = state as FakeCryptoCase['state'];
    row.state_changed_at = new Date();
    return { rows: [], rowCount: 1 };
  }

  if (
    /^UPDATE crypto_trace_cases SET petition_text = \$1, state = 'petition_drafted'/i.test(trimmed)
  ) {
    const [petition_text, case_id, user_id] = params as [string, string, string];
    const row = fakeCryptoCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    row.petition_text = petition_text;
    row.state = 'petition_drafted';
    row.state_changed_at = new Date();
    return { rows: [], rowCount: 1 };
  }

  if (/^UPDATE crypto_trace_cases SET state = \$1, state_changed_at = NOW\(\)/i.test(trimmed)) {
    const [state, case_id, user_id] = params as [string, string, string];
    const row = fakeCryptoCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    row.state = state;
    row.state_changed_at = new Date();
    return { rows: [], rowCount: 1 };
  }

  // --------------- legal_documents ---------------

  if (/^INSERT INTO legal_documents/i.test(trimmed)) {
    const [user_id, recovery_session_id, doc_kind, state_jurisdiction, body_markdown] =
      params as [string, string, string, string | null, string];
    const row: FakeLegalDocument = {
      id: `00000000-0000-0000-3000-${String(nextLegalDocSeq++).padStart(12, '0')}`,
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

  // --------------- specialists ---------------

  if (
    /^SELECT id, display_name, category, jurisdictions, capabilities, commission_pct, contact_email, contact_phone, bar_number, status, vetted_at, vetted_by, notes, created_at FROM specialists WHERE/i.test(
      trimmed,
    )
  ) {
    // getSpecialist path
    if (/WHERE id = \$1 AND status = 'active'/i.test(trimmed)) {
      const [id] = params as [string];
      const row = fakeSpecialists.find((s) => s.id === id && s.status === 'active');
      return row ? { rows: [specialistRowOut(row)], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // listSpecialistsFor path — dynamic predicate fragments.
    let pos = 0;
    let categoryFilter: string | null = null;
    let jurisdictionFilter: string | null = null;
    let capabilitiesFilter: string[] | null = null;
    if (/category = \$/.test(trimmed)) categoryFilter = params[pos++] as string;
    if (/= ANY\(jurisdictions\)/.test(trimmed)) jurisdictionFilter = params[pos++] as string;
    if (/capabilities @> \$/.test(trimmed)) capabilitiesFilter = params[pos++] as string[];
    const limit = params[pos++] as number;

    let candidates = fakeSpecialists.filter((s) => s.status === 'active');
    if (categoryFilter) candidates = candidates.filter((s) => s.category === categoryFilter);
    if (jurisdictionFilter) {
      candidates = candidates.filter((s) => s.jurisdictions.includes(jurisdictionFilter!));
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

  // createReferral category lookup
  if (/^SELECT category FROM specialists WHERE id = \$1 AND status = 'active'/i.test(trimmed)) {
    const [id] = params as [string];
    const row = fakeSpecialists.find((s) => s.id === id && s.status === 'active');
    return row ? { rows: [{ category: row.category }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // recovery_sessions ownership check (createReferral)
  if (/^SELECT 1 AS exists_marker FROM recovery_sessions WHERE id = \$1 AND user_id = \$2/i.test(trimmed)) {
    const [id, user_id] = params as [string, string];
    const row = fakeSessions.find((s) => s.id === id && s.user_id === user_id);
    return row ? { rows: [{ exists_marker: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // specialist_referrals dedupe SELECT
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

  // specialist_referrals INSERT
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

  // listReferralsForUser — with session
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
  // listReferralsForUser — no session
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

  throw new Error(`unstubbed SQL: ${trimmed.slice(0, 200)}`);
};

// ----------------------------------------------------------------
// Apple JWS verifier stub — patch the SDK's prototype method so
// purchaseRecoveryPlus → verifyAppleTransactionJws → SignedDataVerifier
// returns synthetic data without touching certs or network.
// ----------------------------------------------------------------

interface StubAppleTx {
  transactionId: string;
  productId: string;
  bundleId: string;
  environment: string;
  purchaseDate: number;
}

let stubAppleTxOverride: Partial<StubAppleTx> | 'throw' | null = null;

const SDK = appleSdk as unknown as { SignedDataVerifier: { prototype: Record<string, unknown> } };
const originalVerify = SDK.SignedDataVerifier.prototype.verifyAndDecodeTransaction;

function installAppleStub() {
  SDK.SignedDataVerifier.prototype.verifyAndDecodeTransaction = async function (_jws: string) {
    if (stubAppleTxOverride === 'throw') {
      throw new Error('synthetic verifier failure');
    }
    const o = stubAppleTxOverride ?? {};
    return {
      transactionId: o.transactionId ?? 'tx-route-test-100001',
      originalTransactionId: o.transactionId ?? 'tx-route-test-100001',
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
// LLM fetch stub — capture every Anthropic call and return a
// deterministic body. Letter / petition / legal-doc generators all
// route through callLLM → fetch(api.anthropic.com).
// ----------------------------------------------------------------

const originalFetch = globalThis.fetch;
let lastLlmCallCount = 0;

function installFetchStub() {
  lastLlmCallCount = 0;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const u = typeof url === 'string' ? url : (url as { toString(): string }).toString();
    if (u.includes('api.anthropic.com')) {
      lastLlmCallCount++;
      // Parse the model's user prompt to detect which generator called.
      // legalPacketGenerator asks for JSON { body_markdown }; the wire /
      // petition generators expect plain text. Sniff via the system
      // prompt content.
      const body = init?.body ?? '';
      // legalPacketGenerator prompts contain the literal substring
      // `Return JSON: { "body_markdown":` in their system prompt. After
      // callLLM's JSON.stringify, the embedded double-quotes become
      // backslash-escaped — so we match both shapes.
      const wantsJsonBody =
        /\\"body_markdown\\":/.test(body) || /"body_markdown":/.test(body);
      const responseText = wantsJsonBody
        ? JSON.stringify({
            body_markdown:
              '> **LEGAL DISCLAIMER**\n>\n> AegisDial is not your attorney. Stub legal-doc body.\n\n# Stub generated doc\n\nBody.',
          })
        : 'NOTE: This draft is a starting template. Consult your bank\'s fraud department or a licensed attorney before sending.\n\nDear Fraud Department,\n\n[stub LLM body]\n';
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

function entitleUser(user_id: string, recovery_session_id: string | null = SESSION_A): void {
  fakePurchases.push({
    id: `pur-${nextPurchaseSeq++}`,
    user_id,
    recovery_session_id,
    apple_transaction_id: `tx-seed-${user_id}-${recovery_session_id ?? 'null'}-${nextPurchaseSeq}`,
    refunded_at: null,
    purchased_at: new Date(),
  });
}

function seedSpecialist(opts: Partial<FakeSpecialist> = {}): FakeSpecialist {
  const s: FakeSpecialist = {
    id: opts.id ?? SPECIALIST_ID,
    display_name: opts.display_name ?? 'Acme Asset Recovery LLP',
    category: opts.category ?? 'asset_recovery_attorney',
    jurisdictions: opts.jurisdictions ?? ['US-FL', 'US-CA'],
    capabilities: opts.capabilities ?? ['wire_recall', 'crypto'],
    commission_pct: opts.commission_pct ?? '10.00',
    contact_email: opts.contact_email ?? 'intake@acme.example',
    contact_phone: opts.contact_phone ?? null,
    bar_number: opts.bar_number ?? 'FL-12345',
    status: opts.status ?? 'active',
    vetted_at: opts.vetted_at ?? new Date(),
    vetted_by: opts.vetted_by ?? null,
    notes: opts.notes ?? null,
    created_at: opts.created_at ?? new Date(),
  };
  fakeSpecialists.push(s);
  return s;
}

function seedSession(user_id: string, session_id: string): void {
  if (!fakeSessions.some((s) => s.id === session_id)) {
    fakeSessions.push({ id: session_id, user_id });
  }
}

beforeEach(() => {
  fakePurchases = [];
  fakeWireCases = [];
  fakeCryptoCases = [];
  fakeLegalDocs = [];
  fakeSpecialists = [];
  fakeReferrals = [];
  fakeSessions = [];
  nextPurchaseSeq = 1;
  nextWireCaseSeq = 1;
  nextCryptoCaseSeq = 1;
  nextLegalDocSeq = 1;
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

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(fastifyRateLimit, { global: false, max: 9999, timeWindow: '1 minute' });
  await app.register(recoveryShieldRoutes);
  return app;
}

// ================================================================
// AUTH / TIER gating — every route family
// ================================================================

describe('Recovery Shield routes — 401 without bearer', () => {
  const ROUTES: Array<{ method: 'GET' | 'POST'; url: string; payload?: unknown }> = [
    { method: 'POST', url: '/v1/recovery/plus/purchase' },
    { method: 'GET', url: `/v1/recovery/plus/status?recovery_session_id=${SESSION_A}` },
    { method: 'POST', url: '/v1/recovery/trace/wire' },
    { method: 'GET', url: `/v1/recovery/trace/wire/00000000-0000-0000-1000-000000000001?recovery_session_id=${SESSION_A}` },
    { method: 'POST', url: '/v1/recovery/trace/wire/00000000-0000-0000-1000-000000000001/advance' },
    { method: 'POST', url: '/v1/recovery/trace/wire/00000000-0000-0000-1000-000000000001/letter' },
    { method: 'POST', url: '/v1/recovery/trace/crypto' },
    { method: 'GET', url: `/v1/recovery/trace/crypto/00000000-0000-0000-2000-000000000001?recovery_session_id=${SESSION_A}` },
    { method: 'POST', url: '/v1/recovery/trace/crypto/00000000-0000-0000-2000-000000000001/hops' },
    { method: 'POST', url: '/v1/recovery/trace/crypto/00000000-0000-0000-2000-000000000001/petition' },
    { method: 'POST', url: '/v1/recovery/trace/crypto/00000000-0000-0000-2000-000000000001/advance' },
    { method: 'POST', url: '/v1/recovery/documents/generate' },
    { method: 'GET', url: '/v1/recovery/documents' },
    { method: 'GET', url: '/v1/recovery/documents/00000000-0000-0000-3000-000000000001' },
    { method: 'GET', url: '/v1/recovery/specialists' },
    { method: 'GET', url: `/v1/recovery/specialists/${SPECIALIST_ID}` },
    { method: 'POST', url: '/v1/recovery/specialists/refer' },
    { method: 'GET', url: '/v1/recovery/referrals' },
  ];
  for (const r of ROUTES) {
    it(`401 without bearer: ${r.method} ${r.url}`, async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({ method: r.method, url: r.url, payload: r.payload });
        assert.equal(res.statusCode, 401);
      } finally {
        await app.close();
      }
    });
  }
});

describe('Recovery Shield routes — invalid token → 401', () => {
  // ALLOW_DEV_BEARER maps the shared secret to a synthetic Pro user.
  // An invalid-token path returns 401 (the 402 Pro-tier gate only fires
  // when the token *is* valid but the user isn't paid — that branch is
  // exercised in production with real JWTs and unit-tested in the
  // upstream `requireProTier` test suite).
  const ROUTES: Array<{ method: 'GET' | 'POST'; url: string }> = [
    { method: 'POST', url: '/v1/recovery/plus/purchase' },
    { method: 'GET', url: '/v1/recovery/documents' },
    { method: 'GET', url: '/v1/recovery/specialists' },
  ];
  for (const r of ROUTES) {
    it(`401 with invalid token: ${r.method} ${r.url}`, async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: r.method,
          url: r.url,
          headers: { authorization: 'Bearer not-a-real-token' },
        });
        assert.equal(res.statusCode, 401);
      } finally {
        await app.close();
      }
    });
  }
});

// ================================================================
// POST /v1/recovery/plus/purchase
// ================================================================

describe('POST /v1/recovery/plus/purchase', () => {
  it('happy path → 201 + purchase_id + is_new=true', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/plus/purchase',
        headers: { authorization: PRO_BEARER },
        payload: {
          apple_receipt: 'a'.repeat(64),
          apple_transaction_id: 'tx-route-test-100001',
          recovery_session_id: SESSION_A,
          purchase_amount_cents: 24900,
        },
      });
      assert.equal(res.statusCode, 201);
      const body = res.json() as { purchase_id: string; is_new: boolean; entitled_session_id: string };
      assert.equal(body.is_new, true);
      assert.equal(body.entitled_session_id, SESSION_A);
      assert.ok(body.purchase_id);
      assert.equal(fakePurchases.length, 1);
    } finally {
      await app.close();
    }
  });

  it('replay → 200 + is_new=false (idempotent)', async () => {
    const app = await buildApp();
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/v1/recovery/plus/purchase',
        headers: { authorization: PRO_BEARER },
        payload: {
          apple_receipt: 'a'.repeat(64),
          apple_transaction_id: 'tx-route-test-100001',
          recovery_session_id: SESSION_A,
          purchase_amount_cents: 24900,
        },
      });
      assert.equal(first.statusCode, 201);
      const firstBody = first.json() as { purchase_id: string };
      const second = await app.inject({
        method: 'POST',
        url: '/v1/recovery/plus/purchase',
        headers: { authorization: PRO_BEARER },
        payload: {
          apple_receipt: 'a'.repeat(64),
          apple_transaction_id: 'tx-route-test-100001',
          recovery_session_id: SESSION_A,
          purchase_amount_cents: 24900,
        },
      });
      assert.equal(second.statusCode, 200);
      const secondBody = second.json() as { purchase_id: string; is_new: boolean };
      assert.equal(secondBody.is_new, false);
      assert.equal(secondBody.purchase_id, firstBody.purchase_id);
      assert.equal(fakePurchases.length, 1, 'no duplicate row inserted');
    } finally {
      await app.close();
    }
  });

  it('invalid price → 400', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/plus/purchase',
        headers: { authorization: PRO_BEARER },
        payload: {
          apple_receipt: 'a'.repeat(64),
          apple_transaction_id: 'tx-route-test-100002',
          recovery_session_id: SESSION_A,
          purchase_amount_cents: 100, // not 24900
        },
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { error: string }).error, 'invalid_price');
    } finally {
      await app.close();
    }
  });

  it('invalid body (missing apple_receipt) → 400', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/plus/purchase',
        headers: { authorization: PRO_BEARER },
        payload: {
          apple_transaction_id: 'tx-route-test-100003',
          purchase_amount_cents: 24900,
        },
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { error: string }).error, 'invalid_body');
    } finally {
      await app.close();
    }
  });

  it('wrong productId → 400 invalid_product', async () => {
    const app = await buildApp();
    try {
      stubAppleTxOverride = { productId: 'com.aegisdial.app.pro.monthly' };
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/plus/purchase',
        headers: { authorization: PRO_BEARER },
        payload: {
          apple_receipt: 'a'.repeat(64),
          apple_transaction_id: 'tx-route-test-100004',
          recovery_session_id: SESSION_A,
          purchase_amount_cents: 24900,
        },
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { error: string }).error, 'invalid_product');
    } finally {
      await app.close();
    }
  });

  it('verifier failure → 400 receipt_verification_failed', async () => {
    const app = await buildApp();
    try {
      stubAppleTxOverride = 'throw';
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/plus/purchase',
        headers: { authorization: PRO_BEARER },
        payload: {
          apple_receipt: 'a'.repeat(64),
          apple_transaction_id: 'tx-route-test-100005',
          recovery_session_id: SESSION_A,
          purchase_amount_cents: 24900,
        },
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { error: string }).error, 'receipt_verification_failed');
    } finally {
      await app.close();
    }
  });

  // R-H3 adversarial-review — cross-user replay of an
  // apple_transaction_id must NOT silently return the original owner's
  // purchase_id. Threat model: a leaked / log-mined JWS receipt is
  // attempted by a second user who has somehow obtained it. The route
  // layer's cross-user check fires AFTER purchaseRecoveryPlus returns
  // is_new=false, refusing to surface the canonical row to the wrong
  // caller and emitting a metric for the operator dashboard.
  it('cross-user replay → 409 transaction_id_already_used', async () => {
    const app = await buildApp();
    try {
      // Seed an existing purchase belonging to OTHER_USER_ID — the
      // synthetic dev bearer in this test maps to SYNTHETIC_USER_ID.
      fakePurchases.push({
        id: 'pur-cross-1',
        user_id: OTHER_USER_ID,
        recovery_session_id: SESSION_A,
        apple_transaction_id: 'tx-cross-user-replay-1',
        refunded_at: null,
        purchased_at: new Date(),
      });
      stubAppleTxOverride = { transactionId: 'tx-cross-user-replay-1' };

      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/plus/purchase',
        headers: { authorization: PRO_BEARER },
        payload: {
          apple_receipt: 'a'.repeat(64),
          apple_transaction_id: 'tx-cross-user-replay-1',
          recovery_session_id: SESSION_B,
          purchase_amount_cents: 24900,
        },
      });
      assert.equal(res.statusCode, 409);
      const body = res.json() as { error: string };
      assert.equal(body.error, 'transaction_id_already_used');

      // Adversarial follow-up: user B (the caller) must NOT be
      // entitled on ANY session as a side effect of the failed replay.
      // We probe via GET /plus/status — for both the original session
      // and an unrelated one.
      const statusA = await app.inject({
        method: 'GET',
        url: `/v1/recovery/plus/status?recovery_session_id=${SESSION_A}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(statusA.statusCode, 200);
      assert.deepEqual(statusA.json(), { entitled: false });

      const statusB = await app.inject({
        method: 'GET',
        url: `/v1/recovery/plus/status?recovery_session_id=${SESSION_B}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(statusB.statusCode, 200);
      assert.deepEqual(statusB.json(), { entitled: false });

      // Sanity: no duplicate row got inserted.
      assert.equal(fakePurchases.length, 1);
      assert.equal(fakePurchases[0]!.user_id, OTHER_USER_ID);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// GET /v1/recovery/plus/status
// ================================================================

describe('GET /v1/recovery/plus/status', () => {
  it('entitled=true when a purchase exists for this session', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/plus/status?recovery_session_id=${SESSION_A}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { entitled: true });
    } finally {
      await app.close();
    }
  });

  it('entitled=false when no purchase for this session', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/plus/status?recovery_session_id=${SESSION_B}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { entitled: false });
    } finally {
      await app.close();
    }
  });

  it('invalid query (non-UUID session) → 400', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/recovery/plus/status?recovery_session_id=not-a-uuid',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// POST /v1/recovery/trace/wire
// ================================================================

describe('POST /v1/recovery/trace/wire', () => {
  it('happy path → 201 + intake state', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/trace/wire',
        headers: { authorization: PRO_BEARER },
        payload: {
          source_bank: 'Chase',
          destination_account_hint: '1234',
          wire_amount_cents: 5_000_000,
          wire_sent_at: '2026-05-01T00:00:00Z',
          recovery_session_id: SESSION_A,
        },
      });
      assert.equal(res.statusCode, 201);
      const body = res.json() as { case_id: string; state: string };
      assert.equal(body.state, 'intake');
      assert.ok(body.case_id);
      assert.equal(fakeWireCases.length, 1);
      // destination_account_hint envelope-encrypted at rest.
      const stored = fakeWireCases[0]!;
      assert.ok(stored.destination_account_hint?.startsWith('v1:'));
      assert.equal(crypto.decryptString(stored.destination_account_hint!), '1234');
    } finally {
      await app.close();
    }
  });

  it('without Recovery Plus → 402 recovery_plus_required', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/trace/wire',
        headers: { authorization: PRO_BEARER },
        payload: {
          source_bank: 'Chase',
          wire_amount_cents: 5_000_000,
          wire_sent_at: '2026-05-01T00:00:00Z',
          recovery_session_id: SESSION_B, // no entitlement
        },
      });
      assert.equal(res.statusCode, 402);
      assert.equal((res.json() as { error: string }).error, 'recovery_plus_required');
    } finally {
      await app.close();
    }
  });

  it('invalid body (missing wire_amount_cents) → 400', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/trace/wire',
        headers: { authorization: PRO_BEARER },
        payload: {
          source_bank: 'Chase',
          wire_sent_at: '2026-05-01T00:00:00Z',
          recovery_session_id: SESSION_A,
        },
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { error: string }).error, 'invalid_body');
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// GET /v1/recovery/trace/wire/:case_id
// ================================================================

async function seedWireCase(user_id: string, session_id: string): Promise<string> {
  // Direct INSERT — bypass the route to avoid double-entanglement.
  const row: FakeWireCase = {
    id: `00000000-0000-0000-1000-${String(nextWireCaseSeq++).padStart(12, '0')}`,
    user_id,
    recovery_session_id: session_id,
    source_bank: 'Chase',
    destination_account_hint: crypto.encryptString('1234'),
    wire_amount_cents: 5_000_000n,
    wire_sent_at: new Date('2026-05-01T00:00:00Z'),
    state: 'intake',
    dispute_letter_text: null,
    bank_response_text: null,
    state_changed_at: new Date(),
    created_at: new Date(),
  };
  fakeWireCases.push(row);
  return row.id;
}

describe('GET /v1/recovery/trace/wire/:case_id', () => {
  it('happy path → 200 with decrypted destination_account_hint', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const case_id = await seedWireCase(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/trace/wire/${case_id}?recovery_session_id=${SESSION_A}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { destination_account_hint: string; wire_amount_cents: string };
      assert.equal(body.destination_account_hint, '1234');
      assert.equal(body.wire_amount_cents, '5000000');
    } finally {
      await app.close();
    }
  });

  it('cross-user case_id → 404', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const case_id = await seedWireCase(OTHER_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/trace/wire/${case_id}?recovery_session_id=${SESSION_A}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  it('malformed case_id → 400', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/trace/wire/not-a-uuid?recovery_session_id=${SESSION_A}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// POST /v1/recovery/trace/wire/:case_id/advance
// ================================================================

describe('POST /v1/recovery/trace/wire/:case_id/advance', () => {
  it('legal transition intake → letter_drafted → 200', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const case_id = await seedWireCase(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/recovery/trace/wire/${case_id}/advance`,
        headers: { authorization: PRO_BEARER },
        payload: { next_state: 'letter_drafted', recovery_session_id: SESSION_A },
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as { state: string }).state, 'letter_drafted');
    } finally {
      await app.close();
    }
  });

  it('illegal transition intake → recalled → 409', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const case_id = await seedWireCase(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/recovery/trace/wire/${case_id}/advance`,
        headers: { authorization: PRO_BEARER },
        payload: { next_state: 'recalled', recovery_session_id: SESSION_A },
      });
      assert.equal(res.statusCode, 409);
      assert.equal((res.json() as { error: string }).error, 'invalid_state_transition');
    } finally {
      await app.close();
    }
  });

  it('non-existent case_id → 404', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/trace/wire/00000000-0000-0000-1000-999999999999/advance',
        headers: { authorization: PRO_BEARER },
        payload: { next_state: 'letter_drafted', recovery_session_id: SESSION_A },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// POST /v1/recovery/trace/wire/:case_id/letter
// ================================================================

describe('POST /v1/recovery/trace/wire/:case_id/letter', () => {
  it('happy path → 200 + plaintext letter, ciphertext stored', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const case_id = await seedWireCase(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/recovery/trace/wire/${case_id}/letter`,
        headers: { authorization: PRO_BEARER },
        payload: { recovery_session_id: SESSION_A },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { letter_text: string };
      assert.match(body.letter_text, /Fraud Department|starting template/i);
      // At-rest ciphertext.
      const row = fakeWireCases.find((c) => c.id === case_id)!;
      assert.ok(row.dispute_letter_text?.startsWith('v1:'));
      assert.ok(lastLlmCallCount >= 1, 'LLM was invoked');
    } finally {
      await app.close();
    }
  });

  it('without Plus (different session) → 402', async () => {
    const app = await buildApp();
    try {
      const case_id = await seedWireCase(SYNTHETIC_USER_ID, SESSION_B);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/recovery/trace/wire/${case_id}/letter`,
        headers: { authorization: PRO_BEARER },
        payload: { recovery_session_id: SESSION_B },
      });
      assert.equal(res.statusCode, 402);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// POST /v1/recovery/trace/crypto
// ================================================================

describe('POST /v1/recovery/trace/crypto', () => {
  it('happy path → 201 + intake', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/trace/crypto',
        headers: { authorization: PRO_BEARER },
        payload: {
          source_wallet: '0xVICTIM__________________________________1',
          destination_wallet: '0xSCAMMER_________________________________2',
          chain: 'ethereum',
          amount_native: '1000000000000000000',
          amount_usd_cents_at_send: 250000,
          recovery_session_id: SESSION_A,
        },
      });
      assert.equal(res.statusCode, 201);
      const body = res.json() as { case_id: string; state: string };
      assert.equal(body.state, 'intake');
      assert.equal(fakeCryptoCases.length, 1);
    } finally {
      await app.close();
    }
  });

  it('without Plus → 402', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/trace/crypto',
        headers: { authorization: PRO_BEARER },
        payload: {
          source_wallet: '0xVICTIM__________________________________1',
          destination_wallet: '0xSCAMMER_________________________________2',
          chain: 'ethereum',
          amount_native: '1',
          amount_usd_cents_at_send: 100,
          recovery_session_id: SESSION_B,
        },
      });
      assert.equal(res.statusCode, 402);
    } finally {
      await app.close();
    }
  });

  it('invalid chain → 400', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/trace/crypto',
        headers: { authorization: PRO_BEARER },
        payload: {
          source_wallet: '0xVICTIM__________________________________1',
          destination_wallet: '0xSCAMMER_________________________________2',
          chain: 'dogecoin', // not in CHAIN_NAMES
          amount_native: '1',
          amount_usd_cents_at_send: 100,
          recovery_session_id: SESSION_A,
        },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// GET /v1/recovery/trace/crypto/:case_id
// ================================================================

async function seedCryptoCase(opts: {
  user_id?: string;
  session_id?: string;
  state?: FakeCryptoCase['state'];
  exchange_tagged?: string | null;
}): Promise<string> {
  const row: FakeCryptoCase = {
    id: `00000000-0000-0000-2000-${String(nextCryptoCaseSeq++).padStart(12, '0')}`,
    user_id: opts.user_id ?? SYNTHETIC_USER_ID,
    recovery_session_id: opts.session_id ?? SESSION_A,
    source_wallet: '0xVICTIM',
    destination_wallet: '0xSCAMMER',
    chain: 'ethereum',
    amount_native: '1000000000000000000',
    amount_usd_cents_at_send: '250000',
    hops_analyzed: 0,
    exchange_tagged: opts.exchange_tagged ?? null,
    trace_report_jsonb: null,
    state: opts.state ?? 'intake',
    petition_text: null,
    state_changed_at: new Date(),
    created_at: new Date(),
  };
  fakeCryptoCases.push(row);
  return row.id;
}

describe('GET /v1/recovery/trace/crypto/:case_id', () => {
  it('happy → 200', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const case_id = await seedCryptoCase({});
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/trace/crypto/${case_id}?recovery_session_id=${SESSION_A}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as { state: string }).state, 'intake');
    } finally {
      await app.close();
    }
  });

  it('cross-user → 404', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const case_id = await seedCryptoCase({ user_id: OTHER_USER_ID });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/trace/crypto/${case_id}?recovery_session_id=${SESSION_A}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// POST /v1/recovery/trace/crypto/:case_id/hops
// ================================================================

describe('POST /v1/recovery/trace/crypto/:case_id/hops', () => {
  it('happy → walks hops (no API keys configured → 0 hops, state=tracing)', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const case_id = await seedCryptoCase({});
      const res = await app.inject({
        method: 'POST',
        url: `/v1/recovery/trace/crypto/${case_id}/hops`,
        headers: { authorization: PRO_BEARER },
        payload: { recovery_session_id: SESSION_A, max_hops: 1 },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { hops_analyzed: number; exchange_tagged: string | null };
      // chainFetch with no API keys returns []. We still execute the
      // happy-path query write (state='tracing' if no exchange tag).
      assert.equal(typeof body.hops_analyzed, 'number');
      assert.equal(body.exchange_tagged, null);
    } finally {
      await app.close();
    }
  });

  it('non-existent case_id → 404', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/trace/crypto/00000000-0000-0000-2000-999999999999/hops',
        headers: { authorization: PRO_BEARER },
        payload: { recovery_session_id: SESSION_A },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// POST /v1/recovery/trace/crypto/:case_id/petition
// ================================================================

describe('POST /v1/recovery/trace/crypto/:case_id/petition', () => {
  it('before exchange identified → 409 invalid_state_transition', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const case_id = await seedCryptoCase({});
      const res = await app.inject({
        method: 'POST',
        url: `/v1/recovery/trace/crypto/${case_id}/petition`,
        headers: { authorization: PRO_BEARER },
        payload: { recovery_session_id: SESSION_A },
      });
      assert.equal(res.statusCode, 409);
    } finally {
      await app.close();
    }
  });

  it('after exchange_identified → 200 with plaintext petition', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const case_id = await seedCryptoCase({
        state: 'exchange_identified',
        exchange_tagged: 'Binance Hot Wallet',
      });
      // Seed trace_report_jsonb so the prompt has data to render.
      const row = fakeCryptoCases.find((c) => c.id === case_id)!;
      row.trace_report_jsonb = { schema_version: 1, hops: [], exchange_path: [], halt_reason: 'exchange_identified', analyzed_at: new Date().toISOString() };

      const res = await app.inject({
        method: 'POST',
        url: `/v1/recovery/trace/crypto/${case_id}/petition`,
        headers: { authorization: PRO_BEARER },
        payload: { recovery_session_id: SESSION_A },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { petition_text: string };
      assert.match(body.petition_text, /Fraud Department|starting template/i);
      // At-rest ciphertext.
      const stored = fakeCryptoCases.find((c) => c.id === case_id)!;
      assert.ok(stored.petition_text?.startsWith('v1:'));
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// POST /v1/recovery/trace/crypto/:case_id/advance
// ================================================================

describe('POST /v1/recovery/trace/crypto/:case_id/advance', () => {
  it('legal transition intake → tracing → 200', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const case_id = await seedCryptoCase({});
      const res = await app.inject({
        method: 'POST',
        url: `/v1/recovery/trace/crypto/${case_id}/advance`,
        headers: { authorization: PRO_BEARER },
        payload: { next_state: 'tracing', recovery_session_id: SESSION_A },
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as { state: string }).state, 'tracing');
    } finally {
      await app.close();
    }
  });

  it('illegal transition intake → frozen → 409', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const case_id = await seedCryptoCase({});
      const res = await app.inject({
        method: 'POST',
        url: `/v1/recovery/trace/crypto/${case_id}/advance`,
        headers: { authorization: PRO_BEARER },
        payload: { next_state: 'frozen', recovery_session_id: SESSION_A },
      });
      assert.equal(res.statusCode, 409);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// POST /v1/recovery/documents/generate
// ================================================================

describe('POST /v1/recovery/documents/generate', () => {
  it('happy path → 201 with generated docs', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/documents/generate',
        headers: { authorization: PRO_BEARER },
        payload: {
          recovery_session_id: SESSION_A,
          doc_kinds: ['ic3_complaint', 'ftc_complaint'],
          user_acknowledged_disclaimer: true,
          case_facts: {
            scam_type: 'romance_scam',
            amount_lost_cents: 500_000,
            incident_date: '2026-05-01T00:00:00Z',
          },
        },
      });
      assert.equal(res.statusCode, 201);
      const body = res.json() as {
        generated: Array<{ document_id: string; doc_kind: string }>;
        skipped: Array<{ doc_kind: string; reason: string }>;
      };
      assert.equal(body.generated.length, 2);
      assert.equal(fakeLegalDocs.length, 2);
      // body stored as ciphertext.
      assert.ok(fakeLegalDocs[0]!.body_markdown.startsWith('v1:'));
    } finally {
      await app.close();
    }
  });

  it('disclaimer not acknowledged → 400', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/documents/generate',
        headers: { authorization: PRO_BEARER },
        payload: {
          recovery_session_id: SESSION_A,
          doc_kinds: ['ic3_complaint'],
          user_acknowledged_disclaimer: false,
          case_facts: {
            scam_type: 'romance_scam',
            amount_lost_cents: 500_000,
            incident_date: '2026-05-01T00:00:00Z',
          },
        },
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { error: string }).error, 'disclaimer_not_acknowledged');
    } finally {
      await app.close();
    }
  });

  it('without Plus → 402', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/documents/generate',
        headers: { authorization: PRO_BEARER },
        payload: {
          recovery_session_id: SESSION_B,
          doc_kinds: ['ic3_complaint'],
          user_acknowledged_disclaimer: true,
          case_facts: {
            scam_type: 'romance_scam',
            amount_lost_cents: 500_000,
            incident_date: '2026-05-01T00:00:00Z',
          },
        },
      });
      assert.equal(res.statusCode, 402);
    } finally {
      await app.close();
    }
  });

  it('invalid_body (missing case_facts) → 400', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/documents/generate',
        headers: { authorization: PRO_BEARER },
        payload: {
          recovery_session_id: SESSION_A,
          user_acknowledged_disclaimer: true,
        },
      });
      assert.equal(res.statusCode, 400);
      assert.equal((res.json() as { error: string }).error, 'invalid_body');
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// GET /v1/recovery/documents
// ================================================================

function seedLegalDoc(user_id: string, session_id: string, doc_kind = 'ic3_complaint'): string {
  const row: FakeLegalDocument = {
    id: `00000000-0000-0000-3000-${String(nextLegalDocSeq++).padStart(12, '0')}`,
    user_id,
    recovery_session_id: session_id,
    doc_kind,
    state_jurisdiction: null,
    body_markdown: crypto.encryptString('Stub markdown body'),
    pdf_url: null,
    generated_at: new Date(),
    user_acknowledged_disclaimer_at: new Date(),
  };
  fakeLegalDocs.push(row);
  return row.id;
}

describe('GET /v1/recovery/documents', () => {
  it('lists user-owned docs only', async () => {
    const app = await buildApp();
    try {
      seedLegalDoc(SYNTHETIC_USER_ID, SESSION_A, 'ic3_complaint');
      seedLegalDoc(SYNTHETIC_USER_ID, SESSION_A, 'ftc_complaint');
      seedLegalDoc(OTHER_USER_ID, SESSION_A, 'ic3_complaint');
      const res = await app.inject({
        method: 'GET',
        url: '/v1/recovery/documents',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { documents: Array<{ doc_kind: string; body_markdown: string }> };
      assert.equal(body.documents.length, 2);
      // Bodies decrypted in the DTO.
      assert.equal(body.documents[0]!.body_markdown, 'Stub markdown body');
    } finally {
      await app.close();
    }
  });

  it('filters by recovery_session_id', async () => {
    const app = await buildApp();
    try {
      seedLegalDoc(SYNTHETIC_USER_ID, SESSION_A);
      seedLegalDoc(SYNTHETIC_USER_ID, SESSION_B);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/documents?recovery_session_id=${SESSION_A}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { documents: Array<{ recovery_session_id: string }> };
      assert.equal(body.documents.length, 1);
      assert.equal(body.documents[0]!.recovery_session_id, SESSION_A);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// GET /v1/recovery/documents/:document_id
// ================================================================

describe('GET /v1/recovery/documents/:document_id', () => {
  it('happy → 200 with decrypted body', async () => {
    const app = await buildApp();
    try {
      const doc_id = seedLegalDoc(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/documents/${doc_id}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as { body_markdown: string }).body_markdown, 'Stub markdown body');
    } finally {
      await app.close();
    }
  });

  it('cross-user → 404', async () => {
    const app = await buildApp();
    try {
      const doc_id = seedLegalDoc(OTHER_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/documents/${doc_id}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  it('malformed document_id → 400', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/recovery/documents/not-a-uuid',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// GET /v1/recovery/specialists
// ================================================================

describe('GET /v1/recovery/specialists', () => {
  it('lists active specialists only', async () => {
    const app = await buildApp();
    try {
      seedSpecialist({ id: SPECIALIST_ID, status: 'active' });
      seedSpecialist({ id: SPECIALIST_ID_INACTIVE, status: 'pending', display_name: 'Pending Co' });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/recovery/specialists',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { specialists: Array<{ id: string }> };
      assert.equal(body.specialists.length, 1);
      assert.equal(body.specialists[0]!.id, SPECIALIST_ID);
    } finally {
      await app.close();
    }
  });

  it('filters by category', async () => {
    const app = await buildApp();
    try {
      seedSpecialist({ id: SPECIALIST_ID, category: 'asset_recovery_attorney' });
      seedSpecialist({
        id: SPECIALIST_ID_OTHER,
        category: 'blockchain_forensics',
        display_name: 'Chain Forensics LLC',
      });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/recovery/specialists?category=blockchain_forensics',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { specialists: Array<{ id: string; category: string }> };
      assert.equal(body.specialists.length, 1);
      assert.equal(body.specialists[0]!.category, 'blockchain_forensics');
    } finally {
      await app.close();
    }
  });

  it('filters by capabilities', async () => {
    const app = await buildApp();
    try {
      seedSpecialist({ id: SPECIALIST_ID, capabilities: ['wire_recall', 'crypto'] });
      seedSpecialist({
        id: SPECIALIST_ID_OTHER,
        capabilities: ['wire_recall'],
        display_name: 'Wire Only Co',
      });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/recovery/specialists?capabilities=crypto',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { specialists: Array<{ id: string }> };
      assert.equal(body.specialists.length, 1);
      assert.equal(body.specialists[0]!.id, SPECIALIST_ID);
    } finally {
      await app.close();
    }
  });

  it('invalid query (bad jurisdiction) → 400', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/recovery/specialists?jurisdiction=lowercase',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// GET /v1/recovery/specialists/:specialist_id
// ================================================================

describe('GET /v1/recovery/specialists/:specialist_id', () => {
  it('happy → 200', async () => {
    const app = await buildApp();
    try {
      seedSpecialist({ id: SPECIALIST_ID });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/specialists/${SPECIALIST_ID}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as { id: string }).id, SPECIALIST_ID);
    } finally {
      await app.close();
    }
  });

  // R-M1 adversarial-review — the admin-only `notes` column MUST NOT
  // leak through the user-facing single-specialist GET. Migration 066
  // documents `notes` as admin-only (operational scoring + vetting
  // commentary). The list route already omits it; this asserts the
  // single GET matches.
  it('does NOT include the admin-only `notes` field in the response', async () => {
    const app = await buildApp();
    try {
      seedSpecialist({
        id: SPECIALIST_ID,
        notes: 'INTERNAL ONLY: this firm pays out fast; bumped to A-tier.',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/specialists/${SPECIALIST_ID}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as Record<string, unknown>;
      assert.ok(!('notes' in body), '`notes` must not appear in the response body');
      // Make sure the rest of the shape is preserved.
      assert.equal(body.id, SPECIALIST_ID);
      assert.ok('display_name' in body);
      assert.ok('commission_pct' in body);
    } finally {
      await app.close();
    }
  });

  it('non-existent → 404', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/specialists/${SPECIALIST_ID}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  it('inactive specialist → 404', async () => {
    const app = await buildApp();
    try {
      seedSpecialist({ id: SPECIALIST_ID_INACTIVE, status: 'pending' });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/specialists/${SPECIALIST_ID_INACTIVE}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  it('malformed specialist_id → 400', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/recovery/specialists/not-a-uuid',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// POST /v1/recovery/specialists/refer
// ================================================================

describe('POST /v1/recovery/specialists/refer', () => {
  it('happy → 201', async () => {
    const app = await buildApp();
    try {
      seedSpecialist({ id: SPECIALIST_ID });
      seedSession(SYNTHETIC_USER_ID, SESSION_A);
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/specialists/refer',
        headers: { authorization: PRO_BEARER },
        payload: {
          specialist_id: SPECIALIST_ID,
          recovery_session_id: SESSION_A,
        },
      });
      assert.equal(res.statusCode, 201);
      assert.ok((res.json() as { referral_id: string }).referral_id);
      assert.equal(fakeReferrals.length, 1);
    } finally {
      await app.close();
    }
  });

  it('without Plus → 402', async () => {
    const app = await buildApp();
    try {
      seedSpecialist({ id: SPECIALIST_ID });
      seedSession(SYNTHETIC_USER_ID, SESSION_B);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/specialists/refer',
        headers: { authorization: PRO_BEARER },
        payload: {
          specialist_id: SPECIALIST_ID,
          recovery_session_id: SESSION_B,
        },
      });
      assert.equal(res.statusCode, 402);
    } finally {
      await app.close();
    }
  });

  it('inactive specialist → 404', async () => {
    const app = await buildApp();
    try {
      seedSpecialist({ id: SPECIALIST_ID_INACTIVE, status: 'pending' });
      seedSession(SYNTHETIC_USER_ID, SESSION_A);
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/specialists/refer',
        headers: { authorization: PRO_BEARER },
        payload: {
          specialist_id: SPECIALIST_ID_INACTIVE,
          recovery_session_id: SESSION_A,
        },
      });
      assert.equal(res.statusCode, 404);
      assert.equal((res.json() as { error: string }).error, 'specialist_not_available');
    } finally {
      await app.close();
    }
  });

  it('cross-user recovery_session → 404 recovery_session_not_found', async () => {
    const app = await buildApp();
    try {
      seedSpecialist({ id: SPECIALIST_ID });
      // Session belongs to OTHER_USER_ID, not the caller.
      seedSession(OTHER_USER_ID, SESSION_A);
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/specialists/refer',
        headers: { authorization: PRO_BEARER },
        payload: {
          specialist_id: SPECIALIST_ID,
          recovery_session_id: SESSION_A,
        },
      });
      assert.equal(res.statusCode, 404);
      assert.equal((res.json() as { error: string }).error, 'recovery_session_not_found');
    } finally {
      await app.close();
    }
  });

  it('invalid body → 400', async () => {
    const app = await buildApp();
    try {
      entitleUser(SYNTHETIC_USER_ID, SESSION_A);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/specialists/refer',
        headers: { authorization: PRO_BEARER },
        payload: { recovery_session_id: SESSION_A }, // missing specialist_id
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

// ================================================================
// GET /v1/recovery/referrals
// ================================================================

function seedReferral(opts: Partial<FakeReferral> & { user_id: string; specialist_id: string; recovery_session_id: string }): FakeReferral {
  const r: FakeReferral = {
    id: `00000000-0000-0000-4000-${String(nextReferralSeq++).padStart(12, '0')}`,
    user_id: opts.user_id,
    specialist_id: opts.specialist_id,
    recovery_session_id: opts.recovery_session_id,
    referred_at: opts.referred_at ?? new Date(),
    specialist_acknowledged_at: opts.specialist_acknowledged_at ?? null,
    engagement_status: opts.engagement_status ?? 'referred',
    fee_owed_cents: opts.fee_owed_cents ?? null,
    fee_paid_at: opts.fee_paid_at ?? null,
    outcome_notes: opts.outcome_notes ?? null,
  };
  fakeReferrals.push(r);
  return r;
}

describe('GET /v1/recovery/referrals', () => {
  it('lists user-owned referrals only', async () => {
    const app = await buildApp();
    try {
      seedReferral({
        user_id: SYNTHETIC_USER_ID,
        specialist_id: SPECIALIST_ID,
        recovery_session_id: SESSION_A,
      });
      seedReferral({
        user_id: OTHER_USER_ID,
        specialist_id: SPECIALIST_ID,
        recovery_session_id: SESSION_A,
      });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/recovery/referrals',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { referrals: Array<{ specialist_id: string }> };
      assert.equal(body.referrals.length, 1);
    } finally {
      await app.close();
    }
  });

  it('filters by recovery_session_id', async () => {
    const app = await buildApp();
    try {
      seedReferral({
        user_id: SYNTHETIC_USER_ID,
        specialist_id: SPECIALIST_ID,
        recovery_session_id: SESSION_A,
      });
      seedReferral({
        user_id: SYNTHETIC_USER_ID,
        specialist_id: SPECIALIST_ID,
        recovery_session_id: SESSION_B,
      });
      const res = await app.inject({
        method: 'GET',
        url: `/v1/recovery/referrals?recovery_session_id=${SESSION_A}`,
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { referrals: Array<{ recovery_session_id: string }> };
      assert.equal(body.referrals.length, 1);
      assert.equal(body.referrals[0]!.recovery_session_id, SESSION_A);
    } finally {
      await app.close();
    }
  });

  it('invalid query (bad UUID) → 400', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/recovery/referrals?recovery_session_id=not-a-uuid',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});
