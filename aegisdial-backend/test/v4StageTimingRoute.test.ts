import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 11 — admin route /admin/v4/stage-timing.
//
// Pins the wiring of getStageTimingSummary into the admin namespace:
//   - requireBearer enforced (401 without secret, 200 with)
//   - SQL contract matches what summarizeStageTimingRows expects
//   - hours param parsing + clamping at 1..168
//   - Fake-DB pool integration mirrors adminRecoveryGrant.test.ts

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-stage-timing-route';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-stage-timing-route';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { adminRoutes } = await import('../src/routes/admin.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;

interface QueryCall {
  text: string;
  params: unknown[];
}

let queryLog: QueryCall[] = [];
let nextRows: Array<{ playbook_id: string; stage: string; verdict: string; count: string }> = [];

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  queryLog.push({ text, params });
  if (/FROM metric_counters/i.test(text) && /v4\.stage_timing\.evaluated/i.test(text)) {
    return { rows: nextRows, rowCount: nextRows.length };
  }
  return { rows: [], rowCount: 0 };
};

beforeEach(() => {
  queryLog = [];
  nextRows = [];
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(adminRoutes);
  return app;
}

describe('GET /admin/v4/stage-timing — auth gate', () => {
  it('returns 401 without bearer token', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-timing',
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 with a wrong bearer token', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-timing',
        headers: { authorization: 'Bearer not-the-real-secret' },
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/v4/stage-timing — SQL contract', () => {
  it('issues a single SUM/GROUP BY against metric_counters with the v4.stage_timing.evaluated name filter', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-timing',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const summaryQueries = queryLog.filter(
        (q) => /v4\.stage_timing\.evaluated/i.test(q.text) && /GROUP BY/i.test(q.text),
      );
      assert.equal(summaryQueries.length, 1, 'exactly one summary query per request');
      const q = summaryQueries[0]!;
      // The interval parameter must be a "N hours" string for $1::INTERVAL.
      assert.match(
        q.params[0] as string,
        /^\d+ hours$/,
        'interval must be a "N hours" string for cast to INTERVAL',
      );
      // SUM aggregation — not raw count, because emitMetric folds buckets.
      assert.match(q.text, /SUM\(value\)/i, 'must SUM, not COUNT — bucketed counters');
    } finally {
      await app.close();
    }
  });

  it('defaults to hours=24 when no query param is provided', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-timing',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { hours: number };
      assert.equal(body.hours, 24);
      const q = queryLog.find((c) => /v4\.stage_timing\.evaluated/i.test(c.text))!;
      assert.equal(q.params[0], '24 hours');
    } finally {
      await app.close();
    }
  });

  it('clamps hours at 168 (one week — beyond retention sweep)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-timing?hours=999',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { hours: number };
      assert.equal(body.hours, 168);
      const q = queryLog.find((c) => /v4\.stage_timing\.evaluated/i.test(c.text))!;
      assert.equal(q.params[0], '168 hours', 'INTERVAL param clamped at one week');
    } finally {
      await app.close();
    }
  });

  it('returns 400 for non-numeric or non-positive hours', async () => {
    const app = await buildApp();
    try {
      const r1 = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-timing?hours=abc',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(r1.statusCode, 400);

      const r2 = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-timing?hours=0',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(r2.statusCode, 400);

      const r3 = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-timing?hours=-1',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(r3.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it('returns 400 for ill-formed numerics that parseInt would silently accept (MEDIUM-2 fix)', async () => {
    // Without strict-regex validation, parseInt would silently accept
    // these as 1, 12, 168, 1, 1 respectively — masking caller bugs.
    const cases = ['1.5', '12abc', '168.5', '1e10', '0x10'];
    const app = await buildApp();
    try {
      for (const c of cases) {
        const res = await app.inject({
          method: 'GET',
          url: `/admin/v4/stage-timing?hours=${encodeURIComponent(c)}`,
          headers: { authorization: `Bearer ${SHARED_SECRET}` },
        });
        assert.equal(res.statusCode, 400, `expected 400 for hours=${c}`);
      }
    } finally {
      await app.close();
    }
  });

  it('returns 400 for duplicated hours params (Fastify returns array — MEDIUM-3 fix)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-timing?hours=24&hours=999',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      // Strict validation must reject `string[]` at the typeof guard.
      assert.equal(res.statusCode, 400, 'duplicated query param must not be silently accepted');
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/v4/stage-timing — response shape', () => {
  it('reshapes mock SUM rows into per-(playbook, stage) summary', async () => {
    nextRows = [
      { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'in_range', count: '7' },
      { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'too_fast', count: '2' },
      { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'too_slow', count: '1' },
    ];
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-timing?hours=12',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        hours: number;
        total_events: number;
        rows: Array<{
          playbook_id: string;
          stage: string;
          total: number;
          in_range_pct: number | null;
          health: string;
        }>;
      };
      assert.equal(body.hours, 12);
      assert.equal(body.total_events, 10);
      const row = body.rows.find(
        (r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear',
      )!;
      assert.equal(row.total, 10);
      assert.equal(row.in_range_pct, 70);
      assert.equal(row.health, 'healthy');
    } finally {
      await app.close();
    }
  });

  it('parses pg numeric strings safely — SUM(value) returns string, response returns number', async () => {
    nextRows = [
      { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'in_range', count: '12345' },
    ];
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-timing',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        rows: Array<{ playbook_id: string; stage: string; total: number; in_range: number }>;
      };
      const row = body.rows.find(
        (r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear',
      )!;
      assert.equal(row.in_range, 12345, 'string count from pg must coerce to number');
      assert.equal(row.total, 12345);
    } finally {
      await app.close();
    }
  });
});
