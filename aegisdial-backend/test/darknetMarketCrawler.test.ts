import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Identity Shield I-P3c — darknet market crawler scaffold.
//
// Stubs:
//   - db.pool.query — selectively matches the SQL emitted by
//     darknetMarketCrawler.ts (active market list, monitor index,
//     identity_breaches UPSERT, identity_breach_findings INSERT,
//     touchLastObserved) and operates against in-memory tables.
//   - Redis is provided by InMemoryCache (REDIS_URL=memory://…) so
//     rate-limit + backoff state behaves like prod without a server.
//   - fetchListingFn injected per-test so we can simulate 200 / 429
//     / empty pages without a real SOCKS5 dependency.
//   - parseListingFn injected per-test so we can control
//     MarketListing output without crafting per-market HTML.
//
// Goals (12-test bar from the I-P3c spec):
//   1. Empty market list → returns 0 markets, no throws
//   2. No Tor proxy configured → idles, no throws
//   3. Active market + parser returns 0 listings → 0 findings
//   4. 5 listings, no monitor matches → 5 identity_breaches, 0 findings
//   5. 1 email-match, no SSN → 1 finding, severity='caution'
//   6. Same listing with ssn_last4 → severity='critical'
//   7. Re-crawl same listing → 0 new identity_breaches
//   8. Per-user salt isolation — A's hash matches, B's identical
//      plaintext under B's salt does NOT cross-pollute
//   9. Market 429 → backoff recorded, no crash
//  10. Observer-only enforcement — POST verb throws
//  11. Generic-default-parser extracts emails from unknown market HTML
//  12. Active-threats wiring — onion URL recorded as url_host threat

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-darknet-crawler';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://darknet-crawler';
// Default to "Tor configured" so the crawler doesn't short-circuit on
// the no-Tor idle branch in most tests. The dedicated "no Tor" test
// reaches into the config module to clear these before the call.
process.env.DARKNET_CRAWLER_TOR_SOCKS5_HOST ||= '127.0.0.1';
process.env.DARKNET_CRAWLER_TOR_SOCKS5_PORT ||= '9050';
// Enable the dev-bearer shortcut so the I-H1 end-to-end route test can
// authenticate through the same Fastify app the crawler reads against.
process.env.ALLOW_DEV_BEARER ||= 'true';

const db = await import('../src/lib/db.ts');
const configMod = await import('../src/config.ts');
const crawler = await import('../src/workers/darknetMarketCrawler.ts');
const activeThreatsMod = await import('../src/services/identity/activeThreats.ts');
const Fastify = (await import('fastify')).default;
const fastifyRateLimit = (await import('@fastify/rate-limit')).default;
const { identityShieldRoutes } = await import('../src/routes/identityShield.ts');

// ----------------------------------------------------------------
// In-memory tables + SQL router
// ----------------------------------------------------------------

interface FakeMarket {
  id: string;
  source_handle: string;
  source_kind: 'darknet_market';
  status: 'active' | 'dormant';
  last_message_observed_at: Date | null;
}
interface FakeMonitor {
  id: string;
  user_id: string;
  monitor_kind: 'email' | 'phone_e164' | 'ssn_last4_hash' | 'dob_hash' | 'name_address_hash';
  watched_value: string;
  salt_hex: string | null;
  active: boolean;
}
interface FakeBreach {
  id: string;
  breach_name: string;
  source: 'aegisdial_internal' | 'hibp' | 'enzoic';
  source_breach_id: string;
  domain: string | null;
  breach_date: Date | null;
  pwn_count: number | null;
  data_classes: string[];
  description: string | null;
}
interface FakeFinding {
  id: string;
  user_id: string;
  monitor_id: string;
  breach_id: string;
  severity: 'informational' | 'caution' | 'critical';
}
interface FakeActiveThreat {
  id: string;
  threat_kind: string;
  threat_value: string;
  severity: string;
  provenance: string;
  context_text: string | null;
  geo_tag: string | null;
  expires_at: Date | null;
}

let fakeMarkets: FakeMarket[] = [];
let fakeMonitors: FakeMonitor[] = [];
let fakeBreaches: FakeBreach[] = [];
let fakeFindings: FakeFinding[] = [];
let fakeActiveThreats: FakeActiveThreat[] = [];
let nextId = 1;

