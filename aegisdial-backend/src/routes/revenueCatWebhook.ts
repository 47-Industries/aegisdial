// RevenueCat → backend server-to-server webhook.
//
// RevenueCat sits in front of StoreKit on iOS and forwards a normalised
// event for every entitlement transition (initial purchase, renewal,
// expiration, refund, product change). Configure in the RevenueCat
// dashboard at Project Settings → Integrations → Webhook with:
//
//   URL:    https://api.aegisdial.com/subscription/revenuecat/webhook
//   Header: Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>
//
// The webhook secret is a value YOU pick — we compare against
// config.REVENUECAT_WEBHOOK_SECRET. Without that env var set, the
// route 503's so a misconfigured prod can't silently accept unsigned
// hits.
//
// User identity: we set RevenueCat's app_user_id to AegisDial's
// users.id via Purchases.logIn() in the Flutter PurchaseService right
// after sign-in (lib/services/auth_service.dart). The webhook reads
// that ID from the event payload to find the local user row.
//
// Provider semantics: this writes provider='apple_storekit' because
// the BILLING source IS Apple — RevenueCat is just an alternate
// notification path for the same Apple subscription. The existing
// `/subscription/apple/verify` and `/subscription/apple/notifications`
// routes already write to the same provider; ON CONFLICT (provider,
// provider_transaction_id) merges duplicate notifications cleanly.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { config } from '../config.js';
import { currentTier, ensureTierPersisted } from '../lib/subscription.js';
import { planForProductId } from '../lib/plans.js';
import { syncFamilyPlanSeatsToSubscription } from '../lib/familySeats.js';

// Subset of fields we actually read off the RevenueCat event envelope.
// RC sends many more — we ignore them. See:
// https://www.revenuecat.com/docs/webhooks#sample-event
const RC_EVENT_SCHEMA = z.object({
  event: z.object({
    type: z.string(),
    id: z.string().optional(),
    app_user_id: z.string().min(1),
    product_id: z.string().optional(),
    period_type: z.string().optional(),
    purchased_at_ms: z.number().optional(),
    expiration_at_ms: z.number().nullable().optional(),
    store: z.string().optional(),
    transaction_id: z.string().optional(),
    original_transaction_id: z.string().optional(),
    environment: z.string().optional(),
  }),
  api_version: z.string().optional(),
});

// Map RevenueCat event types to subscription row state. Anything not
// in this map is a noisy informational event (TEST, TRANSFER, etc.)
// that we acknowledge without DB writes.
const ACTIVATING_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'NON_RENEWING_PURCHASE',
  'UNCANCELLATION',
  'PRODUCT_CHANGE',
]);
const REVOKING_EVENTS = new Set([
  'EXPIRATION',
  'REFUND',
  'SUBSCRIPTION_PAUSED',
]);

