import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Recovery Shield — R-P2 entitlement service tests.
//
// Stubs:
//   - db.pool.query — selectively returns recovery_plus_purchases
//     rows + applies the same UPSERT / UPDATE semantics the live
//     migration enforces (apple_transaction_id UNIQUE; the atomic
//     NULL-session UPDATE binding).
//   - verifyFn — injected stub for the Apple JWS verifier. Tests
//     never reach Apple's real endpoint.
//
// Coverage targets (mirrors the R-P2 prompt deliverables):
//   1. Happy path — fresh receipt → is_new=true
//   2. Replay — same transaction_id → is_new=false, no duplicate row
//   3. Wrong product (subscription receipt) → InvalidProductError
//   4. Wrong bundle id → InvalidBundleError
//   5. Wrong price (purchase_amount_cents != 24900) → InvalidPriceError
//   6. hasRecoveryPlus → true after purchase for matching session
//   7. hasRecoveryPlus → false for a different session
//   8. hasRecoveryPlus → true for ANY session when purchase had NULL session
//   9. Pre-purchase binding is single-use (sessionA succeeds and binds;
//      sessionB then fails)
//  10. revokeOnRefund flips refunded_at; hasRecoveryPlus → false after
//  11. Sandbox-environment receipt still verifies
//  12. Cross-user safety — user A's purchase doesn't entitle user B

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-recovery-plus';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://recovery-plus';
process.env.APPLE_BUNDLE_ID ||= 'com.aegisdial.app';

const db = await import('../src/lib/db.ts');
const ent = await import('../src/services/recovery/recoveryPlusEntitlement.ts');

// ----------------------------------------------------------------
// In-memory stub DB
// ----------------------------------------------------------------

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

