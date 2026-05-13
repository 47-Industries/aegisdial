import { query } from '../../lib/db.js';
import { emitMetric, captureError } from '../../lib/observability.js';
import {
  verifyAppleTransactionJws,
  type DecodedTransaction,
} from '../../lib/appleVerify.js';
import { config } from '../../config.js';
import type { RecoveryPlusPurchaseRow } from './types.js';

// Recovery Shield — R-P2: Recovery Plus entitlement service.
//
// $249 per-recovery-session unlock. The unit of entitlement is the
// recovery_session_id, NOT the user — buying Plus for one scam
// doesn't unlock the next one. Every scam is its own incident; the
// pricing reflects that (admin reviews + legal-packet generation
// + specialist marketplace access are per-case work).
//
// THREE PUBLIC FUNCTIONS:
//
//   - purchaseRecoveryPlus(input) — called by POST /v1/recovery/plus/
//     purchase after the iOS client completes a StoreKit transaction.
//     Verifies the Apple JWS receipt via the existing
//     verifyAppleTransactionJws helper (StoreKit 2; the same path the
//     Pro-tier subscription route uses) and INSERTs a row keyed on
//     apple_transaction_id UNIQUE. Replay-safe: a second call with the
//     same transaction_id returns the original purchase, NOT an error.
//
//   - hasRecoveryPlus(user_id, session_id) — the entitlement gate.
//     Returns true iff a non-refunded row exists for this user AND
//     (session matches OR the purchase was pre-bound to no session).
//     The "no session" branch is the pre-purchase flow: iOS may
//     surface the Plus upsell before the user has opened a specific
//     session. First check on a NULL-session row BINDS it to the
//     calling session atomically — subsequent sessions need a fresh
//     purchase.
//
//   - revokeOnRefund(apple_transaction_id) — invoked by the Apple
//     server-to-server REFUND notification webhook (separate route).
//     Sets refunded_at; the entitlement check filters refunded rows
//     out. Row is preserved (not deleted) so the admin revenue
//     dashboard's refund-rate metric stays queryable.
//
// REPLAY PROTECTION:
//
//   The apple_transaction_id UNIQUE constraint on
//   recovery_plus_purchases (migration 062) is the primary defense.
//   ON CONFLICT (apple_transaction_id) DO NOTHING makes the INSERT
//   atomic; concurrent retries from a flaky iOS client produce
//   exactly one row regardless of how many requests overlap.
//
//   A second user replaying a stolen receipt collides on the same
//   UNIQUE constraint at the DB layer. The route surface still
//   rejects cross-user replay at 409 because we look up the original
//   owner before returning success — but even if that check were
//   bypassed, the original row stays bound to the original user.
//
// PRICE VALIDATION:
//
//   $249 = 24900 cents. The amount sent by the client is cross-checked
//   against this constant; a client lying about the amount they paid
//   gets 400'd. The Apple receipt itself doesn't carry a "price paid"
//   the way we'd want for a one-time IAP (it carries the product id,
//   which we cross-check against `recovery_plus_one_time`), so this is
//   belt-and-suspenders.
//
// PRODUCT VALIDATION:
//
//   The verified JWS payload must reference product id
//   `recovery_plus_one_time`. A subscription receipt (com.aegisdial.app
//   .pro.monthly, etc.) for the same user gets rejected at this layer
//   even though it would pass JWS verification. Prevents subscription-
//   receipt-as-Plus-unlock confusion.

/**
 * Recovery Plus price in cents. $249 USD.
 *
 * Single source of truth — the route layer cross-checks the client-
 * reported amount against this; future localized-pricing work will
 * widen this to a (currency, country) → cents matrix.
 */
export const RECOVERY_PLUS_PRICE_CENTS = 24900;

/**
 * Apple IAP product id for the Recovery Plus one-time unlock.
 * MUST match the SKU registered in App Store Connect.
 */
export const RECOVERY_PLUS_PRODUCT_ID = 'recovery_plus_one_time';

export class InvalidProductError extends Error {
  constructor(productId: string) {
    super(`receipt productId '${productId}' is not ${RECOVERY_PLUS_PRODUCT_ID}`);
    this.name = 'InvalidProductError';
  }
}

export class InvalidBundleError extends Error {
  constructor(bundleId: string) {
    super(`receipt bundleId '${bundleId}' does not match ${config.APPLE_BUNDLE_ID}`);
    this.name = 'InvalidBundleError';
  }
}

export class InvalidPriceError extends Error {
  constructor(got: number) {
    super(`purchase_amount_cents ${got} does not match expected ${RECOVERY_PLUS_PRICE_CENTS}`);
    this.name = 'InvalidPriceError';
  }
}

