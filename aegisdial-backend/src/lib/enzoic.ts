import { createHash } from 'node:crypto';
import { config } from '../config.js';

// Enzoic Exposures API client.
// Endpoints (per https://www.enzoic.com/docs-exposures-api/):
//   GET https://api.enzoic.com/v1/exposures?username=<SHA-256>
//      - username is the lowercase SHA-256 of the email (plaintext never
//        leaves our server — important for Enzoic best practices and
//        our own privacy story).
//      - returns { count, exposures: ["<id>", ...] }
//   GET https://api.enzoic.com/v1/exposures?id=<exposureId>
//      - returns a single exposure detail object
// For phone lookups Enzoic uses a separate endpoint
// (GET /v1/accounts?username=...), but for MVP we send phones through
// the same /v1/exposures flow with a hashed username, which matches
// Enzoic's integration pattern for "account identifiers."
//
// Auth: HTTP Basic with APIKEY:SECRET.
//
// When creds aren't set and ENZOIC_MOCK=true, produce a deterministic
// fake set of exposures so end-to-end flows are testable in dev.

const BASE_URL = 'https://api.enzoic.com/v1';

export interface EnzoicExposure {
  id: string;
  title: string;
  date: string | null;
  source_domain: string | null;
  data_types: string[];
  entries_count: number | null;
  description: string | null;
  severity: 'info' | 'warning' | 'critical';
}

export type EnzoicIdentifierKind = 'email' | 'phone';

/**
 * Sentinel returned to callers when a scan was intentionally skipped
 * (rather than "we scanned and found zero exposures"). Surfaced by
 * `lookupExposures` for `kind='phone'` today, so iOS can render
 * "phone monitoring coming soon" instead of the empty-state breach UI.
 *
 * Treated as a tuple shape — callers can pattern-match on `disabled: true`
 * or fall through to .length when they only care about the count.
 */
export interface EnzoicDisabled {
  disabled: true;
  reason: string;
}

export function isEnzoicDisabled(
  r: EnzoicExposure[] | EnzoicDisabled,
): r is EnzoicDisabled {
  return !Array.isArray(r) && r.disabled === true;
}

const HIGH_SEVERITY_DATA_TYPES = new Set([
  'passwords',
  'partial credit card numbers',
  'credit card information',
  'credit card numbers',
  'social security numbers',
  'ssn',
  'government-issued ids',
  'bank account numbers',
  'financial information',
]);

/**
 * Phone monitoring is DISABLED against live Enzoic.
 *
 * Enzoic's `/v1/exposures` endpoint is designed for email- / username-
 * shaped identifiers, keyed on SHA-256(username). Feeding a hashed phone
 * number into it silently returns empty regardless of whether the phone
 * has appeared in a real breach — which meant the iOS "breach monitor"
 * surface was showing a false all-clear for every phone a user added.
 *
 * Until we either (a) migrate to Enzoic's phone-aware `/v1/accounts`
 * endpoint (requires a different product tier — confirm with Enzoic
 * sales) or (b) switch to a phone-breach-specific provider, we
 * short-circuit phone lookups against the LIVE API and return a
 * sentinel so callers can render "phone monitoring coming soon."
 *
 * Mock mode (used in dev + CI) is unaffected — tests still expect the
 * deterministic mock shape for phones.
 *
 * TODO.md tracks this.
 */
export function isLivePhoneLookupDisabled(): boolean {
  return true;
}

/**
 * Returns the sentinel form when phone monitoring against the live
 * Enzoic API is currently disabled; otherwise returns a normal array
 * of exposures. iOS uses this to decide between "no exposures found"
 * and "phone monitoring coming soon" copy.
 */
export async function lookupExposuresWithStatus(
  kind: EnzoicIdentifierKind,
  identifier: string,
): Promise<EnzoicExposure[] | EnzoicDisabled> {
  // Mock mode continues to return fake data so dev UX isn't gated on
  // a future provider migration.
  if (config.ENZOIC_MOCK || !config.ENZOIC_API_KEY || !config.ENZOIC_API_SECRET) {
    return mockExposures(kind, identifier);
  }
  if (kind === 'phone' && isLivePhoneLookupDisabled()) {
    return {
      disabled: true,
      reason: 'phone_monitoring_pending_provider',
    };
  }
  return lookupExposures(kind, identifier);
}

