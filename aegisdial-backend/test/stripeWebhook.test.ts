import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Stand up the env the config schema demands BEFORE any src/* imports.
// config.ts fails fast on missing required vars, so every test file has to
// do this dance. We also set Stripe price IDs here so priceToProductId maps
// price_test_monthly -> com.fortyseven.aegisdial.pro.monthly — the same catalog
// key an Apple-originated subscription row would use.
process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://stripe-webhook-test';
process.env.STRIPE_SECRET_KEY ||= 'sk_test_dummy_key';
process.env.STRIPE_WEBHOOK_SECRET ||= 'whsec_test_dummy';
process.env.STRIPE_MONTHLY_PRICE_ID = 'price_test_monthly';
process.env.STRIPE_YEARLY_PRICE_ID = 'price_test_yearly';
process.env.STRIPE_FAMILY_PLUS_MONTHLY_PRICE_ID = 'price_test_family_plus';

const db = await import('../src/lib/db.ts');
const stripeVerify = await import('../src/lib/stripeVerify.ts');

// Minimal logger matching the FastifyBaseLogger shape handleStripeEvent uses.
// We don't assert on log output — a silent logger keeps the test output clean.
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

// In-memory fake for the subscriptions table. handleStripeEvent only reads /
// writes through db.query(), so we intercept pool.query and route by SQL
// fragment. Each row is keyed on provider_transaction_id because that's the
// ON CONFLICT key the INSERT uses — it's the same idempotency key Stripe
// relies on when retrying failed webhook deliveries.
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

interface DbState {
  subs: Map<string, SubRow>;
  queryLog: Array<{ text: string; params: unknown[] }>;
}

const dbState: DbState = {
  subs: new Map(),
  queryLog: [],
};

function resetDb(): void {
  dbState.subs.clear();
  dbState.queryLog.length = 0;
}

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  dbState.queryLog.push({ text, params });
  const t = text.trim();

  // Upsert from upsertStripeSubscription.
  if (/^INSERT INTO subscriptions[\s\S]+ON CONFLICT \(provider, provider_transaction_id\)/i.test(t)) {
    const [
      user_id,
      provider_product_id,
      provider_transaction_id,
      status,
      current_period_start,
      current_period_end,
      auto_renew,
      raw_payload,
    ] = params as [string, string, string, string, string, string, boolean, string];
    const key = provider_transaction_id;
    const existing = dbState.subs.get(key);
    if (existing) {
      existing.provider_product_id = provider_product_id;
      existing.status = status;
      existing.current_period_start = current_period_start;
      existing.current_period_end = current_period_end;
      existing.auto_renew = auto_renew;
      existing.raw_payload = raw_payload;
      existing.updated_at = new Date();
    } else {
      dbState.subs.set(key, {
        user_id,
        provider: 'stripe',
        provider_product_id,
        provider_transaction_id,
        status,
        current_period_start,
        current_period_end,
        auto_renew,
        raw_payload,
        updated_at: new Date(),
      });
    }
    return { rows: [], rowCount: 1 };
  }

  // customer.subscription.deleted path — UPDATE ... SET status = 'revoked'.
  if (/^UPDATE subscriptions\s+SET status = 'revoked'/i.test(t)) {
    const subId = params[0] as string;
    const row = dbState.subs.get(subId);
    if (row) {
      row.status = 'revoked';
      row.auto_renew = false;
      row.updated_at = new Date();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // customer.subscription.paused path — UPDATE ... SET status = 'expired'.
  if (/^UPDATE subscriptions\s+SET status = 'expired'/i.test(t)) {
    const subId = params[0] as string;
    const row = dbState.subs.get(subId);
    if (row) {
      row.status = 'expired';
      row.auto_renew = false;
      row.updated_at = new Date();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // invoice.payment_failed path — UPDATE ... SET status = 'in_grace' gated
  // by status NOT IN ('revoked', 'cancelled'). The fake has to honor the
  // same guard to validate the spec's "don't drag a revoked row back" rule.
  if (/^UPDATE subscriptions\s+SET status = 'in_grace'/i.test(t)) {
    const subId = params[0] as string;
    const row = dbState.subs.get(subId);
    if (row && row.status !== 'revoked' && row.status !== 'cancelled') {
      row.status = 'in_grace';
      row.updated_at = new Date();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // ensureTierPersisted does `UPDATE users SET tier = $2 ...` — accept.
  if (/^UPDATE users SET tier/i.test(t)) {
    return { rows: [], rowCount: 1 };
  }

  // currentTier issues two SELECTs against subscriptions + family_members.
  // Both return empty for our test user — we only care about the writes.
  if (/^SELECT[\s\S]+FROM subscriptions/i.test(t)) {
    const userId = params[0] as string;
    const rows = Array.from(dbState.subs.values())
      .filter((r) => r.user_id === userId)
      .sort((a, b) => (a.current_period_end < b.current_period_end ? 1 : -1));
    return { rows: rows.slice(0, 1), rowCount: Math.min(rows.length, 1) };
  }
  if (/^SELECT[\s\S]+FROM family_members/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }

  // syncFamilyPlanSeatsToSubscription writes to family_plans / family_members.
  if (/^INSERT INTO family_plans/i.test(t)) return { rows: [], rowCount: 1 };
  if (/^INSERT INTO family_members/i.test(t)) return { rows: [], rowCount: 0 };

  // Anything else is either unexpected or benign — return an empty rowset
  // rather than throw so a stray query doesn't mask the test we care about.
  return { rows: [], rowCount: 0 };
};

(db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;

// Fake Stripe client. handleStripeEvent only reaches the client via
// stripeClient().subscriptions.retrieve for checkout.session.completed. We
// install a shim that returns whatever the current test seeded.
interface FakeStripe {
  subscriptions: {
    retrieve: (id: string) => Promise<unknown>;
  };
}
let pendingRetrievedSub: unknown = null;
const fakeStripe: FakeStripe = {
  subscriptions: {
    retrieve: async (_id: string) => {
      if (!pendingRetrievedSub) throw new Error('no fake subscription seeded');
      return pendingRetrievedSub;
    },
  },
};
stripeVerify.__setStripeClientForTesting(fakeStripe as unknown as import('stripe').default);

// Helpers that build minimal event + subscription payloads. We only populate
// the fields handleStripeEvent actually reads. If a future edit needs another
// field, add it here rather than inline in a test — keeps the fixtures honest.
const USER_ID = '11111111-2222-3333-4444-555555555555';
const SUB_ID = 'sub_test_123';

function buildSubscription(overrides: {
  status?: string;
  cancel_at_period_end?: boolean;
  current_period_start?: number;
  current_period_end?: number;
  priceId?: string;
  metadataUserId?: string;
} = {}): unknown {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: SUB_ID,
    status: overrides.status ?? 'active',
    cancel_at_period_end: overrides.cancel_at_period_end ?? false,
    current_period_start: overrides.current_period_start ?? now,
    current_period_end: overrides.current_period_end ?? now + 30 * 24 * 3600,
    metadata: { aegisdial_user_id: overrides.metadataUserId ?? USER_ID },
    items: {
      data: [
        {
          current_period_start: overrides.current_period_start ?? now,
          current_period_end: overrides.current_period_end ?? now + 30 * 24 * 3600,
          price: { id: overrides.priceId ?? 'price_test_monthly' },
        },
      ],
    },
  };
}

function buildEvent(type: string, object: unknown, id = 'evt_test_1'): import('stripe').default.Event {
  return {
    id,
    type,
    data: { object },
    // Other Stripe.Event fields the handler never reads — filling with plausible
    // shapes keeps TS happy without pulling in the full type.
    api_version: '2024-11-20.acacia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    object: 'event',
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
  } as unknown as import('stripe').default.Event;
}

before(() => {
  assert.equal(typeof stripeVerify.handleStripeEvent, 'function');
});

beforeEach(() => {
  resetDb();
  pendingRetrievedSub = null;
});

describe('handleStripeEvent — checkout.session.completed', () => {
  it('creates an active subscription row keyed on the Stripe subscription id', async () => {
    pendingRetrievedSub = buildSubscription();
    const event = buildEvent('checkout.session.completed', {
      id: 'cs_test_1',
      client_reference_id: USER_ID,
      subscription: SUB_ID,
      metadata: {},
    });
    await stripeVerify.handleStripeEvent(event, log);

    const row = dbState.subs.get(SUB_ID);
    assert.ok(row, 'expected a subscription row to be written');
    assert.equal(row.user_id, USER_ID);
    assert.equal(row.provider, 'stripe');
    assert.equal(row.status, 'active');
    // Price ID should be translated to the internal catalog SKU so family
    // seat sync + tier derivation treat Stripe + Apple consistently.
    assert.equal(row.provider_product_id, 'com.fortyseven.aegisdial.pro.monthly');
    assert.equal(row.auto_renew, true);
  });

  it('falls back to subscription_data.metadata.aegisdial_user_id when client_reference_id is absent', async () => {
    pendingRetrievedSub = buildSubscription();
    const event = buildEvent('checkout.session.completed', {
      id: 'cs_test_2',
      client_reference_id: null,
      subscription: SUB_ID,
      metadata: { aegisdial_user_id: USER_ID },
    });
    await stripeVerify.handleStripeEvent(event, log);

    const row = dbState.subs.get(SUB_ID);
    assert.ok(row);
    assert.equal(row.user_id, USER_ID);
  });
});

describe('handleStripeEvent — customer.subscription.updated', () => {
  it('flips status from active to cancelled on cancel_at_period_end + canceled', async () => {
    // Seed an active row the way checkout.session.completed would have.
    pendingRetrievedSub = buildSubscription({ status: 'active' });
    await stripeVerify.handleStripeEvent(
      buildEvent('checkout.session.completed', {
        id: 'cs_seed',
        client_reference_id: USER_ID,
        subscription: SUB_ID,
      }),
      log,
    );
    assert.equal(dbState.subs.get(SUB_ID)?.status, 'active');

    // Now fire the update event with a canceled Stripe status.
    const event = buildEvent(
      'customer.subscription.updated',
      buildSubscription({ status: 'canceled', cancel_at_period_end: true }),
      'evt_update_1',
    );
    await stripeVerify.handleStripeEvent(event, log);

    const row = dbState.subs.get(SUB_ID);
    assert.equal(row?.status, 'cancelled');
    assert.equal(row?.auto_renew, false);
  });
});

describe('handleStripeEvent — invoice.payment_failed', () => {
  it("sets status to 'in_grace'", async () => {
    pendingRetrievedSub = buildSubscription({ status: 'active' });
    await stripeVerify.handleStripeEvent(
      buildEvent('checkout.session.completed', {
        id: 'cs_seed',
        client_reference_id: USER_ID,
        subscription: SUB_ID,
      }),
      log,
    );

    const event = buildEvent(
      'invoice.payment_failed',
      { id: 'in_test_1', subscription: SUB_ID },
      'evt_inv_fail_1',
    );
    await stripeVerify.handleStripeEvent(event, log);

    assert.equal(dbState.subs.get(SUB_ID)?.status, 'in_grace');
  });

  it("does not overwrite 'revoked' with 'in_grace' (late retry of a failed invoice)", async () => {
    // Seed + revoke the row (simulates customer.subscription.deleted having
    // arrived first). A stale invoice.payment_failed must not resurrect it.
    pendingRetrievedSub = buildSubscription({ status: 'active' });
    await stripeVerify.handleStripeEvent(
      buildEvent('checkout.session.completed', {
        id: 'cs_seed',
        client_reference_id: USER_ID,
        subscription: SUB_ID,
      }),
      log,
    );
    await stripeVerify.handleStripeEvent(
      buildEvent('customer.subscription.deleted', buildSubscription({ status: 'canceled' }), 'evt_del_1'),
      log,
    );
    assert.equal(dbState.subs.get(SUB_ID)?.status, 'revoked');

    await stripeVerify.handleStripeEvent(
      buildEvent('invoice.payment_failed', { id: 'in_test_2', subscription: SUB_ID }, 'evt_inv_late'),
      log,
    );
    assert.equal(dbState.subs.get(SUB_ID)?.status, 'revoked', 'revoked is terminal');
  });
});

describe('handleStripeEvent — idempotency', () => {
  it('duplicate checkout.session.completed deliveries are a no-op on the second call', async () => {
    pendingRetrievedSub = buildSubscription();
    const event = buildEvent('checkout.session.completed', {
      id: 'cs_test_dup',
      client_reference_id: USER_ID,
      subscription: SUB_ID,
    });
    await stripeVerify.handleStripeEvent(event, log);
    const firstRow = { ...(dbState.subs.get(SUB_ID) as SubRow) };
    assert.equal(dbState.subs.size, 1);

    // Same event shape, redelivered. ON CONFLICT DO UPDATE keeps the row
    // count at one and the status unchanged.
    await stripeVerify.handleStripeEvent(event, log);
    assert.equal(dbState.subs.size, 1, 'no duplicate row');
    const secondRow = dbState.subs.get(SUB_ID);
    assert.equal(secondRow?.status, firstRow.status);
    assert.equal(secondRow?.provider_transaction_id, firstRow.provider_transaction_id);
    assert.equal(secondRow?.user_id, firstRow.user_id);
  });
});

describe('handleStripeEvent — missing attribution', () => {
  it('checkout.session.completed without client_reference_id or metadata does not crash or write', async () => {
    pendingRetrievedSub = buildSubscription();
    const event = buildEvent('checkout.session.completed', {
      id: 'cs_no_user',
      client_reference_id: null,
      subscription: SUB_ID,
      metadata: {},
    });
    // Should log + skip, not throw.
    await stripeVerify.handleStripeEvent(event, log);
    assert.equal(dbState.subs.size, 0, 'no row written without user attribution');
  });

  it('customer.subscription.updated without attribution does not crash or write', async () => {
    const sub = buildSubscription({ metadataUserId: '' });
    // Strip both attribution fields.
    (sub as { metadata: Record<string, string> }).metadata = {};
    const event = buildEvent('customer.subscription.updated', sub, 'evt_upd_no_user');
    await stripeVerify.handleStripeEvent(event, log);
    assert.equal(dbState.subs.size, 0);
  });
});
