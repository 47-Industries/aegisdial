import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Email Shield — Microsoft Graph provider tests.
// All network is stubbed via httpFetch DI. Goals:
//   - PKCE + authorize URL with read-only scope (BAN: Mail.ReadWrite,
//     Mail.Send)
//   - linkAccount: token exchange + /me lookup; rejects missing email
//   - fetchSince first-poll uses delta endpoint and returns deltaLink
//     as cursor
//   - fetchSince incremental uses the deltaLink as the URL
//   - 410 Gone / 404 on delta = stale cursor, falls back to first-poll
//   - normalizeMessage parses Graph Message shape
//   - getInboxRules: forwardTo / delete / markAsRead+moveToFolder
//   - getOAuthGrants: 403 on consumer accounts returns [] (not Revoked)
//   - getRecentLogins: 403 on consumer accounts returns [] (not Revoked)
//   - revoke is a no-op (Microsoft has no public revoke endpoint)
//   - ensureAccessToken: refresh on expiry, RevokedError on 400/401
//   - Single-flight refresh
//   - onTokenRefreshed callback fires before next API call

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-graph';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://graph-provider';

const { MicrosoftGraphProvider, GraphApiError } = await import('../src/services/email/microsoftGraph.ts');
const { RevokedError, TransientError } = await import('../src/services/email/types.ts');
const { indexHash } = await import('../src/lib/crypto.ts');

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
type FetchStub = (url: string, init?: FetchInit) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

function makeResp(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

function makeFetchStub(handlers: { match: (url: string, init?: FetchInit) => boolean; respond: (url: string, init?: FetchInit) => ReturnType<FetchStub> }[]): FetchStub {
  return async (url, init) => {
    for (const h of handlers) {
      if (h.match(url, init)) return h.respond(url, init);
    }
    throw new Error(`unstubbed fetch: ${url}`);
  };
}

function makeProvider(stub: FetchStub, opts: { onTokenRefreshed?: (creds: { oauth_token: string | null; oauth_refresh_token: string | null; oauth_expires_at: Date | null }) => Promise<void> } = {}) {
  return new MicrosoftGraphProvider({
    httpFetch: stub,
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'https://api.aegisdial.com/v1/email/oauth/microsoft/callback',
    onTokenRefreshed: opts.onTokenRefreshed as never,
  });
}

const TEST_CREDS = {
  provider: 'microsoft' as const,
  provider_account_id: 'msft-oid-123',
  display_email: 'user@outlook.com',
  oauth_token: 'access-tok-abc',
  oauth_refresh_token: 'refresh-tok-xyz',
  oauth_expires_at: new Date(Date.now() + 3600 * 1000),
  imap_host: null,
  imap_port: null,
  imap_username: null,
  app_password: null,
};

// ----------------------------------------------------------------
// PKCE + authorize URL
// ----------------------------------------------------------------

describe('MicrosoftGraphProvider — PKCE + authorize URL', () => {
  it('builds an authorize URL with read-only Mail.Read scope', () => {
    const url = MicrosoftGraphProvider.buildAuthorizeUrl({
      client_id: 'cid', redirect_uri: 'https://x/cb', state: 's', pkce_challenge: 'c',
    });
    assert.ok(url.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?'));
    assert.match(url, /Mail\.Read/);
    assert.match(url, /offline_access/);
    // Read-only invariant — must NOT request write scopes.
    assert.ok(!/Mail\.ReadWrite/.test(url), 'Mail.ReadWrite requested — BAN');
    assert.ok(!/Mail\.Send/.test(url), 'Mail.Send requested — BAN');
    assert.ok(!/MailboxSettings\.ReadWrite/.test(url), 'MailboxSettings.ReadWrite — BAN');
    assert.match(url, /code_challenge_method=S256/);
  });

  it('derives PKCE challenge deterministically', () => {
    const a = MicrosoftGraphProvider.pkceChallenge('verifier-abc-1234');
    const b = MicrosoftGraphProvider.pkceChallenge('verifier-abc-1234');
    assert.equal(a, b);
    assert.ok(!a.includes('='));
  });
});

// ----------------------------------------------------------------
// linkAccount
// ----------------------------------------------------------------

describe('MicrosoftGraphProvider.linkAccount', () => {
  it('exchanges code for tokens and fetches /me', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        respond: () => makeResp(200, {
          access_token: 'AT', expires_in: 3600, refresh_token: 'RT', token_type: 'Bearer',
        }),
      },
      {
        match: (url) => url === 'https://graph.microsoft.com/v1.0/me',
        respond: () => makeResp(200, { id: 'oid-X', mail: 'Alice@Outlook.com', displayName: 'Alice' }),
      },
    ]);
    const provider = makeProvider(stub);
    const creds = await provider.linkAccount({
      provider: 'microsoft',
      authorization_code: 'CODE',
      pkce_verifier: 'V',
    });
    assert.equal(creds.provider, 'microsoft');
    assert.equal(creds.provider_account_id, 'oid-X');
    assert.equal(creds.display_email, 'alice@outlook.com');
    assert.equal(creds.oauth_token, 'AT');
    assert.equal(creds.oauth_refresh_token, 'RT');
  });

  it('falls back to userPrincipalName when mail field is missing', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/token'),
        respond: () => makeResp(200, { access_token: 'AT', expires_in: 3600, token_type: 'Bearer' }),
      },
      {
        match: (url) => url.endsWith('/me'),
        respond: () => makeResp(200, { id: 'oid-Y', userPrincipalName: 'bob@hotmail.com' }),
      },
    ]);
    const provider = makeProvider(stub);
    const creds = await provider.linkAccount({
      provider: 'microsoft', authorization_code: 'C', pkce_verifier: 'V',
    });
    assert.equal(creds.display_email, 'bob@hotmail.com');
  });

  it('throws when /me returns no mail or upn', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/token'),
        respond: () => makeResp(200, { access_token: 'AT', expires_in: 3600, token_type: 'Bearer' }),
      },
      {
        match: (url) => url.endsWith('/me'),
        respond: () => makeResp(200, { id: 'oid-Z' }), // no mail/upn
      },
    ]);
    const provider = makeProvider(stub);
    await assert.rejects(
      () => provider.linkAccount({ provider: 'microsoft', authorization_code: 'C', pkce_verifier: 'V' }),
      (err: unknown) => err instanceof TransientError,
    );
  });
});

