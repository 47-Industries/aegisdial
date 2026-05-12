import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 20 — admin audit + 500 sanitization tests.
// Pins:
//   - Successful handler return → emits v4.admin.access metric tagged
//     by (route, operator, status)
//   - Exception in handler → 500 with sanitized body (no raw error
//     message), audit failure metric, captureError invocation
//   - X-Operator-Id header extraction with 64-char cap + 'unknown'
//     fallback
//   - Correlation id round-trip in the response body
//   - Wrapper does NOT swallow Fastify reply state (status codes
//     set by handler propagate)

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-admin-audit';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-admin-audit';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { withAdminAudit, OPERATOR_HEADER } = await import('../src/routes/adminAudit.ts');

interface MetricEmit {
  name: string;
  tags: Record<string, unknown>;
}

let emissions: MetricEmit[] = [];

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  if (/INSERT\s+INTO\s+metric_counters/i.test(text)) {
    const name = params[0] as string;
    let tags: Record<string, unknown> = {};
    try {
      tags = JSON.parse(params[1] as string) as Record<string, unknown>;
    } catch {
      // ignore
    }
    emissions.push({ name, tags });
  }
  return { rows: [], rowCount: 0 };
};

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  emissions = [];
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

async function buildApp(handler: Parameters<typeof withAdminAudit>[1]): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  app.get('/test/route', withAdminAudit('test-route', handler));
  return app;
}

describe('withAdminAudit — happy path', () => {
  it('emits v4.admin.access with route + hashed operator tags on success', async () => {
    const app = await buildApp(async (_req, reply) => reply.send({ ok: true }));
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/test/route',
        headers: { [OPERATOR_HEADER]: 'alice@example.com' },
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });
      await flushMicrotasks();
      const access = emissions.find((e) => e.name === 'v4.admin.access');
      assert.ok(access, 'audit metric must fire on success');
      assert.equal(access!.tags.route, 'test-route');
      // M-2 adversarial fix: operator id is hashed to a 12-char hex
      // prefix in the metric tag to bound cardinality. Raw value
      // appears in req.log only.
      assert.match(access!.tags.operator as string, /^[0-9a-f]{12}$/);
      assert.notEqual(access!.tags.operator, 'alice@example.com', 'raw value must not leak into metric tag');
      assert.equal(access!.tags.status, '200');
    } finally {
      await app.close();
    }
  });

  it('hashes the same operator id to the same tag (stable identity)', async () => {
    const app = await buildApp(async (_req, reply) => reply.send({ ok: true }));
    try {
      const r1 = await app.inject({
        method: 'GET',
        url: '/test/route',
        headers: { [OPERATOR_HEADER]: 'kyle' },
      });
      const r2 = await app.inject({
        method: 'GET',
        url: '/test/route',
        headers: { [OPERATOR_HEADER]: 'kyle' },
      });
      assert.equal(r1.statusCode, 200);
      assert.equal(r2.statusCode, 200);
      await flushMicrotasks();
      const accessEmits = emissions.filter((e) => e.name === 'v4.admin.access');
      assert.equal(accessEmits.length, 2);
      assert.equal(accessEmits[0]!.tags.operator, accessEmits[1]!.tags.operator);
    } finally {
      await app.close();
    }
  });

  it('different operator ids hash to different tags', async () => {
    const app = await buildApp(async (_req, reply) => reply.send({ ok: true }));
    try {
      const r1 = await app.inject({
        method: 'GET',
        url: '/test/route',
        headers: { [OPERATOR_HEADER]: 'kyle' },
      });
      const r2 = await app.inject({
        method: 'GET',
        url: '/test/route',
        headers: { [OPERATOR_HEADER]: 'jesiah' },
      });
      assert.equal(r1.statusCode, 200);
      assert.equal(r2.statusCode, 200);
      await flushMicrotasks();
      const accessEmits = emissions.filter((e) => e.name === 'v4.admin.access');
      assert.notEqual(accessEmits[0]!.tags.operator, accessEmits[1]!.tags.operator);
    } finally {
      await app.close();
    }
  });

  it('hash bounds operator tag length at 12 chars regardless of input size', async () => {
    const app = await buildApp(async (_req, reply) => reply.send({ ok: true }));
    try {
      const longId = 'x'.repeat(5000);
      const res = await app.inject({
        method: 'GET',
        url: '/test/route',
        headers: { [OPERATOR_HEADER]: longId },
      });
      assert.equal(res.statusCode, 200);
      await flushMicrotasks();
      const access = emissions.find((e) => e.name === 'v4.admin.access');
      assert.equal((access!.tags.operator as string).length, 12, 'hash truncated to 12 hex chars');
    } finally {
      await app.close();
    }
  });

  it('absent X-Operator-Id falls back to literal "unknown" (low-cardinality sentinel)', async () => {
    const app = await buildApp(async (_req, reply) => reply.send({ ok: true }));
    try {
      const res = await app.inject({ method: 'GET', url: '/test/route' });
      assert.equal(res.statusCode, 200);
      await flushMicrotasks();
      const access = emissions.find((e) => e.name === 'v4.admin.access');
      assert.equal(access!.tags.operator, 'unknown', 'sentinel preserved — not hashed');
    } finally {
      await app.close();
    }
  });

  it('propagates non-200 handler status (e.g. 400, 404) into the audit metric', async () => {
    const app = await buildApp(async (_req, reply) => reply.code(404).send({ error: 'not_found' }));
    try {
      const res = await app.inject({ method: 'GET', url: '/test/route' });
      assert.equal(res.statusCode, 404);
      await flushMicrotasks();
      const access = emissions.find((e) => e.name === 'v4.admin.access');
      assert.equal(access!.tags.status, '404', 'audit metric reflects the real handler status');
    } finally {
      await app.close();
    }
  });
});

