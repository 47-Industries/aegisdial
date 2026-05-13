import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Email Shield — Gmail provider tests.
// All network is stubbed via the httpFetch dependency injection
// boundary. Goals:
//   - linkAccount: token exchange + userinfo, returns plaintext creds
//   - fetchSince: first-poll (no cursor) vs incremental (history.list)
//   - normalizeMessage: parses Gmail MIME tree into IncomingMessage
//   - ensureAccessToken: refresh on expiry; RevokedError on
//     invalid_grant from Google
//   - callApi: maps 401/403 to RevokedError, 5xx/429 to TransientError
//   - getInboxRules: forward-to-external, delete-on-receive,
//     hide-from-inbox concerns surfaced

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-gmail-provider';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://gmail-provider';

const { GmailProvider, GmailApiError } = await import('../src/services/email/gmail.ts');
const { RevokedError, TransientError } = await import('../src/services/email/types.ts');
const { indexHash } = await import('../src/lib/crypto.ts');

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
type FetchStub = (url: string, init?: FetchInit) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

function makeResp(status: number, body: unknown): ReturnType<FetchStub> extends Promise<infer R> ? R : never {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as ReturnType<FetchStub> extends Promise<infer R> ? R : never;
}

function makeFetchStub(handlers: { match: (url: string, init?: FetchInit) => boolean; respond: (url: string, init?: FetchInit) => ReturnType<FetchStub> }[]): FetchStub {
  return async (url, init) => {
    for (const h of handlers) {
      if (h.match(url, init)) return h.respond(url, init);
    }
    throw new Error(`unstubbed fetch: ${url}`);
  };
}

function makeProvider(stub: FetchStub) {
  return new GmailProvider({
    httpFetch: stub,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'https://api.aegisdial.com/v1/email/oauth/google/callback',
  });
}

const TEST_CREDS = {
  provider: 'gmail' as const,
  provider_account_id: 'test-sub-123',
  display_email: 'user@example.com',
  oauth_token: 'access-tok-abc',
  oauth_refresh_token: 'refresh-tok-xyz',
  oauth_expires_at: new Date(Date.now() + 3600 * 1000),
  imap_host: null,
  imap_port: null,
  imap_username: null,
  app_password: null,
};

// ----------------------------------------------------------------
// PKCE helper
// ----------------------------------------------------------------

describe('GmailProvider — PKCE + authorize URL', () => {
  it('derives a deterministic SHA-256 base64url challenge from the verifier', () => {
    const verifier = 'abc-very-high-entropy-pkce-verifier-1234567890';
    const a = GmailProvider.pkceChallenge(verifier);
    const b = GmailProvider.pkceChallenge(verifier);
    assert.equal(a, b);
    // base64url: no +, /, =
    assert.ok(!a.includes('+'));
    assert.ok(!a.includes('/'));
    assert.ok(!a.includes('='));
  });

  it('builds an authorize URL with read-only Gmail scope and PKCE S256', () => {
    const url = GmailProvider.buildAuthorizeUrl({
      client_id: 'cid',
      redirect_uri: 'https://example.com/cb',
      state: 'st',
      pkce_challenge: 'challenge',
    });
    assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
    assert.match(url, /scope=openid\+email\+/);
    assert.match(url, /gmail\.readonly/);
    // Read-only invariant — must NOT request modify / send scopes.
    assert.ok(!/gmail\.modify/.test(url), 'modify scope requested — BAN');
    assert.ok(!/gmail\.send/.test(url), 'send scope requested — BAN');
    assert.match(url, /code_challenge_method=S256/);
    assert.match(url, /access_type=offline/);
  });
});

// ----------------------------------------------------------------
// linkAccount
// ----------------------------------------------------------------

describe('GmailProvider.linkAccount', () => {
  it('exchanges authorization_code for tokens + fetches userinfo', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url === 'https://oauth2.googleapis.com/token',
        respond: () =>
          makeResp(200, {
            access_token: 'AT-1',
            expires_in: 3600,
            refresh_token: 'RT-1',
            token_type: 'Bearer',
          }),
      },
      {
        match: (url) => url === 'https://openidconnect.googleapis.com/v1/userinfo',
        respond: () => makeResp(200, { sub: '108765', email: 'Alice@Example.COM', email_verified: true }),
      },
    ]);
    const provider = makeProvider(stub);
    const creds = await provider.linkAccount({
      provider: 'gmail',
      authorization_code: 'AUTHCODE',
      pkce_verifier: 'PKCE_V',
    });
    assert.equal(creds.provider, 'gmail');
    assert.equal(creds.provider_account_id, '108765');
    // display_email MUST be lowercased.
    assert.equal(creds.display_email, 'alice@example.com');
    assert.equal(creds.oauth_token, 'AT-1');
    assert.equal(creds.oauth_refresh_token, 'RT-1');
    assert.ok(creds.oauth_expires_at instanceof Date);
  });

  it('throws TransientError when Google rejects the code', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url === 'https://oauth2.googleapis.com/token',
        respond: () => makeResp(400, { error: 'invalid_grant', error_description: 'expired' }),
      },
    ]);
    const provider = makeProvider(stub);
    await assert.rejects(
      () =>
        provider.linkAccount({
          provider: 'gmail',
          authorization_code: 'BAD',
          pkce_verifier: 'PKCE_V',
        }),
      (err: unknown) => err instanceof TransientError,
    );
  });
});