let fakePurchases: FakePurchase[] = [];
let nextPurchaseSeq = 1;

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const trimmed = text.trim().replace(/\s+/g, ' ');

  // INSERT ... ON CONFLICT (apple_transaction_id) DO NOTHING
  if (/^INSERT INTO recovery_plus_purchases/i.test(trimmed)) {
    const [
      user_id,
      recovery_session_id,
      apple_transaction_id,
      apple_receipt_data,
      purchase_amount_cents,
      currency,
    ] = params as [string, string | null, string, string, number, string];
    if (fakePurchases.some((p) => p.apple_transaction_id === apple_transaction_id)) {
      // UNIQUE conflict — ON CONFLICT DO NOTHING returns no rows.
      return { rows: [], rowCount: 0 };
    }
    const row: FakePurchase = {
      id: `purchase-${nextPurchaseSeq++}`,
      user_id,
      recovery_session_id,
      apple_transaction_id,
      apple_receipt_data,
      purchase_amount_cents,
      currency,
      purchased_at: new Date(),
      refunded_at: null,
    };
    fakePurchases.push(row);
    return {
      rows: [{ id: row.id, recovery_session_id: row.recovery_session_id }],
      rowCount: 1,
    };
  }

  // SELECT id, recovery_session_id FROM recovery_plus_purchases WHERE apple_transaction_id = $1
  if (
    /^SELECT id, recovery_session_id FROM recovery_plus_purchases WHERE apple_transaction_id = \$1/i.test(
      trimmed,
    )
  ) {
    const [txId] = params as [string];
    const row = fakePurchases.find((p) => p.apple_transaction_id === txId);
    return row
      ? {
          rows: [{ id: row.id, recovery_session_id: row.recovery_session_id }],
          rowCount: 1,
        }
      : { rows: [], rowCount: 0 };
  }

  // UPDATE recovery_plus_purchases SET recovery_session_id = $2 WHERE id = (SELECT ...)
  // Atomic NULL-session binding.
  if (
    /^UPDATE recovery_plus_purchases SET recovery_session_id = \$2 WHERE id = \( SELECT id FROM recovery_plus_purchases WHERE user_id = \$1 AND recovery_session_id IS NULL AND refunded_at IS NULL/i.test(
      trimmed,
    )
  ) {
    const [user_id, session_id] = params as [string, string];
    // Pick the most-recent NULL-session, non-refunded row for this user.
    const candidates = fakePurchases
      .filter(
        (p) =>
          p.user_id === user_id &&
          p.recovery_session_id === null &&
          p.refunded_at === null,
      )
      .sort((a, b) => b.purchased_at.getTime() - a.purchased_at.getTime());
    if (candidates.length === 0) return { rows: [], rowCount: 0 };
    const target = candidates[0]!;
    target.recovery_session_id = session_id;
    return { rows: [{ id: target.id }], rowCount: 1 };
  }

  // SELECT id FROM recovery_plus_purchases WHERE user_id = $1 AND recovery_session_id = $2 AND refunded_at IS NULL LIMIT 1
  if (
    /^SELECT id FROM recovery_plus_purchases WHERE user_id = \$1 AND recovery_session_id = \$2 AND refunded_at IS NULL/i.test(
      trimmed,
    )
  ) {
    const [user_id, session_id] = params as [string, string];
    const row = fakePurchases.find(
      (p) =>
        p.user_id === user_id &&
        p.recovery_session_id === session_id &&
        p.refunded_at === null,
    );
    return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // UPDATE recovery_plus_purchases SET refunded_at = COALESCE(refunded_at, NOW()) WHERE apple_transaction_id = $1
  if (
    /^UPDATE recovery_plus_purchases SET refunded_at = COALESCE\(refunded_at, NOW\(\)\) WHERE apple_transaction_id = \$1/i.test(
      trimmed,
    )
  ) {
    const [txId] = params as [string];
    const row = fakePurchases.find((p) => p.apple_transaction_id === txId);
    if (!row) return { rows: [], rowCount: 0 };
    if (row.refunded_at === null) row.refunded_at = new Date();
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // emitMetric → metric_counters UPSERT. Swallow.
  if (/^INSERT INTO metric_counters/i.test(trimmed)) {
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`unstubbed SQL: ${trimmed.slice(0, 160)}`);
};

beforeEach(() => {
  fakePurchases = [];
  nextPurchaseSeq = 1;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

// ----------------------------------------------------------------
// verifyFn stub factory
// ----------------------------------------------------------------

interface StubTxOverrides {
  transactionId?: string;
  /** Override the original_transaction_id independently from
   *  per-event transactionId — exercises the R-M5 divergence path. */
  originalTransactionId?: string;
  productId?: string;
  bundleId?: string;
  environment?: string;
  appAccountToken?: string | null;
}

function stubVerify(overrides: StubTxOverrides = {}) {
  return async (_receipt: string) => ({
    transactionId: overrides.transactionId ?? 'tx-100001',
    originalTransactionId:
      overrides.originalTransactionId ?? overrides.transactionId ?? 'tx-100001',
    productId: overrides.productId ?? 'recovery_plus_one_time',
    bundleId: overrides.bundleId ?? 'com.aegisdial.app',
    purchaseDateMs: 1_700_000_000_000,
    expiresDateMs: null,
    type: 'Non-Consumable',
    environment: overrides.environment ?? 'Production',
    appAccountToken: overrides.appAccountToken ?? null,
    raw: { stub: true },
  });
}

const USER_A = '00000000-0000-0000-0000-00000000000a';
const USER_B = '00000000-0000-0000-0000-00000000000b';
const SESSION_1 = '11111111-1111-1111-1111-111111111111';
const SESSION_2 = '22222222-2222-2222-2222-222222222222';

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe('purchaseRecoveryPlus', () => {
  it('happy path — fresh receipt → is_new=true and a row exists', async () => {
    const result = await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'stubbed-jws-payload',
        apple_transaction_id: 'tx-100001',
        recovery_session_id: SESSION_1,
        purchase_amount_cents: ent.RECOVERY_PLUS_PRICE_CENTS,
      },
      { verifyFn: stubVerify() },
    );
    assert.equal(result.is_new, true);
    assert.equal(result.entitled_session_id, SESSION_1);
    assert.ok(result.purchase_id);
    assert.equal(fakePurchases.length, 1);
    assert.equal(fakePurchases[0]!.user_id, USER_A);
    assert.equal(fakePurchases[0]!.purchase_amount_cents, 24900);
    assert.equal(fakePurchases[0]!.currency, 'USD');
  });

  it('replay — same apple_transaction_id → is_new=false, no duplicate row', async () => {
    const verify = stubVerify({ transactionId: 'tx-replay-200002' });
    const first = await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-1',
        apple_transaction_id: 'tx-replay-200002',
        recovery_session_id: SESSION_1,
        purchase_amount_cents: 24900,
      },
      { verifyFn: verify },
    );
    const second = await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-1',
        apple_transaction_id: 'tx-replay-200002',
        recovery_session_id: SESSION_1,
        purchase_amount_cents: 24900,
      },
      { verifyFn: verify },
    );
    assert.equal(first.is_new, true);
    assert.equal(second.is_new, false);
    // Idempotent: same purchase_id on the replay.
    assert.equal(second.purchase_id, first.purchase_id);
    assert.equal(fakePurchases.length, 1);
  });

  it('wrong product (subscription receipt) → InvalidProductError', async () => {
    await assert.rejects(
      ent.purchaseRecoveryPlus(
        {
          user_id: USER_A,
          apple_receipt: 'jws-sub',
          apple_transaction_id: 'tx-300003',
          recovery_session_id: SESSION_1,
          purchase_amount_cents: 24900,
        },
        { verifyFn: stubVerify({ productId: 'com.aegisdial.app.pro.monthly' }) },
      ),
      (err: unknown) => err instanceof ent.InvalidProductError,
    );
    assert.equal(fakePurchases.length, 0);
  });

  it('wrong bundle id → InvalidBundleError', async () => {
    await assert.rejects(
      ent.purchaseRecoveryPlus(
        {
          user_id: USER_A,
          apple_receipt: 'jws-evil',
          apple_transaction_id: 'tx-400004',
          recovery_session_id: SESSION_1,
          purchase_amount_cents: 24900,
        },
        { verifyFn: stubVerify({ bundleId: 'com.scammer.fake' }) },
      ),
      (err: unknown) => err instanceof ent.InvalidBundleError,
    );
    assert.equal(fakePurchases.length, 0);
  });

  it('price mismatch → InvalidPriceError (and never reaches the verifier)', async () => {
    let verifierCalled = false;
    const traceVerify = async () => {
      verifierCalled = true;
      return (await stubVerify()('any'));
    };
    await assert.rejects(
      ent.purchaseRecoveryPlus(
        {
          user_id: USER_A,
          apple_receipt: 'jws-cheap',
          apple_transaction_id: 'tx-500005',
          recovery_session_id: SESSION_1,
          purchase_amount_cents: 9900, // wrong — $99 instead of $249
        },
        { verifyFn: traceVerify },
      ),
      (err: unknown) => err instanceof ent.InvalidPriceError,
    );
    assert.equal(verifierCalled, false, 'price check must run before verifier');
    assert.equal(fakePurchases.length, 0);
  });

  it('sandbox-environment receipt verifies fine', async () => {
    const result = await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-sandbox',
        apple_transaction_id: 'tx-sandbox-600006',
        recovery_session_id: SESSION_1,
        purchase_amount_cents: 24900,
      },
      {
        verifyFn: stubVerify({
          environment: 'Sandbox',
          transactionId: 'tx-sandbox-600006',
        }),
      },
    );
    assert.equal(result.is_new, true);
    assert.equal(fakePurchases.length, 1);
  });

  it('purchase with NULL session is allowed (pre-purchase flow)', async () => {
    const result = await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-pre',
        apple_transaction_id: 'tx-pre-700007',
        // No recovery_session_id — pre-purchase.
        purchase_amount_cents: 24900,
      },
      { verifyFn: stubVerify({ transactionId: 'tx-pre-700007' }) },
    );
    assert.equal(result.is_new, true);
    assert.equal(result.entitled_session_id, null);
  });

  it('caller-supplied apple_transaction_id mismatch is rejected', async () => {
    await assert.rejects(
      ent.purchaseRecoveryPlus(
        {
          user_id: USER_A,
          apple_receipt: 'jws-mismatch',
          apple_transaction_id: 'tx-claimed', // doesn't match what the JWS decodes to
          recovery_session_id: SESSION_1,
          purchase_amount_cents: 24900,
        },
        { verifyFn: stubVerify({ transactionId: 'tx-actual-different' }) },
      ),
      (err: unknown) => err instanceof ent.ReceiptVerificationError,
    );
  });

  // R-M5 adversarial-review — apple_transaction_id storage is keyed
  // on originalTransactionId, not the per-event transactionId. For
  // non-consumable IAPs these are typically identical, but Apple's
  // docs document edge cases (device restore, family-sharing re-grant,
  // App Store support re-grant) where they diverge. The refund webhook
  // references originalTransactionId, so we standardize storage on it
  // to keep revokeOnRefund findable.
  it('stores originalTransactionId (not per-event transactionId) in apple_transaction_id', async () => {
    const result = await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-divergent',
        // Caller is allowed to send either the per-event txn id or
        // the original — both should validate, both should result
        // in the original being stored.
        apple_transaction_id: 'tx-original-stable-id',
        recovery_session_id: SESSION_1,
        purchase_amount_cents: 24900,
      },
      {
        verifyFn: stubVerify({
          transactionId: 'tx-per-event-divergent',
          originalTransactionId: 'tx-original-stable-id',
        }),
      },
    );
    assert.equal(result.is_new, true);
    assert.equal(fakePurchases.length, 1);
    // The persisted apple_transaction_id MUST be the original, not
    // the per-event id — so the Apple refund webhook's
    // originalTransactionId reference always finds the row.
    assert.equal(
      fakePurchases[0]!.apple_transaction_id,
      'tx-original-stable-id',
      'apple_transaction_id column must store originalTransactionId',
    );
    assert.notEqual(
      fakePurchases[0]!.apple_transaction_id,
      'tx-per-event-divergent',
      'must NOT store the per-event transactionId',
    );
    // End-to-end: a refund webhook keyed on originalTransactionId
    // finds the row.
    const refund = await ent.revokeOnRefund('tx-original-stable-id');
    assert.equal(refund.revoked, true);
    assert.equal(await ent.hasRecoveryPlus(USER_A, SESSION_1), false);
  });

  it('verifier throws → ReceiptVerificationError surfaces', async () => {
    await assert.rejects(
      ent.purchaseRecoveryPlus(
        {
          user_id: USER_A,
          apple_receipt: 'jws-bad-sig',
          apple_transaction_id: 'tx-800008',
          recovery_session_id: SESSION_1,
          purchase_amount_cents: 24900,
        },
        {
          verifyFn: async () => {
            throw new Error('signature chain broken');
          },
        },
      ),
      (err: unknown) =>
        err instanceof ent.ReceiptVerificationError &&
        /signature chain broken/.test((err as Error).message),
    );
  });
});

