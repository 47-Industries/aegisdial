import { createHash } from 'crypto';
import cron from 'node-cron';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { redis } from '../lib/cache.js';
import { captureError, emitMetric } from '../lib/observability.js';
import { ingestThreatBatch } from '../services/identity/activeThreats.js';
import type { ThreatInput } from '../services/identity/types.js';

// Identity Shield — darknet market crawler (I-P3c).
//
// Daily Tor-proxied GET of public credential-market listing pages,
// per-listing parse → hash-match against the identity_monitors table,
// fan-out to identity_breaches / identity_breach_findings / active_threats.
// Reads its seed list from threat_intel_channels WHERE
// source_kind='darknet_market' AND status='active'. The table is empty
// on day 1; Jesiah drops the seed list once Hetzner Tor is provisioned.
// Empty table = idle worker (no throws, no errors, no network egress).
//
// ═══════════════════════════════════════════════════════════════════
// OBSERVER-ONLY POSTURE — read before touching anything in this file.
// ═══════════════════════════════════════════════════════════════════
//
// AegisDial is a READ-ONLY observer of public criminal marketplaces.
// Every architectural choice in this file reinforces three invariants:
//
//   1. NO ENGAGEMENT. This worker NEVER posts, NEVER bids, NEVER buys,
//      NEVER creates an account, NEVER pays a vendor-buyer-bond, NEVER
//      sends DMs, NEVER replies on a market forum. It only fetches
//      publicly visible listing pages — what an anonymous browser sees
//      on first load before any auth wall.
//
//   2. NO JS EXECUTION. Plain HTTP/HTML scrapes only. No headless
//      browser, no Puppeteer, no Playwright. JS execution dramatically
//      expands the fingerprinting surface AND opens the door to
//      accidentally "clicking" buttons via misfired client-side
//      handlers — both of which break invariant (1) by accident.
//
//   3. CONSERVATIVE RATE LIMITS. Per market: ≤1 request per 10 seconds
//      AND ≤100 requests per day. The goal is not throughput; the goal
//      is operational longevity. A banned crawler IP costs a Tor exit
//      rotation and a market-level cooldown.
//
// These invariants are mirrored in db/migrations/072 (table header) and
// RECOVERY_AND_IDENTITY_SHIELDS.md §4 "Legal + reputational posture".
// The I-P8 adversarial review verifies the absence of any write surface
// against any market listed in threat_intel_channels — if you add code
// that violates that, the verifier will flag it.
//
// ARCHITECTURAL ENFORCEMENT — read this twice:
//
//   - `fetchListingPage()` is the SOLE doorway to a market. It hard-
//     codes method='GET'; a caller cannot pass a different method
//     through it. The startup self-test asserts this defensively so a
//     future refactor that loosens the constraint logs loudly at boot.
//   - The Tor proxy is injected through `fetchListingFn` — there is
//     no fallback to the bare global fetch in production paths. Dev
//     mode (no Tor env vars) idles the worker entirely instead of
//     trying clearnet.
//   - There is no UPDATE / POST / DELETE path against any URL parsed
//     out of a listing. The crawler reads, hashes, writes to our OWN
//     database. Period.
//
// PROD CUTOVER:
//   The injected default `fetchListingFn` is a stub that returns
//   {html: '', status: 200}. To wire real Tor egress, add
//   socks-proxy-agent as a dependency and replace the default fetcher
//   with a SOCKS5-routed `undici.fetch` (or equivalent). The injection
//   point is unchanged — tests stay deterministic, prod swaps the
//   default. The bun command is:
//     bun add socks-proxy-agent
//   followed by docs/IDENTITY_SHIELD_OPERATOR_RUNBOOK.md's Tor section.
//   Until that's wired the worker scaffold-runs against the stub and
//   processes zero listings even with a populated seed table — exactly
//   the I-P3c scaffold semantics.
//
// ═══════════════════════════════════════════════════════════════════
// HASH-MATCH PIPELINE — also read before touching.
// ═══════════════════════════════════════════════════════════════════
//
// CRITICAL — the matching pipeline never sends listing data outside
// worker memory. The flow:
//
//   1. Load every active identity_monitors row (id, user_id, kind,
//      watched_value, salt_hex) into a per-cycle in-memory map.
//   2. For each parsed listing's sample_records:
//        a. For 'email' / 'phone_e164' monitor kinds — compare the
//           listing's plaintext value DIRECTLY (case-normalized) against
//           the monitor's plaintext watched_value.
//        b. For 'ssn_last4_hash' / 'dob_hash' / 'name_address_hash'
//           kinds — compute sha256(monitor.salt_hex || tag || listing_value)
//           and compare against monitor.watched_value (the pre-hashed
//           digest in identity_monitors).
//
//      CANONICAL HASH SCHEME (load-bearing — must match the route in
//      src/routes/identityShield.ts hashWithSalt and the migration 068
//      comment):
//          digest = sha256( salt_hex || tag || plaintext )
//        where tag ∈ {'ssn4', 'dob', 'na'} discriminates which kind
//        the hash describes — a kind-tag defense so an SSN-4 hash
//        cannot replay against the DOB column even if salts collide.
//        Derived from monitor.monitor_kind:
//          ssn_last4_hash    → 'ssn4'
//          dob_hash          → 'dob'
//          name_address_hash → 'na'
//        Adversarial-review I-H1 fix (2026-05-12): three call sites
//        (route INSERT, crawler match, migration comment) used to drift
//        between two schemes; they are now pinned here. Any future
//        scheme change must touch all three together.
//
//   3. ONLY hits become identity_breach_findings INSERTs.
//
// PER-USER SALT ISOLATION: because the SSN/DOB/name-address kinds hash
// each user's value with that user's OWN salt, a listing's plaintext
// SSN-last-4 will hash differently for each user even if two users
// happen to share the same last 4 digits. The lookup must iterate
// monitors and re-hash per row (NOT compute one canonical hash and
// look it up). The test bar codifies this — user B with identical
// plaintext but a different salt MUST NOT auto-match user A's hash.
//
// We DO NOT ship listing PII to any per-user lookup endpoint — the
// match runs in worker memory and only the per-user finding ID
// surfaces in storage. There is no API surface that accepts listing
// data and returns a per-user "are you in this dump?" answer.

