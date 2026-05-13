import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Recovery Shield — R-P6 — admin dashboard route tests.
//
// Mirrors test/adminEmailShield.test.ts: env BEFORE src/* imports,
// then swap pool.query with an SQL-prefix-matching fake. Routes are
// read-only — no mutations to assert beyond response shape.
//
// Coverage matrix per route:
//   - happy path (seeded fixture → asserted shape + values)
//   - empty data path (no rows → zeros / empty arrays, never NaN)
//   - missing bearer → 401 missing_bearer
//   - wrong bearer → 401 invalid_token
//   - PII-leak guard: response body contains NO user_id, email,
//     apple_transaction_id, encrypted column, or other per-user field

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-admin-recovery-shield-secret';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://admin-recovery-shield-test';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { adminRecoveryShieldRoutes } = await import(
  '../src/routes/adminRecoveryShield.ts'
);

const SHARED_SECRET = process.env.API_SHARED_SECRET!;

// -----------------------------------------------------------------
// In-memory DB state. Each test resets via resetDb().
// -----------------------------------------------------------------
interface PurchaseRow {
  purchase_amount_cents: number;
  purchased_at: Date;
  refunded_at: Date | null;
}
interface WireCaseRow {
  state: string;
  created_at: Date;
}
interface CryptoCaseRow {
  state: string;
  created_at: Date;
}
interface LegalDocRow {
  doc_kind: string;
  body_markdown: string;
  generated_at: Date;
  user_acknowledged_disclaimer_at: Date | null;
}
interface SpecialistRow {
  id: string;
  display_name: string;
  category: string;
}
interface ReferralRow {
  specialist_id: string;
  engagement_status: string;
  fee_owed_cents: number | null;
  fee_paid_at: Date | null;
  referred_at: Date;
}
interface DbState {
  purchases: PurchaseRow[];
  wire_cases: WireCaseRow[];
  crypto_cases: CryptoCaseRow[];
  legal_documents: LegalDocRow[];
  specialists: SpecialistRow[];
  referrals: ReferralRow[];
}

const dbState: DbState = {
  purchases: [],
  wire_cases: [],
  crypto_cases: [],
  legal_documents: [],
  specialists: [],
  referrals: [],
};

function resetDb(): void {
  dbState.purchases.length = 0;
  dbState.wire_cases.length = 0;
  dbState.crypto_cases.length = 0;
  dbState.legal_documents.length = 0;
  dbState.specialists.length = 0;
  dbState.referrals.length = 0;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 60 * 1000);
}

