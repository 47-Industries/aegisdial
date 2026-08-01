import { config } from '../config.js';
import { query } from '../lib/db.js';
import { encryptString, readMaybeEncrypted } from '../lib/crypto.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { emitMetric } from '../lib/observability.js';
import { telnyxNumberLookup, telnyxLookupConfigured } from '../lib/telnyx.js';

// Default per-instance daily cap on billable phone lookups. Any combo of
// Twilio + Ekata + IPQS lookups for a distinct e164 that misses cache
// counts as one "billable" unit. Overridable via env (parseInt at use
// time so changes don't require a redeploy of this module).
const DEFAULT_DAILY_LOOKUP_CAP = 2000;

// Cache key for the Twilio cooldown when we hit a 429. We short-circuit
// every subsequent Twilio call until this key expires.
const TWILIO_COOLDOWN_KEY = 'twilio:rate_limited_until';
const TWILIO_COOLDOWN_DEFAULT_SEC = 60;

function dailyLookupCap(): number {
  const raw = process.env.DAILY_LOOKUP_CAP;
  if (!raw) return DEFAULT_DAILY_LOOKUP_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_LOOKUP_CAP;
  return Math.floor(n);
}

/**
 * Returns true when we're already over the daily billable-lookup cap and
 * should short-circuit to null. Never fails closed — if the SELECT
 * throws (metric_counters unavailable, cold start, etc.) we treat the
 * call as under-cap so lookups don't disappear silently.
 */
async function isOverDailyCap(): Promise<boolean> {
  try {
    const cap = dailyLookupCap();
    const rows = await query<{ sum: string | null }>(
      `SELECT COALESCE(SUM(value), 0)::text AS sum
         FROM metric_counters
        WHERE name = 'phone_lookup.billable'
          AND bucket > NOW() - INTERVAL '1 day'`,
    );
    const total = Number(rows.rows[0]?.sum ?? '0');
    return total >= cap;
  } catch {
    // Fail OPEN — cap enforcement is best-effort. Losing visibility on
    // metric_counters must not translate into a silent lookup outage.
    return false;
  }
}

// "Who is this number?" enrichment. Runs against a provider chain and
// caches the result for 30 days. Shape is provider-agnostic so we can
// swap providers later without touching the verdict response.
//
// Current providers (in priority order):
//   1. Twilio Lookup V2 — CNAM (caller name), line type, carrier.
//      Cheapest ($0.005–0.02/call), most reliable, already has env vars.
//   2. IPQualityScore (optional) — spam-risk signal.
//   3. Ekata (optional, future) — full subscriber + address.
//
// NOTE: we deliberately do NOT use FastPeopleSearch / TruthFinder because
// (a) neither has a public API, (b) scraping their HTML violates TOS +
// CFAA-grey, (c) both employ Cloudflare / Akamai bot protection that
// breaks anyway. Twilio + Ekata give richer data legally.

export interface PublicPhoneInfo {
  e164: string;
  owner_name: string | null;
  line_type: 'mobile' | 'landline' | 'voip' | 'toll_free' | 'premium' | 'unknown';
  carrier_name: string | null;
  country_code: string | null;
  city: string | null;
  state_code: string | null;
  address: string | null;
  is_spoofable: boolean;
  /** Carrier + line_type match a known burner / disposable VoIP service
   * (Google Voice, TextNow, Hushed, Burner, Skype, Pinger, Sideline,
   * etc.). Combined with a fresh first_seen this is the strongest
   * "probably a scammer" signal we can surface. */
  is_likely_burner: boolean;
  /** Country code is outside +1 (NANP). Most US elders being targeted
   * by overseas calls are high-risk. Surface this prominently. */
  is_overseas: boolean;
  /** Human label for the burner service if we recognize it ("Google
   * Voice", "TextNow", "Skype"). null when it's just "VoIP". */
  burner_service: string | null;
  spam_risk_score: number | null;
  public_records_found: boolean;
  sources: string[];
  looked_up_at: string;
}