// ----------------------------------------------------------------
// fetchSince — first poll + incremental + stale-cursor recovery
// ----------------------------------------------------------------

describe('MicrosoftGraphProvider.fetchSince', () => {
  function buildGraphMessage(id: string, fromAddr: string, fromName: string, subject: string, replyTo?: string): unknown {
    return {
      id,
      internetMessageId: `<${id}@outlook.com>`,
      receivedDateTime: '2026-05-11T12:00:00Z',
      from: { emailAddress: { name: fromName, address: fromAddr } },
      replyTo: replyTo ? [{ emailAddress: { address: replyTo } }] : [],
      toRecipients: [{ emailAddress: { name: 'User', address: 'user@outlook.com' } }],
      ccRecipients: [],
      subject,
      body: { contentType: 'text', content: 'Hello world' },
      hasAttachments: false,
      internetMessageHeaders: [
        { name: 'Authentication-Results', value: 'outlook.com; spf=pass; dkim=pass; dmarc=pass' },
      ],
    };
  }

  it('first poll uses /me/mailFolders/inbox/messages/delta and returns deltaLink as cursor', async () => {
    const deltaLink = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=ABC';
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/mailFolders/inbox/messages/delta'),
        respond: () =>
          makeResp(200, {
            value: [
              buildGraphMessage('m1', 'alice@example.com', 'Alice', 'Hello'),
              buildGraphMessage('m2', 'bob@bank.com', '', 'Re: payment'),
            ],
            '@odata.deltaLink': deltaLink,
          }),
      },
    ]);
    const provider = makeProvider(stub);
    const result = await provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 10 });
    assert.equal(result.messages.length, 2);
    assert.equal(result.next_cursor, deltaLink);
    assert.equal(result.messages[0]!.from.address, 'alice@example.com');
    assert.equal(result.messages[0]!.from.display, 'Alice');
    assert.equal(result.messages[0]!.external_message_id, 'm1');
    // Auth-results parsed from internetMessageHeaders.
    assert.equal(result.messages[0]!.auth_results.spf, 'pass');
  });

  it('incremental poll fetches the deltaLink URL directly', async () => {
    const deltaLinkIn = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=OLD';
    const deltaLinkOut = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=NEW';
    let calledUrl = '';
    const stub = makeFetchStub([
      {
        match: (url) => url === deltaLinkIn,
        respond: (url) => {
          calledUrl = url;
          return makeResp(200, {
            value: [buildGraphMessage('m3', 'eve@evil.xyz', '', 'URGENT WIRE')],
            '@odata.deltaLink': deltaLinkOut,
          });
        },
      },
    ]);
    const provider = makeProvider(stub);
    const result = await provider.fetchSince({ credentials: TEST_CREDS, cursor: deltaLinkIn, max_messages: 10 });
    assert.equal(calledUrl, deltaLinkIn);
    assert.equal(result.messages.length, 1);
    assert.equal(result.next_cursor, deltaLinkOut);
  });

  it('410 Gone on delta query triggers first-poll fallback', async () => {
    let firstPollCalls = 0;
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('$deltatoken=STALE'),
        respond: () => makeResp(410, { error: { code: 'syncStateInvalid', message: 'delta token expired' } }),
      },
      {
        match: (url) => url.includes('/me/mailFolders/inbox/messages/delta') && !url.includes('$deltatoken='),
        respond: () => {
          firstPollCalls++;
          return makeResp(200, {
            value: [],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=FRESH',
          });
        },
      },
    ]);
    const provider = makeProvider(stub);
    const result = await provider.fetchSince({
      credentials: TEST_CREDS,
      cursor: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=STALE',
      max_messages: 10,
    });
    assert.equal(firstPollCalls, 1, 'first-poll fallback should fire');
    assert.match(result.next_cursor, /\$deltatoken=FRESH/);
  });

  it('drops bodyless messages (no body, no attachments)', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/messages/delta'),
        respond: () =>
          makeResp(200, {
            value: [
              { id: 'm-good', subject: 'X', body: { contentType: 'text', content: 'has body' } },
              { id: 'm-bodyless', subject: 'Y' /* no body */ },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=N',
          }),
      },
    ]);
    const provider = makeProvider(stub);
    const result = await provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 10 });
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.external_message_id, 'm-good');
  });
});