function utcMidnight(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

// -----------------------------------------------------------------
// SQL prefix matcher. Each route's query gets its own branch. Match
// the most specific signature first; fall through to swallow at the
// end.
// -----------------------------------------------------------------
const fakeQuery = async (
  text: string,
  _params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.replace(/\s+/g, ' ').trim();

  // ------------------- summary panel: purchases ----------------
  if (
    /FROM recovery_plus_purchases WHERE purchased_at >= NOW\(\) - INTERVAL '30 days' AND refunded_at IS NULL/i.test(
      t,
    ) &&
    /COUNT\(\*\)::TEXT\s+AS open_count/i.test(t)
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let count = 0;
    let revenue = 0;
    for (const p of dbState.purchases) {
      if (p.purchased_at.getTime() < cutoff) continue;
      if (p.refunded_at !== null) continue;
      count++;
      revenue += p.purchase_amount_cents;
    }
    return {
      rows: [{ open_count: String(count), revenue_cents: String(revenue) }],
      rowCount: 1,
    };
  }

  // ------------------- summary panel: wire cases by state ------
  if (
    /FROM wire_trace_cases WHERE created_at >= NOW\(\) - INTERVAL '365 days' GROUP BY state/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const counts: Record<string, number> = {};
    for (const c of dbState.wire_cases) {
      if (c.created_at.getTime() < cutoff) continue;
      counts[c.state] = (counts[c.state] ?? 0) + 1;
    }
    return {
      rows: Object.entries(counts).map(([state, count]) => ({
        state,
        count: String(count),
      })),
      rowCount: Object.keys(counts).length,
    };
  }

  // ------------------- summary panel: crypto cases by state ----
  if (
    /FROM crypto_trace_cases WHERE created_at >= NOW\(\) - INTERVAL '365 days' GROUP BY state/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const counts: Record<string, number> = {};
    for (const c of dbState.crypto_cases) {
      if (c.created_at.getTime() < cutoff) continue;
      counts[c.state] = (counts[c.state] ?? 0) + 1;
    }
    return {
      rows: Object.entries(counts).map(([state, count]) => ({
        state,
        count: String(count),
      })),
      rowCount: Object.keys(counts).length,
    };
  }

  // ------------------- summary panel: legal docs 30d count -----
  if (
    /SELECT COUNT\(\*\)::TEXT AS count FROM legal_documents WHERE generated_at >= NOW\(\) - INTERVAL '30 days'/i.test(
      t,
    ) &&
    !/AVG/i.test(t) &&
    !/date_trunc/i.test(t)
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let n = 0;
    for (const d of dbState.legal_documents) {
      if (d.generated_at.getTime() >= cutoff) n++;
    }
    return { rows: [{ count: String(n) }], rowCount: 1 };
  }

  // ------------------- summary panel: referrals by status ------
  if (
    /SELECT engagement_status, COUNT\(\*\)::TEXT AS count FROM specialist_referrals WHERE referred_at >= NOW\(\) - INTERVAL '30 days' GROUP BY engagement_status/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const counts: Record<string, number> = {};
    for (const r of dbState.referrals) {
      if (r.referred_at.getTime() < cutoff) continue;
      counts[r.engagement_status] = (counts[r.engagement_status] ?? 0) + 1;
    }
    return {
      rows: Object.entries(counts).map(([engagement_status, count]) => ({
        engagement_status,
        count: String(count),
      })),
      rowCount: Object.keys(counts).length,
    };
  }

  // ------------------- timeline: wire ---------------------------
  if (
    /date_trunc\('day', created_at AT TIME ZONE 'UTC'\) AS bucket.*FROM wire_trace_cases WHERE created_at >= NOW\(\) - INTERVAL '30 days'/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const buckets = new Map<string, { bucket: Date; count: number }>();
    for (const c of dbState.wire_cases) {
      if (c.created_at.getTime() < cutoff) continue;
      const d = utcMidnight(c.created_at);
      const key = d.toISOString();
      const slot = buckets.get(key) ?? { bucket: d, count: 0 };
      slot.count++;
      buckets.set(key, slot);
    }
    const rows = Array.from(buckets.values())
      .sort((a, b) => a.bucket.getTime() - b.bucket.getTime())
      .slice(0, 30)
      .map((b) => ({ bucket: b.bucket, count: String(b.count) }));
    return { rows, rowCount: rows.length };
  }

  // ------------------- timeline: crypto -------------------------
  if (
    /date_trunc\('day', created_at AT TIME ZONE 'UTC'\) AS bucket.*FROM crypto_trace_cases WHERE created_at >= NOW\(\) - INTERVAL '30 days'/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const buckets = new Map<string, { bucket: Date; count: number }>();
    for (const c of dbState.crypto_cases) {
      if (c.created_at.getTime() < cutoff) continue;
      const d = utcMidnight(c.created_at);
      const key = d.toISOString();
      const slot = buckets.get(key) ?? { bucket: d, count: 0 };
      slot.count++;
      buckets.set(key, slot);
    }
    const rows = Array.from(buckets.values())
      .sort((a, b) => a.bucket.getTime() - b.bucket.getTime())
      .slice(0, 30)
      .map((b) => ({ bucket: b.bucket, count: String(b.count) }));
    return { rows, rowCount: rows.length };
  }

  // ------------------- timeline: legal_documents ---------------
  if (
    /date_trunc\('day', generated_at AT TIME ZONE 'UTC'\) AS bucket.*FROM legal_documents WHERE generated_at >= NOW\(\) - INTERVAL '30 days'/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const buckets = new Map<string, { bucket: Date; count: number }>();
    for (const c of dbState.legal_documents) {
      if (c.generated_at.getTime() < cutoff) continue;
      const d = utcMidnight(c.generated_at);
      const key = d.toISOString();
      const slot = buckets.get(key) ?? { bucket: d, count: 0 };
      slot.count++;
      buckets.set(key, slot);
    }
    const rows = Array.from(buckets.values())
      .sort((a, b) => a.bucket.getTime() - b.bucket.getTime())
      .slice(0, 30)
      .map((b) => ({ bucket: b.bucket, count: String(b.count) }));
    return { rows, rowCount: rows.length };
  }

  // ------------------- timeline: referrals ---------------------
  if (
    /date_trunc\('day', referred_at AT TIME ZONE 'UTC'\) AS bucket.*FROM specialist_referrals WHERE referred_at >= NOW\(\) - INTERVAL '30 days'/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const buckets = new Map<string, { bucket: Date; count: number }>();
    for (const c of dbState.referrals) {
      if (c.referred_at.getTime() < cutoff) continue;
      const d = utcMidnight(c.referred_at);
      const key = d.toISOString();
      const slot = buckets.get(key) ?? { bucket: d, count: 0 };
      slot.count++;
      buckets.set(key, slot);
    }
    const rows = Array.from(buckets.values())
      .sort((a, b) => a.bucket.getTime() - b.bucket.getTime())
      .slice(0, 30)
      .map((b) => ({ bucket: b.bucket, count: String(b.count) }));
    return { rows, rowCount: rows.length };
  }

  // ------------------- specialist-performance ------------------
  if (
    /FROM specialists s JOIN specialist_referrals r ON r\.specialist_id = s\.id/i.test(
      t,
    ) &&
    /INTERVAL '90 days'/i.test(t)
  ) {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const bySpec = new Map<
      string,
      {
        spec: SpecialistRow;
        count: number;
        won: number;
        lost: number;
        fee_owed: number;
        fee_paid: number;
      }
    >();
    for (const r of dbState.referrals) {
      if (r.referred_at.getTime() < cutoff) continue;
      const spec = dbState.specialists.find((s) => s.id === r.specialist_id);
      if (!spec) continue;
      const slot = bySpec.get(spec.id) ?? {
        spec,
        count: 0,
        won: 0,
        lost: 0,
        fee_owed: 0,
        fee_paid: 0,
      };
      slot.count++;
      if (r.engagement_status === 'case_closed_won') slot.won++;
      if (r.engagement_status === 'case_closed_lost') slot.lost++;
      if (r.fee_owed_cents !== null) {
        slot.fee_owed += r.fee_owed_cents;
        if (r.fee_paid_at !== null) slot.fee_paid += r.fee_owed_cents;
      }
      bySpec.set(spec.id, slot);
    }
    const rows = Array.from(bySpec.values())
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.spec.display_name.localeCompare(b.spec.display_name);
      })
      .slice(0, 50)
      .map((s) => ({
        specialist_id: s.spec.id,
        display_name: s.spec.display_name,
        category: s.spec.category,
        referrals_count: String(s.count),
        case_closed_won_count: String(s.won),
        case_closed_lost_count: String(s.lost),
        fee_owed_total_cents: String(s.fee_owed),
        fee_paid_total_cents: String(s.fee_paid),
      }));
    return { rows, rowCount: rows.length };
  }

  // ------------------- document-quality ------------------------
  if (
    /SELECT doc_kind, COUNT\(\*\)::TEXT\s+AS generated_count, AVG\(length\(body_markdown\)\)/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const byKind = new Map<
      string,
      { count: number; lengths: number[]; ackd: number }
    >();
    for (const d of dbState.legal_documents) {
      if (d.generated_at.getTime() < cutoff) continue;
      const slot = byKind.get(d.doc_kind) ?? {
        count: 0,
        lengths: [],
        ackd: 0,
      };
      slot.count++;
      slot.lengths.push(d.body_markdown.length);
      if (d.user_acknowledged_disclaimer_at !== null) slot.ackd++;
      byKind.set(d.doc_kind, slot);
    }
    const rows = Array.from(byKind.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([doc_kind, v]) => {
        const avg =
          v.lengths.length === 0
            ? null
            : v.lengths.reduce((a, b) => a + b, 0) / v.lengths.length;
        return {
          doc_kind,
          generated_count: String(v.count),
          avg_body_length: avg === null ? null : String(avg),
          acknowledged_count: String(v.ackd),
        };
      });
    return { rows, rowCount: rows.length };
  }

  // ------------------- refund-rate ------------------------------
  if (
    /COUNT\(\*\) FILTER \(\s+WHERE refunded_at IS NOT NULL\s+AND refunded_at - purchased_at <= INTERVAL '24 hours'/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let total = 0;
    let refunded = 0;
    let within_24h = 0;
    let within_7d = 0;
    let after_7d = 0;
    for (const p of dbState.purchases) {
      if (p.purchased_at.getTime() < cutoff) continue;
      total++;
      if (p.refunded_at === null) continue;
      refunded++;
      const delta = p.refunded_at.getTime() - p.purchased_at.getTime();
      const H24 = 24 * 60 * 60 * 1000;
      const D7 = 7 * 24 * 60 * 60 * 1000;
      if (delta <= H24) within_24h++;
      else if (delta <= D7) within_7d++;
      else after_7d++;
    }
    return {
      rows: [
        {
          total: String(total),
          refunded: String(refunded),
          within_24h: String(within_24h),
          within_7d: String(within_7d),
          after_7d: String(after_7d),
        },
      ],
      rowCount: 1,
    };
  }

  // metric_counters INSERT from withAdminAudit — swallow.
  if (/INSERT\s+INTO\s+metric_counters/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }

  // Unknown — log for debugging without failing the run.
  // eslint-disable-next-line no-console
  if (process.env.DEBUG_ADMIN_TEST) console.warn('[unmatched SQL]', t.slice(0, 200));
  return { rows: [], rowCount: 0 };
};