// ----------------------------------------------------------------
// callApi error mapping
// ----------------------------------------------------------------

describe('GmailProvider — error mapping via callApi (exercised through fetchSince)', () => {
  it('401 maps to RevokedError', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/users/me/messages?'),
        respond: () => makeResp(401, { error: { code: 401, message: 'unauthorized' } }),
      },
    ]);
    const provider = makeProvider(stub);
    await assert.rejects(
      () => provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 10 }),
      (err: unknown) => err instanceof RevokedError,
    );
  });

  it('403 permissionDenied maps to RevokedError', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/users/me/messages?'),
        respond: () =>
          makeResp(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'permissionDenied' } }),
      },
    ]);
    const provider = makeProvider(stub);
    await assert.rejects(
      () => provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 10 }),
      (err: unknown) => err instanceof RevokedError,
    );
  });

  it('500 maps to TransientError', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/users/me/messages?'),
        respond: () => makeResp(500, 'internal server error'),
      },
    ]);
    const provider = makeProvider(stub);
    await assert.rejects(
      () => provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 10 }),
      (err: unknown) => err instanceof TransientError,
    );
  });

  it('429 maps to TransientError', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/users/me/messages?'),
        respond: () => makeResp(429, 'rate limit'),
      },
    ]);
    const provider = makeProvider(stub);
    await assert.rejects(
      () => provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 10 }),
      (err: unknown) => err instanceof TransientError,
    );
  });
});

// ----------------------------------------------------------------
// ensureAccessToken — refresh on expiry
// ----------------------------------------------------------------

describe('GmailProvider — token refresh on expiry', () => {
  it('refreshes when oauth_expires_at is in the past, mutating creds', async () => {
    let refreshCallCount = 0;
    let messagesCallCount = 0;
    const stub = makeFetchStub([
      {
        match: (url) => url === 'https://oauth2.googleapis.com/token',
        respond: () => {
          refreshCallCount++;
          return makeResp(200, {
            access_token: 'AT-REFRESHED',
            expires_in: 3600,
            token_type: 'Bearer',
          });
        },
      },
      {
        match: (url) => url.includes('/users/me/messages?'),
        respond: () => {
          messagesCallCount++;
          return makeResp(200, { messages: [] });
        },
      },
      {
        match: (url) => url.includes('/users/me/profile'),
        respond: () => makeResp(200, { emailAddress: 'a@b.com', messagesTotal: 0, threadsTotal: 0, historyId: '9999' }),
      },
    ]);
    const expiredCreds = {
      ...TEST_CREDS,
      oauth_expires_at: new Date(Date.now() - 1000), // expired 1s ago
    };
    const provider = makeProvider(stub);
    await provider.fetchSince({ credentials: expiredCreds, cursor: null, max_messages: 10 });
    assert.equal(refreshCallCount, 1, 'refresh should have been called once');
    assert.equal(messagesCallCount, 1);
    assert.equal(expiredCreds.oauth_token, 'AT-REFRESHED', 'creds mutated with new token');
  });

  it('throws RevokedError when refresh returns 400 invalid_grant', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url === 'https://oauth2.googleapis.com/token',
        respond: () => makeResp(400, { error: 'invalid_grant' }),
      },
    ]);
    const expiredCreds = {
      ...TEST_CREDS,
      oauth_expires_at: new Date(Date.now() - 1000),
    };
    const provider = makeProvider(stub);
    await assert.rejects(
      () => provider.fetchSince({ credentials: expiredCreds, cursor: null, max_messages: 10 }),
      (err: unknown) => err instanceof RevokedError,
    );
  });

  it('throws RevokedError when no refresh token is available', async () => {
    const provider = makeProvider(makeFetchStub([]));
    const noRefresh = {
      ...TEST_CREDS,
      oauth_refresh_token: null,
      oauth_expires_at: new Date(Date.now() - 1000),
    };
    await assert.rejects(
      () => provider.fetchSince({ credentials: noRefresh, cursor: null, max_messages: 10 }),
      (err: unknown) => err instanceof RevokedError,
    );
  });
});