// ----------------------------------------------------------------
// Token refresh + single-flight + callback
// ----------------------------------------------------------------

describe('MicrosoftGraphProvider — token refresh', () => {
  it('refreshes when expired and invokes onTokenRefreshed before next API call', async () => {
    let cbAt = -1;
    let apiAt = -1;
    let counter = 0;
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/oauth2/v2.0/token'),
        respond: () => makeResp(200, {
          access_token: 'AT-NEW', refresh_token: 'RT-NEW', expires_in: 3600, token_type: 'Bearer',
        }),
      },
      {
        match: (url) => url.includes('/me/mailFolders/inbox/messages/delta'),
        respond: () => {
          apiAt = ++counter;
          return makeResp(500, 'transient');
        },
      },
    ]);
    const provider = makeProvider(stub, {
      onTokenRefreshed: async (creds) => {
        cbAt = ++counter;
        assert.equal(creds.oauth_token, 'AT-NEW');
        assert.equal(creds.oauth_refresh_token, 'RT-NEW');
      },
    });
    const expired = { ...TEST_CREDS, oauth_expires_at: new Date(Date.now() - 1000) };
    await assert.rejects(
      () => provider.fetchSince({ credentials: expired, cursor: null, max_messages: 1 }),
      (err: unknown) => err instanceof TransientError,
    );
    assert.ok(cbAt > 0 && apiAt > 0);
    assert.ok(cbAt < apiAt, `callback must fire before API call (cb@${cbAt}, api@${apiAt})`);
  });

  it('throws RevokedError on 400 invalid_grant during refresh', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/oauth2/v2.0/token'),
        respond: () => makeResp(400, { error: 'invalid_grant' }),
      },
    ]);
    const provider = makeProvider(stub);
    const expired = { ...TEST_CREDS, oauth_expires_at: new Date(Date.now() - 1000) };
    await assert.rejects(
      () => provider.fetchSince({ credentials: expired, cursor: null, max_messages: 1 }),
      (err: unknown) => err instanceof RevokedError,
    );
  });

  it('single-flight: two concurrent calls share one refresh', async () => {
    let refreshes = 0;
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/oauth2/v2.0/token'),
        respond: () => {
          refreshes++;
          return makeResp(200, { access_token: 'AT', expires_in: 3600, token_type: 'Bearer' });
        },
      },
      {
        match: (url) => url.includes('/me/mailFolders/inbox/messages/delta'),
        respond: () =>
          makeResp(200, { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=Z' }),
      },
    ]);
    const provider = makeProvider(stub);
    const expired = { ...TEST_CREDS, oauth_expires_at: new Date(Date.now() - 1000) };
    await Promise.all([
      provider.fetchSince({ credentials: expired, cursor: null, max_messages: 1 }),
      provider.fetchSince({ credentials: expired, cursor: null, max_messages: 1 }),
    ]);
    assert.equal(refreshes, 1);
  });
});

