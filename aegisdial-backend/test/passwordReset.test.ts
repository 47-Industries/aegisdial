import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';

// Route tests for the password-reset flow:
//   POST /auth/email/forgot-password
//   POST /auth/email/reset-password
//
// Same in-memory pool-mock pattern as the other route tests. Bcrypt
// rounds are real (cost ~10) so the suite is a few hundred ms total —
// faster than wiring a faster-bcrypt shim and tests how rounds behave.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-pwreset-shared-secret-xyz';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://pwreset-test';
process.env.ENZOIC_MOCK = 'true';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { authRoutes } = await import('../src/routes/auth.ts');

const USER_A_EMAIL = 'alice@example.com';
const USER_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

interface UserRow {
  id: string;
  email: string;
  email_hash: string;
  auth_method: 'email' | 'apple';
}
interface ResetCodeRow {
  id: string;
  user_id: string;
  code_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}
interface DbState {
  users: Map<string, UserRow>;
  resetCodes: ResetCodeRow[];
}

const dbState: DbState = { users: new Map(), resetCodes: [] };

async function resetDb(): Promise<void> {
  dbState.users.clear();
  dbState.resetCodes.length = 0;
  // Alice exists; her current password is "old-password-1234"
  const oldHash = await bcrypt.hash('old-password-1234', 4);
  dbState.users.set(USER_A_ID, {
    id: USER_A_ID,
    email: USER_A_EMAIL,
    email_hash: oldHash,
    auth_method: 'email',
  });
}

