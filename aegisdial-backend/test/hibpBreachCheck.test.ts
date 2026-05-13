import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Email Shield — HIBP breach-exposure check.
//
// Coverage matrix:
//   1. No API key → email_checked=false, reason='no_api_key', no fetch
//   2. Invalid email → reason='invalid_email', no fetch
//   3. 404 from HIBP → email_checked=true, breaches=[]
//   4. 200 with 2 breaches → 2 findings, correct field mapping
//   5. One breach has Passwords → high_severity_count=1
//   6. 429 → reason='rate_limited'
//   7. 500 → reason='api_error'
//   8. Cache hit on the second call → fetch invoked exactly once
//   9. most_recent_breach_at = max(BreachDate) across breaches
//
// fetch is stubbed per-test via the `httpFetch` opts override.
// Redis is the in-memory shim activated by REDIS_URL=memory://hibp.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-hibp';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://hibp';
// Set the API key BEFORE the module loads so config picks it up.
// The "no key" test mutates config back to undefined.
process.env.HIBP_API_KEY = 'test-hibp-key-deadbeef';

const { config } = await import('../src/config.ts');
const cache = await import('../src/lib/cache.ts');
const { checkBreachExposure } = await import(
  '../src/services/email/hibpBreachCheck.ts'
);

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

// Mutable shim — every test starts with a fresh map of routes.
type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;
let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
let nextResponse: () => Promise<Response> = async () =>
  new Response('null', { status: 500 });

const stubFetch: FetchStub = async (url, init) => {
  const hdrs: Record<string, string> = {};
  const rawHdrs = init?.headers as Record<string, string> | undefined;
  if (rawHdrs) {
    for (const [k, v] of Object.entries(rawHdrs)) hdrs[k] = String(v);
  }
  fetchCalls.push({ url: String(url), headers: hdrs });
  return nextResponse();
};

// Make a Breach object in HIBP's wire shape.
function hibpBreach(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    Name: 'LinkedIn',
    Domain: 'linkedin.com',
    BreachDate: '2012-05-05',
    AddedDate: '2016-05-21T21:35:40Z',
    PwnCount: 164611595,
    DataClasses: ['Email addresses', 'Passwords'],
    IsVerified: true,
    IsSensitive: false,
    IsRetired: false,
    ...overrides,
  };
}

// Flush the in-memory Redis between tests so cache state doesn't
// leak across cases — particularly important for the cache-hit test
// not to be poisoned by the 200/404 tests above it.
async function resetCache(): Promise<void> {
  // The in-memory client's `quit()` clears its store; re-init by
  // calling del() on the specific test email's key. Simpler: walk
  // the few keys we know we wrote. Also drop any in-flight lock
  // keys so single-flight tests don't bleed across cases.
  const emails = [
    'jesiah@aegisdial.app',
    'mom@example.com',
    'cached@example.com',
    'chrono@example.com',
    'network-throw@example.com',
    'parse-fail@example.com',
    'schema-drift@example.com',
    'single-flight-a@example.com',
    'single-flight-b@example.com',
  ];
  for (const e of emails) {
    await cache.cacheInvalidate('hibp:' + sha(e));
    await cache.cacheInvalidate('hibp:' + sha(e) + ':inflight');
  }
}