describe('hasRecoveryPlus', () => {
  it('returns true after purchase for the matching session', async () => {
    await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-h1',
        apple_transaction_id: 'tx-h1',
        recovery_session_id: SESSION_1,
        purchase_amount_cents: 24900,
      },
      { verifyFn: stubVerify({ transactionId: 'tx-h1' }) },
    );
    assert.equal(await ent.hasRecoveryPlus(USER_A, SESSION_1), true);
  });

  it('returns false for a different session', async () => {
    await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-h2',
        apple_transaction_id: 'tx-h2',
        recovery_session_id: SESSION_1,
        purchase_amount_cents: 24900,
      },
      { verifyFn: stubVerify({ transactionId: 'tx-h2' }) },
    );
    assert.equal(await ent.hasRecoveryPlus(USER_A, SESSION_2), false);
  });

  it('NULL-session purchase entitles the first session that checks (binds)', async () => {
    await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-pre1',
        apple_transaction_id: 'tx-pre-1',
        // No session — pre-purchase
        purchase_amount_cents: 24900,
      },
      { verifyFn: stubVerify({ transactionId: 'tx-pre-1' }) },
    );
    assert.equal(fakePurchases[0]!.recovery_session_id, null);
    // First check binds.
    assert.equal(await ent.hasRecoveryPlus(USER_A, SESSION_1), true);
    assert.equal(
      fakePurchases[0]!.recovery_session_id,
      SESSION_1,
      'NULL-session row should now be bound to SESSION_1',
    );
  });

  it('pre-purchase binding is single-use — second session does NOT get free entitlement', async () => {
    await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-pre2',
        apple_transaction_id: 'tx-pre-2',
        purchase_amount_cents: 24900,
      },
      { verifyFn: stubVerify({ transactionId: 'tx-pre-2' }) },
    );
    // SessionA wins the bind.
    assert.equal(await ent.hasRecoveryPlus(USER_A, SESSION_1), true);
    // SessionB is now NOT entitled — the NULL row is gone, no row matches SESSION_2.
    assert.equal(await ent.hasRecoveryPlus(USER_A, SESSION_2), false);
  });

  it('cross-user safety — user A purchase does NOT entitle user B', async () => {
    await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-cross',
        apple_transaction_id: 'tx-cross',
        recovery_session_id: SESSION_1,
        purchase_amount_cents: 24900,
      },
      { verifyFn: stubVerify({ transactionId: 'tx-cross' }) },
    );
    assert.equal(await ent.hasRecoveryPlus(USER_A, SESSION_1), true);
    assert.equal(await ent.hasRecoveryPlus(USER_B, SESSION_1), false);
  });

  it('cross-user safety — user A NULL-session purchase does NOT bind to user B', async () => {
    await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-cross-null',
        apple_transaction_id: 'tx-cross-null',
        purchase_amount_cents: 24900,
      },
      { verifyFn: stubVerify({ transactionId: 'tx-cross-null' }) },
    );
    // user B tries to claim it.
    assert.equal(await ent.hasRecoveryPlus(USER_B, SESSION_1), false);
    // The row should still be unbound — user A's NULL row stays NULL.
    assert.equal(fakePurchases[0]!.recovery_session_id, null);
  });
});