(db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;

const app = Fastify({ logger: false });
await app.register(adminRecoveryShieldRoutes);
await app.ready();

const bearer = { authorization: `Bearer ${SHARED_SECRET}` };

// PII-leak guard: a recursive JSON walker. Asserts no per-user field
// keys appear anywhere in the response shape.
const FORBIDDEN_KEYS = new Set([
  'user_id',
  'email',
  'apple_transaction_id',
  'apple_receipt_data',
  'destination_account_hint',
  'dispute_letter_text',
  'bank_response_text',
  'petition_text',
  'body_markdown',
  'source_wallet',
  'destination_wallet',
  'contact_email',
  'contact_phone',
  'outcome_notes',
]);

function assertNoPii(value: unknown, path = '$'): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoPii(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) {
        assert.fail(`PII leak: forbidden key '${k}' at ${path}`);
      }
      assertNoPii(v, `${path}.${k}`);
    }
  }
}

before(() => {
  resetDb();
});
beforeEach(() => {
  resetDb();
});

// =================================================================
// 1. /v1/admin/recovery-shield/summary
// =================================================================
describe('GET /v1/admin/recovery-shield/summary', () => {
  it('returns aggregate counters across all five sub-panels with seeded data', async () => {
    dbState.purchases.push(
      // 30d, not refunded
      {
        purchase_amount_cents: 24900,
        purchased_at: daysAgo(2),
        refunded_at: null,
      },
      {
        purchase_amount_cents: 24900,
        purchased_at: daysAgo(5),
        refunded_at: null,
      },
      // 30d, refunded → excluded
      {
        purchase_amount_cents: 24900,
        purchased_at: daysAgo(3),
        refunded_at: daysAgo(2),
      },
      // > 30d → excluded
      {
        purchase_amount_cents: 24900,
        purchased_at: daysAgo(45),
        refunded_at: null,
      },
    );
    dbState.wire_cases.push(
      { state: 'intake', created_at: daysAgo(1) },
      { state: 'letter_drafted', created_at: daysAgo(2) },
      { state: 'user_sent', created_at: daysAgo(3) },
      { state: 'bank_acknowledged', created_at: daysAgo(4) },
      { state: 'recalled', created_at: daysAgo(5) },
      { state: 'denied', created_at: daysAgo(6) },
      { state: 'closed', created_at: daysAgo(7) },
    );
    dbState.crypto_cases.push(
      { state: 'intake', created_at: daysAgo(1) },
      { state: 'tracing', created_at: daysAgo(2) },
      { state: 'frozen', created_at: daysAgo(3) },
      { state: 'denied', created_at: daysAgo(4) },
    );
    dbState.legal_documents.push(
      {
        doc_kind: 'ic3_complaint',
        body_markdown: 'x'.repeat(1000),
        generated_at: daysAgo(1),
        user_acknowledged_disclaimer_at: daysAgo(1),
      },
      {
        doc_kind: 'ftc_complaint',
        body_markdown: 'x'.repeat(500),
        generated_at: daysAgo(2),
        user_acknowledged_disclaimer_at: null,
      },
      // >30d → excluded from generated_30d count
      {
        doc_kind: 'ic3_complaint',
        body_markdown: 'x'.repeat(500),
        generated_at: daysAgo(45),
        user_acknowledged_disclaimer_at: null,
      },
    );
    dbState.referrals.push(
      {
        specialist_id: 'spec-1',
        engagement_status: 'referred',
        fee_owed_cents: null,
        fee_paid_at: null,
        referred_at: daysAgo(1),
      },
      {
        specialist_id: 'spec-1',
        engagement_status: 'case_closed_won',
        fee_owed_cents: 10000,
        fee_paid_at: daysAgo(1),
        referred_at: daysAgo(20),
      },
      // >30d → excluded
      {
        specialist_id: 'spec-1',
        engagement_status: 'referred',
        fee_owed_cents: null,
        fee_paid_at: null,
        referred_at: daysAgo(45),
      },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/summary',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
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

    assert.equal(body.open_purchases_30d, 2, 'refunded + >30d excluded');
    assert.equal(body.total_revenue_30d_cents, 49800);
    assert.equal(body.wire_cases_by_state.intake, 1);
    assert.equal(body.wire_cases_by_state.letter_drafted, 1);
    assert.equal(body.wire_cases_by_state.user_sent, 1);
    assert.equal(body.wire_cases_by_state.bank_acknowledged, 1);
    assert.equal(body.wire_cases_by_state.recalled, 1);
    assert.equal(body.wire_cases_by_state.denied, 1);
    assert.equal(body.wire_cases_by_state.closed, 1);
    assert.equal(body.open_wire_cases, 4, 'intake+letter+user_sent+ack open');
    assert.equal(body.crypto_cases_by_state.intake, 1);
    assert.equal(body.crypto_cases_by_state.tracing, 1);
    assert.equal(body.crypto_cases_by_state.frozen, 1);
    assert.equal(body.crypto_cases_by_state.denied, 1);
    assert.equal(body.open_crypto_cases, 2);
    assert.equal(body.legal_docs_generated_30d, 2);
    assert.equal(body.total_referrals_30d, 2);
    assert.equal(body.referrals_30d_by_status.referred, 1);
    assert.equal(body.referrals_30d_by_status.case_closed_won, 1);
    assertNoPii(body);
  });

  it('returns zeros gracefully when no data exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/summary',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      open_purchases_30d: number;
      total_revenue_30d_cents: number;
      open_wire_cases: number;
      open_crypto_cases: number;
      legal_docs_generated_30d: number;
      total_referrals_30d: number;
      wire_cases_by_state: Record<string, number>;
      crypto_cases_by_state: Record<string, number>;
      referrals_30d_by_status: Record<string, number>;
    };
    assert.equal(body.open_purchases_30d, 0);
    assert.equal(body.total_revenue_30d_cents, 0);
    assert.equal(body.open_wire_cases, 0);
    assert.equal(body.open_crypto_cases, 0);
    assert.equal(body.legal_docs_generated_30d, 0);
    assert.equal(body.total_referrals_30d, 0);
    assert.equal(body.wire_cases_by_state.intake, 0);
    assert.equal(body.crypto_cases_by_state.intake, 0);
    assert.equal(body.referrals_30d_by_status.referred, 0);
    // Sanity: all state buckets present (no missing keys producing NaN).
    for (const v of Object.values(body.wire_cases_by_state)) {
      assert.ok(Number.isFinite(v));
    }
    for (const v of Object.values(body.crypto_cases_by_state)) {
      assert.ok(Number.isFinite(v));
    }
    assertNoPii(body);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/summary',
    });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { error: string }).error, 'missing_bearer');
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/summary',
      headers: { authorization: 'Bearer not-the-secret' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { error: string }).error, 'invalid_token');
  });
});

