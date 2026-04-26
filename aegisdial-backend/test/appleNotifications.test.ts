import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Apple server-to-server notifications v2 — unit tests for the
// `handleAppleNotification` router exported from src/routes/subscription.ts.
//
// We DO NOT exercise the full route here because `verifyAppleNotificationJws`
// pulls the Apple root certificates off disk and runs the SDK verifier, and
// constructing a validly-signed JWS in a unit test is both noisy and doesn't
// add signal over exercising the router with a pre-verified payload. The
// signature-verify → 400 path is already covered by the route-level error
// branch (APPLE_NOTIFICATION_SCHEMA validation), and re-testing it here
// would just duplicate the SDK's own test suite.
//
// Same in-memory pool-mock pattern as routesAuthBreach.test.ts /
// stripeWebhook.test.ts: stand up config env BEFORE src/* imports, then
// swap pool.query with a fake that pattern-matches on SQL prefix.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://apple-notifications-test';
process.env.APPLE_BUNDLE_ID ||= 'com.fortyseven.aegisdial';
process.env.APPLE_STOREKIT_ENV ||= 'sandbox';

const db = await import('../src/lib/db.ts');
const { handleAppleNotification } = await import('../src/routes/subscription.ts');
const appleVerify = await import('../src/lib/appleVerify.ts');

// Silent logger matching FastifyBaseLogger — we don't assert on output.
const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => log,
  level: 'silent',
  silent: () => {},
} as unknown as import('fastify').FastifyBaseLogger;

interface SubRow {
  user_id: string;
  provider: string;
  provider_product_id: string;
  provider_transaction_id: string;
  status: string;
  current_period_start: string;
  current_period_end: string;
  auto_renew: boolean;
  raw_payload: string;
  updated_at: Date;
}

interface UserRow {
  id: string;
  tier: string;
}

interface DbState {
  subs: Map<string, SubRow>;
  users: Map<string, UserRow>;
  queryLog: Array<{ text: string; params: unknown[] }>;
}

const USER_ID = '11111111-2222-3333-4444-555555555555';
const ORIGINAL_TX_ID = '2000000987654321';
const PRODUCT_ID = 'com.fortyseven.aegisdial.pro.monthly';

const dbState: DbState = { subs: new Map(), users: new Map(), queryLog: [] };

function resetDb(): void {
  dbState.subs.clear();
  dbState.users.clear();
  dbState.queryLog.length = 0;
  dbState.users.set(USER_ID, { id: USER_ID, tier: 'pro' });
}