// ───────────────────────────────────────────────────────────────
// Schedule + rate-limit constants
// ───────────────────────────────────────────────────────────────

// Daily crawl. Spread vs identityShieldIngest (03:43 / 04:11) and
// retentionSweeper (04:07) so a single Postgres / Tor blip doesn't
// stack three workers on the same minute.
const DAILY_CRON = '33 2 * * *'; // 02:33 UTC daily

// Hard per-market rate floor. The crawler MAY take longer than 10s
// between fetches (e.g., the index page returned quickly and we don't
// have anything else to do); the floor is "no faster than this".
const MIN_FETCH_INTERVAL_SECONDS = 10;

// Hard per-market daily cap. A market that produced 100 listing
// requests in 24h is at the budget — operator can lift it by tuning
// this constant, but never via per-call override.
const MAX_REQUESTS_PER_MARKET_PER_DAY = 100;

// Backoff ladder. Each consecutive failure (429 / 5xx) doubles the
// next-eligible delay, capped at 24h. A successful fetch resets the
// counter via the cleanupBackoff() path.
const BACKOFF_LADDER_MS = [
  1 * 60 * 60 * 1000,   // 1h
  4 * 60 * 60 * 1000,   // 4h
  24 * 60 * 60 * 1000,  // 24h (cap)
] as const;

// Redis key prefixes — colon-delimited per project convention.
const RL_LAST_FETCH_PREFIX = 'darknet_crawler:lastfetch:';
const RL_DAILY_COUNT_PREFIX = 'darknet_crawler:daily:';
const BACKOFF_KEY_PREFIX = 'darknet_crawler:backoff:';
const BACKOFF_STEP_KEY_PREFIX = 'darknet_crawler:backoff_step:';

// ───────────────────────────────────────────────────────────────
// Type surface
// ───────────────────────────────────────────────────────────────

/**
 * SOCKS5 proxy config for the Tor egress fleet. Injected as a tuple so
 * the production fetcher (post socks-proxy-agent install) builds its
 * agent from the same shape the test stubs receive.
 */
export interface TorProxyConfig {
  socks5_host: string;
  socks5_port: number;
}

export interface CrawlerHandle {
  crawlTask: cron.ScheduledTask;
}

/**
 * Parsed market listing. The shape is intentionally narrow — only the
 * fields we actually match against identity_monitors. New fields go in
 * a sample_records sub-object so the parser interface stays stable.
 *
 * sample_records carries the "first-N-rows" preview that markets
 * publicly display to advertise their dumps. We NEVER pay to unlock
 * the full record set — see observer-only posture.
 */
export interface MarketListing {
  /** Market's own listing id. Used as the dedup key in identity_breaches.source_breach_id (with the market_id prefix). */
  listing_id: string;
  /** Short title (e.g., "FRESH ATT 2024 — 12M lines"). */
  title: string;
  /** Free-form category vocabulary maintained by each parser. */
  category: string;
  /** Total record count claimed by the listing. */
  record_count?: number;
  /** Publicly-displayed preview rows. Bounded — markets show ≤5 rows pre-purchase. */
  sample_records: Array<{
    email?: string;
    phone?: string;
    ssn_last4?: string;
    /** ISO date if the listing displays a DOB column; otherwise omitted. */
    dob?: string;
  }>;
  /** Listing's own claim of the source breach (e.g., "ATT 2024"). Free-form. */
  source_breach_claimed?: string;
  /** When the market says it was listed (per-parser interpretation of their date format). */
  listed_at?: Date;
  /** Asking price in USD if displayed; otherwise omitted. */
  price_usd?: number;
}

/** Per-market HTML parser. Stub-impls per known market live below. */
interface MarketParser {
  parse(html: string): MarketListing[];
}

/** Fetch signature exposed for test injection. Hard-coded GET-only. */
type FetchListingFn = (
  url: string,
  proxy: TorProxyConfig,
) => Promise<{ html: string; status: number }>;

/** Parse signature exposed for test injection. */
type ParseListingFn = (html: string) => MarketListing[];

/** In-memory monitor index built once per crawl cycle. */
interface MonitorIndex {
  emails: Map<string, Array<{ id: string; user_id: string }>>;
  phones: Map<string, Array<{ id: string; user_id: string }>>;
  /** Hash-kind monitors carry their per-user salt for lazy per-listing hashing. */
  ssnLast4: Array<{ id: string; user_id: string; salt_hex: string; watched_hash: string }>;
  dob: Array<{ id: string; user_id: string; salt_hex: string; watched_hash: string }>;
}

// ───────────────────────────────────────────────────────────────
// Observer-only HTTP wrapper — the ONE doorway to any market
// ───────────────────────────────────────────────────────────────

/**
 * The single fetch path against a market. Hard-coded GET. Any future
 * code that needs to reach a market goes through THIS function and
 * cannot smuggle a different HTTP verb past it — the `method` param is
 * not exposed and not mutable from the caller side.
 *
 * The actual network egress is delegated to `fetchFn` (injected). The
 * default stub returns empty HTML so a dev box with no Tor configured
 * processes zero listings even against a populated seed table — that
 * is the I-P3c scaffold-on-empty-table semantics.
 *
 * The pseudo-method param exists ONLY to power the observer-only self-
 * test: callers can pass `_unsafeMethod` in tests to verify that the
 * wrapper throws on anything other than 'GET'. Production never calls
 * with this argument.
 */
async function fetchListingPage(
  url: string,
  proxy: TorProxyConfig,
  fetchFn: FetchListingFn,
  _unsafeMethod?: string,
): Promise<{ html: string; status: number }> {
  // Defense-in-depth: a future code change that accidentally exposes
  // method='POST' (or 'DELETE' etc.) trips this throw. The startup
  // self-test (selfTestObserverOnly) exercises this branch on every
  // worker boot so any regression surfaces in logs immediately.
  if (_unsafeMethod !== undefined && _unsafeMethod !== 'GET') {
    throw new Error(
      `observer_only_violation: fetchListingPage only allows GET, received ${_unsafeMethod}`,
    );
  }
  return fetchFn(url, proxy);
}