// ----------------------------------------------------------------
// fetchSince — first poll vs incremental
// ----------------------------------------------------------------

describe('GmailProvider.fetchSince', () => {
  function buildMessageFixture(id: string, fromAddr: string, subject: string): unknown {
    return {
      id,
      threadId: `t-${id}`,
      historyId: '12345',
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: fromAddr },
          { name: 'To', value: 'user@example.com' },
          { name: 'Subject', value: subject },
          { name: 'Message-ID', value: `<${id}@gmail.com>` },
          { name: 'Authentication-Results', value: 'mx.google.com; spf=pass dkim=pass dmarc=pass' },
        ],
        body: { size: 5, data: Buffer.from('Hello').toString('base64url') },
      },
    };
  }

  it('first poll (cursor=null) lists latest messages and snapshots profile.historyId', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/users/me/messages?'),
        respond: () => makeResp(200, { messages: [{ id: 'm1' }, { id: 'm2' }] }),
      },
      {
        match: (url) => url.includes('/users/me/messages/m1'),
        respond: () => makeResp(200, buildMessageFixture('m1', '"Alice" <alice@example.com>', 'Hello world')),
      },
      {
        match: (url) => url.includes('/users/me/messages/m2'),
        respond: () => makeResp(200, buildMessageFixture('m2', 'bob@bank.com', 'Re: payment')),
      },
      {
        match: (url) => url.includes('/users/me/profile'),
        respond: () => makeResp(200, { emailAddress: 'user@example.com', messagesTotal: 100, threadsTotal: 50, historyId: '5555' }),
      },
    ]);
    const provider = makeProvider(stub);
    const result = await provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 10 });
    assert.equal(result.messages.length, 2);
    assert.equal(result.next_cursor, '5555');
    // Address canonicalization: display extracted, address lowercased.
    assert.equal(result.messages[0]!.from.display, 'Alice');
    assert.equal(result.messages[0]!.from.address, 'alice@example.com');
    assert.equal(result.messages[1]!.from.display, '');
    assert.equal(result.messages[1]!.from.address, 'bob@bank.com');
    // Auth results parsed.
    assert.equal(result.messages[0]!.auth_results.spf, 'pass');
    assert.equal(result.messages[0]!.auth_results.dkim, 'pass');
    assert.equal(result.messages[0]!.auth_results.dmarc, 'pass');
  });

  it('incremental poll (cursor set) uses history.list and returns the latest historyId', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/users/me/history'),
        respond: () =>
          makeResp(200, {
            history: [
              {
                id: '5556',
                messagesAdded: [{ message: { id: 'm3', threadId: 't-m3' } }],
              },
            ],
            historyId: '5556',
          }),
      },
      {
        match: (url) => url.includes('/users/me/messages/m3'),
        respond: () => makeResp(200, buildMessageFixture('m3', 'eve@evil.xyz', 'URGENT WIRE')),
      },
    ]);
    const provider = makeProvider(stub);
    const result = await provider.fetchSince({ credentials: TEST_CREDS, cursor: '5555', max_messages: 10 });
    assert.equal(result.messages.length, 1);
    // Adversarial-review C1 pin: external_message_id is Gmail's
    // internal raw.id, NOT the RFC-5322 Message-ID header. This is
    // the value that fetchAttachmentBytes URL-paths and the DB
    // UNIQUE constraint dedupes on.
    assert.equal(result.messages[0]!.external_message_id, 'm3');
    // The RFC Message-ID is still available via headers for the
    // scoring engine if it wants to use it for thread correlation.
    assert.equal(result.messages[0]!.headers['message-id'], '<m3@gmail.com>');
    assert.equal(result.next_cursor, '5556');
  });
});

// ----------------------------------------------------------------
// normalizeMessage — MIME walk + attachment hashing
// ----------------------------------------------------------------

