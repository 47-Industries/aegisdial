import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Email Shield — P23 — admin dashboard route tests.
//
// Same in-memory pool-mock pattern as adminRecoveryGrant.test.ts: env
// set BEFORE any src/* imports, then swap pool.query with an
// SQL-prefix-matching fake. The dashboard routes only read — no
// mutations to assert.
//
// Coverage matrix per route:
//   - happy path (seeded fixture → asserted shape + values)
//   - empty data path (no rows → zeros / empty arrays, never 500)
//   - missing bearer → 401 missing_bearer
//   - wrong bearer → 401 invalid_token (the requireBearer admin
//     surface returns 401 for BOTH unauthenticated and wrong-token
//     cases — there's no distinct "authenticated non-admin" surface
//     because bearer == admin)

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-admin-email-shield-secret';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://admin-email-shield-test';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { adminEmailShieldRoutes } = await import('../src/routes/adminEmailShield.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;

// -----------------------------------------------------------------
// In-memory DB state. Each test resets via resetDb().
// -----------------------------------------------------------------
interface AccountRow {
  provider: 'gmail' | 'microsoft' | 'imap';
  status: 'active' | 'auth_failed' | 'revoked' | 'paused';
}
interface ScanRow {
  sender_domain: string;
  verdict: 'safe' | 'suspicious' | 'fraud';
  scanned_at: Date;
}
interface CompromiseRow {
  overall_verdict: 'clean' | 'concerns' | 'compromised';
  findings: Record<string, unknown>;
  generated_at: Date;
}
interface TamperRow {
  status: 'pending' | 'confirmed' | 'denied' | 'expired';
  created_at: Date;
}
interface DbState {
  accounts: AccountRow[];
  scans: ScanRow[];
  compromise_reports: CompromiseRow[];
  tamper_alerts: TamperRow[];
}

const dbState: DbState = {
  accounts: [],
  scans: [],
  compromise_reports: [],
  tamper_alerts: [],
};

function resetDb(): void {
  dbState.accounts.length = 0;
  dbState.scans.length = 0;
  dbState.compromise_reports.length = 0;
  dbState.tamper_alerts.length = 0;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 60 * 1000);
}