/**
 * Default fetch stub. Production replaces this with a SOCKS5-proxied
 * undici.fetch after `bun add socks-proxy-agent`. The stub returns
 * `{html: '', status: 200}` so the crawl cycle treats every fetch as
 * a successful zero-listing page — which means the entire scaffold
 * runs end-to-end against a populated seed table without ever touching
 * the actual network. Same defense-in-depth as the no-Tor-config
 * idle branch.
 */
const stubFetchListingFn: FetchListingFn = async (_url, _proxy) => {
  return { html: '', status: 200 };
};

// ───────────────────────────────────────────────────────────────
// Per-market HTML parsers (stubs)
// ───────────────────────────────────────────────────────────────
//
// Each parser corresponds to one market's listing-index HTML shape.
// Initial impls return `[]` because we won't have ground-truth HTML
// until Jesiah confirms the seed list AND the operator runbook walks
// through a manual one-time visit (via Tor, observer-only) to capture
// fixture HTML. Once that fixture exists, the corresponding parser's
// `parse()` gets fleshed out with cheerio-based selectors (TODO
// comments mark each).
//
// PARSER OUTPUT CONTRACT:
//   - Return MarketListing[] — empty array on "no listings on page".
//   - Per listing, populate sample_records with whatever the market
//     publicly displays (typically 1–5 redacted rows). NEVER attempt
//     to unmask redacted fields.
//   - NEVER make additional HTTP requests from inside a parser; the
//     fetchListingPage doorway is the only egress.

class RussianMarketParser implements MarketParser {
  // TODO(prod): hydrate from fixture once Tor proxy + Jesiah's manual
  // fixture-capture pass lands. Listing rows on russian-market live
  // under a <table class="listings"> with columns:
  //   [id, source_breach, record_count, sample_emails, date, price].
  parse(_html: string): MarketListing[] {
    return [];
  }
}

class BriansClubParser implements MarketParser {
  // TODO(prod): hydrate from fixture. BriansClub displays CC dumps
  // (cc_dumps category), not credential dumps — sample_records will
  // only ever carry partial card metadata, never emails/phones/SSN.
  // The hash-match pipeline routes those listings to active_threats
  // (crypto_wallet kind if a payment wallet is displayed) rather than
  // identity_breach_findings.
  parse(_html: string): MarketListing[] {
    return [];
  }
}

class TwoEasyParser implements MarketParser {
  // TODO(prod): hydrate from fixture. 2easy's "bot" listings include
  // a sample_emails column displayed pre-purchase — that's the field
  // we hash-match.
  parse(_html: string): MarketListing[] {
    return [];
  }
}

class BitifyParser implements MarketParser {
  // TODO(prod): hydrate from fixture. Bitify carries the most
  // identity-rich listings (fullz + identity_kits categories). Sample
  // rows include email + phone + ssn_last4 + dob; the parser
  // populates all four fields on each sample_records entry.
  parse(_html: string): MarketListing[] {
    return [];
  }
}

/**
 * Fallback parser used against any market without a hand-tuned parser.
 * Conservative — regex-extracts emails and US E.164 phones from the
 * page text and emits a single MarketListing with category='unknown'
 * and listing_id = sha256 of the input HTML (so dedup works across
 * re-crawls of an unchanged page).
 *
 * Does NOT attempt to extract SSN or DOB — pattern-matching on 4-digit
 * sequences is too lossy and would flood the findings table with
 * false-positive hash collisions.
 */
class GenericDefaultParser implements MarketParser {
  parse(html: string): MarketListing[] {
    if (!html || html.length === 0) return [];
    // Cheap shape gates. Both regexes are anchored on word boundaries
    // so noisy HTML attributes (e.g., 'mailto:' prefixes) don't double-
    // count. The email regex permits a single dot before TLD and a
    // dotless local part, which is the realistic shape for credential-
    // dump previews.
    const emails = Array.from(
      new Set(
        (
          html.match(
            /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
          ) ?? []
        ).map((e) => e.toLowerCase()),
      ),
    );
    // US-ish E.164: optional +1, then 10 digits, with separators
    // tolerated. Normalization happens later via the active-threats
    // service's normalizer; here we just extract.
    const phones = Array.from(
      new Set(
        (
          html.match(
            /\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g,
          ) ?? []
        ),
      ),
    );

    if (emails.length === 0 && phones.length === 0) return [];

    const samples: MarketListing['sample_records'] = [];
    // Cap to 50 per listing — generic-parser pages are typically index
    // dumps with hundreds of artifacts; we sample defensively to keep
    // the hash-match cost bounded.
    const cappedEmails = emails.slice(0, 50);
    const cappedPhones = phones.slice(0, 50);
    const maxLen = Math.max(cappedEmails.length, cappedPhones.length);
    for (let i = 0; i < maxLen; i++) {
      samples.push({
        email: cappedEmails[i],
        phone: cappedPhones[i],
      });
    }

    return [
      {
        // Content-hash the input so the same HTML on a re-crawl
        // dedups cleanly. Different HTML → different listing_id.
        listing_id: createHash('sha256').update(html).digest('hex').slice(0, 32),
        title: '[generic-parser extraction]',
        category: 'unknown',
        sample_records: samples,
      },
    ];
  }
}

// Parser registry. The lookup key is threat_intel_channels.source_handle
// (i.e., the market's .onion hostname). Unknown handles fall back to
// the generic parser.
const PARSERS_BY_HANDLE: Record<string, MarketParser> = {
  // Handles are placeholders — Jesiah's seed list confirms the actual
  // .onion hostnames tomorrow. Each handle here MUST also appear in
  // the threat_intel_channels table with source_kind='darknet_market'.
  russian_market: new RussianMarketParser(),
  brians_club: new BriansClubParser(),
  '2easy': new TwoEasyParser(),
  bitify: new BitifyParser(),
};
const GENERIC_PARSER = new GenericDefaultParser();