describe('revokeOnRefund', () => {
  it('flips refunded_at on the matching row and entitlement check returns false', async () => {
    await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-refund',
        apple_transaction_id: 'tx-refund-1',
        recovery_session_id: SESSION_1,
        purchase_amount_cents: 24900,
      },
      { verifyFn: stubVerify({ transactionId: 'tx-refund-1' }) },
    );
    assert.equal(await ent.hasRecoveryPlus(USER_A, SESSION_1), true);

    const result = await ent.revokeOnRefund('tx-refund-1');
    assert.equal(result.revoked, true);
    assert.ok(fakePurchases[0]!.refunded_at instanceof Date);

    // After refund the entitlement check returns false.
    assert.equal(await ent.hasRecoveryPlus(USER_A, SESSION_1), false);
  });

  it('returns revoked=false when the transaction is unknown (Apple ghost notification)', async () => {
    const result = await ent.revokeOnRefund('tx-never-seen');
    assert.equal(result.revoked, false);
  });

  it('is idempotent on a second call (no error, refunded_at preserved)', async () => {
    await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-refund-2',
        apple_transaction_id: 'tx-refund-2',
        recovery_session_id: SESSION_1,
        purchase_amount_cents: 24900,
      },
      { verifyFn: stubVerify({ transactionId: 'tx-refund-2' }) },
    );
    const first = await ent.revokeOnRefund('tx-refund-2');
    const firstStamp = fakePurchases[0]!.refunded_at;
    const second = await ent.revokeOnRefund('tx-refund-2');
    assert.equal(first.revoked, true);
    assert.equal(second.revoked, true);
    // refunded_at preserved (COALESCE).
    assert.equal(fakePurchases[0]!.refunded_at, firstStamp);
  });

  it('refund-then-rebuy works — a fresh transaction_id INSERTs a new row', async () => {
    await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-rb-1',
        apple_transaction_id: 'tx-rb-original',
        recovery_session_id: SESSION_1,
        purchase_amount_cents: 24900,
      },
      { verifyFn: stubVerify({ transactionId: 'tx-rb-original' }) },
    );
    await ent.revokeOnRefund('tx-rb-original');
    assert.equal(await ent.hasRecoveryPlus(USER_A, SESSION_1), false);

    // User buys again — Apple issues a new transactionId.
    await ent.purchaseRecoveryPlus(
      {
        user_id: USER_A,
        apple_receipt: 'jws-rb-2',
        apple_transaction_id: 'tx-rb-new',
        recovery_session_id: SESSION_1,
        purchase_amount_cents: 24900,
      },
      { verifyFn: stubVerify({ transactionId: 'tx-rb-new' }) },
    );
    assert.equal(await ent.hasRecoveryPlus(USER_A, SESSION_1), true);
    assert.equal(fakePurchases.length, 2);
  });
});