// ----------------------------------------------------------------
// Error mapping
// ----------------------------------------------------------------

describe('MicrosoftGraphProvider — error mapping', () => {
  it('401 → RevokedError', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/mailFolders/inbox/messages/delta'),
        respond: () => makeResp(401, { error: 'unauthorized' }),
      },
    ]);
    const provider = makeProvider(stub);
    await assert.rejects(
      () => provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 1 }),
      (err: unknown) => err instanceof RevokedError,
    );
  });

  it('429 → TransientError', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/mailFolders/inbox/messages/delta'),
        respond: () => makeResp(429, 'rate limit'),
      },
    ]);
    const provider = makeProvider(stub);
    await assert.rejects(
      () => provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 1 }),
      (err: unknown) => err instanceof TransientError,
    );
  });

  it('exports GraphApiError with .status field', () => {
    const e = new GraphApiError(410, 'gone');
    assert.equal(e.status, 410);
    assert.equal(e.name, 'GraphApiError');
  });
});

// ----------------------------------------------------------------
// getInboxRules
// ----------------------------------------------------------------

describe('MicrosoftGraphProvider.getInboxRules', () => {
  it('flags external-domain forwardTo / forwardAsAttachmentTo / redirectTo', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/mailFolders/inbox/messageRules'),
        respond: () =>
          makeResp(200, {
            value: [
              {
                id: 'r1',
                displayName: 'Fwd from boss',
                actions: { forwardTo: [{ emailAddress: { address: 'attacker@evil.xyz' } }] },
              },
              {
                id: 'r2',
                displayName: '',
                actions: { forwardAsAttachmentTo: [{ emailAddress: { address: 'leak@evil.xyz' } }] },
              },
              {
                id: 'r3',
                displayName: '',
                actions: { redirectTo: [{ emailAddress: { address: 'archive@company.com' } }] },
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
    const externalForwards = findings.filter((f) => f.concern === 'forward_to_external');
    assert.equal(externalForwards.length, 2);
    const dests = externalForwards.map((f) => f.destination).sort();
    assert.deepEqual(dests, ['attacker@evil.xyz', 'leak@evil.xyz']);
  });

  it('flags delete and permanentDelete (H3 fix: markAsRead+moveToFolder NO LONGER flagged)', async () => {
    // H3 adversarial fix: the markAsRead+moveToFolder heuristic
    // had a high false-positive rate on legitimate "auto-file
    // newsletters" rules and trained users to dismiss findings.
    // Only `delete: true` / `permanentDelete: true` (so the victim
    // never sees the message) remain as BEC signatures, plus
    // external-domain forwards (covered separately above).
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/mailFolders/inbox/messageRules'),
        respond: () =>
          makeResp(200, {
            value: [
              { id: 'r-del', actions: { delete: true } },
              { id: 'r-purge', actions: { permanentDelete: true } },
              { id: 'r-newsletter', actions: { markAsRead: true, moveToFolder: 'AQMkADAw...' } },
            ],
          }),
      },
    ]);
    const provider = makeProvider(stub);
    const findings = await provider.getInboxRules(TEST_CREDS);
    const concerns = findings.map((f) => f.concern).sort();
    // The newsletter-filing rule MUST NOT show up as a finding.
    assert.deepEqual(concerns, ['delete_on_receive', 'delete_on_receive']);
  });

  it('flags BOTH forwardTo external + delete: true as TWO findings on the same rule (BEC signature)', async () => {
    // The classic BEC rule combines an external forward (siphon
    // replies to attacker) with delete (victim never sees the
    // forwarded thread). Each action must surface its own finding.
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/mailFolders/inbox/messageRules'),
        respond: () =>
          makeResp(200, {
            value: [
              {
                id: 'r-bec',
                displayName: 'innocent-looking-rule',
                actions: {
                  forwardTo: [{ emailAddress: { address: 'attacker@evil.xyz' } }],
                  delete: true,
                },
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
    assert.equal(findings.length, 2);
    const concerns = findings.map((f) => f.concern).sort();
    assert.deepEqual(concerns, ['delete_on_receive', 'forward_to_external']);
  });
});

// ----------------------------------------------------------------
// Adversarial-review fixes — additional coverage
// ----------------------------------------------------------------

describe('MicrosoftGraphProvider — H1 fix: nextLink overflow advances cursor', () => {
  it('persists @odata.nextLink as cursor when limit is reached mid-page', async () => {
    // Page 1 returns 2 messages + nextLink. limit=1 → we keep 1
    // message and stop. The cursor MUST be the nextLink, not the
    // input cursor — without H1 fix, next poll would re-fetch the
    // same page and re-emit message 1.
    const nextLink = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=PAGE2';
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('$deltatoken=START'),
        respond: () =>
          makeResp(200, {
            value: [
              { id: 'm1', subject: 'first', body: { contentType: 'text', content: 'x' } },
              { id: 'm2', subject: 'second', body: { contentType: 'text', content: 'y' } },
            ],
            '@odata.nextLink': nextLink,
          }),
      },
    ]);
    const provider = makeProvider(stub);
    const result = await provider.fetchSince({
      credentials: TEST_CREDS,
      cursor: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=START',
      max_messages: 1,
    });
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.external_message_id, 'm1');
    // Critical: cursor advanced to nextLink, NOT stuck on the input cursor.
    assert.equal(result.next_cursor, nextLink);
  });
});

