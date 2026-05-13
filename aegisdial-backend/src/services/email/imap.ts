import { createHash } from 'node:crypto';
import { ImapFlow, type FetchMessageObject, type ImapFlowOptions } from 'imapflow';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import { indexHash } from '../../lib/crypto.js';
import {
  type AuthenticationResults,
  type EmailAddress,
  type EmailProvider,
  type IncomingAttachment,
  type IncomingMessage,
  type InboxRuleFinding,
  type LinkedAccountCredentials,
  type LoginAnomalyFinding,
  type OAuthCallbackPayload,
  type OAuthGrantFinding,
  RevokedError,
  TransientError,
} from './types.js';

// Email Shield — IMAP backend.
//
// Last of the three providers (Gmail P3, Microsoft Graph P4, IMAP
// P5). Covers iCloud Mail, Proton Mail (via Bridge), Yahoo Mail,
// FastMail, custom domains hosted on Zoho / Migadu / Tutanota /
// Postfix / Dovecot — any consumer mailbox that exposes IMAP and
// is NOT covered by Gmail or Graph.
//
// PROTOCOL CONSTRAINTS THAT SHAPE THIS BACKEND:
//
//   - No push notifications. IMAP IDLE is the closest analogue, but
//     it holds a long-running TCP connection per account. At
//     consumer scale that's a connection-cost problem. We
//     polling-only, defaulting to 60s.
//
//   - No structured "delta" cursor. The cursor format here is
//     `UIDVALIDITY:UIDNEXT`. UIDVALIDITY is a server-issued mailbox
//     generation number; when it changes, every UID in the mailbox
//     is invalidated (rare — mailbox rebuilt, server migration).
//     UIDNEXT is the next UID the server will assign. We fetch
//     messages with UID >= cursor-UIDNEXT.
//
//   - No native rule audit API. RFC 5804 ManageSieve exists but
//     it's a separate protocol with its own auth. Some servers
//     (Cyrus, Dovecot) support it; iCloud / Yahoo / FastMail do
//     NOT expose it to consumer accounts. getInboxRules returns []
//     and the iOS app deep-links to the provider's web UI.
//
//   - No OAuth grant audit / login anomaly audit. Both return [].
//     iOS deep-links to the provider's account-security page
//     (appleid.apple.com, login.yahoo.com/account/activity, etc.).
//
//   - Two auth flavors:
//     1. App password (most common — iCloud, Yahoo, FastMail all
//        require this for IMAP because they don't expose OAuth on
//        IMAP). Stored envelope-encrypted in
//        email_accounts.app_password_ct.
//     2. OAuth XOAUTH2 bearer (rare — used by Migadu, some Postfix
//        installs). Stored in email_accounts.oauth_token_ct. We
//        respect refresh-token rotation via onTokenRefreshed.
//
// The provider exposes the same EmailProvider interface as Gmail
// and Graph — scoring engine sees one IncomingMessage shape across
// all three.

// ImapClient interface lifted from imapflow's exported types. Kept
// as a constructor-injected parameter so tests can stub without
// spinning up a real IMAP server.
export interface ImapClientFactory {
  (opts: ImapFlowOptions): ImapClientLike;
}

/**
 * Minimal IMAP client surface this provider depends on. ImapFlow
 * implements this naturally; the type is narrow so tests can stub
 * without supplying the full ImapFlow type.
 */
export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string, opts?: { readOnly?: boolean }): Promise<{
    uidValidity: bigint | number;
    uidNext: number;
    exists: number;
  }>;
  fetch(
    range: string | number | { uid: string },
    options: { source?: boolean; envelope?: boolean; uid?: boolean; bodyStructure?: boolean; flags?: boolean; headers?: boolean | string[] },
    opts?: { uid?: boolean },
  ): AsyncIterable<FetchMessageObject>;
}

const DEFAULT_FIRST_POLL_LIMIT = 50;

