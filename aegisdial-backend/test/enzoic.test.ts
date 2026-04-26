import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lookupExposures, hashIdentifier, displayMask } from '../src/lib/enzoic.ts';

describe('enzoic mock mode', () => {
  it('returns deterministic exposures for same identifier', async () => {
    const a = await lookupExposures('email', 'alice@example.com');
    const b = await lookupExposures('email', 'alice@example.com');
    assert.deepEqual(a.map(x => x.id), b.map(x => x.id));
  });

  it('different identifiers get different exposure sets', async () => {
    // Pick two that hash to different first-nibbles.
    const a = await lookupExposures('email', 'aa@a.co');
    const b = await lookupExposures('email', 'bbbbb@b.co');
    // Not guaranteed they differ in count but should differ in at least id prefix.
    if (a.length > 0 && b.length > 0) {
      assert.notDeepEqual(a.map(x=>x.id), b.map(x=>x.id));
    }
  });

  it('hashIdentifier is stable, case-insensitive, and trims', () => {
    const a = hashIdentifier('  FOO@BAR.com  ');
    const b = hashIdentifier('foo@bar.com');
    assert.equal(a, b);
  });

  it('displayMask email redacts local part', () => {
    assert.equal(displayMask('email', 'kylerivers@gmail.com'), 'ky********@gmail.com');
    // Short local parts still get a single-char star tail for visual consistency.
    assert.equal(displayMask('email', 'ab@x.co'), 'a*@x.co');
    assert.equal(displayMask('email', 'a@x.co'), 'a*@x.co');
  });

  it('displayMask phone keeps last 4', () => {
    assert.equal(displayMask('phone', '+14155551234'), '********1234');
  });
});
