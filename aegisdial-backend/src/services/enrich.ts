import { config } from '../config.js';
import { inferLineType } from '../lib/phone.js';
import type { Attestation, LineType } from '../types.js';

export interface TwilioLookupResult {
  carrier: string | null;
  line_type: LineType;
  attestation: Attestation | null;
  caller_name: string | null;
}

const EMPTY: TwilioLookupResult = {
  carrier: null,
  line_type: 'unknown',
  attestation: null,
  caller_name: null,
};

export async function twilioLookup(e164: string): Promise<TwilioLookupResult> {
  if (
    !config.ENABLE_TWILIO_LOOKUP ||
    !config.TWILIO_ACCOUNT_SID ||
    !config.TWILIO_AUTH_TOKEN
  ) {
    return EMPTY;
  }

  const url = new URL(
    `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}`,
  );
  url.searchParams.set('Fields', 'line_type_intelligence,caller_name');

  const auth = Buffer.from(
    `${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`,
  ).toString('base64');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: controller.signal,
    });
    if (!res.ok) return EMPTY;
    const data = (await res.json()) as {
      line_type_intelligence?: {
        type?: string;
        carrier_name?: string;
      };
      caller_name?: {
        caller_name?: string;
      };
    };
    return {
      carrier: data.line_type_intelligence?.carrier_name ?? null,
      line_type: inferLineType(data.line_type_intelligence?.type),
      attestation: null,
      caller_name: data.caller_name?.caller_name ?? null,
    };
  } catch {
    return EMPTY;
  } finally {
    clearTimeout(timeout);
  }
}
