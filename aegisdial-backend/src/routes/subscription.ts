import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { requireAppUser } from '../lib/auth.js';
import { currentTier, ensureTierPersisted } from '../lib/subscription.js';
import {
  verifyAppleTransactionJws,
  verifyAppleNotificationJws,
  type DecodedNotification,
} from '../lib/appleVerify.js';
import { verifyStripeSignature, handleStripeEvent, createCheckoutSession } from '../lib/stripeVerify.js';
import { syncFamilyPlanSeatsToSubscription } from '../lib/familySeats.js';
import { planForProductId } from '../lib/plans.js';
import { config } from '../config.js';

// Subscription routes. This file exposes:
//  - POST /subscription/apple/verify  — iOS sends the JWS-signed Transaction
//    payload from StoreKit 2 after a purchase. In production we verify the
//    signature against Apple's root certs and persist an active row. For now
//    we trust the client payload shape and record it, because wiring full
//    Apple server notification verification requires a shared secret from
//    App Store Connect which we don't have yet.
//
//  - POST /subscription/stripe/webhook — Stripe sends a signed event when an
//    email-user subscription starts/renews/cancels. Same story: stub for now,
//    wire signature verification once the Stripe account + webhook secret
//    are set up.
//
//  - GET  /subscription/status  — returns the current tier + expiry for the
//    authenticated user so the iOS app can decide whether to show the paywall.
//
//  - POST /subscription/dev/grant — dev-only convenience that sets the caller
//    to pro for N days. Gated behind NODE_ENV=development.

const APPLE_VERIFY_SCHEMA = z.object({
  // The rest of the fields the client sends are ignored — we derive them
  // from the signed payload.
  transaction_jws: z.string().min(20),
});

const APPLE_NOTIFICATION_SCHEMA = z.object({
  signedPayload: z.string().min(20),
});