describe('withAdminAudit — slow-route detection (Phase 21)', () => {
  it('1000ms is NOT slow (boundary: > 1000ms only — M-3 boundary pin)', async () => {
    // Adversarial review M-3: threshold check is `duration_ms > 1000`,
    // not `>= 1000`. A future refactor to `>= 1000` would pass the
    // 1050ms test below but change behavior. Pin the exact boundary
    // here.
    const fakeReq = {
      headers: {},
      log: { info: () => {}, error: () => {} },
    } as never;
    const fakeReply = {
      statusCode: 200,
      code(c: number) { this.statusCode = c; return this; },
      send() { return this; },
      sent: false,
    } as never;

    // Stub Date.now to return started=0, then started+1000=1000 on
    // second call. duration_ms = 1000, condition is `> 1000` (false).
    const originalNow = Date.now;
    let callCount = 0;
    Date.now = () => (callCount++ === 0 ? 0 : 1000);
    try {
      const wrapped = withAdminAudit('test-boundary', async () => fakeReply);
      await wrapped.call({} as never, fakeReq, fakeReply);
      await flushMicrotasks();
      const slow = emissions.find((e) => e.name === 'v4.admin.slow_route');
      assert.equal(slow, undefined, 'exactly 1000ms must NOT trigger slow_route');
    } finally {
      Date.now = originalNow;
    }
  });

  it('does NOT emit v4.admin.slow_route for fast handlers', async () => {
    const app = await buildApp(async (_req, reply) => reply.send({ ok: true }));
    try {
      const res = await app.inject({ method: 'GET', url: '/test/route' });
      assert.equal(res.statusCode, 200);
      await flushMicrotasks();
      const slow = emissions.find((e) => e.name === 'v4.admin.slow_route');
      assert.equal(slow, undefined, 'fast handler must not trigger slow_route');
    } finally {
      await app.close();
    }
  });

  it('emits v4.admin.slow_route when handler takes > 1s (drive wrapper directly to avoid Fastify Date.now interleave)', async () => {
    // Call the wrapper directly with stubbed FastifyRequest / FastifyReply
    // so the timing assertion only depends on the handler's own duration.
    // Going through `inject` makes the slow-route metric fire reliably,
    // but the timing then depends on Fastify's internal scheduling which
    // is flaky. Direct call gives us precise control via an awaited
    // setTimeout inside the handler.
    const fakeReq = {
      headers: { [OPERATOR_HEADER]: 'op-perf' },
      log: { info: () => {}, error: () => {} },
    } as never;
    let sentBody: unknown = undefined;
    const fakeReply = {
      statusCode: 200,
      code(c: number) {
        this.statusCode = c;
        return this;
      },
      send(b: unknown) {
        sentBody = b;
        return this;
      },
    } as never;

    const wrapped = withAdminAudit('test-slow', async () => {
      // 1.05s — just above the 1s threshold.
      await new Promise<void>((resolve) => setTimeout(resolve, 1050));
      return fakeReply;
    });

    await wrapped.call({} as never, fakeReq, fakeReply);
    await flushMicrotasks();
    assert.equal(sentBody, undefined, 'handler did not call reply.send — sanity check');
    const slow = emissions.find((e) => e.name === 'v4.admin.slow_route');
    assert.ok(slow, 'handler over 1s budget must emit slow_route');
    assert.equal(slow!.tags.duration_bucket, 'gt1s');
  });
});

