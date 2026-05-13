import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Recovery Shield — R-P3a wire-trace agent tests.
//
// Stubs:
//   - db.pool.query — selectively returns wire_trace_cases rows and
//     recovery_plus_purchases rows. hasRecoveryPlus from
//     recoveryPlusEntitlement.ts is NOT module-mocked; instead we
//     stand up a stub recovery_plus_purchases table in the same
//     fake db so the real entitlement logic exercises end-to-end.
//   - llmFn — injected per-test stub. No network calls.
//
// Coverage targets (one per item in the prompt's test list):
//   1. startWireTraceCase happy path → INSERT row, state='intake'
//   2. startWireTraceCase without Recovery Plus → RecoveryPlusRequiredError
//   3. generateDisputeLetter happy path → chase scaffold + disclaimer
//   4. generateDisputeLetter without Plus → throws
//   5. Bank routing: chase=Reg E, wells_fargo=SWIFT, unknown=generic
//   6. advanceWireTraceCase intake → letter_drafted is legal
//   7. advanceWireTraceCase intake → recalled is illegal
//   8. advanceWireTraceCase cross-user → NotFoundError
//   9. getWireTraceCase cross-user → null
//  10. LLM output missing disclaimer → service prepends defense-in-depth
//  11. dispute_letter_text in DB is ciphertext, not plaintext
//  12. wire_amount_cents bigint handled correctly ($50k = 5_000_000n)

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-wire-trace';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://wire-trace';
process.env.APPLE_BUNDLE_ID ||= 'com.aegisdial.app';

const db = await import('../src/lib/db.ts');
const agent = await import('../src/services/recovery/wireTraceAgent.ts');
const crypto = await import('../src/lib/crypto.ts');

// ----------------------------------------------------------------
// In-memory stub DB
// ----------------------------------------------------------------

interface FakeWireCase {
  id: string;
  user_id: string;
  recovery_session_id: string;
  source_bank: string;
  destination_account_hint: string | null;
  wire_amount_cents: bigint;
  wire_sent_at: Date;
  state:
    | 'intake'
    | 'letter_drafted'
    | 'user_sent'
    | 'bank_acknowledged'
    | 'recalled'
    | 'denied'
    | 'closed';
  dispute_letter_text: string | null;
  bank_response_text: string | null;
  state_changed_at: Date;
  created_at: Date;
}

interface FakePlusPurchase {
  id: string;
  user_id: string;
  recovery_session_id: string | null;
  refunded_at: Date | null;
  purchased_at: Date;
}