function parserFor(sourceHandle: string): MarketParser {
  // Match by exact handle first; fall back to the generic parser. The
  // exact-match-first ordering lets new markets be added to the
  // seed table BEFORE their parser ships — the generic parser will
  // produce best-effort findings until the hand-tuned parser exists.
  return PARSERS_BY_HANDLE[sourceHandle] ?? GENERIC_PARSER;
}

// ───────────────────────────────────────────────────────────────
// Rate-limit + backoff state (Redis-backed)
// ───────────────────────────────────────────────────────────────

/**
 * Has the per-market backoff window elapsed? Returns false (not yet)
 * when a previous 429/5xx parked the market. The backoff key carries
 * a TTL — once it expires the market is eligible again.
 */
async function isInBackoff(marketId: string): Promise<boolean> {
  const raw = await redis.get(`${BACKOFF_KEY_PREFIX}${marketId}`);
  return raw !== null;
}

/**
 * Advance the backoff ladder by one step. Each consecutive failure
 * picks the next rung; we never go past the cap (24h).
 */
async function escalateBackoff(marketId: string): Promise<void> {
  const stepKey = `${BACKOFF_STEP_KEY_PREFIX}${marketId}`;
  const rawStep = await redis.get(stepKey);
  const currentStep = rawStep ? parseInt(rawStep, 10) : 0;
  const nextStep = Math.min(currentStep + 1, BACKOFF_LADDER_MS.length - 1);
  const ttlMs = BACKOFF_LADDER_MS[nextStep] ?? BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1]!;
  const ttlSeconds = Math.ceil(ttlMs / 1000);
  await redis.set(`${BACKOFF_KEY_PREFIX}${marketId}`, '1', 'EX', ttlSeconds);
  // Step key carries a slightly longer TTL than the backoff itself so
  // a market that fails again right after the backoff expires picks up
  // the ladder from where it left off rather than resetting.
  await redis.set(stepKey, String(nextStep), 'EX', ttlSeconds * 2);
  void emitMetric('identity_shield.darknet_market_backoff', {
    market_id: marketId,
    step: String(nextStep),
    ttl_seconds: String(ttlSeconds),
  });
}

/**
 * A successful fetch clears the backoff step counter. The current
 * backoff key (if any) lives out its TTL naturally — we don't DEL it
 * because doing so would let a flaky market re-enter at step 0 instead
 * of cooling down properly.
 */
async function clearBackoffStep(marketId: string): Promise<void> {
  await redis.del(`${BACKOFF_STEP_KEY_PREFIX}${marketId}`);
}

/**
 * Min-interval rate floor. Returns false (not yet eligible) when the
 * last fetch was within MIN_FETCH_INTERVAL_SECONDS. The lastfetch key
 * itself carries a TTL = MIN_FETCH_INTERVAL_SECONDS so it auto-evicts
 * once the floor has elapsed.
 */
async function withinFetchFloor(marketId: string): Promise<boolean> {
  const raw = await redis.get(`${RL_LAST_FETCH_PREFIX}${marketId}`);
  return raw !== null;
}

async function markFetched(marketId: string): Promise<void> {
  await redis.set(
    `${RL_LAST_FETCH_PREFIX}${marketId}`,
    String(Date.now()),
    'EX',
    MIN_FETCH_INTERVAL_SECONDS,
  );
}

/**
 * Per-day request counter. Increments atomically (incrWithTtl: counter
 * + 24h TTL on first incr). Returns the new count so the caller can
 * gate further fetches when it crosses the daily cap.
 */
async function incrDailyCount(marketId: string): Promise<number> {
  // TTL is 24h from the FIRST request of the day. A market that was
  // dormant yesterday and starts fetching at noon today resets at
  // noon tomorrow — that's fine for our purposes (the cron is daily
  // and we want a rolling 24h cap, not a midnight-aligned one).
  return redis.incrWithTtl(`${RL_DAILY_COUNT_PREFIX}${marketId}`, 24 * 60 * 60);
}

// ───────────────────────────────────────────────────────────────
// Monitor index builder
// ───────────────────────────────────────────────────────────────

/**
 * Load every active monitor once per crawl cycle. The cycle is daily,
 * so a single SELECT against `identity_monitors WHERE active` carries
 * a bounded cost even at 100k+ users (the table is small relative to
 * call_sessions / transcript_events).
 *
 * Plaintext kinds (email, phone) are bucketed by normalized value for
 * O(1) lookup. Hash kinds carry their per-user salt + pre-computed
 * digest; the per-listing-sample loop hashes the listing's plaintext
 * once per matching monitor (cheap — sha256 is microseconds and the
 * hash-kind monitor count is small).
 */
async function loadMonitorIndex(): Promise<MonitorIndex> {
  const index: MonitorIndex = {
    emails: new Map(),
    phones: new Map(),
    ssnLast4: [],
    dob: [],
  };
  try {
    const res = await query<{
      id: string;
      user_id: string;
      monitor_kind: 'email' | 'phone_e164' | 'ssn_last4_hash' | 'dob_hash' | 'name_address_hash';
      watched_value: string;
      salt_hex: string | null;
    }>(
      `SELECT id, user_id, monitor_kind, watched_value, salt_hex
         FROM identity_monitors
        WHERE active`,
    );
    for (const row of res.rows) {
      switch (row.monitor_kind) {
        case 'email': {
          const key = row.watched_value.toLowerCase();
          const bucket = index.emails.get(key) ?? [];
          bucket.push({ id: row.id, user_id: row.user_id });
          index.emails.set(key, bucket);
          break;
        }
        case 'phone_e164': {
          // Normalize to digits-only for tolerant matching against
          // listing previews that drop the '+' prefix.
          const key = row.watched_value.replace(/\D+/g, '');
          const bucket = index.phones.get(key) ?? [];
          bucket.push({ id: row.id, user_id: row.user_id });
          index.phones.set(key, bucket);
          break;
        }
        case 'ssn_last4_hash':
          if (row.salt_hex) {
            index.ssnLast4.push({
              id: row.id,
              user_id: row.user_id,
              salt_hex: row.salt_hex,
              watched_hash: row.watched_value,
            });
          }
          break;
        case 'dob_hash':
          if (row.salt_hex) {
            index.dob.push({
              id: row.id,
              user_id: row.user_id,
              salt_hex: row.salt_hex,
              watched_hash: row.watched_value,
            });
          }
          break;
        case 'name_address_hash':
          // Markets don't reliably publish name+address pairs in the
          // pre-purchase preview row — when one does we'll add a fourth
          // bucket here. For now we skip the kind so it doesn't show up
          // as a false-positive against listing data shaped differently
          // (e.g., a literal "first|last|street|zip" string in a forum
          // post that wasn't actually composite-PII).
          break;
      }
    }
  } catch (err) {
    captureError(err, { component: 'darknetMarketCrawler.loadMonitorIndex' });
  }
  return index;
}