// -----------------------------------------------------------------
// SQL prefix matcher. Each route's query gets its own branch.
// Branch order matters — we match on the most specific signature
// first, then fall through to swallow-unknowns at the end.
// -----------------------------------------------------------------
const fakeQuery = async (
  text: string,
  _params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.replace(/\s+/g, ' ').trim();

  // ------------------- summary panel ---------------------------
  // (a) accounts by provider, status='active'
  if (
    /SELECT provider, COUNT\(\*\).*FROM email_accounts WHERE status = 'active' GROUP BY provider/i.test(t)
  ) {
    const counts: Record<string, number> = {};
    for (const a of dbState.accounts) {
      if (a.status !== 'active') continue;
      counts[a.provider] = (counts[a.provider] ?? 0) + 1;
    }
    const rows = Object.entries(counts).map(([provider, count]) => ({
      provider,
      count: String(count),
    }));
    return { rows, rowCount: rows.length };
  }

  // (b) scans 24h/7d/30d FILTER
  if (
    /SELECT COUNT\(\*\) FILTER \(WHERE scanned_at >= NOW\(\) - INTERVAL '24 hours'\).*last_24h.*FROM email_scans/i.test(
      t,
    )
  ) {
    const now = Date.now();
    let l24 = 0;
    let l7 = 0;
    let l30 = 0;
    for (const s of dbState.scans) {
      const age = now - s.scanned_at.getTime();
      if (age <= 30 * 24 * 60 * 60 * 1000) l30++;
      if (age <= 7 * 24 * 60 * 60 * 1000) l7++;
      if (age <= 24 * 60 * 60 * 1000) l24++;
    }
    return {
      rows: [{ last_24h: String(l24), last_7d: String(l7), last_30d: String(l30) }],
      rowCount: 1,
    };
  }

  // (c) verdict distribution 7d
  if (
    /SELECT verdict, COUNT\(\*\).*FROM email_scans WHERE scanned_at >= NOW\(\) - INTERVAL '7 days' GROUP BY verdict/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const counts: Record<string, number> = {};
    for (const s of dbState.scans) {
      if (s.scanned_at.getTime() < cutoff) continue;
      counts[s.verdict] = (counts[s.verdict] ?? 0) + 1;
    }
    const rows = Object.entries(counts).map(([verdict, count]) => ({
      verdict,
      count: String(count),
    }));
    return { rows, rowCount: rows.length };
  }

  // (d) compromise reports 7d
  if (
    /SELECT overall_verdict, COUNT\(\*\).*FROM email_compromise_reports WHERE generated_at >= NOW\(\) - INTERVAL '7 days' GROUP BY overall_verdict/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const counts: Record<string, number> = {};
    for (const r of dbState.compromise_reports) {
      if (r.generated_at.getTime() < cutoff) continue;
      counts[r.overall_verdict] = (counts[r.overall_verdict] ?? 0) + 1;
    }
    const rows = Object.entries(counts).map(([overall_verdict, count]) => ({
      overall_verdict,
      count: String(count),
    }));
    return { rows, rowCount: rows.length };
  }

  // (e) tamper alerts 7d
  if (
    /SELECT status, COUNT\(\*\).*FROM email_tamper_alerts WHERE created_at >= NOW\(\) - INTERVAL '7 days' GROUP BY status/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const counts: Record<string, number> = {};
    for (const a of dbState.tamper_alerts) {
      if (a.created_at.getTime() < cutoff) continue;
      counts[a.status] = (counts[a.status] ?? 0) + 1;
    }
    const rows = Object.entries(counts).map(([status, count]) => ({
      status,
      count: String(count),
    }));
    return { rows, rowCount: rows.length };
  }

  // ------------------- scans-timeline panel --------------------
  if (
    /date_trunc\('day', scanned_at AT TIME ZONE 'UTC'\) AS bucket.*FROM email_scans WHERE scanned_at >= NOW\(\) - INTERVAL '30 days'/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const buckets = new Map<
      string,
      { bucket: Date; scans: number; fraud: number; suspicious: number }
    >();
    for (const s of dbState.scans) {
      if (s.scanned_at.getTime() < cutoff) continue;
      // Pin to UTC midnight to mirror date_trunc('day', ... AT TIME ZONE 'UTC').
      const d = new Date(
        Date.UTC(
          s.scanned_at.getUTCFullYear(),
          s.scanned_at.getUTCMonth(),
          s.scanned_at.getUTCDate(),
        ),
      );
      const key = d.toISOString();
      const slot = buckets.get(key) ?? { bucket: d, scans: 0, fraud: 0, suspicious: 0 };
      slot.scans++;
      if (s.verdict === 'fraud') slot.fraud++;
      if (s.verdict === 'suspicious') slot.suspicious++;
      buckets.set(key, slot);
    }
    const rows = Array.from(buckets.values())
      .sort((a, b) => a.bucket.getTime() - b.bucket.getTime())
      .slice(0, 30)
      .map((b) => ({
        bucket: b.bucket,
        scans: String(b.scans),
        fraud_count: String(b.fraud),
        suspicious_count: String(b.suspicious),
      }));
    return { rows, rowCount: rows.length };
  }

  // ------------------- top-fraud-senders panel ----------------
  if (
    /sender_domain, COUNT\(\*\)::TEXT\s+AS count, MIN\(scanned_at\)\s+AS first_seen_at, MAX\(scanned_at\)\s+AS last_seen_at FROM email_scans WHERE verdict = 'fraud'/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const byDomain = new Map<
      string,
      { count: number; first: Date; last: Date }
    >();
    for (const s of dbState.scans) {
      if (s.verdict !== 'fraud') continue;
      if (s.scanned_at.getTime() < cutoff) continue;
      const slot = byDomain.get(s.sender_domain) ?? {
        count: 0,
        first: s.scanned_at,
        last: s.scanned_at,
      };
      slot.count++;
      if (s.scanned_at < slot.first) slot.first = s.scanned_at;
      if (s.scanned_at > slot.last) slot.last = s.scanned_at;
      byDomain.set(s.sender_domain, slot);
    }
    const rows = Array.from(byDomain.entries())
      .sort((a, b) => {
        if (b[1].count !== a[1].count) return b[1].count - a[1].count;
        return b[1].last.getTime() - a[1].last.getTime();
      })
      .slice(0, 20)
      .map(([sender_domain, v]) => ({
        sender_domain,
        count: String(v.count),
        first_seen_at: v.first,
        last_seen_at: v.last,
      }));
    return { rows, rowCount: rows.length };
  }

  // ------------------- compromise-distribution panel ----------
  if (
    /COUNT\(\*\) FILTER \(WHERE findings \? 'inbox_rules'\)/i.test(t) &&
    /FROM email_compromise_reports WHERE generated_at >= NOW\(\) - INTERVAL '30 days'/i.test(t)
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let total = 0;
    const counters = {
      inbox_rules: 0,
      oauth_grants: 0,
      suspicious_sent: 0,
      login_anomalies: 0,
      breach_exposure: 0,
    };
    for (const r of dbState.compromise_reports) {
      if (r.generated_at.getTime() < cutoff) continue;
      total++;
      for (const key of Object.keys(counters) as (keyof typeof counters)[]) {
        if (key in r.findings) counters[key]++;
      }
    }
    return {
      rows: [
        {
          total_reports: String(total),
          inbox_rules: String(counters.inbox_rules),
          oauth_grants: String(counters.oauth_grants),
          suspicious_sent: String(counters.suspicious_sent),
          login_anomalies: String(counters.login_anomalies),
          breach_exposure: String(counters.breach_exposure),
        },
      ],
      rowCount: 1,
    };
  }

  // ------------------- tamper-alert-resolution panel ----------
  if (
    /SELECT status, COUNT\(\*\).*FROM email_tamper_alerts WHERE created_at >= NOW\(\) - INTERVAL '30 days' GROUP BY status/i.test(
      t,
    )
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const counts: Record<string, number> = {};
    for (const a of dbState.tamper_alerts) {
      if (a.created_at.getTime() < cutoff) continue;
      counts[a.status] = (counts[a.status] ?? 0) + 1;
    }
    const rows = Object.entries(counts).map(([status, count]) => ({
      status,
      count: String(count),
    }));
    return { rows, rowCount: rows.length };
  }

  // metric_counters INSERT (from withAdminAudit.emitMetric) — swallow.
  if (/INSERT\s+INTO\s+metric_counters/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }

  // Unknown — log to console for debugging without failing the run.
  // eslint-disable-next-line no-console
  if (process.env.DEBUG_ADMIN_TEST) console.warn('[unmatched SQL]', t.slice(0, 200));
  return { rows: [], rowCount: 0 };
};

