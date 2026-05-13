import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Email Shield — IMAP provider tests.
// We stub ImapClientLike fully — no real IMAP connection, no real
// mailparser run (mailparser is exercised by its own published tests).
// Goals:
//   - linkAccount: AUTHENTICATIONFAILED → RevokedError, network →
//     TransientError
//   - fetchSince: first-poll (no cursor) uses UIDNEXT snapshot,
//     incremental uses UID > cursor-UIDNEXT, UIDVALIDITY mismatch
//     triggers re-snapshot, no-new-messages branch returns []
//   - Cursor format is "UIDVALIDITY:UIDNEXT"
//   - external_message_id is "UIDVALIDITY:UID"
//   - Bodyless filter (mirrors P3/P4)
//   - Audit methods all return [] (IMAP has no native API for them)
//   - revoke is a no-op (provider-side UI revocation)
//   - normalize: address canonicalization, peppered filename hash,
//     multi-AR merge, BEC reply-to divergence
//   - app_password vs OAuth XOAUTH2 auth selection

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-imap';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://imap-provider';

const { ImapProvider } = await import('../src/services/email/imap.ts');
const { RevokedError, TransientError } = await import('../src/services/email/types.ts');
const { indexHash } = await import('../src/lib/crypto.ts');

// ----------------------------------------------------------------
// Stub ImapClientLike — handles every path the provider drives.
// ----------------------------------------------------------------

interface StubFetchedMessage {
  uid: number;
  source: Buffer;
}

interface StubBehavior {
  connectFails?: 'auth' | 'network';
  uidValidity: string;
  uidNext: number;
  messages?: StubFetchedMessage[];
  /** Called when fetchSince passes its UID range — lets tests assert correctness. */
  onFetch?: (range: string) => void;
}

function makeStubFactory(behavior: StubBehavior) {
  let connected = false;
  return () => {
    return {
      async connect() {
        if (behavior.connectFails === 'auth') {
          throw new Error('AUTHENTICATIONFAILED: invalid credentials');
        }
        if (behavior.connectFails === 'network') {
          throw new Error('ECONNREFUSED 1.2.3.4:993');
        }
        connected = true;
      },
      async logout() {
        connected = false;
      },
      async mailboxOpen(_path: string, _opts?: { readOnly?: boolean }) {
        if (!connected) throw new Error('not connected');
        return {
          uidValidity: behavior.uidValidity,
          uidNext: behavior.uidNext,
          exists: behavior.messages?.length ?? 0,
        };
      },
      async *fetch(
        range: string | number | { uid: string },
        _options: unknown,
        _opts?: { uid?: boolean },
      ): AsyncIterable<StubFetchedMessage> {
        if (behavior.onFetch) behavior.onFetch(String(range));
        for (const m of behavior.messages ?? []) {
          yield m;
        }
      },
    };
  };
}

// Build a real RFC822 source string for mailparser to chew on. We
// don't synthesize parsed shapes — mailparser parses; we assert on
// the output. This catches mailparser-version drift between local
// dev and CI.
function buildRfc822(opts: {
  from: string;
  to?: string;
  replyTo?: string;
  subject: string;
  date?: string;
  authResults?: string | string[];
  body?: string;
}): Buffer {
  const ar = opts.authResults
    ? (Array.isArray(opts.authResults) ? opts.authResults : [opts.authResults])
        .map((v) => `Authentication-Results: ${v}`)
        .join('\r\n') + '\r\n'
    : '';
  const replyToHeader = opts.replyTo ? `Reply-To: ${opts.replyTo}\r\n` : '';
  const toHeader = opts.to ? `To: ${opts.to}\r\n` : 'To: user@example.com\r\n';
  const dateHeader = opts.date ?? new Date('2026-05-11T12:00:00Z').toUTCString();
  return Buffer.from(
    `From: ${opts.from}\r\n` +
      `${toHeader}` +
      `${replyToHeader}` +
      `Subject: ${opts.subject}\r\n` +
      `Date: ${dateHeader}\r\n` +
      `${ar}` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `${opts.body ?? 'Hello world'}\r\n`,
    'utf-8',
  );
}