/**
 * Hash one (salt, tag, plaintext) → hex digest. CANONICAL SCHEME pinned
 * by db/migrations/068_identity_monitors.sql + src/routes/identityShield.ts
 * + this file:
 *
 *     digest = sha256( salt_hex || tag || plaintext )
 *
 * `tag` discriminates which kind the hash describes — an attacker who
 * somehow gets an SSN-4 digest cannot replay it against the DOB column
 * because the tag bytes are mixed into the hashed payload. Per-call-
 * site, the tag is derived from monitor_kind:
 *   ssn_last4_hash    → 'ssn4'
 *   dob_hash          → 'dob'
 *   name_address_hash → 'na'
 *
 * NOTE — adversarial-review I-H1 fix (2026-05-12): this function used to
 * compute sha256(plaintext || salt_hex) WITHOUT a kind-tag, which never
 * matched the route's INSERT scheme. Every darknet hash match silently
 * missed in the prior shape. The route, the crawler, and the migration
 * comment now all reference the SAME scheme; any future change must
 * touch the three together or the route → crawler hand-off breaks again.
 */
function hashWithSalt(saltHex: string, tag: 'ssn4' | 'dob' | 'na', plaintext: string): string {
  return createHash('sha256').update(saltHex).update(tag).update(plaintext).digest('hex');
}

// ───────────────────────────────────────────────────────────────
// Findings / breach / threat fan-out
// ───────────────────────────────────────────────────────────────

/**
 * UPSERT the per-listing identity_breaches row. Returns the row id
 * and a was_insert flag — was_insert=true is the signal to also fan
 * out to active_threats (the market's onion URL becomes a `url_host`
 * threat) and to count toward the findings_inserted metric.
 *
 * source is 'aegisdial_internal' because the identity_breaches table's
 * CHECK constraint (migration 069) only allows 'hibp' | 'enzoic' |
 * 'aegisdial_internal'. Darknet observations are AegisDial's own
 * internal feed by that vocabulary — the provenance string carries the
 * market_id + listing_id detail for downstream attribution.
 */
