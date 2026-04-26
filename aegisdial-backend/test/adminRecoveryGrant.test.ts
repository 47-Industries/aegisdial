import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Route tests for POST /admin/recovery/grant — Kyle's manual 30-day
// Recovery Pro grant for users met via r/Scams / AARP / press. Bypasses
// StoreKit by writing a subscriptions row with provider='admin_grant'.
//
// Same in-memory pool-mock pattern as test/routesAuthBreach.test.ts: env
// set BEFORE any src/* imports, then swap pool.query + pool.connect with
// an SQL-prefix-matching fake that mutates a local store. The admin
// endpoint is gated by `requireBearer` (shared-secret check), NOT the
// dev-bearer JWT shortcut, so we don't need ALLOW_DEV_BEARER.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-admin-shared-secret-xyz';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://admin-grant-test';
process.env.ENZOIC_MOCK = 'true';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { adminRoutes } = await import('../src/routes/admin.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;
const USER_ID_A = '11111111-1111-1111-1111-111111111111';
const USER_ID_B = '22222222-2222-2222-2222-222222222222';

interface UserRow {
  id: string;
  email: string | null;
  tier: string;
}
interface SubscriptionRow {
  user_id: string;
  provider: string;
  provider_product_id: string;
  provider_transaction_id: string;
  status: string;
  current_period_start: Date;
  current_period_end: Date;
  auto_renew: boolean;
  raw_payload: unknown;
}
interface DbState {
  users: Map<string, UserRow>;
  subscriptions: SubscriptionRow[];
}

const dbState: DbState = { users: new Map(), subscriptions: [] };

function resetDb(): void {
  dbState.users.clear();
  dbState.subscriptions.length = 0;
  dbState.users.set(USER_ID_A, {
    id: USER_ID_A,
    email: 'kyle.meets.alice@example.com',
    tier: 'pending',
  });
  dbState.users.set(USER_ID_B, {
    id: USER_ID_B,
    email: 'bob@example.com',
    tier: 'pending',
  });
}

// Parse INSERT INTO subscriptions (...) VALUES ($1, 'admin_grant', $2, ...
// The admin route inlines 'admin_grant', the product_id via $2, the
// transaction_id via $3, the interval via $4, the raw_payload via $5.
const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.trim();

  // Resolve by user_id.
  if (/^SELECT id FROM users WHERE id = \$1/i.test(t)) {
    const row = dbState.users.get(params[0] as string);
    return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // Resolve by email (case-insensitive).
  if (/^SELECT id FROM users WHERE LOWER\(email\) = LOWER\(\$1\)/i.test(t)) {
    const email = (params[0] as string).toLowerCase();
    for (const u of dbState.users.values()) {
      if (u.email && u.email.toLowerCase() === email) {
        return { rows: [{ id: u.id }], rowCount: 1 };
      }
    }
    return { rows: [], rowCount: 0 };
  }

  // The grant insert.
  if (/^INSERT INTO subscriptions[\s\S]+admin_grant/i.test(t)) {
    const [user_id, product_id, txn_id, daysStr, rawJson] = params as [
      string, string, string, string, string,
    ];
    const days = parseInt(daysStr, 10);
    const start = new Date();
    const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
    const row: SubscriptionRow = {
      user_id,
      provider: 'admin_grant',
      provider_product_id: product_id,
      provider_transaction_id: txn_id,
      status: 'active',
      current_period_start: start,
      current_period_end: end,
      auto_renew: false,
      raw_payload: JSON.parse(rawJson),
    };
    dbState.subscriptions.push(row);
    return {
      rows: [{ current_period_start: start, current_period_end: end }],
      rowCount: 1,
    };
  }

  // currentTier() own-subscription lookup.
  if (/^SELECT status, current_period_end[\s\S]+FROM subscriptions[\s\S]+WHERE user_id = \$1/i.test(t)) {
    const userId = params[0] as string;
    const rows = dbState.subscriptions
      .filter((s) => s.user_id === userId)
      .sort((a, b) => b.current_period_end.getTime() - a.current_period_end.getTime());
    const latest = rows[0];
    return latest
      ? {
          rows: [{ status: latest.status, current_period_end: latest.current_period_end }],
          rowCount: 1,
        }
      : { rows: [], rowCount: 0 };
  }

  // currentTier() family-membership lookup — no family fixtures, return empty.
  if (/FROM family_members fm/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }

  // ensureTierPersisted UPDATE users SET tier.
  if (/^UPDATE users SET tier/i.test(t)) {
    const [userId, tier] = params as [string, string];
    const row = dbState.users.get(userId);
    if (row) row.tier = tier;
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // Swallow unknowns.
  return { rows: [], rowCount: 0 };
};

(db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
(db.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => ({
  query: fakeQuery,
  release: () => {},
});

const app = Fastify({ logger: false });
await app.register(adminRoutes);
await app.ready();

const bearer = { authorization: `Bearer ${SHARED_SECRET}` };

before(() => {
  resetDb();
});
beforeEach(() => {
  resetDb();
});

describe('POST /admin/recovery/grant', () => {
  it('grants 30 days by user_id — returns user_id + current_period_end + days_granted=30', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/recovery/grant',
      headers: bearer,
      payload: { user_id: USER_ID_A },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      ok: boolean;
      user_id: string;
      current_period_end: string;
      days_granted: number;
    };
    assert.equal(body.ok, true);
    assert.equal(body.user_id, USER_ID_A);
    assert.equal(body.days_granted, 30);
    // period_end ~30 days from now, allow 5 minutes of clock drift.
    const msOut = new Date(body.current_period_end).getTime() - Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(msOut - thirtyDaysMs) < 5 * 60 * 1000);
    // One subscription row exists.
    assert.equal(dbState.subscriptions.length, 1);
    assert.equal(dbState.subscriptions[0].provider, 'admin_grant');
    assert.equal(dbState.subscriptions[0].provider_product_id, 'com.aegiadial.ios.recovery.session');
    assert.equal(dbState.subscriptions[0].auto_renew, false);
    // User's tier got reconciled to 'pro'.
    assert.equal(dbState.users.get(USER_ID_A)?.tier, 'pro');
  });

  it('grants by email (case-insensitive)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/recovery/grant',
      headers: bearer,
      payload: { email: 'KYLE.MEETS.ALICE@example.com' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { user_id: string; days_granted: number };
    assert.equal(body.user_id, USER_ID_A);
    assert.equal(body.days_granted, 30);
    assert.equal(dbState.subscriptions.length, 1);
    assert.equal(dbState.subscriptions[0].user_id, USER_ID_A);
  });

  it('returns 404 user_not_found when the email is unknown', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/recovery/grant',
      headers: bearer,
      payload: { email: 'nobody@example.com' },
    });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: string };
    assert.equal(body.error, 'user_not_found');
    assert.equal(dbState.subscriptions.length, 0);
  });

  it('returns 400 invalid_body when both email and user_id are missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/recovery/grant',
      headers: bearer,
      payload: { days: 10 },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string };
    assert.equal(body.error, 'invalid_body');
    assert.equal(dbState.subscriptions.length, 0);
  });

  it('returns 401 on the wrong bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/recovery/grant',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { user_id: USER_ID_A },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(dbState.subscriptions.length, 0);
  });

  it('honors a custom days value (60)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/recovery/grant',
      headers: bearer,
      payload: { user_id: USER_ID_B, days: 60 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      current_period_end: string;
      days_granted: number;
    };
    assert.equal(body.days_granted, 60);
    const msOut = new Date(body.current_period_end).getTime() - Date.now();
    const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(msOut - sixtyDaysMs) < 5 * 60 * 1000);
  });

  it('is NOT idempotent — two calls for the same user produce two subscription rows', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/admin/recovery/grant',
      headers: bearer,
      payload: { user_id: USER_ID_A },
    });
    assert.equal(first.statusCode, 200);
    const second = await app.inject({
      method: 'POST',
      url: '/admin/recovery/grant',
      headers: bearer,
      payload: { user_id: USER_ID_A, days: 45 },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(dbState.subscriptions.length, 2);
    // Each row has a distinct provider_transaction_id.
    assert.notEqual(
      dbState.subscriptions[0].provider_transaction_id,
      dbState.subscriptions[1].provider_transaction_id,
    );
  });
});
