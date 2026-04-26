import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// Guardian-alert SMS escalator. The claim+send pattern has one job:
// make escalation one-shot. Once `escalated_at` is stamped inside the
// withTx claim, a Twilio failure must NOT cause a re-send on the next
// tick. These tests prove that invariant by:
//   1. Stubbing `withTx` so we control exactly which rows are claimed
//      AND so every claim "stamps" escalated_at from the worker's POV.
//      (In the real DB the SQL itself does the stamp; here we just
//      return the claimed rows and treat them as stamped.)
//   2. Stubbing global `fetch` to force Twilio outcomes.
//   3. Asserting the shape of the Twilio POST body — specifically that
//      MessagingServiceSid is used when TWILIO_MESSAGING_FROM starts
//      with "MG", and From=... is used otherwise. Swapping these two
//      would cause Twilio to either 400 (SID in From field) or send
//      from the wrong pool (From when MG was expected).
//   4. Asserting a null phone_number skips the row entirely — we'd
//      crash Twilio's validator with a bare `To=` otherwise.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://escalator-test';
// Twilio wiring must be present or runEscalator short-circuits to a
// zero-count return before it ever touches withTx / fetch. We set all
// three and flip TWILIO_MESSAGING_FROM per-test below by reaching into
// the module-level `config` export.
process.env.TWILIO_ACCOUNT_SID = 'AC_test_sid';
process.env.TWILIO_AUTH_TOKEN = 'test_token';
process.env.TWILIO_MESSAGING_FROM = '+14155550123';

const db = await import('../src/lib/db.ts');
const { config } = await import('../src/config.ts');
const escalator = await import('../src/workers/guardianAlertEscalator.ts');

interface AlertRow {
  id: string;
  guardian_user_id: string;
  title: string;
  body: string;
  phone_number: string | null;
}

let claimedRows: AlertRow[] = [];
// Track which rows the worker believes are stamped. In production the
// UPDATE ... RETURNING inside the withTx claim does this atomically.
// We record it at claim time on the pool.connect()-backed fake client
// so we can assert the one-shot invariant holds across a Twilio outage.
const stamped: string[] = [];

// Route withTx through its real implementation by swapping pool.query +
// pool.connect. withTx calls pool.connect() to check out a client, then
// BEGIN / the worker's query / COMMIT / release. Our fake client
// returns claimedRows on the worker's UPDATE ... RETURNING and
// swallows BEGIN/COMMIT/ROLLBACK.
const fakeQuery = async (
  text: string,
  _params?: unknown[],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.trim().toUpperCase();
  if (t.startsWith('BEGIN') || t.startsWith('COMMIT') || t.startsWith('ROLLBACK')) {
    return { rows: [], rowCount: 0 };
  }
  // The only real query the worker issues is the big UPDATE ga SET
  // escalated_at = NOW() ... RETURNING. Recognize it by the RETURNING
  // clause that reads the joined guardian phone_number — that's the
  // worker's claim query specifically and not any stray BEGIN/COMMIT
  // or migration-adjacent call.
  if (/RETURNING\s+ga\.id/i.test(text)) {
    for (const r of claimedRows) stamped.push(r.id);
    return { rows: claimedRows, rowCount: claimedRows.length };
  }
  return { rows: [], rowCount: 0 };
};
(db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
(db.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => ({
  query: fakeQuery,
  release: () => {},
});

// fetch stub configurable per-test.
const realFetch = globalThis.fetch;
let fetchHandler: (input: string, init: RequestInit) => Promise<Response> = async () =>
  new Response('{}', { status: 200 });
const fetchCalls: Array<{ url: string; body: string }> = [];
(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const url = typeof input === 'string' ? input : (input as URL).toString();
  const body = (init?.body as string) ?? '';
  fetchCalls.push({ url, body });
  return fetchHandler(url, init ?? {});
}) as unknown as typeof fetch;

before(() => {
  assert.equal(typeof escalator.runEscalator, 'function');
});

beforeEach(() => {
  claimedRows = [];
  stamped.length = 0;
  fetchCalls.length = 0;
  fetchHandler = async () => new Response('{}', { status: 200 });
  // Reset From between tests — tests that care flip it explicitly.
  (config as unknown as { TWILIO_MESSAGING_FROM: string }).TWILIO_MESSAGING_FROM =
    '+14155550123';
});

after(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
});