const DEV_GRANT_SCHEMA = z.object({
  days: z.number().int().min(1).max(365).default(30),
  product_id: z.string().default('com.aegisdial.app.pro.monthly'),
});

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/subscription/apple/verify',
    { preHandler: requireAppUser },
    async (req, reply) => {
      const user = req.appUser!;
      const body = APPLE_VERIFY_SCHEMA.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

      let decoded;
      try {
        decoded = await verifyAppleTransactionJws(body.data.transaction_jws);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'apple jws verify failed');
        return reply.code(400).send({ error: 'apple_jws_invalid', message: (err as Error).message });
      }

      // Product-ID allowlist. Apple will happily sign any valid JWS for our
      // bundle — consumables, one-time purchases, future test SKUs. We
      // only grant Pro for known subscription SKUs.
      if (!planForProductId(decoded.productId)) {
        req.log.warn({ productId: decoded.productId }, 'apple jws: unknown productId');
        return reply.code(400).send({ error: 'unknown_product_id', product_id: decoded.productId });
      }

      // Bind the transaction to the caller.
      //
      // Primary binding: `appAccountToken` on the JWS. The iOS client sets
      // it at purchase time to a stable per-user UUID (see users.app_account_token).
      // If present, it MUST match the caller.
      //
      // Fallback (for older clients without appAccountToken): ownership
      // check at the DB layer — if another user already claimed this
      // original_transaction_id, reject. Prevents user B replaying user
      // A's JWS to steal entitlement.
      if (decoded.appAccountToken) {
        const ownerRes = await query<{ app_account_token: string | null }>(
          `SELECT app_account_token FROM users WHERE id = $1`,
          [user.id],
        );
        const expected = ownerRes.rows[0]?.app_account_token ?? null;
        if (expected && expected.toLowerCase() !== decoded.appAccountToken.toLowerCase()) {
          req.log.warn(
            { userId: user.id, tokenOnJws: decoded.appAccountToken },
            'apple jws: appAccountToken mismatch',
          );
          return reply.code(403).send({ error: 'account_token_mismatch' });
        }
      }

      const existing = await query<{ user_id: string }>(
        `SELECT user_id FROM subscriptions
          WHERE provider = 'apple_storekit' AND provider_transaction_id = $1
          LIMIT 1`,
        [decoded.originalTransactionId],
      );
      if (existing.rows[0] && existing.rows[0].user_id !== user.id) {
        req.log.warn(
          { caller: user.id, claimed_by: existing.rows[0].user_id, tx: decoded.originalTransactionId },
          'apple jws: transaction already bound to different user',
        );
        return reply.code(409).send({ error: 'transaction_already_bound' });
      }

      // Period derivation: auto-renewable subs trust Apple's expiresDate
      // (or 30d default if Apple omits it, which is rare). One-time SKUs
      // (Recovery Session $99) get a hard 30-day window from purchase
      // date AND auto_renew=FALSE — Apple doesn't send expiresDate on
      // non-renewing IAPs so we set it ourselves.
      const plan = planForProductId(decoded.productId)!; // already allowlisted at line ~66
      const isOneTime = plan.period === 'one_time_30d';
      const expiresMs = isOneTime
        ? decoded.purchaseDateMs + 30 * 24 * 60 * 60 * 1000
        : (decoded.expiresDateMs ?? decoded.purchaseDateMs + 30 * 24 * 60 * 60 * 1000);
      const expires = new Date(expiresMs);
      const periodStart = new Date(decoded.purchaseDateMs);
      const autoRenew = !isOneTime;

      await query(
        `INSERT INTO subscriptions (
           user_id, provider, provider_product_id, provider_transaction_id,
           status, current_period_start, current_period_end, auto_renew, raw_payload
         ) VALUES ($1, 'apple_storekit', $2, $3, 'active', $4, $5, $6, $7)
         ON CONFLICT (provider, provider_transaction_id) DO UPDATE SET
           current_period_end = EXCLUDED.current_period_end,
           status = 'active',
           raw_payload = EXCLUDED.raw_payload,
           updated_at = NOW()
           WHERE subscriptions.user_id = EXCLUDED.user_id`,
        [
          user.id,
          decoded.productId,
          decoded.originalTransactionId,
          periodStart.toISOString(),
          expires.toISOString(),
          autoRenew,
          JSON.stringify(decoded.raw),
        ],
      );

      await syncFamilyPlanSeatsToSubscription(user.id, decoded.productId);
      const tier = await currentTier(user.id);
      await ensureTierPersisted(user.id, tier);
      return reply.send({
        tier,
        current_period_end: expires.toISOString(),
        product_id: decoded.productId,
        environment: decoded.environment,
      });
    },
  );

  // Apple server-to-server notifications v2. Configured in App Store Connect
  // → Notifications → Production Server URL. Body is {"signedPayload": "<JWS>"}.
  //
  // rateLimit: false — Apple retries failed S2S notifications for up to
  // 60 days. A burst (outage recovery, Apple-side retry storm after a
  // regional incident) can easily exceed the global 300/min cap and get
  // us silently rate-limited into dropped notifications. The JWS
  // signature check inside `verifyAppleNotificationJws` is the real
  // abuse gate — an unsigned POST can't pass it.
  app.post('/subscription/apple/notifications', { config: { rateLimit: false } }, async (req, reply) => {
    const body = APPLE_NOTIFICATION_SCHEMA.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    // Signature-verify FIRST. A bad outer JWS 400s so Apple's health-
    // check on the notification URL surfaces a real problem (wrong
    // env, wrong bundleId, expired Apple root on our side). Everything
    // after this is "signature verified — our DB handler is the risk".
    let decoded;
    try {
      decoded = await verifyAppleNotificationJws(body.data.signedPayload);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'apple notification verify failed');
      return reply.code(400).send({ error: 'invalid_signed_payload' });
    }

    // Everything past the signature check returns 200 on any handler
    // failure. Apple retries failed S2S deliveries for up to 60 days —
    // a deterministic bug in our router would flood logs + Sentry for
    // two months and never self-heal. Same pattern as the Stripe
    // webhook: log + captureError + 200.
    try {
      await handleAppleNotification(decoded, req.log);
      return reply.send({ received: true });
    } catch (err) {
      req.log.error(
        { err, notificationType: decoded.notificationType, uuid: decoded.notificationUUID },
        'apple notification handler failed — returning 200 to suppress 60-day retry storm',
      );
      const { captureError } = await import('../lib/observability.js');
      captureError(err, {
        component: 'apple_s2s',
        notification_type: decoded.notificationType,
        notification_uuid: decoded.notificationUUID ?? 'unknown',
      });
      return reply.send({ received: true, handler_failed: true });
    }
  });

  // Stripe webhook. Signature verification requires the raw request body —
  // Fastify normally parses JSON, so the route config below swaps in a raw
  // parser for this path only.
  //
  // rateLimit: false — Stripe retries failed events for up to 3 days with
  // exponential backoff. During a real-world retry storm (our outage,
  // Stripe-side incident, price update that fans out N thousand
  // customer.subscription.updated events) the global 300/min cap would
  // drop events and we'd silently miss renewals / cancellations. The HMAC
  // signature check inside `verifyStripeSignature` is the real abuse
  // gate — anything without a valid `stripe-signature` 400s below.
  app.post(
    '/subscription/stripe/webhook',
    { config: { rawBody: true, rateLimit: false } },
    async (req, reply) => {
      const signature = req.headers['stripe-signature'] as string | undefined;
      const rawBody = (req as unknown as { rawBody?: Buffer | string }).rawBody;
      if (!signature || !rawBody) {
        return reply.code(400).send({ error: 'missing_signature_or_body' });
      }
      let event;
      try {
        event = verifyStripeSignature(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'), signature);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'stripe signature invalid');
        return reply.code(400).send({ error: 'invalid_signature' });
      }
      try {
        await handleStripeEvent(event, req.log);
      } catch (err) {
        // Return 200, not 500. If we 5xx, Stripe retries this event for
        // up to 3 days with exponential backoff — a persistent handler
        // bug (bad SKU, DB outage) would flood our logs and Sentry
        // quota for 72 hours. We've already logged the error + captured
        // it in Sentry via the global error handler; Stripe retrying
        // won't fix a deterministic bug anyway. If the cause is a
        // transient DB failure, the next real customer action will
        // re-sync state. This is the standard Stripe-webhook pattern.
        req.log.error({ err, event_type: (event as { type?: string }).type }, 'stripe event handler failed — returning 200 to suppress retry storm');
        const { captureError } = await import('../lib/observability.js');
        captureError(err, {
          component: 'stripe_webhook',
          event_type: (event as { type?: string }).type ?? 'unknown',
          event_id: (event as { id?: string }).id ?? 'unknown',
        });
        return reply.send({ received: true, handler_failed: true });
      }
      return reply.send({ received: true });
    },
  );

  // Start a Stripe Checkout session for the signed-in email user. The app
  // opens the returned URL in SafariView, the user pays, Stripe redirects
  // back to success_url + fires checkout.session.completed to our webhook.
  const STRIPE_CHECKOUT_SCHEMA = z.object({
    plan: z.enum(['monthly', 'yearly', 'family_plus_monthly']),
    success_url: z.string().url(),
    cancel_url: z.string().url(),
  });
  app.post(
    '/subscription/stripe/checkout',
    { preHandler: requireAppUser },
    async (req, reply) => {
      const user = req.appUser!;
      const body = STRIPE_CHECKOUT_SCHEMA.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      let priceId: string | undefined;
      switch (body.data.plan) {
        case 'monthly': priceId = config.STRIPE_MONTHLY_PRICE_ID; break;
        case 'yearly': priceId = config.STRIPE_YEARLY_PRICE_ID; break;
        case 'family_plus_monthly': priceId = config.STRIPE_FAMILY_PLUS_MONTHLY_PRICE_ID; break;
      }
      if (!priceId) {
        return reply.code(503).send({
          error: 'stripe_not_configured',
          message: 'Stripe price IDs are not set on the server.',
        });
      }
      try {
        const url = await createCheckoutSession(user.id, priceId, body.data.success_url, body.data.cancel_url);
        return reply.send({ checkout_url: url });
      } catch (err) {
        req.log.error({ err }, 'stripe checkout failed');
        // If Stripe itself isn't configured on the server (no secret
        // key set yet in this deploy), surface that as 503
        // stripe_not_configured so the iOS paywall can render "coming
        // soon" copy instead of a generic "something went wrong" error
        // that looks like a real failure to the user.
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('STRIPE_SECRET_KEY is not configured')) {
          return reply.code(503).send({
            error: 'stripe_not_configured',
            message: 'Stripe is not configured on the server yet.',
          });
        }
        return reply.code(500).send({ error: 'checkout_failed' });
      }
    },
  );

  app.get('/subscription/status', { preHandler: requireAppUser }, async (req, reply) => {
    const user = req.appUser!;
    const tier = await currentTier(user.id);
    // Prefer active rows; among ties, pick the latest period_end.
    // Without `status='active' DESC` first, a long-dated cancelled yearly
    // can outrank a newly-active monthly and mis-report the tier.
    const latest = await query<{
      current_period_end: Date;
      status: string;
      provider: string;
      provider_product_id: string;
    }>(
      `SELECT current_period_end, status, provider, provider_product_id
         FROM subscriptions
        WHERE user_id = $1
        ORDER BY (status = 'active') DESC, current_period_end DESC
        LIMIT 1`,
      [user.id],
    );
    const token = await query<{ app_account_token: string }>(
      `SELECT app_account_token FROM users WHERE id = $1`,
      [user.id],
    );
    return reply.send({
      tier,
      active: tier === 'pro',
      subscription: latest.rows[0] ?? null,
      app_account_token: token.rows[0]?.app_account_token ?? null,
    });
  });

  app.post('/subscription/dev/grant', { preHandler: requireAppUser }, async (req, reply) => {
    // Same dual gate as the dev bearer path. Without ALLOW_DEV_BEARER
    // explicitly on, this endpoint 404s even on a staging deploy.
    if (config.NODE_ENV === 'production' || !config.ALLOW_DEV_BEARER) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const user = req.appUser!;
    const body = DEV_GRANT_SCHEMA.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const days = body.data.days;
    const productId = body.data.product_id;
    const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    await query(
      `INSERT INTO subscriptions (
         user_id, provider, provider_product_id, provider_transaction_id,
         status, current_period_start, current_period_end, auto_renew
       ) VALUES ($1, 'apple_storekit', $2, $3, 'active', NOW(), $4, FALSE)`,
      [user.id, productId, `dev-${user.id}-${Date.now()}`, expires.toISOString()],
    );
    await syncFamilyPlanSeatsToSubscription(user.id, productId);
    const tier = await currentTier(user.id);
    await ensureTierPersisted(user.id, tier);
    return reply.send({ tier, current_period_end: expires.toISOString(), product_id: productId });
  });
}