(db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;

const app = Fastify({ logger: false });
await app.register(adminEmailShieldRoutes);
await app.ready();

const bearer = { authorization: `Bearer ${SHARED_SECRET}` };

before(() => {
  resetDb();
});
beforeEach(() => {
  resetDb();
});

// =================================================================
// 1. /v1/admin/email-shield/summary
// =================================================================
describe('GET /v1/admin/email-shield/summary', () => {
  it('returns counters across all five panels with seeded data', async () => {
    dbState.accounts.push(
      { provider: 'gmail', status: 'active' },
      { provider: 'gmail', status: 'active' },
      { provider: 'microsoft', status: 'active' },
      { provider: 'imap', status: 'active' },
      // revoked → should NOT appear in active count
      { provider: 'gmail', status: 'revoked' },
    );
    dbState.scans.push(
      // last 24h
      { sender_domain: 'a.com', verdict: 'safe', scanned_at: hoursAgo(1) },
      { sender_domain: 'a.com', verdict: 'fraud', scanned_at: hoursAgo(2) },
      // 7d but not 24h
      { sender_domain: 'b.com', verdict: 'suspicious', scanned_at: daysAgo(3) },
      // 30d but not 7d
      { sender_domain: 'c.com', verdict: 'safe', scanned_at: daysAgo(15) },
      // >30d → excluded from all windows
      { sender_domain: 'd.com', verdict: 'fraud', scanned_at: daysAgo(45) },
    );
    dbState.compromise_reports.push(
      { overall_verdict: 'clean', findings: {}, generated_at: daysAgo(1) },
      {
        overall_verdict: 'compromised',
        findings: { inbox_rules: [{}] },
        generated_at: daysAgo(2),
      },
      { overall_verdict: 'concerns', findings: { oauth_grants: [] }, generated_at: daysAgo(4) },
    );
    dbState.tamper_alerts.push(
      { status: 'pending', created_at: daysAgo(1) },
      { status: 'confirmed', created_at: daysAgo(2) },
      { status: 'denied', created_at: daysAgo(3) },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/summary',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      active_inboxes: number;
      by_provider: Record<string, number>;
      scans: { last_24h: number; last_7d: number; last_30d: number };
      verdict_distribution_7d: Record<string, number>;
      compromise_reports_7d: Record<string, number>;
      tamper_alerts_7d: Record<string, number>;
    };

    assert.equal(body.active_inboxes, 4, 'revoked account excluded');
    assert.deepEqual(body.by_provider, { gmail: 2, microsoft: 1, imap: 1 });
    assert.equal(body.scans.last_24h, 2);
    assert.equal(body.scans.last_7d, 3);
    assert.equal(body.scans.last_30d, 4);
    assert.deepEqual(body.verdict_distribution_7d, {
      safe: 1,
      suspicious: 1,
      fraud: 1,
    });
    assert.deepEqual(body.compromise_reports_7d, {
      clean: 1,
      concerns: 1,
      compromised: 1,
    });
    assert.deepEqual(body.tamper_alerts_7d, {
      pending: 1,
      confirmed: 1,
      denied: 1,
      expired: 0,
    });
  });

  it('returns zeros gracefully when no data exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/summary',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      active_inboxes: number;
      by_provider: Record<string, number>;
      scans: { last_24h: number; last_7d: number; last_30d: number };
    };
    assert.equal(body.active_inboxes, 0);
    assert.deepEqual(body.by_provider, { gmail: 0, microsoft: 0, imap: 0 });
    assert.deepEqual(body.scans, { last_24h: 0, last_7d: 0, last_30d: 0 });
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/summary',
    });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { error: string }).error, 'missing_bearer');
  });

  it('returns 401 with a wrong bearer (non-admin)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/summary',
      headers: { authorization: 'Bearer not-the-secret' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { error: string }).error, 'invalid_token');
  });
});

