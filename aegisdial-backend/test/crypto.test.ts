import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// IMPORTANT: tests import from src and therefore trigger config.ts, which
// requires DATA_ENCRYPTION_KEY and a handful of other env vars. We set them
// here before any src import happens (node --test loads files top-down).
process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';

const crypto = await import('../src/lib/crypto.ts');

describe('crypto.encryptString / decryptString', () => {
  it('round-trips a string exactly', () => {
    const plain = 'kyle@example.com';
    const ct = crypto.encryptString(plain);
    assert.notEqual(ct, plain);
    assert.ok(ct.startsWith('v1:'));
    assert.equal(crypto.decryptString(ct), plain);
  });

  it('two encryptions of same plaintext produce different ciphertexts (IV per call)', () => {
    const a = crypto.encryptString('same');
    const b = crypto.encryptString('same');
    assert.notEqual(a, b);
    assert.equal(crypto.decryptString(a), 'same');
    assert.equal(crypto.decryptString(b), 'same');
  });

  it('round-trips JSON', () => {
    const payload = { amount_cents: 420000, wallet: 'bc1q...', note: 'sent at 3:14pm' };
    const ct = crypto.encryptJSON(payload);
    assert.deepEqual(crypto.decryptJSON(ct), payload);
  });

  it('readMaybeEncrypted passes through legacy plaintext', () => {
    assert.equal(crypto.readMaybeEncrypted('ky***@gmail.com'), 'ky***@gmail.com');
  });

  it('readMaybeEncrypted decrypts v1 envelope', () => {
    const ct = crypto.encryptString('sensitive');
    assert.equal(crypto.readMaybeEncrypted(ct), 'sensitive');
  });

  it('tamper with ciphertext body fails auth', () => {
    const ct = crypto.encryptString('real');
    const parts = ct.split(':');
    // Flip a byte in the ciphertext segment.
    const bad = Buffer.from(parts[3]!, 'base64');
    bad[0] ^= 0xff;
    const tampered = `v1:${parts[1]}:${parts[2]}:${bad.toString('base64')}`;
    assert.throws(() => crypto.decryptString(tampered));
  });

  it('bad envelope format throws', () => {
    assert.throws(() => crypto.decryptString('not-an-envelope'));
    assert.throws(() => crypto.decryptString('v2:a:b:c'));
  });
});

describe('crypto.encryptInt / decryptInt', () => {
  it('round-trips positive integers', () => {
    const ct = crypto.encryptInt(125_000);
    assert.ok(ct);
    assert.ok(ct!.startsWith('v1:'));
    assert.equal(crypto.decryptInt(ct), 125_000);
  });

  it('round-trips zero', () => {
    const ct = crypto.encryptInt(0);
    assert.equal(crypto.decryptInt(ct), 0);
  });

  it('null in → null out', () => {
    assert.equal(crypto.encryptInt(null), null);
    assert.equal(crypto.encryptInt(undefined), null);
    assert.equal(crypto.decryptInt(null), null);
    assert.equal(crypto.decryptInt(undefined), null);
  });

  it('truncates floats (we store cents, never fractional)', () => {
    const ct = crypto.encryptInt(42.9);
    assert.equal(crypto.decryptInt(ct), 42);
  });

  it('rejects non-finite values', () => {
    assert.throws(() => crypto.encryptInt(Infinity));
    assert.throws(() => crypto.encryptInt(NaN));
  });

  it('legacy plaintext numeric string still decodes', () => {
    // Simulates a pre-migration row where the value was written as a
    // plain int and later read through decryptInt — must fall through.
    assert.equal(crypto.decryptInt('4200'), 4200);
  });

  it('legacy non-numeric plaintext → null', () => {
    assert.equal(crypto.decryptInt('not-a-number'), null);
  });
});

describe('crypto.indexHash', () => {
  it('is deterministic for the same input', () => {
    const a = crypto.indexHash('kyle@example.com');
    const b = crypto.indexHash('kyle@example.com');
    assert.equal(a, b);
  });

  it('normalizes case + whitespace', () => {
    const a = crypto.indexHash('Kyle@Example.com');
    const b = crypto.indexHash('  kyle@example.com  ');
    assert.equal(a, b);
  });

  it('different inputs produce different hashes', () => {
    assert.notEqual(crypto.indexHash('a@b.com'), crypto.indexHash('c@d.com'));
  });
});