let lastResetCodeIdCounter = 0;

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.trim();

  // SELECT id FROM users WHERE email = $1 AND auth_method = 'email'
  if (
    /^SELECT id FROM users WHERE email = \$1 AND auth_method = 'email'/i.test(t)
  ) {
    const email = (params[0] as string).toLowerCase();
    for (const u of dbState.users.values()) {
      if (u.email.toLowerCase() === email && u.auth_method === 'email') {
        return { rows: [{ id: u.id }], rowCount: 1 };
      }
    }
    return { rows: [], rowCount: 0 };
  }

  // UPDATE password_reset_codes SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL
  if (
    /^UPDATE password_reset_codes\s+SET used_at = NOW\(\)\s+WHERE user_id = \$1 AND used_at IS NULL/i.test(
      t,
    )
  ) {
    const userId = params[0] as string;
    let updated = 0;
    for (const r of dbState.resetCodes) {
      if (r.user_id === userId && r.used_at === null) {
        r.used_at = new Date();
        updated++;
      }
    }
    return { rows: [], rowCount: updated };
  }

  // INSERT INTO password_reset_codes (user_id, code_hash, expires_at)
  if (/^INSERT INTO password_reset_codes/i.test(t)) {
    const [user_id, code_hash, expiresIso] = params as [string, string, string];
    dbState.resetCodes.push({
      id: `reset-${++lastResetCodeIdCounter}`,
      user_id,
      code_hash,
      expires_at: new Date(expiresIso),
      used_at: null,
      created_at: new Date(),
    });
    return { rows: [], rowCount: 1 };
  }

  // SELECT id, code_hash FROM password_reset_codes WHERE user_id ... AND used_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1
  if (
    /^SELECT id, code_hash FROM password_reset_codes/i.test(t)
  ) {
    const userId = params[0] as string;
    const candidate = dbState.resetCodes
      .filter(
        (r) =>
          r.user_id === userId &&
          r.used_at === null &&
          r.expires_at.getTime() > Date.now(),
      )
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    if (!candidate) return { rows: [], rowCount: 0 };
    return {
      rows: [{ id: candidate.id, code_hash: candidate.code_hash }],
      rowCount: 1,
    };
  }

  // Atomic burn-code + update-password CTE
  if (
    /^WITH burned AS \(\s*UPDATE password_reset_codes SET used_at = NOW\(\) WHERE id = \$1/i.test(
      t,
    )
  ) {
    const [codeId, newHash, userId] = params as [string, string, string];
    const code = dbState.resetCodes.find((r) => r.id === codeId);
    if (code) code.used_at = new Date();
    const user = dbState.users.get(userId);
    if (user) user.email_hash = newHash;
    return { rows: [], rowCount: 1 };
  }

  // The email layer audits every send by inserting into email_messages
  // and reading back the generated id. We don't care about email
  // payloads in this suite — just return a synthetic id so the void
  // sendEmail() promise resolves cleanly after the test ends.
  if (/^INSERT INTO email_messages/i.test(t)) {
    return { rows: [{ id: 'email-msg-fake' }], rowCount: 1 };
  }
  if (/^UPDATE email_messages/i.test(t)) {
    return { rows: [], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
};

(db as unknown as { pool: { query: typeof fakeQuery } }).pool.query =
  fakeQuery;

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(authRoutes);
  return app;
}

const json = { 'content-type': 'application/json' };

// Extract the actual code from the latest reset row by trying digits 0-999999
// (we don't have it in plaintext after insertion). The test rounds use bcrypt
// cost=10 from the route + we compare against the stored hash. For a deterministic
// test we hook into the email sender path — but since the email layer fires
// asynchronously via void sendEmail(...), we can't easily intercept. Instead,
// we replace the code-hash with a known one after the insert and then submit
// that known code.
async function plantKnownCode(userId: string, code: string): Promise<void> {
  // Find the most recent unused code and overwrite its hash with bcrypt(code).
  const row = dbState.resetCodes
    .filter((r) => r.user_id === userId && r.used_at === null)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
  if (!row) throw new Error('no unused reset code row to plant on');
  row.code_hash = await bcrypt.hash(code, 4);
}

describe('Password reset flow', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  before(async () => {
    app = await buildApp();
  });
  beforeEach(resetDb);

  it('forgot-password for unknown email returns 200 (no enumeration leak)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/email/forgot-password',
      headers: json,
      payload: JSON.stringify({ email: 'nobody@example.com' }),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { sent: true });
    assert.equal(dbState.resetCodes.length, 0);
  });

  it('forgot-password for known email writes a code row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/email/forgot-password',
      headers: json,
      payload: JSON.stringify({ email: USER_A_EMAIL }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(dbState.resetCodes.length, 1);
    const row = dbState.resetCodes[0]!;
    assert.equal(row.user_id, USER_A_ID);
    assert.equal(row.used_at, null);
    assert.ok(row.expires_at.getTime() > Date.now());
  });

  it('a second forgot-password invalidates the first code', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/email/forgot-password',
      headers: json,
      payload: JSON.stringify({ email: USER_A_EMAIL }),
    });
    await app.inject({
      method: 'POST',
      url: '/auth/email/forgot-password',
      headers: json,
      payload: JSON.stringify({ email: USER_A_EMAIL }),
    });
    assert.equal(dbState.resetCodes.length, 2);
    const oldRow = dbState.resetCodes[0]!;
    const newRow = dbState.resetCodes[1]!;
    assert.notEqual(oldRow.used_at, null, 'old code should be marked used');
    assert.equal(newRow.used_at, null);
  });

  it('reset-password with wrong code returns 401', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/email/forgot-password',
      headers: json,
      payload: JSON.stringify({ email: USER_A_EMAIL }),
    });
    await plantKnownCode(USER_A_ID, '123456');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/email/reset-password',
      headers: json,
      payload: JSON.stringify({
        email: USER_A_EMAIL,
        code: '999999',
        new_password: 'new-better-password-1',
      }),
    });
    assert.equal(res.statusCode, 401);
    const user = dbState.users.get(USER_A_ID)!;
    assert.ok(
      await bcrypt.compare('old-password-1234', user.email_hash),
      'password should NOT have changed',
    );
  });

  it('reset-password with correct code rotates the password + burns the code', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/email/forgot-password',
      headers: json,
      payload: JSON.stringify({ email: USER_A_EMAIL }),
    });
    await plantKnownCode(USER_A_ID, '654321');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/email/reset-password',
      headers: json,
      payload: JSON.stringify({
        email: USER_A_EMAIL,
        code: '654321',
        new_password: 'new-better-password-1',
      }),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { reset: true });

    const user = dbState.users.get(USER_A_ID)!;
    assert.ok(
      await bcrypt.compare('new-better-password-1', user.email_hash),
      'password should be the new one',
    );
    assert.equal(
      await bcrypt.compare('old-password-1234', user.email_hash),
      false,
      'old password should no longer work',
    );

    // Code marked used — a replay should fail.
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/email/reset-password',
      headers: json,
      payload: JSON.stringify({
        email: USER_A_EMAIL,
        code: '654321',
        new_password: 'another-attempt',
      }),
    });
    assert.equal(replay.statusCode, 401);
  });

  it('reset-password for unknown email returns 401 (same code as wrong-code)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/email/reset-password',
      headers: json,
      payload: JSON.stringify({
        email: 'nobody@example.com',
        code: '123456',
        new_password: 'anything-here-1',
      }),
    });
    assert.equal(res.statusCode, 401);
  });

  it('reset-password with too-short password returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/email/reset-password',
      headers: json,
      payload: JSON.stringify({
        email: USER_A_EMAIL,
        code: '123456',
        new_password: 'short',
      }),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(
      (res.json() as { error: string }).error,
      'invalid_body',
    );
  });

  it('reset-password with non-numeric code returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/email/reset-password',
      headers: json,
      payload: JSON.stringify({
        email: USER_A_EMAIL,
        code: 'abcdef',
        new_password: 'valid-password-1',
      }),
    });
    assert.equal(res.statusCode, 400);
  });
});
