import Stripe from 'stripe';
import type { FastifyBaseLogger } from 'fastify';
import { query } from './db.js';
import { currentTier, ensureTierPersisted } from './subscription.js';
import { syncFamilyPlanSeatsToSubscription } from './familySeats.js';
import { planForProductId } from './plans.js';
import { config } from '../config.js';

// Stripe signature verification + event handler for email-user subscription
// purchases. Flow:
//   1. Email user hits /subscription/stripe/checkout  -> creates a Checkout
//      Session with our price ID + client_reference_id=userId.
//   2. Stripe redirects them back to the app with success/cancel.
//   3. Stripe POSTs `checkout.session.completed` + ongoing
//      `customer.subscription.*` events to our webhook.
//   4. We verify the signature and update the `subscriptions` table so the
//      user's tier flips to 'pro'.
//
// Signature verification requires the raw request body; see routes/subscription.ts
// which registers a rawBody-capable parser for only this endpoint.

// Pin to the exact Stripe API version the runtime talks to so a silent
// server-side upgrade (Stripe rolling out a new dated version while we
// sleep) can't re-shape the webhook/subscription payloads we rely on.
// This MUST be rotated consciously — when we bump the `stripe` SDK
// package, run:
//   cat node_modules/stripe/esm/apiVersion.d.ts
// review the diff in Stripe's API changelog, update this constant, run
// the full test suite, and only THEN ship.
const STRIPE_API_VERSION = '2026-03-25.dahlia';

let cachedClient: Stripe | null = null;
function stripeClient(): Stripe {
  if (cachedClient) return cachedClient;
  if (!config.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  cachedClient = new Stripe(config.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
  });
  return cachedClient;
}

// Test-only seam. Lets the webhook test install a mock Stripe client so
// checkout.session.completed can be exercised without hitting the real API
// (the handler calls stripeClient().subscriptions.retrieve). Intentionally
// not exposed through an index barrel — import directly from this file.
export function __setStripeClientForTesting(client: Stripe | null): void {
  cachedClient = client;
}

export function verifyStripeSignature(rawBody: string, signature: string): Stripe.Event {
  if (!config.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }
  return stripeClient().webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
}