describe('withAdminAudit — exception sanitization', () => {
  it('returns 500 with sanitized body — no raw error text leaks', async () => {
    const sensitiveMessage = 'relation "secret_table" does not exist (sql: SELECT password FROM users)';
    const app = await buildApp(async () => {
      throw new Error(sensitiveMessage);
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/test/route' });
      assert.equal(res.statusCode, 500);
      const body = res.json() as {
        error: string;
        correlation_id: string;
        route: string;
      };
      assert.equal(body.error, 'admin_route_failed');
      assert.equal(body.route, 'test-route');
      assert.match(body.correlation_id, /^[0-9a-f-]{36}$/, 'correlation_id is a UUIDv4');
      // The thrown message must NOT appear anywhere in the response.
      assert.doesNotMatch(JSON.stringify(body), /secret_table/);
      assert.doesNotMatch(JSON.stringify(body), /password/);
      assert.doesNotMatch(JSON.stringify(body), /SELECT/);
    } finally {
      await app.close();
    }
  });

  it('emits v4.admin.failed metric on exception', async () => {
    const app = await buildApp(async () => {
      throw new Error('boom');
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/test/route',
        headers: { [OPERATOR_HEADER]: 'op-1' },
      });
      assert.equal(res.statusCode, 500);
      await flushMicrotasks();
      const failed = emissions.find((e) => e.name === 'v4.admin.failed');
      assert.ok(failed, 'failure metric must fire on exception');
      assert.equal(failed!.tags.route, 'test-route');
      // Hashed operator tag (M-2) — 12 hex chars, not raw 'op-1'.
      assert.match(failed!.tags.operator as string, /^[0-9a-f]{12}$/);
      assert.notEqual(failed!.tags.operator, 'op-1');
      // Success metric must NOT have fired.
      const success = emissions.find((e) => e.name === 'v4.admin.access');
      assert.equal(success, undefined);
    } finally {
      await app.close();
    }
  });

  it('different requests get different correlation_ids (no static caching bug)', async () => {
    const app = await buildApp(async () => {
      throw new Error('boom');
    });
    try {
      const r1 = await app.inject({ method: 'GET', url: '/test/route' });
      const r2 = await app.inject({ method: 'GET', url: '/test/route' });
      const c1 = (r1.json() as { correlation_id: string }).correlation_id;
      const c2 = (r2.json() as { correlation_id: string }).correlation_id;
      assert.notEqual(c1, c2, 'correlation ids must be per-request');
    } finally {
      await app.close();
    }
  });
});