describe('MicrosoftGraphProvider — H2 fix: synthesized cursor on no-delta-no-next response', () => {
  it('returns the canonical delta endpoint URL when neither deltaLink nor nextLink present', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/mailFolders/inbox/messages/delta'),
        respond: () =>
          makeResp(200, {
            value: [],
            // no deltaLink, no nextLink — Graph edge case
          }),
      },
    ]);
    const provider = makeProvider(stub);
    const result = await provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 1 });
    // The cursor IS the canonical delta URL — explicit "restart a
    // fresh delta sequence next time" rather than an empty string
    // that would conflict with the never-polled state.
    assert.match(result.next_cursor, /\/me\/mailFolders\/inbox\/messages\/delta\?\$top=/);
    assert.match(result.next_cursor, /\$expand=attachments/);
  });
});

describe('MicrosoftGraphProvider — H4 fix: multi-AR header merge', () => {
  it('merges SPF/DKIM/DMARC verdicts across multiple Authentication-Results headers', () => {
    const provider = new MicrosoftGraphProvider({
      httpFetch: () => { throw new Error('should not call'); },
      clientId: 'x', clientSecret: 'y', redirectUri: 'z',
    });
    const raw = {
      id: 'm-multi-ar',
      receivedDateTime: '2026-05-11T00:00:00Z',
      body: { contentType: 'text', content: 'x' },
      internetMessageHeaders: [
        // First AR: only DKIM verdict
        { name: 'Authentication-Results', value: 'mail.protection.outlook.com; dkim=pass' },
        // Second AR: SPF fail
        { name: 'Authentication-Results', value: 'mail.protection.outlook.com; spf=fail' },
        // Third AR: DMARC fail
        { name: 'Authentication-Results', value: 'mail.protection.outlook.com; dmarc=fail action=quarantine' },
      ],
    };
    const msg = provider._normalizeMessageForTests(raw as never);
    assert.equal(msg.auth_results.spf, 'fail');
    assert.equal(msg.auth_results.dkim, 'pass');
    assert.equal(msg.auth_results.dmarc, 'fail');
  });

  it('falls back to ARC-Authentication-Results when AR is missing', () => {
    const provider = new MicrosoftGraphProvider({
      httpFetch: () => { throw new Error('should not call'); },
      clientId: 'x', clientSecret: 'y', redirectUri: 'z',
    });
    const raw = {
      id: 'm-arc',
      receivedDateTime: '2026-05-11T00:00:00Z',
      body: { contentType: 'text', content: 'x' },
      internetMessageHeaders: [
        { name: 'ARC-Authentication-Results', value: 'i=1; mx.example; spf=pass; dkim=pass; dmarc=pass' },
      ],
    };
    const msg = provider._normalizeMessageForTests(raw as never);
    assert.equal(msg.auth_results.spf, 'pass');
    assert.equal(msg.auth_results.dkim, 'pass');
    assert.equal(msg.auth_results.dmarc, 'pass');
  });
});

