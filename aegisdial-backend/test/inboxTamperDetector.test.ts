import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Email Shield — inbox-tamper detector + alert routes.
// Stubs:
//   - db.pool.query — selectively returns scan/alert rows
//   - pushSender — captures push attempts
// Goals:
//   - Verdict='fraud' scans are skipped (user is supposed to delete those)
//   - Window: deletes outside the threshold are skipped
//   - Per-user pending cap stops the 6th alert
//   - UNIQUE (scan_id) makes the detector idempotent
//   - Push is best-effort: a push failure does NOT roll back the DB row
//   - Resolve flow: 'denied' rolling-24h threshold escalates to a
//     compromise report
//   - Expire-stale cron flips pending → expired at 72h
//   - Routes: list + respond; respond requires ownership

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-tamper';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://tamper';
process.env.ALLOW_DEV_BEARER = 'true';

const Fastify = (await import('fastify')).default;
const fastifyRateLimit = (await import('@fastify/rate-limit')).default;
const db = await import('../src/lib/db.ts');
const detector = await import('../src/services/email/inboxTamperDetector.ts');
const { emailShieldRoutes } = await import('../src/routes/emailShield.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;
const SYNTHETIC_USER_ID = '00000000-0000-0000-0000-000000000000';

// ----------------------------------------------------------------
// In-memory stub DB
// ----------------------------------------------------------------

interface FakeScan {
  id: string;
  user_id: string;
  email_account_id: string;
  verdict: 'safe' | 'suspicious' | 'fraud';
  sender_domain: string;
  subject_excerpt: string;
}
interface FakeAlert {
  id: string;
  user_id: string;
  email_account_id: string;
  scan_id: string;
  sender_domain: string;
  subject_excerpt: string;
  delete_after_seconds: number;
  status: 'pending' | 'confirmed' | 'denied' | 'expired';
  responded_at: Date | null;
  created_at: Date;
}

let fakeScans: FakeScan[] = [];
let fakeAlerts: FakeAlert[] = [];
let fakeReports: Array<{
  id: string;
  user_id: string;
  email_account_id: string;
  overall_verdict: string;
  findings: unknown;
  generated_at: Date;
}> = [];
let pushCalls: Array<{ userId: string; title: string; body: string; data: Record<string, unknown> }> = [];

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (/^SELECT id, user_id, email_account_id, verdict, sender_domain, subject_excerpt FROM email_scans/i.test(trimmed)) {
    const [scanId] = params as [string];
    const row = fakeScans.find((s) => s.id === scanId);
    return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT COUNT\(\*\)::TEXT AS count FROM email_tamper_alerts WHERE user_id = \$1 AND status = 'pending'/i.test(trimmed)) {
    const [userId] = params as [string];
    const c = fakeAlerts.filter((a) => a.user_id === userId && a.status === 'pending').length;
    return { rows: [{ count: String(c) }], rowCount: 1 };
  }
  if (/^INSERT INTO email_tamper_alerts/i.test(trimmed)) {
    const [user_id, email_account_id, scan_id, sender_domain, subject_excerpt, delete_after] = params as [
      string, string, string, string, string, number,
    ];
    // UNIQUE (scan_id) — conflict on second insert for same scan.
    if (fakeAlerts.some((a) => a.scan_id === scan_id)) {
      return { rows: [], rowCount: 0 };
    }
    const id = `alert-${fakeAlerts.length + 1}`;
    fakeAlerts.push({
      id, user_id, email_account_id, scan_id, sender_domain, subject_excerpt,
      delete_after_seconds: delete_after, status: 'pending',
      responded_at: null, created_at: new Date(),
    });
    return { rows: [{ id }], rowCount: 1 };
  }
  if (/^UPDATE email_tamper_alerts SET status = \$1, responded_at = NOW\(\) WHERE id = \$2 AND user_id = \$3 AND status = 'pending'/i.test(trimmed)) {
    const [decision, id, user_id] = params as ['confirmed' | 'denied', string, string];
    const alert = fakeAlerts.find((a) => a.id === id && a.user_id === user_id && a.status === 'pending');
    if (!alert) return { rows: [], rowCount: 0 };
    alert.status = decision;
    alert.responded_at = new Date();
    return { rows: [{ id: alert.id, email_account_id: alert.email_account_id }], rowCount: 1 };
  }
  if (/^SELECT COUNT\(\*\)::TEXT AS count FROM email_tamper_alerts WHERE user_id = \$1 AND status = 'denied'/i.test(trimmed)) {
    const [userId] = params as [string];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const c = fakeAlerts.filter(
      (a) =>
        a.user_id === userId &&
        a.status === 'denied' &&
        a.responded_at !== null &&
        a.responded_at.getTime() > cutoff,
    ).length;
    return { rows: [{ count: String(c) }], rowCount: 1 };
  }
  if (/^INSERT INTO email_compromise_reports/i.test(trimmed)) {
    // Two shapes we accept:
    //  (a) legacy VALUES ($1,$2,'compromised',$3::jsonb)  — used elsewhere
    //  (b) race-safe SELECT … WHERE NOT EXISTS form used by
    //      resolveTamperAlert. params: [user_id, email_account_id,
    //      findingsJson, email_account_id]. The 4th param is the
    //      duplicated email_account_id for the NOT EXISTS subquery.
    const [user_id, email_account_id, findingsJson] = params as [string, string, string, string?];
    const findings = JSON.parse(findingsJson) as Record<string, unknown>;
    // Simulate the WHERE NOT EXISTS guard for the tamper-alert path:
    // if a peer report with `inbox_tamper_alerts` findings was
    // INSERTED within the last hour for this (user, account), the
    // new INSERT should be a no-op (rowCount=0).
    if ('inbox_tamper_alerts' in findings) {
      const cutoff = Date.now() - 60 * 60 * 1000;
      const peerExists = fakeReports.some(
        (r) =>
          r.user_id === user_id &&
          r.email_account_id === email_account_id &&
          r.generated_at.getTime() > cutoff &&
          typeof r.findings === 'object' &&
          r.findings !== null &&
          'inbox_tamper_alerts' in (r.findings as Record<string, unknown>),
      );
      if (peerExists) {
        return { rows: [], rowCount: 0 };
      }
    }
    fakeReports.push({
      id: `report-${fakeReports.length + 1}`,
      user_id,
      email_account_id,
      overall_verdict: 'compromised',
      findings,
      generated_at: new Date(),
    });
    return { rows: [{ id: `report-${fakeReports.length}` }], rowCount: 1 };
  }
  if (/^UPDATE email_tamper_alerts SET status = 'expired'/i.test(trimmed)) {
    // Cron-expiry deliberately does NOT set responded_at (adversarial-
    // review H3) — that column is reserved for actual user taps.
    const cutoff = Date.now() - 72 * 60 * 60 * 1000;
    let expired = 0;
    for (const a of fakeAlerts) {
      if (a.status === 'pending' && a.created_at.getTime() < cutoff) {
        a.status = 'expired';
        // Intentionally leave a.responded_at = null.
        expired++;
      }
    }
    return { rows: [], rowCount: expired };
  }
  // List route
  if (/^SELECT id, email_account_id, scan_id, sender_domain, subject_excerpt, delete_after_seconds, status, responded_at, created_at FROM email_tamper_alerts/i.test(trimmed)) {
    const [userId] = params as [string];
    const statusFilter = /status = \$2/.test(trimmed) ? (params[1] as string) : null;
    const limit = params[params.length - 1] as number;
    const filtered = fakeAlerts
      .filter((a) => a.user_id === userId)
      .filter((a) => !statusFilter || a.status === statusFilter)
      .slice(0, limit);
    return { rows: filtered, rowCount: filtered.length };
  }
  // emitMetric writes to metric_counters via an UPSERT. Swallow
  // as a no-op so the strict "throw on unstubbed SQL" guard below
  // doesn't reject the side effect.
  if (/^INSERT INTO metric_counters/i.test(trimmed)) {
    return { rows: [], rowCount: 1 };
  }
  throw new Error(`unstubbed SQL: ${trimmed.slice(0, 120)}`);
};

