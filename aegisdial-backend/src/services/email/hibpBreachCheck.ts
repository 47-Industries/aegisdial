// Email Shield — HIBP (Have I Been Pwned) breach-exposure check.
//
// Pillar 3 of /v1/email/compromise-check. Where the inbox-rules /
// OAuth-grants / login-anomaly detectors catch CURRENT compromise
// of the linked inbox, this detector catches HISTORICAL exposure:
// has the user's email address ever shown up in a public breach
// dump? A LinkedIn-2012 / Adobe-2013 / Collection-1 hit is a signal
// that the account's password (if reused) is in attacker hands —
// the same threat model the inbox-rule audit is trying to prevent,
// just from a different surface.
//
// THREE LAYERS of degradation, in priority order:
//
//   1. HIBP_API_KEY absent → reason_skipped='no_api_key'. Email
//      Shield ships to Pro tier without HIBP being a hard dep; we
//      surface the absence so the iOS UI can render "Add HIBP for
//      a deeper check" rather than silently dropping the finding.
//
//   2. HIBP returns 429 → reason_skipped='rate_limited'. The key
//      tier we buy carries a 1.5s-per-IP floor; under burst the
//      compromise-check route can hit it. Operator retries on the
//      next compromise-check call (≤1/hour per account anyway, so
//      the practical thrash is bounded).
//
//   3. HIBP returns 5xx / unexpected → reason_skipped='api_error'
//      + captureError. Same posture as the inbox-rule detector:
//      one upstream outage must not break the whole report.
//
// HIT PATH: 200 with a Breaches[] body → we normalize the HIBP
// field names to snake_case, compute a high_severity_count over
// "Passwords"-class breaches (the actual credential leak — vs a
// password-only breach like Mailchimp which only leaked email
// addresses), and surface the most recent BreachDate so the iOS
// composite verdict can render "Last seen 2024-03 — Ticketmaster".
//
// CACHE: results pinned for 6h under hibp:<sha256(email)>. The
// compromise-check route already dedupes clean reports for 6h at
// the email_compromise_reports layer, but Pillar 3's per-call
// fan-out runs every time we DON'T have a clean cached report —
// e.g., when another detector found a 'concerns' signal. Hashing
// the email instead of storing it raw keeps Redis from carrying
// recoverable PII (same posture as the rest of the cache layer).
//
// PRIVACY: domain-level breach metadata is already public on
// haveibeenpwned.com — we're not leaking new info by surfacing it
// to the user about their OWN email. The email address itself
// goes to HIBP, which is contractually the SAME vendor relationship
// the user opted into by linking their inbox. No additional PII
// crosses the boundary.
//
// SECURITY:
//   - SSRF: the email is bound to the authenticated user_id via
//     email_accounts.display_email — caller-supplied URLs cannot
//     reach this code path. The URL is constructed from a constant
//     base + encodeURIComponent(email), so attacker control of the
//     email field cannot redirect to an internal host.
//   - API key: NEVER logged. captureError() context fields are
//     scrubbed by observability.ts beforeSend, but we don't put
//     the key in context anyway as a belt-and-braces measure.
//   - Cache key: sha256(email), not the raw address — a Redis
//     leak doesn't surface user identities.

import { createHash } from 'crypto';
import { z } from 'zod';
import { config } from '../../config.js';
import { cacheGet, cacheSet, cacheSetNX } from '../../lib/cache.js';
import { captureError } from '../../lib/observability.js';

// Public HIBP v3 endpoint base. Constant — never derived from
// user input. truncateResponse=false returns the full Breach object
// (BreachDate, DataClasses, IsVerified, etc.) instead of just the
// Name array, which is what the iOS finding surface needs.
const HIBP_BASE_URL = 'https://haveibeenpwned.com/api/v3/breachedaccount';

// Standard cache TTL for both hit and miss results. 6h matches the
// outer email_compromise_reports clean-cache window.
const CACHE_TTL_SECONDS = 60 * 60 * 6;

// Required by HIBP — they bounce requests without it. The contact
// address lets HIBP reach out if our usage pattern looks abusive
// before they rate-limit us blindly.
const HIBP_USER_AGENT = 'AegisDial Email Shield (security@aegisdial.app)';

