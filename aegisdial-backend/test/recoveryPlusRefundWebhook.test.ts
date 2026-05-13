import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Recovery Shield R-H1 adversarial-review — Apple S2S REFUND/REVOKE
// for `recovery_plus_one_time` MUST dispatch into the Recovery Plus
// entitlement revoke path. Pre-fix the route only operated on the
// `subscriptions` table, leaving Recovery Plus rows live forever after
// a refund.
//
// Same in-memory pool-stub idiom as appleNotifications.test.ts — we
// drive `handleAppleNotification` with a synthetic DecodedNotification
// (no real JWS) and assert the row in recovery_plus_purchases gets
// refunded_at stamped + hasRecoveryPlus subsequently returns false.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-recovery-plus-refund-webhook';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://recovery-plus-refund-webhook';
process.env.APPLE_BUNDLE_ID ||= 'com.aegisdial.app';
process.env.APPLE_STOREKIT_ENV ||= 'sandbox';

const db = await import('../src/lib/db.ts');
const { handleAppleNotification } = await import('../src/routes/subscription.ts');
const ent = await import('../src/services/recovery/recoveryPlusEntitlement.ts');
const appleVerify = await import('../src/lib/appleVerify.ts');

// Silent logger matching FastifyBaseLogger.
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

// --------------------------------------------------------------------
// In-memory tables — only the ones this code path actually reads/writes.
// recoveryPlusEntitlement uses: INSERT recovery_plus_purchases, SELECT
// id by apple_transaction_id, UPDATE refunded_at, the bind UPDATE, the
// match SELECT, and metric_counters UPSERT.
// handleAppleNotification additionally reads `subscriptions` for the
// "does this transaction belong to one of our users" check before
// branching on productId.
// --------------------------------------------------------------------

interface FakePurchase {
  id: string;
  user_id: string;
  recovery_session_id: string | null;
  apple_transaction_id: string;
  apple_receipt_data: string;
  purchase_amount_cents: number;
  currency: string;
  purchased_at: Date;
  refunded_at: Date | null;
}

interface DbState {
  purchases: FakePurchase[];
  queryLog: Array<{ text: string; params: unknown[] }>;
}

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ORIGINAL_TX_ID = '2000111122223333';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

