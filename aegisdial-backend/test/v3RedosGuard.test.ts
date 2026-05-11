import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeRegexSource } from '../src/services/sentinelMatcher.ts';

// M-13 + adversarial follow-up regression tests for the ReDoS guard.
//
// The guard is the only thing standing between an admin (compromised
// or careless) and a worker stalled for minutes on a single chunk.
// These tests pin the truth table so future "simplifications" of the
// regex don't silently regress the protections.

describe('isSafeRegexSource — accepts realistic sentinel patterns', () => {
  it('accepts short phrase matchers', () => {
    assert.equal(isSafeRegexSource('social security number'), true);
    assert.equal(isSafeRegexSource('buy.*gift cards?'), true);
    assert.equal(isSafeRegexSource('\\bgift\\s+cards?\\b'), true);
  });

  it('accepts simple alternation (not inside a quantified group)', () => {
    // The alt-form ReDoS guard only fires when alternation is INSIDE
    // a quantified group. Bare alternation is fine.
    assert.equal(isSafeRegexSource('account|routing|wire'), true);
    assert.equal(isSafeRegexSource('(?:bank|credit union)'), true);
    assert.equal(isSafeRegexSource('(yes|no)'), true);
  });

  it('accepts bounded quantifiers inside groups', () => {
    // {n} (exact) is fine — the matcher has bounded work.
    assert.equal(isSafeRegexSource('(\\d){4}'), true);
  });

  it('accepts digit runs and character classes', () => {
    assert.equal(isSafeRegexSource('\\d{3,4}'), true);
    assert.equal(isSafeRegexSource('[0-9]{4}'), true);
  });
});

describe('isSafeRegexSource — rejects the classic nested-quantifier ReDoS family', () => {
  it('rejects (a+)+', () => {
    assert.equal(isSafeRegexSource('(a+)+'), false);
  });

  it('rejects (a*)*', () => {
    assert.equal(isSafeRegexSource('(a*)*'), false);
  });

  it('rejects (.*)+', () => {
    assert.equal(isSafeRegexSource('(.*)+'), false);
  });

  it('rejects (\\d{2,})*', () => {
    assert.equal(isSafeRegexSource('(\\d{2,})*'), false);
  });
});

describe('isSafeRegexSource — rejects the alt-form ReDoS family (adversarial follow-up)', () => {
  // These are the patterns the FIRST version of the guard let through.
  // The OWASP "alt-form" ReDoS: overlapping alternatives inside a
  // quantified group. Catastrophic backtracking on a non-match input.

  it('rejects (a|a)+ — overlap with itself', () => {
    assert.equal(isSafeRegexSource('(a|a)+'), false);
  });

  it('rejects (a|aa)+ — overlap of prefix', () => {
    assert.equal(isSafeRegexSource('(a|aa)+'), false);
  });

  it('rejects (.|a)+ — overlap with wildcard', () => {
    assert.equal(isSafeRegexSource('(.|a)+'), false);
  });

  it('rejects (call|caller|calling)+ — realistic-looking overlap', () => {
    assert.equal(isSafeRegexSource('(call|caller|calling)+'), false);
  });

  it('rejects (a|b)* (even without provable overlap — we reject conservatively)', () => {
    // The guard does NOT attempt overlap detection. Any alternation-
    // inside-quantified-group is rejected. Admins can rewrite as
    // `(?:a|b)` (no quantifier) or `(?:a|b)\\s+(?:a|b)?`.
    assert.equal(isSafeRegexSource('(a|b)*'), false);
  });

  it('rejects (a|b){2,} — unbounded quantifier', () => {
    assert.equal(isSafeRegexSource('(a|b){2,}'), false);
  });
});

describe('isSafeRegexSource — rejects misc dangerous shapes', () => {
  it('rejects empty source', () => {
    assert.equal(isSafeRegexSource(''), false);
  });

  it('rejects source longer than 200 chars', () => {
    assert.equal(isSafeRegexSource('a'.repeat(201)), false);
  });

  it('accepts source at exactly 200 chars', () => {
    assert.equal(isSafeRegexSource('a'.repeat(200)), true);
  });

  it('rejects excessive alternation (>50 pipes)', () => {
    const giant = Array(60).fill('x').join('|');
    assert.equal(isSafeRegexSource(giant), false);
  });

  it('rejects lookahead with quantifier inside', () => {
    assert.equal(isSafeRegexSource('(?=a+)'), false);
  });

  it('rejects lookbehind with quantifier inside', () => {
    assert.equal(isSafeRegexSource('(?<=a*)'), false);
  });
});