describe('GmailProvider — message normalization', () => {
  it('walks multipart/alternative + multipart/mixed and extracts body + attachments', () => {
    const provider = new GmailProvider({
      httpFetch: () => { throw new Error('should not call'); },
      clientId: 'x',
      clientSecret: 'y',
      redirectUri: 'z',
    });
    const raw = {
      id: 'm-multi',
      threadId: 't-multi',
      historyId: '1',
      internalDate: '1700000000000',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: '"CFO" <cfo@company.com>' },
          { name: 'Reply-To', value: 'attacker@evil.xyz' },
          { name: 'To', value: 'finance@company.com' },
          { name: 'Subject', value: 'Urgent: Wire $50,000 today' },
          { name: 'Message-ID', value: '<m-multi@gmail.com>' },
        ],
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              {
                mimeType: 'text/plain',
                body: { data: Buffer.from('Please wire $50,000 to acct 9876.').toString('base64url'), size: 32 },
              },
              {
                mimeType: 'text/html',
                body: { data: Buffer.from('<p>Please wire $50,000.</p>').toString('base64url'), size: 26 },
              },
            ],
          },
          {
            mimeType: 'application/pdf',
            filename: 'invoice_Q4.pdf',
            body: { attachmentId: 'att-1', size: 12345 },
          },
        ],
      },
    };
    const msg = provider._normalizeMessageForTests(raw);
    assert.equal(msg.from.display, 'CFO');
    assert.equal(msg.from.address, 'cfo@company.com');
    // Reply-To divergence pinned — BEC signal.
    assert.equal(msg.reply_to?.address, 'attacker@evil.xyz');
    assert.match(msg.body_text, /wire \$50,000/);
    assert.match(msg.body_html, /<p>/);
    assert.equal(msg.attachments.length, 1);
    const att = msg.attachments[0]!;
    assert.equal(att.content_type, 'application/pdf');
    assert.equal(att.size_bytes, 12345);
    // Filename must be peppered-hashed, not stored plaintext.
    assert.equal(att.filename_hash, indexHash('invoice_Q4.pdf'));
    assert.notEqual(att.filename_hash, 'invoice_Q4.pdf');
    // received_at parsed from internalDate (ms epoch).
    assert.equal(msg.received_at.getTime(), 1700000000000);
  });

  it('parses Authentication-Results header for SPF/DKIM/DMARC verdicts', () => {
    const provider = new GmailProvider({
      httpFetch: () => { throw new Error('should not call'); },
      clientId: 'x', clientSecret: 'y', redirectUri: 'z',
    });
    const raw = {
      id: 'm-auth', threadId: 't', historyId: '1', internalDate: '1700000000000',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'a@b.com' },
          { name: 'Authentication-Results', value: 'mx.google.com; spf=fail; dkim=pass; dmarc=fail action=quarantine' },
        ],
        body: { data: Buffer.from('hi').toString('base64url'), size: 2 },
      },
    };
    const msg = provider._normalizeMessageForTests(raw);
    assert.equal(msg.auth_results.spf, 'fail');
    assert.equal(msg.auth_results.dkim, 'pass');
    assert.equal(msg.auth_results.dmarc, 'fail');
  });

  it('defaults auth_results to all "none" when header missing', () => {
    const provider = new GmailProvider({
      httpFetch: () => { throw new Error('should not call'); },
      clientId: 'x', clientSecret: 'y', redirectUri: 'z',
    });
    const raw = {
      id: 'm', threadId: 't', historyId: '1', internalDate: '1700000000000',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'From', value: 'a@b.com' }],
        body: { data: Buffer.from('hi').toString('base64url'), size: 2 },
      },
    };
    const msg = provider._normalizeMessageForTests(raw);
    assert.equal(msg.auth_results.spf, 'none');
    assert.equal(msg.auth_results.dkim, 'none');
    assert.equal(msg.auth_results.dmarc, 'none');
  });
});

// ----------------------------------------------------------------
// getInboxRules
// ----------------------------------------------------------------

describe('GmailProvider.getInboxRules', () => {
  it('surfaces forward-to-external as a finding', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/users/me/settings/filters'),
        respond: () =>
          makeResp(200, {
            filter: [
              {
                id: 'f-1',
                criteria: { from: 'boss@company.com' },
                action: { forward: 'attacker@evil.xyz' },
              },
            ],
          }),
      },
    ]);
    const provider = makeProvider(stub);
    const findings = await provider.getInboxRules({
      ...TEST_CREDS,
      display_email: 'me@company.com',
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.concern, 'forward_to_external');
    assert.equal(findings[0]!.destination, 'attacker@evil.xyz');
  });

  it('does NOT flag a forward to the same domain', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/users/me/settings/filters'),
        respond: () =>
          makeResp(200, {
            filter: [
              {
                id: 'f-1',
                action: { forward: 'archive@company.com' },
              },
            ],
          }),
      },
    ]);
    const provider = makeProvider(stub);
    const findings = await provider.getInboxRules({
      ...TEST_CREDS,
      display_email: 'me@company.com',
    });
    assert.equal(findings.length, 0);
  });

  it('flags delete-on-receive (TRASH label) and hide-from-inbox (INBOX removed) rules', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/users/me/settings/filters'),
        respond: () =>
          makeResp(200, {
            filter: [
              { id: 'f-trash', action: { addLabelIds: ['TRASH'] } },
              { id: 'f-archive', action: { removeLabelIds: ['INBOX'] } },
            ],
          }),
      },
    ]);
    const provider = makeProvider(stub);
    const findings = await provider.getInboxRules({
      ...TEST_CREDS,
      display_email: 'me@company.com',
    });
    const concerns = findings.map((f) => f.concern).sort();
    assert.deepEqual(concerns, ['delete_on_receive', 'hide_from_inbox']);
  });
});

