import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// emitGuardianAlert fan-out filter matrix.
//
// The two selector knobs have subtle joint semantics:
//   - onlyUserIds:    restrict fan-out to this set.
//   - excludeUserIds: drop these ids from whatever the base set is.
// The intersection (`onlyUserIds ∩ excludeUserIds`) must resolve to
// zero deliveries — an exclude always beats an include. A bug here
// causes the "user picked ONE specific person" copy to ship to every
// guardian on a plan (dishonest for everyone but the named one) OR
// causes a named guardian to get the banner twice (their first-person
// alert + the fan-out banner).
//
// Critical severity also triggers an email fan-out on top of the
// in-DB insert. We assert sendEmail fires once per guardian with an
// email present.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://guardian-alerts-test';

const db = await import('../src/lib/db.ts');
const email = await import('../src/lib/email.ts');
const { emitGuardianAlert, _resetCooldownForTests } = await import(
  '../src/services/guardianAlerts.ts'
);

const SUBJECT = '00000000-0000-0000-0000-000000000001';
const GUARDIANS = ['g1', 'g2', 'g3', 'g4', 'g5'].map(
  (tag, i) => `00000000-0000-0000-0000-00000000100${i}`,
);
const [g1, g2, g3, g4, g5] = GUARDIANS;

interface QueryCall {
  text: string;
  params: unknown[];
}
const queryLog: QueryCall[] = [];

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  queryLog.push({ text, params });
  const t = text.trim();

  // guardianUserIdsFor — return all 5 seeded guardians.
  if (/WITH plan AS/i.test(t)) {
    return { rows: GUARDIANS.map((user_id) => ({ user_id })), rowCount: GUARDIANS.length };
  }

  // subjectUser → family_plan_id lookup.
  if (/^SELECT family_plan_id[\s\S]+FROM family_members/i.test(t)) {
    return { rows: [{ family_plan_id: 'plan-1' }], rowCount: 1 };
  }

  // Multi-row INSERT INTO guardian_alerts — report back an accurate
  // rowCount so the function's delivered tally reflects the VALUES
  // clause count.
  if (/^INSERT INTO guardian_alerts/i.test(t)) {
    // Each guardian consumes 8 params (guardian_user_id, subject,
    // plan, kind, severity, title, body, payload). Row count = params / 8.
    const rows = Math.floor(params.length / 8);
    return { rows: [], rowCount: rows };
  }

  // Email fan-out: SELECT users where id = ANY($1::uuid[]) AND email IS NOT NULL.
  // Two guardians have emails in our fixture.
  if (/FROM users u WHERE u\.id = ANY\(\$1::uuid\[\]\)/i.test(t)) {
    const ids = (params[0] as string[]) ?? [];
    const withEmail = new Set([g2, g4]); // deterministic fixture
    const matching = ids
      .filter((id) => withEmail.has(id))
      .map((id) => ({ user_id: id, email: `${id.slice(0, 6)}@example.com`, display_name: null }));
    return { rows: matching, rowCount: matching.length };
  }

  // SELECT display_name FROM users WHERE id = $1 — subject lookup for
  // the email copy.
  if (/^SELECT display_name FROM users WHERE id = \$1/i.test(t)) {
    return { rows: [{ display_name: 'Parent Name' }], rowCount: 1 };
  }

  // sendEmail's audit row: INSERT INTO email_messages ... RETURNING id.
  // Counting these is a reliable proxy for "sendEmail was invoked" —
  // the function always writes the audit row before attempting to
  // dispatch through Resend.
  if (/^INSERT INTO email_messages/i.test(t)) {
    return { rows: [{ id: `em-${queryLog.length}` }], rowCount: 1 };
  }

  // Status UPDATE from sendEmail's dry-run finalizer.
  if (/^UPDATE email_messages/i.test(t)) {
    return { rows: [], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
};
(db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;

// We can't rebind `email.sendEmail` because ESM module bindings are
// read-only, and guardianAlerts reaches it through a dynamic import
// inside the function — swapping the namespace object on our end
// wouldn't affect the dynamically-imported binding anyway. Instead we
// detect the call indirectly: sendEmail() always issues an INSERT
// INTO email_messages at the top of its body for audit purposes. We
// count those inserts in the fakeQuery above. One insert per
// guardian-with-email proves the fan-out fired.
void email; // imported to force the module to load.

before(() => {
  assert.equal(typeof emitGuardianAlert, 'function');
});

beforeEach(async () => {
  queryLog.length = 0;
  // R8 cooldown is process-level state — clear it between cases so a
  // prior test's emit doesn't suppress this one. Production path never
  // touches the helper.
  await _resetCooldownForTests(SUBJECT, GUARDIANS);
});

function insertCall(): QueryCall | undefined {
  return queryLog.find((c) => /^INSERT INTO guardian_alerts/i.test(c.text.trim()));
}

function guardianIdsInInsert(call: QueryCall): string[] {
  const out: string[] = [];
  // params are laid out 8 per guardian, guardian_user_id first.
  for (let i = 0; i < call.params.length; i += 8) {
    out.push(call.params[i] as string);
  }
  return out;
}

describe('emitGuardianAlert — filter matrix', () => {
  it('no filters → delivered === 5', async () => {
    const res = await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'shield_critical',
      title: 't',
      body: 'b',
    });
    assert.equal(res.delivered, 5);
    const ins = insertCall();
    assert.ok(ins, 'expected an INSERT call');
    assert.equal(guardianIdsInInsert(ins).length, 5);
  });

  it('onlyUserIds:[g3] → delivered === 1 and INSERT contains only g3', async () => {
    const res = await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'shield_critical',
      title: 't',
      body: 'b',
      onlyUserIds: [g3],
    });
    assert.equal(res.delivered, 1);
    const ins = insertCall();
    assert.ok(ins);
    const ids = guardianIdsInInsert(ins);
    assert.deepEqual(ids, [g3]);
  });

  it('excludeUserIds:[g3] → delivered === 4 and g3 is absent', async () => {
    const res = await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'shield_critical',
      title: 't',
      body: 'b',
      excludeUserIds: [g3],
    });
    assert.equal(res.delivered, 4);
    const ins = insertCall();
    assert.ok(ins);
    const ids = guardianIdsInInsert(ins);
    assert.equal(ids.length, 4);
    assert.ok(!ids.includes(g3), 'g3 must not appear in the INSERT');
    // Everyone else does.
    for (const g of [g1, g2, g4, g5]) {
      assert.ok(ids.includes(g), `${g} should still be in the fan-out`);
    }
  });

  it('onlyUserIds:[g3] + excludeUserIds:[g3] → delivered === 0, no INSERT called', async () => {
    const res = await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'shield_critical',
      title: 't',
      body: 'b',
      onlyUserIds: [g3],
      excludeUserIds: [g3],
    });
    assert.equal(res.delivered, 0);
    assert.equal(insertCall(), undefined, 'no guardian_alerts INSERT should run');
  });
});

describe('emitGuardianAlert — critical severity email fan-out', () => {
  it('fires sendEmail once per guardian whose users.email IS NOT NULL', async () => {
    await emitGuardianAlert({
      subjectUserId: SUBJECT,
      kind: 'shield_critical',
      severity: 'critical',
      title: 'Critical title',
      body: 'Critical body',
    });
    // sendEmail always writes an audit row `INSERT INTO email_messages
    // ... RETURNING id` before anything else. One such insert per
    // guardian-with-email is the observable signature of the fan-out.
    const emailInserts = queryLog.filter((c) =>
      /^INSERT INTO email_messages/i.test(c.text.trim()),
    );
    assert.equal(
      emailInserts.length,
      2,
      'expected one email_messages insert per guardian with an address (g2, g4)',
    );
    // Spot-check that the template column was 'guardian_critical_alert'.
    for (const ins of emailInserts) {
      assert.equal(
        ins.params[2],
        'guardian_critical_alert',
        'template column should be guardian_critical_alert',
      );
    }
  });
});
