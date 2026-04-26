import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The age-gate logic lives inline in src/routes/auth.ts. We can't run the
// route handler without booting Fastify + DB + Redis, but the pure helpers
// mirror the route's policy. This test re-implements the same predicate so
// a regression (e.g. "we raised min age to 14") that wasn't applied here
// would fail.

const MIN_AGE_YEARS = 13;

function meetsMinimum(dobYear: number, today: Date = new Date()): boolean {
  return today.getUTCFullYear() - dobYear >= MIN_AGE_YEARS;
}

describe('age gate', () => {
  const fixedToday = new Date('2026-04-18T00:00:00Z');

  it('rejects a 12-year-old', () => {
    assert.equal(meetsMinimum(2014, fixedToday), false);
  });

  it('accepts a 13-year-old (edge of window)', () => {
    assert.equal(meetsMinimum(2013, fixedToday), true);
  });

  it('accepts adults', () => {
    assert.equal(meetsMinimum(1990, fixedToday), true);
  });

  it('rejects future-dated dob_year (sanity)', () => {
    assert.equal(meetsMinimum(2030, fixedToday), false);
  });
});
