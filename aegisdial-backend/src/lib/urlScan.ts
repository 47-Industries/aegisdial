import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { query } from './db.js';

// URL extraction + reputation check. Primary source: Google Safe Browsing
// v4 Lookup API — free up to 10k queries/day, covers MALWARE,
// SOCIAL_ENGINEERING, UNWANTED_SOFTWARE, POTENTIALLY_HARMFUL_APPLICATION.
//
// Results are cached in `url_reputations` for 6 hours so the same shortlink
// appearing in SMS blasts doesn't burn a quota call per user.
//
// When the API key isn't set, we fall back to heuristic flags: suspicious
// TLDs, URL shorteners, known-scam keyword tokens in the path.

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SAFE_BROWSING_URL = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';

// Shorteners favored by spam + phishing campaigns. Presence alone isn't
// malicious; we bump the score but don't flag as junk on this signal alone.
const SUSPICIOUS_SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'bl.ink', 'lnkd.in',
]);

// TLDs historically over-represented in smishing payload links.
const SUSPICIOUS_TLDS = new Set([
  '.top', '.icu', '.xyz', '.click', '.rest', '.buzz', '.quest', '.cfd',
  '.monster', '.live', '.vip', '.zip', '.mov',
]);

export interface UrlFinding {
  url: string;
  is_malicious: boolean;
  threat_types: string[];
  source: 'safe_browsing' | 'heuristic' | 'cache';
}

// Per-URL length cap. Anything longer is either a tracking blob or an
// adversarial attempt to blow up regex matchers / our SB payload.
const MAX_URL_LENGTH = 2048;

// Match protocol-prefixed URLs and bare known-shortener domains (bit.ly/xyz, etc.)
const SHORTENER_BARE_REGEX =
  /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|bl\.ink)\/[^\s<>"']+/gi;

const URL_REGEX =
  /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

export function extractUrls(text: string): string[] {
  const bare = (text.match(SHORTENER_BARE_REGEX) ?? []).map(u => 'https://' + u);
  const matches = [...(text.match(URL_REGEX) ?? []), ...bare];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let raw of matches) {
    raw = raw.replace(/[.,;:!?)\]}]+$/, ''); // trim trailing punctuation
    if (raw.length > MAX_URL_LENGTH) continue;
    if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
    const canonical = canonicalizeUrl(raw);
    if (!canonical) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/**
 * Normalize a URL for consistent caching + strip embedded credentials.
 *
 * - Rejects URLs with non-http(s) schemes.
 * - Rejects URLs with userinfo (http://user:pass@host/...) — never pass
 *   credentials into the reputation cache or the SB payload. If present,
 *   we strip them before returning.
 * - Lowercases scheme + host.
 * - Strips default ports (:80, :443).
 * - Keeps the path + query + fragment but not as a cache key: the cache
 *   uses `canonicalCacheKey(u)` below which is HOST-ONLY.
 * - Returns null if `new URL()` throws (unparseable).
 */
export function canonicalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Strip userinfo
    u.username = '';
    u.password = '';
    u.host = u.host.toLowerCase();
    u.protocol = u.protocol.toLowerCase();
    // Strip default ports
    if ((u.protocol === 'http:' && u.port === '80')
      || (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Cache key for reputation lookups: proto://host[:nondefault-port]/pathname.
 * Excludes query + fragment (where PII most often lives). Different URLs
 * on the same path collide to the same cache entry, which is fine — the
 * malicious-ness of a path rarely changes with query params.
 */
function canonicalCacheKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.host.toLowerCase();
    const path = u.pathname || '/';
    return `${u.protocol.toLowerCase()}//${host}${path}`;
  } catch {
    return null;
  }
}

