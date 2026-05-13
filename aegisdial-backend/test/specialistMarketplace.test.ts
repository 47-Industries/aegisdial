import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Recovery Shield — R-P4 specialist marketplace + referral tracking tests.
//
// Stubs:
//   - db.pool.query — selectively handles every SQL the service issues,
//     including the recovery_plus_purchases queries the real
//     hasRecoveryPlus() helper makes (we do NOT module-mock the
//     entitlement service; we exercise it end-to-end against an
//     in-memory specialists / specialist_referrals / recovery_sessions /
//     recovery_plus_purchases store).
//
// Coverage targets (one per item in the prompt):
//   1. listSpecialistsFor with no filters → returns only active rows
//   2. listSpecialistsFor with category filter → only that category
//   3. listSpecialistsFor with jurisdiction='US-FL' → only rows that
//      have US-FL in jurisdictions[]
//   4. listSpecialistsFor with capabilities=['crypto'] → only rows
//      where 'crypto' ∈ capabilities[]
//   5. listSpecialistsFor respects limit (default 20, max 50)
//   6. getSpecialist returns active row + null for nonexistent
//   7. createReferral happy path → INSERT row, status='referred'
//   8. createReferral without Recovery Plus → RecoveryPlusRequiredError
//   9. createReferral with inactive specialist → SpecialistNotAvailableError
//  10. createReferral with another user's session → RecoverySessionNotFoundError
//  11. createReferral dedupe: same (user, specialist, session) twice → existing id
//  12. createReferral after case_closed_lost → allowed, NEW referral id
//  13. listReferralsForUser scopes to user_id
//  14. listReferralsForSpecialist with since filter
//  15. advanceReferralStatus as admin → any transition allowed
//  16. advanceReferralStatus as specialist (is_admin_actor=false) → forward only
//  17. advanceReferralStatus as specialist attempting backward → throws
//  18. advanceReferralStatus as specialist attempting user_declined → throws
//  19. reportSpecialistFee with is_admin_actor=false → UnauthorizedFeeReportError
//  20. reportSpecialistFee with is_admin_actor=true → updates fee_owed_cents
//  21. markFeePaid happy path → sets fee_paid_at
//  22. markFeePaid idempotent (running twice → second is no-op)

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-specialist-marketplace';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://specialist-marketplace';
process.env.APPLE_BUNDLE_ID ||= 'com.aegisdial.app';

const db = await import('../src/lib/db.ts');
const market = await import('../src/services/recovery/specialistMarketplace.ts');

// ----------------------------------------------------------------
// In-memory stub DB
// ----------------------------------------------------------------

type Category =
  | 'asset_recovery_attorney'
  | 'blockchain_forensics'
  | 'identity_restoration'
  | 'cyber_insurance_consult'
  | 'tax_professional_loss_writeoff';

type Status = 'pending' | 'active' | 'suspended' | 'retired';

type ReferralStatus =
  | 'referred'
  | 'specialist_contacted_user'
  | 'user_engaged'
  | 'case_active'
  | 'case_closed_won'
  | 'case_closed_lost'
  | 'user_declined';

interface FakeSpecialist {
  id: string;
  display_name: string;
  category: Category;
  jurisdictions: string[];
  capabilities: string[];
  commission_pct: string;
  contact_email: string;
  contact_phone: string | null;
  bar_number: string | null;
  status: Status;
  vetted_at: Date | null;
  vetted_by: string | null;
  notes: string | null;
  created_at: Date;
}

interface FakeReferral {
  id: string;
  user_id: string;
  specialist_id: string;
  recovery_session_id: string;
  referred_at: Date;
  specialist_acknowledged_at: Date | null;
  engagement_status: ReferralStatus;
  fee_owed_cents: string | null;
  fee_paid_at: Date | null;
  outcome_notes: string | null;
}

interface FakeRecoverySession {
  id: string;
  user_id: string;
}

interface FakePlusPurchase {
  id: string;
  user_id: string;
  recovery_session_id: string | null;
  refunded_at: Date | null;
  purchased_at: Date;
}

let fakeSpecialists: FakeSpecialist[] = [];
let fakeReferrals: FakeReferral[] = [];
let fakeSessions: FakeRecoverySession[] = [];
let fakePurchases: FakePlusPurchase[] = [];
let nextReferralSeq = 1;
let nextPurchaseSeq = 1;

function entitleUser(user_id: string, recovery_session_id: string): void {
  fakePurchases.push({
    id: `pur-${nextPurchaseSeq++}`,
    user_id,
    recovery_session_id,
    refunded_at: null,
    purchased_at: new Date(),
  });
}