// =================================================================
// 2. /v1/admin/email-shield/scans-timeline
// =================================================================
describe('GET /v1/admin/email-shield/scans-timeline', () => {
  it('returns per-day buckets with fraud + suspicious counts', async () => {
    // Two scans on day-3, one on day-1.
    dbState.scans.push(
      { sender_domain: 'a.com', verdict: 'safe', scanned_at: daysAgo(3) },
      { sender_domain: 'a.com', verdict: 'fraud', scanned_at: daysAgo(3) },
      { sender_domain: 'b.com', verdict: 'suspicious', scanned_at: daysAgo(1) },
      // 60d ago — excluded by 30d window
      { sender_domain: 'c.com', verdict: 'fraud', scanned_at: daysAgo(60) },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/scans-timeline',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      days: Array<{
        date: string;
        scans: number;
        fraud_count: number;
        suspicious_count: number;
      }>;
      window_days: number;
      tz: string;
    };
    assert.equal(body.window_days, 30);
    assert.equal(body.tz, 'UTC');
    assert.equal(body.days.length, 2, 'two distinct day buckets in 30d window');
    // Ascending order.
    assert.ok(body.days[0]!.date < body.days[1]!.date);
    // Day with two scans (one fraud, one safe).
    const day3 = body.days[0]!;
    assert.equal(day3.scans, 2);
    assert.equal(day3.fraud_count, 1);
    assert.equal(day3.suspicious_count, 0);
    // Day with one suspicious scan.
    const day1 = body.days[1]!;
    assert.equal(day1.scans, 1);
    assert.equal(day1.suspicious_count, 1);
    // Date format check (YYYY-MM-DD).
    assert.match(day1.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns empty days array when no scans in window', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/scans-timeline',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { days: unknown[] };
    assert.deepEqual(body.days, []);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/scans-timeline',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer (non-admin)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/scans-timeline',
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 3. /v1/admin/email-shield/top-fraud-senders
// =================================================================
describe('GET /v1/admin/email-shield/top-fraud-senders', () => {
  it('returns top sender_domains by fraud count, ordered desc', async () => {
    dbState.scans.push(
      // domain-a: 3 fraud
      { sender_domain: 'a.com', verdict: 'fraud', scanned_at: daysAgo(5) },
      { sender_domain: 'a.com', verdict: 'fraud', scanned_at: daysAgo(3) },
      { sender_domain: 'a.com', verdict: 'fraud', scanned_at: daysAgo(1) },
      // domain-b: 2 fraud
      { sender_domain: 'b.com', verdict: 'fraud', scanned_at: daysAgo(7) },
      { sender_domain: 'b.com', verdict: 'fraud', scanned_at: daysAgo(2) },
      // domain-c: 1 fraud
      { sender_domain: 'c.com', verdict: 'fraud', scanned_at: daysAgo(4) },
      // safe/suspicious — ignored
      { sender_domain: 'd.com', verdict: 'safe', scanned_at: daysAgo(1) },
      { sender_domain: 'e.com', verdict: 'suspicious', scanned_at: daysAgo(1) },
      // >30d — excluded
      { sender_domain: 'old.com', verdict: 'fraud', scanned_at: daysAgo(45) },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/top-fraud-senders',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      senders: Array<{
        sender_domain: string;
        count: number;
        first_seen_at: string;
        last_seen_at: string;
      }>;
      window_days: number;
    };
    assert.equal(body.window_days, 30);
    assert.equal(body.senders.length, 3, 'a/b/c — safe/suspicious/old excluded');
    assert.equal(body.senders[0]!.sender_domain, 'a.com');
    assert.equal(body.senders[0]!.count, 3);
    assert.equal(body.senders[1]!.sender_domain, 'b.com');
    assert.equal(body.senders[1]!.count, 2);
    assert.equal(body.senders[2]!.sender_domain, 'c.com');
    assert.equal(body.senders[2]!.count, 1);
    // first/last_seen_at are ISO strings spanning the right range
    // for a.com (day-5 → day-1).
    const aFirst = new Date(body.senders[0]!.first_seen_at).getTime();
    const aLast = new Date(body.senders[0]!.last_seen_at).getTime();
    assert.ok(aLast > aFirst);
  });

  it('caps at 20 sender_domains even with more available', async () => {
    for (let i = 0; i < 25; i++) {
      dbState.scans.push({
        sender_domain: `dom-${String(i).padStart(2, '0')}.com`,
        verdict: 'fraud',
        scanned_at: daysAgo(1),
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/top-fraud-senders',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { senders: unknown[] };
    assert.equal(body.senders.length, 20);
  });

  it('returns empty array when no fraud verdicts exist', async () => {
    dbState.scans.push({
      sender_domain: 'safe.com',
      verdict: 'safe',
      scanned_at: daysAgo(1),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/top-fraud-senders',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { senders: unknown[] };
    assert.deepEqual(body.senders, []);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/top-fraud-senders',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/top-fraud-senders',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 4. /v1/admin/email-shield/compromise-distribution
// =================================================================
describe('GET /v1/admin/email-shield/compromise-distribution', () => {
  it('counts per-finding-key presence across reports', async () => {
    dbState.compromise_reports.push(
      // Report 1: inbox_rules + oauth_grants
      {
        overall_verdict: 'concerns',
        findings: { inbox_rules: [{}], oauth_grants: [{}] },
        generated_at: daysAgo(1),
      },
      // Report 2: inbox_rules only (compromised)
      {
        overall_verdict: 'compromised',
        findings: { inbox_rules: [{ concern: 'forward_to_external' }] },
        generated_at: daysAgo(3),
      },
      // Report 3: clean (no findings keys)
      { overall_verdict: 'clean', findings: {}, generated_at: daysAgo(5) },
      // Report 4: login_anomalies + breach_exposure
      {
        overall_verdict: 'concerns',
        findings: { login_anomalies: [{}], breach_exposure: { breaches: [{}] } },
        generated_at: daysAgo(7),
      },
      // Report >30d — excluded
      {
        overall_verdict: 'compromised',
        findings: { inbox_rules: [{}] },
        generated_at: daysAgo(40),
      },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/compromise-distribution',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      total_reports: number;
      by_finding: {
        inbox_rules: number;
        oauth_grants: number;
        suspicious_sent: number;
        login_anomalies: number;
        breach_exposure: number;
      };
      window_days: number;
    };
    assert.equal(body.total_reports, 4, '4 reports in 30d window');
    assert.equal(body.by_finding.inbox_rules, 2);
    assert.equal(body.by_finding.oauth_grants, 1);
    assert.equal(body.by_finding.suspicious_sent, 0);
    assert.equal(body.by_finding.login_anomalies, 1);
    assert.equal(body.by_finding.breach_exposure, 1);
    assert.equal(body.window_days, 30);
  });

  it('returns zeros when no reports exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/compromise-distribution',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      total_reports: number;
      by_finding: Record<string, number>;
    };
    assert.equal(body.total_reports, 0);
    assert.deepEqual(body.by_finding, {
      inbox_rules: 0,
      oauth_grants: 0,
      suspicious_sent: 0,
      login_anomalies: 0,
      breach_exposure: 0,
    });
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/compromise-distribution',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/compromise-distribution',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 5. /v1/admin/email-shield/tamper-alert-resolution
// =================================================================
describe('GET /v1/admin/email-shield/tamper-alert-resolution', () => {
  it('computes funnel percentages from 30d alerts', async () => {
    // 10 alerts total: 5 confirmed, 2 denied, 2 expired, 1 pending.
    for (let i = 0; i < 5; i++) {
      dbState.tamper_alerts.push({ status: 'confirmed', created_at: daysAgo(i + 1) });
    }
    for (let i = 0; i < 2; i++) {
      dbState.tamper_alerts.push({ status: 'denied', created_at: daysAgo(i + 1) });
    }
    for (let i = 0; i < 2; i++) {
      dbState.tamper_alerts.push({ status: 'expired', created_at: daysAgo(i + 1) });
    }
    dbState.tamper_alerts.push({ status: 'pending', created_at: daysAgo(1) });
    // Out-of-window alert — excluded.
    dbState.tamper_alerts.push({ status: 'confirmed', created_at: daysAgo(45) });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/tamper-alert-resolution',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      total_alerts: number;
      confirmed_pct: number;
      denied_pct: number;
      expired_pct: number;
      pending_pct: number;
      by_status: Record<string, number>;
      window_days: number;
    };
    assert.equal(body.total_alerts, 10);
    assert.equal(body.confirmed_pct, 50);
    assert.equal(body.denied_pct, 20);
    assert.equal(body.expired_pct, 20);
    assert.equal(body.pending_pct, 10);
    assert.deepEqual(body.by_status, {
      pending: 1,
      confirmed: 5,
      denied: 2,
      expired: 2,
    });
    assert.equal(body.window_days, 30);
  });

  it('returns zeros / no-divide-by-zero when no alerts exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/tamper-alert-resolution',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      total_alerts: number;
      confirmed_pct: number;
      denied_pct: number;
      expired_pct: number;
      pending_pct: number;
      by_status: Record<string, number>;
    };
    assert.equal(body.total_alerts, 0);
    assert.equal(body.confirmed_pct, 0);
    assert.equal(body.denied_pct, 0);
    assert.equal(body.expired_pct, 0);
    assert.equal(body.pending_pct, 0);
    assert.deepEqual(body.by_status, {
      pending: 0,
      confirmed: 0,
      denied: 0,
      expired: 0,
    });
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/tamper-alert-resolution',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/email-shield/tamper-alert-resolution',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});