describe('MicrosoftGraphProvider — M1 fix: attachments expanded inline', () => {
  it('populates IncomingMessage.attachments from $expand=attachments response', () => {
    const provider = new MicrosoftGraphProvider({
      httpFetch: () => { throw new Error('should not call'); },
      clientId: 'x', clientSecret: 'y', redirectUri: 'z',
    });
    const raw = {
      id: 'm-att',
      receivedDateTime: '2026-05-11T00:00:00Z',
      body: { contentType: 'text', content: 'see invoice' },
      hasAttachments: true,
      attachments: [
        { id: 'a1', name: 'invoice_Q4.pdf', contentType: 'application/pdf', size: 1024, isInline: false },
        { id: 'a2', name: '', contentId: '<logo>', contentType: 'image/png', size: 512, isInline: true },
      ],
    };
    const msg = provider._normalizeMessageForTests(raw as never);
    assert.equal(msg.attachments.length, 2);
    assert.equal(msg.attachments[0]!.content_type, 'application/pdf');
    assert.equal(msg.attachments[0]!.filename_hash, indexHash('invoice_Q4.pdf'));
    // Inline image with no filename uses content-id stripped of <>.
    assert.equal(msg.attachments[1]!.filename_hash, indexHash('logo'));
  });

  it('emits empty attachments array when hasAttachments=false', () => {
    const provider = new MicrosoftGraphProvider({
      httpFetch: () => { throw new Error('should not call'); },
      clientId: 'x', clientSecret: 'y', redirectUri: 'z',
    });
    const raw = {
      id: 'm-noatt',
      receivedDateTime: '2026-05-11T00:00:00Z',
      body: { contentType: 'text', content: 'plain text' },
      hasAttachments: false,
    };
    const msg = provider._normalizeMessageForTests(raw as never);
    assert.equal(msg.attachments.length, 0);
  });
});

describe('MicrosoftGraphProvider — M2 fix: 403 disambiguation (scope-revoked vs feature-unavailable)', () => {
  it('throws RevokedError when 403 body contains Authorization_RequestDenied', async () => {
    // True scope revocation — user revoked Mail.Read on their side.
    // MUST flip status='revoked'; MUST NOT silently return [].
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/mailFolders/inbox/messages/delta'),
        respond: () =>
          makeResp(403, {
            error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' },
          }),
      },
    ]);
    const provider = makeProvider(stub);
    await assert.rejects(
      () => provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 1 }),
      (err: unknown) => err instanceof RevokedError,
    );
  });

  it('returns [] from getOAuthGrants when 403 body has NO scope-revocation marker (consumer outlook.com)', async () => {
    // Feature unavailable for this account type — legit return [].
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/oauth2PermissionGrants'),
        respond: () => makeResp(403, { error: { code: 'Forbidden', message: 'feature not available' } }),
      },
    ]);
    const provider = makeProvider(stub);
    const out = await provider.getOAuthGrants(TEST_CREDS);
    assert.deepEqual(out, []);
  });

  it('throws RevokedError from getOAuthGrants when 403 is a scope revocation', async () => {
    // Same endpoint, but the body indicates a true revocation —
    // MUST propagate RevokedError, NOT swallow.
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/oauth2PermissionGrants'),
        respond: () =>
          makeResp(403, {
            error: { code: 'accessDenied', message: 'access has been revoked' },
          }),
      },
    ]);
    const provider = makeProvider(stub);
    await assert.rejects(
      () => provider.getOAuthGrants(TEST_CREDS),
      (err: unknown) => err instanceof RevokedError,
    );
  });
});