// =================================================================
// 2. /v1/admin/recovery-shield/cases-timeline
// =================================================================
describe('GET /v1/admin/recovery-shield/cases-timeline', () => {
  it('returns per-day buckets merging wire/crypto/docs/referrals', async () => {
    // Day-3: 2 wire, 1 crypto, 1 doc, 1 referral
    dbState.wire_cases.push(
      { state: 'intake', created_at: daysAgo(3) },
      { state: 'intake', created_at: daysAgo(3) },
    );
    dbState.crypto_cases.push({ state: 'intake', created_at: daysAgo(3) });
    dbState.legal_documents.push({
      doc_kind: 'ic3_complaint',
      body_markdown: 'x',
      generated_at: daysAgo(3),
      user_acknowledged_disclaimer_at: null,
    });
    dbState.referrals.push({
      specialist_id: 'spec-1',
      engagement_status: 'referred',
      fee_owed_cents: null,
      fee_paid_at: null,
      referred_at: daysAgo(3),
    });
    // Day-1: 1 wire only
    dbState.wire_cases.push({ state: 'intake', created_at: daysAgo(1) });
    // >30d → excluded
    dbState.wire_cases.push({ state: 'intake', created_at: daysAgo(45) });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/cases-timeline',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      days: Array<{
        date: string;
        wire_cases_opened: number;
        crypto_cases_opened: number;
        legal_packets_generated: number;
        referrals_created: number;
      }>;
      window_days: number;
      tz: string;
    };
    assert.equal(body.window_days, 30);
    assert.equal(body.tz, 'UTC');
    assert.equal(body.days.length, 2, 'two distinct day buckets');
    assert.ok(body.days[0]!.date < body.days[1]!.date, 'ascending');
    const day3 = body.days[0]!;
    assert.equal(day3.wire_cases_opened, 2);
    assert.equal(day3.crypto_cases_opened, 1);
    assert.equal(day3.legal_packets_generated, 1);
    assert.equal(day3.referrals_created, 1);
    const day1 = body.days[1]!;
    assert.equal(day1.wire_cases_opened, 1);
    assert.equal(day1.crypto_cases_opened, 0);
    assert.equal(day1.legal_packets_generated, 0);
    assert.equal(day1.referrals_created, 0);
    assert.match(day1.date, /^\d{4}-\d{2}-\d{2}$/);
    assertNoPii(body);
  });

  it('returns empty days array when no data in window', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/cases-timeline',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { days: unknown[]; window_days: number };
    assert.deepEqual(body.days, []);
    assert.equal(body.window_days, 30);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/cases-timeline',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/cases-timeline',
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 3. /v1/admin/recovery-shield/specialist-performance
// =================================================================
describe('GET /v1/admin/recovery-shield/specialist-performance', () => {
  it('returns leaderboard with conversion + fee rollups', async () => {
    dbState.specialists.push(
      {
        id: 'spec-a',
        display_name: 'Alpha Recovery',
        category: 'asset_recovery_attorney',
      },
      {
        id: 'spec-b',
        display_name: 'Beta Forensics',
        category: 'blockchain_forensics',
      },
    );
    // spec-a: 5 referrals, 2 won, 1 lost (= 3 terminal, 66.7% conv)
    for (let i = 0; i < 5; i++) {
      let status = 'referred';
      if (i < 2) status = 'case_closed_won';
      else if (i === 2) status = 'case_closed_lost';
      dbState.referrals.push({
        specialist_id: 'spec-a',
        engagement_status: status,
        fee_owed_cents: i < 3 ? 50000 : null,
        fee_paid_at: i === 0 ? daysAgo(1) : null,
        referred_at: daysAgo(10),
      });
    }
    // spec-b: 2 referrals, 0 terminal
    for (let i = 0; i < 2; i++) {
      dbState.referrals.push({
        specialist_id: 'spec-b',
        engagement_status: 'user_engaged',
        fee_owed_cents: null,
        fee_paid_at: null,
        referred_at: daysAgo(15),
      });
    }
    // >90d — excluded
    dbState.referrals.push({
      specialist_id: 'spec-a',
      engagement_status: 'referred',
      fee_owed_cents: null,
      fee_paid_at: null,
      referred_at: daysAgo(120),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/specialist-performance',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      specialists: Array<{
        specialist_id: string;
        display_name: string;
        category: string;
        referrals_count: number;
        case_closed_won_count: number;
        case_closed_lost_count: number;
        conversion_pct: number;
        fee_owed_total_cents: number;
        fee_paid_total_cents: number;
      }>;
      window_days: number;
    };
    assert.equal(body.window_days, 90);
    assert.equal(body.specialists.length, 2);
    assert.equal(body.specialists[0]!.specialist_id, 'spec-a', 'desc by count');
    assert.equal(body.specialists[0]!.referrals_count, 5);
    assert.equal(body.specialists[0]!.case_closed_won_count, 2);
    assert.equal(body.specialists[0]!.case_closed_lost_count, 1);
    // 2 won / 3 terminal = 66.7%
    assert.equal(body.specialists[0]!.conversion_pct, 66.7);
    assert.equal(body.specialists[0]!.fee_owed_total_cents, 150000);
    assert.equal(body.specialists[0]!.fee_paid_total_cents, 50000);
    assert.equal(body.specialists[1]!.specialist_id, 'spec-b');
    assert.equal(body.specialists[1]!.conversion_pct, 0, 'no terminal cases');
    assertNoPii(body);
  });

  it('returns empty specialists array when no referrals exist', async () => {
    dbState.specialists.push({
      id: 'spec-empty',
      display_name: 'Empty',
      category: 'identity_restoration',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/specialist-performance',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { specialists: unknown[] };
    assert.deepEqual(body.specialists, []);
  });

  it('caps the leaderboard at 50 entries', async () => {
    for (let i = 0; i < 60; i++) {
      const id = `spec-${String(i).padStart(2, '0')}`;
      dbState.specialists.push({
        id,
        display_name: `Spec ${i}`,
        category: 'blockchain_forensics',
      });
      dbState.referrals.push({
        specialist_id: id,
        engagement_status: 'referred',
        fee_owed_cents: null,
        fee_paid_at: null,
        referred_at: daysAgo(5),
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/specialist-performance',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { specialists: unknown[] };
    assert.equal(body.specialists.length, 50);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/specialist-performance',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/specialist-performance',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 4. /v1/admin/recovery-shield/document-quality
// =================================================================
describe('GET /v1/admin/recovery-shield/document-quality', () => {
  it('returns per-doc_kind generated count + ack rate + body length', async () => {
    dbState.legal_documents.push(
      // ic3: 3 docs, 2 acked, body lengths 1000/2000/1500 → avg 1500
      {
        doc_kind: 'ic3_complaint',
        body_markdown: 'x'.repeat(1000),
        generated_at: daysAgo(1),
        user_acknowledged_disclaimer_at: daysAgo(1),
      },
      {
        doc_kind: 'ic3_complaint',
        body_markdown: 'x'.repeat(2000),
        generated_at: daysAgo(2),
        user_acknowledged_disclaimer_at: daysAgo(2),
      },
      {
        doc_kind: 'ic3_complaint',
        body_markdown: 'x'.repeat(1500),
        generated_at: daysAgo(3),
        user_acknowledged_disclaimer_at: null,
      },
      // ftc: 1 doc, 0 acked
      {
        doc_kind: 'ftc_complaint',
        body_markdown: 'x'.repeat(800),
        generated_at: daysAgo(4),
        user_acknowledged_disclaimer_at: null,
      },
      // >30d — excluded
      {
        doc_kind: 'ic3_complaint',
        body_markdown: 'x'.repeat(99999),
        generated_at: daysAgo(45),
        user_acknowledged_disclaimer_at: null,
      },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/document-quality',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      docs: Array<{
        doc_kind: string;
        generated_count: number;
        avg_body_length: number;
        disclaimer_acknowledgement_rate: number;
      }>;
      window_days: number;
    };
    assert.equal(body.window_days, 30);
    assert.equal(body.docs.length, 2);
    const ic3 = body.docs.find((d) => d.doc_kind === 'ic3_complaint')!;
    assert.equal(ic3.generated_count, 3);
    assert.equal(ic3.avg_body_length, 1500);
    // 2 acked / 3 generated = 66.7%
    assert.equal(ic3.disclaimer_acknowledgement_rate, 66.7);
    const ftc = body.docs.find((d) => d.doc_kind === 'ftc_complaint')!;
    assert.equal(ftc.generated_count, 1);
    assert.equal(ftc.disclaimer_acknowledgement_rate, 0);
    assertNoPii(body);
  });

  it('returns empty docs array (no NaN) when no documents in window', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/document-quality',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      docs: unknown[];
      window_days: number;
    };
    assert.deepEqual(body.docs, []);
    assert.equal(body.window_days, 30);
  });

  it('handles single-doc kind without divide-by-zero on ack rate', async () => {
    dbState.legal_documents.push({
      doc_kind: 'affidavit',
      body_markdown: 'a'.repeat(500),
      generated_at: hoursAgo(1),
      user_acknowledged_disclaimer_at: null,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/document-quality',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      docs: Array<{
        doc_kind: string;
        generated_count: number;
        disclaimer_acknowledgement_rate: number;
      }>;
    };
    assert.equal(body.docs.length, 1);
    assert.equal(body.docs[0]!.disclaimer_acknowledgement_rate, 0);
    assert.ok(Number.isFinite(body.docs[0]!.disclaimer_acknowledgement_rate));
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/document-quality',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/document-quality',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 5. /v1/admin/recovery-shield/refund-rate
// =================================================================
describe('GET /v1/admin/recovery-shield/refund-rate', () => {
  it('computes refund metrics with windowed breakdown', async () => {
    // 10 purchases in 30d. 3 refunded: 1 within 24h, 1 within 7d, 1 after 7d.
    for (let i = 0; i < 7; i++) {
      dbState.purchases.push({
        purchase_amount_cents: 24900,
        purchased_at: daysAgo(i + 1),
        refunded_at: null,
      });
    }
    // refunded within 24h (purchased 2d ago, refunded 1d ago + a few hours)
    dbState.purchases.push({
      purchase_amount_cents: 24900,
      purchased_at: daysAgo(2),
      refunded_at: hoursAgo(38), // 2d - 38h = ~10h delta
    });
    // refunded within 7d (purchased 10d ago, refunded 5d ago = 5d delta)
    dbState.purchases.push({
      purchase_amount_cents: 24900,
      purchased_at: daysAgo(10),
      refunded_at: daysAgo(5),
    });
    // refunded after 7d (purchased 20d ago, refunded 1d ago = 19d delta)
    dbState.purchases.push({
      purchase_amount_cents: 24900,
      purchased_at: daysAgo(20),
      refunded_at: daysAgo(1),
    });
    // > 30d — excluded
    dbState.purchases.push({
      purchase_amount_cents: 24900,
      purchased_at: daysAgo(45),
      refunded_at: daysAgo(40),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/refund-rate',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      total_purchases_30d: number;
      refunded_30d: number;
      refund_pct: number;
      top_refund_window: {
        within_24h: number;
        within_7d: number;
        after_7d: number;
      };
      window_days: number;
    };
    assert.equal(body.total_purchases_30d, 10);
    assert.equal(body.refunded_30d, 3);
    // 3/10 = 30.0%
    assert.equal(body.refund_pct, 30);
    assert.equal(body.top_refund_window.within_24h, 1);
    assert.equal(body.top_refund_window.within_7d, 1);
    assert.equal(body.top_refund_window.after_7d, 1);
    assert.equal(body.window_days, 30);
    assertNoPii(body);
  });

  it('returns zeros + no-divide-by-zero when no purchases exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/refund-rate',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      total_purchases_30d: number;
      refunded_30d: number;
      refund_pct: number;
      top_refund_window: {
        within_24h: number;
        within_7d: number;
        after_7d: number;
      };
    };
    assert.equal(body.total_purchases_30d, 0);
    assert.equal(body.refunded_30d, 0);
    assert.equal(body.refund_pct, 0);
    assert.ok(Number.isFinite(body.refund_pct), 'no NaN');
    assert.deepEqual(body.top_refund_window, {
      within_24h: 0,
      within_7d: 0,
      after_7d: 0,
    });
  });

  it('returns 0% refund_pct when purchases exist but none refunded', async () => {
    dbState.purchases.push(
      {
        purchase_amount_cents: 24900,
        purchased_at: daysAgo(1),
        refunded_at: null,
      },
      {
        purchase_amount_cents: 24900,
        purchased_at: daysAgo(2),
        refunded_at: null,
      },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/refund-rate',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      total_purchases_30d: number;
      refunded_30d: number;
      refund_pct: number;
    };
    assert.equal(body.total_purchases_30d, 2);
    assert.equal(body.refunded_30d, 0);
    assert.equal(body.refund_pct, 0);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/refund-rate',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/recovery-shield/refund-rate',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});
