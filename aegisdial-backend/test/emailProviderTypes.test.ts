import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Smoke test for the Email Shield provider boundary.
// Phase 2 ships types + error classes; no provider implementations
// yet. This test pins the public API surface so a future refactor
// that renames or drops one of these surfaces gets caught.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-email-types';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://email-types';

const types = await import('../src/services/email/types.ts');

describe('Email Shield provider boundary — types + errors', () => {
  it('exports RevokedError with the right shape', () => {
    const e = new types.RevokedError('gmail', 'token expired and no refresh');
    assert.equal(e.name, 'RevokedError');
    assert.equal(e.provider, 'gmail');
    assert.ok(e instanceof Error);
    assert.match(e.message, /token expired/);
  });

  it('RevokedError default message references the provider', () => {
    const e = new types.RevokedError('microsoft');
    assert.match(e.message, /microsoft account access revoked/);
  });

  it('exports TransientError distinct from RevokedError', () => {
    const e = new types.TransientError('imap', 'connection timed out');
    assert.equal(e.name, 'TransientError');
    assert.equal(e.provider, 'imap');
    assert.ok(!(e instanceof types.RevokedError));
  });

  it('RevokedError is the only error type that flips status to revoked', () => {
    // Documented invariant in the EmailProvider interface JSDoc.
    // The worker code (P6) MUST distinguish RevokedError from
    // TransientError — TransientError does NOT flip status.
    const revoked = new types.RevokedError('gmail');
    const transient = new types.TransientError('gmail');
    assert.notEqual(revoked.constructor, transient.constructor);
  });
});
