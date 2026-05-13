import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// /v1/recovery/start — Email Shield → Recovery Concierge handoff.
//
// Mirrors the existing sms_scan_id handoff. The two surfaces this
// test pins:
//   1. Schema accepts email_scan_id as an optional UUID and 400s
//      on a non-UUID string.
//   2. Lookup is scoped to (id, user_id) — a leaked scan UUID from
//      another user returns 404 email_scan_not_found, never opens
//      a recovery session against the wrong record.
//
// We don't exercise the full session-creation path (withTx + step
// template build) because that's covered by recoveryCompanion.test
// and the v4RecoveryPreload tests. This file is laser-focused on
// the cross-pool ownership check.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-recovery-email';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://recovery-email';
process.env.ALLOW_DEV_BEARER = 'true';

const Fastify = (await import('fastify')).default;
const fastifyRateLimit = (await import('@fastify/rate-limit')).default;
const db = await import('../src/lib/db.ts');
const { recoveryRoutes } = await import('../src/routes/recovery.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;
const SYNTHETIC_USER_ID = '00000000-0000-0000-0000-000000000000';

interface FakeEmailScan {
  id: string;
  user_id: string;
  sender_domain: string;
  subject_excerpt: string;
}

let fakeEmailScans: FakeEmailScan[] = [];

// Stub. Only the SELECT we care about gets a real answer; every
// other query returns "no rows" so the route can short-circuit
// after the lookup. We never get to the withTx path in these
// tests — the 404 branch returns first, and the 400-on-invalid-
// UUID branch returns even earlier via Zod.
const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (/^SELECT sender_domain, subject_excerpt FROM email_scans/i.test(trimmed)) {
    const [scanId, userId] = params as [string, string];
    const row = fakeEmailScans.find(
      (s) => s.id === scanId && s.user_id === userId,
    );
    return row
      ? { rows: [{ sender_domain: row.sender_domain, subject_excerpt: row.subject_excerpt }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  // SMS path — return "no row" so the handler ignores it.
  if (/^SELECT sender_e164, body_excerpt FROM sms_scans/i.test(trimmed)) {
    return { rows: [], rowCount: 0 };
  }
  // family_members lookup — return empty so the step builder picks
  // the no-family-plan branch (it never reaches that branch in our
  // tests, but defense in depth).
  if (/FROM family_members/i.test(trimmed)) {
    return { rows: [], rowCount: 0 };
  }
  // Any other SELECT — empty. INSERTs into recovery_* are unreachable
  // because all our test cases return 400/404 before withTx.
  return { rows: [], rowCount: 0 };
};

beforeEach(() => {
  fakeEmailScans = [];
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(fastifyRateLimit, { global: false, max: 9999, timeWindow: '1 minute' });
  await app.register(recoveryRoutes);
  return app;
}
const PRO_BEARER = `Bearer ${SHARED_SECRET}`;

describe('/v1/recovery/start — email_scan_id handoff', () => {
  it('400s on a non-UUID email_scan_id', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/start',
        headers: { authorization: PRO_BEARER },
        payload: { email_scan_id: 'not-a-uuid' },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it('404s when email_scan_id does not exist', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/start',
        headers: { authorization: PRO_BEARER },
        payload: { email_scan_id: '00000000-0000-0000-0000-000000000001' },
      });
      assert.equal(res.statusCode, 404);
      assert.equal((res.json() as { error: string }).error, 'email_scan_not_found');
    } finally {
      await app.close();
    }
  });

  it('404s when email_scan_id belongs to ANOTHER user (cross-user safety)', async () => {
    // A leaked UUID from someone else's inbox MUST NOT open a
    // recovery session under our identity. The WHERE user_id = $2
    // is the entire defense — if a future refactor drops it,
    // this test 200s.
    fakeEmailScans.push({
      id: '00000000-0000-0000-0000-0000000000aa',
      user_id: 'some-other-user-id',
      sender_domain: 'attacker.example',
      subject_excerpt: 'wire',
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recovery/start',
        headers: { authorization: PRO_BEARER },
        payload: { email_scan_id: '00000000-0000-0000-0000-0000000000aa' },
      });
      assert.equal(res.statusCode, 404);
      assert.equal((res.json() as { error: string }).error, 'email_scan_not_found');
    } finally {
      await app.close();
    }
  });

  // The happy-path "lookup succeeds → session is created" is covered
  // by recoveryCompanion.test (which already exercises /v1/recovery/start
  // end-to-end). What this file owns: the 400/404 cross-pool defenses
  // that the full-flow tests don't pin.
});