// Spoofability heuristic: VoIP + toll-free numbers are far easier to
// spoof / rent than a named-carrier mobile. We surface this so the
// caller-ID UI can flag "this looks like it came from a VoIP number,
// treat the caller ID with skepticism."
function isSpoofable(lineType: PublicPhoneInfo['line_type']): boolean {
  return lineType === 'voip' || lineType === 'toll_free';
}

// Known burner / disposable-number services. Map from carrier name
// (case-insensitive substring) to a human label we show the user.
// Sources: each provider's public documentation + Twilio's own CNAM
// carrier registry. Maintained manually — these change rarely (once
// every 1–2 years when a new service launches).
const BURNER_CARRIERS: Array<{ match: RegExp; label: string }> = [
  { match: /google[-\s]?voice|bandwidth\.com clec/i, label: 'Google Voice' },
  { match: /textnow/i,                               label: 'TextNow' },
  { match: /hushed/i,                                label: 'Hushed' },
  { match: /burner\b/i,                              label: 'Burner app' },
  { match: /skype/i,                                 label: 'Skype' },
  { match: /pinger|sideline/i,                       label: 'Pinger / Sideline' },
  { match: /ooma/i,                                  label: 'Ooma' },
  { match: /vonage/i,                                label: 'Vonage' },
  { match: /twilio/i,                                label: 'Twilio (programmable)' },
  { match: /bandwidth|inteliquent|level ?3|onvoy/i,  label: 'Wholesale VoIP carrier' },
  { match: /voice\.?com|mynumbers|flowroute|plivo/i, label: 'VoIP reseller' },
];

function detectBurner(
  lineType: PublicPhoneInfo['line_type'],
  carrierName: string | null,
): { is_likely_burner: boolean; burner_service: string | null } {
  if (!carrierName) {
    // No carrier data but line is VoIP or toll-free → still suspicious.
    if (lineType === 'voip' || lineType === 'toll_free') {
      return { is_likely_burner: true, burner_service: null };
    }
    return { is_likely_burner: false, burner_service: null };
  }
  for (const b of BURNER_CARRIERS) {
    if (b.match.test(carrierName)) {
      return { is_likely_burner: true, burner_service: b.label };
    }
  }
  // Non-recognized carrier but still VoIP → moderately suspicious.
  if (lineType === 'voip') {
    return { is_likely_burner: true, burner_service: null };
  }
  return { is_likely_burner: false, burner_service: null };
}

// Overseas detection: we default to US-first (+1 is NANP which covers
// US + Canada + Caribbean). Anything else is treated as overseas for
// the purposes of "extra caution on unexpected international calls to
// elderly parents." This will need per-user-region awareness when we
// expand outside US, but for now it's the right heuristic.
function isOverseas(e164: string): boolean {
  return !e164.startsWith('+1');
}

/**
 * Main entry point. Returns null for obviously-invalid e164 strings and
 * cache-misses-with-no-providers-configured. Always non-throwing —
 * providers that fail are dropped from the `sources` list.
 */
