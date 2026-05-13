-- Recovery Shield — P1: Recovery Plus IAP entitlement registry.
--
-- One row per successful StoreKit purchase of the `recovery_plus_one_time`
-- non-consumable IAP. Recovery Plus is a $249 unlock per recovery
-- session (NOT per-user, NOT per-month — the entitlement binds to a
-- single recovery_session_id; a user who buys Plus for one case does
-- NOT get it free for the next). Keeps pricing honest: every scam is
-- its own incident.
--
-- ENTITLEMENT MODEL:
--   - purchaseRecoveryPlus(userId, appleReceipt, sessionId) verifies
--     the receipt via Apple's verifyReceipt endpoint (sandbox +
--     production fallback) and INSERTs the row.
--   - hasRecoveryPlus(userId, sessionId) is a single-row lookup keyed
--     on (user_id, recovery_session_id) WHERE refunded_at IS NULL.
--   - revokeOnRefund(appleTransactionId) is wired into Apple's
--     server-to-server refund webhook (RECEIPT-REFUND, REVOKE) — sets
--     refunded_at NOW(); the next entitlement check returns false.
--
-- REPLAY PROTECTION:
--   - apple_transaction_id is UNIQUE. Apple's verifyReceipt response
--     includes original_transaction_id; we store that. A replayed
--     receipt from a different user fails the UNIQUE constraint
--     before it can cross the user-boundary.
--   - Cross-user purchase attempts (user A buys, user B tries to
--     replay the same receipt) collide on apple_transaction_id and
--     401 at the route layer.
--
-- PRE-PURCHASE UNLOCK CASE:
--   - recovery_session_id is nullable. iOS surfaces the Recovery Plus
--     upsell BEFORE the recovery session exists in some flows (user
--     opens the marketplace tab, decides to buy Plus first, then
--     starts the session). We INSERT the row with NULL session_id;
--     the route that creates the session then UPDATEs the row to
--     bind it. A nullable session_id row that's older than 7 days
--     without binding gets swept (handled in the route, not at the
--     DB layer).
--
-- PRIVACY POSTURE:
--   - apple_receipt_data is the full verified base64 receipt blob.
--     Stored plaintext (already a public artifact from the StoreKit
--     transaction); Apple's verifyReceipt is idempotent and we may
--     re-verify on suspicion of tampering. NOT envelope-encrypted —
--     no PII beyond the (user-known) transaction id.
--   - purchase_amount_cents is denormalized from the receipt for
--     fast admin-dashboard aggregation (don't re-parse JSON on every
--     summary query).
--
-- RETENTION: Recovery Plus purchases are kept FOREVER. Tax records,
-- refund auditability, customer-support traceability. The retention
-- sweeper SKIPS this table.
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS recovery_plus_purchases (
  id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Nullable: pre-purchase unlock case (user buys Plus before
  -- starting the session). Route layer UPDATEs this to bind the
  -- session once it's created. No FK cascade — recovery_sessions
  -- delete is rare and we'd rather keep the purchase row for refund
  -- auditability than cascade away receipts.
  recovery_session_id       UUID         REFERENCES recovery_sessions(id),
  -- Apple's original_transaction_id from the verifyReceipt response.
  -- UNIQUE constraint is the replay-protection backbone — same
  -- receipt cannot be redeemed by two users or twice by one user.
  apple_transaction_id      TEXT         NOT NULL UNIQUE,
  -- Full verified receipt blob (base64). Kept for re-verification on
  -- refund / chargeback / support escalation. Not envelope-encrypted:
  -- already public to the user and to Apple.
  apple_receipt_data        TEXT         NOT NULL,
  -- $249 = 24900. Denormalized from the receipt for fast aggregate
  -- queries (admin revenue dashboard). Stored as INTEGER cents to
  -- avoid float drift on summation.
  purchase_amount_cents     INTEGER      NOT NULL,
  currency                  TEXT         NOT NULL DEFAULT 'USD',
  purchased_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Apple refunds reverse the entitlement. Webhook handler sets
  -- this to NOW(); the hasRecoveryPlus() lookup filters refunded
  -- rows out. We KEEP the row (don't DELETE) so the admin
  -- dashboard's refund-rate metric remains queryable.
  refunded_at               TIMESTAMPTZ
);

-- Hot path: "did this user purchase Plus for this session" — the
-- entitlement check on every Recovery-Plus-gated route. Includes
-- purchased_at DESC so the latest-purchase-wins on the (rare) case
-- of a duplicate bind.
CREATE INDEX IF NOT EXISTS idx_recovery_plus_user
  ON recovery_plus_purchases (user_id, purchased_at DESC);

COMMENT ON TABLE recovery_plus_purchases IS
  'Recovery Shield — $249 per-session Recovery Plus IAP unlock registry. apple_transaction_id UNIQUE protects against receipt replay. Refunds set refunded_at and the entitlement check filters those out.';

COMMENT ON COLUMN recovery_plus_purchases.recovery_session_id IS
  'Nullable for pre-purchase unlock flow — iOS may surface Plus before the session exists. Route layer binds it once the session is created. NOT cascade-deleted on session delete (keep purchase row for refund / tax audit).';

COMMENT ON COLUMN recovery_plus_purchases.apple_transaction_id IS
  'Apple original_transaction_id from verifyReceipt response. UNIQUE — the primary replay-protection mechanism.';

COMMENT ON COLUMN recovery_plus_purchases.purchase_amount_cents IS
  'Denormalized from the receipt for fast revenue aggregation. $249 = 24900. INTEGER cents avoids float drift on SUM() rollups.';

COMMENT ON COLUMN recovery_plus_purchases.refunded_at IS
  'Set by the Apple server-to-server refund webhook. Row is preserved (NOT deleted) so the admin dashboard refund-rate metric stays queryable. Entitlement lookup filters WHERE refunded_at IS NULL.';