export async function createCheckoutSession(
  userId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const session = await stripeClient().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: userId,
    metadata: { aegisdial_user_id: userId },
    subscription_data: {
      metadata: { aegisdial_user_id: userId },
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  if (!session.url) throw new Error('Stripe checkout session had no URL');
  return session.url;
}

export async function handleStripeEvent(event: Stripe.Event, log: FastifyBaseLogger): Promise<void> {
  log.info({ type: event.type, id: event.id }, 'stripe event');

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = extractUserId(session);
      if (!userId) {
        // TODO: future Kyle — our /subscription/stripe/checkout route sets
        // client_reference_id + subscription_data.metadata.aegisdial_user_id,
        // so a missing userId here means either (a) the checkout was started
        // outside our app (Stripe dashboard, billing portal) or (b) a future
        // refactor dropped the attribution. Either way we can't entitle
        // without knowing which user paid — log and skip.
        log.warn({ type: event.type, id: event.id }, 'stripe checkout session missing user attribution');
        return;
      }
      const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
      if (!subscriptionId) {
        log.warn({ type: event.type, id: event.id }, 'stripe checkout session missing subscription id');
        return;
      }
      const sub = await stripeClient().subscriptions.retrieve(subscriptionId);
      await upsertStripeSubscription(userId, sub);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.resumed': {
      const sub = event.data.object as Stripe.Subscription;
      const userId = extractUserId(sub);
      if (!userId) {
        log.warn({ type: event.type, id: event.id, sub: sub.id }, 'stripe subscription missing user attribution');
        return;
      }
      await upsertStripeSubscription(userId, sub);
      break;
    }
    case 'customer.subscription.deleted': {
      // Stripe fires this when a sub is hard-deleted (fully cancelled + end
      // of period). We map to 'revoked' so tier recomputation knows this is
      // terminal, distinct from a mid-cycle cancel that still has runway.
      const sub = event.data.object as Stripe.Subscription;
      const userId = extractUserId(sub);
      if (!userId) {
        log.warn({ type: event.type, id: event.id, sub: sub.id }, 'stripe subscription missing user attribution');
        return;
      }
      await query(
        `UPDATE subscriptions
            SET status = 'revoked', auto_renew = FALSE, updated_at = NOW()
          WHERE provider = 'stripe' AND provider_transaction_id = $1`,
        [sub.id],
      );
      const tier = await currentTier(userId);
      await ensureTierPersisted(userId, tier);
      break;
    }
    case 'customer.subscription.paused': {
      // Paused subs are eligible to resume. Treat as 'expired' (no entitlement)
      // until we see customer.subscription.resumed, which re-enters the upsert
      // path with status 'active'.
      const sub = event.data.object as Stripe.Subscription;
      const userId = extractUserId(sub);
      if (!userId) {
        log.warn({ type: event.type, id: event.id, sub: sub.id }, 'stripe subscription missing user attribution');
        return;
      }
      await query(
        `UPDATE subscriptions
            SET status = 'expired', auto_renew = FALSE, updated_at = NOW()
          WHERE provider = 'stripe' AND provider_transaction_id = $1`,
        [sub.id],
      );
      const tier = await currentTier(userId);
      await ensureTierPersisted(userId, tier);
      break;
    }
    case 'invoice.payment_failed': {
      // The `subscription` field on Invoice moved between API versions; we
      // probe both locations defensively.
      const invoice = event.data.object as unknown as {
        subscription?: string | { id: string };
        parent?: { subscription_details?: { subscription?: string | { id: string } } };
      };
      const maybeDirect = invoice.subscription;
      const maybeNested = invoice.parent?.subscription_details?.subscription;
      const raw = maybeDirect ?? maybeNested;
      const subId = typeof raw === 'string' ? raw : raw?.id;
      if (!subId) return;
      // Only demote to in_grace if the row isn't already in a terminal state.
      // If the sub was already revoked (e.g. deleted earlier) we don't want a
      // late payment_failed event dragging it back into a billable grace state.
      await query(
        `UPDATE subscriptions
            SET status = 'in_grace', updated_at = NOW()
          WHERE provider = 'stripe' AND provider_transaction_id = $1
            AND status NOT IN ('revoked', 'cancelled')`,
        [subId],
      );
      break;
    }
    default:
      // Other events (payment_intent.*, invoice.paid, etc.) are not actioned.
      // TODO: future Kyle — invoice.paid would be a cleaner trigger for
      // renewal tier bumps than relying on customer.subscription.updated;
      // revisit once we have a month of production traffic to sample.
      log.debug({ type: event.type, id: event.id }, 'stripe event not handled');
      break;
  }
}