export async function lookupPhone(e164: string): Promise<PublicPhoneInfo | null> {
  if (!/^\+\d{7,15}$/.test(e164)) return null;

  // Cache hit within TTL? Return that. Cache hits are free and must
  // NOT be budgeted against the daily cap.
  const cached = await readCache(e164);
  if (cached) return cached;

  // Daily spend guard — enforced BEFORE we kick off any paid provider.
  // Cap is read from env each call so operators can bump it without a
  // redeploy in an incident. Fails open (see isOverDailyCap).
  if (await isOverDailyCap()) {
    void emitMetric('phone_lookup.cap_exhausted', {});
    // eslint-disable-next-line no-console
    console.warn('[phoneLookup] daily budget cap reached — short-circuiting lookup', {
      e164_suffix: e164.slice(-4),
    });
    return null;
  }

  // Twilio cooldown. If we got a 429 recently, skip Twilio entirely
  // until the cooldown key expires. Other providers (Ekata / IPQS) are
  // independent and still fire.
  const twilioRateLimited = await isTwilioRateLimited();

  // Run every configured provider in parallel. They're independent —
  // Twilio gives caller name + carrier, IPQS gives risk score.
  const providers: Array<Promise<Partial<PublicPhoneInfo> & { sources: string[] }>> = [];
  // Identity provider: Telnyx when CALL_PROVIDER says so and a key exists,
  // otherwise Twilio Lookup v2. Exactly one of the two runs — they return the
  // same fields (owner_name / line_type / carrier_name / country_code) and
  // paying both for the same answer is the one thing this migration exists to
  // stop. Telnyx has no 429-cooldown branch because it isn't rate-limited the
  // way Twilio Lookup is; if that changes, mirror the cooldown here.
  if (config.CALL_PROVIDER === 'telnyx' && telnyxLookupConfigured()) {
    providers.push(runTelnyxLookup(e164));
  } else if (
    config.ENABLE_TWILIO_LOOKUP &&
    config.TWILIO_ACCOUNT_SID &&
    config.TWILIO_AUTH_TOKEN &&
    !twilioRateLimited
  ) {
    providers.push(runTwilioLookup(e164));
  }
  // Ekata — richer subscriber + address data. Twilio runs first because
  // it's cheaper and faster; Ekata fills in owner_name / address when
  // Twilio's CNAM returns "unknown".
  if (config.EKATA_API_KEY) providers.push(runEkata(e164));
  // IPQS — fraud / spam-risk cross-check. Last because its contribution
  // is a single score field; Twilio + Ekata have already populated the
  // identity fields by the time we merge.
  if (config.IPQS_API_KEY) providers.push(runIpqs(e164));

  if (providers.length === 0) return null;

  // Count a billable unit once per miss. We count at dispatch time
  // (before providers resolve) so a concurrent flurry of identical
  // numbers doesn't all slip under the cap while the first request is
  // in flight. Fire-and-forget — a failed metric write must not affect
  // the caller.
  void emitMetric('phone_lookup.billable', {});

  const results = await Promise.allSettled(providers);
  const merged: PublicPhoneInfo = {
    e164,
    owner_name: null,
    line_type: 'unknown',
    carrier_name: null,
    country_code: null,
    city: null,
    state_code: null,
    address: null,
    is_spoofable: false,
    is_likely_burner: false,
    is_overseas: isOverseas(e164),
    burner_service: null,
    spam_risk_score: null,
    public_records_found: false,
    sources: [],
    looked_up_at: new Date().toISOString(),
  };
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const p = r.value;
    // Merge field-by-field — first non-null wins. Providers are ordered
    // by priority so Twilio's owner_name beats Ekata's (if both fire).
    if (p.owner_name && !merged.owner_name) merged.owner_name = p.owner_name;
    if (p.line_type && p.line_type !== 'unknown' && merged.line_type === 'unknown') {
      merged.line_type = p.line_type;
    }
    if (p.carrier_name && !merged.carrier_name) merged.carrier_name = p.carrier_name;
    if (p.country_code && !merged.country_code) merged.country_code = p.country_code;
    if (p.city && !merged.city) merged.city = p.city;
    if (p.state_code && !merged.state_code) merged.state_code = p.state_code;
    if (p.address && !merged.address) merged.address = p.address;
    if (p.spam_risk_score != null && merged.spam_risk_score == null) {
      merged.spam_risk_score = p.spam_risk_score;
    }
    if (p.public_records_found) merged.public_records_found = true;
    merged.sources.push(...p.sources);
  }
  merged.is_spoofable = isSpoofable(merged.line_type);
  const burner = detectBurner(merged.line_type, merged.carrier_name);
  merged.is_likely_burner = burner.is_likely_burner;
  merged.burner_service = burner.burner_service;
  merged.public_records_found ||= !!(merged.owner_name || merged.address);

  if (merged.sources.length === 0) return null;

  // Cache for 30 days. Cache failures are swallowed — better to re-bill
  // occasionally than to miss a lookup.
  await writeCache(merged).catch(() => { /* best effort */ });
  return merged;
}

// ---------- Telnyx Number Lookup ----------
//
// Same shape as runTwilioLookup so the two are interchangeable at the call
// site. Cost: ~$0.003 for carrier + caller-name in one request, vs Twilio's
// ~$0.015 for the equivalent two Fields.

