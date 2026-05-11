import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitiveDigits } from '../src/services/sentinelMatcher.ts';

// Reviewer's note from the original Phase 5 review:
//   "The matched_text from sentinel regex goes verbatim into the push
//    payload context — Mom's own SSN/card number digits could land in
//    guardian_alerts.payload plaintext. Not fixed in this PR, but
//    follow-up should redact to length-markers ('<<9 digits matched>>')."
//
// These tests pin the redactor's contract on every sentinel pattern
// shape that captures literal digits — SSN, card, MFA — plus the
// negative cases (intent-only patterns where there's nothing to
// redact).

describe('redactSensitiveDigits — SSN-shaped input', () => {
  it('redacts 9 contiguous digits', () => {
    assert.equal(redactSensitiveDigits('123456789'), '<<9 digits>>');
  });

  it('redacts SSN with dashes (XXX-XX-XXXX form)', () => {
    assert.equal(redactSensitiveDigits('123-45-6789'), '<<9 digits>>');
  });

  it('redacts SSN with spaces (spoken-aloud form)', () => {
    assert.equal(redactSensitiveDigits('1 2 3 4 5 6 7 8 9'), '<<9 digits>>');
  });

  it('preserves surrounding context', () => {
    assert.equal(
      redactSensitiveDigits('my social is 123-45-6789'),
      'my social is <<9 digits>>',
    );
  });
});

describe('redactSensitiveDigits — card-shaped input', () => {
  it('redacts 16 contiguous digits', () => {
    assert.equal(
      redactSensitiveDigits('4111111111111111'),
      '<<16 digits>>',
    );
  });

  it('redacts card with standard 4-4-4-4 grouping', () => {
    assert.equal(
      redactSensitiveDigits('4111 1111 1111 1111'),
      '<<16 digits>>',
    );
  });

  it('redacts card with dashes', () => {
    assert.equal(
      redactSensitiveDigits('4111-1111-1111-1111'),
      '<<16 digits>>',
    );
  });
});

describe('redactSensitiveDigits — MFA-shaped input', () => {
  it('redacts 6 contiguous digits', () => {
    assert.equal(redactSensitiveDigits('847291'), '<<6 digits>>');
  });

  it('redacts 4 contiguous digits (lower threshold)', () => {
    assert.equal(redactSensitiveDigits('1234'), '<<4 digits>>');
  });
});

describe('redactSensitiveDigits — does NOT redact short numeric content', () => {
  it('leaves 1-digit content alone', () => {
    assert.equal(redactSensitiveDigits('I have 1 phone'), 'I have 1 phone');
  });

  it('leaves 2-digit content alone', () => {
    assert.equal(redactSensitiveDigits('age 47'), 'age 47');
  });

  it('leaves 3-digit content alone (preserves area codes / count words)', () => {
    assert.equal(redactSensitiveDigits('about 100 dollars'), 'about 100 dollars');
  });
});

describe('redactSensitiveDigits — voluntary-phrase patterns (no digits)', () => {
  // These sentinel patterns capture INTENT, not data — there's
  // nothing to redact, and the verbatim text should pass through.
  it('passes "my card number is" unchanged', () => {
    assert.equal(
      redactSensitiveDigits('my card number is'),
      'my card number is',
    );
  });

  it('passes "the password is" unchanged', () => {
    assert.equal(
      redactSensitiveDigits('the password is'),
      'the password is',
    );
  });
});

describe('redactSensitiveDigits — multiple runs and edge cases', () => {
  it('redacts multiple digit runs independently', () => {
    assert.equal(
      redactSensitiveDigits('123456789 and also 4111-1111-1111-1111'),
      '<<9 digits>> and also <<16 digits>>',
    );
  });

  it('preserves a 3-digit run between two long runs', () => {
    // Three digits stays — but the longer runs get redacted.
    assert.equal(
      redactSensitiveDigits('123456789, then 123, then 1111111111111111'),
      '<<9 digits>>, then 123, then <<16 digits>>',
    );
  });

  it('handles empty string', () => {
    assert.equal(redactSensitiveDigits(''), '');
  });

  // Adversarial-pass MEDIUM-4 follow-ups: realistic STT shapes
  // that the seventh-pass review flagged as untested.

  it('redacts mixed-separator phone-shaped input', () => {
    assert.equal(
      redactSensitiveDigits('123 456-7890'),
      '<<10 digits>>',
    );
  });

  it('merges two 4-digit groups with single-space separator', () => {
    assert.equal(redactSensitiveDigits('1234 5678'), '<<8 digits>>');
  });

  it('redacts STT double-space form (defensive widening)', () => {
    // STT often inserts 2-3 spaces at speech pauses. The original
    // separator class `[\s-]?` (single-char only) would have split
    // this into "123" + "<<6 digits>>"; the widened `[\s-]{0,3}`
    // merges them correctly.
    assert.equal(
      redactSensitiveDigits('123  456789'),
      '<<9 digits>>',
    );
  });

  it('redacts 4-digit year — accepted false-positive per docstring', () => {
    // The threshold of 4 catches MFA codes (the floor of useful
    // digit-PII) at the cost of redacting 4-digit years. Doc-
    // matches-code: this WILL redact, and that's accepted.
    assert.equal(
      redactSensitiveDigits('year 2024 was good'),
      'year <<4 digits>> was good',
    );
  });
});
