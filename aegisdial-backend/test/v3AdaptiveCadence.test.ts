import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield — adaptive transcript-flush cadence tests.
//
// Pure-function unit tests on pickFlushCadenceMs. The defaults below
// must match src/config.ts. If the defaults change, update these.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v3-cadence';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v3-cadence-test';

const { pickFlushCadenceMs } = await import('../src/services/adaptiveCadence.ts');

const LOW_MS = 8000;
const MEDIUM_MS = 5000;
const HIGH_MS = 3000;
const CRITICAL_MS = 2000;

describe('adaptiveCadence — pickFlushCadenceMs', () => {
  it('returns the slow cadence for cold low-risk sessions', () => {
    assert.equal(
      pickFlushCadenceMs({ risk_level: 'low', has_any_b4_finding: false }),
      LOW_MS,
    );
  });

  it('tightens to medium when low-risk but a B4 claim is being verified', () => {
    // B4-activity floor: the verifier is racing; iOS shouldn't be on
    // the slow cadence while we have unverified claims in flight.
    assert.equal(
      pickFlushCadenceMs({ risk_level: 'low', has_any_b4_finding: true }),
      MEDIUM_MS,
    );
  });

  it('returns medium cadence for medium-risk regardless of B4 activity', () => {
    assert.equal(
      pickFlushCadenceMs({ risk_level: 'medium', has_any_b4_finding: false }),
      MEDIUM_MS,
    );
    assert.equal(
      pickFlushCadenceMs({ risk_level: 'medium', has_any_b4_finding: true }),
      MEDIUM_MS,
    );
  });

  it('returns high cadence for high-risk', () => {
    assert.equal(
      pickFlushCadenceMs({ risk_level: 'high', has_any_b4_finding: false }),
      HIGH_MS,
    );
    assert.equal(
      pickFlushCadenceMs({ risk_level: 'high', has_any_b4_finding: true }),
      HIGH_MS,
    );
  });

  it('returns critical cadence for critical-risk', () => {
    assert.equal(
      pickFlushCadenceMs({ risk_level: 'critical', has_any_b4_finding: false }),
      CRITICAL_MS,
    );
    assert.equal(
      pickFlushCadenceMs({ risk_level: 'critical', has_any_b4_finding: true }),
      CRITICAL_MS,
    );
  });

  it('preserves the monotonic invariant: higher risk ⇒ shorter cadence', () => {
    // The whole point of adaptive cadence is that risk going UP makes
    // the flush interval go DOWN. Test the full chain so a future
    // mis-tune of a single env value can't accidentally invert it
    // (e.g., setting CRITICAL=4000 and HIGH=2000 by mistake).
    const lowCold = pickFlushCadenceMs({ risk_level: 'low', has_any_b4_finding: false });
    const lowWarm = pickFlushCadenceMs({ risk_level: 'low', has_any_b4_finding: true });
    const med = pickFlushCadenceMs({ risk_level: 'medium', has_any_b4_finding: false });
    const high = pickFlushCadenceMs({ risk_level: 'high', has_any_b4_finding: false });
    const crit = pickFlushCadenceMs({ risk_level: 'critical', has_any_b4_finding: false });
    assert.ok(lowCold >= lowWarm, 'cold low ≥ warm low');
    assert.ok(lowWarm >= med, 'warm low ≥ medium');
    assert.ok(med >= high, 'medium ≥ high');
    assert.ok(high >= crit, 'high ≥ critical');
  });

  it('every cadence is a positive integer ≥ 1000 ms', () => {
    // A 0-ms cadence would cause iOS to hammer the endpoint at line
    // rate. A sub-1s cadence would breach the rate limiter (120/min
    // = 500ms minimum) even at all-critical. Enforce a sanity floor.
    for (const level of ['low', 'medium', 'high', 'critical'] as const) {
      for (const has of [false, true]) {
        const ms = pickFlushCadenceMs({ risk_level: level, has_any_b4_finding: has });
        assert.ok(Number.isInteger(ms), `${level}/${has} is integer`);
        assert.ok(ms >= 1000, `${level}/${has} ≥ 1000ms (got ${ms})`);
      }
    }
  });
});