describe('runEscalator — Twilio 500 one-shot invariant', () => {
  it('stamps every claimed row even when every SMS send fails', async () => {
    claimedRows = [
      {
        id: 'alert-1',
        guardian_user_id: 'g1',
        title: 'Critical',
        body: 'check on mom',
        phone_number: '+14155550101',
      },
      {
        id: 'alert-2',
        guardian_user_id: 'g2',
        title: 'Critical',
        body: 'check on dad',
        phone_number: '+14155550102',
      },
    ];
    fetchHandler = async () => new Response('twilio exploded', { status: 500 });

    const res = await escalator.runEscalator();

    // Both rows got stamped — the stamp happens at claim time, so a
    // Twilio failure can never un-stamp them. This is what prevents
    // double-texting a guardian on a subsequent tick.
    assert.deepEqual(stamped.sort(), ['alert-1', 'alert-2']);
    assert.equal(res.considered, 2);
    assert.equal(res.sent, 0);
    assert.equal(res.skipped, 2);
  });
});

describe('runEscalator — Twilio From/MessagingServiceSid selection', () => {
  it('uses MessagingServiceSid when TWILIO_MESSAGING_FROM starts with "MG"', async () => {
    (config as unknown as { TWILIO_MESSAGING_FROM: string }).TWILIO_MESSAGING_FROM =
      'MG1234567890abcdef';
    claimedRows = [
      {
        id: 'alert-3',
        guardian_user_id: 'g3',
        title: 'Critical',
        body: 'x',
        phone_number: '+14155550103',
      },
    ];
    fetchHandler = async () => new Response('{}', { status: 201 });

    await escalator.runEscalator();

    assert.equal(fetchCalls.length, 1);
    const body = fetchCalls[0]!.body;
    // Twilio requires MessagingServiceSid for MG... identifiers. Passing
    // them via From= is technically accepted by some Twilio SDKs but
    // not the REST API — it 400s with "From is not a valid phone
    // number." The SID form is the only correct one.
    assert.ok(
      /MessagingServiceSid=MG1234567890abcdef/.test(body),
      `expected MessagingServiceSid in body, got: ${body}`,
    );
    assert.ok(!/(^|&)From=/.test(body), `From= must NOT be set for SID, got: ${body}`);
  });

  it('uses From= when TWILIO_MESSAGING_FROM is a bare +E.164 number', async () => {
    (config as unknown as { TWILIO_MESSAGING_FROM: string }).TWILIO_MESSAGING_FROM =
      '+14155550123';
    claimedRows = [
      {
        id: 'alert-4',
        guardian_user_id: 'g4',
        title: 'Critical',
        body: 'x',
        phone_number: '+14155550104',
      },
    ];
    fetchHandler = async () => new Response('{}', { status: 201 });

    await escalator.runEscalator();

    assert.equal(fetchCalls.length, 1);
    const body = fetchCalls[0]!.body;
    assert.ok(
      /(^|&)From=%2B14155550123/.test(body),
      `expected URL-encoded From=+14155550123 in body, got: ${body}`,
    );
    assert.ok(
      !/MessagingServiceSid=/.test(body),
      `MessagingServiceSid must NOT be set for bare E.164, got: ${body}`,
    );
  });
});

describe('runEscalator — null guardian phone_number', () => {
  it('skips rows with a null phone_number entirely — no fetch call', async () => {
    claimedRows = [
      {
        id: 'alert-5',
        guardian_user_id: 'g5',
        title: 'Critical',
        body: 'x',
        // Real-world case: guardian user exists but never captured
        // their phone. We must NOT POST `To=` blank to Twilio.
        phone_number: null,
      },
    ];
    fetchHandler = async () => new Response('{}', { status: 201 });

    const res = await escalator.runEscalator();

    assert.equal(fetchCalls.length, 0, 'fetch must not be called for a null-phone row');
    assert.equal(res.considered, 1);
    assert.equal(res.sent, 0);
    assert.equal(res.skipped, 1);
    // Row still counts as stamped — we already committed to not
    // re-trying, so the guardian never gets ambushed by a retry months
    // later if they add their phone.
    assert.deepEqual(stamped, ['alert-5']);
  });
});