export class ReceiptVerificationError extends Error {
  constructor(message: string) {
    super(`apple receipt verification failed: ${message}`);
    this.name = 'ReceiptVerificationError';
  }
}

export interface PurchaseRecoveryPlusInput {
  user_id: string;
  /** StoreKit 2 signedTransactionInfo JWS — the same envelope the Pro-tier path consumes. */
  apple_receipt: string;
  /**
   * Pulled out of the verified JWS by the caller (or the route layer
   * if it has the decoded payload already). Deduped here via the
   * apple_transaction_id UNIQUE constraint.
   */
  apple_transaction_id: string;
  /**
   * Optional — purchase may pre-date the session (iOS surfaces the
   * upsell from the marketplace tab before the user starts a
   * specific recovery case). NULL → bound on first hasRecoveryPlus
   * call.
   */
  recovery_session_id?: string;
  /** Belt-and-suspenders cross-check against RECOVERY_PLUS_PRICE_CENTS. */
  purchase_amount_cents: number;
  /** Defaults to 'USD'. Future-proofing for the localized-pricing matrix. */
  currency?: string;
}

export interface PurchaseRecoveryPlusResult {
  purchase_id: string;
  /** The session this purchase is bound to, or null if pre-purchase. */
  entitled_session_id: string | null;
  /**
   * false when the apple_transaction_id was already seen (iOS
   * retried a flaky network call). Treat as success — iOS expects
   * an idempotent server response.
   */
  is_new: boolean;
}

export interface PurchaseRecoveryPlusOpts {
  /**
   * Override for tests. Defaults to the production
   * verifyAppleTransactionJws helper.
   *
   * The injected function MUST behave like verifyAppleTransactionJws:
   * verify the JWS signature, validate bundleId, and return the
   * decoded transaction. A stub that returns synthetic values
   * (transactionId / productId / bundleId) is sufficient for tests.
   */
  verifyFn?: (receipt: string) => Promise<DecodedTransaction>;
}

/**
 * Verify the Apple receipt and INSERT (or recognize-as-replay) a
 * row in recovery_plus_purchases. Idempotent on apple_transaction_id.
 *
 * STORAGE CHOICE — apple_transaction_id column:
 *
 *   We store decoded.originalTransactionId, NOT decoded.transactionId.
 *   For non-consumable IAPs the two values are typically identical
 *   (a non-consumable can only be purchased once per Apple ID), but
 *   Apple's StoreKit docs document edge cases — re-downloads on a
 *   new device, family-sharing restores, App Store support
 *   re-grants — where the per-event transactionId diverges from the
 *   stable originalTransactionId. The refund/revoke webhook (R-H1)
 *   references originalTransactionId, so we standardize on it here
 *   to guarantee revokeOnRefund can always find the row.
 *
 *   If the JWS decoder somehow returns an empty originalTransactionId
 *   (StoreKit 1 fallback in edge sandbox cases — shouldn't happen
 *   with StoreKit 2 production receipts), we fall back to
 *   transactionId and log a warning via the observability metric.
 *
 * Throws:
 *  - InvalidBundleError — receipt is for a different app (or the
 *    bundleId field is empty / malformed).
 *  - InvalidProductError — receipt is for a product other than
 *    `recovery_plus_one_time` (typically a subscription receipt
 *    being misredeemed as a Plus unlock).
 *  - InvalidPriceError — caller-asserted amount doesn't match
 *    RECOVERY_PLUS_PRICE_CENTS.
 *  - ReceiptVerificationError — the underlying JWS verifier threw
 *    (signature mismatch, expired cert chain, etc.).
 */