const state: DbState = { purchases: [], queryLog: [] };
let nextSeq = 1;

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  state.queryLog.push({ text, params });
  const trimmed = text.trim().replace(/\s+/g, ' ');

  // emitMetric upsert — swallow.
  if (/^INSERT INTO metric_counters/i.test(trimmed)) {
    return { rows: [], rowCount: 1 };
  }

  // handleAppleNotification's pre-branch subscription lookup. We want
  // it to return empty so the subscription branch becomes a no-op for
  // recovery_plus_one_time productIds (the route handles that
  // explicitly via the productId dispatch).
  if (
    /^SELECT user_id, status FROM subscriptions WHERE provider = 'apple_storekit'/i.test(trimmed)
  ) {
    return { rows: [], rowCount: 0 };
  }

  // recovery_plus_purchases — INSERT, replay SELECT, refund UPDATE.
  if (/^INSERT INTO recovery_plus_purchases/i.test(trimmed)) {
    const [
      user_id,
      recovery_session_id,
      apple_transaction_id,
      apple_receipt_data,
      purchase_amount_cents,
      currency,
    ] = params as [string, string | null, string, string, number, string];
    if (state.purchases.some((p) => p.apple_transaction_id === apple_transaction_id)) {
      return { rows: [], rowCount: 0 };
    }
    const row: FakePurchase = {
      id: `pur-${nextSeq++}`,
      user_id,
      recovery_session_id,
      apple_transaction_id,
      apple_receipt_data,
      purchase_amount_cents,
      currency,
      purchased_at: new Date(),
      refunded_at: null,
    };
    state.purchases.push(row);
    return {
      rows: [{ id: row.id, recovery_session_id: row.recovery_session_id }],
      rowCount: 1,
    };
  }

  if (
    /^SELECT id, recovery_session_id FROM recovery_plus_purchases WHERE apple_transaction_id = \$1/i.test(
      trimmed,
    )
  ) {
    const [txId] = params as [string];
    const row = state.purchases.find((p) => p.apple_transaction_id === txId);
    return row
      ? { rows: [{ id: row.id, recovery_session_id: row.recovery_session_id }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  if (
    /^UPDATE recovery_plus_purchases SET refunded_at = COALESCE\(refunded_at, NOW\(\)\) WHERE apple_transaction_id = \$1/i.test(
      trimmed,
    )
  ) {
    const [txId] = params as [string];
    const row = state.purchases.find((p) => p.apple_transaction_id === txId);
    if (!row) return { rows: [], rowCount: 0 };
    if (row.refunded_at === null) row.refunded_at = new Date();
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // hasRecoveryPlus step 1 — atomic NULL-session bind. No NULL rows
  // in this fixture (we always pre-bind to SESSION_ID), so this is a
  // no-op match.
  if (
    /^UPDATE recovery_plus_purchases SET recovery_session_id = \$2 WHERE id = \( SELECT id FROM recovery_plus_purchases WHERE user_id = \$1 AND recovery_session_id IS NULL/i.test(
      trimmed,
    )
  ) {
    const [user_id] = params as [string, string];
    const candidates = state.purchases.filter(
      (p) =>
        p.user_id === user_id && p.recovery_session_id === null && p.refunded_at === null,
    );
    if (candidates.length === 0) return { rows: [], rowCount: 0 };
    candidates[0]!.recovery_session_id = params[1] as string;
    return { rows: [{ id: candidates[0]!.id }], rowCount: 1 };
  }

  // hasRecoveryPlus step 2 — exact (user, session, refunded_at IS NULL).
  if (
    /^SELECT id FROM recovery_plus_purchases WHERE user_id = \$1 AND recovery_session_id = \$2 AND refunded_at IS NULL/i.test(
      trimmed,
    )
  ) {
    const [user_id, session_id] = params as [string, string];
    const row = state.purchases.find(
      (p) =>
        p.user_id === user_id &&
        p.recovery_session_id === session_id &&
        p.refunded_at === null,
    );
    return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // currentTier / reconcileTier downstream queries — return empty so
  // any subscription-table fallthrough is a quiet no-op.
  return { rows: [], rowCount: 0 };
};

(db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;

// --------------------------------------------------------------------
// Helpers to build a DecodedNotification without a signed JWS.
// --------------------------------------------------------------------

type DecodedNotification = Awaited<ReturnType<typeof appleVerify.verifyAppleNotificationJws>>;

function buildNotification(overrides: Partial<DecodedNotification> = {}): DecodedNotification {
  const now = Date.now();
  const base: DecodedNotification = {
    notificationType: 'TEST',
    subtype: null,
    notificationUUID: 'uuid-recovery-plus-refund-test',
    signedDate: now,
    signedTransactionInfo: null,
    signedRenewalInfo: null,
    transaction: null,
    renewalInfo: null,
    raw: {},
  };
  return { ...base, ...overrides };
}

function buildPlusTransaction(
  overrides: Partial<NonNullable<DecodedNotification['transaction']>> = {},
) {
  const now = Date.now();
  return {
    transactionId: ORIGINAL_TX_ID,
    originalTransactionId: ORIGINAL_TX_ID,
    productId: ent.RECOVERY_PLUS_PRODUCT_ID,
    bundleId: 'com.aegisdial.app',
    purchaseDateMs: now,
    expiresDateMs: null,
    revocationDateMs: null,
    environment: 'Sandbox',
    appAccountToken: null,
    raw: {},
    ...overrides,
  };
}

async function seedPlusPurchase(): Promise<FakePurchase> {
  // Drive through purchaseRecoveryPlus so the SQL matches what the
  // production path inserts — including the R-M5 originalTransactionId
  // storage standard.
  await ent.purchaseRecoveryPlus(
    {
      user_id: USER_ID,
      apple_receipt: 'stub-jws',
      apple_transaction_id: ORIGINAL_TX_ID,
      recovery_session_id: SESSION_ID,
      purchase_amount_cents: ent.RECOVERY_PLUS_PRICE_CENTS,
    },
    {
      verifyFn: async () => ({
        transactionId: ORIGINAL_TX_ID,
        originalTransactionId: ORIGINAL_TX_ID,
        productId: ent.RECOVERY_PLUS_PRODUCT_ID,
        bundleId: 'com.aegisdial.app',
        purchaseDateMs: Date.now(),
        expiresDateMs: null,
        type: 'Non-Consumable',
        environment: 'Sandbox',
        appAccountToken: null,
        raw: { stub: true },
      }),
    },
  );
  const row = state.purchases.find((p) => p.apple_transaction_id === ORIGINAL_TX_ID);
  assert.ok(row, 'seedPlusPurchase: row should exist after purchase');
  return row!;
}

before(() => {
  assert.equal(typeof handleAppleNotification, 'function');
});

beforeEach(() => {
  state.purchases.length = 0;
  state.queryLog.length = 0;
  nextSeq = 1;
});

// ====================================================================
// REFUND / REVOKE dispatch for recovery_plus_one_time
// ====================================================================

describe('handleAppleNotification — REFUND for recovery_plus_one_time', () => {
  it('stamps refunded_at on the Recovery Plus row and kills the entitlement', async () => {
    await seedPlusPurchase();
    // Pre-condition: user IS entitled.
    assert.equal(await ent.hasRecoveryPlus(USER_ID, SESSION_ID), true);

    const note = buildNotification({
      notificationType: 'REFUND',
      transaction: buildPlusTransaction(),
    });

    await handleAppleNotification(note, log);

    const row = state.purchases.find((p) => p.apple_transaction_id === ORIGINAL_TX_ID);
    assert.ok(row, 'row still present');
    assert.ok(row.refunded_at instanceof Date, 'refunded_at stamped by revokeOnRefund');

    // Post-condition: entitlement check returns false.
    assert.equal(
      await ent.hasRecoveryPlus(USER_ID, SESSION_ID),
      false,
      'hasRecoveryPlus must return false after refund',
    );
  });

  it('REVOKE notification gets the same treatment as REFUND', async () => {
    await seedPlusPurchase();
    const note = buildNotification({
      notificationType: 'REVOKE',
      transaction: buildPlusTransaction(),
    });
    await handleAppleNotification(note, log);
    const row = state.purchases.find((p) => p.apple_transaction_id === ORIGINAL_TX_ID);
    assert.ok(row?.refunded_at instanceof Date);
    assert.equal(await ent.hasRecoveryPlus(USER_ID, SESSION_ID), false);
  });

  it('REFUND for an UNKNOWN Recovery Plus transaction is a no-op (no throw)', async () => {
    // No seed — Apple sometimes sends refund notifications for
    // transactions our DB never saw (sandbox bleed, refund before
    // INSERT landed). The handler must log + return without throwing
    // so Apple's retry queue stays quiet.
    const note = buildNotification({
      notificationType: 'REFUND',
      transaction: buildPlusTransaction({ originalTransactionId: 'tx-never-seen' }),
    });
    await handleAppleNotification(note, log);
    // No rows ever created.
    assert.equal(state.purchases.length, 0);
  });

  it('REFUND for a subscription productId does NOT touch recovery_plus_purchases', async () => {
    // Seed a Plus purchase that should NOT be touched.
    await seedPlusPurchase();
    const noteSub = buildNotification({
      notificationType: 'REFUND',
      transaction: buildPlusTransaction({
        productId: 'com.aegisdial.app.pro.monthly',
        // Different originalTransactionId so the subscription-table
        // fallthrough has no row to operate on (it'll log + return).
        originalTransactionId: '2000-different-sub-tx',
        transactionId: '2000-different-sub-tx',
      }),
    });
    await handleAppleNotification(noteSub, log);
    const row = state.purchases.find((p) => p.apple_transaction_id === ORIGINAL_TX_ID);
    assert.ok(row, 'plus row still present');
    assert.equal(
      row?.refunded_at,
      null,
      'Plus refund path must not fire for subscription productId',
    );
  });
});