async function runTelnyxLookup(
  e164: string,
): Promise<Partial<PublicPhoneInfo> & { sources: string[] }> {
  const r = await telnyxNumberLookup(e164);
  // ok=false covers missing creds, non-2xx, timeout and network error alike —
  // all of which mean "this provider contributed nothing", not "this number
  // has no carrier". Returning empty sources keeps it out of the merge.
  if (!r.ok) return { sources: [] };
  return {
    owner_name: r.owner_name,
    line_type: (r.line_type ?? 'unknown') as PublicPhoneInfo['line_type'],
    carrier_name: r.carrier_name,
    country_code: r.country_code,
    sources: ['telnyx_number_lookup'],
  };
}

// ---------- Twilio Lookup V2 ----------
//
// Docs: https://www.twilio.com/docs/lookup/v2-api
// Endpoint: GET https://lookups.twilio.com/v2/PhoneNumbers/{e164}?Fields=line_type_intelligence,caller_name
// Auth: HTTP basic (AccountSID:AuthToken)
// Cost: $0.005 per `line_type_intelligence` lookup + $0.01 per `caller_name` = ~$0.015 combined.

async function runTwilioLookup(
  e164: string,
): Promise<Partial<PublicPhoneInfo> & { sources: string[] }> {
  const url = new URL(`https://lookups.twilio.com/v2/PhoneNumbers/${e164}`);
  url.searchParams.set('Fields', 'line_type_intelligence,caller_name');

  const auth = Buffer.from(
    `${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`,
  ).toString('base64');

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) {
      if (res.status === 429) {
        // Twilio rate-limited us. Persist a cooldown window so sibling
        // callers within the same Fly instance (and across instances
        // via shared Redis) stop hammering Twilio until it expires.
        const retryAfterRaw = res.headers.get('retry-after');
        const retryAfter = Number(retryAfterRaw);
        const ttl =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(Math.ceil(retryAfter), 900)
            : TWILIO_COOLDOWN_DEFAULT_SEC;
        await markTwilioRateLimited(ttl);
        void emitMetric('phone_lookup.twilio_rate_limited', {}, 1);
      }
      return { sources: [] };
    }
    const data = (await res.json()) as TwilioLookupResponse;

    const lineType = mapTwilioLineType(data.line_type_intelligence?.type ?? undefined);
    const callerName = data.caller_name?.caller_name?.trim();
    return {
      owner_name: callerName && callerName !== 'unknown' ? callerName : null,
      line_type: lineType,
      carrier_name: data.line_type_intelligence?.carrier_name ?? null,
      country_code: data.country_code ?? null,
      sources: ['twilio_lookup_v2'],
    };
  } catch {
    return { sources: [] };
  }
}

function mapTwilioLineType(raw: string | undefined): PublicPhoneInfo['line_type'] {
  switch (raw) {
    case 'mobile':          return 'mobile';
    case 'landline':        return 'landline';
    case 'fixedVoip':
    case 'nonFixedVoip':    return 'voip';
    case 'tollFree':        return 'toll_free';
    case 'premium':         return 'premium';
    default:                return 'unknown';
  }
}

interface TwilioLookupResponse {
  phone_number?: string;
  country_code?: string;
  line_type_intelligence?: {
    type?: string;
    carrier_name?: string;
    mobile_country_code?: string;
    mobile_network_code?: string;
  };
  caller_name?: {
    caller_name?: string;
    caller_type?: string;
  };
}

// ---------- Ekata Pro Insight Phone Intelligence v2 ----------
//
// Docs: https://ekata.com/products/phone-intelligence/
// Endpoint: POST https://api.ekata.com/3.0/phone?api_key=<key>
// Body: { "phone": "<e164>" }
// Returns subscriber name + address + reputation. Pricier than Twilio
// but gives the owner+address fields CNAM often leaves empty.

