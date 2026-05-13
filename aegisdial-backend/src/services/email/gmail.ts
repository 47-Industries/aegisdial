import { createHash } from 'node:crypto';
import { config } from '../../config.js';
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

// Email Shield — Gmail backend.
//
// Implements EmailProvider against the Gmail v1 REST API. Three
// surfaces:
//
//   1. OAuth handshake — exchange the authorization code returned to
//      our callback for access + refresh tokens, then fetch the
//      user's `sub` + email so we have a stable provider_account_id
//      to dedupe re-links against.
//
//   2. Incremental polling — Gmail's history.list is the bandwidth-
//      cheap way to know "what changed since last poll." We persist
//      the historyId in email_accounts.last_history_cursor and call
//      history.list?startHistoryId=<cursor>&historyTypes=messageAdded
//      on every tick. First-poll (cursor=null) falls back to
//      messages.list (latest 50) because Gmail's history doesn't
//      cover the pre-link mailbox.
//
//   3. Message fetch — for each new message ID, GET /messages/<id>?
//      format=full and walk the MIME parts. The parser is the
//      mildly-painful part: Gmail's payload is a recursive tree of
//      MimePart objects, body bytes are base64url, and HTML vs plain
//      vs attachment all live in the same shape.
//
// Auxiliary methods:
//   - fetchAttachmentBytes: messages.attachments.get; bytes are
//     streamed to the caller for VirusTotal, never persisted.
//   - getInboxRules: settings.filters.list, mapped to InboxRuleFinding
//     where the action has a forwardingEmail outside the user's
//     domain or has addLabelIds containing TRASH (delete-on-receive).
//   - getOAuthGrants: Gmail does NOT expose third-party-app grants
//     via the Gmail API. The right URL is the user's Google account
//     permissions page, which we deep-link from iOS. Returns [].
//   - getRecentLogins: same story — not exposed via API. Returns [].
//   - revoke: POST /oauth2/v4/revoke. Always best-effort; even if
//     Google returns 4xx, we still mark the local account revoked.
//
// HTTP boundary is injectable (httpFetch parameter) so tests can
// stub it without monkey-patching global fetch.

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const OAUTH_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

// Scope set is intentionally narrow. gmail.readonly = read mail and
// settings (including filters/rules for the compromise-check audit).
// openid + email give us the sub + email for provider_account_id +
// display_email. We do NOT request gmail.modify, gmail.send, or any
// write scope. Documented loudly in iOS permission prompt copy.
const GMAIL_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

// Per-poll cap. The polling worker defaults to 100; first-poll falls
// back to this same ceiling.
const DEFAULT_FIRST_POLL_LIMIT = 50;

// Gmail history.list paginates at 500 by default; we cap below that
// to avoid building a 500-message-deep set in one tick.
const MAX_HISTORY_PAGE_SIZE = 100;

// Provider returns lowercased addresses everywhere. This matches the
// EmailProvider invariant (IncomingMessage.from.address is
// lowercased; scoring engine assumes it).
function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

// Gmail base64url decoder. Body and attachment payloads come back
// URL-safe base64 (- instead of +, _ instead of /, no padding).
function decodeBase64Url(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

interface GmailMimeHeader { name: string; value: string }
interface GmailMimeBody {
  size?: number;
  data?: string;
  attachmentId?: string;
}
interface GmailMimePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailMimeHeader[];
  body?: GmailMimeBody;
  parts?: GmailMimePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  historyId: string;
  internalDate: string;
  payload?: GmailMimePart;
}

interface GmailHistoryEntry {
  id: string;
  messages?: { id: string; threadId: string }[];
  messagesAdded?: { message: { id: string; threadId: string } }[];
}

interface GmailHistoryListResponse {
  history?: GmailHistoryEntry[];
  nextPageToken?: string;
  historyId?: string;
}

interface GmailProfileResponse {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: 'Bearer';
  id_token?: string;
}

interface GoogleUserinfoResponse {
  sub: string;
  email: string;
  email_verified: boolean;
}

interface GmailFilter {
  id: string;
  criteria?: Record<string, unknown>;
  action?: {
    addLabelIds?: string[];
    removeLabelIds?: string[];
    forward?: string;
  };
}

interface GmailFiltersListResponse {
  filter?: GmailFilter[];
}

/**
 * The fetch shape we depend on. Compatible with the global `fetch`
 * but narrower — so tests can inject a stub without satisfying the
 * full Fetch API surface.
 */
