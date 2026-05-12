import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 13 — admin route /admin/v4/stage-confidence.
// Mirrors Phase 11/12 route-test pattern: real Fastify app + fake
// pool.query.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-stage-confidence-route';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-stage-confidence-route';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { adminRoutes } = await import('../src/routes/admin.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;

interface QueryCall {
  text: string;
  params: unknown[];
}

let queryLog: QueryCall[] = [];
let nextRows: Array<{
  playbook_id: string;
  stage: string;
  confidence_bucket: string;
  count: string;
}> = [];

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  queryLog.push({ text, params });
  if (/v4\.classifier\.classified/i.test(text) && /FROM metric_counters/i.test(text)) {
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

describe('GET /admin/v4/stage-confidence — auth + SQL contract', () => {
  it('returns 401 without bearer token', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-confidence',
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  it('issues a SUM/GROUP BY filtered to v4.classifier.classified', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-confidence',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const summary = queryLog.filter(
        (q) =>
          /v4\.classifier\.classified/i.test(q.text) &&
          /GROUP BY/i.test(q.text) &&
          /SUM\(value\)/i.test(q.text),
      );
      assert.equal(summary.length, 1);
      assert.match(summary[0]!.params[0] as string, /^\d+ hours$/);
    } finally {
      await app.close();
    }
  });

  it('hours param is shared parser — clamps at 168 and rejects ill-formed', async () => {
    const app = await buildApp();
    try {
      const clamp = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-confidence?hours=9999',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(clamp.statusCode, 200);
      assert.equal((clamp.json() as { hours: number }).hours, 168);

      const bad = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-confidence?hours=1.5',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(bad.statusCode, 400);

      const dup = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-confidence?hours=24&hours=999',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(dup.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/v4/stage-confidence — response reshape', () => {
  it('reshapes raw GROUP BY rows into per-(playbook, stage) bucket distribution', async () => {
    nextRows = [
      { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte90', count: '12' },
      { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'lt90', count: '4' },
      { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'lt50', count: '1' },
    ];
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-confidence?hours=12',
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
          buckets: Record<string, number>;
          high_confidence_pct: number | null;
          health: string;
        }>;
      };
      assert.equal(body.hours, 12);
      assert.equal(body.total_events, 17);
      const row = body.rows.find((r) => r.playbook_id === 'bank_impersonation' && r.stage === 'fear')!;
      assert.equal(row.total, 17);
      assert.equal(row.buckets.gte90, 12);
      assert.equal(row.buckets.lt90, 4);
      assert.equal(row.buckets.lt50, 1);
      assert.equal(row.high_confidence_pct, 70.6, '12/17 = 70.588% → 70.6');
      assert.equal(row.health, 'healthy', '>= 0.5 in gte90');
    } finally {
      await app.close();
    }
  });

  it('exposes commit_threshold + bucket_boundaries at the response root (M-1 / M-2 fixes)', async () => {
    const { config: appConfig } = await import('../src/config.ts');
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-confidence',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      const body = res.json() as {
        commit_threshold: number;
        bucket_boundaries: Record<string, number>;
      };
      assert.equal(body.commit_threshold, appConfig.V4_PLAYBOOK_MIN_CONFIDENCE);
      assert.equal(body.bucket_boundaries.lt30, 0.3);
      assert.equal(body.bucket_boundaries.lt90, 0.9);
    } finally {
      await app.close();
    }
  });

  it('numeric SUM string from pg coerces to number', async () => {
    nextRows = [
      { playbook_id: 'irs_impersonation', stage: 'authority', confidence_bucket: 'gte90', count: '54321' },
    ];
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/stage-confidence',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      const body = res.json() as {
        rows: Array<{ playbook_id: string; stage: string; buckets: Record<string, number> }>;
      };
      const row = body.rows.find((r) => r.playbook_id === 'irs_impersonation' && r.stage === 'authority')!;
      assert.equal(row.buckets.gte90, 54321);
    } finally {
      await app.close();
    }
  });
});