export async function purchaseRecoveryPlus(
  input: PurchaseRecoveryPlusInput,
  opts: PurchaseRecoveryPlusOpts = {},
): Promise<PurchaseRecoveryPlusResult> {
  // Price gate. Cheap, runs first — a malformed-amount request
  // never reaches Apple's verifier.
  if (input.purchase_amount_cents !== RECOVERY_PLUS_PRICE_CENTS) {
    void emitMetric('recovery_shield.plus_purchased', {
      is_new: false,
      result: 'invalid_price',
    });
    throw new InvalidPriceError(input.purchase_amount_cents);
  }

  // Verify the Apple JWS. The existing verifyAppleTransactionJws
  // helper does the heavy lifting: signature chain to Apple roots,
  // bundleId match against config.APPLE_BUNDLE_ID, decoded payload.
  // It will THROW on any failure — wrap to surface a typed error
  // upstream.
  //
  // TODO (localized pricing): when the (currency, country) matrix
  // lands, this is where we'd cross-check the price against
  // (decoded.environment, input.currency). For now USD-only.
  const verify = opts.verifyFn ?? verifyAppleTransactionJws;
  let decoded: DecodedTransaction;
  try {
    decoded = await verify(input.apple_receipt);
  } catch (err) {
    void emitMetric('recovery_shield.plus_purchased', {
      is_new: false,
      result: 'verify_failed',
    });
    throw new ReceiptVerificationError((err as Error).message);
  }

  // Defense-in-depth bundle check. verifyAppleTransactionJws
  // already throws on mismatch, but a stubbed verifier in tests
  // could skip that step — re-assert here so the service is
  // self-contained.
  if (decoded.bundleId !== config.APPLE_BUNDLE_ID) {
    void emitMetric('recovery_shield.plus_purchased', {
      is_new: false,
      result: 'invalid_bundle',
    });
    throw new InvalidBundleError(decoded.bundleId);
  }

  // Product gate. The verified JWS must reference the Recovery Plus
  // SKU — NOT a subscription, NOT a different one-time SKU.
  if (decoded.productId !== RECOVERY_PLUS_PRODUCT_ID) {
    void emitMetric('recovery_shield.plus_purchased', {
      is_new: false,
      result: 'invalid_product',
    });
    throw new InvalidProductError(decoded.productId);
  }

  // The originalTransactionId pulled from the verified payload is the
  // authoritative dedupe key. We standardize on originalTransactionId
  // (not the per-event transactionId) because the Apple refund/revoke
  // webhook references it — see the storage-choice comment block at
  // the top of this function.
  //
  // Fallback: if originalTransactionId is empty/missing (StoreKit 1
  // edge case), fall back to transactionId and emit a warning metric.
  // Caller-supplied value is cross-checked against EITHER value for
  // safety — a client lying about which transaction they're claiming
  // would slip past the UNIQUE constraint otherwise.
  let txId = decoded.originalTransactionId;
  if (!txId) {
    void emitMetric('recovery_shield.plus_purchased', {
      is_new: false,
      result: 'missing_original_transaction_id',
    });
    txId = decoded.transactionId;
  }
  if (
    input.apple_transaction_id &&
    input.apple_transaction_id !== txId &&
    input.apple_transaction_id !== decoded.transactionId
  ) {
    void emitMetric('recovery_shield.plus_purchased', {
      is_new: false,
      result: 'tx_id_mismatch',
    });
    throw new ReceiptVerificationError(
      `apple_transaction_id mismatch: caller said '${input.apple_transaction_id}', JWS originalTransactionId='${decoded.originalTransactionId}' transactionId='${decoded.transactionId}'`,
    );
  }

  const currency = input.currency ?? 'USD';
  const sessionId = input.recovery_session_id ?? null;

  // INSERT — ON CONFLICT (apple_transaction_id) DO NOTHING makes
  // this idempotent. A retry from a flaky iOS network returns the
  // existing row; concurrent inserts collapse to one at the DB
  // layer (UNIQUE is enforced atomically inside the transaction
  // even without explicit BEGIN/COMMIT).
  const ins = await query<Pick<RecoveryPlusPurchaseRow, 'id' | 'recovery_session_id'>>(
    `INSERT INTO recovery_plus_purchases (
       user_id, recovery_session_id, apple_transaction_id,
       apple_receipt_data, purchase_amount_cents, currency
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (apple_transaction_id) DO NOTHING
     RETURNING id, recovery_session_id`,
    [
      input.user_id,
      sessionId,
      txId,
      input.apple_receipt,
      input.purchase_amount_cents,
      currency,
    ],
  );

  if ((ins.rowCount ?? 0) === 1) {
    void emitMetric('recovery_shield.plus_purchased', { is_new: true });
    return {
      purchase_id: ins.rows[0]!.id,
      entitled_session_id: ins.rows[0]!.recovery_session_id,
      is_new: true,
    };
  }

  // Replay path. The UNIQUE constraint hit — surface the original
  // purchase so iOS sees the same purchase_id on every retry. Note:
  // we deliberately do NOT scope by user_id here. If user A's
  // transaction is somehow being replayed by user B (which the
  // route layer should reject via auth, but defense-in-depth), we
  // surface the original user's purchase_id and the route can
  // notice the mismatch and 409. The replay-success contract is
  // "the client gets back the canonical row for this transaction"
  // — caller decides whether the caller is authorized to see it.
  const existing = await query<Pick<RecoveryPlusPurchaseRow, 'id' | 'recovery_session_id'>>(
    `SELECT id, recovery_session_id
       FROM recovery_plus_purchases
      WHERE apple_transaction_id = $1`,
    [txId],
  );
  if ((existing.rowCount ?? 0) === 0) {
    // Should be unreachable — the ON CONFLICT path means a row
    // exists. Surface as a verifier error rather than a silent
    // empty success.
    captureError(new Error('replay path: existing row not found after ON CONFLICT'), {
      component: 'recoveryPlusEntitlement.purchase',
      apple_transaction_id: txId,
    });
    throw new ReceiptVerificationError('replay lookup found no row');
  }
  void emitMetric('recovery_shield.plus_purchased', { is_new: false });
  return {
    purchase_id: existing.rows[0]!.id,
    entitled_session_id: existing.rows[0]!.recovery_session_id,
    is_new: false,
  };
}