const TEST_CREDS = {
  provider: 'imap' as const,
  provider_account_id: 'imap.example.com:993:user@example.com',
  display_email: 'user@example.com',
  oauth_token: null,
  oauth_refresh_token: null,
  oauth_expires_at: null,
  imap_host: 'imap.example.com',
  imap_port: 993,
  imap_username: 'user@example.com',
  app_password: 'app-pwd-abc-def-ghi-jkl',
};

// ----------------------------------------------------------------
// linkAccount
// ----------------------------------------------------------------

describe('ImapProvider.linkAccount', () => {
  it('validates app-password credentials via connect + mailboxOpen', async () => {
    const factory = makeStubFactory({ uidValidity: '1', uidNext: 100 });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const creds = await provider.linkAccount({
      provider: 'imap',
      host: 'imap.icloud.com',
      port: 993,
      username: 'Alice@iCloud.com',
      credential: 'app-pwd-xxx',
      credential_kind: 'app_password',
    });
    assert.equal(creds.provider, 'imap');
    assert.equal(creds.imap_host, 'imap.icloud.com');
    assert.equal(creds.imap_port, 993);
    // display_email + username canonicalized to lowercase per the
    // EmailAddress invariant.
    assert.equal(creds.display_email, 'alice@icloud.com');
    // Credential stored on the correct field — app_password, not oauth.
    assert.equal(creds.app_password, 'app-pwd-xxx');
    assert.equal(creds.oauth_token, null);
    // provider_account_id is host:port:lowercased-user (stable for
    // re-link dedupe).
    assert.equal(creds.provider_account_id, 'imap.icloud.com:993:alice@icloud.com');
  });

  it('validates XOAUTH2 credentials and stores them on oauth_token', async () => {
    const factory = makeStubFactory({ uidValidity: '1', uidNext: 100 });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const creds = await provider.linkAccount({
      provider: 'imap',
      host: 'imap.migadu.com',
      port: 993,
      username: 'bob@example.com',
      credential: 'oauth-bearer-token-zzz',
      credential_kind: 'oauth_bearer',
    });
    assert.equal(creds.oauth_token, 'oauth-bearer-token-zzz');
    assert.equal(creds.app_password, null);
  });

  it('throws RevokedError on AUTHENTICATIONFAILED', async () => {
    const factory = makeStubFactory({
      uidValidity: '1', uidNext: 1, connectFails: 'auth',
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    await assert.rejects(
      () =>
        provider.linkAccount({
          provider: 'imap', host: 'imap.x.com', port: 993,
          username: 'a@b', credential: 'wrong', credential_kind: 'app_password',
        }),
      (err: unknown) => err instanceof RevokedError,
    );
  });

  it('throws TransientError on network failure', async () => {
    const factory = makeStubFactory({
      uidValidity: '1', uidNext: 1, connectFails: 'network',
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    await assert.rejects(
      () =>
        provider.linkAccount({
          provider: 'imap', host: 'unreachable.example', port: 993,
          username: 'a@b', credential: 'pwd', credential_kind: 'app_password',
        }),
      (err: unknown) => err instanceof TransientError,
    );
  });
});

// ----------------------------------------------------------------
// fetchSince — first-poll
// ----------------------------------------------------------------

describe('ImapProvider.fetchSince — first poll', () => {
  it('fetches the latest N UIDs and returns UIDVALIDITY:UIDNEXT cursor', async () => {
    let fetchedRange = '';
    const factory = makeStubFactory({
      uidValidity: '12345',
      uidNext: 1000,
      onFetch: (r) => { fetchedRange = r; },
      messages: [
        {
          uid: 999,
          source: buildRfc822({ from: 'alice@example.com', subject: 'Hi' }),
        },
        {
          uid: 998,
          source: buildRfc822({ from: 'bob@example.com', subject: 'Hello' }),
        },
      ],
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const result = await provider.fetchSince({
      credentials: TEST_CREDS,
      cursor: null,
      max_messages: 10,
    });
    assert.equal(result.messages.length, 2);
    // First poll uses [UIDNEXT - limit, UIDNEXT - 1]. With limit=50
    // (DEFAULT_FIRST_POLL_LIMIT) and UIDNEXT=1000: range [950, 999].
    // BUT user passed max_messages=10, and DEFAULT_FIRST_POLL_LIMIT=50,
    // so firstLimit = min(10, 50) = 10. Range [990, 999].
    assert.equal(fetchedRange, '990:999');
    // Cursor advances to UIDVALIDITY:UIDNEXT.
    assert.equal(result.next_cursor, '12345:1000');
    // Address canonicalization.
    assert.equal(result.messages[0]!.from.address, 'alice@example.com');
    // external_message_id is "UIDVALIDITY:UID".
    assert.equal(result.messages[0]!.external_message_id, '12345:999');
  });

  it('short-circuits empty mailbox (UIDNEXT=1) without fetching (M4 fix)', async () => {
    let fetchCalled = false;
    const factory = makeStubFactory({
      uidValidity: '1',
      uidNext: 1,
      onFetch: () => { fetchCalled = true; },
      messages: [],
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const result = await provider.fetchSince({
      credentials: TEST_CREDS, cursor: null, max_messages: 10,
    });
    // UIDNEXT=1 means no message has ever been assigned a UID.
    // Skip the fetch entirely — saves a round-trip and avoids the
    // invalid `1:1` range edge.
    assert.equal(fetchCalled, false);
    assert.equal(result.messages.length, 0);
    assert.equal(result.next_cursor, '1:1');
  });
});

// ----------------------------------------------------------------
// fetchSince — incremental
// ----------------------------------------------------------------

describe('ImapProvider.fetchSince — incremental polling', () => {
  it('fetches UIDs >= cursor-UIDNEXT when UIDVALIDITY matches', async () => {
    let fetchedRange = '';
    const factory = makeStubFactory({
      uidValidity: '12345',
      uidNext: 1010,
      onFetch: (r) => { fetchedRange = r; },
      messages: [
        { uid: 1008, source: buildRfc822({ from: 'eve@evil.xyz', subject: 'URGENT WIRE' }) },
      ],
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const result = await provider.fetchSince({
      credentials: TEST_CREDS,
      cursor: '12345:1005', // last seen UIDNEXT = 1005
      max_messages: 10,
    });
    // Range: [cursor-UIDNEXT, server-UIDNEXT - 1] = [1005, 1009].
    assert.equal(fetchedRange, '1005:1009');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.external_message_id, '12345:1008');
    // Cursor advances to server-UIDNEXT.
    assert.equal(result.next_cursor, '12345:1010');
  });

  it('returns [] with advanced cursor when no new messages since last poll', async () => {
    const factory = makeStubFactory({
      uidValidity: '12345',
      uidNext: 1005,
      messages: [],
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const result = await provider.fetchSince({
      credentials: TEST_CREDS,
      cursor: '12345:1005', // server hasn't advanced
      max_messages: 10,
    });
    assert.equal(result.messages.length, 0);
    // Cursor is still 12345:1005 — UIDNEXT hasn't changed.
    assert.equal(result.next_cursor, '12345:1005');
  });

  it('UIDVALIDITY mismatch triggers first-poll re-snapshot (H3 fix)', async () => {
    // Adversarial-review H3 fix: when UIDVALIDITY changes (mailbox
    // rebuilt server-side — backup restore, migration), we now do
    // a fresh first-poll instead of returning zero. Without this,
    // pre-rebuild messages at UIDs < new UIDNEXT would be invisible
    // to scoring forever.
    let fetchedRange = '';
    const factory = makeStubFactory({
      uidValidity: '99999', // server changed
      uidNext: 50,
      onFetch: (r) => { fetchedRange = r; },
      messages: [
        { uid: 49, source: buildRfc822({ from: 'a@b.com', subject: 'restored', body: 'x' }) },
      ],
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const result = await provider.fetchSince({
      credentials: TEST_CREDS,
      cursor: '12345:1000', // stale cursor from prior UIDVALIDITY
      max_messages: 10,
    });
    // First-poll behavior: range [max(1, 50-10), max(1, 49)] = [40, 49].
    assert.equal(fetchedRange, '40:49');
    // Pre-rebuild message at UID 49 IS now scanned, not skipped.
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.external_message_id, '99999:49');
    assert.equal(result.next_cursor, '99999:50');
  });

  it('monotonic cursor — does NOT regress when server UIDNEXT < cursor UIDNEXT (M1 fix)', async () => {
    // Some Dovecot configs surface a lower UIDNEXT after a restart
    // + expunge. The cursor MUST go forward, never backward, or
    // we'd re-scan messages already scored.
    const factory = makeStubFactory({
      uidValidity: '12345',
      uidNext: 990, // server regressed (was 1005 last poll)
      messages: [],
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const result = await provider.fetchSince({
      credentials: TEST_CREDS,
      cursor: '12345:1005',
      max_messages: 10,
    });
    assert.equal(result.messages.length, 0);
    // Cursor stays at the HIGHER value (max of cursor + server UIDNEXT).
    assert.equal(result.next_cursor, '12345:1005');
  });
});

// ----------------------------------------------------------------
// Bodyless filter (mirrors P3/P4)
// ----------------------------------------------------------------

describe('ImapProvider.fetchSince — bodyless filter', () => {
  it('drops messages with no body and no attachments', async () => {
    const factory = makeStubFactory({
      uidValidity: '1',
      uidNext: 100,
      messages: [
        // Has a body — keep.
        {
          uid: 99,
          source: buildRfc822({ from: 'a@b.com', subject: 'x', body: 'hello' }),
        },
        // No body at all — drop. Synthesize a minimal headers-only
        // RFC822 source. mailparser will produce an empty text/html.
        {
          uid: 98,
          source: Buffer.from(
            'From: noreply@example.com\r\n' +
              'To: user@example.com\r\n' +
              'Subject: Empty\r\n' +
              'Content-Type: text/calendar\r\n' +
              '\r\n',
            'utf-8',
          ),
        },
      ],
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const result = await provider.fetchSince({
      credentials: TEST_CREDS, cursor: null, max_messages: 10,
    });
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.external_message_id, '1:99');
  });
});

// ----------------------------------------------------------------
// Reply-To divergence + multi-AR merge
// ----------------------------------------------------------------

describe('ImapProvider — normalization', () => {
  it('extracts Reply-To divergence (BEC signal)', async () => {
    const factory = makeStubFactory({
      uidValidity: '1',
      uidNext: 10,
      messages: [
        {
          uid: 9,
          source: buildRfc822({
            from: '"CFO" <cfo@company.com>',
            replyTo: 'attacker@evil.xyz',
            subject: 'Urgent wire $50k',
            body: 'Please wire to acct 9876',
          }),
        },
      ],
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const result = await provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 1 });
    const msg = result.messages[0]!;
    assert.equal(msg.from.address, 'cfo@company.com');
    assert.equal(msg.from.display, 'CFO');
    assert.equal(msg.reply_to?.address, 'attacker@evil.xyz');
  });

  it('merges SPF/DKIM/DMARC verdicts across multiple AR headers', async () => {
    const factory = makeStubFactory({
      uidValidity: '1',
      uidNext: 10,
      messages: [
        {
          uid: 9,
          source: buildRfc822({
            from: 'a@b.com',
            subject: 'x',
            body: 'y',
            authResults: [
              'mail.example.com; dkim=pass',
              'mail.example.com; spf=fail',
              'mail.example.com; dmarc=fail',
            ],
          }),
        },
      ],
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const result = await provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 1 });
    const msg = result.messages[0]!;
    assert.equal(msg.auth_results.dkim, 'pass');
    assert.equal(msg.auth_results.spf, 'fail');
    assert.equal(msg.auth_results.dmarc, 'fail');
  });
});

// ----------------------------------------------------------------
// Audit methods — documented [] behavior
// ----------------------------------------------------------------

describe('ImapProvider — audit methods all return []', () => {
  it('getInboxRules (no MANAGESIEVE for consumer IMAP)', async () => {
    const provider = new ImapProvider({ clientFactory: makeStubFactory({ uidValidity: '1', uidNext: 1 }) as never });
    assert.deepEqual(await provider.getInboxRules(TEST_CREDS), []);
  });

  it('getOAuthGrants (IMAP has no grant audit)', async () => {
    const provider = new ImapProvider({ clientFactory: makeStubFactory({ uidValidity: '1', uidNext: 1 }) as never });
    assert.deepEqual(await provider.getOAuthGrants(TEST_CREDS), []);
  });

  it('getRecentLogins (IMAP has no sign-in event audit)', async () => {
    const provider = new ImapProvider({ clientFactory: makeStubFactory({ uidValidity: '1', uidNext: 1 }) as never });
    assert.deepEqual(await provider.getRecentLogins(TEST_CREDS), []);
  });

  it('revoke is a no-op (app passwords revoked via provider UI)', async () => {
    const provider = new ImapProvider({ clientFactory: makeStubFactory({ uidValidity: '1', uidNext: 1 }) as never });
    await assert.doesNotReject(() => provider.revoke(TEST_CREDS));
  });
});

// ----------------------------------------------------------------
// Adversarial-review fixes — added coverage
// ----------------------------------------------------------------

describe('ImapProvider — C1 fix: structured auth-failure detection', () => {
  it('classifies err.authenticationFailed=true as RevokedError even when message lacks "auth"', async () => {
    // Real-world case: iCloud responds with "Application-specific
    // password required" and imapflow sets authenticationFailed=true.
    // The message itself doesn't say "auth"; structured detection
    // catches it.
    const authErr = Object.assign(
      new Error('Application-specific password required'),
      { authenticationFailed: true },
    );
    const factory = () => ({
      async connect() { throw authErr; },
      async logout() { /* noop */ },
      mailboxOpen: async () => ({ uidValidity: 1, uidNext: 1, exists: 0 }),
      // eslint-disable-next-line require-yield
      async *fetch(): AsyncIterable<never> { return; },
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    await assert.rejects(
      () =>
        provider.linkAccount({
          provider: 'imap', host: 'imap.icloud.com', port: 993,
          username: 'a@b.com', credential: 'pwd', credential_kind: 'app_password',
        }),
      (err: unknown) => err instanceof RevokedError,
    );
  });

  it('classifies serverResponseCode=AUTHENTICATIONFAILED as RevokedError', async () => {
    const authErr = Object.assign(
      new Error('Login is disabled'),
      { serverResponseCode: 'AUTHENTICATIONFAILED' },
    );
    const factory = () => ({
      async connect() { throw authErr; },
      async logout() { /* noop */ },
      mailboxOpen: async () => ({ uidValidity: 1, uidNext: 1, exists: 0 }),
      // eslint-disable-next-line require-yield
      async *fetch(): AsyncIterable<never> { return; },
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    await assert.rejects(
      () =>
        provider.linkAccount({
          provider: 'imap', host: 'mail.x.com', port: 993,
          username: 'a@b', credential: 'pwd', credential_kind: 'app_password',
        }),
      (err: unknown) => err instanceof RevokedError,
    );
  });
});

describe('ImapProvider — C2 fix: fetchAttachmentBytes UIDVALIDITY check', () => {
  it('returns empty Buffer when stored UIDVALIDITY no longer matches the server', async () => {
    // The user scanned a message under UIDVALIDITY=12345 but the
    // mailbox has since been rebuilt under UIDVALIDITY=99999.
    // The same UID now points at a different message — bytes from
    // that wrong message MUST NOT be returned.
    let fetchCalled = false;
    const factory = () => ({
      async connect() { /* ok */ },
      async logout() { /* noop */ },
      async mailboxOpen() {
        return { uidValidity: '99999', uidNext: 50, exists: 1 };
      },
      // eslint-disable-next-line require-yield
      async *fetch(): AsyncIterable<never> {
        fetchCalled = true;
      },
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const bytes = await provider.fetchAttachmentBytes({
      credentials: TEST_CREDS,
      external_message_id: '12345:42', // stale UIDVALIDITY
      attachment_id: '42:abc',
    });
    assert.equal(bytes.length, 0);
    assert.equal(fetchCalled, false, 'fetch must NOT run on UIDVALIDITY mismatch');
  });
});

describe('ImapProvider — H2 fix: raw header preservation via parsed.headerLines', () => {
  it('preserves Return-Path as a raw string (mailparser would otherwise object-ify it)', async () => {
    const source = Buffer.from(
      'From: alice@example.com\r\n' +
        'Return-Path: <bounce@sender.com>\r\n' +
        'List-Unsubscribe: <https://example.com/unsub>\r\n' +
        'Subject: hi\r\n' +
        'To: user@example.com\r\n' +
        '\r\n' +
        'Hello\r\n',
      'utf-8',
    );
    const factory = makeStubFactory({
      uidValidity: '1', uidNext: 10,
      messages: [{ uid: 9, source }],
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const result = await provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 1 });
    const msg = result.messages[0]!;
    // Return-Path is preserved as the raw RFC value, NOT
    // mailparser's `[object Object]` mangling.
    assert.equal(typeof msg.headers['return-path'], 'string');
    assert.match(msg.headers['return-path'] as string, /bounce@sender\.com/);
    // List-Unsubscribe is preserved under its ORIGINAL header
    // name, not mailparser's flattened `list` key.
    assert.ok(
      msg.headers['list-unsubscribe'],
      'list-unsubscribe must be preserved (mailparser otherwise renames it to `list`)',
    );
    assert.match(msg.headers['list-unsubscribe'] as string, /example\.com\/unsub/);
  });
});

describe('ImapProvider.fetchAttachmentBytes — happy path (L1 fix: missing coverage)', () => {
  it('fetches the message by UID and returns the matching attachment content', async () => {
    const boundary = 'B-XYZ';
    const attachmentBytes = Buffer.from('PDF-INVOICE-PAYLOAD');
    const source = Buffer.from(
      `From: sender@example.com\r\n` +
        `To: user@example.com\r\n` +
        `Subject: invoice\r\n` +
        `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
        `\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: text/plain\r\n\r\n` +
        `See attached.\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: application/pdf\r\n` +
        `Content-Disposition: attachment; filename="invoice.pdf"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n` +
        `${attachmentBytes.toString('base64')}\r\n` +
        `--${boundary}--\r\n`,
      'utf-8',
    );
    const factory = makeStubFactory({
      uidValidity: '7',
      uidNext: 100,
      messages: [{ uid: 99, source }],
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    // First do a fetchSince to get the attachment id the way the
    // scoring engine would.
    const fetched = await provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 1 });
    const attachmentId = fetched.messages[0]!.attachments[0]!.id;
    assert.match(attachmentId, /^99:/);

    // Now fetch the bytes back.
    const bytes = await provider.fetchAttachmentBytes({
      credentials: TEST_CREDS,
      external_message_id: '7:99',
      attachment_id: attachmentId,
    });
    assert.equal(bytes.toString('utf8'), attachmentBytes.toString('utf8'));
  });
});

// ----------------------------------------------------------------
// Filename hashing (peppered, per H1 indexHash invariant)
// ----------------------------------------------------------------

describe('ImapProvider — attachment hashing', () => {
  it('hashes attachment filename with the peppered indexHash, not raw sha256', async () => {
    // Build an RFC822 source with a real attachment. mailparser
    // will extract it, and our normalizer hashes the filename.
    const boundary = 'BOUND-XYZ';
    const source = Buffer.from(
      `From: sender@example.com\r\n` +
        `To: user@example.com\r\n` +
        `Subject: invoice\r\n` +
        `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
        `\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: text/plain\r\n\r\n` +
        `See attached.\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: application/pdf\r\n` +
        `Content-Disposition: attachment; filename="invoice_Q4.pdf"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n` +
        `${Buffer.from('PDF-FAKE-BYTES').toString('base64')}\r\n` +
        `--${boundary}--\r\n`,
      'utf-8',
    );
    const factory = makeStubFactory({
      uidValidity: '7',
      uidNext: 100,
      messages: [{ uid: 99, source }],
    });
    const provider = new ImapProvider({ clientFactory: factory as never });
    const result = await provider.fetchSince({ credentials: TEST_CREDS, cursor: null, max_messages: 1 });
    const msg = result.messages[0]!;
    assert.equal(msg.attachments.length, 1);
    assert.equal(msg.attachments[0]!.content_type, 'application/pdf');
    // Peppered hash — NOT raw sha256 of the filename.
    assert.equal(msg.attachments[0]!.filename_hash, indexHash('invoice_Q4.pdf'));
    assert.notEqual(msg.attachments[0]!.filename_hash, 'invoice_Q4.pdf');
    // content_sha256 is the bytes-hash (NOT peppered — public).
    assert.ok(msg.attachments[0]!.content_sha256);
    assert.equal(typeof msg.attachments[0]!.content_sha256, 'string');
  });
});
