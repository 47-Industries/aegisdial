import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 17 — sentinel × playbook coverage tests.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-sentinel-coverage';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-sentinel-coverage';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { adminRoutes } = await import('../src/routes/admin.ts');
const cov = await import('../src/services/v4SentinelCoverageSummary.ts');
const playbooks = await import('../src/data/playbooks.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;
const TOTAL_PLAYBOOKS = playbooks.PLAYBOOKS.length;

describe('summarizeSentinelCoverageRows — zero-fill', () => {
  it('returns one row per playbook even with empty input', () => {
    const out = cov.summarizeSentinelCoverageRows([], { hours: 24 });
    assert.equal(out.rows.length, TOTAL_PLAYBOOKS);
    for (const r of out.rows) {
      assert.equal(r.total_fires, 0);
      assert.equal(r.coverage, 'no_data');
      assert.equal(r.patterns.length, 0);
    }
  });

  it('coverage=covered for a playbook with >= 1 fire; no_data otherwise', () => {
    const out = cov.summarizeSentinelCoverageRows(
      [
        { playbook_id: 'bank_impersonation', pattern: 'verify_identity', count: 5 },
      ],
      { hours: 24 },
    );
    const bank = out.rows.find((r) => r.playbook_id === 'bank_impersonation')!;
    const irs = out.rows.find((r) => r.playbook_id === 'irs_impersonation')!;
    assert.equal(bank.coverage, 'covered');
    assert.equal(bank.total_fires, 5);
    assert.equal(irs.coverage, 'no_data');
  });
});

describe('summarizeSentinelCoverageRows — none-playbook bucket (pre-classification fires)', () => {
  it('aggregates fires with playbook_id=none into the none_playbook bucket', () => {
    const out = cov.summarizeSentinelCoverageRows(
      [
        { playbook_id: 'none', pattern: 'verify_identity', count: 3 },
        { playbook_id: 'none', pattern: 'transfer_request', count: 2 },
        { playbook_id: 'bank_impersonation', pattern: 'verify_identity', count: 5 },
      ],
      { hours: 24 },
    );
    assert.equal(out.none_playbook.total_fires, 5);
    assert.equal(out.none_playbook.patterns.length, 2);
    assert.equal(out.none_playbook.patterns[0]!.pattern, 'verify_identity', 'sorted by count desc');
    assert.equal(out.none_playbook.patterns[0]!.count, 3);
    // Bank playbook still tracks separately.
    assert.equal(
      out.rows.find((r) => r.playbook_id === 'bank_impersonation')!.total_fires,
      5,
    );
  });
});

describe('summarizeSentinelCoverageRows — patterns sorted by count desc with lex tie-break', () => {
  it('orders patterns by count desc, alphabetical on ties', () => {
    const out = cov.summarizeSentinelCoverageRows(
      [
        { playbook_id: 'bank_impersonation', pattern: 'zebra', count: 5 },
        { playbook_id: 'bank_impersonation', pattern: 'alpha', count: 5 },
        { playbook_id: 'bank_impersonation', pattern: 'most_common', count: 10 },
      ],
      { hours: 24 },
    );
    const bank = out.rows.find((r) => r.playbook_id === 'bank_impersonation')!;
    assert.deepEqual(
      bank.patterns.map((p) => p.pattern),
      ['most_common', 'alpha', 'zebra'],
    );
  });

  it('folds duplicate (playbook, pattern) rows additively', () => {
    const out = cov.summarizeSentinelCoverageRows(
      [
        { playbook_id: 'bank_impersonation', pattern: 'verify_identity', count: 3 },
        { playbook_id: 'bank_impersonation', pattern: 'verify_identity', count: 7 },
      ],
      { hours: 24 },
    );
    const bank = out.rows.find((r) => r.playbook_id === 'bank_impersonation')!;
    assert.equal(bank.total_fires, 10);
    assert.equal(bank.patterns[0]!.count, 10);
  });
});

describe('summarizeSentinelCoverageRows — total_events covers off-taxonomy too (M-1 fix)', () => {
  // M-1 from Phase 17 adversarial: pre-fix, off-taxonomy fires were
  // dropped from total_events. The operator's cross-check
  // sum(rows.total) + none.total + dropped.count == total_events
  // would fail during the pre-Phase-17 backfill window.
  it('total_events sums canonical + none + off-taxonomy', () => {
    const out = cov.summarizeSentinelCoverageRows(
      [
        { playbook_id: 'bank_impersonation', pattern: 'p', count: 3 },
        { playbook_id: 'none', pattern: 'p', count: 5 },
        { playbook_id: 'unknown_xyz', pattern: 'p', count: 7 },
        { playbook_id: '__untagged__', pattern: 'p', count: 11 },
      ],
      { hours: 24 },
    );
    const canonicalSum = out.rows.reduce((a, r) => a + r.total_fires, 0);
    assert.equal(canonicalSum, 3);
    assert.equal(out.none_playbook.total_fires, 5);
    assert.equal(out.dropped_off_taxonomy.count, 18);
    assert.equal(
      out.total_events,
      3 + 5 + 18,
      'total_events covers ALL counted fires (canonical + none + off-taxonomy)',
    );
  });
});

describe('summarizeSentinelCoverageRows — reserved sentinel collision invariant (L-1 fix)', () => {
  it('RESERVED_PLAYBOOK_ID_NONE is "none"', () => {
    assert.equal(cov.RESERVED_PLAYBOOK_ID_NONE, 'none');
  });

  it('no canonical playbook has id="none" — runtime guard would have thrown at import', async () => {
    // Re-importing here verifies the load-time invariant didn't fire.
    const ids = playbooks.PLAYBOOKS.map((p) => p.id);
    assert.ok(
      !ids.includes('none' as never),
      'sentinel value collision — "none" must not be a canonical PlaybookId',
    );
  });
});

describe('summarizeSentinelCoverageRows — off-taxonomy defense', () => {
  it('surfaces unknown playbook ids in dropped_off_taxonomy', () => {
    const out = cov.summarizeSentinelCoverageRows(
      [
        { playbook_id: 'unknown_pb', pattern: 'verify_identity', count: 9 },
        { playbook_id: 'bank_impersonation', pattern: 'verify_identity', count: 5 },
      ],
      { hours: 24 },
    );
    assert.equal(out.dropped_off_taxonomy.count, 9);
    assert.equal(out.dropped_off_taxonomy.samples[0]!.playbook_id, 'unknown_pb');
  });

  it('surfaces pre-Phase-17 untagged rows (NULL playbook_id) as off-taxonomy', () => {
    const out = cov.summarizeSentinelCoverageRows(
      [
        { playbook_id: '__untagged__', pattern: 'verify_identity', count: 12 },
      ],
      { hours: 24 },
    );
    assert.equal(out.dropped_off_taxonomy.count, 12);
  });

  it('caps off-taxonomy samples at 10', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      playbook_id: `unknown_${i}`,
      pattern: 'x',
      count: 1,
    }));
    const out = cov.summarizeSentinelCoverageRows(rows, { hours: 24 });
    assert.equal(out.dropped_off_taxonomy.count, 25);
    assert.equal(out.dropped_off_taxonomy.samples.length, 10);
  });
});