function hostOnly(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export async function scanUrls(urls: string[]): Promise<UrlFinding[]> {
  if (urls.length === 0) return [];
  const findings: UrlFinding[] = [];
  const toLookup: string[] = [];

  // Cache check first. Cache failures (e.g. DB down, or running in a
  // unit test with no pool) degrade gracefully to a live lookup.
  // Cache key is the HOST+PATH canonical form — we never hash the raw URL
  // with query + fragment because those routinely carry PII (emails,
  // session tokens) and would pollute the shared cache.
  for (const u of urls) {
    const cacheKey = canonicalCacheKey(u);
    if (!cacheKey) continue;
    const hash = sha256(cacheKey);
    let row:
      | { is_malicious: boolean; threat_types: string[]; checked_at: Date }
      | undefined;
    try {
      const cached = await query<{
        is_malicious: boolean;
        threat_types: string[];
        checked_at: Date;
      }>(
        `SELECT is_malicious, threat_types, checked_at
           FROM url_reputations WHERE url_hash = $1`,
        [hash],
      );
      row = cached.rows[0];
    } catch {
      row = undefined;
    }
    if (row && Date.now() - new Date(row.checked_at).getTime() < CACHE_TTL_MS) {
      findings.push({
        url: u,
        is_malicious: row.is_malicious,
        threat_types: row.threat_types,
        source: 'cache',
      });
    } else {
      toLookup.push(u);
    }
  }

  if (toLookup.length > 0) {
    const live = config.GOOGLE_SAFE_BROWSING_API_KEY
      ? await safeBrowsingLookup(toLookup)
      : toLookup.map((u) => heuristicScan(u));
    for (const f of live) {
      findings.push(f);
      await persistCache(f);
    }
  }

  return findings;
}

async function safeBrowsingLookup(urls: string[]): Promise<UrlFinding[]> {
  try {
    const body = {
      client: { clientId: 'aegisdial', clientVersion: '0.1.0' },
      threatInfo: {
        threatTypes: [
          'MALWARE',
          'SOCIAL_ENGINEERING',
          'UNWANTED_SOFTWARE',
          'POTENTIALLY_HARMFUL_APPLICATION',
        ],
        platformTypes: ['ANY_PLATFORM'],
        threatEntryTypes: ['URL'],
        threatEntries: urls.map((u) => ({ url: u })),
      },
    };
    const resp = await fetch(
      `${SAFE_BROWSING_URL}?key=${config.GOOGLE_SAFE_BROWSING_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2500),
      },
    );
    if (!resp.ok) {
      // Fall back to heuristics on API failure — never block the user.
      return urls.map((u) => heuristicScan(u));
    }
    const json = (await resp.json()) as {
      matches?: { threat: { url: string }; threatType: string }[];
    };
    const hits = new Map<string, string[]>();
    for (const m of json.matches ?? []) {
      const existing = hits.get(m.threat.url) ?? [];
      existing.push(m.threatType);
      hits.set(m.threat.url, existing);
    }
    return urls.map((u) => {
      const threats = hits.get(u);
      return threats
        ? { url: u, is_malicious: true, threat_types: threats, source: 'safe_browsing' as const }
        : { url: u, is_malicious: false, threat_types: [], source: 'safe_browsing' as const };
    });
  } catch {
    return urls.map((u) => heuristicScan(u));
  }
}

function heuristicScan(url: string): UrlFinding {
  const threats: string[] = [];
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (SUSPICIOUS_SHORTENERS.has(host)) threats.push('URL_SHORTENER');
    for (const tld of SUSPICIOUS_TLDS) {
      if (host.endsWith(tld)) {
        threats.push('SUSPICIOUS_TLD');
        break;
      }
    }
    const hostAndPath = (host + parsed.pathname + parsed.search).toLowerCase();
    // Classic smishing bait tokens in host / path / query. Smishers register
    // domains like usps-redeliv.cfd or chase-verify.xyz — the brand name is
    // in the hostname, not just the path.
    if (/(usps|ups|fedex|dhl|amazon|irs|usbank|apple[-_]?id|icloud|paypal|venmo|chase|wellsfargo|bankofamerica|bofa|reward|gift|prize|unpaid|toll|redeliv|confirm|verify|secure[-_]?login|account[-_]?locked|ezpass|sunpass|fastrak|i-?pass|tolltag|txtag|peachpass)/i.test(hostAndPath)) {
      threats.push('SMISHING_KEYWORD_IN_URL');
    }
    // Cyrillic / IDN homograph (basic check)
    if (/[\u0400-\u04ff]/.test(host)) threats.push('IDN_HOMOGRAPH');
  } catch {
    threats.push('UNPARSEABLE_URL');
  }
  return {
    url,
    is_malicious: threats.length >= 2, // at least two heuristics before we flag
    threat_types: threats,
    source: 'heuristic',
  };
}

async function persistCache(f: UrlFinding): Promise<void> {
  const cacheKey = canonicalCacheKey(f.url);
  if (!cacheKey) return;
  // Store only the hash of the canonical cache key + the hostname (for
  // debugging which domains are trending). The full URL — with its query
  // params and potential session tokens — never touches the DB.
  try {
    await query(
      `INSERT INTO url_reputations (url_hash, redacted_host, is_malicious, threat_types, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (url_hash) DO UPDATE SET
         redacted_host = EXCLUDED.redacted_host,
         is_malicious = EXCLUDED.is_malicious,
         threat_types = EXCLUDED.threat_types,
         source = EXCLUDED.source,
         checked_at = NOW()`,
      [sha256(cacheKey), hostOnly(f.url), f.is_malicious, f.threat_types, f.source],
    );
  } catch {
    // Cache failures shouldn't bubble; the caller already has the finding.
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export { sha256 };
