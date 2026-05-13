import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// /v1/stats/summary tests. Two surfaces matter:
//   1. The countOrZero guard MUST swallow per-query failures — the
//      home screen renders off this endpoint and a missing migration
//      on a rolling deploy can NOT 500 it.
//   2. The new Email Shield + SMS Shield + Identity Shield fields
//      must be present in the response shape so iOS doesn't render
//      NaN. Identity Shield I-P5 added the identity_shield nested
//      block (monitors_active, new_findings_7d, active_threats_*).

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-stats';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://stats';
process.env.ALLOW_DEV_BEARER = 'true';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { statsRoutes } = await import('../src/routes/stats.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;

// Throw-every-query stub. Proves countOrZero fully wraps the response.
const throwingQuery = async (): Promise<never> => {
  throw new Error('simulated relation does not exist');
};

// Selective-throw stub. email_* throws (migration not applied yet);
// everything else succeeds with COUNT=0. Proves the per-query catch
// is per-query, not all-or-nothing.
const selectivelyThrowingQuery = async (
  text: string,
): Promise<{ rows: { count: string }[]; rowCount: number }> => {
  if (/FROM email_/i.test(text)) {
    throw new Error('relation "email_scans" does not exist');
  }
  return { rows: [{ count: '0' }], rowCount: 1 };
};

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(statsRoutes);
  return app;
}

describe('/v1/stats/summary — countOrZero protection (H1 adversarial fix)', () => {
  beforeEach(() => {
    (db.pool as unknown as { query: unknown }).query = throwingQuery;
  });

  it('returns 200 with all-zero counts when every underlying table is missing', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/stats/summary',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as Record<string, number>;
      assert.equal(body.shields_this_week, 0);
      assert.equal(body.critical_calls_avoided_30d, 0);
      assert.equal(body.breaches_found_30d, 0);
      assert.equal(body.sms_scans_flagged_30d, 0);
      assert.equal(body.email_scans_flagged_30d, 0);
      assert.equal(body.email_compromise_alerts_30d, 0);
      assert.equal(body.email_tamper_alerts_pending, 0);
      assert.equal(body.scams_blocked_all_time, 0);
      // I-P5: identity_shield block must render with zeros when every
      // identity_* / active_threats table is missing. The home-screen
      // tile MUST NOT NaN-out on a node that hasn't applied 068–074.
      const idShield = (res.json() as Record<string, unknown>).identity_shield as Record<
        string,
        number
      >;
      assert.ok(idShield, 'identity_shield block must be present even when every table throws');
      assert.equal(idShield.monitors_active, 0);
      assert.equal(idShield.new_findings_7d, 0);
      assert.equal(idShield.active_threats_near_user_30d, 0);
      assert.equal(idShield.active_threats_delta_7d, 0);
      // PII non-leakage assertion: the identity_shield block carries
      // ONLY count fields — no email addresses, phones, hashes, salts,
      // or breach names. Counts are aggregate; values would not be.
      for (const v of Object.values(idShield)) {
        assert.equal(typeof v, 'number', `identity_shield must only carry numeric counts, got ${typeof v}`);
      }
    } finally {
      await app.close();
    }
  });
});

describe('/v1/stats/summary — partial-migration rolling-deploy state', () => {
  beforeEach(() => {
    (db.pool as unknown as { query: unknown }).query = selectivelyThrowingQuery;
  });

  it('returns 200 with email_* fields zeroed when only email_scans is missing', async () => {
    // Simulates the realistic rolling deploy state: migrations 057-059
    // not yet applied on this node, but every other table exists.
    // Home screen MUST still render. Email fields contribute 0 to
    // the aggregate; everything else flows through.
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/stats/summary',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as Record<string, number>;
      assert.equal(body.email_scans_flagged_30d, 0);
      assert.equal(body.email_compromise_alerts_30d, 0);
      assert.equal(body.email_tamper_alerts_pending, 0);
      // Non-email counts still came back from the (stub) DB as 0,
      // not undefined. iOS's number-formatting wouldn't NaN-out.
      assert.equal(typeof body.shields_this_week, 'number');
      assert.equal(typeof body.scams_blocked_all_time, 'number');
    } finally {
      await app.close();
    }
  });
});

describe('/v1/stats/summary — positive path with nonzero counts (M6 review fix)', () => {
  // Pin that the response actually reflects DB counts, not
  // hard-coded zeros. A future refactor that accidentally pinned
  // any field to a literal would slip past the all-zero tests
  // above; this test catches it.
  beforeEach(() => {
    (db.pool as unknown as { query: unknown }).query = async () => ({
      rows: [{ count: '5' }],
      rowCount: 1,
    });
  });

  it('returns 5 for every per-source count and the aggregate sum', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/stats/summary',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as Record<string, number>;
      // Per-source counts mirror the stub return.
      assert.equal(body.shields_this_week, 5);
      assert.equal(body.critical_calls_avoided_30d, 5);
      assert.equal(body.breaches_found_30d, 5);
      assert.equal(body.sms_scans_flagged_30d, 5);
      assert.equal(body.email_scans_flagged_30d, 5);
      assert.equal(body.email_compromise_alerts_30d, 5);
      // Tamper-alert pending count — new field for the home-screen
      // badge. Same stub returns 5 → 5 pending alerts shown as a dot.
      assert.equal(body.email_tamper_alerts_pending, 5);
      // Aggregate sums 4 sources: smsJunkedAllTime + criticalAvoided30d
      // + smsScansFlaggedAllTime + emailScansFlaggedAllTime = 5×4 = 20.
      // criticalAvoided30d intentionally double-counts as a source
      // (matches the pre-Email-Shield behavior); the window-mixing is
      // documented in stats.ts comments.
      assert.equal(body.scams_blocked_all_time, 20);
      // I-P5: each identity_shield count came from the stub returning
      // '5', so the block should be {5, 5, 5, 5} — proves we're not
      // pinning any field to a literal.
      const idShield = (res.json() as Record<string, unknown>).identity_shield as Record<
        string,
        number
      >;
      assert.equal(idShield.monitors_active, 5);
      assert.equal(idShield.new_findings_7d, 5);
      assert.equal(idShield.active_threats_near_user_30d, 5);
      assert.equal(idShield.active_threats_delta_7d, 5);
    } finally {
      await app.close();
    }
  });
});

describe('/v1/stats/summary — auth', () => {
  beforeEach(() => {
    (db.pool as unknown as { query: unknown }).query = async () => ({
      rows: [{ count: '0' }],
      rowCount: 1,
    });
  });

  it('rejects unauthenticated requests with 401', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/stats/summary' });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });
});
