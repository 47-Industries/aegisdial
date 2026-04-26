import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMention } from '../src/crawlers/sentiment.ts';

describe('classifyMention', () => {
  it('flags obvious scam language as negative with high weight', () => {
    const r = classifyMention(
      'This number is a scam! They said I had a warrant and demanded gift cards immediately.',
    );
    assert.equal(r.sentiment, 'negative');
    assert.ok(r.weight >= 0.7);
    assert.ok(r.severity >= 3);
  });

  it('flags robocall language', () => {
    const r = classifyMention('Got a robocall from this number three times today.');
    assert.equal(r.sentiment, 'negative');
    assert.equal(r.scam_category, 'robocall');
  });

  it('flags IRS impersonation', () => {
    const r = classifyMention('Called claiming to be IRS demanding back taxes.');
    assert.equal(r.sentiment, 'negative');
    assert.equal(r.scam_category, 'impersonation');
  });

  it('marks self-posted numbers as positive', () => {
    const r = classifyMention('This is my own number, call me at (415) 555-1234 for sales questions');
    assert.equal(r.sentiment, 'positive');
  });

  it('returns neutral for innocuous text', () => {
    const r = classifyMention('The conference room is located on the second floor.');
    assert.equal(r.sentiment, 'neutral');
  });

  it('returns mild negative for single spam keyword', () => {
    const r = classifyMention('This is spam');
    assert.equal(r.sentiment, 'negative');
    assert.equal(r.scam_category, 'spam');
  });
});
