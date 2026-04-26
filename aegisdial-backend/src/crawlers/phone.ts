import { normalizeE164 } from '../lib/phone.js';

const US_PHONE_REGEX =
  /(?:\+?1[\s\-.]?)?\(?([2-9]\d{2})\)?[\s\-.]?([2-9]\d{2})[\s\-.]?(\d{4})/g;

export function extractPhoneNumbers(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(US_PHONE_REGEX)) {
    const raw = `+1${match[1]}${match[2]}${match[3]}`;
    const e164 = normalizeE164(raw, 'US');
    if (e164) {
      found.add(e164);
    }
  }
  return [...found];
}

export function windowSnippet(text: string, match: string, radius: number = 150): string {
  const idx = text.indexOf(match);
  if (idx < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + match.length + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}