let fakeCases: FakeWireCase[] = [];
let fakePurchases: FakePlusPurchase[] = [];
let nextCaseSeq = 1;
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

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const trimmed = text.trim().replace(/\s+/g, ' ');

  // ---- wire_trace_cases ----

  if (/^INSERT INTO wire_trace_cases/i.test(trimmed)) {
    const [
      user_id,
      recovery_session_id,
      source_bank,
      destination_account_hint,
      wire_amount_cents,
      wire_sent_at,
    ] = params as [string, string, string, string | null, bigint | string, Date];
    const row: FakeWireCase = {
      id: `wire-${nextCaseSeq++}`,
      user_id,
      recovery_session_id,
      source_bank,
      destination_account_hint,
      wire_amount_cents:
        typeof wire_amount_cents === 'bigint'
          ? wire_amount_cents
          : BigInt(wire_amount_cents),
      wire_sent_at,
      state: 'intake',
      dispute_letter_text: null,
      bank_response_text: null,
      state_changed_at: new Date(),
      created_at: new Date(),
    };
    fakeCases.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  if (
    /^SELECT id, user_id, recovery_session_id, source_bank, destination_account_hint, wire_amount_cents, wire_sent_at, state, dispute_letter_text, bank_response_text, state_changed_at, created_at FROM wire_trace_cases WHERE id = \$1 AND user_id = \$2/i.test(
      trimmed,
    )
  ) {
    const [case_id, user_id] = params as [string, string];
    const row = fakeCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [
        {
          ...row,
          // pg returns BIGINT columns as strings by default; mirror that.
          wire_amount_cents: row.wire_amount_cents.toString(),
        },
      ],
      rowCount: 1,
    };
  }

  if (
    /^SELECT state, recovery_session_id FROM wire_trace_cases WHERE id = \$1 AND user_id = \$2/i.test(
      trimmed,
    )
  ) {
    const [case_id, user_id] = params as [string, string];
    const row = fakeCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [{ state: row.state, recovery_session_id: row.recovery_session_id }],
      rowCount: 1,
    };
  }

  if (
    /^UPDATE wire_trace_cases SET dispute_letter_text = \$3,/i.test(trimmed)
  ) {
    const [case_id, user_id, ct] = params as [string, string, string];
    const row = fakeCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    row.dispute_letter_text = ct;
    if (row.state === 'intake') {
      row.state = 'letter_drafted';
      row.state_changed_at = new Date();
    }
    return { rows: [], rowCount: 1 };
  }

  if (
    /^UPDATE wire_trace_cases SET state = \$3, state_changed_at = NOW\(\), bank_response_text = COALESCE\(\$4, bank_response_text\) WHERE id = \$1 AND user_id = \$2/i.test(
      trimmed,
    )
  ) {
    const [case_id, user_id, next_state, bank_response] = params as [
      string,
      string,
      FakeWireCase['state'],
      string | null,
    ];
    const row = fakeCases.find((c) => c.id === case_id && c.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    row.state = next_state;
    row.state_changed_at = new Date();
    if (bank_response !== null) row.bank_response_text = bank_response;
    return { rows: [], rowCount: 1 };
  }

  // ---- recovery_plus_purchases (used by hasRecoveryPlus) ----

  // Atomic NULL-session bind UPDATE — we never set up NULL-session
  // purchases in this test so this always returns 0 rows.
  if (
    /^UPDATE recovery_plus_purchases SET recovery_session_id = \$2 WHERE id = \( SELECT id FROM recovery_plus_purchases WHERE user_id = \$1 AND recovery_session_id IS NULL/i.test(
      trimmed,
    )
  ) {
    return { rows: [], rowCount: 0 };
  }

  if (
    /^SELECT id FROM recovery_plus_purchases WHERE user_id = \$1 AND recovery_session_id = \$2 AND refunded_at IS NULL/i.test(
      trimmed,
    )
  ) {
    const [user_id, session_id] = params as [string, string];
    const row = fakePurchases.find(
      (p) =>
        p.user_id === user_id &&
        p.recovery_session_id === session_id &&
        p.refunded_at === null,
    );
    return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // emitMetric → metric_counters UPSERT. Swallow.
  if (/^INSERT INTO metric_counters/i.test(trimmed)) {
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`unstubbed SQL: ${trimmed.slice(0, 200)}`);
};

beforeEach(() => {
  fakeCases = [];
  fakePurchases = [];
  nextCaseSeq = 1;
  nextPurchaseSeq = 1;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

// ----------------------------------------------------------------
// LLM stub factory
// ----------------------------------------------------------------

function stubLlm(opts: { capture?: { lastSystem?: string; lastUser?: string }; output?: string } = {}) {
  return async (input: { system: string; user: string }) => {
    if (opts.capture) {
      opts.capture.lastSystem = input.system;
      opts.capture.lastUser = input.user;
    }
    // Default: echo the disclaimer header + a token so we know the LLM
    // was actually called.
    return (
      opts.output ??
      `${agent.DISPUTE_LETTER_DISCLAIMER}\n\nDear Fraud Department,\n\n[stub LLM body]\n`
    );
  };
}

const USER_A = '00000000-0000-0000-0000-00000000000a';
const USER_B = '00000000-0000-0000-0000-00000000000b';
const SESSION_1 = '11111111-1111-1111-1111-111111111111';

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe('startWireTraceCase', () => {
  it('happy path inserts an intake row and returns case_id + state', async () => {
    entitleUser(USER_A, SESSION_1);
    const result = await agent.startWireTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_1,
      source_bank: 'Chase',
      destination_account_hint: '1234',
      wire_amount_cents: 5_000_000n,
      wire_sent_at: new Date('2026-05-01T00:00:00Z'),
    });
    assert.equal(result.state, 'intake');
    assert.match(result.case_id, /^wire-/);
    assert.equal(fakeCases.length, 1);
    const row = fakeCases[0]!;
    assert.equal(row.user_id, USER_A);
    assert.equal(row.source_bank, 'Chase');
    assert.equal(row.state, 'intake');
    // destination_account_hint is envelope-encrypted on the way in.
    assert.ok(row.destination_account_hint?.startsWith('v1:'));
    // And it round-trips back to '1234'.
    assert.equal(crypto.decryptString(row.destination_account_hint!), '1234');
  });

  it('throws RecoveryPlusRequiredError when user lacks entitlement', async () => {
    await assert.rejects(
      agent.startWireTraceCase({
        user_id: USER_A,
        recovery_session_id: SESSION_1,
        source_bank: 'Chase',
        wire_amount_cents: 100_000n,
        wire_sent_at: new Date(),
      }),
      (err: Error) => err.name === 'RecoveryPlusRequiredError',
    );
    assert.equal(fakeCases.length, 0);
  });

  it('handles BIGINT amount > 2^31 (commercial wire, $50k = 5_000_000n)', async () => {
    entitleUser(USER_A, SESSION_1);
    await agent.startWireTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_1,
      source_bank: 'Wells Fargo',
      wire_amount_cents: 5_000_000n,
      wire_sent_at: new Date(),
    });
    assert.equal(fakeCases[0]!.wire_amount_cents, 5_000_000n);
  });
});

