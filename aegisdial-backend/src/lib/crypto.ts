import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { config } from '../config.js';

// AES-256-GCM envelope encryption for PII at rest. We keep the scheme simple
// and auditable: one symmetric key (config.DATA_ENCRYPTION_KEY, 32 bytes
// base64), random 12-byte IV per row, 16-byte auth tag appended.
//
// Wire format (versioned so we can rotate):
//   v1:<iv_b64>:<tag_b64>:<ct_b64>
//
// Why not pgcrypto column-level encryption? Because the KEK then lives in
// postgresql.conf or a table, which leaks via pg_dump and Neon snapshots.
// Doing it at the app layer keeps the key out of the database entirely.

// Known dev default — matches the value in src/config.ts. In production we
// refuse to start if this is still the active key, because using a leaked
// value silently is catastrophic (every encrypted row would be readable by
// anyone with git access).
const DEV_DEFAULT_KEY = 'ZGV2LW9ubHkta2V5LWRvLW5vdC11c2UtaW4tcHJvZC1lbnYtMzI=';

const KEY = (() => {
  if (config.NODE_ENV === 'production' && config.DATA_ENCRYPTION_KEY === DEV_DEFAULT_KEY) {
    throw new Error(
      'FATAL: DATA_ENCRYPTION_KEY is still the dev default in production. ' +
        'Set a real key before boot: `fly secrets set DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)`. ' +
        'Refusing to start — every PII column would otherwise be encrypted with a publicly-known key.',
    );
  }
  const buf = Buffer.from(config.DATA_ENCRYPTION_KEY, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `DATA_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return buf;
})();

export function encryptString(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptString(envelope: string): string {
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('bad_envelope_format');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function encryptJSON(value: unknown): string {
  return encryptString(JSON.stringify(value));
}

export function decryptJSON<T = unknown>(envelope: string): T {
  return JSON.parse(decryptString(envelope)) as T;
}

// Best-effort read: if the column contains a legacy plaintext value
// (pre-migration) return it as-is; otherwise decrypt. Used during the brief
// transitional window when rows may be mixed.
export function readMaybeEncrypted(value: string | null): string | null {
  if (value == null) return value;
  if (value.startsWith('v1:')) return decryptString(value);
  return value;
}

// Integer helpers — wrap amount-style values for storage. We encrypt the
// stringified integer; on read we parse back to a number. Nullable in,
// nullable out: `null` round-trips unchanged so the absence of an amount
// stays distinguishable from zero.
export function encryptInt(value: number | null | undefined): string | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) throw new Error('encryptInt: non-finite value');
  return encryptString(String(Math.trunc(value)));
}

export function decryptInt(envelope: string | null | undefined): number | null {
  if (envelope == null) return null;
  if (!envelope.startsWith('v1:')) {
    // Legacy rows stored the integer as a plain string (or never used this
    // column). Try to parse — if it's not a number, treat as null.
    const n = Number(envelope);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(decryptString(envelope));
  return Number.isFinite(n) ? n : null;
}

export function readMaybeEncryptedJSON<T = unknown>(value: string | null): T | null {
  if (value == null) return value;
  if (value.startsWith('v1:')) return decryptJSON<T>(value);
  return JSON.parse(value) as T;
}

// SHA-256 hex — used for index/lookup columns that need to remain searchable
// when the display value is encrypted. Deterministic with a pepper so the
// hash isn't directly enumerable via rainbow tables.
const HASH_PEPPER = createHash('sha256')
  .update('aegisdial:v1:')
  .update(KEY)
  .digest();

export function indexHash(plain: string): string {
  return createHash('sha256')
    .update(HASH_PEPPER)
    .update(plain.trim().toLowerCase())
    .digest('hex');
}