// Apple S2S notification v2 router.
//
// Exported for unit testing — the route above calls it after verifying
// the outer JWS signature. Each branch is keyed on
// `notificationType` per
// https://developer.apple.com/documentation/appstoreservernotifications/notificationtype
//
// State machine — one row per original_transaction_id:
//   DID_RENEW                 -> status='active',  extend period_end
//   EXPIRED                   -> status='expired'
//   GRACE_PERIOD_EXPIRED      -> status='expired'
//   REFUND                    -> status='refunded', tier recomputed
//   REVOKE                    -> status='refunded' (same practical effect as REFUND)
//   DID_CHANGE_RENEWAL_STATUS -> auto_renew flipped only
//   PRICE_INCREASE / CONSUMPTION_REQUEST / RENEWAL_EXTENDED / RENEWAL_EXTENSION
//                             -> log-only
//   Anything else             -> log + 200 (never block Apple's retry)
//
// If the notification references a transaction we've never seen (Apple
// can sometimes fire for a transaction that was purchased before the
// account was bound to us, or for a sandbox leak into a prod URL), we
// log + 200 rather than creating a ghost row — the
// /subscription/apple/verify path is the only writer that establishes
// user-id ownership. A REFUND arriving before any verify would be a
// security hole if we auto-created.
export async function handleAppleNotification(
  decoded: DecodedNotification,
  log: FastifyBaseLogger,
): Promise<void> {
  const type = decoded.notificationType;
  log.info(
    { notificationType: type, subtype: decoded.subtype, uuid: decoded.notificationUUID },
    'apple s2s notification',
  );

  // Every notification that acts on a subscription row needs an
  // originalTransactionId. Prefer the transaction payload, fall back to
  // the renewal-info payload (some types only ship one of the two).
  const originalTxId =
    decoded.transaction?.originalTransactionId ?? decoded.renewalInfo?.originalTransactionId ?? null;

  // Look up the row once so every handler branch works off the same
  // "does this belong to one of our users?" answer.
  type SubRow = { user_id: string; status: string };
  let existing: SubRow | null = null;
  if (originalTxId) {
    const res = await query<SubRow>(
      `SELECT user_id, status FROM subscriptions
        WHERE provider = 'apple_storekit' AND provider_transaction_id = $1
        LIMIT 1`,
      [originalTxId],
    );
    existing = res.rows[0] ?? null;
  }

  switch (type) {
    case 'DID_RENEW': {
      if (!existing || !originalTxId) {
        log.warn({ originalTxId }, 'apple DID_RENEW for unknown transaction — skipping');
        return;
      }
      const tx = decoded.transaction;
      if (!tx || !tx.expiresDateMs || !tx.purchaseDateMs) {
        log.warn({ originalTxId }, 'apple DID_RENEW missing purchase/expires dates — skipping');
        return;
      }
      await query(
        `UPDATE subscriptions
            SET status = 'active',
                current_period_start = $2,
                current_period_end = $3,
                raw_payload = $4,
                updated_at = NOW()
          WHERE provider = 'apple_storekit' AND provider_transaction_id = $1`,
        [
          originalTxId,
          new Date(tx.purchaseDateMs).toISOString(),
          new Date(tx.expiresDateMs).toISOString(),
          JSON.stringify(decoded.raw),
        ],
      );
      await reconcileTier(existing.user_id);
      break;
    }
    case 'EXPIRED':
    case 'GRACE_PERIOD_EXPIRED': {
      if (!existing || !originalTxId) {
        log.warn({ originalTxId, type }, 'apple EXPIRED/GRACE_PERIOD_EXPIRED for unknown transaction — skipping');
        return;
      }
      await query(
        `UPDATE subscriptions
            SET status = 'expired',
                auto_renew = FALSE,
                updated_at = NOW()
          WHERE provider = 'apple_storekit' AND provider_transaction_id = $1`,
        [originalTxId],
      );
      await reconcileTier(existing.user_id);
      break;
    }
    case 'REFUND':
    case 'REVOKE': {
      // REFUND = Apple refunded the charge (customer-initiated or Apple-
      // initiated support case). REVOKE = family-sharing member lost
      // access. Same DB shape: the row is no longer entitling.
      if (!existing || !originalTxId) {
        log.warn({ originalTxId, type }, 'apple REFUND/REVOKE for unknown transaction — skipping');
        return;
      }
      await query(
        `UPDATE subscriptions
            SET status = 'refunded',
                auto_renew = FALSE,
                updated_at = NOW()
          WHERE provider = 'apple_storekit' AND provider_transaction_id = $1`,
        [originalTxId],
      );
      await reconcileTier(existing.user_id);
      break;
    }
    case 'DID_CHANGE_RENEWAL_STATUS': {
      // User toggled auto-renew in Settings > Subscriptions. Tier does
      // NOT change — the current period is still paid-through; only the
      // auto_renew flag is affected.
      if (!existing || !originalTxId) {
        log.warn({ originalTxId }, 'apple DID_CHANGE_RENEWAL_STATUS for unknown transaction — skipping');
        return;
      }
      // autoRenewStatus: 0 = off, 1 = on.
      const autoRenew = decoded.renewalInfo?.autoRenewStatus === 1;
      await query(
        `UPDATE subscriptions
            SET auto_renew = $2,
                updated_at = NOW()
          WHERE provider = 'apple_storekit' AND provider_transaction_id = $1`,
        [originalTxId, autoRenew],
      );
      break;
    }
    case 'PRICE_INCREASE':
    case 'CONSUMPTION_REQUEST':
    case 'RENEWAL_EXTENDED':
    case 'RENEWAL_EXTENSION':
      // Log-only. PRICE_INCREASE is informational (the user either
      // accepts at next bill or the sub lapses, which fires EXPIRED).
      // CONSUMPTION_REQUEST is a refund-dispute probe that does not
      // require state change. RENEWAL_EXTENDED/RENEWAL_EXTENSION fire
      // for proactive renewal date extensions we initiate; we'll pick
      // up the new date on the next DID_RENEW.
      log.info({ type }, 'apple s2s log-only notification');
      break;
    default:
      // SUBSCRIBED / OFFER_REDEEMED / DID_CHANGE_RENEWAL_PREF /
      // DID_FAIL_TO_RENEW / REFUND_DECLINED / REFUND_REVERSED / TEST /
      // EXTERNAL_PURCHASE_TOKEN / ONE_TIME_CHARGE / RESCIND_CONSENT.
      // For now we log + no-op. The /subscription/apple/verify path is
      // still the entitlement-truth source, so any new-purchase-like
      // event will be reconciled on the next client-side verify.
      log.info({ type }, 'apple s2s notification not routed');
      break;
  }
}

async function reconcileTier(userId: string): Promise<void> {
  const tier = await currentTier(userId);
  await ensureTierPersisted(userId, tier);
}
