import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractPhoneNumbers, windowSnippet } from '../src/crawlers/phone.ts';

describe('extractPhoneNumbers', () => {
  it('extracts a clean formatted number', () => {
    const r = extractPhoneNumbers('Got a call from (415) 555-1234 claiming to be IRS.');
    assert.deepEqual(r, ['+14155551234']);
  });

  it('handles dot and dash formats', () => {
    const r = extractPhoneNumbers('Call 415.555.1234 or 415-555-1234 or 4155551234');
    assert.deepEqual(r, ['+14155551234']);
  });

  it('handles +1 prefix', () => {
    const r = extractPhoneNumbers('Number: +1 800 432 1000, do not answer');
    assert.deepEqual(r, ['+18004321000']);
  });

  it('ignores obvious non-numbers', () => {
    const r = extractPhoneNumbers('Years 1989 and 2023 are not phones. But 800-432-1000 is.');
    assert.deepEqual(r, ['+18004321000']);
  });

  it('extracts multiple unique numbers', () => {
    const r = extractPhoneNumbers('First (212) 555-1212, also +1 646-555-9999');
    assert.deepEqual(r.sort(), ['+12125551212', '+16465559999']);
  });

  it('does not include numbers starting with 0 or 1', () => {
    const r = extractPhoneNumbers('Fake 115-555-1234 and 015-555-1234');
    assert.deepEqual(r, []);
  });
});

describe('windowSnippet', () => {
  it('returns a window around a match', () => {
    const txt = 'a'.repeat(200) + 'target' + 'b'.repeat(200);
    const w = windowSnippet(txt, 'target', 50);
    assert.ok(w.includes('target'));
    assert.ok(w.length <= 50 + 50 + 'target'.length + 5);
  });
});
