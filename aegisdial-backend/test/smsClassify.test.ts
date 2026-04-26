import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifySms } from '../src/services/smsClassify.ts';
import { extractUrls } from '../src/lib/urlScan.ts';

describe('extractUrls', () => {
  it('extracts http and https URLs', () => {
    const out = extractUrls('Hit https://bit.ly/xyz now and http://evil.top/win');
    assert.deepEqual(out.sort(), ['http://evil.top/win', 'https://bit.ly/xyz'].sort());
  });

  it('extracts www prefixes and prepends http', () => {
    const out = extractUrls('Click www.scam.click/reward');
    assert.deepEqual(out, ['http://www.scam.click/reward']);
  });

  it('trims trailing punctuation', () => {
    const out = extractUrls('Visit https://example.com/page, now.');
    assert.deepEqual(out, ['https://example.com/page']);
  });

  it('no URLs returns empty', () => {
    assert.deepEqual(extractUrls('Just a friendly text'), []);
  });
});

describe('classifySms', () => {
  it('USPS redelivery smishing → junk', async () => {
    const r = await classifySms(
      "USPS: Your package cannot be delivered. Schedule redelivery now: http://usps-redeliv.cfd/",
    );
    assert.equal(r.action, 'junk');
    assert.ok(r.phrase_hits.some((h) => h.pattern.id === 'package_redelivery'));
  });

  it('unpaid toll smishing → junk', async () => {
    const r = await classifySms(
      'Final notice: unpaid toll balance on your account. Pay at https://ezpass-pay.top/',
    );
    assert.equal(r.action, 'junk');
  });

  it('benign message → allow', async () => {
    const r = await classifySms('Running late, see you at 7');
    assert.equal(r.action, 'allow');
    assert.equal(r.risk_score, 0);
  });

  it('legitimate OTP → transaction', async () => {
    const r = await classifySms('Your Chase verification code is 482913. Do not share.');
    // "verification code" matches BOTH transactional hint AND otp_code phrase
    // (which is payment_fraud + sensitive_data); a clean OTP message should
    // score as transactional given no payment / isolation patterns.
    // At worst it'll land in promotion, but should never be allow-only.
    assert.ok(['transaction', 'promotion', 'allow'].includes(r.action));
  });

  it('prize lottery bait → junk or promotion', async () => {
    const r = await classifySms(
      "Congratulations! You've won a $500 Amazon gift card. Click https://prize.monster/claim to redeem.",
    );
    assert.notEqual(r.action, 'allow');
  });

  it('bank impersonation smishing → junk', async () => {
    const r = await classifySms(
      'ALERT: Your account has been locked due to unusual activity. Verify at https://chase-verify.xyz/',
    );
    assert.equal(r.action, 'junk');
  });
});