// ----------------------------------------------------------------
// getOAuthGrants — 403 on consumer accounts
// ----------------------------------------------------------------

describe('MicrosoftGraphProvider.getOAuthGrants', () => {
  it('returns [] when Graph returns 403 (consumer outlook.com with no AAD)', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/oauth2PermissionGrants'),
        respond: () => makeResp(403, { error: { code: 'Forbidden' } }),
      },
    ]);
    const provider = makeProvider(stub);
    const findings = await provider.getOAuthGrants(TEST_CREDS);
    assert.deepEqual(findings, []);
  });

  it('marks grants with Mail.ReadWrite / Mail.Send as excessive_scope', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/oauth2PermissionGrants'),
        respond: () =>
          makeResp(200, {
            value: [
              { id: 'g1', clientId: 'app-1', scope: 'Mail.Read User.Read' },
              { id: 'g2', clientId: 'app-2', scope: 'Mail.ReadWrite' },
              { id: 'g3', clientId: 'app-3', scope: 'Mail.Send' },
            ],
          }),
      },
      {
        match: (url) => url.includes('/servicePrincipals/'),
        respond: (url) => makeResp(200, { id: 'sp', displayName: `App-${url.split('/').pop()}` }),
      },
    ]);
    const provider = makeProvider(stub);
    const findings = await provider.getOAuthGrants(TEST_CREDS);
    assert.equal(findings.length, 3);
    const concerns = findings.map((f) => f.concern);
    assert.deepEqual(concerns.sort(), ['excessive_scope', 'excessive_scope', 'unrecognized']);
    assert.deepEqual(findings[0]!.scopes, ['mail.read', 'user.read']);
  });
});

// ----------------------------------------------------------------
// getRecentLogins
// ----------------------------------------------------------------

describe('MicrosoftGraphProvider.getRecentLogins', () => {
  it('returns [] when auditLogs/signIns is 403 (consumer accounts)', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/auditLogs/signIns'),
        respond: () => makeResp(403, { error: 'AuditLog.Read.All required' }),
      },
    ]);
    const provider = makeProvider(stub);
    const out = await provider.getRecentLogins(TEST_CREDS);
    assert.deepEqual(out, []);
  });

  it('surfaces high-risk sign-ins', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/auditLogs/signIns'),
        respond: () =>
          makeResp(200, {
            value: [
              {
                id: 'si-1',
                createdDateTime: '2026-05-11T01:00:00Z',
                location: { city: 'Lagos', countryOrRegion: 'NG' },
                deviceDetail: { displayName: 'Unknown', operatingSystem: 'Linux' },
                status: { errorCode: 0 },
                riskLevelAggregated: 'high',
              },
              {
                id: 'si-2',
                createdDateTime: '2026-05-11T00:00:00Z',
                location: { city: 'Sacramento', countryOrRegion: 'US' },
                deviceDetail: { displayName: 'iPhone' },
                status: { errorCode: 0 },
                riskLevelAggregated: 'none',
              },
            ],
          }),
      },
    ]);
    const provider = makeProvider(stub);
    const out = await provider.getRecentLogins(TEST_CREDS);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.concern, 'unusual_geo');
    assert.match(out[0]!.location, /Lagos/);
  });
});

// ----------------------------------------------------------------
// revoke (no-op)
// ----------------------------------------------------------------