function ensureSession(user_id: string, session_id: string): void {
  if (!fakeSessions.some((s) => s.id === session_id)) {
    fakeSessions.push({ id: session_id, user_id });
  }
}

function specialistRowOut(s: FakeSpecialist): Record<string, unknown> {
  return {
    id: s.id,
    display_name: s.display_name,
    category: s.category,
    jurisdictions: s.jurisdictions,
    capabilities: s.capabilities,
    commission_pct: s.commission_pct,
    contact_email: s.contact_email,
    contact_phone: s.contact_phone,
    bar_number: s.bar_number,
    status: s.status,
    vetted_at: s.vetted_at,
    vetted_by: s.vetted_by,
    notes: s.notes,
    created_at: s.created_at,
  };
}

function referralRowOut(r: FakeReferral): Record<string, unknown> {
  return {
    id: r.id,
    user_id: r.user_id,
    specialist_id: r.specialist_id,
    recovery_session_id: r.recovery_session_id,
    referred_at: r.referred_at,
    specialist_acknowledged_at: r.specialist_acknowledged_at,
    engagement_status: r.engagement_status,
    fee_owed_cents: r.fee_owed_cents,
    fee_paid_at: r.fee_paid_at,
    outcome_notes: r.outcome_notes,
  };
}

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const trimmed = text.trim().replace(/\s+/g, ' ');

  // ---- specialists SELECT (list) ----
  if (/^SELECT id, display_name, category, jurisdictions, capabilities, commission_pct, contact_email, contact_phone, bar_number, status, vetted_at, vetted_by, notes, created_at FROM specialists WHERE/i.test(trimmed)) {
    // listSpecialistsFor: WHERE status = 'active' [AND category = $1] [AND $N = ANY(jurisdictions)] [AND capabilities @> $N] ORDER BY category, display_name LIMIT $N
    // getSpecialist: WHERE id = $1 AND status = 'active'
    if (/WHERE id = \$1 AND status = 'active'/i.test(trimmed)) {
      const [id] = params as [string];
      const row = fakeSpecialists.find((s) => s.id === id && s.status === 'active');
      return row
        ? { rows: [specialistRowOut(row)], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }

    // listSpecialistsFor: dynamic WHERE clause. We re-parse the SQL
    // by walking the predicate fragments — predictable because the
    // service builds them in the same order: category, jurisdiction,
    // capabilities, limit.
    let pos = 0;
    let categoryFilter: Category | null = null;
    let jurisdictionFilter: string | null = null;
    let capabilitiesFilter: string[] | null = null;

    if (/category = \$/.test(trimmed)) {
      categoryFilter = params[pos++] as Category;
    }
    if (/= ANY\(jurisdictions\)/.test(trimmed)) {
      jurisdictionFilter = params[pos++] as string;
    }
    if (/capabilities @> \$/.test(trimmed)) {
      capabilitiesFilter = params[pos++] as string[];
    }
    const limit = params[pos++] as number;

    let candidates = fakeSpecialists.filter((s) => s.status === 'active');
    if (categoryFilter) candidates = candidates.filter((s) => s.category === categoryFilter);
    if (jurisdictionFilter) {
      candidates = candidates.filter((s) => s.jurisdictions.includes(jurisdictionFilter!));
    }
    if (capabilitiesFilter) {
      candidates = candidates.filter((s) =>
        capabilitiesFilter!.every((c) => s.capabilities.includes(c)),
      );
    }
    candidates.sort((a, b) => {
      if (a.category !== b.category) return a.category < b.category ? -1 : 1;
      return a.display_name < b.display_name ? -1 : 1;
    });
    const sliced = candidates.slice(0, limit);
    return { rows: sliced.map(specialistRowOut), rowCount: sliced.length };
  }

  // ---- specialists SELECT (category lookup for createReferral) ----
  if (/^SELECT category FROM specialists WHERE id = \$1 AND status = 'active'/i.test(trimmed)) {
    const [id] = params as [string];
    const row = fakeSpecialists.find((s) => s.id === id && s.status === 'active');
    return row ? { rows: [{ category: row.category }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // ---- recovery_sessions ownership check ----
  if (/^SELECT 1 AS exists_marker FROM recovery_sessions WHERE id = \$1 AND user_id = \$2/i.test(trimmed)) {
    const [id, user_id] = params as [string, string];
    const row = fakeSessions.find((s) => s.id === id && s.user_id === user_id);
    return row ? { rows: [{ exists_marker: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // ---- specialist_referrals dedupe SELECT ----
  if (/^SELECT id FROM specialist_referrals WHERE user_id = \$1 AND specialist_id = \$2 AND recovery_session_id = \$3 AND engagement_status = ANY\(\$4\)/i.test(trimmed)) {
    const [user_id, specialist_id, session_id, statuses] = params as [
      string,
      string,
      string,
      ReferralStatus[],
    ];
    const matches = fakeReferrals
      .filter(
        (r) =>
          r.user_id === user_id &&
          r.specialist_id === specialist_id &&
          r.recovery_session_id === session_id &&
          statuses.includes(r.engagement_status),
      )
      .sort((a, b) => b.referred_at.getTime() - a.referred_at.getTime());
    return matches.length > 0
      ? { rows: [{ id: matches[0]!.id }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // ---- specialist_referrals INSERT ----
  if (/^INSERT INTO specialist_referrals/i.test(trimmed)) {
    const [user_id, specialist_id, session_id] = params as [string, string, string];
    const row: FakeReferral = {
      id: `ref-${nextReferralSeq++}`,
      user_id,
      specialist_id,
      recovery_session_id: session_id,
      referred_at: new Date(),
      specialist_acknowledged_at: null,
      engagement_status: 'referred',
      fee_owed_cents: null,
      fee_paid_at: null,
      outcome_notes: null,
    };
    fakeReferrals.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // ---- specialist_referrals SELECT for user-scoped list (with session) ----
  if (/^SELECT id, user_id, specialist_id, recovery_session_id, referred_at, specialist_acknowledged_at, engagement_status, fee_owed_cents, fee_paid_at, outcome_notes FROM specialist_referrals WHERE user_id = \$1 AND recovery_session_id = \$2 ORDER BY referred_at DESC/i.test(trimmed)) {
    const [user_id, session_id] = params as [string, string];
    const matches = fakeReferrals
      .filter((r) => r.user_id === user_id && r.recovery_session_id === session_id)
      .sort((a, b) => b.referred_at.getTime() - a.referred_at.getTime());
    return { rows: matches.map(referralRowOut), rowCount: matches.length };
  }

  // ---- specialist_referrals SELECT for user-scoped list (no session) ----
  if (/^SELECT id, user_id, specialist_id, recovery_session_id, referred_at, specialist_acknowledged_at, engagement_status, fee_owed_cents, fee_paid_at, outcome_notes FROM specialist_referrals WHERE user_id = \$1 ORDER BY referred_at DESC$/i.test(trimmed)) {
    const [user_id] = params as [string];
    const matches = fakeReferrals
      .filter((r) => r.user_id === user_id)
      .sort((a, b) => b.referred_at.getTime() - a.referred_at.getTime());
    return { rows: matches.map(referralRowOut), rowCount: matches.length };
  }

  // ---- specialist_referrals SELECT for specialist-scoped list (with since) ----
  if (/^SELECT id, user_id, specialist_id, recovery_session_id, referred_at, specialist_acknowledged_at, engagement_status, fee_owed_cents, fee_paid_at, outcome_notes FROM specialist_referrals WHERE specialist_id = \$1 AND referred_at >= \$2 ORDER BY referred_at DESC LIMIT \$3/i.test(trimmed)) {
    const [specialist_id, since, limit] = params as [string, Date, number];
    const matches = fakeReferrals
      .filter((r) => r.specialist_id === specialist_id && r.referred_at >= since)
      .sort((a, b) => b.referred_at.getTime() - a.referred_at.getTime())
      .slice(0, limit);
    return { rows: matches.map(referralRowOut), rowCount: matches.length };
  }

  // ---- specialist_referrals SELECT for specialist-scoped list (no since) ----
  if (/^SELECT id, user_id, specialist_id, recovery_session_id, referred_at, specialist_acknowledged_at, engagement_status, fee_owed_cents, fee_paid_at, outcome_notes FROM specialist_referrals WHERE specialist_id = \$1 ORDER BY referred_at DESC LIMIT \$2/i.test(trimmed)) {
    const [specialist_id, limit] = params as [string, number];
    const matches = fakeReferrals
      .filter((r) => r.specialist_id === specialist_id)
      .sort((a, b) => b.referred_at.getTime() - a.referred_at.getTime())
      .slice(0, limit);
    return { rows: matches.map(referralRowOut), rowCount: matches.length };
  }

  // ---- specialist_referrals SELECT for status load (advanceReferralStatus) ----
  if (/^SELECT engagement_status FROM specialist_referrals WHERE id = \$1/i.test(trimmed)) {
    const [id] = params as [string];
    const row = fakeReferrals.find((r) => r.id === id);
    return row
      ? { rows: [{ engagement_status: row.engagement_status }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // ---- specialist_referrals JOIN specialists for fee-report category lookup ----
  if (/^SELECT s\.category FROM specialist_referrals r JOIN specialists s ON s\.id = r\.specialist_id WHERE r\.id = \$1/i.test(trimmed)) {
    const [id] = params as [string];
    const referral = fakeReferrals.find((r) => r.id === id);
    if (!referral) return { rows: [], rowCount: 0 };
    const specialist = fakeSpecialists.find((s) => s.id === referral.specialist_id);
    if (!specialist) return { rows: [], rowCount: 0 };
    return { rows: [{ category: specialist.category }], rowCount: 1 };
  }

  // ---- specialist_referrals UPDATE engagement_status ----
  if (/^UPDATE specialist_referrals SET engagement_status = \$2,/i.test(trimmed)) {
    const [id, next_status, outcome_notes] = params as [
      string,
      ReferralStatus,
      string | null,
    ];
    const row = fakeReferrals.find((r) => r.id === id);
    if (!row) return { rows: [], rowCount: 0 };
    row.engagement_status = next_status;
    if (next_status === 'specialist_contacted_user' && row.specialist_acknowledged_at === null) {
      row.specialist_acknowledged_at = new Date();
    }
    if (outcome_notes !== null) row.outcome_notes = outcome_notes;
    return { rows: [], rowCount: 1 };
  }

  // ---- specialist_referrals UPDATE fee_owed_cents ----
  if (/^UPDATE specialist_referrals SET fee_owed_cents = \$2 WHERE id = \$1$/i.test(trimmed)) {
    const [id, fee_owed] = params as [string, bigint];
    const row = fakeReferrals.find((r) => r.id === id);
    if (!row) return { rows: [], rowCount: 0 };
    row.fee_owed_cents = fee_owed.toString();
    return { rows: [], rowCount: 1 };
  }

  // ---- specialist_referrals UPDATE fee_paid_at (idempotent on NULL) ----
  if (/^UPDATE specialist_referrals SET fee_paid_at = COALESCE\(\$2, NOW\(\)\) WHERE id = \$1 AND fee_paid_at IS NULL/i.test(trimmed)) {
    const [id, paid_at] = params as [string, Date | null];
    const row = fakeReferrals.find((r) => r.id === id);
    if (!row) return { rows: [], rowCount: 0 };
    if (row.fee_paid_at !== null) return { rows: [], rowCount: 0 };
    row.fee_paid_at = paid_at ?? new Date();
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // ---- recovery_plus_purchases — NULL-session bind UPDATE ----
  // Tests never set up NULL-session purchases; always returns 0 rows.
  if (/^UPDATE recovery_plus_purchases SET recovery_session_id = \$2 WHERE id = \( SELECT id FROM recovery_plus_purchases WHERE user_id = \$1 AND recovery_session_id IS NULL/i.test(trimmed)) {
    return { rows: [], rowCount: 0 };
  }

  // ---- recovery_plus_purchases — bound-session SELECT ----
  if (/^SELECT id FROM recovery_plus_purchases WHERE user_id = \$1 AND recovery_session_id = \$2 AND refunded_at IS NULL/i.test(trimmed)) {
    const [user_id, session_id] = params as [string, string];
    const row = fakePurchases.find(
      (p) =>
        p.user_id === user_id &&
        p.recovery_session_id === session_id &&
        p.refunded_at === null,
    );
    return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // ---- emitMetric → metric_counters UPSERT. Swallow. ----
  if (/^INSERT INTO metric_counters/i.test(trimmed)) {
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`unstubbed SQL: ${trimmed.slice(0, 240)}`);
};

beforeEach(() => {
  fakeSpecialists = [];
  fakeReferrals = [];
  fakeSessions = [];
  fakePurchases = [];
  nextReferralSeq = 1;
  nextPurchaseSeq = 1;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

// ----------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------

const USER_A = '00000000-0000-0000-0000-00000000000a';
const USER_B = '00000000-0000-0000-0000-00000000000b';
const SESSION_1 = '11111111-1111-1111-1111-111111111111';
const SESSION_2 = '22222222-2222-2222-2222-222222222222';

function makeSpecialist(overrides: Partial<FakeSpecialist> = {}): FakeSpecialist {
  return {
    id: overrides.id ?? `spec-${fakeSpecialists.length + 1}`,
    display_name: overrides.display_name ?? `Specialist ${fakeSpecialists.length + 1}`,
    category: overrides.category ?? 'asset_recovery_attorney',
    jurisdictions: overrides.jurisdictions ?? ['US-FL'],
    capabilities: overrides.capabilities ?? ['wire_recall'],
    commission_pct: overrides.commission_pct ?? '15.00',
    contact_email: overrides.contact_email ?? 'intake@example.com',
    contact_phone: overrides.contact_phone ?? null,
    bar_number: overrides.bar_number ?? 'FL-12345',
    status: overrides.status ?? 'active',
    vetted_at: overrides.vetted_at ?? new Date(),
    vetted_by: overrides.vetted_by ?? null,
    notes: overrides.notes ?? null,
    created_at: overrides.created_at ?? new Date(),
  };
}

// ----------------------------------------------------------------
// listSpecialistsFor
// ----------------------------------------------------------------

describe('listSpecialistsFor', () => {
  it('with no filters returns only active specialists', async () => {
    fakeSpecialists.push(
      makeSpecialist({ id: 'spec-1', display_name: 'A Active', status: 'active' }),
      makeSpecialist({ id: 'spec-2', display_name: 'B Suspended', status: 'suspended' }),
      makeSpecialist({ id: 'spec-3', display_name: 'C Pending', status: 'pending' }),
      makeSpecialist({ id: 'spec-4', display_name: 'D Active', status: 'active' }),
    );
    const result = await market.listSpecialistsFor({});
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((r) => r.id).sort(),
      ['spec-1', 'spec-4'].sort(),
    );
  });

  it('with category filter returns only that category', async () => {
    fakeSpecialists.push(
      makeSpecialist({ id: 's1', category: 'asset_recovery_attorney' }),
      makeSpecialist({ id: 's2', category: 'blockchain_forensics' }),
      makeSpecialist({ id: 's3', category: 'blockchain_forensics' }),
    );
    const result = await market.listSpecialistsFor({ category: 'blockchain_forensics' });
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r.category === 'blockchain_forensics'));
  });

  it("with jurisdiction='US-FL' returns only specialists who have US-FL in jurisdictions[]", async () => {
    fakeSpecialists.push(
      makeSpecialist({ id: 's1', jurisdictions: ['US-FL', 'US-GA'] }),
      makeSpecialist({ id: 's2', jurisdictions: ['US-CA'] }),
      makeSpecialist({ id: 's3', jurisdictions: ['US-FL'] }),
    );
    const result = await market.listSpecialistsFor({ jurisdiction: 'US-FL' });
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((r) => r.id).sort(), ['s1', 's3']);
  });

  it("with capabilities=['crypto'] returns only specialists with 'crypto' in capabilities[]", async () => {
    fakeSpecialists.push(
      makeSpecialist({ id: 's1', capabilities: ['crypto', 'wire_recall'] }),
      makeSpecialist({ id: 's2', capabilities: ['wire_recall'] }),
      makeSpecialist({ id: 's3', capabilities: ['crypto'] }),
    );
    const result = await market.listSpecialistsFor({ capabilities: ['crypto'] });
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((r) => r.id).sort(), ['s1', 's3']);
  });

  it("with capabilities=['crypto','wire_recall'] requires ALL (superset match)", async () => {
    fakeSpecialists.push(
      makeSpecialist({ id: 's1', capabilities: ['crypto', 'wire_recall'] }),
      makeSpecialist({ id: 's2', capabilities: ['crypto'] }),
      makeSpecialist({ id: 's3', capabilities: ['wire_recall'] }),
    );
    const result = await market.listSpecialistsFor({
      capabilities: ['crypto', 'wire_recall'],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, 's1');
  });

  it('respects limit (default 20, max 50)', async () => {
    for (let i = 1; i <= 60; i++) {
      fakeSpecialists.push(
        makeSpecialist({
          id: `s${String(i).padStart(3, '0')}`,
          display_name: `S ${String(i).padStart(3, '0')}`,
        }),
      );
    }
    const defaultResult = await market.listSpecialistsFor({});
    assert.equal(defaultResult.length, 20);

    const customResult = await market.listSpecialistsFor({}, { limit: 30 });
    assert.equal(customResult.length, 30);

    // Over-cap clamps to 50.
    const cappedResult = await market.listSpecialistsFor({}, { limit: 100 });
    assert.equal(cappedResult.length, 50);
  });
});

// ----------------------------------------------------------------
// getSpecialist
// ----------------------------------------------------------------

describe('getSpecialist', () => {
  it('returns an active specialist by id', async () => {
    fakeSpecialists.push(makeSpecialist({ id: 'spec-x', status: 'active' }));
    const row = await market.getSpecialist('spec-x');
    assert.ok(row);
    assert.equal(row!.id, 'spec-x');
    assert.equal(row!.status, 'active');
  });

  it('returns null for a non-existent id', async () => {
    const row = await market.getSpecialist('does-not-exist');
    assert.equal(row, null);
  });

  it('returns null for a non-active specialist (suspended)', async () => {
    fakeSpecialists.push(makeSpecialist({ id: 'spec-susp', status: 'suspended' }));
    const row = await market.getSpecialist('spec-susp');
    assert.equal(row, null);
  });
});

// ----------------------------------------------------------------
// createReferral
// ----------------------------------------------------------------

describe('createReferral', () => {
  it('happy path inserts a row with engagement_status=referred', async () => {
    entitleUser(USER_A, SESSION_1);
    ensureSession(USER_A, SESSION_1);
    fakeSpecialists.push(makeSpecialist({ id: 'spec-1', status: 'active' }));

    const result = await market.createReferral({
      user_id: USER_A,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_1,
    });

    assert.ok(result.referral_id);
    assert.equal(fakeReferrals.length, 1);
    const row = fakeReferrals[0]!;
    assert.equal(row.user_id, USER_A);
    assert.equal(row.specialist_id, 'spec-1');
    assert.equal(row.recovery_session_id, SESSION_1);
    assert.equal(row.engagement_status, 'referred');
  });

  it('without Recovery Plus throws RecoveryPlusRequiredError', async () => {
    ensureSession(USER_A, SESSION_1);
    fakeSpecialists.push(makeSpecialist({ id: 'spec-1', status: 'active' }));

    await assert.rejects(
      market.createReferral({
        user_id: USER_A,
        specialist_id: 'spec-1',
        recovery_session_id: SESSION_1,
      }),
      (err: unknown) => err instanceof market.RecoveryPlusRequiredError,
    );
    assert.equal(fakeReferrals.length, 0);
  });

  it('with an inactive specialist throws SpecialistNotAvailableError', async () => {
    entitleUser(USER_A, SESSION_1);
    ensureSession(USER_A, SESSION_1);
    fakeSpecialists.push(makeSpecialist({ id: 'spec-inactive', status: 'suspended' }));

    await assert.rejects(
      market.createReferral({
        user_id: USER_A,
        specialist_id: 'spec-inactive',
        recovery_session_id: SESSION_1,
      }),
      (err: unknown) => err instanceof market.SpecialistNotAvailableError,
    );
    assert.equal(fakeReferrals.length, 0);
  });

  it("against another user's recovery session throws RecoverySessionNotFoundError", async () => {
    entitleUser(USER_A, SESSION_1);
    // Session owned by USER_B, not USER_A.
    ensureSession(USER_B, SESSION_1);
    fakeSpecialists.push(makeSpecialist({ id: 'spec-1', status: 'active' }));

    await assert.rejects(
      market.createReferral({
        user_id: USER_A,
        specialist_id: 'spec-1',
        recovery_session_id: SESSION_1,
      }),
      (err: unknown) => err instanceof market.RecoverySessionNotFoundError,
    );
    assert.equal(fakeReferrals.length, 0);
  });

  it('dedupe: same (user, specialist, session) twice → second returns existing referral_id', async () => {
    entitleUser(USER_A, SESSION_1);
    ensureSession(USER_A, SESSION_1);
    fakeSpecialists.push(makeSpecialist({ id: 'spec-1', status: 'active' }));

    const first = await market.createReferral({
      user_id: USER_A,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_1,
    });
    const second = await market.createReferral({
      user_id: USER_A,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_1,
    });

    assert.equal(second.referral_id, first.referral_id);
    assert.equal(fakeReferrals.length, 1);
  });

  it('after a prior case_closed_lost → allowed, returns a NEW referral_id', async () => {
    entitleUser(USER_A, SESSION_1);
    ensureSession(USER_A, SESSION_1);
    fakeSpecialists.push(makeSpecialist({ id: 'spec-1', status: 'active' }));

    const first = await market.createReferral({
      user_id: USER_A,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_1,
    });
    // Close it.
    await market.advanceReferralStatus({
      referral_id: first.referral_id,
      next_status: 'case_closed_lost',
      is_admin_actor: true,
    });
    // Re-engage.
    const second = await market.createReferral({
      user_id: USER_A,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_1,
    });
    assert.notEqual(second.referral_id, first.referral_id);
    assert.equal(fakeReferrals.length, 2);
  });
});

// ----------------------------------------------------------------
// listReferralsForUser
// ----------------------------------------------------------------

describe('listReferralsForUser', () => {
  it('scopes to user_id — user A never sees user B referrals', async () => {
    entitleUser(USER_A, SESSION_1);
    entitleUser(USER_B, SESSION_2);
    ensureSession(USER_A, SESSION_1);
    ensureSession(USER_B, SESSION_2);
    fakeSpecialists.push(makeSpecialist({ id: 'spec-1', status: 'active' }));

    await market.createReferral({
      user_id: USER_A,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_1,
    });
    await market.createReferral({
      user_id: USER_B,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_2,
    });

    const userARows = await market.listReferralsForUser(USER_A);
    assert.equal(userARows.length, 1);
    assert.equal(userARows[0]!.user_id, USER_A);

    const userBRows = await market.listReferralsForUser(USER_B);
    assert.equal(userBRows.length, 1);
    assert.equal(userBRows[0]!.user_id, USER_B);
  });

  it('with recovery_session_id narrows further to that session', async () => {
    entitleUser(USER_A, SESSION_1);
    entitleUser(USER_A, SESSION_2);
    ensureSession(USER_A, SESSION_1);
    ensureSession(USER_A, SESSION_2);
    fakeSpecialists.push(makeSpecialist({ id: 'spec-1', status: 'active' }));

    await market.createReferral({
      user_id: USER_A,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_1,
    });
    await market.createReferral({
      user_id: USER_A,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_2,
    });

    const session1Rows = await market.listReferralsForUser(USER_A, {
      recovery_session_id: SESSION_1,
    });
    assert.equal(session1Rows.length, 1);
    assert.equal(session1Rows[0]!.recovery_session_id, SESSION_1);
  });
});

// ----------------------------------------------------------------
// listReferralsForSpecialist
// ----------------------------------------------------------------

describe('listReferralsForSpecialist', () => {
  it('with since filter returns only referrals at-or-after that timestamp', async () => {
    entitleUser(USER_A, SESSION_1);
    entitleUser(USER_B, SESSION_2);
    ensureSession(USER_A, SESSION_1);
    ensureSession(USER_B, SESSION_2);
    fakeSpecialists.push(makeSpecialist({ id: 'spec-1', status: 'active' }));

    // Plant an old referral by hand (the createReferral path always
    // stamps NOW() — we backdate one to test the since filter).
    fakeReferrals.push({
      id: 'old-ref',
      user_id: USER_A,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_1,
      referred_at: new Date('2020-01-01T00:00:00Z'),
      specialist_acknowledged_at: null,
      engagement_status: 'referred',
      fee_owed_cents: null,
      fee_paid_at: null,
      outcome_notes: null,
    });
    // Recent referral via the real path.
    await market.createReferral({
      user_id: USER_B,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_2,
    });

    const sinceLastYear = new Date('2025-01-01T00:00:00Z');
    const rows = await market.listReferralsForSpecialist('spec-1', { since: sinceLastYear });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.user_id, USER_B);
  });
});

// ----------------------------------------------------------------
// advanceReferralStatus
// ----------------------------------------------------------------

describe('advanceReferralStatus', () => {
  async function seedReferral(): Promise<string> {
    entitleUser(USER_A, SESSION_1);
    ensureSession(USER_A, SESSION_1);
    fakeSpecialists.push(makeSpecialist({ id: 'spec-1', status: 'active' }));
    const r = await market.createReferral({
      user_id: USER_A,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_1,
    });
    return r.referral_id;
  }

  it('as admin → any non-terminal transition allowed (jump straight to case_active)', async () => {
    const refId = await seedReferral();
    const result = await market.advanceReferralStatus({
      referral_id: refId,
      next_status: 'case_active',
      is_admin_actor: true,
    });
    assert.equal(result.status, 'case_active');
    assert.equal(fakeReferrals.find((r) => r.id === refId)!.engagement_status, 'case_active');
  });

  it('as specialist webhook (is_admin_actor=false) → linear forward path allowed', async () => {
    const refId = await seedReferral();
    // referred → specialist_contacted_user
    const step1 = await market.advanceReferralStatus({
      referral_id: refId,
      next_status: 'specialist_contacted_user',
      is_admin_actor: false,
    });
    assert.equal(step1.status, 'specialist_contacted_user');
    // Confirm specialist_acknowledged_at was stamped.
    assert.ok(fakeReferrals.find((r) => r.id === refId)!.specialist_acknowledged_at);

    // specialist_contacted_user → user_engaged
    const step2 = await market.advanceReferralStatus({
      referral_id: refId,
      next_status: 'user_engaged',
      is_admin_actor: false,
    });
    assert.equal(step2.status, 'user_engaged');

    // user_engaged → case_active
    const step3 = await market.advanceReferralStatus({
      referral_id: refId,
      next_status: 'case_active',
      is_admin_actor: false,
    });
    assert.equal(step3.status, 'case_active');

    // case_active → case_closed_won
    const step4 = await market.advanceReferralStatus({
      referral_id: refId,
      next_status: 'case_closed_won',
      is_admin_actor: false,
    });
    assert.equal(step4.status, 'case_closed_won');
  });

  it('as specialist webhook attempting backward (case_active → user_engaged) throws', async () => {
    const refId = await seedReferral();
    // Move forward to case_active first.
    await market.advanceReferralStatus({
      referral_id: refId,
      next_status: 'case_active',
      is_admin_actor: true,
    });
    await assert.rejects(
      market.advanceReferralStatus({
        referral_id: refId,
        next_status: 'user_engaged',
        is_admin_actor: false,
      }),
      (err: unknown) => err instanceof market.InvalidStatusTransitionError,
    );
  });

  it('as specialist webhook attempting user_declined throws (admin-only)', async () => {
    const refId = await seedReferral();
    await assert.rejects(
      market.advanceReferralStatus({
        referral_id: refId,
        next_status: 'user_declined',
        is_admin_actor: false,
      }),
      (err: unknown) => err instanceof market.InvalidStatusTransitionError,
    );
    // Admin CAN trigger user_declined.
    const result = await market.advanceReferralStatus({
      referral_id: refId,
      next_status: 'user_declined',
      is_admin_actor: true,
    });
    assert.equal(result.status, 'user_declined');
  });

  it('rejects advancement from a terminal status (even for admin)', async () => {
    const refId = await seedReferral();
    await market.advanceReferralStatus({
      referral_id: refId,
      next_status: 'case_closed_won',
      is_admin_actor: true,
    });
    await assert.rejects(
      market.advanceReferralStatus({
        referral_id: refId,
        next_status: 'case_active',
        is_admin_actor: true,
      }),
      (err: unknown) => err instanceof market.InvalidStatusTransitionError,
    );
  });
});

// ----------------------------------------------------------------
// reportSpecialistFee
// ----------------------------------------------------------------

describe('reportSpecialistFee', () => {
  async function seedReferral(): Promise<string> {
    entitleUser(USER_A, SESSION_1);
    ensureSession(USER_A, SESSION_1);
    fakeSpecialists.push(makeSpecialist({ id: 'spec-1', status: 'active' }));
    const r = await market.createReferral({
      user_id: USER_A,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_1,
    });
    return r.referral_id;
  }

  it('with is_admin_actor=false throws UnauthorizedFeeReportError (fee-fraud guard)', async () => {
    const refId = await seedReferral();
    await assert.rejects(
      market.reportSpecialistFee({
        referral_id: refId,
        fee_owed_cents: 50_000n,
        is_admin_actor: false,
      }),
      (err: unknown) => err instanceof market.UnauthorizedFeeReportError,
    );
    // No mutation.
    assert.equal(fakeReferrals.find((r) => r.id === refId)!.fee_owed_cents, null);
  });

  it('with is_admin_actor=true updates fee_owed_cents', async () => {
    const refId = await seedReferral();
    const result = await market.reportSpecialistFee({
      referral_id: refId,
      fee_owed_cents: 1_234_500n,
      is_admin_actor: true,
    });
    assert.equal(result.referral_id, refId);
    assert.equal(result.fee_owed_cents, 1_234_500n);
    const row = fakeReferrals.find((r) => r.id === refId)!;
    assert.equal(row.fee_owed_cents, '1234500');
  });
});

// ----------------------------------------------------------------
// markFeePaid
// ----------------------------------------------------------------

describe('markFeePaid', () => {
  async function seedReferral(): Promise<string> {
    entitleUser(USER_A, SESSION_1);
    ensureSession(USER_A, SESSION_1);
    fakeSpecialists.push(makeSpecialist({ id: 'spec-1', status: 'active' }));
    const r = await market.createReferral({
      user_id: USER_A,
      specialist_id: 'spec-1',
      recovery_session_id: SESSION_1,
    });
    return r.referral_id;
  }

  it('happy path sets fee_paid_at', async () => {
    const refId = await seedReferral();
    const paid = new Date('2026-05-01T12:00:00Z');
    await market.markFeePaid({ referral_id: refId, paid_at: paid });
    const row = fakeReferrals.find((r) => r.id === refId)!;
    assert.ok(row.fee_paid_at);
    assert.equal(row.fee_paid_at!.getTime(), paid.getTime());
  });

  it('idempotent — running twice leaves the first timestamp intact', async () => {
    const refId = await seedReferral();
    const firstPaid = new Date('2026-05-01T12:00:00Z');
    const secondPaid = new Date('2026-05-02T12:00:00Z');

    await market.markFeePaid({ referral_id: refId, paid_at: firstPaid });
    await market.markFeePaid({ referral_id: refId, paid_at: secondPaid });

    const row = fakeReferrals.find((r) => r.id === refId)!;
    // First timestamp wins; second call is a no-op (WHERE fee_paid_at IS NULL).
    assert.equal(row.fee_paid_at!.getTime(), firstPaid.getTime());
  });
});