// ----------------------------------------------------------------
// getOAuthGrants + getRecentLogins — documented [] behavior
// ----------------------------------------------------------------

describe('GmailProvider — audit methods Gmail does not expose', () => {
  it('getOAuthGrants returns [] (Gmail does not expose third-party grants via API)', async () => {
    const provider = makeProvider(makeFetchStub([]));
    const out = await provider.getOAuthGrants(TEST_CREDS);
    assert.deepEqual(out, []);
  });

  it('getRecentLogins returns [] (Gmail does not expose sign-in events via API)', async () => {
    const provider = makeProvider(makeFetchStub([]));
    const out = await provider.getRecentLogins(TEST_CREDS);
    assert.deepEqual(out, []);
  });
});

// ----------------------------------------------------------------
// revoke — best-effort, swallows non-2xx
// ----------------------------------------------------------------

// ----------------------------------------------------------------
// Adversarial-review fixes — additional coverage
// ----------------------------------------------------------------

describe('GmailProvider — H1 fix: parseAddressList respects quoted-comma display names', () => {
  it('does NOT split `"Smith, John" <jsmith@example.com>` on the comma inside quotes', () => {
    const provider = new GmailProvider({
      httpFetch: () => { throw new Error('should not call'); },
      clientId: 'x', clientSecret: 'y', redirectUri: 'z',
    });
    const raw = {
      id: 'm-h1', threadId: 't', historyId: '1', internalDate: '1700000000000',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'sender@example.com' },
          { name: 'To', value: '"Smith, John" <jsmith@example.com>, bob@b.com' },
        ],
        body: { data: Buffer.from('x').toString('base64url'), size: 1 },
      },
    };
    const msg = provider._normalizeMessageForTests(raw);
    assert.equal(msg.to.length, 2);
    assert.equal(msg.to[0]!.display, 'Smith, John');
    assert.equal(msg.to[0]!.address, 'jsmith@example.com');
    assert.equal(msg.to[1]!.address, 'bob@b.com');
    // Critical invariant from EmailAddress contract: address must be
    // lowercased RFC-5321. NO bogus `'"smith'` from the prior naive split.
    for (const a of msg.to) {
      assert.ok(!a.address.includes('"'), `address must not contain quotes: ${a.address}`);
      assert.equal(a.address, a.address.toLowerCase());
    }
  });
});

