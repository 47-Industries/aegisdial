import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 14 — admin route /admin/v4/calibration-scorecard.
// Mirrors Phase 11/12/13 route-test pattern with a single fake
// pool.query that routes by metric name to one of three SUM/GROUP BY
// row sets — confirms the route makes ALL THREE underlying queries
// (Promise.all) and that the composer's verdict reaches the response.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-scorecard-route';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-scorecard-route';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { adminRoutes } = await import('../src/routes/admin.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;

let queryLog: Array<{ text: string; params: unknown[] }> = [];

interface MockRows {
  timing: Array<{ playbook_id: string; stage: string; verdict: string; count: string }>;
  claims: Array<{ playbook_id: string; claim_type: string; expected: string; count: string }>;
  confidence: Array<{ playbook_id: string; stage: string; confidence_bucket: string; count: string }>;
}

const mock: MockRows = { timing: [], claims: [], confidence: [] };

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  queryLog.push({ text, params });
  if (/v4\.stage_timing\.evaluated/.test(text)) {
    return { rows: mock.timing, rowCount: mock.timing.length };
  }
  if (/v4\.b4\.claim_extracted_vs_playbook/.test(text)) {
    return { rows: mock.claims, rowCount: mock.claims.length };
  }
  if (/v4\.classifier\.classified/.test(text)) {
    return { rows: mock.confidence, rowCount: mock.confidence.length };
  }
  return { rows: [], rowCount: 0 };
};

beforeEach(() => {
  queryLog = [];
  mock.timing = [];
  mock.claims = [];
  mock.confidence = [];
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(adminRoutes);
  return app;
}

describe('GET /admin/v4/calibration-scorecard — auth + parallel fan-out', () => {
  it('returns 401 without bearer token', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/calibration-scorecard',
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  it('issues all three underlying SUM/GROUP BY queries in one request', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/calibration-scorecard',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const timing = queryLog.filter((q) => /v4\.stage_timing\.evaluated/.test(q.text)).length;
      const claims = queryLog.filter((q) => /v4\.b4\.claim_extracted_vs_playbook/.test(q.text)).length;
      const confidence = queryLog.filter((q) => /v4\.classifier\.classified/.test(q.text)).length;
      assert.equal(timing, 1, 'exactly one timing query');
      assert.equal(claims, 1, 'exactly one claim-coverage query');
      assert.equal(confidence, 1, 'exactly one confidence query');
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/v4/calibration-scorecard — hours + min_events parameters', () => {
  it('clamps hours at 168 (shared parser)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/calibration-scorecard?hours=9999',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      const body = res.json() as { hours: number };
      assert.equal(body.hours, 168);
    } finally {
      await app.close();
    }
  });

  it('rejects bad hours (1.5, abc, duplicate)', async () => {
    const app = await buildApp();
    try {
      const r1 = await app.inject({
        method: 'GET',
        url: '/admin/v4/calibration-scorecard?hours=1.5',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(r1.statusCode, 400);
      const r2 = await app.inject({
        method: 'GET',
        url: '/admin/v4/calibration-scorecard?hours=24&hours=999',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(r2.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it('accepts ?min_events=0 (staging override)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/calibration-scorecard?min_events=0',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { thresholds: { min_events: number } };
      assert.equal(body.thresholds.min_events, 0);
    } finally {
      await app.close();
    }
  });

  it('rejects ill-formed min_events (1.5, abc, > 100000)', async () => {
    const app = await buildApp();
    try {
      for (const bad of ['1.5', 'abc', '999999', '-1']) {
        const res = await app.inject({
          method: 'GET',
          url: `/admin/v4/calibration-scorecard?min_events=${encodeURIComponent(bad)}`,
          headers: { authorization: `Bearer ${SHARED_SECRET}` },
        });
        assert.equal(res.statusCode, 400, `expected 400 for min_events=${bad}`);
      }
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/v4/calibration-scorecard — verdict end-to-end', () => {
  it('returns insufficient_data when no axis has rows', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/calibration-scorecard',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      const body = res.json() as { overall: { verdict: string } };
      assert.equal(body.overall.verdict, 'insufficient_data');
    } finally {
      await app.close();
    }
  });

  it('returns needs_calibration when ALL axes have enough volume AND at least one is flagged', async () => {
    // bank_impersonation.fear timing drift (way below 70%)
    mock.timing = [
      { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'in_range', count: '10' },
      { playbook_id: 'bank_impersonation', stage: 'fear', verdict: 'too_fast', count: '90' },
    ];
    // bank_impersonation aligned coverage — expects bank_affiliation, case_number, account_tail, employee_identity
    mock.claims = [
      { playbook_id: 'bank_impersonation', claim_type: 'bank_affiliation', expected: 'true', count: '25' },
      { playbook_id: 'bank_impersonation', claim_type: 'case_number', expected: 'true', count: '25' },
      { playbook_id: 'bank_impersonation', claim_type: 'account_tail', expected: 'true', count: '25' },
      { playbook_id: 'bank_impersonation', claim_type: 'employee_identity', expected: 'true', count: '25' },
    ];
    // healthy confidence
    mock.confidence = [
      { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'gte90', count: '90' },
      { playbook_id: 'bank_impersonation', stage: 'fear', confidence_bucket: 'lt90', count: '10' },
    ];
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/calibration-scorecard?min_events=10',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        overall: { verdict: string; reason: string; all_axes_empty: boolean };
        timing: { flagged: Array<{ playbook_id: string; stage: string }> };
      };
      assert.equal(body.overall.verdict, 'needs_calibration');
      assert.match(body.overall.reason, /timing=1/);
      assert.equal(body.timing.flagged[0]!.playbook_id, 'bank_impersonation');
      assert.equal(body.timing.flagged[0]!.stage, 'fear');
    } finally {
      await app.close();
    }
  });
});