describe('generateDisputeLetter', () => {
  async function setupCase(bank: string, opts: { hint?: string; amount?: bigint } = {}) {
    entitleUser(USER_A, SESSION_1);
    const r = await agent.startWireTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_1,
      source_bank: bank,
      destination_account_hint: opts.hint,
      wire_amount_cents: opts.amount ?? 100_000n,
      wire_sent_at: new Date('2026-05-01T00:00:00Z'),
    });
    return r.case_id;
  }

  it('happy path: returns letter with disclaimer; uses chase scaffold; stores ciphertext', async () => {
    const caseId = await setupCase('Chase', { hint: '9876' });
    const capture: { lastSystem?: string; lastUser?: string } = {};
    const result = await agent.generateDisputeLetter({
      case_id: caseId,
      user_id: USER_A,
      opts: { llmFn: stubLlm({ capture }) },
    });
    assert.ok(result.letter_text.includes(agent.DISPUTE_LETTER_DISCLAIMER));
    // Chase scaffold carries Reg E and the Chase fraud line — both must
    // be in the user prompt that the LLM received.
    assert.ok(capture.lastUser?.includes('CHASE'));
    assert.ok(capture.lastUser?.includes('Regulation E'));
    assert.ok(capture.lastUser?.includes('1-800-432-3117'));
    // Letter is persisted as ciphertext (v1:<iv>:<tag>:<ct>).
    const row = fakeCases.find((c) => c.id === caseId)!;
    assert.ok(row.dispute_letter_text?.startsWith('v1:'));
    // And state advanced from 'intake' to 'letter_drafted'.
    assert.equal(row.state, 'letter_drafted');
  });

  it('throws RecoveryPlusRequiredError when entitlement is gone', async () => {
    // Seed a case under entitlement, then revoke the purchase.
    const caseId = await setupCase('Chase');
    fakePurchases = [];
    await assert.rejects(
      agent.generateDisputeLetter({
        case_id: caseId,
        user_id: USER_A,
        opts: { llmFn: stubLlm() },
      }),
      (err: Error) => err.name === 'RecoveryPlusRequiredError',
    );
  });

  it('throws NotFoundError on cross-user case_id', async () => {
    const caseId = await setupCase('Chase');
    // User B has no case; tries to read user A's. hasRecoveryPlus is
    // not even reached — the user-scoped SELECT returns no rows.
    await assert.rejects(
      agent.generateDisputeLetter({
        case_id: caseId,
        user_id: USER_B,
        opts: { llmFn: stubLlm() },
      }),
      (err: Error) => err.name === 'NotFoundError',
    );
  });

  it('bank routing: wells_fargo uses SWIFT framing', async () => {
    const caseId = await setupCase('Wells Fargo');
    const capture: { lastSystem?: string; lastUser?: string } = {};
    await agent.generateDisputeLetter({
      case_id: caseId,
      user_id: USER_A,
      opts: { llmFn: stubLlm({ capture }) },
    });
    assert.ok(capture.lastUser?.includes('WELLS FARGO'));
    assert.ok(capture.lastUser?.includes('MT103'));
    assert.ok(capture.lastUser?.includes('MT192'));
  });

  it('bank routing: unknown bank falls through to generic scaffold', async () => {
    const caseId = await setupCase('Unknown Local Credit Union');
    const capture: { lastSystem?: string; lastUser?: string } = {};
    await agent.generateDisputeLetter({
      case_id: caseId,
      user_id: USER_A,
      opts: { llmFn: stubLlm({ capture }) },
    });
    assert.ok(capture.lastUser?.includes('GENERIC US BANK'));
    assert.ok(capture.lastUser?.includes('generic'));
  });

  it('LLM output missing disclaimer → service prepends it (defense in depth)', async () => {
    const caseId = await setupCase('Chase');
    const result = await agent.generateDisputeLetter({
      case_id: caseId,
      user_id: USER_A,
      opts: {
        llmFn: stubLlm({
          output: 'Dear Fraud Department,\n\nThis letter omits the disclaimer.\n',
        }),
      },
    });
    // The service must prepend it.
    assert.ok(
      result.letter_text.startsWith(agent.DISPUTE_LETTER_DISCLAIMER),
      `expected letter to start with disclaimer, got: ${result.letter_text.slice(0, 200)}`,
    );
    // Ciphertext in DB decrypts to the same prepended-disclaimer text.
    const row = fakeCases.find((c) => c.id === caseId)!;
    const decrypted = crypto.decryptString(row.dispute_letter_text!);
    assert.ok(decrypted.startsWith(agent.DISPUTE_LETTER_DISCLAIMER));
  });
});

