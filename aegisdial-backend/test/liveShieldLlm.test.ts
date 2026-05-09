import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';

// Dynamic import — deferred until AFTER env setup (static imports hoist
// and would trigger config.ts validation before our env vars are set).
const {
  parseVerdict,
  mergeScores,
  shouldFireLlm,
  LLM_TRIGGER_THRESHOLD,
  FAMILY_ALERT_THRESHOLD,
} = await import('../src/services/liveShieldLlm.ts');

// liveShieldLlm — pure-function tests for the parsing and scoring logic
// inside the hybrid risk engine. The Anthropic round-trip itself is
// integration-tested elsewhere; these tests cover the deterministic
// pieces that are easy to break.

describe('parseVerdict', () => {
  it('parses a clean JSON verdict', () => {
    const v = parseVerdict(JSON.stringify({
      score: 87,
      scam_type: 'irs_impersonation',
      coaching_line: 'They are pretending to be the IRS. Hang up.',
    }));
    assert.ok(v);
    assert.equal(v!.score, 87);
    assert.equal(v!.scam_type, 'irs_impersonation');
    assert.equal(v!.coaching_line, 'They are pretending to be the IRS. Hang up.');
  });

  it('strips markdown fences the model added by mistake', () => {
    const wrapped = '```json\n' + JSON.stringify({
      score: 50,
      scam_type: 'tech_support',
      coaching_line: 'Say no.',
    }) + '\n```';
    const v = parseVerdict(wrapped);
    assert.ok(v);
    assert.equal(v!.score, 50);
  });

  it('clamps score to [0, 100]', () => {
    const lo = parseVerdict(JSON.stringify({ score: -5, scam_type: 'unknown', coaching_line: '' }));
    assert.equal(lo!.score, 0);
    const hi = parseVerdict(JSON.stringify({ score: 150, scam_type: 'unknown', coaching_line: '' }));
    assert.equal(hi!.score, 100);
  });

  it('rounds fractional scores', () => {
    const v = parseVerdict(JSON.stringify({ score: 73.6, scam_type: 'unknown', coaching_line: '' }));
    assert.equal(v!.score, 74);
  });

  it('truncates coaching_line to 200 chars', () => {
    const long = 'a'.repeat(500);
    const v = parseVerdict(JSON.stringify({ score: 50, scam_type: 'unknown', coaching_line: long }));
    assert.equal(v!.coaching_line.length, 200);
  });

  it('rejects unknown scam_type values (model hallucinated a label)', () => {
    const v = parseVerdict(JSON.stringify({
      score: 50,
      scam_type: 'made_up_scam_label',
      coaching_line: 'Hi',
    }));
    assert.equal(v, null);
  });

  it('rejects malformed JSON', () => {
    assert.equal(parseVerdict('not json at all'), null);
    assert.equal(parseVerdict(''), null);
    assert.equal(parseVerdict('{"score": 50,'), null);
  });

  it('rejects missing required fields', () => {
    assert.equal(parseVerdict(JSON.stringify({ score: 50 })), null);
    assert.equal(parseVerdict(JSON.stringify({ scam_type: 'unknown' })), null);
    assert.equal(parseVerdict(JSON.stringify({ score: 50, scam_type: 'unknown' })), null);
  });

  it('rejects wrong types on required fields', () => {
    assert.equal(parseVerdict(JSON.stringify({
      score: '50', // string instead of number
      scam_type: 'unknown',
      coaching_line: 'Hi',
    })), null);
  });

  it('accepts the full taxonomy', () => {
    for (const t of [
      'irs_impersonation', 'ssa_impersonation', 'law_enforcement_impersonation',
      'bank_impersonation', 'medicare_impersonation', 'utility_shutoff',
      'tech_support', 'gift_card_scam', 'wire_transfer_scam',
      'grandchild_emergency', 'ai_voice_clone_family', 'romance_scam',
      'crypto_scam', 'investment_scam', 'package_redelivery',
      'unpaid_toll', 'employment_scam', 'unknown',
    ]) {
      const v = parseVerdict(JSON.stringify({ score: 50, scam_type: t, coaching_line: 'x' }));
      assert.ok(v, `taxonomy entry rejected: ${t}`);
    }
  });
});

describe('mergeScores', () => {
  it('returns regex score when LLM is null (LLM never ran)', () => {
    assert.equal(mergeScores(60, null), 60);
    assert.equal(mergeScores(0, null), 0);
  });

  it('LLM can escalate above regex', () => {
    // regex 60, llm 80 → max(60, round(80*0.95)=76) = 76
    assert.equal(mergeScores(60, 80), 76);
  });

  it('LLM cannot demote regex (regex floor holds)', () => {
    // regex 70, llm 30 → max(70, round(30*0.95)=29) = 70
    assert.equal(mergeScores(70, 30), 70);
  });

  it('handles equal regex and LLM (regex slightly authoritative)', () => {
    // regex 60, llm 60 → max(60, 57) = 60. Regex wins.
    assert.equal(mergeScores(60, 60), 60);
  });

  it('LLM at 100 escalates correctly', () => {
    assert.equal(mergeScores(50, 100), 95);
  });

  it('cross-threshold scenarios', () => {
    // regex below trigger, llm null → regex wins
    assert.equal(mergeScores(40, null), 40);
    // regex above trigger but below alert, llm escalates to alert range
    assert.equal(mergeScores(55, 80), 76);
    // both below alert
    assert.equal(mergeScores(40, 50), 48);
    // regex below trigger threshold, llm null
    assert.equal(mergeScores(20, null), 20);
  });
});

describe('shouldFireLlm', () => {
  it('fires when never called before', () => {
    assert.equal(shouldFireLlm(null), true);
  });

  it('does not fire when within debounce window', () => {
    const recent = new Date(Date.now() - 1000); // 1s ago
    assert.equal(shouldFireLlm(recent), false);
  });

  it('fires when outside the debounce window', () => {
    const old = new Date(Date.now() - 10_000); // 10s ago
    assert.equal(shouldFireLlm(old), true);
  });

  it('does not fire exactly at debounce boundary minus one ms', () => {
    const justInside = new Date(Date.now() - 7_999);
    assert.equal(shouldFireLlm(justInside), false);
  });
});

describe('threshold constants', () => {
  // These are referenced in COMPANY_OS.md and LIVE_SHIELD.md — pinned
  // here so a careless change to either constant breaks the test before
  // it breaks the locked product spec.
  it('LLM_TRIGGER_THRESHOLD is 50', () => {
    assert.equal(LLM_TRIGGER_THRESHOLD, 50);
  });
  it('FAMILY_ALERT_THRESHOLD is 75', () => {
    assert.equal(FAMILY_ALERT_THRESHOLD, 75);
  });
});
