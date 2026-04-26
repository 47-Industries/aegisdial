import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectPhrases } from '../src/lib/scamPhrases.ts';
import { scoreHits, scoreText } from '../src/services/liveShield.ts';

describe('detectPhrases', () => {
  it('detects the gift-card kill phrase', () => {
    const hits = detectPhrases('Please go to Walmart and buy Apple gift cards.');
    const ids = hits.map((h) => h.pattern.id);
    assert.ok(ids.includes('gift_cards'));
  });

  it('detects "safe account" bank-impersonation pattern', () => {
    const hits = detectPhrases('We need you to move your money to a safe account right now.');
    const ids = hits.map((h) => h.pattern.id);
    assert.ok(ids.includes('safe_account'));
    assert.ok(ids.includes('immediate_action'));
  });

  it('detects remote-access tool pretext', () => {
    const hits = detectPhrases('Please download AnyDesk so I can fix your computer.');
    assert.ok(hits.some((h) => h.pattern.id === 'remote_access_tools'));
  });

  it('detects isolation coaching', () => {
    const hits = detectPhrases(
      "Don't hang up the phone and don't tell the teller why you're withdrawing.",
    );
    const ids = hits.map((h) => h.pattern.id);
    assert.ok(ids.includes('dont_hang_up'));
    assert.ok(ids.includes('go_alone'));
  });

  it('detects OTP / verification code ask', () => {
    const hits = detectPhrases('I just sent you a 6-digit verification code — please read it back.');
    assert.ok(hits.some((h) => h.pattern.id === 'otp_code'));
  });

  it('detects SSA suspension scam', () => {
    const hits = detectPhrases('Your social security number has been suspended.');
    assert.ok(hits.some((h) => h.pattern.id === 'ssa_suspension'));
  });

  it('detects bail-money emergency pattern', () => {
    const hits = detectPhrases("I've been arrested and I need bail money.");
    const ids = hits.map((h) => h.pattern.id);
    assert.ok(ids.includes('arrested_need_bail'));
  });

  it('detects crypto payment ask', () => {
    const hits = detectPhrases('You need to deposit funds into our Bitcoin wallet.');
    assert.ok(hits.some((h) => h.pattern.id === 'crypto_payment'));
  });

  it('clean benign text produces no hits', () => {
    const hits = detectPhrases('Hello, how are you today? The weather is nice.');
    assert.equal(hits.length, 0);
  });
});

describe('scoreHits', () => {
  it('empty set scores 0 low', () => {
    const s = scoreHits([]);
    assert.equal(s.risk_score, 0);
    assert.equal(s.risk_level, 'low');
  });

  it('bank impersonation + wire + urgency + isolation is critical', () => {
    const text =
      "Hi, this is the fraud department. We've seen unauthorized charges on your account. " +
      "You need to wire the funds to a safe account right now — and don't hang up the phone " +
      "or don't tell the teller. We only have a few minutes.";
    const s = scoreText(text);
    assert.equal(s.risk_level, 'critical', `got ${s.risk_level} @ ${s.risk_score}`);
    assert.ok(s.risk_score >= 75, `got ${s.risk_score}`);
    assert.ok(s.triggered_categories.includes('impersonation_financial'));
    assert.ok(s.triggered_categories.includes('payment_fraud'));
    assert.ok(s.triggered_categories.includes('isolation'));
  });

  it('remote access + bank pretext flips to critical fast', () => {
    const text =
      'This is the fraud team at your bank. Please download AnyDesk so I can secure your account.';
    const s = scoreText(text);
    assert.ok(s.risk_score >= 75, `got ${s.risk_score}`);
    assert.equal(s.risk_level, 'critical');
  });

  it('grandchild emergency + money ask is critical', () => {
    const text =
      "Grandma it's me, I've been arrested and I need bail money. Please don't tell mom.";
    const s = scoreText(text);
    assert.ok(s.risk_score >= 75, `got ${s.risk_score}`);
    assert.equal(s.risk_level, 'critical');
  });

  it('mild urgency alone is not enough to flag', () => {
    const s = scoreText('Please call back within the hour, thanks.');
    assert.ok(s.risk_score < 25, `got ${s.risk_score}`);
    assert.equal(s.risk_level, 'low');
  });

  it('dedup: same pattern hit twice counts once', () => {
    const a = scoreText('gift card gift card gift card');
    const b = scoreText('gift card');
    assert.equal(a.risk_score, b.risk_score);
  });
});
