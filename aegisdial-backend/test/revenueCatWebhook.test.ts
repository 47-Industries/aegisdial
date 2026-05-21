import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Route tests for POST /subscription/revenuecat/webhook — server-to-
// server entitlement events from RevenueCat. The route auth-checks via
// `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>`, then upserts
// the subscriptions table based on event type.
//
// Same in-memory pool-mock pattern as adminRecoveryGrant.test.ts.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-rc-shared-secret-xyz';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://rc-webhook-test';
process.env.ENZOIC_MOCK = 'true';
process.env.REVENUECAT_WEBHOOK_SECRET = 'rc-webhook-secret-for-tests';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { revenueCatWebhookRoutes } = await import(
  '../src/routes/revenueCatWebhook.ts'
);

const WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET!;
const USER_ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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
  users: Set<string>;
  subscriptions: SubscriptionRow[];
  tierWrites: Array<{ user_id: string; tier: string }>;
}

const dbState: DbState = {
  users: new Set([USER_ID_A]),
  subscriptions: [],
  tierWrites: [],
};

function resetDb(): void {
  dbState.users.clear();
  dbState.users.add(USER_ID_A);
  dbState.subscriptions.length = 0;
  dbState.tierWrites.length = 0;
}

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.trim();

  if (/^SELECT id FROM users WHERE id = \$1/i.test(t)) {
    return dbState.users.has(params[0] as string)
      ? { rows: [{ id: params[0] }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  if (/^INSERT INTO subscriptions/i.test(t)) {
    const [
      user_id,
      product_id,
      txn_id,
      startIso,
      endIso,
      autoRenew,
      rawJson,
    ] = params as [string, string, string, string, string, boolean, string];
    const existing = dbState.subscriptions.find(
      (s) =>
        s.provider === 'apple_storekit' &&
        s.provider_transaction_id === txn_id,
    );
    if (existing) {
      existing.current_period_end = new Date(endIso);
      existing.status = 'active';
      existing.raw_payload = JSON.parse(rawJson);
    } else {
      dbState.subscriptions.push({
        user_id,
        provider: 'apple_storekit',
        provider_product_id: product_id,
        provider_transaction_id: txn_id,
        status: 'active',
        current_period_start: new Date(startIso),
        current_period_end: new Date(endIso),
        auto_renew: autoRenew,
        raw_payload: JSON.parse(rawJson),
      });
    }
    return { rows: [], rowCount: 1 };
  }

  if (/^UPDATE subscriptions/i.test(t)) {
    const [user_id, txn_id, status] = params as [string, string, string];
    const row = dbState.subscriptions.find(
      (s) =>
        s.user_id === user_id && s.provider_transaction_id === txn_id,
    );
    if (row) {
      row.status = status;
      row.current_period_end = new Date(
        Math.min(row.current_period_end.getTime(), Date.now()),
      );
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  if (/^SELECT status, current_period_end\s+FROM subscriptions/i.test(t)) {
    const userId = params[0] as string;
    const latest = dbState.subscriptions
      .filter((s) => s.user_id === userId)
      .sort(
        (a, b) =>
          b.current_period_end.getTime() - a.current_period_end.getTime(),
      )[0];
    if (!latest) return { rows: [], rowCount: 0 };
    return {
      rows: [
        {
          status: latest.status,
          current_period_end: latest.current_period_end,
        },
      ],
      rowCount: 1,
    };
  }

  if (/^SELECT s\.status, s\.current_period_end\s+FROM family_members/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }

  if (/^UPDATE users\s+SET tier/i.test(t)) {
    const [tier, userId] = params as [string, string];
    dbState.tierWrites.push({ user_id: userId, tier });
    return { rows: [], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
};

(db as unknown as { pool: { query: typeof fakeQuery } }).pool.query =
  fakeQuery;

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(revenueCatWebhookRoutes);
  return app;
}

const authedHeaders = {
  authorization: `Bearer ${WEBHOOK_SECRET}`,
  'content-type': 'application/json',
};

const proMonthly = 'com.aegisdial.app.pro.monthly';

describe('POST /subscription/revenuecat/webhook', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  before(async () => {
    app = await buildApp();
  });
  beforeEach(resetDb);

  it('rejects an unsigned request with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/subscription/revenuecat/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        event: {
          type: 'INITIAL_PURCHASE',
          app_user_id: USER_ID_A,
          product_id: proMonthly,
        },
      }),
    });
    assert.equal(res.statusCode, 401);
    assert.equal(dbState.subscriptions.length, 0);
  });

  it('rejects a wrong-secret request with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/subscription/revenuecat/webhook',
      headers: {
        authorization: 'Bearer not-the-real-secret',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        event: {
          type: 'INITIAL_PURCHASE',
          app_user_id: USER_ID_A,
          product_id: proMonthly,
        },
      }),
    });
    assert.equal(res.statusCode, 401);
  });

  it('accepts a 200 INITIAL_PURCHASE and writes an active subscription', async () => {
    const purchasedAt = Date.now();
    const expiresAt = purchasedAt + 30 * 24 * 60 * 60 * 1000;
    const res = await app.inject({
      method: 'POST',
      url: '/subscription/revenuecat/webhook',
      headers: authedHeaders,
      payload: JSON.stringify({
        event: {
          type: 'INITIAL_PURCHASE',
          id: 'rc-event-1',
          app_user_id: USER_ID_A,
          product_id: proMonthly,
          period_type: 'NORMAL',
          purchased_at_ms: purchasedAt,
          expiration_at_ms: expiresAt,
          store: 'APP_STORE',
          original_transaction_id: 'orig-1',
          transaction_id: 'txn-1',
          environment: 'PRODUCTION',
        },
      }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(dbState.subscriptions.length, 1);
    const row = dbState.subscriptions[0]!;
    assert.equal(row.user_id, USER_ID_A);
    assert.equal(row.provider, 'apple_storekit');
    assert.equal(row.provider_product_id, proMonthly);
    assert.equal(row.provider_transaction_id, 'orig-1');
    assert.equal(row.status, 'active');
    assert.equal(row.auto_renew, true);
  });

  it('RENEWAL updates the same row (no duplicate rows)', async () => {
    const firstExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const renewedExpiresAt = firstExpiresAt + 30 * 24 * 60 * 60 * 1000;
    const base = {
      app_user_id: USER_ID_A,
      product_id: proMonthly,
      period_type: 'NORMAL',
      original_transaction_id: 'orig-1',
      transaction_id: 'txn-1',
      store: 'APP_STORE',
    };
    await app.inject({
      method: 'POST',
      url: '/subscription/revenuecat/webhook',
      headers: authedHeaders,
      payload: JSON.stringify({
        event: {
          ...base,
          type: 'INITIAL_PURCHASE',
          purchased_at_ms: Date.now(),
          expiration_at_ms: firstExpiresAt,
        },
      }),
    });
    await app.inject({
      method: 'POST',
      url: '/subscription/revenuecat/webhook',
      headers: authedHeaders,
      payload: JSON.stringify({
        event: {
          ...base,
          type: 'RENEWAL',
          purchased_at_ms: Date.now(),
          expiration_at_ms: renewedExpiresAt,
        },
      }),
    });
    assert.equal(dbState.subscriptions.length, 1);
    assert.equal(
      dbState.subscriptions[0]!.current_period_end.getTime(),
      renewedExpiresAt,
    );
  });

  it('REFUND sets status=revoked on the existing row', async () => {
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await app.inject({
      method: 'POST',
      url: '/subscription/revenuecat/webhook',
      headers: authedHeaders,
      payload: JSON.stringify({
        event: {
          type: 'INITIAL_PURCHASE',
          app_user_id: USER_ID_A,
          product_id: proMonthly,
          period_type: 'NORMAL',
          purchased_at_ms: Date.now(),
          expiration_at_ms: expiresAt,
          original_transaction_id: 'orig-1',
        },
      }),
    });
    await app.inject({
      method: 'POST',
      url: '/subscription/revenuecat/webhook',
      headers: authedHeaders,
      payload: JSON.stringify({
        event: {
          type: 'REFUND',
          app_user_id: USER_ID_A,
          original_transaction_id: 'orig-1',
        },
      }),
    });
    const row = dbState.subscriptions[0]!;
    assert.equal(row.status, 'revoked');
  });

  it('EXPIRATION sets status=expired', async () => {
    await app.inject({
      method: 'POST',
      url: '/subscription/revenuecat/webhook',
      headers: authedHeaders,
      payload: JSON.stringify({
        event: {
          type: 'INITIAL_PURCHASE',
          app_user_id: USER_ID_A,
          product_id: proMonthly,
          period_type: 'NORMAL',
          purchased_at_ms: Date.now(),
          expiration_at_ms: Date.now() + 30 * 24 * 60 * 60 * 1000,
          original_transaction_id: 'orig-1',
        },
      }),
    });
    await app.inject({
      method: 'POST',
      url: '/subscription/revenuecat/webhook',
      headers: authedHeaders,
      payload: JSON.stringify({
        event: {
          type: 'EXPIRATION',
          app_user_id: USER_ID_A,
          original_transaction_id: 'orig-1',
        },
      }),
    });
    const row = dbState.subscriptions[0]!;
    assert.equal(row.status, 'expired');
  });

  it('event for unknown app_user_id returns 200 with note (no DB writes)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/subscription/revenuecat/webhook',
      headers: authedHeaders,
      payload: JSON.stringify({
        event: {
          type: 'INITIAL_PURCHASE',
          app_user_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          product_id: proMonthly,
          period_type: 'NORMAL',
          purchased_at_ms: Date.now(),
          expiration_at_ms: Date.now() + 30 * 24 * 60 * 60 * 1000,
          original_transaction_id: 'orig-1',
        },
      }),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { received: boolean; note?: string };
    assert.equal(body.received, true);
    assert.equal(body.note, 'user_not_found');
    assert.equal(dbState.subscriptions.length, 0);
  });

  it('unknown product_id swallows handler error and returns 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/subscription/revenuecat/webhook',
      headers: authedHeaders,
      payload: JSON.stringify({
        event: {
          type: 'INITIAL_PURCHASE',
          app_user_id: USER_ID_A,
          product_id: 'com.somebodyelse.app.not.in.our.catalog',
          period_type: 'NORMAL',
          purchased_at_ms: Date.now(),
          expiration_at_ms: Date.now() + 30 * 24 * 60 * 60 * 1000,
          original_transaction_id: 'orig-1',
        },
      }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(dbState.subscriptions.length, 0);
  });
});