describe('GmailProvider — H3 fix: onTokenRefreshed persistence callback', () => {
  it('invokes the callback after refresh and BEFORE the next API call', async () => {
    // If the subsequent API call throws, the persistence callback
    // must already have fired — proving the rotated token is safe.
    let callbackFiredAt = -1;
    let apiCallAt = -1;
    let counter = 0;
    const stub = makeFetchStub([
      {
        match: (url) => url === 'https://oauth2.googleapis.com/token',
        respond: () =>
          makeResp(200, {
            access_token: 'AT-NEW',
            refresh_token: 'RT-ROTATED',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
      },
      {
        match: (url) => url.includes('/users/me/messages?'),
        respond: () => {
          apiCallAt = ++counter;
          return makeResp(500, 'transient'); // make the subsequent call throw
        },
      },
    ]);
    const provider = new GmailProvider({
      httpFetch: stub,
      clientId: 'cid', clientSecret: 'csec', redirectUri: 'r',
      onTokenRefreshed: async (creds) => {
        callbackFiredAt = ++counter;
        assert.equal(creds.oauth_token, 'AT-NEW');
        // Rotated refresh token also picked up.
        assert.equal(creds.oauth_refresh_token, 'RT-ROTATED');
      },
    });
    const expiredCreds = {
      ...TEST_CREDS,
      oauth_expires_at: new Date(Date.now() - 1000),
    };
    await assert.rejects(
      () => provider.fetchSince({ credentials: expiredCreds, cursor: null, max_messages: 10 }),
      (err: unknown) => err instanceof TransientError,
    );
    assert.ok(callbackFiredAt > 0, 'callback must fire');
    assert.ok(apiCallAt > 0, 'API call must happen');
    assert.ok(
      callbackFiredAt < apiCallAt,
      `callback must fire BEFORE the next API call (callback@${callbackFiredAt}, api@${apiCallAt})`,
    );
  });
});

describe('GmailProvider — H4 fix: bodyless messages are dropped', () => {
  it('drops messages with no body and no attachments', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/users/me/messages?'),
        respond: () => makeResp(200, { messages: [{ id: 'm-good' }, { id: 'm-bodyless' }] }),
      },
      {
        match: (url) => url.endsWith('/users/me/messages/m-good?format=full'),
        respond: () => makeResp(200, {
          id: 'm-good', threadId: 't', historyId: '1', internalDate: '1700000000000',
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'From', value: 'a@b.com' }],
            body: { data: Buffer.from('hello').toString('base64url'), size: 5 },
          },
        }),
      },
      {
        match: (url) => url.endsWith('/users/me/messages/m-bodyless?format=full'),
        respond: () => makeResp(200, {
          id: 'm-bodyless', threadId: 't', historyId: '1', internalDate: '1700000000000',
          payload: {
            mimeType: 'text/calendar', // bodyless system notification
            headers: [{ name: 'From', value: 'sys@b.com' }],
            // no body, no parts, no attachments
          },
        }),
      },
      {
        match: (url) => url.includes('/users/me/profile'),
        respond: () => makeResp(200, { emailAddress: 'a@b.com', messagesTotal: 0, threadsTotal: 0, historyId: '99' }),
      },
    ]);
    const provider = makeProvider(stub);
    const result = await provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 10 });
    assert.equal(result.messages.length, 1, 'bodyless message must be dropped');
    assert.equal(result.messages[0]!.external_message_id, 'm-good');
  });
});

describe('GmailProvider — H5 fix: stale-cursor 404 recovery', () => {
  it('falls back to first-poll when history.list returns 404 (stale cursor)', async () => {
    let historyCalls = 0;
    let firstPollCalls = 0;
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/users/me/history'),
        respond: () => {
          historyCalls++;
          // Gmail returns 404 when startHistoryId is too old.
          return makeResp(404, { error: { code: 404, message: 'invalid startHistoryId' } });
        },
      },
      {
        match: (url) => url.includes('/users/me/messages?'),
        respond: () => {
          firstPollCalls++;
          return makeResp(200, { messages: [{ id: 'm-fresh' }] });
        },
      },
      {
        match: (url) => url.endsWith('/users/me/messages/m-fresh?format=full'),
        respond: () => makeResp(200, {
          id: 'm-fresh', threadId: 't', historyId: '1', internalDate: '1700000000000',
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'From', value: 'a@b.com' }],
            body: { data: Buffer.from('hi').toString('base64url'), size: 2 },
          },
        }),
      },
      {
        match: (url) => url.includes('/users/me/profile'),
        respond: () => makeResp(200, { emailAddress: 'a@b.com', messagesTotal: 0, threadsTotal: 0, historyId: '99999' }),
      },
    ]);
    const provider = makeProvider(stub);
    const result = await provider.fetchSince({
      credentials: TEST_CREDS,
      cursor: 'ancient-stale-cursor',
      max_messages: 10,
    });
    assert.equal(historyCalls, 1, 'history was tried');
    assert.equal(firstPollCalls, 1, 'fallback first-poll fired');
    assert.equal(result.messages.length, 1);
    // New cursor is the fresh historyId from profile, not the
    // stale one the caller passed in.
    assert.equal(result.next_cursor, '99999');
  });
});

describe('GmailProvider — H2 fix: 404 soft-miss on messages.get during incremental poll', () => {
  it('skips a message that was deleted between history.list and messages.get', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/users/me/history'),
        respond: () =>
          makeResp(200, {
            history: [
              {
                id: '5556',
                messagesAdded: [
                  { message: { id: 'm-deleted', threadId: 't1' } },
                  { message: { id: 'm-alive', threadId: 't2' } },
                ],
              },
            ],
            historyId: '5556',
          }),
      },
      {
        match: (url) => url.endsWith('/users/me/messages/m-deleted?format=full'),
        respond: () => makeResp(404, { error: { code: 404, message: 'not found' } }),
      },
      {
        match: (url) => url.endsWith('/users/me/messages/m-alive?format=full'),
        respond: () => makeResp(200, {
          id: 'm-alive', threadId: 't2', historyId: '1', internalDate: '1700000000000',
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'From', value: 'a@b.com' }],
            body: { data: Buffer.from('still here').toString('base64url'), size: 10 },
          },
        }),
      },
    ]);
    const provider = makeProvider(stub);
    const result = await provider.fetchSince({ credentials: TEST_CREDS, cursor: '5555', max_messages: 10 });
    // Only the alive message comes through; the deleted one is a
    // race-condition soft miss, not a worker-stopping error.
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.external_message_id, 'm-alive');
    assert.equal(result.next_cursor, '5556');
  });
});