function seedActiveSub(overrides: Partial<SubRow> = {}): SubRow {
  const now = new Date();
  const row: SubRow = {
    user_id: USER_ID,
    provider: 'apple_storekit',
    provider_product_id: PRODUCT_ID,
    provider_transaction_id: ORIGINAL_TX_ID,
    status: 'active',
    current_period_start: new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString(),
    current_period_end: new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString(),
    auto_renew: true,
    raw_payload: '{}',
    updated_at: now,
    ...overrides,
  };
  dbState.subs.set(row.provider_transaction_id, row);
  return row;
}

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  dbState.queryLog.push({ text, params });
  const t = text.trim();

  // Lookup row by provider + provider_transaction_id — the first thing
  // handleAppleNotification does in every branch.
  if (/^SELECT user_id, status FROM subscriptions[\s\S]+WHERE provider = 'apple_storekit'/i.test(t)) {
    const txId = params[0] as string;
    const row = dbState.subs.get(txId);
    return row
      ? { rows: [{ user_id: row.user_id, status: row.status }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // DID_RENEW update: status='active' + new period_start/end.
  if (/^UPDATE subscriptions\s+SET status = 'active'/i.test(t)) {
    const [txId, periodStart, periodEnd, rawPayload] = params as [string, string, string, string];
    const row = dbState.subs.get(txId);
    if (row) {
      row.status = 'active';
      row.current_period_start = periodStart;
      row.current_period_end = periodEnd;
      row.raw_payload = rawPayload;
      row.updated_at = new Date();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // EXPIRED / GRACE_PERIOD_EXPIRED: status='expired', auto_renew=false.
  if (/^UPDATE subscriptions\s+SET status = 'expired'/i.test(t)) {
    const txId = params[0] as string;
    const row = dbState.subs.get(txId);
    if (row) {
      row.status = 'expired';
      row.auto_renew = false;
      row.updated_at = new Date();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // REFUND / REVOKE: status='refunded', auto_renew=false.
  if (/^UPDATE subscriptions\s+SET status = 'refunded'/i.test(t)) {
    const txId = params[0] as string;
    const row = dbState.subs.get(txId);
    if (row) {
      row.status = 'refunded';
      row.auto_renew = false;
      row.updated_at = new Date();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // DID_CHANGE_RENEWAL_STATUS: auto_renew flipped only.
  if (/^UPDATE subscriptions\s+SET auto_renew = \$2/i.test(t)) {
    const [txId, autoRenew] = params as [string, boolean];
    const row = dbState.subs.get(txId);
    if (row) {
      row.auto_renew = autoRenew;
      row.updated_at = new Date();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // currentTier reads subscriptions by user_id — return the most
  // recent row so the 'refunded' status propagates into the tier
  // computation (classifyRow treats non-active as 'expired').
  if (/^SELECT status, current_period_end\s+FROM subscriptions\s+WHERE user_id/i.test(t)) {
    const userId = params[0] as string;
    const rows = Array.from(dbState.subs.values())
      .filter((r) => r.user_id === userId)
      .sort((a, b) => (a.current_period_end < b.current_period_end ? 1 : -1));
    return {
      rows: rows.slice(0, 1).map((r) => ({
        status: r.status,
        current_period_end: new Date(r.current_period_end),
      })),
      rowCount: Math.min(rows.length, 1),
    };
  }

  // currentTier family_members SELECT — we don't seed any, empty is fine.
  if (/^SELECT[\s\S]+FROM family_members/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }

  // ensureTierPersisted: UPDATE users SET tier.
  if (/^UPDATE users SET tier/i.test(t)) {
    const [userId, tier] = params as [string, string];
    const row = dbState.users.get(userId);
    if (row) row.tier = tier;
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // Anything else: empty rowset, don't throw — keeps the test honest
  // if a future change introduces a new read/write.
  return { rows: [], rowCount: 0 };
};

(db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;

// Helpers to build a DecodedNotification without having to construct a
// full signed JWS. We're testing the router, not the verifier.
type DecodedNotification = Awaited<ReturnType<typeof appleVerify.verifyAppleNotificationJws>>;

function buildNotification(overrides: Partial<DecodedNotification> = {}): DecodedNotification {
  const now = Date.now();
  const base: DecodedNotification = {
    notificationType: 'TEST',
    subtype: null,
    notificationUUID: 'uuid-test-1',
    signedDate: now,
    signedTransactionInfo: null,
    signedRenewalInfo: null,
    transaction: null,
    renewalInfo: null,
    raw: {},
  };
  return { ...base, ...overrides };
}

function buildTransaction(overrides: Partial<NonNullable<DecodedNotification['transaction']>> = {}) {
  const now = Date.now();
  return {
    transactionId: ORIGINAL_TX_ID,
    originalTransactionId: ORIGINAL_TX_ID,
    productId: PRODUCT_ID,
    bundleId: 'com.fortyseven.aegisdial',
    purchaseDateMs: now,
    expiresDateMs: now + 30 * 24 * 3600 * 1000,
    revocationDateMs: null,
    environment: 'Sandbox',
    appAccountToken: null,
    raw: {},
    ...overrides,
  };
}

function buildRenewalInfo(overrides: Partial<NonNullable<DecodedNotification['renewalInfo']>> = {}) {
  return {
    originalTransactionId: ORIGINAL_TX_ID,
    productId: PRODUCT_ID,
    autoRenewStatus: 1,
    autoRenewProductId: PRODUCT_ID,
    renewalDateMs: Date.now() + 30 * 24 * 3600 * 1000,
    gracePeriodExpiresDateMs: null,
    expirationIntent: null,
    environment: 'Sandbox',
    raw: {},
    ...overrides,
  };
}

before(() => {
  assert.equal(typeof handleAppleNotification, 'function');
});

beforeEach(() => {
  resetDb();
});

describe('handleAppleNotification — DID_RENEW', () => {
  it('extends current_period_end + keeps status active', async () => {
    seedActiveSub();
    const newPurchase = Date.now();
    const newExpiry = newPurchase + 30 * 24 * 3600 * 1000;
    const note = buildNotification({
      notificationType: 'DID_RENEW',
      transaction: buildTransaction({
        purchaseDateMs: newPurchase,
        expiresDateMs: newExpiry,
      }),
    });

    await handleAppleNotification(note, log);

    const row = dbState.subs.get(ORIGINAL_TX_ID);
    assert.ok(row, 'row should still exist');
    assert.equal(row.status, 'active');
    assert.equal(
      row.current_period_end,
      new Date(newExpiry).toISOString(),
      'current_period_end should be updated to the new expires date',
    );
    assert.equal(
      row.current_period_start,
      new Date(newPurchase).toISOString(),
      'current_period_start should be updated',
    );
  });

  it('skips the update when the transaction is unknown', async () => {
    // No seed. Unknown tx — handler should log + no-op, not create a
    // ghost row.
    const note = buildNotification({
      notificationType: 'DID_RENEW',
      transaction: buildTransaction({ originalTransactionId: 'unknown-tx-id' }),
    });
    await handleAppleNotification(note, log);
    assert.equal(dbState.subs.size, 0);
  });
});

describe('handleAppleNotification — EXPIRED', () => {
  it("sets status to 'expired' + clears auto_renew", async () => {
    seedActiveSub();
    const note = buildNotification({
      notificationType: 'EXPIRED',
      transaction: buildTransaction(),
    });

    await handleAppleNotification(note, log);

    const row = dbState.subs.get(ORIGINAL_TX_ID);
    assert.equal(row?.status, 'expired');
    assert.equal(row?.auto_renew, false);
  });

  it("GRACE_PERIOD_EXPIRED also sets status to 'expired'", async () => {
    seedActiveSub({ status: 'in_grace' });
    const note = buildNotification({
      notificationType: 'GRACE_PERIOD_EXPIRED',
      transaction: buildTransaction(),
    });
    await handleAppleNotification(note, log);
    assert.equal(dbState.subs.get(ORIGINAL_TX_ID)?.status, 'expired');
  });
});

describe('handleAppleNotification — REFUND', () => {
  it("sets status='refunded' AND reconciles the user's tier to 'expired'", async () => {
    seedActiveSub();
    // Pre-condition: user is 'pro' in the users table.
    assert.equal(dbState.users.get(USER_ID)?.tier, 'pro');

    const note = buildNotification({
      notificationType: 'REFUND',
      transaction: buildTransaction(),
    });

    await handleAppleNotification(note, log);

    const row = dbState.subs.get(ORIGINAL_TX_ID);
    assert.equal(row?.status, 'refunded', 'subscription row flipped to refunded');
    assert.equal(row?.auto_renew, false);

    // ensureTierPersisted should have flipped the users row to
    // 'expired'. classifyRow in src/lib/subscription.ts treats anything
    // non-active as 'expired' (except the literal 'cancelled' status),
    // so a 'refunded' row classifies to 'expired'.
    assert.equal(
      dbState.users.get(USER_ID)?.tier,
      'expired',
      'user tier should be reconciled to expired after refund',
    );
  });

  it('REVOKE gets the same treatment as REFUND', async () => {
    seedActiveSub();
    const note = buildNotification({
      notificationType: 'REVOKE',
      transaction: buildTransaction(),
    });
    await handleAppleNotification(note, log);
    assert.equal(dbState.subs.get(ORIGINAL_TX_ID)?.status, 'refunded');
    assert.equal(dbState.users.get(USER_ID)?.tier, 'expired');
  });
});

describe('handleAppleNotification — DID_CHANGE_RENEWAL_STATUS', () => {
  it('flips auto_renew off when autoRenewStatus=0 without changing status', async () => {
    seedActiveSub();
    const note = buildNotification({
      notificationType: 'DID_CHANGE_RENEWAL_STATUS',
      transaction: buildTransaction(),
      renewalInfo: buildRenewalInfo({ autoRenewStatus: 0 }),
    });
    await handleAppleNotification(note, log);
    const row = dbState.subs.get(ORIGINAL_TX_ID);
    assert.equal(row?.auto_renew, false);
    assert.equal(row?.status, 'active', 'tier-bearing status unchanged');
  });
});

describe('handleAppleNotification — unknown type', () => {
  it('logs + returns without DB change', async () => {
    seedActiveSub();
    const before = { ...(dbState.subs.get(ORIGINAL_TX_ID) as SubRow) };
    const note = buildNotification({
      notificationType: 'SOMETHING_NEW_APPLE_ADDED',
      transaction: buildTransaction(),
    });
    // Should not throw.
    await handleAppleNotification(note, log);
    const after = dbState.subs.get(ORIGINAL_TX_ID);
    assert.equal(after?.status, before.status);
    assert.equal(after?.auto_renew, before.auto_renew);
    assert.equal(after?.current_period_end, before.current_period_end);
  });

  it('PRICE_INCREASE is log-only', async () => {
    seedActiveSub();
    await handleAppleNotification(
      buildNotification({ notificationType: 'PRICE_INCREASE', transaction: buildTransaction() }),
      log,
    );
    const row = dbState.subs.get(ORIGINAL_TX_ID);
    assert.equal(row?.status, 'active');
  });
});