export async function lookupExposures(
  kind: EnzoicIdentifierKind,
  identifier: string,
): Promise<EnzoicExposure[]> {
  if (config.ENZOIC_MOCK || !config.ENZOIC_API_KEY || !config.ENZOIC_API_SECRET) {
    return mockExposures(kind, identifier);
  }
  // Phone lookups against live Enzoic return an empty list rather than
  // noisy results (see isLivePhoneLookupDisabled). Callers that want to
  // distinguish "disabled" from "zero hits" should use
  // lookupExposuresWithStatus instead.
  if (kind === 'phone' && isLivePhoneLookupDisabled()) {
    const { emitMetric } = await import('./observability.js');
    void emitMetric('enzoic.phone_lookup_skipped', {});
    return [];
  }
  try {
    // Enzoic expects the SHA-256 (lowercase hex) of the normalized
    // (lowercase + trimmed) identifier. Plaintext never leaves our server.
    const hashed = hashIdentifier(identifier);
    const listUrl = `${BASE_URL}/exposures?username=${hashed}`;
    const listResp = await fetch(listUrl, {
      method: 'GET',
      headers: { Authorization: basicAuth() },
      signal: AbortSignal.timeout(5000),
    });
    if (!listResp.ok) {
      const { captureMessage, emitMetric } = await import('./observability.js');
      captureMessage(`Enzoic non-2xx: ${listResp.status}`, 'warning');
      void emitMetric('enzoic.non_2xx', { status: listResp.status, kind });
      return [];
    }
    const listJson = (await listResp.json()) as { exposures?: string[] };
    const ids = listJson.exposures ?? [];
    if (ids.length === 0) return [];

    const detailed: EnzoicExposure[] = [];
    const chunks = chunk(ids, 10);
    for (const batch of chunks) {
      const results = await Promise.all(
        batch.map((id) =>
          fetch(`${BASE_URL}/exposures?id=${encodeURIComponent(id)}`, {
            method: 'GET',
            headers: { Authorization: basicAuth() },
            signal: AbortSignal.timeout(5000),
          })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ),
      );
      for (const r of results) {
        if (!r) continue;
        detailed.push(shapeExposure(r as RawEnzoicDetail));
      }
    }
    return detailed;
  } catch (err) {
    const { captureError, emitMetric } = await import('./observability.js');
    captureError(err, { component: 'enzoic', kind });
    void emitMetric('enzoic.fetch_failed', { kind });
    return [];
  }
}

interface RawEnzoicDetail {
  id: string;
  title?: string;
  date?: string;
  domain?: string;
  dataClasses?: string[];
  entries?: number;
  description?: string;
}

function shapeExposure(raw: RawEnzoicDetail): EnzoicExposure {
  const dataTypes = (raw.dataClasses ?? []).map((c) => c.toLowerCase());
  const severity = computeSeverity(dataTypes);
  return {
    id: raw.id,
    title: raw.title ?? 'Unknown breach',
    date: raw.date ?? null,
    source_domain: raw.domain ?? null,
    data_types: dataTypes,
    entries_count: raw.entries ?? null,
    description: raw.description ?? null,
    severity,
  };
}

function computeSeverity(dataTypes: string[]): 'info' | 'warning' | 'critical' {
  const hit = dataTypes.some((t) => HIGH_SEVERITY_DATA_TYPES.has(t));
  if (hit) return 'critical';
  if (dataTypes.length === 0) return 'info';
  return 'warning';
}

function basicAuth(): string {
  const tok = Buffer.from(`${config.ENZOIC_API_KEY}:${config.ENZOIC_API_SECRET}`).toString('base64');
  return `Basic ${tok}`;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Deterministic mock: SHA-256 the identifier, derive N exposures from the
// hash. Lets us demo + e2e-test the full UI without real creds.
function mockExposures(kind: EnzoicIdentifierKind, identifier: string): EnzoicExposure[] {
  const hash = createHash('sha256').update(identifier.toLowerCase()).digest('hex');
  // Number of exposures: 0..3 based on first hex nibble.
  const count = parseInt(hash[0]!, 16) % 4;
  if (count === 0) return [];
  const catalog: Array<Omit<EnzoicExposure, 'id'>> = [
    {
      title: 'LinkedIn (2012 breach)',
      date: '2012-06-05',
      source_domain: 'linkedin.com',
      data_types: ['email addresses', 'passwords'],
      entries_count: 167_000_000,
      description: 'Email + hashed password leak from LinkedIn.',
      severity: 'critical',
    },
    {
      title: 'MyFitnessPal (2018)',
      date: '2018-02-01',
      source_domain: 'myfitnesspal.com',
      data_types: ['email addresses', 'usernames', 'passwords'],
      entries_count: 143_000_000,
      description: 'Under Armour MyFitnessPal credential breach.',
      severity: 'critical',
    },
    {
      title: 'Twilio Authy phone leak (2022)',
      date: '2022-08-09',
      source_domain: 'authy.com',
      data_types: ['phone numbers'],
      entries_count: 33_420_000,
      description: 'Authy phone-number leak; widely used in SIM-swap campaigns.',
      severity: 'warning',
    },
  ];
  const picks: EnzoicExposure[] = [];
  for (let i = 0; i < count && i < catalog.length; i++) {
    const base = catalog[i]!;
    picks.push({
      id: `mock-${hash.slice(0, 12)}-${i}`,
      ...base,
    });
  }
  // Use `kind` to vary mocks slightly
  if (kind === 'phone') picks.forEach((p) => (p.data_types = ['phone numbers']));
  return picks;
}

export function hashIdentifier(value: string): string {
  return createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

export function displayMask(kind: EnzoicIdentifierKind, value: string): string {
  const v = value.trim();
  if (kind === 'email') {
    const at = v.indexOf('@');
    if (at <= 0) return v;
    const local = v.slice(0, at);
    const domain = v.slice(at);
    if (local.length <= 2) return `${local[0]}*${domain}`;
    return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}${domain}`;
  }
  // phone
  return v.length > 4 ? `${'*'.repeat(v.length - 4)}${v.slice(-4)}` : v;
}