const fakePushSender = async (payload: {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<number> => {
  pushCalls.push({
    userId: payload.userId,
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
  });
  return 1;
};

beforeEach(() => {
  fakeScans = [];
  fakeAlerts = [];
  fakeReports = [];
  pushCalls = [];
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

// ----------------------------------------------------------------
// Detector unit tests
// ----------------------------------------------------------------

describe('inboxTamperDetector.maybeFireTamperAlert', () => {
  function pushScan(verdict: FakeScan['verdict']): FakeScan {
    const s: FakeScan = {
      id: `scan-${fakeScans.length + 1}`,
      user_id: SYNTHETIC_USER_ID,
      email_account_id: 'acct-1',
      verdict,
      sender_domain: 'example.com',
      subject_excerpt: 'Q4 invoice update',
    };
    fakeScans.push(s);
    return s;
  }

  it('fires an alert + push for a safe-verdict message deleted within the window', async () => {
    const s = pushScan('safe');
    const result = await detector.maybeFireTamperAlert(
      {
        scan_id: s.id,
        user_id: s.user_id,
        email_account_id: s.email_account_id,
        delete_after_seconds: 120,
      },
      { pushSender: fakePushSender },
    );
    assert.equal(result.fired, true);
    assert.ok(result.alert_id);
    assert.equal(fakeAlerts.length, 1);
    assert.equal(fakeAlerts[0]!.delete_after_seconds, 120);
    // Push fired with the right payload + non-PII body.
    assert.equal(pushCalls.length, 1);
    assert.match(pushCalls[0]!.title, /Did you delete this email/i);
    // PRIVACY (adversarial-review H4): the push body is GENERIC —
    // sender_domain is NOT in it. It only lives in `data` so iOS
    // renders it inside the unlocked app, never on lock screen /
    // CarPlay / watchOS mirrors.
    assert.ok(!pushCalls[0]!.body.includes('example.com'));
    // The subject_excerpt is NOT in the push body — only on the
    // detail screen iOS pulls via the list endpoint.
    assert.ok(!pushCalls[0]!.body.includes('Q4 invoice update'));
    assert.equal(pushCalls[0]!.data.kind, 'email_tamper_alert');
    // The sender_domain IS in the data dictionary for the detail screen.
    assert.equal(pushCalls[0]!.data.sender_domain, 'example.com');
  });

  it('skips when verdict is fraud (user is supposed to delete those)', async () => {
    const s = pushScan('fraud');
    const result = await detector.maybeFireTamperAlert(
      {
        scan_id: s.id,
        user_id: s.user_id,
        email_account_id: s.email_account_id,
        delete_after_seconds: 60,
      },
      { pushSender: fakePushSender },
    );
    assert.equal(result.fired, false);
    assert.equal(result.reason_skipped, 'verdict_was_fraud');
    assert.equal(pushCalls.length, 0);
  });

  it('skips when delete is outside the window (e.g. 30 minutes later)', async () => {
    const s = pushScan('safe');
    const result = await detector.maybeFireTamperAlert(
      {
        scan_id: s.id,
        user_id: s.user_id,
        email_account_id: s.email_account_id,
        delete_after_seconds: 30 * 60, // 30 min — outside default 10-min window
      },
      { pushSender: fakePushSender },
    );
    assert.equal(result.fired, false);
    assert.equal(result.reason_skipped, 'outside_window');
  });

  it('respects a custom window override', async () => {
    const s = pushScan('safe');
    const result = await detector.maybeFireTamperAlert(
      {
        scan_id: s.id,
        user_id: s.user_id,
        email_account_id: s.email_account_id,
        delete_after_seconds: 1200, // 20 min
      },
      { window_seconds: 1500, pushSender: fakePushSender },
    );
    assert.equal(result.fired, true);
  });

  it('skips when scan is not found (race: history page replayed an unknown id)', async () => {
    const result = await detector.maybeFireTamperAlert(
      {
        scan_id: 'scan-nonexistent',
        user_id: SYNTHETIC_USER_ID,
        email_account_id: 'acct-1',
        delete_after_seconds: 60,
      },
      { pushSender: fakePushSender },
    );
    assert.equal(result.fired, false);
    assert.equal(result.reason_skipped, 'scan_not_found');
  });

  it('caps per-user pending alerts at 5 to avoid push overload', async () => {
    // Pre-load 5 pending alerts.
    for (let i = 0; i < 5; i++) {
      fakeAlerts.push({
        id: `existing-${i}`,
        user_id: SYNTHETIC_USER_ID,
        email_account_id: 'acct-1',
        scan_id: `pre-${i}`,
        sender_domain: 'x.com', subject_excerpt: 'x',
        delete_after_seconds: 30,
        status: 'pending',
        responded_at: null,
        created_at: new Date(),
      });
    }
    const s = pushScan('safe');
    const result = await detector.maybeFireTamperAlert(
      {
        scan_id: s.id,
        user_id: s.user_id,
        email_account_id: s.email_account_id,
        delete_after_seconds: 60,
      },
      { pushSender: fakePushSender },
    );
    assert.equal(result.fired, false);
    assert.equal(result.reason_skipped, 'pending_cap_reached');
    assert.equal(pushCalls.length, 0);
  });

  it('is idempotent — second call for same scan_id no-ops', async () => {
    const s = pushScan('safe');
    await detector.maybeFireTamperAlert(
      { scan_id: s.id, user_id: s.user_id, email_account_id: s.email_account_id, delete_after_seconds: 60 },
      { pushSender: fakePushSender },
    );
    const second = await detector.maybeFireTamperAlert(
      { scan_id: s.id, user_id: s.user_id, email_account_id: s.email_account_id, delete_after_seconds: 60 },
      { pushSender: fakePushSender },
    );
    assert.equal(second.fired, false);
    assert.equal(second.reason_skipped, 'already_alerted');
    assert.equal(fakeAlerts.length, 1);
    // Push only fired on the first call.
    assert.equal(pushCalls.length, 1);
  });

  it('push failure does NOT roll back the DB row (best-effort)', async () => {
    const s = pushScan('safe');
    const throwingPush = async (): Promise<number> => {
      throw new Error('APNs down');
    };
    const result = await detector.maybeFireTamperAlert(
      { scan_id: s.id, user_id: s.user_id, email_account_id: s.email_account_id, delete_after_seconds: 60 },
      { pushSender: throwingPush },
    );
    // DB INSERT still succeeded; iOS will surface the alert on the
    // next foreground fetch via /v1/email/tamper-alerts.
    assert.equal(result.fired, true);
    assert.equal(fakeAlerts.length, 1);
  });
});

// ----------------------------------------------------------------
// resolveTamperAlert
// ----------------------------------------------------------------

describe('inboxTamperDetector.resolveTamperAlert', () => {
  function seedAlert(status: FakeAlert['status'], age_ms = 0): FakeAlert {
    const id = `alert-${fakeAlerts.length + 1}`;
    const a: FakeAlert = {
      id,
      user_id: SYNTHETIC_USER_ID,
      email_account_id: 'acct-1',
      scan_id: `s-${id}`,
      sender_domain: 'sketchy.xyz',
      subject_excerpt: 'wire',
      delete_after_seconds: 60,
      status,
      responded_at: status === 'pending' ? null : new Date(Date.now() - age_ms),
      created_at: new Date(Date.now() - age_ms),
    };
    fakeAlerts.push(a);
    return a;
  }

  it("accepts 'confirmed' — no escalation", async () => {
    const a = seedAlert('pending');
    const r = await detector.resolveTamperAlert({
      alert_id: a.id, user_id: a.user_id, decision: 'confirmed',
    });
    assert.equal(r.ok, true);
    assert.equal(r.escalated_to_compromise_report, false);
    assert.equal(a.status, 'confirmed');
    assert.equal(fakeReports.length, 0);
  });

  it('returns ok=false when alert is not pending (replay)', async () => {
    const a = seedAlert('confirmed');
    const r = await detector.resolveTamperAlert({
      alert_id: a.id, user_id: a.user_id, decision: 'denied',
    });
    assert.equal(r.ok, false);
  });

  it("returns ok=false on cross-user alert_id", async () => {
    const a = seedAlert('pending');
    const r = await detector.resolveTamperAlert({
      alert_id: a.id, user_id: 'other-user', decision: 'confirmed',
    });
    assert.equal(r.ok, false);
  });

  it('first denial does NOT escalate yet (threshold = 3)', async () => {
    const a = seedAlert('pending');
    const r = await detector.resolveTamperAlert({
      alert_id: a.id, user_id: a.user_id, decision: 'denied',
    });
    assert.equal(r.ok, true);
    assert.equal(r.escalated_to_compromise_report, false);
    assert.equal(fakeReports.length, 0);
  });

  it('third denial within 24h escalates to a compromise report', async () => {
    // Two prior denials in the rolling window.
    seedAlert('denied', 10 * 60 * 1000); // 10 min ago
    seedAlert('denied', 20 * 60 * 1000); // 20 min ago
    // Third — about to be resolved.
    const a = seedAlert('pending');
    const r = await detector.resolveTamperAlert({
      alert_id: a.id, user_id: a.user_id, decision: 'denied',
    });
    assert.equal(r.ok, true);
    assert.equal(r.escalated_to_compromise_report, true);
    assert.equal(fakeReports.length, 1);
    assert.equal(fakeReports[0]!.overall_verdict, 'compromised');
    const findings = fakeReports[0]!.findings as { inbox_tamper_alerts: { denial_count_24h: number } };
    assert.equal(findings.inbox_tamper_alerts.denial_count_24h, 3);
  });

  it('race-safe: a peer-inserted compromise report deduplicates the second escalation', async () => {
    // Adversarial-review H2: three near-simultaneous denials each see
    // denialCount=3 under READ COMMITTED. The new WHERE-NOT-EXISTS
    // guard ensures only one compromise report row ends up inserted.
    // We simulate this by pre-seeding a fresh report and then driving
    // an escalating denial — the INSERT should hit the dedup branch.
    seedAlert('denied', 5 * 60 * 1000);
    seedAlert('denied', 10 * 60 * 1000);
    const a = seedAlert('pending');
    // Pre-existing report from a peer's denial 30s ago.
    fakeReports.push({
      id: 'peer-report',
      user_id: a.user_id,
      email_account_id: a.email_account_id,
      overall_verdict: 'compromised',
      findings: { inbox_tamper_alerts: { denial_count_24h: 3, threshold: 3 } },
      generated_at: new Date(Date.now() - 30_000),
    });
    const r = await detector.resolveTamperAlert({
      alert_id: a.id, user_id: a.user_id, decision: 'denied',
    });
    assert.equal(r.ok, true);
    // Caller still sees escalated=true — the incident IS on file.
    assert.equal(r.escalated_to_compromise_report, true);
    // But only one report row exists, not two.
    assert.equal(fakeReports.length, 1);
    assert.equal(fakeReports[0]!.id, 'peer-report');
  });
});

// ----------------------------------------------------------------
// expireStaleTamperAlerts
// ----------------------------------------------------------------

describe('inboxTamperDetector.expireStaleTamperAlerts', () => {
  it('flips pending alerts older than 72h to expired', async () => {
    // 80h old pending — should expire.
    fakeAlerts.push({
      id: 'stale', user_id: SYNTHETIC_USER_ID, email_account_id: 'a',
      scan_id: 's', sender_domain: 'x', subject_excerpt: 'x',
      delete_after_seconds: 60,
      status: 'pending',
      responded_at: null,
      created_at: new Date(Date.now() - 80 * 60 * 60 * 1000),
    });
    // 1h old pending — should stay.
    fakeAlerts.push({
      id: 'fresh', user_id: SYNTHETIC_USER_ID, email_account_id: 'a',
      scan_id: 's2', sender_domain: 'x', subject_excerpt: 'x',
      delete_after_seconds: 60,
      status: 'pending',
      responded_at: null,
      created_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const { expired } = await detector.expireStaleTamperAlerts();
    assert.equal(expired, 1);
    assert.equal(fakeAlerts.find((a) => a.id === 'stale')!.status, 'expired');
    assert.equal(fakeAlerts.find((a) => a.id === 'fresh')!.status, 'pending');
  });

  it('does NOT set responded_at on cron-expired rows (adversarial-review H3)', async () => {
    // responded_at is reserved for "the user tapped a button." The
    // cron-expiry MUST leave it NULL so GDPR exports and future
    // queries don't falsely claim user engagement.
    fakeAlerts.push({
      id: 'stale2', user_id: SYNTHETIC_USER_ID, email_account_id: 'a',
      scan_id: 's3', sender_domain: 'x', subject_excerpt: 'x',
      delete_after_seconds: 60,
      status: 'pending',
      responded_at: null,
      created_at: new Date(Date.now() - 100 * 60 * 60 * 1000),
    });
    await detector.expireStaleTamperAlerts();
    const row = fakeAlerts.find((a) => a.id === 'stale2')!;
    assert.equal(row.status, 'expired');
    assert.equal(row.responded_at, null);
  });
});

// ----------------------------------------------------------------
// Route tests — list + respond
// ----------------------------------------------------------------

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(fastifyRateLimit, { global: false, max: 9999, timeWindow: '1 minute' });
  await app.register(emailShieldRoutes);
  return app;
}
const PRO_BEARER = `Bearer ${SHARED_SECRET}`;

describe('GET /v1/email/tamper-alerts', () => {
  it('returns the user\'s pending alerts by default', async () => {
    fakeAlerts.push({
      id: '00000000-0000-0000-0000-0000000000aa',
      user_id: SYNTHETIC_USER_ID, email_account_id: 'a',
      scan_id: 's', sender_domain: 'sketchy.xyz', subject_excerpt: 'wire $50k',
      delete_after_seconds: 90, status: 'pending',
      responded_at: null, created_at: new Date(),
    });
    fakeAlerts.push({
      id: '00000000-0000-0000-0000-0000000000bb',
      user_id: SYNTHETIC_USER_ID, email_account_id: 'a',
      scan_id: 's2', sender_domain: 'sketchy.xyz', subject_excerpt: 'old',
      delete_after_seconds: 90, status: 'confirmed',
      responded_at: new Date(), created_at: new Date(Date.now() - 60_000),
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/email/tamper-alerts',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { alerts: { id: string; status: string }[] };
      assert.equal(body.alerts.length, 1);
      assert.equal(body.alerts[0]!.status, 'pending');
    } finally {
      await app.close();
    }
  });

  it("400s on invalid status query param (adversarial-review H5)", async () => {
    // Old code silently returned [] for typos like ?status=Pending.
    // The Zod enum guard now fails closed so iOS clients learn
    // about contract violations instead of seeing a phantom-empty
    // inbox during a real compromise.
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/email/tamper-alerts?status=Pending',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it("accepts ?status=all to return every status", async () => {
    fakeAlerts.push({
      id: '00000000-0000-0000-0000-000000000aaa',
      user_id: SYNTHETIC_USER_ID, email_account_id: 'a',
      scan_id: 'sa', sender_domain: 'x', subject_excerpt: 'x',
      delete_after_seconds: 60, status: 'pending',
      responded_at: null, created_at: new Date(),
    });
    fakeAlerts.push({
      id: '00000000-0000-0000-0000-000000000bbb',
      user_id: SYNTHETIC_USER_ID, email_account_id: 'a',
      scan_id: 'sb', sender_domain: 'x', subject_excerpt: 'x',
      delete_after_seconds: 60, status: 'expired',
      responded_at: null, created_at: new Date(Date.now() - 100_000),
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/email/tamper-alerts?status=all',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { alerts: { status: string }[] };
      assert.equal(body.alerts.length, 2);
    } finally {
      await app.close();
    }
  });
});

describe('POST /v1/email/tamper-alerts/:id/respond', () => {
  it("accepts 'denied' on a pending alert + returns escalation flag", async () => {
    fakeAlerts.push({
      id: '00000000-0000-0000-0000-0000000000cc',
      user_id: SYNTHETIC_USER_ID, email_account_id: 'a',
      scan_id: 's3', sender_domain: 'x', subject_excerpt: 'x',
      delete_after_seconds: 90, status: 'pending',
      responded_at: null, created_at: new Date(),
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/tamper-alerts/00000000-0000-0000-0000-0000000000cc/respond',
        headers: { authorization: PRO_BEARER },
        payload: { decision: 'denied' },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { decision: string; escalated_to_compromise_report: boolean };
      assert.equal(body.decision, 'denied');
      assert.equal(body.escalated_to_compromise_report, false); // only one denial
    } finally {
      await app.close();
    }
  });

  it('returns 404 on cross-user alert id', async () => {
    fakeAlerts.push({
      id: '00000000-0000-0000-0000-0000000000dd',
      user_id: 'other-user', email_account_id: 'a',
      scan_id: 's4', sender_domain: 'x', subject_excerpt: 'x',
      delete_after_seconds: 60, status: 'pending',
      responded_at: null, created_at: new Date(),
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/tamper-alerts/00000000-0000-0000-0000-0000000000dd/respond',
        headers: { authorization: PRO_BEARER },
        payload: { decision: 'confirmed' },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  it('returns 400 on malformed UUID', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/tamper-alerts/not-a-uuid/respond',
        headers: { authorization: PRO_BEARER },
        payload: { decision: 'confirmed' },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it('returns 400 on invalid decision', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/tamper-alerts/00000000-0000-0000-0000-0000000000ee/respond',
        headers: { authorization: PRO_BEARER },
        payload: { decision: 'maybe' },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});