export type HttpFetch = (
  url: string,
  init?: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

/**
 * Adversarial-review H2 fix: typed API error with a numeric status
 * field. Replaces the prior `Error('gmail unexpected status 404: ...')`
 * regex-on-message approach (which had false positives — e.g. a
 * 500 body that happened to contain "404" as a line number would
 * match). Callers branch on `.status` directly.
 *
 * Not part of the EmailProvider interface — this is internal to
 * GmailProvider. The interface only exposes RevokedError /
 * TransientError; GmailApiError is mapped to one of those (or
 * propagated as-is for status codes the worker needs to react
 * to specifically — 404 on incremental history.list is the
 * stale-cursor recovery signal in H5).
 */
export class GmailApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

interface GmailProviderOptions {
  /** Default: global fetch. Tests inject a stub. */
  httpFetch?: HttpFetch;
  /** Default: process.env-derived config. Tests can pin specific values. */
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  /**
   * Adversarial-review H3 fix: persistence callback invoked after
   * a successful token refresh, BEFORE the next bearer-authenticated
   * call. Without this, ensureAccessToken would mutate the in-memory
   * creds object but the caller wouldn't persist them if a subsequent
   * API call threw — leading to spurious RevokedError on the next
   * poll cycle when Google's refresh-token rotation invalidates the
   * pre-refresh token.
   *
   * Worker pattern: build ONE GmailProvider per process with a
   * closure that takes the refreshed creds and UPSERTs
   * email_accounts.oauth_token_ct / oauth_expires_at /
   * oauth_refresh_token_ct keyed on provider_account_id.
   */
  onTokenRefreshed?: (creds: LinkedAccountCredentials) => Promise<void>;
}

export class GmailProvider implements EmailProvider {
  readonly name = 'gmail' as const;

  private readonly httpFetch: HttpFetch;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly redirectUri: string | undefined;
  private readonly onTokenRefreshed: GmailProviderOptions['onTokenRefreshed'];
  /**
   * Adversarial-review M5 fix: single-flight refresh promise. Two
   * concurrent fetchSince calls on shared (provider, credentials)
   * would otherwise both fire refresh; with Google's refresh-token
   * rotation (default for new GCP projects in 2024+), the second
   * rotation invalidates the first and we'd hit spurious 401s.
   *
   * Keyed by provider_account_id so multiple email_accounts can
   * refresh in parallel safely; only same-account concurrent
   * refreshes are serialized.
   */
  private readonly inflightRefresh = new Map<string, Promise<string>>();

  constructor(opts: GmailProviderOptions = {}) {
    this.httpFetch = opts.httpFetch ?? ((url, init) => fetch(url, init));
    this.clientId = opts.clientId ?? config.GOOGLE_OAUTH_CLIENT_ID;
    this.clientSecret = opts.clientSecret ?? config.GOOGLE_OAUTH_CLIENT_SECRET;
    this.redirectUri = opts.redirectUri ?? config.GOOGLE_OAUTH_REDIRECT_URI;
    this.onTokenRefreshed = opts.onTokenRefreshed;
  }

  /**
   * Build the consent URL the iOS app sends the user to. Caller
   * generates the PKCE verifier + state, stashes them server-side,
   * and uses the verifier later in linkAccount().
   *
   * Static helper so the /v1/email/accounts/link route (P11) can
   * call it without instantiating a provider.
   */
  static buildAuthorizeUrl(input: {
    client_id: string;
    redirect_uri: string;
    state: string;
    pkce_challenge: string;
  }): string {
    const params = new URLSearchParams({
      client_id: input.client_id,
      redirect_uri: input.redirect_uri,
      response_type: 'code',
      scope: GMAIL_SCOPES,
      access_type: 'offline', // need refresh token
      prompt: 'consent', // force refresh-token issuance on re-link
      state: input.state,
      code_challenge: input.pkce_challenge,
      code_challenge_method: 'S256',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * PKCE helpers. Verifier is the high-entropy secret the route
   * stores server-side keyed by state; challenge is the SHA-256
   * derivation Google compares against on the token exchange.
   */
  static pkceChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
  }

  async linkAccount(input: OAuthCallbackPayload): Promise<LinkedAccountCredentials> {
    if (input.provider !== 'gmail') {
      throw new Error(`GmailProvider.linkAccount called with provider=${input.provider}`);
    }
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      throw new Error('GmailProvider not configured: GOOGLE_OAUTH_CLIENT_ID / CLIENT_SECRET / REDIRECT_URI required');
    }

    // Exchange authorization_code → tokens. PKCE verifier replaces
    // the client_secret-on-public-client model but Google requires
    // BOTH for confidential clients — we send both. PKCE is the
    // tighter binding (verifier must match the challenge we sent
    // to the authorize URL); client_secret is the longer-term
    // app identity.
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.authorization_code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      code_verifier: input.pkce_verifier,
    }).toString();

    const tokenResp = await this.httpFetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    if (!tokenResp.ok) {
      const text = await tokenResp.text().catch(() => '');
      // 400 invalid_grant on the initial exchange means the code
      // was already used, expired, or the PKCE verifier didn't match.
      // The user can retry the consent flow; not a "revoked" state.
      throw new TransientError('gmail', `token exchange failed (${tokenResp.status}): ${text.slice(0, 200)}`);
    }
    const tokens = (await tokenResp.json()) as GoogleTokenResponse;

    // Pull /userinfo for stable sub + display_email. The id_token
    // returned by Google ALSO carries these, but verifying its
    // signature requires fetching Google's JWKS — using the userinfo
    // endpoint is simpler and equivalently authentic (it's an
    // OAuth-protected resource).
    const userinfo = await this.callApi<GoogleUserinfoResponse>(
      tokens.access_token,
      OAUTH_USERINFO_URL,
    );

    // Adversarial-review L3 fix: reject unverified emails. Rare for
    // consumer Gmail but possible with imported accounts. Linking an
    // unverified address pins the wrong identity to the row.
    if (userinfo.email_verified === false) {
      throw new TransientError(
        'gmail',
        'google account email is not verified — ask the user to verify before linking',
      );
    }

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;

    return {
      provider: 'gmail',
      provider_account_id: userinfo.sub,
      display_email: normalizeAddress(userinfo.email),
      oauth_token: tokens.access_token,
      oauth_refresh_token: tokens.refresh_token ?? null,
      oauth_expires_at: expiresAt,
      imap_host: null,
      imap_port: null,
      imap_username: null,
      app_password: null,
    };
  }

  async fetchSince(input: {
    credentials: LinkedAccountCredentials;
    cursor: string | null;
    max_messages: number;
  }): Promise<{ messages: IncomingMessage[]; next_cursor: string }> {
    const access = await this.ensureAccessToken(input.credentials);
    // Adversarial-review L1 fix: clamp to [1, 200]. A worker bug
    // passing 0 or negative would otherwise either be a no-op or
    // produce a confusing 400 from Gmail.
    const limit = Math.max(1, Math.min(input.max_messages, 200));

    // First poll (no cursor): list the latest N message IDs by
    // descending received-time, then snapshot the current historyId
    // so subsequent polls can use the cheaper history.list path.
    if (!input.cursor) {
      return this.firstPoll(access, limit);
    }

    // Incremental: ask Gmail what's been added since the cursor.
    // historyTypes=messageAdded keeps the response small — we don't
    // care about label changes or deletions for forward-scanning.
    // Pagination is rare at our cadence (60s polls) but handled.
    //
    // Adversarial-review H5 fix: Gmail's history records expire
    // after ~7 days. A paused or long-throttled account's cursor
    // becomes stale and history.list returns 404. Detect that case
    // (GmailApiError with status=404) and fall back to first-poll,
    // accepting a small gap.
    const newMessageIds = new Set<string>();
    let pageToken: string | undefined;
    let latestHistoryId = input.cursor;
    try {
      do {
        const url = new URL(`${GMAIL_API_BASE}/users/me/history`);
        url.searchParams.set('startHistoryId', input.cursor);
        url.searchParams.set('historyTypes', 'messageAdded');
        url.searchParams.set('maxResults', String(MAX_HISTORY_PAGE_SIZE));
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const page = await this.callApi<GmailHistoryListResponse>(access, url.toString());
        for (const h of page.history ?? []) {
          for (const ma of h.messagesAdded ?? []) {
            newMessageIds.add(ma.message.id);
          }
          if (h.id) latestHistoryId = h.id;
        }
        if (page.historyId) latestHistoryId = page.historyId;
        pageToken = page.nextPageToken;
        // Bail out once we've collected enough new IDs — rest comes
        // on the next poll. This bounds per-poll cost.
        if (newMessageIds.size >= limit) break;
      } while (pageToken);
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) {
        // Stale cursor. Reset by snapshotting the current historyId
        // and treating this poll as a first-poll. Accept the gap.
        return this.firstPoll(access, limit);
      }
      throw err;
    }

    const messages: IncomingMessage[] = [];
    for (const id of [...newMessageIds].slice(0, limit)) {
      const msg = await this.fetchMessage(access, id);
      if (msg) messages.push(msg);
    }

    return {
      messages: messages.filter(hasBodyOrAttachments),
      next_cursor: latestHistoryId,
    };
  }

  /**
   * First-poll path. Lists the latest N message IDs and snapshots
   * profile.historyId for use as the next cursor. Used on initial
   * link AND on stale-cursor recovery (H5).
   */
  private async firstPoll(
    access: string,
    limit: number,
  ): Promise<{ messages: IncomingMessage[]; next_cursor: string }> {
    const firstLimit = Math.min(limit, DEFAULT_FIRST_POLL_LIMIT);
    const list = await this.callApi<{ messages?: { id: string }[] }>(
      access,
      `${GMAIL_API_BASE}/users/me/messages?maxResults=${firstLimit}`,
    );
    const ids = (list.messages ?? []).map((m) => m.id);
    const messages: IncomingMessage[] = [];
    for (const id of ids) {
      const msg = await this.fetchMessage(access, id);
      if (msg) messages.push(msg);
    }
    const profile = await this.callApi<GmailProfileResponse>(
      access,
      `${GMAIL_API_BASE}/users/me/profile`,
    );
    return {
      messages: messages.filter(hasBodyOrAttachments),
      next_cursor: profile.historyId,
    };
  }

  async fetchAttachmentBytes(input: {
    credentials: LinkedAccountCredentials;
    external_message_id: string;
    attachment_id: string;
  }): Promise<Buffer> {
    const access = await this.ensureAccessToken(input.credentials);
    const resp = await this.callApi<{ data?: string }>(
      access,
      `${GMAIL_API_BASE}/users/me/messages/${input.external_message_id}/attachments/${input.attachment_id}`,
    );
    if (!resp.data) return Buffer.alloc(0);
    return decodeBase64Url(resp.data);
  }

  async getInboxRules(
    credentials: LinkedAccountCredentials,
  ): Promise<InboxRuleFinding[]> {
    const access = await this.ensureAccessToken(credentials);
    const filters = await this.callApi<GmailFiltersListResponse>(
      access,
      `${GMAIL_API_BASE}/users/me/settings/filters`,
    );
    const userDomain = credentials.display_email.split('@')[1]?.toLowerCase() ?? '';
    const out: InboxRuleFinding[] = [];
    for (const f of filters.filter ?? []) {
      const action = f.action ?? {};
      // Forward-to-external: the rule forwards mail to an address
      // whose domain != the user's own domain. The classic BEC
      // smoking gun.
      if (action.forward) {
        const fwd = action.forward.toLowerCase();
        const fwdDomain = fwd.split('@')[1] ?? '';
        if (fwdDomain && fwdDomain !== userDomain) {
          out.push({
            rule_id: f.id,
            name: '',
            concern: 'forward_to_external',
            destination: fwd,
            created_at: null,
          });
        }
      }
      // Auto-trash: the rule sends incoming mail straight to trash.
      // BEC variant: after the forward rule is set, an attacker also
      // adds a hide-from-inbox rule so the victim never sees the
      // forwarded threads.
      if (action.addLabelIds?.includes('TRASH')) {
        out.push({
          rule_id: f.id,
          name: '',
          concern: 'delete_on_receive',
          destination: null,
          created_at: null,
        });
      }
      // Hide-from-inbox: rule removes the INBOX label (sent straight
      // to All Mail / archived).
      if (action.removeLabelIds?.includes('INBOX')) {
        out.push({
          rule_id: f.id,
          name: '',
          concern: 'hide_from_inbox',
          destination: null,
          created_at: null,
        });
      }
    }
    return out;
  }

  async getOAuthGrants(
    _credentials: LinkedAccountCredentials,
  ): Promise<OAuthGrantFinding[]> {
    // Gmail does NOT expose the user's third-party-app grants
    // via the Gmail API. The Google account permissions page
    // (myaccount.google.com/permissions) is the source of truth,
    // and it's not API-accessible. iOS surfaces a deep-link.
    return [];
  }

  async getRecentLogins(
    _credentials: LinkedAccountCredentials,
  ): Promise<LoginAnomalyFinding[]> {
    // Gmail does NOT expose recent sign-in events via API.
    // Workspace admin accounts have access via Admin SDK, but
    // consumer Gmail does not. iOS surfaces a deep-link to
    // myaccount.google.com/security.
    return [];
  }

  async revoke(credentials: LinkedAccountCredentials): Promise<void> {
    const token = credentials.oauth_refresh_token ?? credentials.oauth_token;
    if (!token) return;
    // Best-effort. Even if Google returns 4xx (already revoked /
    // unknown token), we want the local state to reflect "revoked".
    // We swallow non-2xx here; the caller is the route layer which
    // is already committing status='revoked' to email_accounts.
    try {
      await this.httpFetch(`${OAUTH_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
    } catch {
      // Network failure: still proceed with local revoke. iOS app
      // can suggest the user revoke on Google's side too.
    }
  }

  /**
   * Token-refresh + bearer-call helper. If the cached access token is
   * past oauth_expires_at, refresh first. Returns the access token
   * the caller should use for one or more bearer-authenticated calls.
   *
   * Adversarial-review H3 fix: after a successful refresh we await
   * the `onTokenRefreshed` callback BEFORE returning the new access
   * token, so even if the subsequent API call throws, the caller has
   * already persisted the rotated token. Prevents spurious
   * RevokedError on the next poll cycle.
   *
   * Adversarial-review M5 fix: single-flight refresh via
   * inflightRefresh map keyed on provider_account_id. Concurrent
   * fetchSince calls share the same refresh promise.
   */
  private async ensureAccessToken(creds: LinkedAccountCredentials): Promise<string> {
    if (!creds.oauth_token) {
      throw new RevokedError('gmail', 'no access token on credentials');
    }
    // No refresh if no expiry or not yet expired. 60s slack so we
    // don't refresh right at the edge.
    const now = Date.now();
    if (!creds.oauth_expires_at || creds.oauth_expires_at.getTime() - now > 60_000) {
      return creds.oauth_token;
    }
    if (!creds.oauth_refresh_token) {
      throw new RevokedError('gmail', 'access token expired and no refresh token available');
    }
    if (!this.clientId || !this.clientSecret) {
      throw new Error('GmailProvider not configured: GOOGLE_OAUTH_CLIENT_ID / CLIENT_SECRET required for refresh');
    }

    // Single-flight: dedupe concurrent refresh attempts for the same
    // account. Without this, two concurrent fetchSince calls on the
    // same creds would each fire a refresh; Google's refresh-token
    // rotation would invalidate the first response and the second
    // wins, leaving the first call's pre-refresh token dangling.
    const inflight = this.inflightRefresh.get(creds.provider_account_id);
    if (inflight) return inflight;

    const refreshPromise = this.doRefresh(creds);
    this.inflightRefresh.set(creds.provider_account_id, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      this.inflightRefresh.delete(creds.provider_account_id);
    }
  }

  private async doRefresh(creds: LinkedAccountCredentials): Promise<string> {
    const refreshBody = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.oauth_refresh_token!,
      client_id: this.clientId!,
      client_secret: this.clientSecret!,
    }).toString();
    const resp = await this.httpFetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: refreshBody,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // 400 invalid_grant = user revoked; 401 = refresh token
      // invalid. Both permanent.
      if (resp.status === 400 || resp.status === 401) {
        throw new RevokedError('gmail', `refresh failed (${resp.status}): ${text.slice(0, 200)}`);
      }
      throw new TransientError('gmail', `refresh failed (${resp.status}): ${text.slice(0, 200)}`);
    }
    const tokens = (await resp.json()) as GoogleTokenResponse;
    creds.oauth_token = tokens.access_token;
    creds.oauth_expires_at = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;
    // Google may rotate the refresh token. When it does, the response
    // includes a new refresh_token — persist that too.
    if (tokens.refresh_token) {
      creds.oauth_refresh_token = tokens.refresh_token;
    }
    // Invoke the persistence callback BEFORE returning. If the
    // subsequent API call throws, the rotated token is already
    // committed to email_accounts.
    if (this.onTokenRefreshed) {
      await this.onTokenRefreshed(creds);
    }
    return tokens.access_token;
  }

  /**
   * Bearer-authenticated JSON call. Maps Google's failure codes:
   *   - 401 → RevokedError
   *   - 403 with 'permissionDenied' / 'insufficientPermissions' → RevokedError
   *   - 5xx or 429 → TransientError
   *   - 404 / other 4xx → GmailApiError (typed, exposes .status so
   *     callers can branch — 404 on history.list is stale-cursor
   *     recovery; 404 on messages.get is a race-condition soft miss)
   *   - network error → TransientError
   */
  private async callApi<T>(accessToken: string, url: string): Promise<T> {
    let resp: Awaited<ReturnType<HttpFetch>>;
    try {
      resp = await this.httpFetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      throw new TransientError('gmail', `network error: ${err instanceof Error ? err.message : 'unknown'}`);
    }
    if (resp.ok) return (await resp.json()) as T;
    const status = resp.status;
    const text = await resp.text().catch(() => '');
    if (status === 401) {
      throw new RevokedError('gmail', `unauthorized (401): ${text.slice(0, 200)}`);
    }
    if (status === 403 && /permissionDenied|insufficientPermissions/i.test(text)) {
      throw new RevokedError('gmail', `forbidden (403): ${text.slice(0, 200)}`);
    }
    if (status >= 500 || status === 429) {
      throw new TransientError('gmail', `provider ${status}: ${text.slice(0, 200)}`);
    }
    // Adversarial-review H2 fix: throw a typed error so callers can
    // branch on .status instead of regex-matching the message.
    throw new GmailApiError(status, `gmail status ${status}: ${text.slice(0, 200)}`);
  }

  /**
   * Fetch one message and normalize to IncomingMessage. Returns null
   * if Gmail responded 404 (message was deleted between the history-
   * list result and our get — race that resolves itself; not a
   * worker-stopping error).
   *
   * Adversarial-review H2 fix: 404 detection via typed GmailApiError
   * instead of regex on error message.
   */
  private async fetchMessage(
    accessToken: string,
    id: string,
  ): Promise<IncomingMessage | null> {
    let raw: GmailMessage;
    try {
      raw = await this.callApi<GmailMessage>(
        accessToken,
        `${GMAIL_API_BASE}/users/me/messages/${id}?format=full`,
      );
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) return null;
      throw err;
    }
    return this.normalizeMessage(raw);
  }

  /**
   * Walk the recursive MIME tree of a Gmail message payload and
   * produce IncomingMessage. Made internal-with-no-IO so unit tests
   * can drive it with fixture payloads without standing up a Gmail
   * mock.
   *
   * Public-ish on the class for test access via a thin wrapper —
   * see _normalizeMessageForTests.
   */
  private normalizeMessage(raw: GmailMessage): IncomingMessage {
    const payload = raw.payload ?? {};
    const headers = headersToMap(payload.headers ?? []);

    const fromHeader = pickHeader(headers, 'from') ?? '';
    const replyToHeader = pickHeader(headers, 'reply-to');
    const toHeader = pickHeader(headers, 'to') ?? '';
    const ccHeader = pickHeader(headers, 'cc') ?? '';
    const subject = pickHeader(headers, 'subject') ?? '';

    const from = parseAddress(fromHeader);
    const reply_to = replyToHeader ? parseAddress(replyToHeader) : null;
    const to = parseAddressList(toHeader);
    const cc = parseAddressList(ccHeader);

    // Walk parts. Strategy:
    //   - first text/plain part with body data → body_text
    //   - first text/html part with body data → body_html
    //   - everything else with a filename → attachment
    // We do not strip quoted reply chains here; downstream scoring
    // tolerates the noise and removing chains adds a fragile regex.
    let body_text = '';
    let body_html = '';
    const attachments: IncomingAttachment[] = [];

    const walk = (part: GmailMimePart): void => {
      const mt = (part.mimeType ?? '').toLowerCase();
      if (part.parts && part.parts.length > 0) {
        for (const sub of part.parts) walk(sub);
        return;
      }
      const filename = part.filename ?? '';
      // Adversarial-review M1 fix: parts with body.attachmentId
      // and no body.data ARE attachments — even when the filename
      // is empty. Common case: HTML <img src="cid:..."> inline
      // images, which BEC payloads use to embed phishing QR codes
      // or fake brand logos without a filename.
      const hasAttachmentId = !!part.body?.attachmentId;
      const isAttachment = filename.length > 0 || (hasAttachmentId && !part.body?.data);
      if (isAttachment) {
        if (part.body?.attachmentId) {
          // Filename source for hashing: real filename if present,
          // else the Content-ID (cid) header, else a literal "inline".
          // We hash whatever we have so two messages with the same
          // inline-image cid produce the same filename_hash for
          // dedup-aware reputation.
          const cidHeader = headersFromPart(part).get('content-id') ?? '';
          const cid = Array.isArray(cidHeader) ? cidHeader[0] ?? '' : cidHeader;
          const filenameForHash =
            filename ||
            (cid ? cid.replace(/^<|>$/g, '') : '') ||
            'inline';
          attachments.push({
            id: part.body.attachmentId,
            filename_hash: indexHash(filenameForHash),
            content_type: mt || 'application/octet-stream',
            size_bytes: part.body.size ?? -1,
            content_sha256: null,
          });
        }
        return;
      }
      const data = part.body?.data;
      if (!data) return;
      const decoded = decodeBase64Url(data).toString('utf8');
      if (mt === 'text/plain' && body_text.length === 0) {
        body_text = decoded;
      } else if (mt === 'text/html' && body_html.length === 0) {
        body_html = decoded;
      } else if (!body_text && mt.startsWith('text/')) {
        // Fallback: any text/* part if we never found a plain/html
        body_text = decoded;
      }
    };
    walk(payload);

    const internalMs = Number.parseInt(raw.internalDate, 10);
    const received_at = Number.isFinite(internalMs) ? new Date(internalMs) : new Date();

    const auth_results = pickAuthResults(headers);

    return {
      // Adversarial-review C1 fix: use Gmail's internal `raw.id` as
      // the external_message_id, NOT the RFC-5322 Message-ID header.
      // Two reasons:
      //   1. fetchAttachmentBytes URL-paths this value as the
      //      gmail-message-id; Message-ID would 404.
      //   2. Message-ID is sender-chosen and not unique across a
      //      mailbox (forwarded reposts, mailing lists, attacker
      //      forging) — would cause spurious UNIQUE collisions in
      //      email_scans on the (email_account_id,
      //      external_message_id) dedupe key.
      // The RFC Message-ID is still available via headers['message-id']
      // for the scoring engine if it wants to use it for thread
      // correlation.
      external_message_id: raw.id,
      received_at,
      from,
      reply_to,
      to,
      cc,
      subject,
      body_text,
      body_html,
      headers: Object.fromEntries(headers),
      attachments,
      auth_results,
    };
  }

  /**
   * Test seam — wraps the private normalizer so unit tests can pass
   * a GmailMessage fixture without going through the network layer.
   * NOT for production callers.
   */
  _normalizeMessageForTests(raw: GmailMessage): IncomingMessage {
    return this.normalizeMessage(raw);
  }
}

// ---------- header / address helpers ----------

function headersToMap(headers: GmailMimeHeader[]): Map<string, string | string[]> {
  const m = new Map<string, string | string[]>();
  for (const h of headers) {
    const k = h.name.toLowerCase();
    const existing = m.get(k);
    if (existing === undefined) {
      m.set(k, h.value);
    } else if (Array.isArray(existing)) {
      existing.push(h.value);
    } else {
      m.set(k, [existing, h.value]);
    }
  }
  return m;
}

function pickHeader(m: Map<string, string | string[]>, name: string): string | undefined {
  const v = m.get(name.toLowerCase());
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * RFC 5322 address parser, minimum-viable. Handles:
 *   - bare: jeff@example.com
 *   - display+angle: "Jeff Bezos" <jeff@example.com>
 *   - display-no-quotes: Jeff Bezos <jeff@example.com>
 * Does NOT handle: group syntax, encoded-words (=?utf-8?...?=) display
 * names — those are rare and the scoring engine treats display
 * lookalike, not display correctness, as the BEC signal.
 */
function parseAddress(raw: string): EmailAddress {
  const trimmed = raw.trim();
  if (!trimmed) return { display: '', address: '' };
  const angleMatch = trimmed.match(/^"?(.*?)"?\s*<([^>]+)>$/);
  if (angleMatch) {
    return {
      display: angleMatch[1]!.trim(),
      address: normalizeAddress(angleMatch[2]!),
    };
  }
  return { display: '', address: normalizeAddress(trimmed) };
}

/**
 * Comma-split that respects quoted display names and angle brackets.
 * `"Smith, John" <jsmith@example.com>, bob@b.com` correctly splits
 * into two entries.
 *
 * Adversarial-review H1 fix: the prior implementation used a naive
 * `raw.split(',')` which corrupted quoted-comma display names into
 * bogus addresses like `{address: '"smith'}`. That violated the
 * EmailAddress contract (`address` must be lowercased RFC-5321) and
 * would have poisoned the recipient-domain reputation rollup.
 */
function parseAddressList(raw: string): EmailAddress[] {
  if (!raw.trim()) return [];
  const out: EmailAddress[] = [];
  let depthAngle = 0;
  let inQuote = false;
  let buf = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '"' && raw[i - 1] !== '\\') {
      inQuote = !inQuote;
      buf += ch;
      continue;
    }
    if (!inQuote && ch === '<') {
      depthAngle++;
      buf += ch;
      continue;
    }
    if (!inQuote && ch === '>') {
      depthAngle = Math.max(0, depthAngle - 1);
      buf += ch;
      continue;
    }
    if (ch === ',' && !inQuote && depthAngle === 0) {
      if (buf.trim()) out.push(parseAddress(buf));
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(parseAddress(buf));
  return out;
}

/**
 * Helper to pull headers off a single MIME part (for inline-image
 * Content-ID lookup in attachment hashing). Reuses the same logic
 * as the top-level header builder.
 */
function headersFromPart(part: GmailMimePart): Map<string, string | string[]> {
  return headersToMap(part.headers ?? []);
}

/**
 * IncomingMessage invariant (types.ts): at least one of body_text /
 * body_html non-empty, OR at least one attachment. Bodyless messages
 * with no attachments (calendar-only invites, system notifications
 * with iCal-only content) are dropped at the provider boundary.
 *
 * Adversarial-review H4 fix.
 */
function hasBodyOrAttachments(msg: IncomingMessage): boolean {
  return msg.body_text.length > 0 || msg.body_html.length > 0 || msg.attachments.length > 0;
}

/**
 * Pick the right Authentication-Results header for a Gmail-delivered
 * message.
 *
 * Gmail prepends its own AR header on inbound, and may carry
 * upstream AR headers from forwarders. We prefer the one whose
 * authserv-id is google.com / googlemail.com — that's the verdict
 * we trust. If none match (rare; pre-Gmail forwarder chain),
 * fall back to the first AR.
 *
 * If Authentication-Results is absent, look at ARC-Authentication-
 * Results — common for mailing-list traffic where the AR header is
 * relayed via ARC. Returns all-`none` as a last resort.
 *
 * Adversarial-review M3 + M4 fix.
 */
function pickAuthResults(headers: Map<string, string | string[]>): AuthenticationResults {
  const arRaw = headers.get('authentication-results');
  if (arRaw !== undefined) {
    const arList = Array.isArray(arRaw) ? arRaw : [arRaw];
    const preferred = arList.find((h) => /\b(google\.com|googlemail\.com)\b/i.test(h));
    return parseAuthResults(preferred ?? arList[0]!);
  }
  // ARC fallback — used when the message arrived via a forwarder
  // that relays the original verdict via ARC-Authentication-Results.
  const arcRaw = headers.get('arc-authentication-results');
  if (arcRaw !== undefined) {
    const arcList = Array.isArray(arcRaw) ? arcRaw : [arcRaw];
    return parseAuthResults(arcList[0]!);
  }
  return { spf: 'none', dkim: 'none', dmarc: 'none' };
}

/**
 * Parse a single Authentication-Results header. RFC 8601 vocab.
 * Format example:
 *   "mx.google.com; spf=pass (google.com: domain of foo@bar.com designates ...) smtp.mailfrom=foo@bar.com; dkim=pass header.i=@bar.com; dmarc=pass action=none header.from=bar.com"
 */
function parseAuthResults(raw: string): AuthenticationResults {
  const out: AuthenticationResults = { spf: 'none', dkim: 'none', dmarc: 'none' };
  const lower = raw.toLowerCase();
  for (const key of ['spf', 'dkim', 'dmarc'] as const) {
    const m = lower.match(new RegExp(`\\b${key}=([a-z]+)`));
    if (!m) continue;
    const v = m[1]!;
    if (v === 'pass' || v === 'fail' || v === 'softfail' || v === 'neutral' || v === 'temperror' || v === 'permerror' || v === 'none') {
      out[key] = v;
    }
  }
  return out;
}
