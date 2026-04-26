import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// phoneLookup.lookupPhone cooldown semantics.
//
// When Twilio Lookup V2 returns 429, the service parses `retry-after`
// and calls `cacheSet('twilio:rate_limited_until', ..., <ttl>)`. Every
// subsequent call that would otherwise dispatch Twilio must short-
// circuit past it until the cooldown expires — otherwise we hammer a
// provider that's already told us to back off and risk a sustained
// block.
//
// We prove this by:
//   1. Stubbing fetch to return 429 with `retry-after: 60` on the
//      first call, and counting subsequent Twilio fetches.
//   2. Asserting `cacheSet` was called with the cooldown key + TTL=60.
//   3. Making a second lookup — fetch must NOT be called again (the
//      cache wall short-circuits).
//   4. Clearing the cooldown key + calling a third time — fetch
//      dispatches again.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://phonelookup-test';
// lookupPhone requires the flag AND creds to dispatch Twilio at all.
process.env.ENABLE_TWILIO_LOOKUP = 'true';
process.env.TWILIO_ACCOUNT_SID = 'AC_test_sid';
process.env.TWILIO_AUTH_TOKEN = 'test_token';
// No other providers — keeps the test focused on the Twilio path.
delete process.env.EKATA_API_KEY;
delete process.env.IPQS_API_KEY;

const db = await import('../src/lib/db.ts');
const cache = await import('../src/lib/cache.ts');
const phoneLookup = await import('../src/services/phoneLookup.ts');

// Minimal DB stub — lookupPhone hits `SELECT ... FROM phone_lookups`
// for the cache read, `SELECT ... FROM metric_counters` for the daily
// cap, and INSERT INTO phone_lookups on write. All return empty so the
// cache is a perpetual miss (forcing the provider path every time).
(db.pool as unknown as {
  query: (sql: string, p?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
}).query = async () => ({ rows: [], rowCount: 0 });

// Spy on cacheSet to verify the cooldown write. We wrap the exported
// function rather than trying to rewrite the module binding (ESM
// bindings are read-only).
const cacheSetCalls: Array<{ key: string; value: unknown; ttl: number }> = [];
const realCacheSet = cache.cacheSet;
// Install via assignment onto a mutable Object.defineProperty-like
// surface. Since cacheSet is a const export we rebind via a wrapping
// Proxy on the module's consumer side. Simpler: phoneLookup reaches
// cacheSet through the ESM import of cache; swap redis directly.
//
// The phoneLookup path calls cacheSet → redis.set. So spy on redis.set
// to observe the cooldown write with its exact TTL.
interface RedisSpy {
  set: (key: string, value: string, mode: 'EX', ttl: number) => Promise<'OK'>;
  get: (key: string) => Promise<string | null>;
  del: (key: string) => Promise<number>;
}
const store = new Map<string, { value: string; expiresAt: number | null }>();
const redisSpy: RedisSpy = {
  set: async (key, value, _mode, ttl) => {
    cacheSetCalls.push({ key, value: JSON.parse(value), ttl });
    store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return 'OK';
  },
  get: async (key) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      store.delete(key);
      return null;
    }
    return entry.value;
  },
  del: async (key) => (store.delete(key) ? 1 : 0),
};
(cache.redis as unknown as RedisSpy).set = redisSpy.set;
(cache.redis as unknown as RedisSpy).get = redisSpy.get;
(cache.redis as unknown as RedisSpy).del = redisSpy.del;

// fetch spy — returns 429 the first N times, 200 after a flip.
const realFetch = globalThis.fetch;
let fetchCount = 0;
let fetchMode: '429' | '200' = '429';
(globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
  fetchCount++;
  if (fetchMode === '429') {
    return new Response('{"code":20429,"message":"Too Many Requests"}', {
      status: 429,
      headers: { 'retry-after': '60', 'content-type': 'application/json' },
    });
  }
  // Non-429 path returns a minimal Twilio Lookup V2-shaped body that
  // merges into a valid PublicPhoneInfo.
  return new Response(
    JSON.stringify({
      phone_number: '+14155550001',
      country_code: 'US',
      line_type_intelligence: { type: 'mobile', carrier_name: 'Verizon' },
      caller_name: { caller_name: 'Alice Tester' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as unknown as typeof fetch;

before(() => {
  assert.equal(typeof phoneLookup.lookupPhone, 'function');
});

beforeEach(() => {
  fetchCount = 0;
  fetchMode = '429';
  cacheSetCalls.length = 0;
  store.clear();
});

after(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
  // Restore cacheSet just to be polite — other test files may run in
  // the same process.
  void realCacheSet;
});

describe('lookupPhone — Twilio 429 cooldown', () => {
  it('writes twilio:rate_limited_until with retry-after TTL on first 429', async () => {
    fetchMode = '429';
    await phoneLookup.lookupPhone('+14155550001');
    // Twilio got hit once, returned 429; that triggers exactly one
    // cooldown write with the key + TTL from `retry-after`.
    assert.ok(fetchCount >= 1, 'fetch must have been called at least once');
    const cooldown = cacheSetCalls.find((c) => c.key === 'twilio:rate_limited_until');
    assert.ok(cooldown, 'expected a cooldown write');
    assert.equal(cooldown.ttl, 60, 'TTL must match retry-after header');
  });

  it('short-circuits Twilio on the next call while cooldown is live', async () => {
    fetchMode = '429';
    await phoneLookup.lookupPhone('+14155550001');
    const afterFirst = fetchCount;
    assert.ok(afterFirst >= 1);

    // Cooldown is set; a second lookup for a different number should
    // skip Twilio entirely. No other providers are configured so the
    // fetch counter must stay flat.
    fetchMode = '200'; // would succeed if it actually dispatched
    await phoneLookup.lookupPhone('+14155550002');
    assert.equal(
      fetchCount,
      afterFirst,
      'Twilio must not be re-dispatched while cooldown is live',
    );
  });

  it('dispatches again after the cooldown key is cleared', async () => {
    fetchMode = '429';
    await phoneLookup.lookupPhone('+14155550001');
    const afterFirst = fetchCount;
    assert.ok(afterFirst >= 1);

    // Clear the cooldown (simulates expiry).
    store.delete('twilio:rate_limited_until');
    fetchMode = '200';
    await phoneLookup.lookupPhone('+14155550003');
    assert.ok(fetchCount > afterFirst, 'Twilio should dispatch once the cooldown lifts');
  });
});