// Mirror the cacheKeyFor helper without exporting it from the
// module — emails are lowercase-trimmed before hashing.
function sha(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

beforeEach(async () => {
  fetchCalls = [];
  nextResponse = async () => new Response('null', { status: 500 });
  // Restore the key in case a prior test cleared it.
  (config as { HIBP_API_KEY?: string }).HIBP_API_KEY = 'test-hibp-key-deadbeef';
  await resetCache();
});

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe('hibpBreachCheck', () => {
  it('returns reason_skipped=no_api_key when HIBP_API_KEY is unset, without calling fetch', async () => {
    (config as { HIBP_API_KEY?: string }).HIBP_API_KEY = undefined;

    const result = await checkBreachExposure('jesiah@aegisdial.app', {
      httpFetch: stubFetch,
    });

    assert.equal(result.email_checked, false);
    assert.equal(result.reason_skipped, 'no_api_key');
    assert.deepEqual(result.breaches, []);
    assert.equal(result.high_severity_count, 0);
    assert.equal(fetchCalls.length, 0, 'no fetch may be made without a key');
  });

  it('returns reason_skipped=invalid_email for a malformed address, without calling fetch', async () => {
    const result = await checkBreachExposure('not-an-email-at-all', {
      httpFetch: stubFetch,
    });

    assert.equal(result.email_checked, false);
    assert.equal(result.reason_skipped, 'invalid_email');
    assert.deepEqual(result.breaches, []);
    assert.equal(fetchCalls.length, 0);
  });

  it('treats HIBP 404 as the "clean" signal — email_checked=true, breaches=[]', async () => {
    nextResponse = async () =>
      new Response('Not Found', { status: 404 });

    const result = await checkBreachExposure('jesiah@aegisdial.app', {
      httpFetch: stubFetch,
    });

    assert.equal(result.email_checked, true);
    assert.deepEqual(result.breaches, []);
    assert.equal(result.high_severity_count, 0);
    assert.equal(result.reason_skipped, undefined);
    assert.equal(fetchCalls.length, 1);
    // Verify the request shape — required headers, URL encoded.
    assert.ok(
      fetchCalls[0]!.url.includes('jesiah%40aegisdial.app'),
      'email must be URL-encoded',
    );
    assert.ok(
      fetchCalls[0]!.url.includes('truncateResponse=false'),
      'must request full breach metadata',
    );
    assert.equal(fetchCalls[0]!.headers['hibp-api-key'], 'test-hibp-key-deadbeef');
    assert.ok(
      fetchCalls[0]!.headers['User-Agent']?.includes('AegisDial'),
      'must send AegisDial User-Agent',
    );
  });

  it('maps a 200 response with two breaches into BreachExposureFinding[]', async () => {
    nextResponse = async () =>
      new Response(
        JSON.stringify([
          hibpBreach({
            Name: 'LinkedIn',
            Domain: 'linkedin.com',
            BreachDate: '2012-05-05',
            DataClasses: ['Email addresses'], // no Passwords
          }),
          hibpBreach({
            Name: 'Adobe',
            Domain: 'adobe.com',
            BreachDate: '2013-10-04',
            DataClasses: ['Email addresses', 'Password hints'], // no Passwords
            IsVerified: true,
          }),
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const result = await checkBreachExposure('mom@example.com', {
      httpFetch: stubFetch,
    });

    assert.equal(result.email_checked, true);
    assert.equal(result.breaches.length, 2);
    assert.equal(result.breaches[0]!.breach_name, 'LinkedIn');
    assert.equal(result.breaches[0]!.domain, 'linkedin.com');
    assert.equal(result.breaches[0]!.breach_date, '2012-05-05');
    assert.equal(result.breaches[0]!.is_verified, true);
    assert.deepEqual(result.breaches[0]!.data_classes, ['Email addresses']);
    assert.equal(result.breaches[1]!.breach_name, 'Adobe');
    // Neither breach in this fixture leaked actual Passwords.
    assert.equal(result.high_severity_count, 0);
  });

  it('counts breaches that include "Passwords" in DataClasses as high_severity', async () => {
    nextResponse = async () =>
      new Response(
        JSON.stringify([
          hibpBreach({
            Name: 'LinkedIn',
            DataClasses: ['Email addresses', 'Passwords'], // counts
          }),
          hibpBreach({
            Name: 'NewsletterSpam',
            DataClasses: ['Email addresses'], // does not count
          }),
        ]),
        { status: 200 },
      );

    const result = await checkBreachExposure('mom@example.com', {
      httpFetch: stubFetch,
    });

    assert.equal(result.email_checked, true);
    assert.equal(result.breaches.length, 2);
    assert.equal(result.high_severity_count, 1);
  });

  it('returns reason_skipped=rate_limited on HIBP 429', async () => {
    nextResponse = async () =>
      new Response('Too Many Requests', { status: 429 });

    const result = await checkBreachExposure('mom@example.com', {
      httpFetch: stubFetch,
    });

    assert.equal(result.email_checked, false);
    assert.equal(result.reason_skipped, 'rate_limited');
    assert.deepEqual(result.breaches, []);
    assert.equal(result.high_severity_count, 0);
  });

  it('returns reason_skipped=api_error on HIBP 500', async () => {
    nextResponse = async () =>
      new Response('Internal Server Error', { status: 500 });

    const result = await checkBreachExposure('mom@example.com', {
      httpFetch: stubFetch,
    });

    assert.equal(result.email_checked, false);
    assert.equal(result.reason_skipped, 'api_error');
    assert.deepEqual(result.breaches, []);
  });

  it('caches results — the second call within TTL does not invoke fetch', async () => {
    nextResponse = async () =>
      new Response(
        JSON.stringify([hibpBreach({ Name: 'LinkedIn' })]),
        { status: 200 },
      );

    const first = await checkBreachExposure('cached@example.com', {
      httpFetch: stubFetch,
    });
    assert.equal(first.email_checked, true);
    assert.equal(first.breaches.length, 1);
    assert.equal(fetchCalls.length, 1, 'first call hits HIBP');

    // Second call — cache hit, no fetch.
    const second = await checkBreachExposure('cached@example.com', {
      httpFetch: stubFetch,
    });
    assert.equal(second.email_checked, true);
    assert.equal(second.breaches.length, 1);
    assert.equal(
      fetchCalls.length,
      1,
      'second call must be served from cache (no second fetch)',
    );
    // Same shape — cache round-trips the full result object.
    assert.equal(second.breaches[0]!.breach_name, 'LinkedIn');
  });

  it('computes most_recent_breach_at as the max BreachDate across all breaches', async () => {
    nextResponse = async () =>
      new Response(
        JSON.stringify([
          hibpBreach({ Name: 'LinkedIn', BreachDate: '2012-05-05' }),
          hibpBreach({ Name: 'Ticketmaster', BreachDate: '2024-05-20' }),
          hibpBreach({ Name: 'Adobe', BreachDate: '2013-10-04' }),
        ]),
        { status: 200 },
      );

    const result = await checkBreachExposure('chrono@example.com', {
      httpFetch: stubFetch,
    });

    assert.equal(result.email_checked, true);
    assert.equal(result.breaches.length, 3);
    assert.equal(
      result.most_recent_breach_at,
      '2024-05-20',
      'newest BreachDate wins regardless of array order',
    );
  });

  // ---------------------------------------------------------------
  // Verification-audit follow-ups: failure-mode hardening tests
  // ---------------------------------------------------------------

  it('treats a network-layer throw as api_error and does NOT cache it', async () => {
    nextResponse = async () => {
      throw new Error('ECONNRESET');
    };
    const result = await checkBreachExposure('network-throw@example.com', {
      httpFetch: stubFetch,
    });
    assert.equal(result.email_checked, false);
    assert.equal(result.reason_skipped, 'api_error');
    assert.equal(fetchCalls.length, 1, 'fetch was attempted exactly once');
  });

  it('single-flight: a peer call within the 5s lock window returns rate_limited (does NOT re-hit HIBP)', async () => {
    // Two near-simultaneous calls for the same email on a cold
    // cache. The first acquires the lock and starts the HIBP call;
    // the second sees the lock held and returns rate_limited so we
    // don't burn the HIBP free-tier per-IP rate budget on duplicate
    // work. Adversarial-review (HIGH) fix.
    nextResponse = async () =>
      new Response(JSON.stringify([]), { status: 404 });
    // First call serializes through normally and caches a 404 ('no
    // breaches' result). Lock is released by TTL but cache is now
    // hot — next test of THIS race needs a fresh email.
    const first = await checkBreachExposure('single-flight-a@example.com', {
      httpFetch: stubFetch,
    });
    assert.equal(first.email_checked, true);
    assert.equal(first.breaches.length, 0);

    // Now: force the FIRST call to never return (Promise that hangs)
    // so the lock stays held when we issue the second call.
    let resolveHang: (r: Response) => void = () => {};
    nextResponse = async () =>
      new Promise<Response>((r) => {
        resolveHang = r;
      });
    const slowCall = checkBreachExposure('single-flight-b@example.com', {
      httpFetch: stubFetch,
    });
    // Microtask yield so the first call's `cacheSetNX` lands.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    // Second concurrent call — should return rate_limited.
    const second = await checkBreachExposure('single-flight-b@example.com', {
      httpFetch: stubFetch,
    });
    assert.equal(second.email_checked, false);
    assert.equal(second.reason_skipped, 'rate_limited');
    // Clean up the hanging first call.
    resolveHang(new Response(JSON.stringify([]), { status: 404 }));
    await slowCall;
  });

  it('treats a malformed JSON body as api_error', async () => {
    nextResponse = async () =>
      new Response('not-valid-json-at-all', { status: 200 });
    const result = await checkBreachExposure('parse-fail@example.com', {
      httpFetch: stubFetch,
    });
    assert.equal(result.email_checked, false);
    assert.equal(result.reason_skipped, 'api_error');
  });

  it('treats a 200 with shape-mismatched JSON as api_error (schema drift guard)', async () => {
    // HIBP renames "Name" to "BreachName" in a hypothetical v4
    // API — our Zod schema rejects, we degrade.
    nextResponse = async () =>
      new Response(
        JSON.stringify([{ BreachName: 'LinkedIn', BreachDate: '2012-05-05' }]),
        { status: 200 },
      );
    const result = await checkBreachExposure('schema-drift@example.com', {
      httpFetch: stubFetch,
    });
    assert.equal(result.email_checked, false);
    assert.equal(result.reason_skipped, 'api_error');
  });
});
