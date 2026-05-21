import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Tests for the PRO_GRANT_EMAILS allowlist short-circuit in
// currentTier(). Founders + team + App Store reviewer accounts get
// 'pro' regardless of subscription rows.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-allowlist-secret';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://allowlist-test';
process.env.ENZOIC_MOCK = 'true';
process.env.PRO_GRANT_EMAILS = 'jesiah@example.com, dean@example.com,review@aegisdial.com';

const db = await import('../src/lib/db.ts');
const { currentTier } = await import('../src/lib/subscription.ts');

const ALLOWLISTED_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NON_ALLOWLISTED_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const MIXED_CASE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

interface DbState {
  users: Map<string, { id: string; email: string | null }>;
}
const dbState: DbState = { users: new Map() };
function resetDb(): void {
  dbState.users.clear();
  dbState.users.set(ALLOWLISTED_ID, { id: ALLOWLISTED_ID, email: 'jesiah@example.com' });
  dbState.users.set(NON_ALLOWLISTED_ID, { id: NON_ALLOWLISTED_ID, email: 'alice@example.com' });
  dbState.users.set(MIXED_CASE_ID, { id: MIXED_CASE_ID, email: 'Dean@Example.Com' });
}

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.trim();

  if (/^SELECT email FROM users WHERE id = \$1/i.test(t)) {
    const user = dbState.users.get(params[0] as string);
    return user
      ? { rows: [{ email: user.email }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  // currentTier's subscription + family queries — return empty so the
  // only path to 'pro' for non-allowlisted users is the subscription
  // table (which we leave empty), which means they should be 'pending'.
  if (/^SELECT status, current_period_end\s+FROM subscriptions/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }
  if (/^SELECT s\.status, s\.current_period_end\s+FROM family_members/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
};

(db as unknown as { pool: { query: typeof fakeQuery } }).pool.query = fakeQuery;

describe('PRO_GRANT_EMAILS allowlist', () => {
  before(resetDb);
  beforeEach(resetDb);

  it('returns pro for an exact-match allowlisted email', async () => {
    const tier = await currentTier(ALLOWLISTED_ID);
    assert.equal(tier, 'pro');
  });

  it('returns pro for a case-insensitive match', async () => {
    // User row email is "Dean@Example.Com" but allowlist normalised
    // it to "dean@example.com" — the lookup should still match.
    const tier = await currentTier(MIXED_CASE_ID);
    assert.equal(tier, 'pro');
  });

  it('returns pending for a non-allowlisted user with no subscription', async () => {
    const tier = await currentTier(NON_ALLOWLISTED_ID);
    assert.equal(tier, 'pending');
  });

  it('returns pending for a user not in the DB at all', async () => {
    const tier = await currentTier('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz');
    assert.equal(tier, 'pending');
  });
});
