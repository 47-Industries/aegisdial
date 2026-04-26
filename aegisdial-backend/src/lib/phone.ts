import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { LineType } from '../types.js';

export function normalizeE164(raw: string, country: string = 'US'): string | null {
  try {
    const parsed = parsePhoneNumberFromString(raw, country as CountryCode);
    if (!parsed || !parsed.isValid()) return null;
    return parsed.number;
  } catch {
    return null;
  }
}

export function inferLineType(twilioType: string | null | undefined): LineType {
  if (!twilioType) return 'unknown';
  switch (twilioType.toLowerCase()) {
    case 'mobile':
      return 'mobile';
    case 'voip':
    case 'nonfixedvoip':
    case 'fixedvoip':
      return 'voip';
    case 'landline':
    case 'fixed_line':
      return 'landline';
    case 'toll_free':
    case 'tollfree':
      return 'toll_free';
    default:
      return 'unknown';
  }
}