interface ImapProviderOptions {
  /**
   * Factory for the underlying IMAP client. Defaults to a wrapper
   * around ImapFlow that adapts its API to ImapClientLike. Tests
   * inject a stub.
   */
  clientFactory?: ImapClientFactory;
}

// Note on token refresh: unlike Gmail / Graph, the IMAP backend
// does NOT carry an onTokenRefreshed callback. IMAP itself is a
// session-only protocol — once authenticated for a connection,
// no refresh happens. For OAuth XOAUTH2 backends (rare in the
// consumer set we target), the polling worker is responsible for
// refreshing the access token via the provider's HTTP endpoint
// BEFORE each connect; the refreshed token is then passed in via
// LinkedAccountCredentials.oauth_token. This file does no HTTP.

/**
 * Adversarial-review C1 fix: imapflow surfaces auth failures via
 * structured fields (`err.authenticationFailed === true` and/or
 * `err.serverResponseCode === 'AUTHENTICATIONFAILED'`). The error
 * MESSAGE is whatever the server returned in its NO/BAD response,
 * which frequently does NOT contain the strings "authentication
 * failed" / "invalid credentials" — common real-world examples:
 *   - "Application-specific password required" (iCloud / Gmail)
 *   - "[ALERT] Please log in via your web browser"
 *   - "Login is disabled"
 *   - "Logindisabled" (no STARTTLS upgrade and server refused
 *     plaintext)
 *
 * Without this, every one of these would be classified as
 * TransientError and the polling worker would retry forever
 * instead of flipping status='revoked' and prompting the user
 * to re-link in iOS.
 */
function isImapAuthFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { authenticationFailed?: boolean; serverResponseCode?: string };
  if (e.authenticationFailed === true) return true;
  if (e.serverResponseCode === 'AUTHENTICATIONFAILED') return true;
  // Fallback to message-based detection for older / wrapped errors.
  const msg = err instanceof Error ? err.message : String(err);
  return /AUTHENTICATIONFAILED|invalid.*credentials|authentication.*failed|login.*disabled|application.specific.password.required/i.test(msg);
}

export class ImapProvider implements EmailProvider {
  readonly name = 'imap' as const;

  private readonly clientFactory: ImapClientFactory;

  constructor(opts: ImapProviderOptions = {}) {
    this.clientFactory = opts.clientFactory ?? defaultImapFlowFactory;
  }