// --- Route ---

let queryLog: Array<{ text: string; params: unknown[] }> = [];
let nextRows: Array<{ playbook_id: string; pattern: string; count: string }> = [];

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  queryLog.push({ text, params });
  if (/v3\.sentinel_matcher\.fired/i.test(text)) {
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

describe('GET /admin/v4/sentinel-coverage — route', () => {
  it('returns 401 without bearer', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/admin/v4/sentinel-coverage' });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  it('uses shared parseHoursParam — clamp + ill-formed rejection', async () => {
    const app = await buildApp();
    try {
      const clamp = await app.inject({
        method: 'GET',
        url: '/admin/v4/sentinel-coverage?hours=9999',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal((clamp.json() as { hours: number }).hours, 168);

      const bad = await app.inject({
        method: 'GET',
        url: '/admin/v4/sentinel-coverage?hours=1.5',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(bad.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it('reshapes raw SUM rows into per-playbook coverage end-to-end', async () => {
    nextRows = [
      { playbook_id: 'bank_impersonation', pattern: 'verify_identity', count: '12' },
      { playbook_id: 'bank_impersonation', pattern: 'transfer_request', count: '4' },
      { playbook_id: 'none', pattern: 'verify_identity', count: '8' },
    ];
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v4/sentinel-coverage?hours=6',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        hours: number;
        total_events: number;
        rows: Array<{ playbook_id: string; total_fires: number; coverage: string }>;
        none_playbook: { total_fires: number };
      };
      assert.equal(body.hours, 6);
      assert.equal(body.total_events, 24);
      const bank = body.rows.find((r) => r.playbook_id === 'bank_impersonation')!;
      assert.equal(bank.total_fires, 16);
      assert.equal(bank.coverage, 'covered');
      assert.equal(body.none_playbook.total_fires, 8);
    } finally {
      await app.close();
    }
  });
});