export interface BreachExposureFinding {
  /** HIBP "Name" — short identifier, e.g. "LinkedIn", "Adobe". */
  breach_name: string;
  /** Already-public eTLD+1 of the breached service. */
  domain: string;
  /** ISO date (YYYY-MM-DD) of when the breach occurred. */
  breach_date: string;
  /** ISO timestamp of when HIBP indexed it. */
  added_date: string;
  /** Total accounts in the breach (HIBP "PwnCount"). */
  pwn_count: number;
  /** What leaked: "Email addresses", "Passwords", "IP addresses", … */
  data_classes: string[];
  is_verified: boolean;
  is_sensitive: boolean;
  is_retired: boolean;
}

export interface BreachExposureResult {
  /** true only when an HTTP call to HIBP actually completed (or returned 404). */
  email_checked: boolean;
  breaches: BreachExposureFinding[];
  /** Count of breaches whose DataClasses includes "Passwords". */
  high_severity_count: number;
  /** Set when we couldn't fully run the check. */
  reason_skipped?: 'no_api_key' | 'rate_limited' | 'api_error' | 'invalid_email';
  /** ISO date of the newest breach_date across all returned breaches. */
  most_recent_breach_at?: string;
}

const EmailSchema = z.string().email();

// Subset of the HIBP v3 BreachedAccount response we care about. We
// validate at the boundary so a schema drift on HIBP's side surfaces
// as an api_error rather than a TypeScript runtime crash inside the
// composite verdict computation.
const HibpBreachSchema = z.object({
  Name: z.string(),
  Domain: z.string(),
  BreachDate: z.string(),
  AddedDate: z.string(),
  PwnCount: z.number().nonnegative(),
  DataClasses: z.array(z.string()),
  IsVerified: z.boolean(),
  IsSensitive: z.boolean(),
  IsRetired: z.boolean(),
});
const HibpResponseSchema = z.array(HibpBreachSchema);

/** sha256 the email so Redis carries a non-reversible cache key. */
function cacheKeyFor(email: string): string {
  const digest = createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
  return `hibp:${digest}`;
}

/** Newest breach_date over the array, or undefined if empty. */
function mostRecentBreachDate(breaches: BreachExposureFinding[]): string | undefined {
  if (breaches.length === 0) return undefined;
  let max = breaches[0]!.breach_date;
  for (let i = 1; i < breaches.length; i++) {
    const d = breaches[i]!.breach_date;
    if (d > max) max = d;
  }
  return max;
}

/**
 * Query HIBP for breaches involving `email`. Caches both hits and
 * misses for 6h. The `httpFetch` opt exists purely for test stubbing
 * — production callers pass nothing and the global `fetch` is used.
 *
 * Never throws — returns a structured result with `reason_skipped`
 * on any failure so the compromise-check Promise.all sibling
 * detectors aren't taken out by a HIBP outage.
 */