  async linkAccount(input: OAuthCallbackPayload): Promise<LinkedAccountCredentials> {
    if (input.provider !== 'imap') {
      throw new Error(`ImapProvider.linkAccount called with provider=${input.provider}`);
    }
    // Validate by attempting a connect + select INBOX. If it
    // succeeds, persist; if it fails, surface the right error
    // type so the route layer can show "wrong password" vs
    // "server unreachable".
    // Adversarial-review H1 fix: force STARTTLS upgrade on non-993
    // ports. Without this, a misconfigured server on port 143 that
    // doesn't advertise STARTTLS (or a MITM stripping the
    // CAPABILITY response) would silently downgrade us to plaintext
    // and we'd send the app password in cleartext. doSTARTTLS=true
    // means imapflow throws instead of degrading.
    const usesImplicitTls = input.port === 993 || input.port === 465;
    const client = this.clientFactory({
      host: input.host,
      port: input.port,
      secure: usesImplicitTls,
      doSTARTTLS: !usesImplicitTls,
      logger: false,
      auth:
        input.credential_kind === 'oauth_bearer'
          ? { user: input.username, accessToken: input.credential }
          : { user: input.username, pass: input.credential },
    } as ImapFlowOptions);
    try {
      await client.connect();
      // Validates auth + INBOX existence. We discard the returned
      // mailbox info because linkAccount only needs to confirm the
      // credentials work; first-poll snapshots its own cursor.
      await client.mailboxOpen('INBOX', { readOnly: true });
      return {
        provider: 'imap',
        provider_account_id: `${input.host}:${input.port}:${input.username.toLowerCase()}`,
        display_email: input.username.toLowerCase(),
        oauth_token: input.credential_kind === 'oauth_bearer' ? input.credential : null,
        oauth_refresh_token: null,
        oauth_expires_at: null,
        imap_host: input.host,
        imap_port: input.port,
        imap_username: input.username,
        app_password: input.credential_kind === 'app_password' ? input.credential : null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isImapAuthFailure(err)) {
        throw new RevokedError('imap', `IMAP auth failed: ${msg.slice(0, 200)}`);
      }
      throw new TransientError('imap', `IMAP link failed: ${msg.slice(0, 200)}`);
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore — link succeeded, logout failure is cosmetic
      }
    }
  }

  async fetchSince(input: {
    credentials: LinkedAccountCredentials;
    cursor: string | null;
    max_messages: number;
  }): Promise<{ messages: IncomingMessage[]; next_cursor: string }> {
    const limit = Math.max(1, Math.min(input.max_messages, 200));
    const client = this.buildClient(input.credentials);
    try {
      await client.connect();
      const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
      const serverUidValidity = String(mailbox.uidValidity);

      // Cursor parsing. Format: "UIDVALIDITY:UIDNEXT" (both
      // numeric strings; UIDVALIDITY may be a bigint).
      const parsed = parseCursor(input.cursor);

      // M4 fix: short-circuit on a wholly empty mailbox (UIDNEXT=1
      // means no message has ever been assigned a UID). Saves one
      // network round-trip and avoids the `1:1` range edge case.
      if (mailbox.uidNext <= 1) {
        return { messages: [], next_cursor: `${serverUidValidity}:1` };
      }

      // Adversarial-review H3 fix: UIDVALIDITY mismatch means the
      // mailbox was rebuilt server-side (migration, restore from
      // backup). Every prior UID is invalidated. Treat as a fresh
      // first-poll — fetch the latest N messages from the new
      // generation — rather than zero messages + advanced cursor
      // (which would make the user's pre-rebuild mail invisible
      // forever).
      const treatAsFirstPoll = !parsed || parsed.uidValidity !== serverUidValidity;

      let uidRange: string;
      let resumeFromUid: number;
      if (treatAsFirstPoll) {
        const firstLimit = Math.min(limit, DEFAULT_FIRST_POLL_LIMIT);
        const lowerUid = Math.max(1, mailbox.uidNext - firstLimit);
        const upperUid = Math.max(1, mailbox.uidNext - 1);
        uidRange = `${lowerUid}:${upperUid}`;
        resumeFromUid = mailbox.uidNext;
      } else {
        // Incremental: messages with UID >= cursor-UIDNEXT have
        // arrived since last poll.
        const lowerUid = parsed!.uidNext;
        const upperUid = Math.max(lowerUid, mailbox.uidNext - 1);
        if (upperUid < lowerUid) {
          // No new messages since last poll.
          //
          // Adversarial-review M1 fix: never let the cursor go
          // backwards. Some Dovecot configs surface a lower
          // UIDNEXT after a server restart + expunge; persist the
          // HIGHER of the two so the cursor is monotonic and we
          // don't re-scan messages already scored.
          return {
            messages: [],
            next_cursor: `${serverUidValidity}:${Math.max(parsed!.uidNext, mailbox.uidNext)}`,
          };
        }
        uidRange = `${lowerUid}:${upperUid}`;
        resumeFromUid = Math.max(parsed!.uidNext, mailbox.uidNext);
      }

      const messages: IncomingMessage[] = [];
      const fetchIter = client.fetch(
        uidRange,
        { uid: true, source: true, envelope: true, bodyStructure: true },
        { uid: true },
      );
      for await (const m of fetchIter) {
        if (!m.source) continue;
        const parsed = await safeParseRfc822(m.source);
        if (!parsed) continue;
        // UIDVALIDITY lives on the mailbox, not on each fetched
        // message — pass it down explicitly so external_message_id
        // carries the right value.
        const incoming = this.toIncomingMessage(parsed, m, serverUidValidity);
        if (hasBodyOrAttachments(incoming)) {
          messages.push(incoming);
        }
        if (messages.length >= limit) break;
      }

      return {
        messages,
        next_cursor: `${serverUidValidity}:${resumeFromUid}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isImapAuthFailure(err)) {
        throw new RevokedError('imap', `IMAP auth rejected during fetch: ${msg.slice(0, 200)}`);
      }
      throw new TransientError('imap', `IMAP fetch failed: ${msg.slice(0, 200)}`);
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
  }

  /**
   * IMAP doesn't expose attachment bytes by attachment id — the
   * scoring engine fetches by UID + MIME part path. Since
   * mailparser already extracts attachment buffers during
   * RFC822 parsing in fetchSince, this method is unreachable in
   * the IMAP flow: the scoring engine should look at
   * IncomingMessage.attachments[i] which already carries
   * content_sha256 populated.
   *
   * We implement it for interface compatibility: re-fetch the
   * message by UID, parse, and return the matching part's
   * content. Stable for re-scan flows; rarely hit in steady state.
   */
  async fetchAttachmentBytes(input: {
    credentials: LinkedAccountCredentials;
    external_message_id: string;
    attachment_id: string;
  }): Promise<Buffer> {
    const parsedExt = parseExternalMessageId(input.external_message_id);
    if (!parsedExt) return Buffer.alloc(0);

    const client = this.buildClient(input.credentials);
    try {
      await client.connect();
      const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
      // Adversarial-review C2 fix: if UIDVALIDITY has changed since
      // the scan was recorded, the UID we stored now points at a
      // DIFFERENT message. Bailing out is the only safe move —
      // returning bytes from a wrong message would (a) leak third-
      // party content into the VirusTotal cache under our scan id
      // and (b) corrupt the attachment-bytes audit.
      const serverUidValidity = String(mailbox.uidValidity);
      if (parsedExt.uidValidity !== serverUidValidity) {
        return Buffer.alloc(0);
      }
      const fetchIter = client.fetch(
        `${parsedExt.uid}:${parsedExt.uid}`,
        { uid: true, source: true },
        { uid: true },
      );
      for await (const m of fetchIter) {
        if (!m.source) continue;
        const parsed = await safeParseRfc822(m.source);
        if (!parsed) continue;
        // attachment_id is the synthetic id we wrote into
        // IncomingAttachment.id during normalization. The format
        // is "uid:checksum" — find the matching attachment. M2
        // fix: align the fallback chain with fetchSince so a
        // missing mailparser checksum doesn't drop the lookup.
        const target = (parsed.attachments ?? []).find((a) => {
          const checksum = a.checksum ?? (a.content ? bufferSha256(a.content) : '');
          return buildAttachmentId(parsedExt.uid, checksum) === input.attachment_id;
        });
        return target?.content ?? Buffer.alloc(0);
      }
      return Buffer.alloc(0);
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
  }

  async getInboxRules(
    _credentials: LinkedAccountCredentials,
  ): Promise<InboxRuleFinding[]> {
    // RFC 5804 ManageSieve is a separate protocol with its own
    // auth. iCloud, Yahoo, FastMail (the realistic IMAP backends
    // for consumer Email Shield) don't expose it. iOS deep-links
    // to the provider's web rule manager.
    return [];
  }

  async getOAuthGrants(
    _credentials: LinkedAccountCredentials,
  ): Promise<OAuthGrantFinding[]> {
    return [];
  }

  async getRecentLogins(
    _credentials: LinkedAccountCredentials,
  ): Promise<LoginAnomalyFinding[]> {
    return [];
  }

  async revoke(_credentials: LinkedAccountCredentials): Promise<void> {
    // App passwords cannot be revoked server-side via IMAP. The user
    // must do it in the provider's web UI:
    //   - iCloud: appleid.apple.com/account/manage > App-Specific Passwords
    //   - Yahoo: login.yahoo.com/account/security > Generate app password
    //   - FastMail: fastmail.com/settings/security/devicepasswords
    //
    // OAuth XOAUTH2 revocation is provider-specific. We could call
    // the matching revoke endpoint per-host, but the surface area
    // is large and the win is small — local status='revoked' is
    // already the authoritative state.
    //
    // iOS deep-links surface revocation in the provider's UI on
    // unlink. Local DB flip happens at the route layer.
    return;
  }

  // ---------- internals ----------

  private buildClient(creds: LinkedAccountCredentials): ImapClientLike {
    if (!creds.imap_host || !creds.imap_port || !creds.imap_username) {
      throw new Error('IMAP credentials missing host/port/username');
    }
    const credential = creds.oauth_token ?? creds.app_password;
    if (!credential) {
      throw new RevokedError('imap', 'no app password or OAuth token on credentials');
    }
    const isOAuth = !!creds.oauth_token;
    // H1 fix: same forced-STARTTLS posture as linkAccount.
    const usesImplicitTls = creds.imap_port === 993 || creds.imap_port === 465;
    return this.clientFactory({
      host: creds.imap_host,
      port: creds.imap_port,
      secure: usesImplicitTls,
      doSTARTTLS: !usesImplicitTls,
      logger: false,
      auth: isOAuth
        ? { user: creds.imap_username, accessToken: credential }
        : { user: creds.imap_username, pass: credential },
    } as ImapFlowOptions);
  }

  /**
   * Public test seam. Mirrors the Gmail/Graph providers' pattern.
   */
  _normalizeFromParsedForTests(
    parsed: ParsedMail,
    meta: { uid: number; uidValidity: string },
  ): IncomingMessage {
    return this.toIncomingMessage(
      parsed,
      { uid: meta.uid } as FetchMessageObject,
      meta.uidValidity,
    );
  }

  private toIncomingMessage(
    parsed: ParsedMail,
    fetched: FetchMessageObject,
    uidValidity: string,
  ): IncomingMessage {
    // Address normalization — mailparser gives back AddressObject |
    // AddressObject[] depending on header shape. We collapse to the
    // EmailAddress contract.
    const from = firstAddressOf(parsed.from);
    // mailparser's `replyTo` is also typed as AddressObject |
    // AddressObject[]. BEC signal: any reply-to-divergent from-address.
    const reply_to = parsed.replyTo ? firstAddressOf(parsed.replyTo) : null;
    const to = allAddressesOf(parsed.to);
    const cc = allAddressesOf(parsed.cc);

    // Build headers map. Adversarial-review H2 fix: mailparser's
    // `parsed.headers` Map specially decodes ~10 headers
    // (from/to/cc/return-path/date/references/in-reply-to/message-id
    // /list-* — see mailparser/mail-parser.js around the decoded
    // headers list). Decoded values are objects/Dates, NOT raw
    // strings, and `list-unsubscribe` gets RENAMED to the
    // collapsed `list` key. That breaks the IncomingMessage
    // contract (which says headers preserve their raw RFC-2822
    // shape) and silently downgrades scoring fidelity on IMAP
    // accounts vs Gmail/Graph.
    //
    // `parsed.headerLines` carries the RAW (name, line) pairs as
    // they appeared in the source — that's what we want. We
    // lowercase the name and strip the "name: " prefix from the
    // line, leaving the unmangled value.
    const headers: Record<string, string | string[]> = {};
    for (const hl of parsed.headerLines ?? []) {
      const k = hl.key.toLowerCase();
      // hl.line looks like "Subject: Hello\r\n" — strip the
      // "Name:" prefix and any trailing CRLF.
      const colonIdx = hl.line.indexOf(':');
      const rawValue = colonIdx >= 0 ? hl.line.slice(colonIdx + 1).trim() : hl.line.trim();
      const existing = headers[k];
      if (existing === undefined) {
        headers[k] = rawValue;
      } else if (Array.isArray(existing)) {
        existing.push(rawValue);
      } else {
        headers[k] = [existing, rawValue];
      }
    }

    // Attachments. mailparser parses attachments into Attachment[]
    // with filename, contentType, size, content (Buffer), checksum.
    // We hash the filename peppered and surface the buffer-side
    // sha256 (mailparser's `checksum` is already MD5; we recompute
    // sha256 for our content_sha256 invariant via Node crypto).
    //
    // Filter: mailparser treats certain bodyless-but-typed content
    // (text/calendar with empty body, system-notification text/plain
    // with no payload) as zero-byte attachments. Those are noise
    // for the scoring engine — drop attachments with size 0 AND
    // no filename AND no Content-ID. A real intentional 0-byte
    // attachment with a filename still surfaces.
    const attachments: IncomingAttachment[] = (parsed.attachments ?? [])
      .filter((a) => {
        const isNonZero = (a.size ?? 0) > 0;
        const hasIdentity = !!(a.filename || a.cid);
        return isNonZero || hasIdentity;
      })
      .map((a) => {
        const filename = a.filename ?? '';
        const cid = (a.cid ?? '').replace(/^<|>$/g, '');
        const filenameForHash = filename || cid || 'inline';
        // SHA-256 over the content buffer — needed for the
        // VirusTotal attachment-cache key. mailparser doesn't
        // provide sha256; we compute. Not peppered — this is a
        // public bytes-hash, not an enumerable PII hash.
        const sha256 = a.content ? bufferSha256(a.content) : null;
        return {
          id: buildAttachmentId(fetched.uid ?? 0, a.checksum ?? sha256 ?? ''),
          filename_hash: indexHash(filenameForHash),
          content_type: (a.contentType ?? 'application/octet-stream').toLowerCase(),
          size_bytes: a.size ?? -1,
          content_sha256: sha256,
        };
      });

    const auth_results = pickAuthResults(headers);

    return {
      // IMAP "external_message_id" is the UIDVALIDITY:UID pair —
      // stable for the lifetime of the mailbox generation. The
      // RFC-5322 Message-ID is still available via
      // headers['message-id'] for thread correlation.
      external_message_id: `${uidValidity}:${fetched.uid ?? 0}`,
      received_at: parsed.date ?? new Date(),
      from,
      reply_to,
      to,
      cc,
      subject: parsed.subject ?? '',
      body_text: parsed.text ?? '',
      body_html: typeof parsed.html === 'string' ? parsed.html : '',
      headers,
      attachments,
      auth_results,
    };
  }
}

// ---------- helpers ----------

function defaultImapFlowFactory(opts: ImapFlowOptions): ImapClientLike {
  // ImapFlow already conforms structurally — we cast at the boundary
  // so the public type stays narrow.
  return new ImapFlow(opts) as unknown as ImapClientLike;
}

interface ParsedCursor {
  uidValidity: string;
  uidNext: number;
}

function parseCursor(cursor: string | null): ParsedCursor | null {
  if (!cursor) return null;
  const parts = cursor.split(':');
  if (parts.length !== 2) return null;
  const [validity, nextStr] = parts;
  const next = Number.parseInt(nextStr!, 10);
  if (!Number.isFinite(next)) return null;
  return { uidValidity: validity!, uidNext: next };
}

function buildAttachmentId(uid: number, checksum: string): string {
  return `${uid}:${checksum}`;
}

function parseExternalMessageId(id: string): { uidValidity: string; uid: number } | null {
  const parts = id.split(':');
  if (parts.length !== 2) return null;
  const uid = Number.parseInt(parts[1]!, 10);
  if (!Number.isFinite(uid) || uid <= 0) return null;
  return { uidValidity: parts[0]!, uid };
}

function bufferSha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function safeParseRfc822(source: Buffer | string): Promise<ParsedMail | null> {
  try {
    return await simpleParser(source);
  } catch {
    return null;
  }
}

function addressToEmailAddress(a: { name?: string; address?: string }): EmailAddress {
  return {
    display: a.name ?? '',
    address: (a.address ?? '').trim().toLowerCase(),
  };
}

function firstAddressOf(field: AddressObject | AddressObject[] | undefined): EmailAddress {
  if (!field) return { display: '', address: '' };
  const list = Array.isArray(field) ? field : [field];
  for (const block of list) {
    for (const a of block.value ?? []) {
      if (a.address) return addressToEmailAddress(a);
    }
  }
  return { display: '', address: '' };
}

function allAddressesOf(
  field: AddressObject | AddressObject[] | undefined,
): EmailAddress[] {
  if (!field) return [];
  const list = Array.isArray(field) ? field : [field];
  const out: EmailAddress[] = [];
  for (const block of list) {
    for (const a of block.value ?? []) {
      if (a.address) out.push(addressToEmailAddress(a));
    }
  }
  return out;
}

function hasBodyOrAttachments(msg: IncomingMessage): boolean {
  // mailparser sometimes emits a single newline or trailing
  // whitespace even on bodyless messages (calendar-only invites,
  // system notifications with iCal-only Content-Type). Trim before
  // length-checking so the bodyless filter actually drops them.
  return (
    msg.body_text.trim().length > 0 ||
    msg.body_html.trim().length > 0 ||
    msg.attachments.length > 0
  );
}

/**
 * Same multi-AR merge logic as the Graph provider (P4 H4 fix).
 * IMAP backends (especially Postfix / Dovecot) frequently write
 * multiple AR headers per inbound — one per verifier. Take the
 * union (closest-MTA-wins per axis).
 */
function pickAuthResults(headers: Record<string, string | string[]>): AuthenticationResults {
  const merged: AuthenticationResults = { spf: 'none', dkim: 'none', dmarc: 'none' };
  const ar = headers['authentication-results'];
  if (ar !== undefined) {
    const list = Array.isArray(ar) ? ar : [ar];
    for (const line of list) {
      const parsed = parseAuthResultsLine(line);
      for (const k of ['spf', 'dkim', 'dmarc'] as const) {
        if (merged[k] === 'none' && parsed[k] !== 'none') merged[k] = parsed[k];
      }
    }
    if (merged.spf !== 'none' || merged.dkim !== 'none' || merged.dmarc !== 'none') {
      return merged;
    }
  }
  const arc = headers['arc-authentication-results'];
  if (arc !== undefined) {
    const list = Array.isArray(arc) ? arc : [arc];
    for (const line of list) {
      const parsed = parseAuthResultsLine(line);
      for (const k of ['spf', 'dkim', 'dmarc'] as const) {
        if (merged[k] === 'none' && parsed[k] !== 'none') merged[k] = parsed[k];
      }
    }
  }
  return merged;
}

function parseAuthResultsLine(raw: string): AuthenticationResults {
  const out: AuthenticationResults = { spf: 'none', dkim: 'none', dmarc: 'none' };
  const lower = raw.toLowerCase();
  for (const key of ['spf', 'dkim', 'dmarc'] as const) {
    const m = lower.match(new RegExp(`\\b${key}=([a-z]+)`));
    if (!m) continue;
    const v = m[1]!;
    if (
      v === 'pass' || v === 'fail' || v === 'softfail' || v === 'neutral' ||
      v === 'temperror' || v === 'permerror' || v === 'none'
    ) {
      out[key] = v;
    }
  }
  return out;
}