async function runEkata(
  e164: string,
): Promise<Partial<PublicPhoneInfo> & { sources: string[] }> {
  try {
    const url = `https://api.ekata.com/3.0/phone?api_key=${encodeURIComponent(
      config.EKATA_API_KEY ?? '',
    )}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: e164 }),
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) return { sources: [] };
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('application/json')) return { sources: [] };
    const data = (await res.json()) as EkataPhoneResponse;

    const lineType = mapEkataLineType(data.line_type ?? undefined);
    const subscriberName = data.subscriber_name?.trim() || null;
    const carrier = data.carrier?.trim() || null;
    const addr = data.subscriber_address ?? null;
    const address = addr
      ? [addr.street_line_1, addr.city, joinWithSpace(addr.state_code, addr.postal_code)]
          .map((s) => (s ?? '').trim())
          .filter((s) => s.length > 0)
          .join(', ') || null
      : null;

    return {
      owner_name: subscriberName,
      line_type: lineType,
      carrier_name: carrier,
      country_code: addr?.country_code ?? null,
      city: addr?.city?.trim() || null,
      state_code: addr?.state_code?.trim() || null,
      address,
      public_records_found: !!(subscriberName || address),
      sources: ['ekata_phone_intelligence'],
    };
  } catch {
    return { sources: [] };
  }
}

function joinWithSpace(a: string | null | undefined, b: string | null | undefined): string {
  return [a, b].filter((s) => s && s.trim().length > 0).join(' ');
}

function mapEkataLineType(raw: string | undefined): PublicPhoneInfo['line_type'] {
  switch (raw) {
    case 'Mobile':        return 'mobile';
    case 'Landline':      return 'landline';
    case 'NonFixedVOIP':
    case 'FixedVOIP':     return 'voip';
    case 'TollFree':      return 'toll_free';
    case 'Premium':       return 'premium';
    default:              return 'unknown';
  }
}

interface EkataPhoneResponse {
  is_valid?: boolean;
  country_calling_code?: number;
  line_type?: string;
  carrier?: string;
  country_code?: string;
  subscriber_name?: string;
  subscriber_address?: {
    street_line_1?: string;
    city?: string;
    postal_code?: string;
    state_code?: string;
    country_code?: string;
  };
  reputation?: {
    level?: number;
    report_count?: number;
  };
  is_prepaid?: boolean;
}

// ---------- IPQualityScore ----------
//
// Docs: https://www.ipqualityscore.com/documentation/phone-number-validation-api/overview
// Endpoint: GET https://www.ipqualityscore.com/api/json/phone/<key>/<e164>?strictness=1
// Returns fraud_score (0–100) we surface as spam_risk_score, plus
// carrier / line_type we cross-check against Twilio + Ekata.

async function runIpqs(
  e164: string,
): Promise<Partial<PublicPhoneInfo> & { sources: string[] }> {
  try {
    const key = encodeURIComponent(config.IPQS_API_KEY ?? '');
    const num = encodeURIComponent(e164);
    const url = `https://www.ipqualityscore.com/api/json/phone/${key}/${num}?strictness=1`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) return { sources: [] };
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('application/json')) return { sources: [] };
    const data = (await res.json()) as IpqsPhoneResponse;

    const lineType = mapIpqsLineType(data.line_type ?? undefined);
    const fraudScore =
      typeof data.fraud_score === 'number' ? data.fraud_score : null;
    return {
      line_type: lineType,
      carrier_name: data.carrier?.trim() || null,
      country_code: data.country?.trim() || null,
      city: data.city?.trim() || null,
      state_code: data.region?.trim() || null,
      spam_risk_score: fraudScore,
      sources: ['ipqualityscore'],
    };
  } catch {
    return { sources: [] };
  }
}

function mapIpqsLineType(raw: string | undefined): PublicPhoneInfo['line_type'] {
  switch (raw) {
    case 'Wireless':      return 'mobile';
    case 'Landline':      return 'landline';
    case 'VOIP':          return 'voip';
    case 'TollFree':      return 'toll_free';
    case 'Premium':       return 'premium';
    default:              return 'unknown';
  }
}

interface IpqsPhoneResponse {
  valid?: boolean;
  line_type?: string;
  carrier?: string;
  active?: boolean;
  fraud_score?: number;
  recent_abuse?: boolean;
  risky?: boolean;
  country?: string;
  city?: string;
  region?: string;
}

// ---------- Twilio cooldown (Redis) ----------

/**
 * Returns true when Twilio flagged us with a 429 recently and we're
 * still inside the cooldown window. Swallows cache errors — a broken
 * Redis cluster must not make Twilio lookups disappear silently.
 */