describe('GmailProvider — fetchAttachmentBytes', () => {
  it('decodes base64url attachment data into a Buffer', async () => {
    const payload = Buffer.from('PDF binary content here, totally not malware').toString('base64url');
    const stub = makeFetchStub([
      {
        match: (url) =>
          url.includes('/users/me/messages/m-att/attachments/att-1'),
        respond: () => makeResp(200, { data: payload, size: payload.length }),
      },
    ]);
    const provider = makeProvider(stub);
    const bytes = await provider.fetchAttachmentBytes({
      credentials: TEST_CREDS,
      external_message_id: 'm-att',
      attachment_id: 'att-1',
    });
    assert.equal(bytes.toString('utf8'), 'PDF binary content here, totally not malware');
  });

  it('returns empty buffer when the attachment has no data field', async () => {
    const stub = makeFetchStub([
      {
        match: (url) =>
          url.includes('/users/me/messages/m-x/attachments/att-x'),
        respond: () => makeResp(200, {}),
      },
    ]);
    const provider = makeProvider(stub);
    const bytes = await provider.fetchAttachmentBytes({
      credentials: TEST_CREDS,
      external_message_id: 'm-x',
      attachment_id: 'att-x',
    });
    assert.equal(bytes.length, 0);
  });
});

describe('GmailProvider — M1 fix: inline-image attachments without filename', () => {
  it('records a CID-referenced inline image as an attachment', () => {
    const provider = new GmailProvider({
      httpFetch: () => { throw new Error('should not call'); },
      clientId: 'x', clientSecret: 'y', redirectUri: 'z',
    });
    const raw = {
      id: 'm-inline', threadId: 't', historyId: '1', internalDate: '1700000000000',
      payload: {
        mimeType: 'multipart/related',
        headers: [{ name: 'From', value: 'sender@b.com' }],
        parts: [
          {
            mimeType: 'text/html',
            body: { data: Buffer.from('<img src="cid:logo123">').toString('base64url'), size: 24 },
          },
          {
            mimeType: 'image/png',
            filename: '', // common case — no filename for inline images
            headers: [{ name: 'Content-ID', value: '<logo123>' }],
            body: { attachmentId: 'att-cid-1', size: 5000 },
          },
        ],
      },
    };
    const msg = provider._normalizeMessageForTests(raw);
    assert.equal(msg.attachments.length, 1);
    assert.equal(msg.attachments[0]!.id, 'att-cid-1');
    assert.equal(msg.attachments[0]!.content_type, 'image/png');
    // Hash is derived from the Content-ID (stripped of <>), not from
    // an empty filename — so two messages with the same cid produce
    // the same hash for reputation dedup.
    assert.equal(msg.attachments[0]!.filename_hash, indexHash('logo123'));
  });
});

describe('GmailProvider — M3 + M4 fix: Authentication-Results selection', () => {
  it('prefers the AR header whose authserv-id is google.com when multiple exist', () => {
    const provider = new GmailProvider({
      httpFetch: () => { throw new Error('should not call'); },
      clientId: 'x', clientSecret: 'y', redirectUri: 'z',
    });
    const raw = {
      id: 'm-multi-ar', threadId: 't', historyId: '1', internalDate: '1700000000000',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'a@b.com' },
          // Some upstream forwarder claims everything passed.
          { name: 'Authentication-Results', value: 'forwarder.example; spf=pass; dkim=pass; dmarc=pass' },
          // Gmail's own verdict — what we trust.
          { name: 'Authentication-Results', value: 'mx.google.com; spf=fail; dkim=fail; dmarc=fail' },
        ],
        body: { data: Buffer.from('hi').toString('base64url'), size: 2 },
      },
    };
    const msg = provider._normalizeMessageForTests(raw);
    assert.equal(msg.auth_results.spf, 'fail');
    assert.equal(msg.auth_results.dkim, 'fail');
    assert.equal(msg.auth_results.dmarc, 'fail');
  });

  it('falls back to ARC-Authentication-Results when AR is absent', () => {
    const provider = new GmailProvider({
      httpFetch: () => { throw new Error('should not call'); },
      clientId: 'x', clientSecret: 'y', redirectUri: 'z',
    });
    const raw = {
      id: 'm-arc', threadId: 't', historyId: '1', internalDate: '1700000000000',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'list@mailman.example' },
          { name: 'ARC-Authentication-Results', value: 'i=1; mx.google.com; spf=pass; dkim=pass; dmarc=pass' },
        ],
        body: { data: Buffer.from('hi').toString('base64url'), size: 2 },
      },
    };
    const msg = provider._normalizeMessageForTests(raw);
    assert.equal(msg.auth_results.spf, 'pass');
    assert.equal(msg.auth_results.dmarc, 'pass');
  });
});