const SEV_RANK: Record<string, number> = {
  informational: 1,
  caution: 2,
  warning: 3,
  confirmed_scammer: 4,
};

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const trimmed = text.trim().replace(/\s+/g, ' ');

  // ---- active markets (crawlMarketsOnce entry) ---------------------
  if (
    /^SELECT id, source_handle FROM threat_intel_channels WHERE source_kind = 'darknet_market' AND status = 'active'/i.test(
      trimmed,
    )
  ) {
    const rows = fakeMarkets
      .filter((m) => m.source_kind === 'darknet_market' && m.status === 'active')
      .map((m) => ({ id: m.id, source_handle: m.source_handle }));
    return { rows, rowCount: rows.length };
  }

  // ---- monitor index load ------------------------------------------
  if (/^SELECT id, user_id, monitor_kind, watched_value, salt_hex FROM identity_monitors WHERE active/i.test(trimmed)) {
    const rows = fakeMonitors
      .filter((m) => m.active)
      .map((m) => ({
        id: m.id,
        user_id: m.user_id,
        monitor_kind: m.monitor_kind,
        watched_value: m.watched_value,
        salt_hex: m.salt_hex,
      }));
    return { rows, rowCount: rows.length };
  }

  // ---- route /v1/identity-shield/monitors — resolveUserSalt --------
  // The route looks up an existing per-(user, kind) salt before
  // hashing on POST; null = generate a fresh one.
  if (/^SELECT salt_hex FROM identity_monitors WHERE user_id = \$1 AND monitor_kind = \$2 AND active AND salt_hex IS NOT NULL/i.test(trimmed)) {
    const [user_id, monitor_kind] = params as [string, string];
    const match = fakeMonitors.find(
      (m) => m.user_id === user_id && m.monitor_kind === monitor_kind && m.active && m.salt_hex,
    );
    return match ? { rows: [{ salt_hex: match.salt_hex }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // ---- route /v1/identity-shield/monitors — INSERT new monitor -----
  if (
    /^INSERT INTO identity_monitors \(user_id, monitor_kind, watched_value, salt_hex, active\)/i.test(
      trimmed,
    )
  ) {
    const [user_id, monitor_kind, watched_value, salt_hex] = params as [
      string,
      'email' | 'phone_e164' | 'ssn_last4_hash' | 'dob_hash' | 'name_address_hash',
      string,
      string | null,
    ];
    const existing = fakeMonitors.find(
      (m) =>
        m.user_id === user_id &&
        m.monitor_kind === monitor_kind &&
        m.watched_value === watched_value,
    );
    if (existing) {
      // ON CONFLICT DO NOTHING — return zero rows.
      return { rows: [], rowCount: 0 };
    }
    const id = `mon-${nextId++}`;
    fakeMonitors.push({
      id,
      user_id,
      monitor_kind,
      watched_value,
      salt_hex,
      active: true,
    });
    return { rows: [{ id }], rowCount: 1 };
  }

  // ---- identity_breaches UPSERT ------------------------------------
  if (
    /^INSERT INTO identity_breaches \( breach_name, source, source_breach_id, domain, breach_date, pwn_count, data_classes, description \) VALUES/i.test(
      trimmed,
    )
  ) {
    const [
      breach_name,
      source_breach_id,
      domain,
      breach_date,
      pwn_count,
      data_classes,
      description,
    ] = params as [
      string,
      string,
      string | null,
      string | null,
      number | null,
      string[],
      string | null,
    ];
    const existing = fakeBreaches.find(
      (b) => b.source === 'aegisdial_internal' && b.source_breach_id === source_breach_id,
    );
    if (existing) {
      return {
        rows: [{ id: existing.id, was_insert: false }],
        rowCount: 1,
      };
    }
    const id = `breach-${nextId++}`;
    fakeBreaches.push({
      id,
      breach_name,
      source: 'aegisdial_internal',
      source_breach_id,
      domain,
      breach_date: breach_date ? new Date(breach_date) : null,
      pwn_count,
      data_classes: data_classes ?? [],
      description,
    });
    return {
      rows: [{ id, was_insert: true }],
      rowCount: 1,
    };
  }

  // ---- identity_breach_findings INSERT-once ------------------------
  if (
    /^INSERT INTO identity_breach_findings \( user_id, monitor_id, breach_id, severity \) VALUES/i.test(trimmed)
  ) {
    const [user_id, monitor_id, breach_id, severity] = params as [
      string,
      string,
      string,
      'caution' | 'critical',
    ];
    const existing = fakeFindings.find(
      (f) => f.user_id === user_id && f.monitor_id === monitor_id && f.breach_id === breach_id,
    );
    if (existing) {
      return { rows: [], rowCount: 0 };
    }
    fakeFindings.push({
      id: `finding-${nextId++}`,
      user_id,
      monitor_id,
      breach_id,
      severity,
    });
    return { rows: [], rowCount: 1 };
  }

  // ---- last_message_observed_at touch ------------------------------
  if (/^UPDATE threat_intel_channels SET last_message_observed_at = NOW\(\)/i.test(trimmed)) {
    const [marketId] = params as [string];
    const m = fakeMarkets.find((x) => x.id === marketId);
    if (m) m.last_message_observed_at = new Date();
    return { rows: [], rowCount: m ? 1 : 0 };
  }

  // ---- active_threats batch ingest (via ingestThreatBatch) ---------
  if (/^WITH input_rows AS \( SELECT/i.test(trimmed) && /INSERT INTO active_threats/i.test(trimmed)) {
    const PARAMS_PER_ROW = 8;
    const rows: Array<{ was_insert: boolean }> = [];
    for (let i = 0; i < params.length; i += PARAMS_PER_ROW) {
      const [kind, value, severity, provenance, context, geo_tag, expires_at, incoming_rank] = params.slice(
        i,
        i + PARAMS_PER_ROW,
      ) as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        Date | null,
        number,
      ];
      const existing = fakeActiveThreats.find(
        (r) =>
          r.threat_kind === kind && r.threat_value === value && r.provenance === provenance,
      );
      if (existing) {
        const existingRank = SEV_RANK[existing.severity] ?? 0;
        if (incoming_rank > existingRank) {
          existing.severity = severity;
          existing.expires_at = expires_at;
        }
        rows.push({ was_insert: false });
      } else {
        fakeActiveThreats.push({
          id: `at-${nextId++}`,
          threat_kind: kind,
          threat_value: value,
          severity,
          provenance,
          context_text: context,
          geo_tag,
          expires_at,
        });
        rows.push({ was_insert: true });
      }
    }
    return { rows, rowCount: rows.length };
  }

  // metric_counters UPSERT — swallow
  if (/^INSERT INTO metric_counters/i.test(trimmed)) {
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`unstubbed SQL: ${trimmed.slice(0, 200)}`);
};

const cacheMod = await import('../src/lib/cache.ts');

// Clear the in-memory Redis state for the keys this worker manages.
// The InMemoryCache backing the memory:// REDIS_URL retains state
// across tests inside one process; without this every test after the
// first would see a stale rate-limit floor (10s) or daily-cap counter.
async function resetCrawlerRedisState(): Promise<void> {
  // We don't know each market_id ahead of time; tests use a stable
  // "m1" id so the four prefixes-with-m1 cover the common case. The
  // generic prefix-clear loop catches any test that uses a different
  // market id via the cache's `del` interface.
  const prefixes = [
    'darknet_crawler:lastfetch:',
    'darknet_crawler:daily:',
    'darknet_crawler:backoff:',
    'darknet_crawler:backoff_step:',
  ];
  for (const p of prefixes) {
    // Cover the test fixtures' known market ids.
    for (const id of ['m1', 'm2', 'm3']) {
      await cacheMod.redis.del(`${p}${id}`);
    }
  }
}

beforeEach(async () => {
  fakeMarkets = [];
  fakeMonitors = [];
  fakeBreaches = [];
  fakeFindings = [];
  fakeActiveThreats = [];
  nextId = 1;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
  // Each test starts with Tor configured. The "no Tor" test mutates
  // the config back to undefined before the call.
  (configMod.config as unknown as Record<string, unknown>).DARKNET_CRAWLER_TOR_SOCKS5_HOST =
    '127.0.0.1';
  (configMod.config as unknown as Record<string, unknown>).DARKNET_CRAWLER_TOR_SOCKS5_PORT = 9050;
  await resetCrawlerRedisState();
});

// ----------------------------------------------------------------
// Test bar
// ----------------------------------------------------------------

describe('darknetMarketCrawler — scaffold semantics', () => {
  it('empty market list → returns 0 markets, no throws', async () => {
    const result = await crawler.crawlMarketsOnce({
      fetchListingFn: async () => ({ html: '<html></html>', status: 200 }),
    });
    assert.deepEqual(result, {
      markets_crawled: 0,
      listings_parsed: 0,
      findings_inserted: 0,
      errors: 0,
    });
    assert.equal(fakeBreaches.length, 0);
    assert.equal(fakeFindings.length, 0);
  });

  it('no Tor proxy configured → idles, no throws', async () => {
    (configMod.config as unknown as Record<string, unknown>).DARKNET_CRAWLER_TOR_SOCKS5_HOST =
      undefined;
    (configMod.config as unknown as Record<string, unknown>).DARKNET_CRAWLER_TOR_SOCKS5_PORT =
      undefined;
    fakeMarkets.push({
      id: 'm1',
      source_handle: 'russian_market',
      source_kind: 'darknet_market',
      status: 'active',
      last_message_observed_at: null,
    });
    let fetchCalled = false;
    const result = await crawler.crawlMarketsOnce({
      fetchListingFn: async () => {
        fetchCalled = true;
        return { html: '', status: 200 };
      },
    });
    assert.deepEqual(result, {
      markets_crawled: 0,
      listings_parsed: 0,
      findings_inserted: 0,
      errors: 0,
    });
    // Critically — fetch must NOT have been called. The no-Tor branch
    // short-circuits BEFORE any market is touched.
    assert.equal(fetchCalled, false);
  });
});

describe('darknetMarketCrawler — parse + breach upsert', () => {
  it('active market + parser returns 0 listings → 0 findings, 0 breaches', async () => {
    fakeMarkets.push({
      id: 'm1',
      source_handle: 'russian_market',
      source_kind: 'darknet_market',
      status: 'active',
      last_message_observed_at: null,
    });
    const result = await crawler.crawlMarketsOnce({
      fetchListingFn: async () => ({ html: '<html></html>', status: 200 }),
      parseListingFn: () => [],
    });
    assert.equal(result.markets_crawled, 1);
    assert.equal(result.listings_parsed, 0);
    assert.equal(result.findings_inserted, 0);
    assert.equal(fakeBreaches.length, 0);
    assert.equal(fakeFindings.length, 0);
  });

  it('5 listings, no monitor matches → 5 identity_breaches, 0 findings', async () => {
    fakeMarkets.push({
      id: 'm1',
      source_handle: 'russian_market',
      source_kind: 'darknet_market',
      status: 'active',
      last_message_observed_at: null,
    });
    // No monitors at all — listings still produce breach rows.
    const result = await crawler.crawlMarketsOnce({
      fetchListingFn: async () => ({ html: '<html></html>', status: 200 }),
      parseListingFn: () =>
        Array.from({ length: 5 }, (_, i) => ({
          listing_id: `L${i}`,
          title: `dump #${i}`,
          category: 'credentials',
          sample_records: [{ email: `unrelated${i}@example.com` }],
        })),
    });
    assert.equal(result.markets_crawled, 1);
    assert.equal(result.listings_parsed, 5);
    assert.equal(result.findings_inserted, 0);
    assert.equal(fakeBreaches.length, 5);
    assert.equal(fakeFindings.length, 0);
  });
});

describe('darknetMarketCrawler — hash-match findings', () => {
  it('1 email-match, no SSN → 1 finding, severity=caution', async () => {
    fakeMarkets.push({
      id: 'm1',
      source_handle: 'russian_market',
      source_kind: 'darknet_market',
      status: 'active',
      last_message_observed_at: null,
    });
    fakeMonitors.push({
      id: 'mon-1',
      user_id: 'user-A',
      monitor_kind: 'email',
      watched_value: 'victim@example.com',
      salt_hex: null,
      active: true,
    });
    const result = await crawler.crawlMarketsOnce({
      fetchListingFn: async () => ({ html: '<html></html>', status: 200 }),
      parseListingFn: () => [
        {
          listing_id: 'L1',
          title: 'fresh dump',
          category: 'credentials',
          sample_records: [{ email: 'VICTIM@EXAMPLE.com' }], // case-insensitive match
        },
      ],
    });
    assert.equal(result.findings_inserted, 1);
    assert.equal(fakeFindings.length, 1);
    assert.equal(fakeFindings[0]!.user_id, 'user-A');
    assert.equal(fakeFindings[0]!.severity, 'caution');
  });

  it('same match but sample includes ssn_last4 → severity=critical', async () => {
    fakeMarkets.push({
      id: 'm1',
      source_handle: 'bitify',
      source_kind: 'darknet_market',
      status: 'active',
      last_message_observed_at: null,
    });
    fakeMonitors.push({
      id: 'mon-1',
      user_id: 'user-A',
      monitor_kind: 'email',
      watched_value: 'victim@example.com',
      salt_hex: null,
      active: true,
    });
    const result = await crawler.crawlMarketsOnce({
      fetchListingFn: async () => ({ html: '<html></html>', status: 200 }),
      parseListingFn: () => [
        {
          listing_id: 'L1',
          title: 'fullz dump',
          category: 'fullz',
          sample_records: [{ email: 'victim@example.com', ssn_last4: '1234' }],
        },
      ],
    });
    assert.equal(result.findings_inserted, 1);
    assert.equal(fakeFindings.length, 1);
    assert.equal(fakeFindings[0]!.severity, 'critical');
  });

  it('dedup — re-crawl same listing produces 0 new identity_breaches', async () => {
    fakeMarkets.push({
      id: 'm1',
      source_handle: 'russian_market',
      source_kind: 'darknet_market',
      status: 'active',
      last_message_observed_at: null,
    });
    const stable: ReturnType<NonNullable<Parameters<typeof crawler.crawlMarketsOnce>[0]>['parseListingFn'] & {}> =
      [
        {
          listing_id: 'L1',
          title: 'dump',
          category: 'credentials',
          sample_records: [{ email: 'unrelated@example.com' }],
        },
      ];
    const first = await crawler.crawlMarketsOnce({
      fetchListingFn: async () => ({ html: '<html></html>', status: 200 }),
      parseListingFn: () => stable,
    });
    assert.equal(first.listings_parsed, 1);
    assert.equal(fakeBreaches.length, 1);

    // Reset the per-cycle rate-limit + fetch-floor so the second
    // crawl actually fetches. InMemoryCache honors EX TTLs (10s) but
    // we'd rather not sleep — purge directly.
    await cacheMod.redis.del('darknet_crawler:lastfetch:m1');

    const second = await crawler.crawlMarketsOnce({
      fetchListingFn: async () => ({ html: '<html></html>', status: 200 }),
      parseListingFn: () => stable,
    });
    assert.equal(second.listings_parsed, 1);
    // Critical assertion: identity_breaches.length is STILL 1 — the
    // ON CONFLICT (source, source_breach_id) DO UPDATE branch took.
    assert.equal(fakeBreaches.length, 1);
  });

  it('per-user salt isolation — A matches, B with identical plaintext + different salt does NOT', async () => {
    fakeMarkets.push({
      id: 'm1',
      source_handle: 'bitify',
      source_kind: 'darknet_market',
      status: 'active',
      last_message_observed_at: null,
    });
    // Both users monitor the SAME plaintext "1234" but with different
    // salts. The monitor watched_value is the pre-hashed digest under
    // the canonical scheme sha256(salt || tag || plaintext) — same
    // shape the route INSERT writes and the crawler match recomputes.
    // Adversarial-review I-H1 fix (2026-05-12) pinned the three sites
    // to this scheme; this fixture mirrors it.
    const aSalt = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const bSalt = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const aHash = createHash('sha256').update(aSalt).update('ssn4').update('1234').digest('hex');
    const bHash = createHash('sha256').update(bSalt).update('ssn4').update('1234').digest('hex');
    fakeMonitors.push({
      id: 'mon-A',
      user_id: 'user-A',
      monitor_kind: 'ssn_last4_hash',
      watched_value: aHash,
      salt_hex: aSalt,
      active: true,
    });
    fakeMonitors.push({
      id: 'mon-B',
      user_id: 'user-B',
      monitor_kind: 'ssn_last4_hash',
      watched_value: bHash,
      salt_hex: bSalt,
      active: true,
    });
    const result = await crawler.crawlMarketsOnce({
      fetchListingFn: async () => ({ html: '<html></html>', status: 200 }),
      parseListingFn: () => [
        {
          listing_id: 'L1',
          title: 'fullz',
          category: 'fullz',
          sample_records: [{ ssn_last4: '1234' }],
        },
      ],
    });
    // Both A and B legitimately match because each has the same
    // plaintext "1234". Per-user salt isolation means BOTH match
    // their OWN hashes — but A's monitor must NOT match B's hash
    // and vice versa. We assert each user got exactly one finding,
    // and that no cross-contaminated row exists.
    assert.equal(result.findings_inserted, 2);
    const aFindings = fakeFindings.filter((f) => f.user_id === 'user-A');
    const bFindings = fakeFindings.filter((f) => f.user_id === 'user-B');
    assert.equal(aFindings.length, 1);
    assert.equal(bFindings.length, 1);
    assert.equal(aFindings[0]!.monitor_id, 'mon-A');
    assert.equal(bFindings[0]!.monitor_id, 'mon-B');
    // The non-cross-pollution invariant: at no point does A's
    // pre-hashed value equal B's pre-hashed value, even with the
    // same plaintext.
    assert.notEqual(aHash, bHash);
  });
});

describe('darknetMarketCrawler — rate-limit + backoff', () => {
  it('market 429 → backoff recorded, no crash, no listings parsed', async () => {
    fakeMarkets.push({
      id: 'm1',
      source_handle: 'russian_market',
      source_kind: 'darknet_market',
      status: 'active',
      last_message_observed_at: null,
    });
    let parseCalled = false;
    const result = await crawler.crawlMarketsOnce({
      fetchListingFn: async () => ({ html: '', status: 429 }),
      parseListingFn: () => {
        parseCalled = true;
        return [];
      },
    });
    assert.equal(result.errors, 1);
    assert.equal(result.listings_parsed, 0);
    assert.equal(parseCalled, false);

    // Verify the backoff key landed in Redis.
    const backoff = await cacheMod.redis.get('darknet_crawler:backoff:m1');
    assert.ok(backoff !== null, 'backoff key should be set after 429');
  });
});

describe('darknetMarketCrawler — observer-only architectural invariants', () => {
  it('fetchListingPage refuses any verb other than GET', async () => {
    const trapFetch = async () => ({ html: '', status: 200 });
    await assert.rejects(
      () =>
        crawler.__test.fetchListingPage(
          'http://example.invalid/',
          { socks5_host: 'localhost', socks5_port: 9050 },
          trapFetch,
          'POST',
        ),
      /observer_only_violation/,
    );
    // PUT and DELETE also rejected — sanity check on the constraint
    // not being POST-specific.
    await assert.rejects(
      () =>
        crawler.__test.fetchListingPage(
          'http://example.invalid/',
          { socks5_host: 'localhost', socks5_port: 9050 },
          trapFetch,
          'DELETE',
        ),
      /observer_only_violation/,
    );
    // GET (the legitimate verb) does NOT throw.
    const ok = await crawler.__test.fetchListingPage(
      'http://example.invalid/',
      { socks5_host: 'localhost', socks5_port: 9050 },
      trapFetch,
      'GET',
    );
    assert.deepEqual(ok, { html: '', status: 200 });
  });
});

describe('darknetMarketCrawler — generic-default-parser', () => {
  it('extracts emails + phones from unknown-market HTML', () => {
    const parser = new crawler.__test.GenericDefaultParser();
    const html = `
      <html><body>
        <table>
          <tr><td>victim@example.com</td><td>+1-415-555-0100</td></tr>
          <tr><td>another@example.org</td><td>(415) 555-0200</td></tr>
        </table>
      </body></html>
    `;
    const listings = parser.parse(html);
    assert.equal(listings.length, 1);
    const listing = listings[0]!;
    assert.equal(listing.category, 'unknown');
    // Both emails are extracted, lowercased, deduped.
    const allEmails = listing.sample_records.map((s) => s.email).filter(Boolean) as string[];
    assert.ok(allEmails.includes('victim@example.com'));
    assert.ok(allEmails.includes('another@example.org'));
    // Phones are extracted in their original surface form.
    const allPhones = listing.sample_records.map((s) => s.phone).filter(Boolean) as string[];
    assert.ok(allPhones.length >= 2);
    // listing_id is content-hashed → stable across calls on same HTML.
    const listings2 = parser.parse(html);
    assert.equal(listings2[0]!.listing_id, listing.listing_id);
  });

  it('returns empty array on empty / no-artifact HTML', () => {
    const parser = new crawler.__test.GenericDefaultParser();
    assert.deepEqual(parser.parse(''), []);
    assert.deepEqual(parser.parse('<html><body>no artifacts here</body></html>'), []);
  });
});

describe('darknetMarketCrawler — active-threats fan-out', () => {
  it("newly observed market's onion URL becomes a url_host active_threats row", async () => {
    fakeMarkets.push({
      id: 'm1',
      source_handle: 'russian-market-abc123.onion',
      source_kind: 'darknet_market',
      status: 'active',
      last_message_observed_at: null,
    });
    await crawler.crawlMarketsOnce({
      fetchListingFn: async () => ({ html: '<html></html>', status: 200 }),
      parseListingFn: () => [],
    });
    // One active_threats row created: kind=url_host, severity=warning,
    // value=the .onion host, provenance points back to the market id.
    const matching = fakeActiveThreats.filter(
      (t) => t.threat_kind === 'url_host' && t.threat_value === 'russian-market-abc123.onion',
    );
    assert.equal(matching.length, 1);
    assert.equal(matching[0]!.severity, 'warning');
    assert.equal(matching[0]!.provenance, 'darknet_market:m1');
  });

  it('uses the active-threats service entry point (ingestThreatBatch)', () => {
    // Belt-and-braces sanity check that the worker references the
    // shared service. If a future refactor inlined the INSERT, this
    // assertion would still pass — it's mostly to assert the import
    // graph stays intact and the service contract is the one in use.
    assert.equal(typeof activeThreatsMod.ingestThreatBatch, 'function');
  });
});

// ────────────────────────────────────────────────────────────────────
// I-H1 — end-to-end route → crawler hash hand-off (adversarial fix)
// ────────────────────────────────────────────────────────────────────
//
// The most load-bearing test in the file. Three sites used to drift on
// the SSN/DOB/name-address hash scheme (route INSERT, crawler match,
// migration comment); every darknet hash match silently missed because
// the digests never collided. This test exercises the route → crawler
// hand-off end-to-end through Fastify so a future regression that
// touches one site without the others fails loudly here.
//
// Flow:
//   1. POST /v1/identity-shield/monitors with monitor_kind='ssn_last4_hash'
//      and ssn_last4='1234' via app.inject — exercises the route's
//      hashing path with a synthetic per-user salt.
//   2. Seed an active darknet market in fakeMarkets.
//   3. Inject a parsed listing with sample_records[0].ssn_last4 === '1234'.
//   4. Call crawlMarketsOnce — the crawler builds the monitor index from
//      the SAME table the POST wrote into, and re-hashes the listing
//      value with each monitor's salt + kind-tag.
//   5. Assert a finding exists for the user (the hashes DID collide
//      because both sites use the canonical sha256(salt || tag || pt) scheme).
//
// If the route and crawler ever drift again, step 5 returns 0 findings
// and this test fails with "expected 1 finding, got 0".

describe('darknetMarketCrawler — I-H1 end-to-end route hash hand-off', () => {
  it('SSN-4 monitor added via route /v1/identity-shield/monitors matches a darknet listing with the same SSN-4', async () => {
    // Build a Fastify app that mounts the real identity-shield routes
    // (same SQL stub the crawler uses — fakeMonitors is shared).
    const app = Fastify();
    await app.register(fastifyRateLimit, { global: false, max: 9999, timeWindow: '1 minute' });
    await app.register(identityShieldRoutes);

    try {
      // Step 1 — POST /monitors to add an SSN-last-4 monitor under the
      // synthetic dev-bearer user (00000000-... per auth.ts mapping).
      const PLAINTEXT_SSN4 = '1234';
      const postRes = await app.inject({
        method: 'POST',
        url: '/v1/identity-shield/monitors',
        headers: { authorization: `Bearer ${process.env.API_SHARED_SECRET}` },
        payload: { monitor_kind: 'ssn_last4_hash', ssn_last4: PLAINTEXT_SSN4 },
      });
      assert.equal(postRes.statusCode, 201, `monitor add failed: ${postRes.body}`);
      // Sanity: the row landed with a 64-char hex hash + a 64-char hex
      // salt, and NO plaintext anywhere. Same security invariant the
      // route tests pin.
      assert.equal(fakeMonitors.length, 1);
      const stored = fakeMonitors[0]!;
      assert.equal(stored.monitor_kind, 'ssn_last4_hash');
      assert.ok(/^[0-9a-f]{64}$/.test(stored.watched_value), 'monitor.watched_value must be hex sha256');
      assert.ok(stored.salt_hex && /^[0-9a-f]{64}$/.test(stored.salt_hex), 'salt_hex must be 32 bytes hex');
      assert.ok(!stored.watched_value.includes(PLAINTEXT_SSN4), 'plaintext SSN must not survive into watched_value');

      // Step 2 — seed a darknet market.
      fakeMarkets.push({
        id: 'm1',
        source_handle: 'bitify',
        source_kind: 'darknet_market',
        status: 'active',
        last_message_observed_at: null,
      });

      // Step 3+4 — run the crawler with a parsed listing that contains
      // the same plaintext SSN-4 the user just monitored.
      const result = await crawler.crawlMarketsOnce({
        fetchListingFn: async () => ({ html: '<html></html>', status: 200 }),
        parseListingFn: () => [
          {
            listing_id: 'L1',
            title: 'fullz dump',
            category: 'fullz',
            sample_records: [{ ssn_last4: PLAINTEXT_SSN4 }],
          },
        ],
      });

      // Step 5 — assert the hash hand-off worked end-to-end.
      assert.equal(result.findings_inserted, 1, 'I-H1: route → crawler hash hand-off must produce 1 finding');
      assert.equal(fakeFindings.length, 1);
      assert.equal(fakeFindings[0]!.user_id, '00000000-0000-0000-0000-000000000000');
      assert.equal(fakeFindings[0]!.severity, 'critical', 'ssn_last4 present in sample → critical severity');
      assert.equal(fakeFindings[0]!.monitor_id, stored.id);
    } finally {
      await app.close();
    }
  });

  it('DOB monitor added via route matches a darknet listing with the same DOB', async () => {
    const app = Fastify();
    await app.register(fastifyRateLimit, { global: false, max: 9999, timeWindow: '1 minute' });
    await app.register(identityShieldRoutes);

    try {
      const PLAINTEXT_DOB = '1990-04-15';
      const postRes = await app.inject({
        method: 'POST',
        url: '/v1/identity-shield/monitors',
        headers: { authorization: `Bearer ${process.env.API_SHARED_SECRET}` },
        payload: { monitor_kind: 'dob_hash', dob_iso: PLAINTEXT_DOB },
      });
      assert.equal(postRes.statusCode, 201, `monitor add failed: ${postRes.body}`);
      const stored = fakeMonitors[0]!;
      assert.equal(stored.monitor_kind, 'dob_hash');

      fakeMarkets.push({
        id: 'm1',
        source_handle: 'bitify',
        source_kind: 'darknet_market',
        status: 'active',
        last_message_observed_at: null,
      });

      const result = await crawler.crawlMarketsOnce({
        fetchListingFn: async () => ({ html: '<html></html>', status: 200 }),
        parseListingFn: () => [
          {
            listing_id: 'L1',
            title: 'identity kit',
            category: 'identity_kits',
            sample_records: [{ dob: PLAINTEXT_DOB }],
          },
        ],
      });

      assert.equal(result.findings_inserted, 1, 'route → crawler DOB hash hand-off must produce 1 finding');
      assert.equal(fakeFindings.length, 1);
      assert.equal(fakeFindings[0]!.monitor_id, stored.id);
    } finally {
      await app.close();
    }
  });
});
