import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// End-to-end route tests for:
//  (a) PATCH /v1/users/me — phone_number normalization happy path + 400
//      on invalid input.
//  (b) POST /v1/breach/monitor — 409 identifier_already_monitored dedup
//      when the same (user_id, kind, value_hash) already exists.
//
// Same pattern as stripeWebhook.test.ts: stand up config env BEFORE any
// src/* imports, then swap pool.query with an in-memory fake that
// pattern-matches on the SQL prefix and mutates a local store.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://routes-test';
// Dev-bearer shortcut so Authorization: Bearer <API_SHARED_SECRET>
// lands us in req.appUser as the synthetic pro user. NODE_ENV must not
// be 'production' for this to engage (default 'development' works).
process.env.ALLOW_DEV_BEARER = 'true';
process.env.ENZOIC_MOCK = 'true';

const Fastify = (await import('fastify')).default;
const rateLimit = (await import('@fastify/rate-limit')).default;
const db = await import('../src/lib/db.ts');
const { authRoutes } = await import('../src/routes/auth.ts');
const { breachRoutes } = await import('../src/routes/breach.ts');

const DEV_USER_ID = '00000000-0000-0000-0000-000000000000';
const SHARED_SECRET = process.env.API_SHARED_SECRET!;

interface UsersRow {
  id: string;
  phone_number: string | null;
  display_name: string | null;
}
interface MonitoredRow {
  id: string;
  user_id: string;
  kind: 'email' | 'phone';
  value_hash: string;
  display_value: string;
  created_at: Date;
  status: string;
  last_scanned_at: Date | null;
  last_scan_exposure_count: number;
}

interface DbState {
  users: Map<string, UsersRow>;
  monitors: Array<MonitoredRow>;
  counter: number;
}

const dbState: DbState = { users: new Map(), monitors: [], counter: 0 };