describe('GmailProvider — L3 fix: reject unverified email at link time', () => {
  it('throws when Google reports email_verified=false', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url === 'https://oauth2.googleapis.com/token',
        respond: () => makeResp(200, { access_token: 'AT', expires_in: 3600, token_type: 'Bearer' }),
      },
      {
        match: (url) => url === 'https://openidconnect.googleapis.com/v1/userinfo',
        respond: () => makeResp(200, { sub: '123', email: 'maybe@example.com', email_verified: false }),
      },
    ]);
    const provider = makeProvider(stub);
    await assert.rejects(
      () => provider.linkAccount({ provider: 'gmail', authorization_code: 'C', pkce_verifier: 'V' }),
      (err: unknown) => err instanceof TransientError && /not verified/i.test(err.message),
    );
  });
});

describe('GmailProvider — M5 fix: single-flight refresh', () => {
  it('serializes concurrent refresh attempts on shared creds (only one network call)', async () => {
    let refreshCalls = 0;
    let messagesCalls = 0;
    const stub = makeFetchStub([
      {
        match: (url) => url === 'https://oauth2.googleapis.com/token',
        respond: () => {
          refreshCalls++;
          return makeResp(200, {
            access_token: `AT-${refreshCalls}`,
            refresh_token: `RT-${refreshCalls}`,
            expires_in: 3600,
            token_type: 'Bearer',
          });
        },
      },
      {
        match: (url) => url.includes('/users/me/messages?'),
        respond: () => {
          messagesCalls++;
          return makeResp(200, { messages: [] });
        },
      },
      {
        match: (url) => url.includes('/users/me/profile'),
        respond: () => makeResp(200, { emailAddress: 'a@b.com', messagesTotal: 0, threadsTotal: 0, historyId: '1' }),
      },
    ]);
    const provider = makeProvider(stub);
    const expiredCreds = {
      ...TEST_CREDS,
      oauth_expires_at: new Date(Date.now() - 1000),
    };
    // Two concurrent fetchSince on the SAME creds object. Without
    // single-flight, both would refresh; Google's rotation would
    // invalidate the first response.
    const [a, b] = await Promise.all([
      provider.fetchSince({ credentials: expiredCreds, cursor: null, max_messages: 1 }),
      provider.fetchSince({ credentials: expiredCreds, cursor: null, max_messages: 1 }),
    ]);
    assert.equal(refreshCalls, 1, 'only ONE refresh should fire');
    assert.equal(messagesCalls, 2, 'both messages.list calls fired');
    assert.equal(a.next_cursor, '1');
    assert.equal(b.next_cursor, '1');
  });
});

describe('GmailProvider — H2 fix: typed GmailApiError exposes .status', () => {
  it('exports a typed error class with a numeric status field', () => {
    const err = new GmailApiError(404, 'not found');
    assert.equal(err.name, 'GmailApiError');
    assert.equal(err.status, 404);
    assert.ok(err instanceof Error);
  });
});

describe('GmailProvider.revoke', () => {
  it('POSTs to the revoke endpoint with the refresh token (when available)', async () => {
    let revokedWith = '';
    const stub = makeFetchStub([
      {
        match: (url) => url.startsWith('https://oauth2.googleapis.com/revoke'),
        respond: (url) => {
          revokedWith = url;
          return makeResp(200, '');
        },
      },
    ]);
    const provider = makeProvider(stub);
    await provider.revoke(TEST_CREDS);
    assert.match(revokedWith, /token=refresh-tok-xyz/);
  });

  it('does not throw when Google returns 400 (best-effort)', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.startsWith('https://oauth2.googleapis.com/revoke'),
        respond: () => makeResp(400, { error: 'invalid_token' }),
      },
    ]);
    const provider = makeProvider(stub);
    await assert.doesNotReject(() => provider.revoke(TEST_CREDS));
  });

  it('is a no-op when no token exists', async () => {
    const stub = makeFetchStub([]); // unstubbed = throws if called
    const provider = makeProvider(stub);
    const tokenless = { ...TEST_CREDS, oauth_token: null, oauth_refresh_token: null };
    await assert.doesNotReject(() => provider.revoke(tokenless));
  });
});