async function upsertStripeSubscription(userId: string, sub: Stripe.Subscription): Promise<void> {
  const item = sub.items.data[0];
  if (!item) return;
  const priceId = item.price.id;
  // Translate the opaque Stripe price ID back to our internal SKU
  // (e.g. 'com.aegiadial.ios.pro.monthly') so downstream consumers —
  // linesForProductId, family-seat sync, the iOS paywall reading
  // provider_product_id — keep seeing the same catalog keys regardless of
  // whether the purchase came through Apple or Stripe. Fall back to the raw
  // price_id if no mapping exists so we don't drop the row on the floor.
  const productId = priceToProductId(priceId) ?? priceId;
  // If the returned productId doesn't resolve against our catalog, we've
  // seen a Stripe price ID we can't map to a known plan. Persist the row
  // so the user doesn't disappear from billing, but LOG LOUDLY and ship
  // to Sentry — otherwise a newly-added Stripe SKU that wasn't mirrored
  // into our env config would silently entitle users to an unknown
  // plan, breaking downstream family_seats + tier lookups.
  if (!planForProductId(productId)) {
    const { captureError } = await import('./observability.js');
    const err = new Error(
      `Stripe webhook: unknown product_id "${productId}" (price_id=${priceId}). ` +
      `Add the mapping to STRIPE_*_PRICE_ID env vars or src/lib/plans.ts.`,
    );
    captureError(err, {
      component: 'stripe_webhook',
      price_id: priceId,
      product_id: productId,
      user_id: userId,
    });
  }
  const status = mapStripeStatus(sub.status);
  // Stripe moved `current_period_start/end` from Subscription onto each
  // SubscriptionItem. Read through `unknown` so both old and new API
  // versions are handled without a type version pin.
  const subAny = sub as unknown as { current_period_start?: number; current_period_end?: number };
  const itemAny = item as unknown as { current_period_start?: number; current_period_end?: number };
  const startSec = itemAny.current_period_start ?? subAny.current_period_start;
  const endSec = itemAny.current_period_end ?? subAny.current_period_end;
  if (!startSec || !endSec) throw new Error('stripe subscription missing period fields');
  const periodStart = new Date(startSec * 1000);
  const periodEnd = new Date(endSec * 1000);
  await query(
    `INSERT INTO subscriptions (
       user_id, provider, provider_product_id, provider_transaction_id,
       status, current_period_start, current_period_end, auto_renew, raw_payload
     ) VALUES ($1, 'stripe', $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (provider, provider_transaction_id) DO UPDATE SET
       status = EXCLUDED.status,
       provider_product_id = EXCLUDED.provider_product_id,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       auto_renew = EXCLUDED.auto_renew,
       raw_payload = EXCLUDED.raw_payload,
       updated_at = NOW()`,
    [
      userId,
      productId,
      sub.id,
      status,
      periodStart.toISOString(),
      periodEnd.toISOString(),
      !sub.cancel_at_period_end,
      JSON.stringify(sub),
    ],
  );
  await syncFamilyPlanSeatsToSubscription(userId, productId);
  const tier = await currentTier(userId);
  await ensureTierPersisted(userId, tier);
}

function mapStripeStatus(s: Stripe.Subscription.Status): string {
  switch (s) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'in_grace';
    case 'canceled':
    case 'incomplete_expired':
      return 'cancelled';
    case 'incomplete':
      return 'in_grace';
    case 'paused':
      return 'cancelled';
    default:
      return 'expired';
  }
}

function extractUserId(obj: Stripe.Checkout.Session | Stripe.Subscription): string | null {
  if ('client_reference_id' in obj && obj.client_reference_id) return obj.client_reference_id;
  const metadata = (obj.metadata ?? {}) as Record<string, string>;
  return metadata.aegisdial_user_id ?? null;
}

// Map a Stripe price ID back to our internal SKU. Stripe price IDs are
// opaque (price_xxx) and live in the env config; our catalog in plans.ts is
// keyed on the App Store-style product ID ('com.aegiadial.ios.pro.monthly',
// etc). This function is the glue so Stripe-originated rows land in the
// subscriptions table with the same product_id shape as Apple rows.
function priceToProductId(priceId: string): string | null {
  const mapping: Array<[string | undefined, string]> = [
    [config.STRIPE_MONTHLY_PRICE_ID, 'com.aegiadial.ios.pro.monthly'],
    [config.STRIPE_YEARLY_PRICE_ID, 'com.aegiadial.ios.pro.yearly'],
    [config.STRIPE_FAMILY_PLUS_MONTHLY_PRICE_ID, 'com.aegiadial.ios.pro.family_plus.monthly'],
  ];
  for (const [envPrice, productId] of mapping) {
    if (envPrice && envPrice === priceId) {
      // Sanity: only return mappings we have catalog entries for.
      if (planForProductId(productId)) return productId;
    }
  }
  return null;
}
