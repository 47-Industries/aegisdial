import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeScore } from '../src/services/score.ts';
import type { NumberSignals } from '../src/types.ts';

const baseSignals: NumberSignals = {
  mention_count_30d: 0,
  mention_count_all: 0,
  negative_sentiment_ratio: 0,
  complaint_sources: 0,
  first_seen: null,
  last_seen: null,
  stir_shaken_attestation: null,
  carrier: null,
  line_type: 'unknown',
  number_age_days: null,
  business_match: null,
  spoof_reports_30d: 0,
};

describe('computeScore', () => {
  it('clean unknown number scores in unknown band', () => {
    const r = computeScore({ e164: '+14155550100', signals: baseSignals });
    assert.ok(r.trust_score >= 50 && r.trust_score < 80, `got ${r.trust_score}`);
    assert.equal(r.verdict, 'unknown');
  });

  it('heavy scam signals flip to likely_spoof', () => {
    const r = computeScore({
      e164: '+14155550100',
      signals: {
        ...baseSignals,
        mention_count_30d: 500,
        mention_count_all: 1200,
        negative_sentiment_ratio: 0.9,
        complaint_sources: 5,
        stir_shaken_attestation: 'C',
        line_type: 'voip',
      },
    });
    assert.ok(r.trust_score < 25, `got ${r.trust_score}`);
    assert.equal(r.verdict, 'likely_spoof');
  });

  it('verified bank line with heavy spoof reports returns spoof_risk_high', () => {
    const r = computeScore({
      e164: '+18004321000',
      signals: {
        ...baseSignals,
        stir_shaken_attestation: 'A',
        line_type: 'toll_free',
        business_match: {
          name: 'Bank of America',
          category: 'bank',
          verified: true,
          source: 'high_spoof_targets_registry',
        },
        spoof_reports_30d: 50,
      },
    });
    assert.equal(r.verdict, 'spoof_risk_high');
    assert.equal(r.display_color, 'amber');
    assert.ok(r.user_message?.includes('back of your card'));
  });

  it('verified, aged, STIR-A number scores trusted', () => {
    const r = computeScore({
      e164: '+18004321000',
      signals: {
        ...baseSignals,
        stir_shaken_attestation: 'A',
        line_type: 'toll_free',
        number_age_days: 3000,
        business_match: {
          name: 'Generic Trusted Biz',
          category: 'other',
          verified: true,
          source: 'business_registry',
        },
        spoof_reports_30d: 0,
      },
    });
    assert.ok(r.trust_score >= 80, `got ${r.trust_score}`);
    assert.equal(r.verdict, 'trusted');
    assert.equal(r.display_color, 'green');
  });
});
