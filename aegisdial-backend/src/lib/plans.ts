// Authoritative plan catalog. One row per SKU — every subscription that
// lands in the `subscriptions` table must reference one of these product
// IDs. When a plan verifies (Apple) or a webhook fires (Stripe), we map
// product_id → line counts and push those into the user's family_plans row
// so `/v1/family/invite` capacity checks reflect what they actually paid
// for.
//
// Pricing (effective 2026-05-12, per Jesiah's new tier):
//   Pro Monthly                 — $49.99 / month        (3 lines, monthly)
//   Pro Annual                  — $399 / year ($33/mo)  (3 lines, yearly, save $200)
//   Recovery Session (one-time) — $149 + 14-day Pro     (1 line, non-renewing)
//   Recovery Concierge Monthly  — $99 / month           (1 line, dedicated agent + priority)
//   Recovery Concierge Yearly   — $899 / year (~$75/mo) (1 line, dedicated agent + priority)
//
// DEPRECATED (kept for resolving existing subscriptions, NOT offered in
// the active paywall):
//   Pro Family+                 — $69.99 / month        (3 + 2 add-on lines, monthly)
//
// Family+ has no Annual SKU. If we add one later, append to PLANS and it
// flows through automatically (and remember to drop it from
// DEPRECATED_SKUS once it's actively offered again).

export interface Plan {
  product_id: string;
  included_lines: number;
  addon_lines: number;
  /**
   * - 'monthly' / 'yearly': auto-renewing subscription, Apple/Stripe drive expiry.
   * - 'one_time_14d': non-renewing IAP that grants a 14-day Pro window.
   *   `subscription.ts` reads the numeric suffix to compute current_period_end.
   *   The Recovery Session SKU is the only one_time today.
   */
  period: 'monthly' | 'yearly' | 'one_time_14d';
  display_name: string;
  price_usd_cents: number;
  /**
   * True when this SKU still resolves to a valid subscription (so existing
   * subscribers keep their access) but is no longer offered in the active
   * paywall to new buyers. Marketing copy should not surface it.
   */
  deprecated?: boolean;
}

export const PLANS: Record<string, Plan> = {
  'com.aegiadial.ios.pro.monthly': {
    product_id: 'com.aegiadial.ios.pro.monthly',
    included_lines: 3,
    addon_lines: 0,
    period: 'monthly',
    display_name: 'AegisDial Pro',
    price_usd_cents: 4999,
  },
  'com.aegiadial.ios.pro.yearly': {
    product_id: 'com.aegiadial.ios.pro.yearly',
    included_lines: 3,
    addon_lines: 0,
    period: 'yearly',
    display_name: 'AegisDial Pro — Annual',
    price_usd_cents: 39900,
  },

  // ── Recovery wedge ─────────────────────────────────────────────────
  // One-time, non-renewing 14-day Pro grant. The wedge SKU for victims
  // who just got scammed and want guided recovery without subscribing.
  // Configured in App Store Connect as a NON-CONSUMABLE in-app purchase
  // (not auto-renewable subscription). The Apple verify path detects
  // period='one_time_14d' and writes auto_renew=FALSE on the
  // subscriptions row; current_period_end is set 14 days out.
  'com.aegiadial.ios.recovery.session': {
    product_id: 'com.aegiadial.ios.recovery.session',
    included_lines: 1, // single-user, no family seats
    addon_lines: 0,
    period: 'one_time_14d',
    display_name: 'AegisDial Recovery Session',
    price_usd_cents: 14900,
  },

  // ── Recovery Concierge (subscription tier) ─────────────────────────
  // Higher-priced Pro variant marketed as "Dedicated agent + priority."
  // The dedicated-agent and priority-support features are a UI/SLA
  // claim for now — backend doesn't yet gate any code path on this
  // tier specifically. Persona-level routing can be added later by
  // checking provider_product_id at /v1/recovery/* and SLA work.
  'com.aegiadial.ios.recovery.monthly': {
    product_id: 'com.aegiadial.ios.recovery.monthly',
    included_lines: 1,
    addon_lines: 0,
    period: 'monthly',
    display_name: 'AegisDial Recovery Concierge',
    price_usd_cents: 9900,
  },
  'com.aegiadial.ios.recovery.yearly': {
    product_id: 'com.aegiadial.ios.recovery.yearly',
    included_lines: 1,
    addon_lines: 0,
    period: 'yearly',
    display_name: 'AegisDial Recovery Concierge — Annual',
    price_usd_cents: 89900,
  },

  // ── Deprecated (existing subs honored, not offered to new buyers) ──
  'com.aegiadial.ios.pro.family_plus.monthly': {
    product_id: 'com.aegiadial.ios.pro.family_plus.monthly',
    included_lines: 3,
    addon_lines: 2,
    period: 'monthly',
    display_name: 'AegisDial Pro — Family+',
    price_usd_cents: 6999,
    deprecated: true,
  },
};

// All monthly-tier product IDs offered on the active paywall, low→high.
// Family+ is excluded — it's deprecated. Adding a new monthly SKU?
// Append here AND in the iOS paywall.
export const MONTHLY_SKUS = [
  'com.aegiadial.ios.pro.monthly',
  'com.aegiadial.ios.recovery.monthly',
];

// All annual-tier product IDs offered on the active paywall, low→high.
export const YEARLY_SKUS = [
  'com.aegiadial.ios.pro.yearly',
  'com.aegiadial.ios.recovery.yearly',
];

export function planForProductId(productId: string): Plan | null {
  return PLANS[productId] ?? null;
}

export function linesForProductId(productId: string): { included: number; addon: number } {
  const plan = PLANS[productId];
  if (!plan) return { included: 3, addon: 0 }; // safe default — basic pro
  return { included: plan.included_lines, addon: plan.addon_lines };
}

/**
 * Number of days to grant on a one-time IAP. Today only Recovery Session
 * is one-time, and the grant is 14 days. The function exists so a future
 * one_time_30d / one_time_60d variant can be added without touching the
 * subscription.ts integration point.
 */
export function grantDaysForOneTime(plan: Plan): number {
  switch (plan.period) {
    case 'one_time_14d':
      return 14;
    default:
      return 0;
  }
}