function resetDb(): void {
  dbState.users.clear();
  dbState.users.set(DEV_USER_ID, {
    id: DEV_USER_ID,
    phone_number: null,
    display_name: null,
  });
  dbState.monitors.length = 0;
  dbState.counter = 0;
}

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.trim();

  // Count monitors per user (used by the per-user cap in breachRoutes).
  if (/^SELECT COUNT\(\*\)[\s\S]+FROM monitored_identifiers/i.test(t)) {
    const userId = params[0] as string;
    const count = dbState.monitors.filter((m) => m.user_id === userId).length;
    return { rows: [{ count: String(count) }], rowCount: 1 };
  }

  // Breach add: INSERT ... ON CONFLICT DO NOTHING RETURNING id, created_at.
  if (/^INSERT INTO monitored_identifiers[\s\S]+ON CONFLICT[\s\S]+DO NOTHING/i.test(t)) {
    const [user_id, kind, value_hash, display_value] = params as [
      string, 'email' | 'phone', string, string,
    ];
    const dup = dbState.monitors.find(
      (m) => m.user_id === user_id && m.kind === kind && m.value_hash === value_hash,
    );
    if (dup) {
      return { rows: [], rowCount: 0 }; // conflict path
    }
    const id = `mon-${++dbState.counter}`;
    const row: MonitoredRow = {
      id,
      user_id,
      kind,
      value_hash,
      display_value,
      created_at: new Date(),
      status: 'active',
      last_scanned_at: null,
      last_scan_exposure_count: 0,
    };
    dbState.monitors.push(row);
    return { rows: [{ id, created_at: row.created_at }], rowCount: 1 };
  }

  // Breach add conflict-resolve SELECT for the existing row's id.
  if (/^SELECT id FROM monitored_identifiers[\s\S]+WHERE user_id = \$1 AND kind = \$2 AND value_hash = \$3/i.test(t)) {
    const [user_id, kind, value_hash] = params as [string, string, string];
    const row = dbState.monitors.find(
      (m) => m.user_id === user_id && m.kind === kind && m.value_hash === value_hash,
    );
    return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // breachScan.insertExposures happy-path UPDATE after scan.
  if (/^UPDATE monitored_identifiers[\s\S]+SET last_scanned_at = NOW\(\)/i.test(t)) {
    const id = params[0] as string;
    const row = dbState.monitors.find((m) => m.id === id);
    if (row) {
      row.last_scanned_at = new Date();
      row.last_scan_exposure_count = (params[1] as number) ?? 0;
      row.status = 'active';
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // Fetch email for digest; no email in our fixture so return empty.
  if (/^SELECT email FROM users WHERE id = \$1/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }

  // PATCH /v1/users/me — UPDATE users SET ... WHERE id = $N RETURNING phone_number.
  if (/^UPDATE users SET[\s\S]+RETURNING phone_number/i.test(t)) {
    const userId = params[params.length - 1] as string;
    const row = dbState.users.get(userId);
    if (!row) return { rows: [], rowCount: 0 };
    // Parse the SET clause to figure out which params go where. We know
    // the route builds `phone_number = $n` and/or `display_name = $n`
    // in order; walk the SET clause in order and pair with params.
    const setMatch = t.match(/SET ([^W]+?)\s+WHERE/i)?.[1] ?? '';
    const pieces = setMatch.split(',').map((s) => s.trim());
    pieces.forEach((piece, i) => {
      const [col] = piece.split('=').map((s) => s.trim());
      if (col === 'phone_number') row.phone_number = params[i] as string | null;
      if (col === 'display_name') row.display_name = params[i] as string | null;
    });
    return { rows: [{ phone_number: row.phone_number }], rowCount: 1 };
  }

  // PATCH echo-current SELECT when no fields are supplied.
  if (/^SELECT phone_number FROM users WHERE id = \$1/i.test(t)) {
    const row = dbState.users.get(params[0] as string);
    return row
      ? { rows: [{ phone_number: row.phone_number }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // tier check issued by ensureTierPersisted — accept silently.
  if (/^UPDATE users SET tier/i.test(t)) return { rows: [], rowCount: 1 };

  // Swallow anything else so a stray query (ensureTierPersisted reads,
  // analytics, etc.) doesn't surface as a test failure.
  return { rows: [], rowCount: 0 };
};

// Redirect every src/lib/db call through the in-memory fake. withTx()
// calls pool.connect() to check out a client; our fake connect hands
// back a client whose .query() is the same fake, so BEGIN/COMMIT/etc.
// all get swallowed by the SQL switch at the bottom of fakeQuery.
(db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
(db.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => ({
  query: fakeQuery,
  release: () => {},
});

// Build one Fastify instance with just the routes we need. We register
// @fastify/rate-limit because breachRoutes + the new PATCH both attach
// `config.rateLimit`, which is a no-op unless the plugin is present.
const app = Fastify({ logger: false });
await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
await app.register(authRoutes);
await app.register(breachRoutes);
await app.ready();

const bearer = { authorization: `Bearer ${SHARED_SECRET}` };

before(() => {
  resetDb();
});

beforeEach(() => {
  resetDb();
});

describe('PATCH /v1/users/me — phone_number', () => {
  it('normalizes a US phone to E.164 and persists it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/users/me',
      headers: bearer,
      payload: { phone_number: '(415) 555-2671' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ok: boolean; phone_number: string };
    assert.equal(body.ok, true);
    assert.equal(body.phone_number, '+14155552671');
    // Persisted on the fake users row.
    assert.equal(dbState.users.get(DEV_USER_ID)?.phone_number, '+14155552671');
  });

  it('returns 400 invalid_phone on an unparseable value', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/users/me',
      headers: bearer,
      payload: { phone_number: 'not-a-phone' },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string };
    assert.equal(body.error, 'invalid_phone');
    // phone_number on the row stays null — invalid input must not persist.
    assert.equal(dbState.users.get(DEV_USER_ID)?.phone_number, null);
  });

  it('clears phone_number when client sends null', async () => {
    // Seed a value first.
    dbState.users.get(DEV_USER_ID)!.phone_number = '+14155552671';
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/users/me',
      headers: bearer,
      payload: { phone_number: null },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { phone_number: string | null };
    assert.equal(body.phone_number, null);
    assert.equal(dbState.users.get(DEV_USER_ID)?.phone_number, null);
  });
});

describe('POST /v1/breach/monitor — duplicate 409', () => {
  it('returns 409 identifier_already_monitored when the same email is re-added', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/breach/monitor',
      headers: bearer,
      payload: { kind: 'email', value: 'alice@example.com' },
    });
    assert.equal(first.statusCode, 200);
    const firstId = (first.json() as { monitored: { id: string } }).monitored.id;

    const dup = await app.inject({
      method: 'POST',
      url: '/v1/breach/monitor',
      headers: bearer,
      payload: { kind: 'email', value: 'ALICE@example.com' }, // same after lower-case
    });
    assert.equal(dup.statusCode, 409);
    const body = dup.json() as { error: string; existing_id: string | null };
    assert.equal(body.error, 'identifier_already_monitored');
    assert.equal(body.existing_id, firstId);
    // Only one row exists in the fake DB — the dup did not create a second.
    assert.equal(dbState.monitors.length, 1);
  });
});