export async function checkBreachExposure(
  email: string,
  opts?: { httpFetch?: typeof fetch },
): Promise<BreachExposureResult> {
  // 1) Validate email format BEFORE hashing or hitting the network.
  //    Prevents weird inputs (empty string, "null", whitespace) from
  //    burning a real HIBP round-trip.
  const parsed = EmailSchema.safeParse(email);
  if (!parsed.success) {
    return {
      email_checked: false,
      breaches: [],
      high_severity_count: 0,
      reason_skipped: 'invalid_email',
    };
  }
  const normalizedEmail = parsed.data.toLowerCase().trim();

  // 2) Graceful degradation when the operator hasn't purchased a
  //    key. Email Shield must work without HIBP — surfacing the
  //    skip reason lets iOS render the right copy.
  if (!config.HIBP_API_KEY) {
    return {
      email_checked: false,
      breaches: [],
      high_severity_count: 0,
      reason_skipped: 'no_api_key',
    };
  }

  // 3) Cache lookup. Cache covers both hits (breaches array) and
  //    misses (empty array) — both states are stable for the 6h TTL
  //    relative to a single compromise-check call.
  const key = cacheKeyFor(normalizedEmail);
  const cached = await cacheGet<BreachExposureResult>(key);
  if (cached) {
    return cached;
  }

  // 3a) Single-flight guard (adversarial-review fix). Two
  //     concurrent compromise-checks for the same email on a cold
  //     cache would BOTH hit HIBP otherwise — wasteful, and on the
  //     free tier the second one will 429. The per-(user, account)
  //     hourly cap already bounds same-user thrashing, but two
  //     users on a family plan sharing display_email, or a
  //     post-deploy cold-cache fan-out, will collide cross-user.
  //
  //     `cacheSetNX` is the atomic "first writer wins" — peers who
  //     fail to acquire return rate_limited so iOS can show "try
  //     again shortly" instead of triggering a second API call.
  //     5s TTL is enough for the in-flight call to complete and
  //     write the result cache; peers will then read the result
  //     from cache on retry.
  const inflightKey = `${key}:inflight`;
  const acquired = await cacheSetNX(inflightKey, 1, 5);
  if (!acquired) {
    return {
      email_checked: false,
      breaches: [],
      high_severity_count: 0,
      reason_skipped: 'rate_limited',
    };
  }

  // 4) Live HIBP call. truncateResponse=false returns the full
  //    Breach objects so we don't need a second lookup-per-breach
  //    round-trip for metadata.
  const httpFetch = opts?.httpFetch ?? fetch;
  const url = `${HIBP_BASE_URL}/${encodeURIComponent(normalizedEmail)}?truncateResponse=false`;

  let response: Response;
  try {
    response = await httpFetch(url, {
      method: 'GET',
      headers: {
        'hibp-api-key': config.HIBP_API_KEY,
        'User-Agent': HIBP_USER_AGENT,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    // Network-layer failure (DNS, TLS, timeout). Surface as
    // api_error — operator can retry next hour.
    captureError(err, { component: 'hibpBreachCheck.fetch' });
    return {
      email_checked: false,
      breaches: [],
      high_severity_count: 0,
      reason_skipped: 'api_error',
    };
  }

  // 404 is the HIBP "clean" signal — explicitly part of the API
  // contract, not an error. Cache it so a re-run within 6h doesn't
  // burn another round-trip.
  if (response.status === 404) {
    const result: BreachExposureResult = {
      email_checked: true,
      breaches: [],
      high_severity_count: 0,
    };
    await cacheSet(key, result, CACHE_TTL_SECONDS);
    return result;
  }

  // 429 — we hit the per-IP / per-key rate floor. Operator retries
  // next hour; the outer route's per-(user, account) cap means the
  // practical thrash is bounded.
  if (response.status === 429) {
    return {
      email_checked: false,
      breaches: [],
      high_severity_count: 0,
      reason_skipped: 'rate_limited',
    };
  }

  // Any non-200 outside 404/429 — 401 (bad key), 5xx (HIBP outage),
  // 403 (key revoked), etc. We collapse to a single api_error
  // surface because none of the granular codes need different iOS
  // copy; the operator dashboard via captureError sees the detail.
  // CRITICAL: do NOT include the API key in the context.
  if (response.status !== 200) {
    captureError(new Error(`hibp_unexpected_status_${response.status}`), {
      component: 'hibpBreachCheck',
      status: response.status,
    });
    return {
      email_checked: false,
      breaches: [],
      high_severity_count: 0,
      reason_skipped: 'api_error',
    };
  }

  // 200 — parse the breach array. Schema-validate at the boundary
  // so HIBP renaming a field doesn't crash downstream consumers.
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    captureError(err, { component: 'hibpBreachCheck.parse_json' });
    return {
      email_checked: false,
      breaches: [],
      high_severity_count: 0,
      reason_skipped: 'api_error',
    };
  }
  const validated = HibpResponseSchema.safeParse(raw);
  if (!validated.success) {
    captureError(new Error('hibp_schema_drift'), {
      component: 'hibpBreachCheck.parse_schema',
      issues: validated.error.flatten(),
    });
    return {
      email_checked: false,
      breaches: [],
      high_severity_count: 0,
      reason_skipped: 'api_error',
    };
  }

  const breaches: BreachExposureFinding[] = validated.data.map((b) => ({
    breach_name: b.Name,
    domain: b.Domain,
    breach_date: b.BreachDate,
    added_date: b.AddedDate,
    pwn_count: b.PwnCount,
    data_classes: b.DataClasses,
    is_verified: b.IsVerified,
    is_sensitive: b.IsSensitive,
    is_retired: b.IsRetired,
  }));

  // High-severity = the breach actually leaked Passwords (not just
  // emails / phone numbers / DOB). Used by iOS to render the urgent
  // "change your password now" CTA vs the milder "your email
  // appeared in a directory leak" copy.
  const high_severity_count = breaches.filter((b) =>
    b.data_classes.includes('Passwords'),
  ).length;

  const result: BreachExposureResult = {
    email_checked: true,
    breaches,
    high_severity_count,
    most_recent_breach_at: mostRecentBreachDate(breaches),
  };

  await cacheSet(key, result, CACHE_TTL_SECONDS);
  return result;
}
