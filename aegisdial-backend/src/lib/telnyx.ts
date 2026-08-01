// Telnyx client — SMS + Number Lookup.
//
// Why Telnyx: voice ~$0.002/min vs Twilio ~$0.0085/min inbound, and the call
// screener burns inbound minutes on every screened call, so the per-minute gap
// is the dominant unit cost at scale. Number Lookup is ~$0.003 vs Twilio's
// ~$0.015 combined (line type + CNAM), i.e. the same 3-5x gap.
//
// This module is the low-risk half of TELNYX_MIGRATION.md (steps 1 and 2):
// pure REST swaps, no TeXML. Voice (step 3) is deliberately NOT here — that
// piece must be built and verified against the live API with a real ordered
// number, because a wrong webhook wiring means a dropped call, and that call
// is somebody's grandmother.
//
// Every function fails soft: missing creds or a non-2xx response returns
// false/empty rather than throwing, so a half-configured Telnyx account can
// never take down an escalation run or a lookup. The caller decides which
// provider to use (config.CALL_PROVIDER); this file never decides for them.

import { config } from '../config.js';
import { captureError } from './observability.js';

const TELNYX_API = 'https://api.telnyx.com/v2';

/** True when the minimum SMS credentials exist. Cheap enough to call per-send. */
export function telnyxSmsConfigured(): boolean {
  return Boolean(config.TELNYX_API_KEY && config.TELNYX_MESSAGING_FROM);
}

/** True when a lookup can be attempted (API key is the only requirement). */
export function telnyxLookupConfigured(): boolean {
  return Boolean(config.TELNYX_API_KEY);
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.TELNYX_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

// ---------- SMS ----------
//
// Docs: https://developers.telnyx.com/api/messaging/send-message
// POST /v2/messages  { from, to, text, messaging_profile_id? }
//
// Mirrors sendTwilioSms's contract exactly: resolves true on success, false on
// any non-2xx, and never throws for a delivery-level failure. That symmetry is
// what lets the escalator switch providers with a single ternary.

export async function sendTelnyxSms(args: { to: string; body: string }): Promise<boolean> {
  if (!telnyxSmsConfigured()) {
    captureError(new Error('telnyx_sms_not_configured'), {
      component: 'telnyx.sms',
    });
    return false;
  }

  const payload: Record<string, string> = {
    from: config.TELNYX_MESSAGING_FROM!,
    to: args.to,
    text: args.body,
  };
  // Optional: Telnyx groups outbound numbers under a Messaging Profile. When
  // the profile is set explicitly Telnyx uses it for routing/number-pool
  // selection; when it isn't, the profile that owns `from` is used implicitly.
  if (config.TELNYX_MESSAGING_PROFILE_ID) {
    payload.messaging_profile_id = config.TELNYX_MESSAGING_PROFILE_ID;
  }

  try {
    const res = await fetch(`${TELNYX_API}/messages`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // 4xx here = bad number, opted-out recipient, unfunded account. All are
      // "skip this one", not "abort the run". Body is captured for debugging
      // but never surfaced to a user.
      const text = await res.text().catch(() => '');
      captureError(new Error(`telnyx_sms_${res.status}`), {
        component: 'telnyx.sms',
        status: res.status,
        body: text.slice(0, 200),
      });
      return false;
    }
    return true;
  } catch (err) {
    captureError(err, { component: 'telnyx.sms.network' });
    return false;
  }
}

// ---------- Number Lookup ----------
//
// Docs: https://developers.telnyx.com/api/number-lookup/number-lookup
// GET /v2/number_lookup/{e164}?type=carrier&type=caller-name
//
// `type` is repeatable — carrier gives line type + carrier name, caller-name
// gives CNAM. Requesting both in one call keeps it to a single round trip,
// unlike Twilio Lookup where the two Fields are billed and fetched together
// anyway.

export interface TelnyxLookupResult {
  owner_name: string | null;
  line_type: string | null;
  carrier_name: string | null;
  country_code: string | null;
  ok: boolean;
}

const EMPTY_LOOKUP: TelnyxLookupResult = {
  owner_name: null,
  line_type: null,
  carrier_name: null,
  country_code: null,
  ok: false,
};

export async function telnyxNumberLookup(e164: string): Promise<TelnyxLookupResult> {
  if (!telnyxLookupConfigured()) return EMPTY_LOOKUP;

  const url = new URL(`${TELNYX_API}/number_lookup/${encodeURIComponent(e164)}`);
  url.searchParams.append('type', 'carrier');
  url.searchParams.append('type', 'caller-name');

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${config.TELNYX_API_KEY}` },
      // Same 2.5s budget as the Twilio lookup — this sits in the hot path of a
      // live call screen, so a slow provider must lose rather than stall.
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) {
      captureError(new Error(`telnyx_lookup_${res.status}`), {
        component: 'telnyx.lookup',
        status: res.status,
      });
      return EMPTY_LOOKUP;
    }
    const json = (await res.json()) as TelnyxLookupResponse;
    const d = json.data;
    if (!d) return EMPTY_LOOKUP;

    // Telnyx returns caller_name.caller_name, and mirrors Twilio's convention
    // of using the literal string "unknown" when CNAM has no record — which
    // must become null, not a caller literally named "unknown".
    const rawName = d.caller_name?.caller_name?.trim();
    const ownerName =
      rawName && rawName.toLowerCase() !== 'unknown' ? rawName : null;

    return {
      owner_name: ownerName,
      line_type: mapTelnyxLineType(d.carrier?.type),
      carrier_name: d.carrier?.name ?? null,
      country_code: d.country_code ?? null,
      ok: true,
    };
  } catch {
    return EMPTY_LOOKUP;
  }
}

/**
 * Telnyx carrier.type vocabulary → our internal LineType strings.
 *
 * Telnyx uses a coarser set than Twilio: it reports `voip` without splitting
 * fixed/non-fixed, so both of Twilio's VoIP variants collapse to the same
 * value we already emit. Toll-free is not a carrier `type` in Telnyx's schema
 * (it surfaces as a landline with a toll-free carrier), so the caller keeps
 * relying on prefix detection for that — noted rather than faked.
 */
function mapTelnyxLineType(raw: string | undefined): string {
  switch ((raw ?? '').toLowerCase()) {
    case 'mobile':
      return 'mobile';
    case 'landline':
    case 'fixed line':
    case 'fixed_line':
      return 'landline';
    case 'voip':
      return 'voip';
    case 'toll free':
    case 'toll_free':
      return 'toll_free';
    default:
      return 'unknown';
  }
}

interface TelnyxLookupResponse {
  data?: {
    country_code?: string;
    phone_number?: string;
    carrier?: {
      name?: string;
      type?: string;
      mobile_country_code?: string;
      mobile_network_code?: string;
    };
    caller_name?: {
      caller_name?: string;
      caller_type?: string;
    };
  };
}