describe('advanceWireTraceCase', () => {
  async function seedCaseInState(state: FakeWireCase['state']) {
    entitleUser(USER_A, SESSION_1);
    const r = await agent.startWireTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_1,
      source_bank: 'Chase',
      wire_amount_cents: 100_000n,
      wire_sent_at: new Date(),
    });
    const row = fakeCases.find((c) => c.id === r.case_id)!;
    row.state = state;
    return r.case_id;
  }

  it('intake → letter_drafted is a legal transition', async () => {
    const caseId = await seedCaseInState('intake');
    const r = await agent.advanceWireTraceCase({
      case_id: caseId,
      user_id: USER_A,
      next_state: 'letter_drafted',
    });
    assert.equal(r.state, 'letter_drafted');
    assert.equal(fakeCases.find((c) => c.id === caseId)!.state, 'letter_drafted');
  });

  it('intake → recalled is REJECTED (must go through letter_drafted)', async () => {
    const caseId = await seedCaseInState('intake');
    await assert.rejects(
      agent.advanceWireTraceCase({
        case_id: caseId,
        user_id: USER_A,
        next_state: 'recalled',
      }),
      (err: Error) => err.name === 'InvalidStateTransitionError',
    );
    // Row stays in intake.
    assert.equal(fakeCases.find((c) => c.id === caseId)!.state, 'intake');
  });

  it('cross-user advance throws NotFoundError', async () => {
    const caseId = await seedCaseInState('intake');
    await assert.rejects(
      agent.advanceWireTraceCase({
        case_id: caseId,
        user_id: USER_B,
        next_state: 'letter_drafted',
      }),
      (err: Error) => err.name === 'NotFoundError',
    );
  });

  it('bank_acknowledged with bank_response_text writes ciphertext', async () => {
    const caseId = await seedCaseInState('user_sent');
    await agent.advanceWireTraceCase({
      case_id: caseId,
      user_id: USER_A,
      next_state: 'bank_acknowledged',
      bank_response_text: 'Chase case #BC-99-12345 opened; recall message dispatched.',
    });
    const row = fakeCases.find((c) => c.id === caseId)!;
    assert.equal(row.state, 'bank_acknowledged');
    assert.ok(row.bank_response_text?.startsWith('v1:'));
    assert.equal(
      crypto.decryptString(row.bank_response_text!),
      'Chase case #BC-99-12345 opened; recall message dispatched.',
    );
  });

  it('terminal-state case rejects further forward transitions', async () => {
    const caseId = await seedCaseInState('recalled');
    await assert.rejects(
      agent.advanceWireTraceCase({
        case_id: caseId,
        user_id: USER_A,
        next_state: 'denied',
      }),
      (err: Error) => err.name === 'InvalidStateTransitionError',
    );
  });
});

describe('getWireTraceCase', () => {
  it('returns the row for the owning user', async () => {
    entitleUser(USER_A, SESSION_1);
    const r = await agent.startWireTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_1,
      source_bank: 'Chase',
      wire_amount_cents: 100_000n,
      wire_sent_at: new Date(),
    });
    const row = await agent.getWireTraceCase({ case_id: r.case_id, user_id: USER_A });
    assert.ok(row);
    assert.equal(row?.user_id, USER_A);
    assert.equal(row?.state, 'intake');
  });

  it('cross-user returns null', async () => {
    entitleUser(USER_A, SESSION_1);
    const r = await agent.startWireTraceCase({
      user_id: USER_A,
      recovery_session_id: SESSION_1,
      source_bank: 'Chase',
      wire_amount_cents: 100_000n,
      wire_sent_at: new Date(),
    });
    const row = await agent.getWireTraceCase({ case_id: r.case_id, user_id: USER_B });
    assert.equal(row, null);
  });

  it('non-existent case_id returns null', async () => {
    const row = await agent.getWireTraceCase({
      case_id: '99999999-9999-9999-9999-999999999999',
      user_id: USER_A,
    });
    assert.equal(row, null);
  });
});