async function upsertBreachForListing(
  marketId: string,
  sourceHandle: string,
  listing: MarketListing,
): Promise<{ id: string; was_insert: boolean } | null> {
  try {
    const sourceBreachId = `darknet_market:${marketId}:${listing.listing_id}`;
    const breachName = listing.source_breach_claimed
      ? `${sourceHandle}: ${listing.source_breach_claimed}`
      : `${sourceHandle}: ${listing.title}`;
    const res = await query<{ id: string; was_insert: boolean }>(
      `INSERT INTO identity_breaches (
         breach_name, source, source_breach_id,
         domain, breach_date, pwn_count, data_classes, description
       ) VALUES (
         $1, 'aegisdial_internal', $2,
         $3, $4::date, $5, $6, $7
       )
       ON CONFLICT (source, source_breach_id) DO UPDATE
         SET synced_at = NOW()
       RETURNING id, (xmax = 0) AS was_insert`,
      [
        breachName.slice(0, 500),
        sourceBreachId,
        sourceHandle,
        listing.listed_at ? listing.listed_at.toISOString().slice(0, 10) : null,
        listing.record_count ?? null,
        deriveDataClasses(listing),
        listing.title.slice(0, 1000),
      ],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { id: row.id, was_insert: row.was_insert };
  } catch (err) {
    captureError(err, {
      component: 'darknetMarketCrawler.upsertBreachForListing',
      market_id: marketId,
      listing_id: listing.listing_id,
    });
    return null;
  }
}

/**
 * Derive HIBP-style data_classes from a listing's sample shape. The
 * vocabulary mirrors identity_breaches.data_classes conventions
 * (migration 069 header). Used both for catalog metadata AND for
 * severity computation downstream (Passwords/SSN → critical).
 */
function deriveDataClasses(listing: MarketListing): string[] {
  const classes = new Set<string>();
  for (const s of listing.sample_records) {
    if (s.email) classes.add('Email addresses');
    if (s.phone) classes.add('Phone numbers');
    if (s.ssn_last4) classes.add('Social security numbers');
    if (s.dob) classes.add('Dates of birth');
  }
  // Category-based hints. The carding / cc_dumps categories never
  // expose SSN/DOB but DO imply credential-tier exposure; we add a
  // 'Credit cards' class so the iOS finding card renders accurately.
  if (listing.category === 'cc_dumps' || listing.category === 'carding') {
    classes.add('Credit card information');
  }
  if (listing.category === 'fullz' || listing.category === 'identity_kits') {
    classes.add('Social security numbers');
    classes.add('Dates of birth');
  }
  return Array.from(classes);
}

/**
 * INSERT one finding ON CONFLICT DO NOTHING. Returns true on fresh
 * insert. Severity is computed from the listing's exposed fields —
 * SSN/DOB presence forces 'critical', anything else stays at 'caution'.
 */
async function insertFindingIfNew(args: {
  user_id: string;
  monitor_id: string;
  breach_id: string;
  severity: 'caution' | 'critical';
}): Promise<boolean> {
  try {
    const res = await query(
      `INSERT INTO identity_breach_findings (
         user_id, monitor_id, breach_id, severity
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, monitor_id, breach_id) DO NOTHING`,
      [args.user_id, args.monitor_id, args.breach_id, args.severity],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    captureError(err, {
      component: 'darknetMarketCrawler.insertFindingIfNew',
      user_id: args.user_id,
    });
    return false;
  }
}

// ───────────────────────────────────────────────────────────────
// Per-listing match → findings + threats
// ───────────────────────────────────────────────────────────────

/**
 * Run the hash-match pipeline against ONE listing's sample_records.
 * Returns the count of NEW findings inserted (idempotent re-discovery
 * counts as zero).
 *
 * Severity decision: any sample_record with ssn_last4 OR dob present
 * promotes the finding to 'critical'. Pure email/phone matches stay
 * at 'caution'.
 */
async function matchListingAgainstMonitors(
  breachId: string,
  listing: MarketListing,
  index: MonitorIndex,
): Promise<number> {
  // Compute the per-listing severity gate ONCE. A single critical
  // sample inside the listing escalates all matched findings from
  // this listing — the rationale being that if this listing exposes
  // ANYONE's SSN, the breach itself is critical-tier and any user
  // matched by email/phone deserves the same urgency in their alert.
  const listingHasCriticalClass = listing.sample_records.some(
    (s) => s.ssn_last4 !== undefined || s.dob !== undefined,
  );
  const severity: 'caution' | 'critical' = listingHasCriticalClass ? 'critical' : 'caution';

  // Track unique (monitor_id) wins so multiple sample-row matches
  // against the same monitor produce ONE finding (not N).
  const matchedMonitorIds = new Set<string>();

  for (const sample of listing.sample_records) {
    // ---- plaintext email match -----------------------------------
    if (sample.email) {
      const key = sample.email.toLowerCase();
      const bucket = index.emails.get(key);
      if (bucket) {
        for (const m of bucket) matchedMonitorIds.add(`${m.id}|${m.user_id}`);
      }
    }

    // ---- plaintext phone match -----------------------------------
    if (sample.phone) {
      const key = sample.phone.replace(/\D+/g, '');
      if (key.length > 0) {
        const bucket = index.phones.get(key);
        if (bucket) {
          for (const m of bucket) matchedMonitorIds.add(`${m.id}|${m.user_id}`);
        }
        // Also try the +1-prefixed shape (US-default normalization)
        // in case the monitor stored '+1XXXXXXXXXX' but the listing
        // showed just 10 digits.
        if (key.length === 10) {
          const us = `1${key}`;
          const bucketUs = index.phones.get(us);
          if (bucketUs) {
            for (const m of bucketUs) matchedMonitorIds.add(`${m.id}|${m.user_id}`);
          }
        }
      }
    }

    // ---- hash-match: SSN last-4 ----------------------------------
    if (sample.ssn_last4) {
      // PER-USER SALT ISOLATION: hash the listing's plaintext with
      // EACH user's own salt (+ the kind-tag 'ssn4'). User A's monitor
      // hash and User B's monitor hash are different even when both
      // monitors track the same 4-digit string — exactly what we want,
      // because sha256(A.salt || 'ssn4' || value) ≠ sha256(B.salt ||
      // 'ssn4' || value). The test bar codifies this.
      //
      // CRITICAL — the tag bytes are the I-H1 adversarial-review fix.
      // Without them this site computed a different digest than the
      // route's INSERT path; every SSN match silently missed.
      for (const m of index.ssnLast4) {
        const candidateHash = hashWithSalt(m.salt_hex, 'ssn4', sample.ssn_last4);
        if (candidateHash === m.watched_hash) {
          matchedMonitorIds.add(`${m.id}|${m.user_id}`);
        }
      }
    }

    // ---- hash-match: DOB -----------------------------------------
    if (sample.dob) {
      // Same kind-tag discipline as the SSN branch — tag bytes 'dob'
      // mixed into the hashed payload pin the digest to the DOB column.
      for (const m of index.dob) {
        const candidateHash = hashWithSalt(m.salt_hex, 'dob', sample.dob);
        if (candidateHash === m.watched_hash) {
          matchedMonitorIds.add(`${m.id}|${m.user_id}`);
        }
      }
    }
  }

  let newFindings = 0;
  for (const composite of matchedMonitorIds) {
    const [monitorId, userId] = composite.split('|');
    if (!monitorId || !userId) continue;
    const inserted = await insertFindingIfNew({
      user_id: userId,
      monitor_id: monitorId,
      breach_id: breachId,
      severity,
    });
    if (inserted) {
      newFindings++;
      void emitMetric('identity_shield.darknet_match_found', {
        severity,
      });
    }
  }
  return newFindings;
}

// ───────────────────────────────────────────────────────────────
// Per-market crawl
// ───────────────────────────────────────────────────────────────

interface ActiveMarketRow {
  id: string;
  source_handle: string;
}

/**
 * Crawl one market end-to-end:
 *   1. Backoff gate.
 *   2. Daily-cap gate.
 *   3. Min-interval gate.
 *   4. fetchListingPage (single GET).
 *   5. Parse to MarketListing[].
 *   6. Per listing: upsert identity_breaches, match against monitors.
 *   7. Fan out the market's onion URL to active_threats (once).
 *
 * Returns per-market counters for the crawl-cycle summary.
 */
async function crawlOneMarket(args: {
  market: ActiveMarketRow;
  proxy: TorProxyConfig;
  index: MonitorIndex;
  fetchListingFn: FetchListingFn;
  parseListingFn?: ParseListingFn;
}): Promise<{ listings_parsed: number; findings_inserted: number; errors: number; skipped: boolean }> {
  const { market, proxy, index, fetchListingFn, parseListingFn } = args;

  if (await isInBackoff(market.id)) {
    return { listings_parsed: 0, findings_inserted: 0, errors: 0, skipped: true };
  }
  if (await withinFetchFloor(market.id)) {
    return { listings_parsed: 0, findings_inserted: 0, errors: 0, skipped: true };
  }
  const dailyCount = await incrDailyCount(market.id);
  if (dailyCount > MAX_REQUESTS_PER_MARKET_PER_DAY) {
    return { listings_parsed: 0, findings_inserted: 0, errors: 0, skipped: true };
  }

  // Build the index page URL from the market's .onion hostname.
  // Markets vary in their listing-index path; we use '/' as the
  // conservative default and let the per-market parser deal with the
  // shape it gets. Once Jesiah confirms per-market paths the parser
  // implementations can each carry their own index endpoint.
  const url = `http://${market.source_handle}/`;

  let res: { html: string; status: number };
  try {
    res = await fetchListingPage(url, proxy, fetchListingFn);
    await markFetched(market.id);
  } catch (err) {
    captureError(err, {
      component: 'darknetMarketCrawler.fetch',
      market_id: market.id,
    });
    await escalateBackoff(market.id);
    return { listings_parsed: 0, findings_inserted: 0, errors: 1, skipped: false };
  }

  if (res.status === 429 || res.status >= 500) {
    await escalateBackoff(market.id);
    void emitMetric('identity_shield.darknet_crawl', {
      market_id: market.id,
      listings_parsed: '0',
      findings_created: '0',
      errors: '1',
      reason: res.status === 429 ? 'rate_limited' : 'upstream_5xx',
    });
    return { listings_parsed: 0, findings_inserted: 0, errors: 1, skipped: false };
  }
  if (res.status !== 200) {
    // 4xx outside 429 — likely a 404 (market gone) or 403 (anti-bot
    // wall). Don't escalate backoff for these — operator should
    // inspect via the next intel-source-health admin view.
    void emitMetric('identity_shield.darknet_crawl', {
      market_id: market.id,
      listings_parsed: '0',
      findings_created: '0',
      errors: '1',
      reason: `status_${res.status}`,
    });
    return { listings_parsed: 0, findings_inserted: 0, errors: 1, skipped: false };
  }

  // A successful fetch resets the backoff ladder. The key itself
  // remains until its TTL if one was in flight; the step counter
  // resets to 0 so the next failure starts at step 1 again.
  await clearBackoffStep(market.id);

  // Hand the HTML to the appropriate parser. Tests inject
  // parseListingFn to skip the registry lookup entirely.
  const parser = parseListingFn
    ? { parse: parseListingFn }
    : parserFor(market.source_handle);
  let listings: MarketListing[];
  try {
    listings = parser.parse(res.html);
  } catch (err) {
    captureError(err, {
      component: 'darknetMarketCrawler.parse',
      market_id: market.id,
      source_handle: market.source_handle,
    });
    return { listings_parsed: 0, findings_inserted: 0, errors: 1, skipped: false };
  }

  let findingsInserted = 0;
  let errors = 0;
  for (const listing of listings) {
    const breach = await upsertBreachForListing(market.id, market.source_handle, listing);
    if (!breach) {
      errors++;
      continue;
    }
    // matchListingAgainstMonitors runs in worker memory — no per-user
    // lookup endpoint, no per-listing HTTP, no cross-pollution.
    const findings = await matchListingAgainstMonitors(breach.id, listing, index);
    findingsInserted += findings;
  }

  // Fan-out the market's onion URL as a `url_host` active_threats
  // entry. Severity 'warning' = "confirmed scam infrastructure, no
  // single-victim attestation." The provenance ties back to the
  // threat_intel_channels row so admin attribution stays clean.
  // ingestThreatBatch is idempotent so the same market URL doesn't
  // proliferate rows across daily crawls.
  const threats: ThreatInput[] = [
    {
      kind: 'url_host',
      value: market.source_handle,
      severity: 'warning',
      provenance: `darknet_market:${market.id}`,
      context: `Darknet market observed by AegisDial crawler (${market.source_handle})`.slice(0, 200),
    },
  ];
  try {
    await ingestThreatBatch(threats);
  } catch (err) {
    captureError(err, {
      component: 'darknetMarketCrawler.activeThreats_fanout',
      market_id: market.id,
    });
    errors++;
  }

  // Touch the threat_intel_channels.last_message_observed_at column
  // so the operator runbook's "last crawl per market" view is honest.
  // Failure here is logged but not fatal — the row still gets crawled
  // tomorrow regardless of whether the timestamp updated.
  try {
    await query(
      `UPDATE threat_intel_channels
          SET last_message_observed_at = NOW()
        WHERE id = $1`,
      [market.id],
    );
  } catch (err) {
    captureError(err, {
      component: 'darknetMarketCrawler.touchLastObserved',
      market_id: market.id,
    });
  }

  void emitMetric('identity_shield.darknet_crawl', {
    market_id: market.id,
    listings_parsed: String(listings.length),
    findings_created: String(findingsInserted),
    errors: String(errors),
  });

  return {
    listings_parsed: listings.length,
    findings_inserted: findingsInserted,
    errors,
    skipped: false,
  };
}

// ───────────────────────────────────────────────────────────────
// Crawl-cycle entry point
// ───────────────────────────────────────────────────────────────

/**
 * One crawl pass over every active darknet market. Empty seed table =
 * returns zeros (no throws, no errors, no network egress). When the
 * Tor proxy isn't configured the worker exits before any market is
 * touched — see startup gate in startDarknetCrawler.
 *
 * Test-only injection:
 *   opts.fetchListingFn — replaces the default stub; lets tests
 *                         simulate 200/429/empty pages without a real
 *                         SOCKS5 dependency.
 *   opts.parseListingFn — replaces the per-market parser registry;
 *                         lets tests control listing output without
 *                         hand-crafting market-specific HTML.
 */
export async function crawlMarketsOnce(opts?: {
  fetchListingFn?: FetchListingFn;
  parseListingFn?: ParseListingFn;
}): Promise<{
  markets_crawled: number;
  listings_parsed: number;
  findings_inserted: number;
  errors: number;
}> {
  // Resolve the Tor proxy from env. Missing config = idle path. Tests
  // bypass this gate by passing a custom fetchListingFn AND a dummy
  // proxy via env, or by stubbing the config module — either is fine
  // because the no-Tor branch returns zeros which is the correct
  // scaffold-on-empty-env behavior anyway.
  const torHost = config.DARKNET_CRAWLER_TOR_SOCKS5_HOST;
  const torPort = config.DARKNET_CRAWLER_TOR_SOCKS5_PORT;
  if (!torHost || !torPort) {
    // Worker idles. Do NOT throw — we want the daily cron to keep
    // running on dev/CI so the scaffold ships unbroken.
    return { markets_crawled: 0, listings_parsed: 0, findings_inserted: 0, errors: 0 };
  }
  const proxy: TorProxyConfig = { socks5_host: torHost, socks5_port: torPort };

  // Active-market seed list. Empty table = zero markets, return zeros.
  let markets: ActiveMarketRow[];
  try {
    const res = await query<ActiveMarketRow>(
      `SELECT id, source_handle
         FROM threat_intel_channels
        WHERE source_kind = 'darknet_market'
          AND status = 'active'`,
    );
    markets = res.rows;
  } catch (err) {
    captureError(err, { component: 'darknetMarketCrawler.fetchMarkets' });
    return { markets_crawled: 0, listings_parsed: 0, findings_inserted: 0, errors: 1 };
  }
  if (markets.length === 0) {
    return { markets_crawled: 0, listings_parsed: 0, findings_inserted: 0, errors: 0 };
  }

  // Build the monitor index ONCE per cycle. Hash-matching iterates the
  // index per listing; loading it per market would multiply the SELECT
  // cost by N markets without any correctness gain (monitors don't
  // change between markets inside a single cycle).
  const index = await loadMonitorIndex();

  const fetchListingFn = opts?.fetchListingFn ?? stubFetchListingFn;
  let listingsParsed = 0;
  let findingsInserted = 0;
  let errors = 0;
  let marketsCrawled = 0;

  for (const market of markets) {
    const result = await crawlOneMarket({
      market,
      proxy,
      index,
      fetchListingFn,
      parseListingFn: opts?.parseListingFn,
    });
    if (!result.skipped) marketsCrawled++;
    listingsParsed += result.listings_parsed;
    findingsInserted += result.findings_inserted;
    errors += result.errors;
  }

  return {
    markets_crawled: marketsCrawled,
    listings_parsed: listingsParsed,
    findings_inserted: findingsInserted,
    errors,
  };
}

// ───────────────────────────────────────────────────────────────
// Observer-only startup self-test
// ───────────────────────────────────────────────────────────────

/**
 * Boot-time defense-in-depth: assert that fetchListingPage refuses any
 * verb other than GET. A future refactor that loosens this constraint
 * trips the assertion at process start, surfacing the regression in
 * the very first log line instead of in production months later.
 *
 * Logs loudly on failure but DOES NOT crash the process — the worker
 * scheduler keeps the rest of the cron lifecycle running. The single
 * console.error line is grep-able and the operator runbook reflexes on
 * it as a P0 alert.
 */
function selfTestObserverOnly(): void {
  let passed = true;
  // The wrapper takes an injected fetch — we pass a no-op that should
  // never be reached because the verb check throws first.
  const trapFetch: FetchListingFn = async () => {
    passed = false;
    return { html: '', status: 200 };
  };
  // The wrapper is async — we await synchronously inside an IIFE to
  // keep the boot-time path simple.
  void (async () => {
    try {
      await fetchListingPage(
        'http://example.invalid/',
        { socks5_host: 'localhost', socks5_port: 9050 },
        trapFetch,
        'POST',
      );
      // If we got here, the wrapper accepted POST — that's a regression.
      passed = false;
    } catch {
      // Expected — the throw is the success signal.
    }
    if (!passed) {
      // eslint-disable-next-line no-console
      console.error(
        '[darknet-crawler] OBSERVER-ONLY SELF-TEST FAILED — fetchListingPage accepted a non-GET verb. ' +
          'This is a P0 architectural regression; review src/workers/darknetMarketCrawler.ts immediately.',
      );
      void emitMetric('identity_shield.darknet_observer_only_violation', {
        location: 'self_test',
      });
    } else {
      // eslint-disable-next-line no-console
      console.log('[darknet-crawler] observer-only self-test passed');
    }
  })();
}

// ───────────────────────────────────────────────────────────────
// Cron scaffolding
// ───────────────────────────────────────────────────────────────

export function startDarknetCrawler(): CrawlerHandle {
  // Startup log: state the operating mode so the operator can
  // confirm Tor-proxy posture from the first line of logs.
  if (!config.DARKNET_CRAWLER_TOR_SOCKS5_HOST || !config.DARKNET_CRAWLER_TOR_SOCKS5_PORT) {
    // eslint-disable-next-line no-console
    console.log(
      '[darknet-crawler] Darknet crawler disabled — no Tor proxy configured (DARKNET_CRAWLER_TOR_SOCKS5_HOST/_PORT). ' +
        'Worker scheduled but cycles will idle. This is the expected dev/CI default.',
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[darknet-crawler] Tor SOCKS5 proxy configured (host=${config.DARKNET_CRAWLER_TOR_SOCKS5_HOST}:${config.DARKNET_CRAWLER_TOR_SOCKS5_PORT}). ` +
        'Worker scheduled @ "33 2 * * *" UTC.',
    );
  }

  // Run the observer-only self-test on every boot. The cost is one
  // throw — micro-microseconds — and the assertion guards against the
  // most architecturally load-bearing invariant in the worker.
  selfTestObserverOnly();

  const crawlTask = cron.schedule(
    DAILY_CRON,
    () => {
      void (async () => {
        const started = Date.now();
        const result = await crawlMarketsOnce();
        // eslint-disable-next-line no-console
        console.log('[darknet-crawler] crawl_cycle complete', {
          duration_ms: Date.now() - started,
          ...result,
        });
      })();
    },
    { timezone: 'UTC' },
  );

  return { crawlTask };
}

export function stopDarknetCrawler(handle: CrawlerHandle): void {
  handle.crawlTask.stop();
}

// Test-only export of the observer-only wrapper so the unit test can
// exercise the verb-rejection path WITHOUT going through the public
// crawlMarketsOnce entry. The underscore prefix flags this as
// internal-with-test-permission — production callers should not import
// it. (TS doesn't enforce export visibility; the convention is the gate.)
export const __test = {
  fetchListingPage,
  parserFor,
  GenericDefaultParser,
  hashWithSalt,
};