/**
 * Entitlement gate. Returns true iff this user has an unrefunded
 * Recovery Plus unlock applicable to this session.
 *
 * APPLICABILITY:
 *  - A row WHERE recovery_session_id = $2 → applicable. The user
 *    has previously bound (or pre-bound at purchase time) this
 *    purchase to this session.
 *  - A row WHERE recovery_session_id IS NULL → applicable AND gets
 *    bound to $2 atomically on this call. Pre-purchase rows are
 *    single-use; the next session needs a fresh purchase.
 *  - Any row WHERE refunded_at IS NOT NULL → NOT applicable. The
 *    Apple refund webhook flipped the row; entitlement is gone.
 *
 * BINDING (atomic):
 *   We UPDATE ... WHERE recovery_session_id IS NULL RETURNING id
 *   first. If that returns a row, the NULL-session purchase is now
 *   bound to this session and the user is entitled. The UPDATE is
 *   atomic (single-statement) — two concurrent hasRecoveryPlus
 *   calls for different sessions on the same NULL-session row can
 *   only result in one of them winning the bind; the other falls
 *   through to the standard match-or-miss path.
 *
 * CROSS-USER SAFETY:
 *   user_id is the first predicate in every query — user A's
 *   purchase row can't unlock user B's session no matter what
 *   session_id is passed.
 */
export async function hasRecoveryPlus(
  user_id: string,
  recovery_session_id: string,
): Promise<boolean> {
  // Step 1: try to bind a NULL-session purchase to this session.
  // Single SQL statement so the UPDATE is atomic — concurrent calls
  // from two sessions can't both win this bind.
  //
  // We pick the most-recent NULL-session row (purchased_at DESC) on
  // the off-chance a user has two pending pre-purchases (unusual —
  // App Store should prevent buying the same non-consumable twice,
  // but adversarial-review item D7 flagged the case where a refund
  // + rebuy leaves two unrefunded NULL rows transiently).
  const bind = await query<{ id: string }>(
    `UPDATE recovery_plus_purchases
        SET recovery_session_id = $2
      WHERE id = (
        SELECT id FROM recovery_plus_purchases
         WHERE user_id = $1
           AND recovery_session_id IS NULL
           AND refunded_at IS NULL
         ORDER BY purchased_at DESC
         LIMIT 1
      )
      RETURNING id`,
    [user_id, recovery_session_id],
  );
  if ((bind.rowCount ?? 0) === 1) {
    void emitMetric('recovery_shield.plus_entitlement_checked', {
      result: 'bound_pre_purchase',
    });
    return true;
  }

  // Step 2: no NULL-session row available — look for a row already
  // bound to this session. refunded_at IS NULL is the entitlement-
  // revocation gate.
  const match = await query<{ id: string }>(
    `SELECT id FROM recovery_plus_purchases
      WHERE user_id = $1
        AND recovery_session_id = $2
        AND refunded_at IS NULL
      LIMIT 1`,
    [user_id, recovery_session_id],
  );
  const ok = (match.rowCount ?? 0) === 1;
  void emitMetric('recovery_shield.plus_entitlement_checked', {
    result: ok ? 'entitled' : 'not_entitled',
  });
  return ok;
}

/**
 * Set refunded_at on the row matching this apple_transaction_id.
 * Invoked by the Apple server-to-server REFUND/REVOKE notification
 * route (separate from this file's surface — the route imports this
 * function as the single mutation hook).
 *
 * Idempotent: calling twice for the same transaction is a no-op on
 * the second call (refunded_at = COALESCE(refunded_at, NOW())).
 *
 * Returns { revoked: true } if a row was touched. Returns
 * { revoked: false } if no matching row exists — Apple sometimes
 * sends refund notifications for transactions our database never
 * saw (sandbox bleed, user refunded before our INSERT landed, etc.).
 * Caller logs but does NOT error on revoked=false.
 */
export async function revokeOnRefund(
  apple_transaction_id: string,
): Promise<{ revoked: boolean }> {
  const upd = await query(
    `UPDATE recovery_plus_purchases
        SET refunded_at = COALESCE(refunded_at, NOW())
      WHERE apple_transaction_id = $1
      RETURNING id`,
    [apple_transaction_id],
  );
  const revoked = (upd.rowCount ?? 0) > 0;
  if (revoked) {
    void emitMetric('recovery_shield.plus_refunded', {});
  }
  return { revoked };
}
