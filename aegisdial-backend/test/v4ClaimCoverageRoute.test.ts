import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 12 — admin route /admin/v4/claim-coverage.
// Mirrors test/v4StageTimingRoute.test.ts pattern: real Fastify app +
// fake pool.query that returns fixed rows for the claim-coverage
// SUM/GROUP BY shape. Pins auth, SQL contract, hours parsing, and
// the reshape end-to-end.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-claim-coverage-route';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-claim-coverage-route';

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
  claim_type: string;
  expected: string;
  count: string;
}> = [];

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  queryLog.push({ text, params });
  if (
    /FROM metric_counters/i.test(text) &&
    /v4\.b4\.claim_extracted_vs_playbook/i.test(text)
  ) {
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

describe('GET /admin/v4/claim-coverage — auth gate', () => {
  it('returns 401 without bearer token', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/claim-coverage',
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/v4/claim-coverage — SQL contract', () => {
  it('issues a SUM/GROUP BY against metric_counters with the v4.b4.claim_extracted_vs_playbook filter', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/claim-coverage',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const matches = queryLog.filter(
        (q) =>
          /v4\.b4\.claim_extracted_vs_playbook/i.test(q.text) &&
          /GROUP BY/i.test(q.text) &&
          /SUM\(value\)/i.test(q.text),
      );
      assert.equal(matches.length, 1, 'exactly one summary query per request');
      assert.match(matches[0]!.params[0] as string, /^\d+ hours$/);
    } finally {
      await app.close();
    }
  });

  it('hours parameter clamps at 168 (parser shared with stage-timing — MEDIUM-2 protection)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/claim-coverage?hours=9999',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { hours: number };
      assert.equal(body.hours, 168);
    } finally {
      await app.close();
    }
  });

  it('returns 400 for ill-formed numerics (1.5, abc, 1e10, duplicate keys)', async () => {
    const app = await buildApp();
    try {
      const cases = ['1.5', 'abc', '1e10', '-1', '0'];
      for (const c of cases) {
        const res = await app.inject({
          method: 'GET',
          url: `/admin/v4/claim-coverage?hours=${encodeURIComponent(c)}`,
          headers: { authorization: `Bearer ${SHARED_SECRET}` },
        });
        assert.equal(res.statusCode, 400, `expected 400 for ${c}`);
      }
      // Duplicated keys → Fastify gives string[] → 400
      const dup = await app.inject({
        method: 'GET',
        url: '/admin/v4/claim-coverage?hours=24&hours=999',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(dup.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/v4/claim-coverage — response reshape', () => {
  it('reshapes raw GROUP BY rows into per-playbook coverage', async () => {
    // tech_support_scam expects ONLY employee_identity. Send an
    // observation for that PLUS a surprise (bank_affiliation).
    nextRows = [
      {
        playbook_id: 'tech_support_scam',
        claim_type: 'employee_identity',
        expected: 'true',
        count: '12',
      },
      {
        playbook_id: 'tech_support_scam',
        claim_type: 'bank_affiliation',
        expected: 'false',
        count: '4',
      },
    ];
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/claim-coverage?hours=6',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        hours: number;
        total_events: number;
        rows: Array<{
          playbook_id: string;
          calibration: string;
          total: number;
          unexpected_observed: Array<{ claim_type: string; count: number }>;
        }>;
      };
      assert.equal(body.hours, 6);
      assert.equal(body.total_events, 16);
      const row = body.rows.find((r) => r.playbook_id === 'tech_support_scam')!;
      assert.equal(row.calibration, 'surprise');
      assert.equal(row.total, 16);
      assert.equal(row.unexpected_observed[0]!.claim_type, 'bank_affiliation');
      assert.equal(row.unexpected_observed[0]!.count, 4);
    } finally {
      await app.close();
    }
  });

  it('includes expectations_hash (MEDIUM-3 — operator goalpost-shift detector)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/claim-coverage',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { expectations_hash: string };
      assert.match(body.expectations_hash, /^[a-f0-9]{12}$/);
    } finally {
      await app.close();
    }
  });

  it('numeric SUM string from pg is coerced to number in the response', async () => {
    nextRows = [
      {
        playbook_id: 'bank_impersonation',
        claim_type: 'bank_affiliation',
        expected: 'true',
        count: '54321',
      },
    ];
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/claim-coverage',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      const body = res.json() as {
        rows: Array<{
          playbook_id: string;
          expected_observed: Array<{ claim_type: string; count: number }>;
        }>;
      };
      const row = body.rows.find((r) => r.playbook_id === 'bank_impersonation')!;
      const obs = row.expected_observed.find((o) => o.claim_type === 'bank_affiliation')!;
      assert.equal(obs.count, 54321, 'string → number coercion from pg');
    } finally {
      await app.close();
    }
  });
});