describe('MicrosoftGraphProvider.revoke', () => {
  it('is a no-op (no public revoke endpoint for v2.0/consumer)', async () => {
    const provider = makeProvider(makeFetchStub([])); // empty stub: any HTTP call would throw
    await assert.doesNotReject(() => provider.revoke(TEST_CREDS));
  });
});

// ----------------------------------------------------------------
// normalizeMessage
// ----------------------------------------------------------------

describe('MicrosoftGraphProvider — message normalization', () => {
  it('extracts Reply-To divergence (BEC signal) from replyTo array', () => {
    const provider = new MicrosoftGraphProvider({
      httpFetch: () => { throw new Error('should not call'); },
      clientId: 'x', clientSecret: 'y', redirectUri: 'z',
    });
    const raw = {
      id: 'm-bec',
      internetMessageId: '<bec@outlook.com>',
      receivedDateTime: '2026-05-11T12:00:00Z',
      from: { emailAddress: { name: 'CFO', address: 'CFO@company.com' } },
      replyTo: [{ emailAddress: { address: 'attacker@evil.xyz' } }],
      toRecipients: [],
      ccRecipients: [],
      subject: 'Urgent wire request',
      body: { contentType: 'text', content: 'Please wire $50k' },
      hasAttachments: false,
      internetMessageHeaders: [],
    };
    const msg = provider._normalizeMessageForTests(raw as never);
    assert.equal(msg.from.address, 'cfo@company.com'); // lowercased
    assert.equal(msg.from.display, 'CFO');
    assert.equal(msg.reply_to?.address, 'attacker@evil.xyz');
    // external_message_id is Graph's `id`, not the RFC Message-ID header.
    assert.equal(msg.external_message_id, 'm-bec');
  });

  it('preserves received_at from receivedDateTime', () => {
    const provider = new MicrosoftGraphProvider({
      httpFetch: () => { throw new Error('should not call'); },
      clientId: 'x', clientSecret: 'y', redirectUri: 'z',
    });
    const raw = {
      id: 'm-time',
      receivedDateTime: '2026-05-11T15:30:00Z',
      body: { contentType: 'text', content: 'x' },
    };
    const msg = provider._normalizeMessageForTests(raw as never);
    assert.equal(msg.received_at.toISOString(), '2026-05-11T15:30:00.000Z');
  });
});

// ----------------------------------------------------------------
// fetchAttachmentsList
// ----------------------------------------------------------------

describe('MicrosoftGraphProvider.fetchAttachmentsList', () => {
  it('returns attachments with peppered filename hash', async () => {
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/messages/m-att/attachments'),
        respond: () =>
          makeResp(200, {
            value: [
              { id: 'a-1', name: 'invoice_Q4.pdf', contentType: 'application/pdf', size: 1024 },
              { id: 'a-2', name: '', contentId: '<logo123>', contentType: 'image/png', size: 512 },
            ],
          }),
      },
    ]);
    const provider = makeProvider(stub);
    const out = await provider.fetchAttachmentsList({
      credentials: TEST_CREDS,
      external_message_id: 'm-att',
    });
    assert.equal(out.length, 2);
    assert.equal(out[0]!.filename_hash, indexHash('invoice_Q4.pdf'));
    // Inline image with no filename uses content-id (stripped of <>).
    assert.equal(out[1]!.filename_hash, indexHash('logo123'));
  });
});

// ----------------------------------------------------------------
// fetchAttachmentBytes
// ----------------------------------------------------------------

describe('MicrosoftGraphProvider.fetchAttachmentBytes', () => {
  it('decodes standard base64 (NOT base64url like Gmail)', async () => {
    const payload = Buffer.from('PDF content').toString('base64'); // standard base64
    const stub = makeFetchStub([
      {
        match: (url) => url.includes('/me/messages/m/attachments/a'),
        respond: () => makeResp(200, { contentBytes: payload, contentType: 'application/pdf', size: payload.length }),
      },
    ]);
    const provider = makeProvider(stub);
    const bytes = await provider.fetchAttachmentBytes({
      credentials: TEST_CREDS,
      external_message_id: 'm',
      attachment_id: 'a',
    });
    assert.equal(bytes.toString('utf8'), 'PDF content');
  });
});