async function isTwilioRateLimited(): Promise<boolean> {
  try {
    const v = await cacheGet<number>(TWILIO_COOLDOWN_KEY);
    return v !== null;
  } catch {
    return false;
  }
}

async function markTwilioRateLimited(ttlSeconds: number): Promise<void> {
  try {
    await cacheSet(TWILIO_COOLDOWN_KEY, Date.now(), ttlSeconds);
  } catch {
    // best-effort
  }
}

// ---------- Cache ----------

async function readCache(e164: string): Promise<PublicPhoneInfo | null> {
  try {
    const rows = await query<{
      e164: string;
      owner_name: string | null;
      owner_name_ct: string | null;
      line_type: string | null;
      carrier_name: string | null;
      country_code: string | null;
      city: string | null;
      city_ct: string | null;
      state_code: string | null;
      address_ct: string | null;
      is_spoofable: boolean | null;
      spam_risk_score: number | null;
      public_records_found: boolean;
      sources: string[];
      looked_up_at: Date;
      expires_at: Date;
    }>(
      `SELECT e164, owner_name, owner_name_ct, line_type, carrier_name,
              country_code, city, city_ct, state_code, address_ct,
              is_spoofable, spam_risk_score, public_records_found,
              sources, looked_up_at, expires_at
         FROM phone_lookups
        WHERE e164 = $1 AND expires_at > NOW()`,
      [e164],
    );
    const r = rows.rows[0];
    if (!r) return null;
    const lineType = (r.line_type as PublicPhoneInfo['line_type']) ?? 'unknown';
    const burner = detectBurner(lineType, r.carrier_name);
    return {
      e164: r.e164,
      owner_name: readMaybeEncrypted(r.owner_name_ct) || r.owner_name || null,
      line_type: lineType,
      carrier_name: r.carrier_name,
      country_code: r.country_code,
      city: readMaybeEncrypted(r.city_ct) || r.city || null,
      state_code: r.state_code,
      address: readMaybeEncrypted(r.address_ct),
      is_spoofable: r.is_spoofable ?? false,
      is_likely_burner: burner.is_likely_burner,
      is_overseas: isOverseas(r.e164),
      burner_service: burner.burner_service,
      spam_risk_score: r.spam_risk_score,
      public_records_found: r.public_records_found,
      sources: r.sources,
      looked_up_at: r.looked_up_at.toISOString(),
    };
  } catch {
    return null;
  }
}

async function writeCache(info: PublicPhoneInfo): Promise<void> {
  await query(
    `INSERT INTO phone_lookups (
       e164, owner_name, owner_name_ct, line_type, carrier_name,
       country_code, city, city_ct, state_code, address_ct,
       is_spoofable, spam_risk_score, public_records_found, sources,
       looked_up_at, expires_at
     ) VALUES (
       $1, '', $2, $3, $4, $5, '', $6, $7, $8, $9, $10, $11, $12, NOW(),
       NOW() + INTERVAL '30 days'
     )
     ON CONFLICT (e164) DO UPDATE SET
       owner_name_ct = EXCLUDED.owner_name_ct,
       line_type = EXCLUDED.line_type,
       carrier_name = EXCLUDED.carrier_name,
       country_code = EXCLUDED.country_code,
       city_ct = EXCLUDED.city_ct,
       state_code = EXCLUDED.state_code,
       address_ct = EXCLUDED.address_ct,
       is_spoofable = EXCLUDED.is_spoofable,
       spam_risk_score = EXCLUDED.spam_risk_score,
       public_records_found = EXCLUDED.public_records_found,
       sources = EXCLUDED.sources,
       looked_up_at = NOW(),
       expires_at = NOW() + INTERVAL '30 days'`,
    [
      info.e164,
      info.owner_name ? encryptString(info.owner_name) : null,
      info.line_type,
      info.carrier_name,
      info.country_code,
      info.city ? encryptString(info.city) : null,
      info.state_code,
      info.address ? encryptString(info.address) : null,
      info.is_spoofable,
      info.spam_risk_score,
      info.public_records_found,
      info.sources,
    ],
  );
}
