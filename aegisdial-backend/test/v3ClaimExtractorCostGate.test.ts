import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldExtract } from '../src/services/claimExtractor.ts';

// M-12 regression tests for the cost gate that short-circuits the
// LLM call when a chunk has zero claim-shaped content.
//
// The gate is asymmetric on purpose: aggressive on filler (cheap to
// skip), conservative on claims (never skip a real bank/agency/case
// mention). These tests pin both sides of the truth table.

describe('shouldExtract — filler / backchannel is skipped', () => {
  it('skips empty string', () => {
    assert.equal(shouldExtract(''), false);
  });

  it('skips short backchannel', () => {
    assert.equal(shouldExtract('uh huh'), false);
    assert.equal(shouldExtract('yeah'), false);
    assert.equal(shouldExtract('ok'), false);
  });

  it('skips a chunk just barely under the 12-char floor', () => {
    assert.equal(shouldExtract('ok sure ok'), false); // 10 chars
  });

  it('skips longer filler with no claim cues', () => {
    assert.equal(shouldExtract('yeah ok i hear you i understand'), false);
    assert.equal(shouldExtract('let me think about this for a moment'), false);
  });
});

describe('shouldExtract — claim-shaped chunks are kept', () => {
  it('keeps explicit bank claim', () => {
    assert.equal(
      shouldExtract("Hi, this is Wells Fargo's fraud department calling"),
      true,
    );
  });

  it('keeps explicit agency claim', () => {
    assert.equal(
      shouldExtract('This is the IRS Criminal Investigation Division'),
      true,
    );
    assert.equal(
      shouldExtract("I'm calling from the Department of Treasury"),
      true,
    );
  });

  it('keeps case-number mentions', () => {
    assert.equal(
      shouldExtract('Your case number is 47291 in our system'),
      true,
    );
  });

  it('keeps account-tail mentions', () => {
    assert.equal(
      shouldExtract('Your account ending in 4-7-2-1 was flagged'),
      true,
    );
  });

  it('keeps employee-identity claims', () => {
    assert.equal(
      shouldExtract("My name is John Williams and I'm an officer"),
      true,
    );
    assert.equal(shouldExtract("I'm Agent Smith calling from the FBI"), true);
  });

  it('keeps any chunk with a 3+ digit run', () => {
    // Account numbers, case numbers, transaction IDs all surface as
    // digit runs even when the surrounding language is sparse.
    assert.equal(shouldExtract('reference 47291 on file'), true);
  });

  it('keeps mid-sentence proper-noun pair (org name)', () => {
    assert.equal(
      shouldExtract('we work with Wells Fargo and Bank Of America on this'),
      true,
    );
  });
});

describe('shouldExtract — edge cases', () => {
  it('is case-insensitive on cue keywords', () => {
    assert.equal(shouldExtract('THIS IS THE BANK CALLING ABOUT FRAUD'), true);
    assert.equal(shouldExtract('the bank says your account is at risk'), true);
  });

  it('does not match standalone "the" or "is"', () => {
    assert.equal(
      shouldExtract('the call is going to be transferred now'),
      false,
    );
  });

  it('does not false-positive on a single capitalized first word', () => {
    // A leading capital is normal sentence-start, not a proper-noun pair.
    assert.equal(shouldExtract('Hello how are you doing today'), false);
  });
});
