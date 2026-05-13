import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Email Shield — /v1/email/* route tests.
// Stubs:
//   - db.pool.query — selectively returns rows for each SQL pattern
//   - cache (Redis) — in-memory Map
//   - GmailProvider / MicrosoftGraphProvider / ImapProvider —
//     swapped with stub implementations
// Goals:
//   - Pro-tier gating (requireProTier returns 402)
//   - OAuth init returns an authorize URL + state, stashes state in Redis
//   - OAuth callback redeems state ONCE, CSRF rejection on user_id
//     mismatch, persists encrypted credentials
//   - IMAP link routes auth failures to 401, server errors to 502
//   - Accounts list returns NO token fields
//   - Delete account flips status='revoked' even if revoke() throws
//   - Scans list filters flagged_only + email_account_id
//   - Settings + read + write + 503 on migration-missing
//   - Compromise check rate limit + dedupe-cache + composite verdict

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-email-routes';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://email-routes';
process.env.ALLOW_DEV_BEARER = 'true';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'gmail-cid';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'gmail-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.aegisdial.com/v1/email/oauth/google/callback';
process.env.MICROSOFT_OAUTH_CLIENT_ID = 'msft-cid';
process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'msft-secret';
process.env.MICROSOFT_OAUTH_REDIRECT_URI = 'https://api.aegisdial.com/v1/email/oauth/microsoft/callback';

const Fastify = (await import('fastify')).default;
const fastifyRateLimit = (await import('@fastify/rate-limit')).default;
const db = await import('../src/lib/db.ts');
const cache = await import('../src/lib/cache.ts');
const { emailShieldRoutes } = await import('../src/routes/emailShield.ts');
const { readMaybeEncrypted } = await import('../src/lib/crypto.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;

// ----------------------------------------------------------------
// Test stubs
// ----------------------------------------------------------------

interface FakeAccount {
  id: string;
  user_id: string;
  provider: 'gmail' | 'microsoft' | 'imap';
  provider_account_id: string;
  display_email: string;
  oauth_token_ct: string | null;
  oauth_refresh_token_ct: string | null;
  oauth_expires_at: Date | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_username: string | null;
  app_password_ct: string | null;
  status: 'active' | 'auth_failed' | 'revoked' | 'paused';
  last_poll_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

let fakeAccounts: FakeAccount[] = [];
let fakeScans: Array<{
  id: string;
  user_id: string;
  email_account_id: string;
  external_message_id: string;
  from_address_hash: string;
  sender_domain: string;
  subject_excerpt: string;
  fraud_score: number;
  verdict: string;
  triggered_categories: unknown[];
  reasons: unknown[];
  url_findings: unknown[];
  attachment_findings: unknown[];
  scanned_at: Date;
}> = [];
let fakeReports: Array<{
  id: string;
  user_id: string;
  email_account_id: string;
  overall_verdict: 'clean' | 'concerns' | 'compromised';
  findings: Record<string, unknown>;
  generated_at: Date;
}> = [];
let fakeUserSettings = new Map<string, string>();
let throwOnSettings = false;

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  // INSERT email_accounts (upsert)
  if (/^INSERT INTO email_accounts/i.test(trimmed)) {
    const [
      user_id, provider, provider_account_id, display_email,
      oauth_token_ct, oauth_refresh_token_ct, oauth_expires_at,
      imap_host, imap_port, imap_username, app_password_ct,
    ] = params as [
      string, FakeAccount['provider'], string, string,
      string | null, string | null, Date | null,
      string | null, number | null, string | null, string | null,
    ];
    const existing = fakeAccounts.find(
      (a) => a.user_id === user_id && a.provider === provider && a.provider_account_id === provider_account_id,
    );
    const id = existing?.id ?? `acct-${fakeAccounts.length + 1}`;
    const acct: FakeAccount = {
      id, user_id, provider, provider_account_id, display_email,
      oauth_token_ct, oauth_refresh_token_ct, oauth_expires_at,
      imap_host, imap_port, imap_username, app_password_ct,
      status: 'active',
      last_poll_at: null,
      created_at: existing?.created_at ?? new Date(),
      updated_at: new Date(),
    };
    if (existing) Object.assign(existing, acct);
    else fakeAccounts.push(acct);
    return { rows: [{ id }], rowCount: 1 };
  }
  // SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2
  if (/^SELECT \* FROM email_accounts WHERE id = \$1 AND user_id = \$2/i.test(trimmed)) {
    const [id, user_id] = params as [string, string];
    const row = fakeAccounts.find((a) => a.id === id && a.user_id === user_id);
    return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  // SELECT (list) email_accounts WHERE user_id
  if (/^SELECT id, provider, display_email, status, last_poll_at, created_at FROM email_accounts/i.test(trimmed)) {
    const [user_id] = params as [string];
    const filtered = fakeAccounts.filter((a) => a.user_id === user_id);
    return { rows: filtered, rowCount: filtered.length };
  }
  // UPDATE email_accounts SET status='revoked'
  if (/^UPDATE email_accounts SET status = 'revoked'/i.test(trimmed)) {
    const [id] = params as [string];
    const row = fakeAccounts.find((a) => a.id === id);
    if (row) row.status = 'revoked';
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  // SELECT scans
  if (/^SELECT id, email_account_id, external_message_id/i.test(trimmed)) {
    const filtered = fakeScans
      .filter((s) => s.user_id === (params[0] as string))
      .filter((s) => !/verdict IN/.test(trimmed) || s.verdict === 'suspicious' || s.verdict === 'fraud')
      .slice(0, params[params.length - 1] as number);
    return { rows: filtered, rowCount: filtered.length };
  }
  // GET settings
  if (/SELECT COALESCE\(email_scan_mode/i.test(trimmed)) {
    if (throwOnSettings) {
      const err = new Error('column "email_scan_mode" does not exist') as Error & { code: string };
      err.code = '42703';
      throw err;
    }
    const user_id = params[0] as string;
    return {
      rows: [{ email_scan_mode: fakeUserSettings.get(user_id) ?? 'manual_only' }],
      rowCount: 1,
    };
  }
  // POST settings
  if (/^UPDATE users SET email_scan_mode/i.test(trimmed)) {
    if (throwOnSettings) {
      const err = new Error('column "email_scan_mode" does not exist') as Error & { code: string };
      err.code = '42703';
      throw err;
    }
    const [mode, user_id] = params as [string, string];
    fakeUserSettings.set(user_id, mode);
    return { rows: [{ id: user_id }], rowCount: 1 };
  }
  // Cached compromise report lookup
  if (/^SELECT id, overall_verdict, findings, generated_at FROM email_compromise_reports/i.test(trimmed)) {
    const [user_id, account_id] = params as [string, string];
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    const cached = fakeReports
      .filter(
        (r) =>
          r.user_id === user_id &&
          r.email_account_id === account_id &&
          r.generated_at.getTime() > cutoff &&
          r.overall_verdict === 'clean',
      )
      .sort((a, b) => b.generated_at.getTime() - a.generated_at.getTime())[0];
    return cached ? { rows: [cached], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  // INSERT compromise report
  if (/^INSERT INTO email_compromise_reports/i.test(trimmed)) {
    const [id, user_id, email_account_id, overall_verdict, findingsJson] = params as [
      string, string, string, 'clean' | 'concerns' | 'compromised', string,
    ];
    fakeReports.push({
      id, user_id, email_account_id, overall_verdict,
      findings: JSON.parse(findingsJson),
      generated_at: new Date(),
    });
    return { rows: [], rowCount: 1 };
  }
  // Adversarial-review M3 fix: hard-error on unrecognized SQL
  // instead of silently returning rowCount=0. A future route that
  // adds a new query pattern not in the stub would otherwise pass
  // tests on a phantom empty result while production hit real
  // behavior. Loud beats silent.
  throw new Error(`unstubbed SQL pattern: ${trimmed.slice(0, 120)}`);
};

// In-memory Redis stub
const fakeRedis = new Map<string, { value: string; expiresAt: number }>();
const originalRedisGet = cache.redis.get.bind(cache.redis);
const originalRedisSet = cache.redis.set.bind(cache.redis);
const originalRedisDel = cache.redis.del.bind(cache.redis);
function installRedisStub() {
  (cache.redis as unknown as { get: typeof fakeGet }).get = fakeGet;
  (cache.redis as unknown as { set: typeof fakeSet }).set = fakeSet;
  (cache.redis as unknown as { del: typeof fakeDel }).del = fakeDel;
}
async function fakeGet(key: string): Promise<string | null> {
  const entry = fakeRedis.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    fakeRedis.delete(key);
    return null;
  }
  return entry.value;
}
async function fakeSet(key: string, value: string, _mode?: string, _ttl?: number): Promise<string> {
  const ttlMs = typeof _ttl === 'number' ? _ttl * 1000 : 600_000;
  fakeRedis.set(key, { value, expiresAt: Date.now() + ttlMs });
  return 'OK';
}
async function fakeDel(key: string): Promise<number> {
  return fakeRedis.delete(key) ? 1 : 0;
}

// ----------------------------------------------------------------
// Provider stubs — swap module-level singletons
// ----------------------------------------------------------------

const gmailMod = await import('../src/services/email/gmail.ts');
const graphMod = await import('../src/services/email/microsoftGraph.ts');
const imapMod = await import('../src/services/email/imap.ts');

let stubLinkResult: Awaited<ReturnType<gmailMod.GmailProvider['linkAccount']>> | null = null;
let stubLinkError: Error | null = null;
let stubInboxRules: Array<{ rule_id: string; concern: string; destination: string | null; name: string; created_at: Date | null }> = [];
let stubOAuthGrants: unknown[] = [];
let stubRecentLogins: unknown[] = [];

function installProviderStubs() {
  const linkAccount = async () => {
    if (stubLinkError) throw stubLinkError;
    return stubLinkResult!;
  };
  const stubAudit = () => Promise.resolve(stubInboxRules as never);
  const stubGrants = () => Promise.resolve(stubOAuthGrants as never);
  const stubLogins = () => Promise.resolve(stubRecentLogins as never);
  const stubRevoke = async () => undefined;
  for (const proto of [gmailMod.GmailProvider.prototype, graphMod.MicrosoftGraphProvider.prototype, imapMod.ImapProvider.prototype]) {
    (proto as unknown as { linkAccount: typeof linkAccount }).linkAccount = linkAccount;
    (proto as unknown as { getInboxRules: typeof stubAudit }).getInboxRules = stubAudit;
    (proto as unknown as { getOAuthGrants: typeof stubGrants }).getOAuthGrants = stubGrants;
    (proto as unknown as { getRecentLogins: typeof stubLogins }).getRecentLogins = stubLogins;
    (proto as unknown as { revoke: typeof stubRevoke }).revoke = stubRevoke;
  }
}

beforeEach(() => {
  fakeAccounts = [];
  fakeScans = [];
  fakeReports = [];
  fakeUserSettings = new Map();
  fakeRedis.clear();
  throwOnSettings = false;
  stubLinkResult = null;
  stubLinkError = null;
  stubInboxRules = [];
  stubOAuthGrants = [];
  stubRecentLogins = [];
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
  installRedisStub();
  installProviderStubs();
});

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(fastifyRateLimit, { global: false, max: 9999, timeWindow: '1 minute' });
  await app.register(emailShieldRoutes);
  return app;
}

const PRO_BEARER = `Bearer ${SHARED_SECRET}`;

// ----------------------------------------------------------------
// Pro-tier gating
// ----------------------------------------------------------------

describe('Email Shield routes — Pro-tier gating', () => {
  it('rejects unauthenticated /v1/email/accounts with 401', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/email/accounts' });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  it('rejects unauthenticated POST /v1/email/accounts/oauth/init with 401', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/accounts/oauth/init',
        payload: { provider: 'gmail' },
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });
});

// ----------------------------------------------------------------
// OAuth init + callback
// ----------------------------------------------------------------

describe('POST /v1/email/accounts/oauth/init', () => {
  it('returns an authorize URL with PKCE + stashes state in Redis', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/accounts/oauth/init',
        headers: { authorization: PRO_BEARER },
        payload: { provider: 'gmail' },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { authorize_url: string; state: string };
      assert.match(body.authorize_url, /accounts\.google\.com\/o\/oauth2\/v2\/auth/);
      assert.match(body.authorize_url, /code_challenge_method=S256/);
      assert.match(body.authorize_url, /gmail\.readonly/);
      assert.ok(body.state.length >= 32);
      // State stashed in Redis with PKCE verifier.
      const stashed = fakeRedis.get(`email-oauth-state:${body.state}`);
      assert.ok(stashed);
    } finally {
      await app.close();
    }
  });

  it('rejects unknown provider with 400', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/accounts/oauth/init',
        headers: { authorization: PRO_BEARER },
        payload: { provider: 'aol' },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

describe('POST /v1/email/accounts/oauth/callback', () => {
  it('exchanges code + persists encrypted credentials', async () => {
    const app = await buildApp();
    try {
      // First init to stash state.
      const init = await app.inject({
        method: 'POST',
        url: '/v1/email/accounts/oauth/init',
        headers: { authorization: PRO_BEARER },
        payload: { provider: 'gmail' },
      });
      const { state } = init.json() as { state: string };

      // Stub provider.linkAccount to return creds.
      stubLinkResult = {
        provider: 'gmail',
        provider_account_id: 'google-sub-123',
        display_email: 'alice@example.com',
        oauth_token: 'AT-PLAINTEXT',
        oauth_refresh_token: 'RT-PLAINTEXT',
        oauth_expires_at: new Date(Date.now() + 3600 * 1000),
        imap_host: null,
        imap_port: null,
        imap_username: null,
        app_password: null,
      };
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/accounts/oauth/callback',
        headers: { authorization: PRO_BEARER },
        payload: { provider: 'gmail', code: 'AUTHCODE', state },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { id: string; provider: string; display_email: string; status: string };
      assert.equal(body.provider, 'gmail');
      assert.equal(body.display_email, 'alice@example.com');
      assert.equal(body.status, 'active');
      // Token must be envelope-encrypted at rest.
      const stored = fakeAccounts[0]!;
      assert.ok(stored.oauth_token_ct);
      assert.match(stored.oauth_token_ct!, /^v1:/, 'token must be envelope-encrypted (v1: prefix)');
      // And decrypt back to plaintext via crypto helper.
      assert.equal(readMaybeEncrypted(stored.oauth_token_ct), 'AT-PLAINTEXT');
    } finally {
      await app.close();
    }
  });

  it('rejects callback with expired/invalid state', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/accounts/oauth/callback',
        headers: { authorization: PRO_BEARER },
        payload: { provider: 'gmail', code: 'AUTHCODE', state: 'a'.repeat(64) },
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /state_expired_or_invalid/);
    } finally {
      await app.close();
    }
  });

  it('H2 fix: TWO concurrent callbacks with the same state — exactly one succeeds', async () => {
    const app = await buildApp();
    try {
      const init = await app.inject({
        method: 'POST',
        url: '/v1/email/accounts/oauth/init',
        headers: { authorization: PRO_BEARER },
        payload: { provider: 'gmail' },
      });
      const { state } = init.json() as { state: string };
      stubLinkResult = {
        provider: 'gmail',
        provider_account_id: 'g-sub',
        display_email: 'a@b.com',
        oauth_token: 'AT', oauth_refresh_token: 'RT',
        oauth_expires_at: new Date(Date.now() + 3600_000),
        imap_host: null, imap_port: null, imap_username: null, app_password: null,
      };
      // Fire both callbacks IN PARALLEL with the same state.
      // Pre-H2-fix the cacheGet + cacheInvalidate pair was two
      // round trips and both calls passed the existence check
      // before either deleted. With GETDEL atomic, exactly one
      // wins.
      const [a, b] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/v1/email/accounts/oauth/callback',
          headers: { authorization: PRO_BEARER },
          payload: { provider: 'gmail', code: 'C', state },
        }),
        app.inject({
          method: 'POST',
          url: '/v1/email/accounts/oauth/callback',
          headers: { authorization: PRO_BEARER },
          payload: { provider: 'gmail', code: 'C', state },
        }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      assert.deepEqual(codes, [200, 400], `exactly one callback must succeed, got ${codes.join(',')}`);
    } finally {
      await app.close();
    }
  });

  it('state is single-use — second redemption fails', async () => {
    const app = await buildApp();
    try {
      const init = await app.inject({
        method: 'POST',
        url: '/v1/email/accounts/oauth/init',
        headers: { authorization: PRO_BEARER },
        payload: { provider: 'gmail' },
      });
      const { state } = init.json() as { state: string };
      stubLinkResult = {
        provider: 'gmail',
        provider_account_id: 'g-sub',
        display_email: 'a@b.com',
        oauth_token: 'AT', oauth_refresh_token: 'RT',
        oauth_expires_at: new Date(Date.now() + 3600_000),
        imap_host: null, imap_port: null, imap_username: null, app_password: null,
      };
      const first = await app.inject({
        method: 'POST',
        url: '/v1/email/accounts/oauth/callback',
        headers: { authorization: PRO_BEARER },
        payload: { provider: 'gmail', code: 'C', state },
      });
      assert.equal(first.statusCode, 200);
      // Replay with same state must fail.
      const replay = await app.inject({
        method: 'POST',
        url: '/v1/email/accounts/oauth/callback',
        headers: { authorization: PRO_BEARER },
        payload: { provider: 'gmail', code: 'C', state },
      });
      assert.equal(replay.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

// ----------------------------------------------------------------
// IMAP link
// ----------------------------------------------------------------

describe('POST /v1/email/accounts/imap/link', () => {
  it('persists encrypted IMAP credentials', async () => {
    const app = await buildApp();
    try {
      stubLinkResult = {
        provider: 'imap',
        provider_account_id: 'imap.icloud.com:993:user@icloud.com',
        display_email: 'user@icloud.com',
        oauth_token: null, oauth_refresh_token: null, oauth_expires_at: null,
        imap_host: 'imap.icloud.com', imap_port: 993, imap_username: 'user@icloud.com',
        app_password: 'app-pwd-secret',
      };
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/accounts/imap/link',
        headers: { authorization: PRO_BEARER },
        payload: {
          host: 'imap.icloud.com', port: 993,
          username: 'user@icloud.com', credential: 'app-pwd-secret',
          credential_kind: 'app_password',
        },
      });
      assert.equal(res.statusCode, 200);
      const stored = fakeAccounts[0]!;
      // app_password ENCRYPTED at rest, never plaintext.
      assert.ok(stored.app_password_ct);
      assert.match(stored.app_password_ct!, /^v1:/);
      assert.equal(readMaybeEncrypted(stored.app_password_ct), 'app-pwd-secret');
    } finally {
      await app.close();
    }
  });

  it('maps IMAP auth failure to 401', async () => {
    const app = await buildApp();
    try {
      stubLinkError = new Error('IMAP auth failed: invalid credentials');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/accounts/imap/link',
        headers: { authorization: PRO_BEARER },
        payload: {
          host: 'imap.icloud.com', port: 993,
          username: 'user@icloud.com', credential: 'wrong',
          credential_kind: 'app_password',
        },
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  it('maps non-auth IMAP errors to 502', async () => {
    const app = await buildApp();
    try {
      stubLinkError = new Error('IMAP link failed: ECONNREFUSED');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/accounts/imap/link',
        headers: { authorization: PRO_BEARER },
        payload: {
          host: 'imap.unreachable', port: 993,
          username: 'a@b', credential: 'x',
          credential_kind: 'app_password',
        },
      });
      assert.equal(res.statusCode, 502);
    } finally {
      await app.close();
    }
  });
});

// ----------------------------------------------------------------
// List + delete
// ----------------------------------------------------------------

describe('GET /v1/email/accounts', () => {
  it('returns linked accounts WITHOUT token fields', async () => {
    const app = await buildApp();
    try {
      fakeAccounts.push({
        id: 'acct-1', user_id: '00000000-0000-0000-0000-000000000000',
        provider: 'gmail', provider_account_id: 'g-sub',
        display_email: 'alice@example.com',
        oauth_token_ct: 'v1:abc:def:ghi',
        oauth_refresh_token_ct: 'v1:xyz:uvw:rst',
        oauth_expires_at: new Date(),
        imap_host: null, imap_port: null, imap_username: null, app_password_ct: null,
        status: 'active', last_poll_at: null,
        created_at: new Date(), updated_at: new Date(),
      });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/email/accounts',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { accounts: Record<string, unknown>[] };
      assert.equal(body.accounts.length, 1);
      // Strict: no token field of any shape leaks.
      const acctJson = JSON.stringify(body.accounts[0]);
      assert.ok(!/oauth_token/i.test(acctJson), `token leak in response: ${acctJson}`);
      assert.ok(!/refresh_token/i.test(acctJson), `refresh token leak: ${acctJson}`);
      assert.ok(!/app_password/i.test(acctJson), `app_password leak: ${acctJson}`);
      assert.ok(!/_ct/.test(acctJson), `ciphertext column leak: ${acctJson}`);
    } finally {
      await app.close();
    }
  });
});

describe('DELETE /v1/email/accounts/:id', () => {
  it('flips status=revoked even if provider.revoke() throws', async () => {
    const app = await buildApp();
    try {
      fakeAccounts.push({
        id: '00000000-0000-0000-0000-000000000001',
        user_id: '00000000-0000-0000-0000-000000000000',
        provider: 'gmail', provider_account_id: 'g-sub',
        display_email: 'a@b.com',
        oauth_token_ct: null, oauth_refresh_token_ct: null, oauth_expires_at: null,
        imap_host: null, imap_port: null, imap_username: null, app_password_ct: null,
        status: 'active', last_poll_at: null,
        created_at: new Date(), updated_at: new Date(),
      });
      // Make the stub revoke throw.
      const throwingRevoke = async () => {
        throw new Error('network down');
      };
      for (const proto of [gmailMod.GmailProvider.prototype]) {
        (proto as unknown as { revoke: typeof throwingRevoke }).revoke = throwingRevoke;
      }
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/email/accounts/00000000-0000-0000-0000-000000000001',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(fakeAccounts[0]!.status, 'revoked');
    } finally {
      await app.close();
    }
  });

  it('returns 404 when account not owned by caller', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/email/accounts/00000000-0000-0000-0000-000000000099',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

// ----------------------------------------------------------------
// Settings + scans
// ----------------------------------------------------------------

describe('Email Shield settings', () => {
  it('GET /v1/email/settings returns default manual_only', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/email/settings',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { email_scan_mode: string; available_modes: string[] };
      assert.equal(body.email_scan_mode, 'manual_only');
      assert.deepEqual(body.available_modes, ['disabled', 'manual_only', 'auto']);
    } finally {
      await app.close();
    }
  });

  it('POST /v1/email/settings updates + GET reflects it', async () => {
    const app = await buildApp();
    try {
      const post = await app.inject({
        method: 'POST',
        url: '/v1/email/settings',
        headers: { authorization: PRO_BEARER },
        payload: { email_scan_mode: 'auto' },
      });
      assert.equal(post.statusCode, 200);
      const get = await app.inject({
        method: 'GET',
        url: '/v1/email/settings',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal((get.json() as { email_scan_mode: string }).email_scan_mode, 'auto');
    } finally {
      await app.close();
    }
  });

  it('GET tolerates migration-not-applied (42703) → falls back to default', async () => {
    const app = await buildApp();
    try {
      throwOnSettings = true;
      const res = await app.inject({
        method: 'GET',
        url: '/v1/email/settings',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as { email_scan_mode: string }).email_scan_mode, 'manual_only');
    } finally {
      await app.close();
    }
  });

  it('POST returns 503 on migration-not-applied (42703)', async () => {
    const app = await buildApp();
    try {
      throwOnSettings = true;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/settings',
        headers: { authorization: PRO_BEARER },
        payload: { email_scan_mode: 'auto' },
      });
      assert.equal(res.statusCode, 503);
    } finally {
      await app.close();
    }
  });
});

// ----------------------------------------------------------------
// Compromise check
// ----------------------------------------------------------------

describe('POST /v1/email/compromise-check', () => {
  it('returns compromised verdict on external-forward inbox rule', async () => {
    const app = await buildApp();
    try {
      fakeAccounts.push({
        id: '00000000-0000-0000-0000-0000000000aa',
        user_id: '00000000-0000-0000-0000-000000000000',
        provider: 'gmail', provider_account_id: 'g-sub',
        display_email: 'me@company.com',
        oauth_token_ct: null, oauth_refresh_token_ct: null, oauth_expires_at: null,
        imap_host: null, imap_port: null, imap_username: null, app_password_ct: null,
        status: 'active', last_poll_at: null,
        created_at: new Date(), updated_at: new Date(),
      });
      stubInboxRules = [
        {
          rule_id: 'r-bec', name: 'innocent-looking',
          concern: 'forward_to_external',
          destination: 'attacker@evil.xyz',
          created_at: null,
        },
      ];
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/compromise-check',
        headers: { authorization: PRO_BEARER },
        payload: { email_account_id: '00000000-0000-0000-0000-0000000000aa' },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { overall_verdict: string; findings: Record<string, unknown> };
      assert.equal(body.overall_verdict, 'compromised');
      assert.ok(body.findings.inbox_rules);
    } finally {
      await app.close();
    }
  });

  it('returns clean verdict when no findings + persists report', async () => {
    const app = await buildApp();
    try {
      fakeAccounts.push({
        id: '00000000-0000-0000-0000-0000000000bb',
        user_id: '00000000-0000-0000-0000-000000000000',
        provider: 'imap', provider_account_id: 'imap:user',
        display_email: 'user@icloud.com',
        oauth_token_ct: null, oauth_refresh_token_ct: null, oauth_expires_at: null,
        imap_host: 'imap.icloud.com', imap_port: 993, imap_username: 'user',
        app_password_ct: null, status: 'active', last_poll_at: null,
        created_at: new Date(), updated_at: new Date(),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/compromise-check',
        headers: { authorization: PRO_BEARER },
        payload: { email_account_id: '00000000-0000-0000-0000-0000000000bb' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as { overall_verdict: string }).overall_verdict, 'clean');
      assert.equal(fakeReports.length, 1);
    } finally {
      await app.close();
    }
  });

  it('dedupe-cache: second call within 6h on a clean account returns cached', async () => {
    const app = await buildApp();
    try {
      fakeAccounts.push({
        id: '00000000-0000-0000-0000-0000000000cc',
        user_id: '00000000-0000-0000-0000-000000000000',
        provider: 'gmail', provider_account_id: 'g-sub',
        display_email: 'me@x.com',
        oauth_token_ct: null, oauth_refresh_token_ct: null, oauth_expires_at: null,
        imap_host: null, imap_port: null, imap_username: null, app_password_ct: null,
        status: 'active', last_poll_at: null,
        created_at: new Date(), updated_at: new Date(),
      });
      const first = await app.inject({
        method: 'POST',
        url: '/v1/email/compromise-check',
        headers: { authorization: PRO_BEARER },
        payload: { email_account_id: '00000000-0000-0000-0000-0000000000cc' },
      });
      assert.equal((first.json() as { from_cache: boolean }).from_cache, false);
      const second = await app.inject({
        method: 'POST',
        url: '/v1/email/compromise-check',
        headers: { authorization: PRO_BEARER },
        payload: { email_account_id: '00000000-0000-0000-0000-0000000000cc' },
      });
      assert.equal((second.json() as { from_cache: boolean }).from_cache, true);
      // Only ONE row in the DB — cached path did not double-insert.
      assert.equal(fakeReports.length, 1);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for an account the user does not own', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/compromise-check',
        headers: { authorization: PRO_BEARER },
        payload: { email_account_id: '00000000-0000-0000-0000-0000000000ff' },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  it('M1 fix: per-(user, account) hourly limit — second check on same account within 1h returns 429', async () => {
    const app = await buildApp();
    try {
      fakeAccounts.push({
        id: '00000000-0000-0000-0000-0000000000ee',
        user_id: '00000000-0000-0000-0000-000000000000',
        provider: 'gmail', provider_account_id: 'g-sub',
        display_email: 'me@x.com',
        oauth_token_ct: null, oauth_refresh_token_ct: null, oauth_expires_at: null,
        imap_host: null, imap_port: null, imap_username: null, app_password_ct: null,
        status: 'active', last_poll_at: null,
        created_at: new Date(), updated_at: new Date(),
      });
      // First call: 'concerns' verdict (so dedupe-cache won't cover
      // the second call — only 'clean' is cached).
      stubInboxRules = [
        { rule_id: 'r1', name: '', concern: 'delete_on_receive', destination: null, created_at: null },
      ];
      const first = await app.inject({
        method: 'POST',
        url: '/v1/email/compromise-check',
        headers: { authorization: PRO_BEARER },
        payload: { email_account_id: '00000000-0000-0000-0000-0000000000ee' },
      });
      assert.equal(first.statusCode, 200);
      assert.equal((first.json() as { overall_verdict: string }).overall_verdict, 'concerns');

      // Second call within the hour: blocked by per-account limit.
      const second = await app.inject({
        method: 'POST',
        url: '/v1/email/compromise-check',
        headers: { authorization: PRO_BEARER },
        payload: { email_account_id: '00000000-0000-0000-0000-0000000000ee' },
      });
      assert.equal(second.statusCode, 429);
      assert.match(second.body, /compromise_check_rate_limited/);
    } finally {
      await app.close();
    }
  });

  it('M2 fix: GET /v1/email/scans with malformed email_account_id returns 400 (not 500)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/email/scans?email_account_id=not-a-uuid',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /invalid_email_account_id/);
    } finally {
      await app.close();
    }
  });

  it('L1 fix: DELETE /v1/email/accounts/:id rejects 36-dashes garbage with 400', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/email/accounts/------------------------------------',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it('returns 409 when account status is not active (revoked)', async () => {
    const app = await buildApp();
    try {
      fakeAccounts.push({
        id: '00000000-0000-0000-0000-0000000000dd',
        user_id: '00000000-0000-0000-0000-000000000000',
        provider: 'gmail', provider_account_id: 'g-sub',
        display_email: 'me@x.com',
        oauth_token_ct: null, oauth_refresh_token_ct: null, oauth_expires_at: null,
        imap_host: null, imap_port: null, imap_username: null, app_password_ct: null,
        status: 'revoked', last_poll_at: null,
        created_at: new Date(), updated_at: new Date(),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/email/compromise-check',
        headers: { authorization: PRO_BEARER },
        payload: { email_account_id: '00000000-0000-0000-0000-0000000000dd' },
      });
      assert.equal(res.statusCode, 409);
    } finally {
      await app.close();
    }
  });
});

// Restore real Redis after tests so other suites that share the
// module don't see a stub.
process.on('beforeExit', () => {
  (cache.redis as unknown as { get: typeof originalRedisGet }).get = originalRedisGet;
  (cache.redis as unknown as { set: typeof originalRedisSet }).set = originalRedisSet;
  (cache.redis as unknown as { del: typeof originalRedisDel }).del = originalRedisDel;
});