export async function revenueCatWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/subscription/revenuecat/webhook',
    {
      // rateLimit: false — same reasoning as Apple S2S. RevenueCat
      // retries failed deliveries; the auth-header check is the real
      // abuse gate.
      config: { rateLimit: false },
    },
    async (req, reply) => {
      // Refuse to accept anything when not configured. Better to
      // surface a 503 in the RevenueCat dashboard than silently
      // accept unsigned events as authentic.
      const secret = config.REVENUECAT_WEBHOOK_SECRET;
      if (!secret) {
        req.log.error('revenuecat webhook hit but REVENUECAT_WEBHOOK_SECRET unset');
        return reply.code(503).send({ error: 'webhook_not_configured' });
      }
      const auth = req.headers['authorization'];
      const expected = `Bearer ${secret}`;
      if (typeof auth !== 'string' || auth !== expected) {
        req.log.warn({ auth: auth ? 'present' : 'absent' }, 'revenuecat webhook auth mismatch');
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const parsed = RC_EVENT_SCHEMA.safeParse(req.body);
      if (!parsed.success) {
        req.log.warn({ err: parsed.error.flatten() }, 'revenuecat webhook bad payload');
        return reply.code(400).send({ error: 'invalid_payload' });
      }
      const ev = parsed.data.event;

      // Validate the local user exists and matches the RC app_user_id
      // (which we set to users.id at signup via Purchases.logIn()).
      // RevenueCat retries on 5xx; we 200 on "user not found" because
      // the most likely cause is a webhook arriving before the user
      // row is created server-side (race during cold sign-up), and
      // retries don't help.
      const userRes = await query<{ id: string }>(
        `SELECT id FROM users WHERE id = $1`,
        [ev.app_user_id],
      );
      if (userRes.rows.length === 0) {
        req.log.warn({ appUserId: ev.app_user_id, eventType: ev.type }, 'revenuecat event for unknown user');
        return reply.send({ received: true, note: 'user_not_found' });
      }
      const userId = userRes.rows[0]!.id;

      try {
        if (ACTIVATING_EVENTS.has(ev.type)) {
          await handleActivation(userId, ev);
        } else if (REVOKING_EVENTS.has(ev.type)) {
          await handleRevocation(userId, ev);
        } else {
          // TEST, TRANSFER, BILLING_ISSUE, SUBSCRIBER_ALIAS, etc. —
          // log and acknowledge.
          req.log.info({ eventType: ev.type, appUserId: ev.app_user_id }, 'revenuecat event acknowledged');
        }
      } catch (err) {
        req.log.error(
          { err, eventType: ev.type, appUserId: ev.app_user_id },
          'revenuecat webhook handler failed — returning 200 to suppress retry storm',
        );
        // Same posture as the Apple S2S handler: log + 200 so a
        // deterministic bug doesn't trigger a multi-day retry flood.
      }

      return reply.send({ received: true });
    },
  );
}

async function handleActivation(userId: string, ev: z.infer<typeof RC_EVENT_SCHEMA>['event']) {
  if (!ev.product_id) {
    throw new Error('activation event missing product_id');
  }
  // Allowlist the product_id against our plan catalog so RevenueCat
  // can't inadvertently activate Pro via an unknown SKU.
  if (!planForProductId(ev.product_id)) {
    throw new Error(`unknown product_id ${ev.product_id}`);
  }
  const isOneTime = ev.period_type === 'NORMAL' && ev.type === 'NON_RENEWING_PURCHASE';
  const purchasedMs = ev.purchased_at_ms ?? Date.now();
  // One-time grants (Recovery Session $149 → 14 days Pro) need a
  // computed expiry since RevenueCat doesn't set expiration_at_ms.
  const expiryMs =
    ev.expiration_at_ms ??
    (isOneTime ? purchasedMs + 14 * 24 * 60 * 60 * 1000 : purchasedMs + 30 * 24 * 60 * 60 * 1000);
  const transactionId =
    ev.original_transaction_id ??
    ev.transaction_id ??
    `revenuecat-${ev.id ?? `${userId}-${purchasedMs}`}`;
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
      userId,
      ev.product_id,
      transactionId,
      new Date(purchasedMs).toISOString(),
      new Date(expiryMs).toISOString(),
      autoRenew,
      JSON.stringify({ source: 'revenuecat', event: ev }),
    ],
  );

  await syncFamilyPlanSeatsToSubscription(userId, ev.product_id);
  const tier = await currentTier(userId);
  await ensureTierPersisted(userId, tier);
}

async function handleRevocation(userId: string, ev: z.infer<typeof RC_EVENT_SCHEMA>['event']) {
  const transactionId = ev.original_transaction_id ?? ev.transaction_id;
  if (!transactionId) {
    // Without a transaction id we can't target the row. Best we can
    // do is no-op + log, since blanket-revoking would nuke unrelated
    // subscriptions.
    throw new Error('revocation event missing transaction id');
  }
  const status = ev.type === 'REFUND' ? 'revoked' : 'expired';
  await query(
    `UPDATE subscriptions
        SET status = $3,
            current_period_end = LEAST(current_period_end, NOW()),
            raw_payload = jsonb_build_object('source','revenuecat','event', $4::jsonb),
            updated_at = NOW()
      WHERE user_id = $1
        AND provider_transaction_id = $2`,
    [userId, transactionId, status, JSON.stringify(ev)],
  );
  const tier = await currentTier(userId);
  await ensureTierPersisted(userId, tier);
}
