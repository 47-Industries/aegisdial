// Authoritative plan catalog. One row per SKU — every subscription that
// lands in the `subscriptions` table must reference one of these product
// IDs. When a plan verifies (Apple) or a webhook fires (Stripe), we map
// product_id → line counts and push those into the user's family_plans row
// so `/v1/family/invite` capacity checks reflect what they actually paid
// for.
//
// Pricing (effective 2026-04-19):
//   Pro (3 lines)               — $49.99 / month  OR  $299 / year
//   Pro Family+ (5 lines)       — $69.99 / month  (3-line base + 2 add-on lines)
//   Recovery Session (one-time) — $99 (non-renewing, 30-day Pro grant for
//                                 the immediate-aftermath wedge — victims
//                                 who want help for ONE event without a
//                                 subscription commitment)
//
// Annual on Family+ is not offered at launch — keeps the ladder simple. If
// we add one later, append to PLANS and it flows through automatically.

export interface Plan {
  product_id: string;
  included_lines: number;
  addon_lines: number;
  period: 'monthly' | 'yearly' | 'one_time_30d';
  display_name: string;
  price_usd_cents: number;
}

export const PLANS: Record<string, Plan> = {
  'com.aegisdial.ios.pro.monthly': {
    product_id: 'com.aegisdial.ios.pro.monthly',
    included_lines: 3,
    addon_lines: 0,
    period: 'monthly',
    display_name: 'AegisDial Pro',
    price_usd_cents: 4999,
  },
  'com.aegisdial.ios.pro.yearly': {
    product_id: 'com.aegisdial.ios.pro.yearly',
    included_lines: 3,
    addon_lines: 0,
    period: 'yearly',
    display_name: 'AegisDial Pro — Annual',
    price_usd_cents: 29900,
  },
  'com.aegisdial.ios.pro.family_plus.monthly': {
    product_id: 'com.aegisdial.ios.pro.family_plus.monthly',
    included_lines: 3,
    addon_lines: 2,
    period: 'monthly',
    display_name: 'AegisDial Pro — Family+',
    price_usd_cents: 6999,
  },
  // One-time, non-renewing 30-day Pro grant. The wedge SKU for victims
  // who just got scammed and want guided recovery without subscribing.
  // Configured in App Store Connect as a NON-CONSUMABLE in-app purchase
  // (not auto-renewable subscription). The Apple verify path detects
  // period='one_time_30d' and writes auto_renew=FALSE on the
  // subscriptions row; current_period_end is set 30 days out.
  'com.aegisdial.ios.recovery.session': {
    product_id: 'com.aegisdial.ios.recovery.session',
    included_lines: 1, // single-user, no family seats
    addon_lines: 0,
    period: 'one_time_30d',
    display_name: 'AegisDial Recovery Session',
    price_usd_cents: 9900,
  },
};

// All monthly-tier product IDs, ordered low→high for UI sorting.
export const MONTHLY_SKUS = [
  'com.aegisdial.ios.pro.monthly',
  'com.aegisdial.ios.pro.family_plus.monthly',
];

// All annual-tier product IDs.
export const YEARLY_SKUS = ['com.aegisdial.ios.pro.yearly'];

export function planForProductId(productId: string): Plan | null {
  return PLANS[productId] ?? null;
}

export function linesForProductId(productId: string): { included: number; addon: number } {
  const plan = PLANS[productId];
  if (!plan) return { included: 3, addon: 0 }; // safe default — basic pro
  return { included: plan.included_lines, addon: plan.addon_lines };
}
