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

// Email Shield — Microsoft Graph backend.
//
// Implements EmailProvider against Microsoft Graph v1.0. Covers all
// four consumer mail surfaces that Microsoft consolidated under
// Graph: outlook.com, hotmail.com, live.com, and consumer Microsoft
// 365 (formerly Office 365).
//
// API differences from Gmail worth knowing about:
//
//   - Graph returns Message objects with already-parsed body
//     (Body.contentType + Body.content) rather than a recursive
//     MIME tree. That makes message normalization simpler than
//     Gmail.
//
//   - Incremental polling uses the delta query
//     (`/me/messages/delta`). The cursor is a complete URL Microsoft
//     gives us back — opaque to us, just persist + replay. Unlike
//     Gmail's historyId (a numeric string), delta cursors carry
//     their own pagination + parameters.
//
//   - Authentication-Results lives on `internetMessageHeaders`, a
//     name/value pair array on the message resource. The Graph
//     Message body does NOT include the verdict directly — we have
//     to walk the array to find the AR header.
//
//   - Inbox rules live at `/me/mailFolders/inbox/messageRules`.
//     Forward concerns surface via `forwardTo` / `forwardAsAttachment`;
//     hide/delete via `markAsRead` + `delete` actions.
//
//   - OAuth grant audit IS available via Graph — `oauth2PermissionGrants`
//     returns delegated grants. Better than Gmail's no-API-access.
//
//   - Login anomaly audit IS available for users with AAD signed-in
//     accounts via `/auditLogs/signIns` (Azure AD audit log). For
//     pure consumer outlook.com accounts the endpoint returns 403;
//     we handle that as an empty result, not a RevokedError.
//
// HTTP boundary is injectable for testing — same pattern as the
// Gmail provider.

const OAUTH_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const OAUTH_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

// Read-only scope set. offline_access for refresh token; Mail.Read
// to read messages, settings, and mailFolders.messageRules;
// User.Read for the /me endpoint to get the stable provider_account_id.
// We do NOT request Mail.ReadWrite, Mail.Send, MailboxSettings.ReadWrite,
// or any write scope — documented in iOS permission prompt copy.
const GRAPH_SCOPES = ['offline_access', 'Mail.Read', 'User.Read'].join(' ');

const DEFAULT_FIRST_POLL_LIMIT = 50;

function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

interface GraphInternetHeader {
  name: string;
  value: string;
}

interface GraphAddressBlock {
  emailAddress?: {
    name?: string;
    address?: string;
  };
}

interface GraphAttachment {
  '@odata.type'?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentId?: string;
}

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  receivedDateTime?: string;
  from?: GraphAddressBlock;
  replyTo?: GraphAddressBlock[];
  toRecipients?: GraphAddressBlock[];
  ccRecipients?: GraphAddressBlock[];
  subject?: string;
  body?: {
    contentType?: 'text' | 'html';
    content?: string;
  };
  bodyPreview?: string;
  hasAttachments?: boolean;
  internetMessageHeaders?: GraphInternetHeader[];
  // Surfaced via $expand=attachments on the delta URL. Adversarial-
  // review M1 fix: without this, IncomingMessage.attachments was
  // always empty for Graph-sourced messages even when the message
  // had attachments — scoring engine couldn't see attachment
  // signals.
  attachments?: GraphAttachment[];
}

interface GraphMessagesResponse {
  value: GraphMessage[];
  '@odata.deltaLink'?: string;
  '@odata.nextLink'?: string;
}

interface GraphAttachmentsResponse {
  value: GraphAttachment[];
}

interface GraphSingleAttachment {
  '@odata.type'?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  contentBytes?: string; // base64 (NOT base64url — Graph uses standard)
  contentId?: string;
}

interface GraphMessageRule {
  id: string;
  displayName?: string;
  sequence?: number;
  isEnabled?: boolean;
  conditions?: Record<string, unknown>;
  actions?: {
    forwardTo?: { emailAddress?: { address?: string; name?: string } }[];
    forwardAsAttachmentTo?: { emailAddress?: { address?: string; name?: string } }[];
    redirectTo?: { emailAddress?: { address?: string; name?: string } }[];
    delete?: boolean;
    markAsRead?: boolean;
    moveToFolder?: string;
    permanentDelete?: boolean;
  };
}

interface GraphMessageRulesResponse {
  value: GraphMessageRule[];
}

interface GraphMeResponse {
  id: string;
  userPrincipalName?: string;
  mail?: string;
  displayName?: string;
}

interface MicrosoftTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: 'Bearer';
  id_token?: string;
}

interface GraphOauth2GrantsResponse {
  value: {
    id: string;
    clientId: string;
    scope: string;
    consentType?: string;
  }[];
}

interface GraphServicePrincipal {
  id: string;
  displayName?: string;
}

interface GraphSignInsResponse {
  value: {
    id: string;
    createdDateTime?: string;
    appDisplayName?: string;
    ipAddress?: string;
    location?: { city?: string; countryOrRegion?: string };
    deviceDetail?: { displayName?: string; operatingSystem?: string };
    status?: { errorCode?: number; failureReason?: string };
    riskLevelAggregated?: string;
    riskLevelDuringSignIn?: string;
  }[];
}

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
 * Typed Graph error with numeric status. Same pattern as
 * GmailApiError — callers branch on `.status` for 404 stale-cursor /
 * race-condition handling instead of regex on message.
 */
export class GraphApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GraphApiError';
  }
}

interface MicrosoftGraphProviderOptions {
  httpFetch?: HttpFetch;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  onTokenRefreshed?: (creds: LinkedAccountCredentials) => Promise<void>;
}

export class MicrosoftGraphProvider implements EmailProvider {
  readonly name = 'microsoft' as const;

  private readonly httpFetch: HttpFetch;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly redirectUri: string | undefined;
  private readonly onTokenRefreshed: MicrosoftGraphProviderOptions['onTokenRefreshed'];
  private readonly inflightRefresh = new Map<string, Promise<string>>();

  constructor(opts: MicrosoftGraphProviderOptions = {}) {
    this.httpFetch = opts.httpFetch ?? ((url, init) => fetch(url, init));
    this.clientId = opts.clientId ?? config.MICROSOFT_OAUTH_CLIENT_ID;
    this.clientSecret = opts.clientSecret ?? config.MICROSOFT_OAUTH_CLIENT_SECRET;
    this.redirectUri = opts.redirectUri ?? config.MICROSOFT_OAUTH_REDIRECT_URI;
    this.onTokenRefreshed = opts.onTokenRefreshed;
  }

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
      response_mode: 'query',
      scope: GRAPH_SCOPES,
      state: input.state,
      code_challenge: input.pkce_challenge,
      code_challenge_method: 'S256',
      // Required for consumer outlook.com: Microsoft otherwise
      // surfaces an error about the multi-tenant endpoint not
      // supporting personal accounts.
      prompt: 'consent',
    });
    return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
  }

  static pkceChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
  }

  async linkAccount(input: OAuthCallbackPayload): Promise<LinkedAccountCredentials> {
    if (input.provider !== 'microsoft') {
      throw new Error(`MicrosoftGraphProvider.linkAccount called with provider=${input.provider}`);
    }
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      throw new Error('MicrosoftGraphProvider not configured: MICROSOFT_OAUTH_CLIENT_ID / CLIENT_SECRET / REDIRECT_URI required');
    }

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.authorization_code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      code_verifier: input.pkce_verifier,
      scope: GRAPH_SCOPES,
    }).toString();

    const tokenResp = await this.httpFetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    if (!tokenResp.ok) {
      const text = await tokenResp.text().catch(() => '');
      throw new TransientError('microsoft', `token exchange failed (${tokenResp.status}): ${text.slice(0, 200)}`);
    }
    const tokens = (await tokenResp.json()) as MicrosoftTokenResponse;

    const me = await this.callApi<GraphMeResponse>(tokens.access_token, `${GRAPH_API_BASE}/me`);
    const email = me.mail ?? me.userPrincipalName ?? '';
    if (!email) {
      throw new TransientError('microsoft', 'Graph /me returned no mail or userPrincipalName');
    }

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;

    return {
      provider: 'microsoft',
      provider_account_id: me.id,
      display_email: normalizeAddress(email),
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
    const limit = Math.max(1, Math.min(input.max_messages, 200));

    if (!input.cursor) {
      return this.firstPoll(access, limit);
    }

    // Incremental: Graph's delta endpoint. The cursor IS the next
    // URL Graph returned last time — opaque to us. If Graph
    // invalidates the delta token (rare: tenant change, mailbox
    // migration), we get 410 Gone — fall back to first-poll.
    try {
      return await this.drainDeltaPages(access, input.cursor, limit);
    } catch (err) {
      // 410 Gone or 404 = stale delta token. Reset like Gmail's
      // stale-cursor recovery path.
      if (err instanceof GraphApiError && (err.status === 410 || err.status === 404)) {
        return this.firstPoll(access, limit);
      }
      throw err;
    }
  }

  /**
   * First-poll path: kick off a fresh delta query against
   * /me/messages/delta. The initial GET returns the most-recent
   * messages PLUS a `@odata.deltaLink` that becomes the cursor for
   * the next call.
   *
   * Adversarial-review M1 fix: `$expand=attachments($select=...)`
   * lifts the attachments metadata into the same page response so
   * IncomingMessage.attachments is populated inline (parity with
   * the Gmail provider, which extracts inline during MIME walk).
   * Without this, scoring rules that branch on `attachments.length`
   * would produce different verdicts depending on provider.
   */
  private async firstPoll(
    access: string,
    limit: number,
  ): Promise<{ messages: IncomingMessage[]; next_cursor: string }> {
    const firstLimit = Math.min(limit, DEFAULT_FIRST_POLL_LIMIT);
    const url = buildDeltaUrl(firstLimit);
    return this.drainDeltaPages(access, url, limit);
  }

  /**
   * Walk a sequence of delta pages following the
   * `@odata.nextLink` / `@odata.deltaLink` protocol. Returns the
   * messages collected and the cursor to persist for next poll.
   *
   * Adversarial-review H1 fix: when we stop mid-page because we
   * hit the limit, the cursor persisted is the CURRENT page's URL
   * (or its `@odata.nextLink`) — never the input cursor. Without
   * this, an active mailbox with > limit messages per poll would
   * permanently re-fetch the same window because the cursor never
   * advanced past page 1.
   *
   * Adversarial-review H2 fix: if neither deltaLink nor nextLink
   * is returned (Graph edge case for empty inbox or a particular
   * delta endpoint response shape), we re-emit the canonical
   * delta endpoint URL as the cursor — explicit "start a fresh
   * delta sequence next time" rather than the implicit empty
   * string that confused both this code and the polling worker.
   */
  private async drainDeltaPages(
    access: string,
    startUrl: string,
    limit: number,
  ): Promise<{ messages: IncomingMessage[]; next_cursor: string }> {
    const messages: IncomingMessage[] = [];
    let url = startUrl;
    // Start with `url` — if we exit before seeing nextLink or
    // deltaLink (mid-page limit overflow with no pagination), this
    // is the URL Graph would replay; safe to persist as the cursor.
    let nextCursor: string = url;
    do {
      const page = await this.callApi<GraphMessagesResponse>(access, url);
      for (const raw of page.value) {
        const msg = this.normalizeMessage(raw);
        if (hasBodyOrAttachments(msg)) messages.push(msg);
        if (messages.length >= limit) break;
      }
      if (page['@odata.deltaLink']) {
        nextCursor = page['@odata.deltaLink'];
        break;
      }
      if (page['@odata.nextLink']) {
        // H1: track nextLink as the cursor so we resume here next
        // poll if we exit on the next iteration's limit-check.
        nextCursor = page['@odata.nextLink'];
        if (messages.length >= limit) break;
        url = page['@odata.nextLink'];
      } else {
        // No more pages and no deltaLink. H2: synthesize the
        // canonical delta URL so the next poll re-bootstraps a
        // fresh delta sequence rather than treating an empty
        // cursor as "never polled."
        nextCursor = buildDeltaUrl(DEFAULT_FIRST_POLL_LIMIT);
        break;
      }
    } while (true);
    return { messages, next_cursor: nextCursor };
  }

  async fetchAttachmentBytes(input: {
    credentials: LinkedAccountCredentials;
    external_message_id: string;
    attachment_id: string;
  }): Promise<Buffer> {
    const access = await this.ensureAccessToken(input.credentials);
    const att = await this.callApi<GraphSingleAttachment>(
      access,
      `${GRAPH_API_BASE}/me/messages/${input.external_message_id}/attachments/${input.attachment_id}`,
    );
    if (!att.contentBytes) return Buffer.alloc(0);
    // Standard base64, NOT base64url. Different from Gmail.
    return Buffer.from(att.contentBytes, 'base64');
  }

  async getInboxRules(
    credentials: LinkedAccountCredentials,
  ): Promise<InboxRuleFinding[]> {
    const access = await this.ensureAccessToken(credentials);
    const rules = await this.callApi<GraphMessageRulesResponse>(
      access,
      `${GRAPH_API_BASE}/me/mailFolders/inbox/messageRules`,
    );
    const userDomain = credentials.display_email.split('@')[1]?.toLowerCase() ?? '';
    const out: InboxRuleFinding[] = [];
    for (const r of rules.value) {
      const actions = r.actions ?? {};
      const forwards = [
        ...(actions.forwardTo ?? []),
        ...(actions.forwardAsAttachmentTo ?? []),
        ...(actions.redirectTo ?? []),
      ];
      for (const f of forwards) {
        const addr = f.emailAddress?.address?.toLowerCase() ?? '';
        if (!addr) continue;
        const fwdDomain = addr.split('@')[1] ?? '';
        if (fwdDomain && fwdDomain !== userDomain) {
          out.push({
            rule_id: r.id,
            name: r.displayName ?? '',
            concern: 'forward_to_external',
            destination: addr,
            created_at: null,
          });
        }
      }
      if (actions.delete === true || actions.permanentDelete === true) {
        out.push({
          rule_id: r.id,
          name: r.displayName ?? '',
          concern: 'delete_on_receive',
          destination: null,
          created_at: null,
        });
      }
      // Adversarial-review H3 fix: dropped the
      // `markAsRead + moveToFolder` heuristic for hide_from_inbox.
      // It produced a false positive on every legitimate
      // "auto-file newsletters" rule the user set up themselves,
      // training users to dismiss findings. The real BEC signal
      // is the `delete: true` action (so the victim never sees
      // the reply) combined with an external forward — both of
      // which are already surfaced above. A future phase can add
      // a more targeted hide_from_inbox detector by resolving the
      // moveToFolder ID to the folder displayName and matching
      // against an Archive/Junk/Hidden pattern, but it requires an
      // extra Graph round trip per rule.
    }
    return out;
  }

  async getOAuthGrants(
    credentials: LinkedAccountCredentials,
  ): Promise<OAuthGrantFinding[]> {
    // Graph DOES expose this — oauth2PermissionGrants. The endpoint
    // requires Directory.Read.All for cross-app visibility, which
    // we don't request (read-only scope set is intentional). What
    // WE can read is /me/oauth2PermissionGrants — grants delegated
    // to apps acting as the signed-in user. For consumer outlook.com
    // this returns 403 (no AAD); for Microsoft 365 it returns the
    // user's own delegated grants.
    const access = await this.ensureAccessToken(credentials);
    let grants: GraphOauth2GrantsResponse;
    try {
      grants = await this.callApi<GraphOauth2GrantsResponse>(
        access,
        `${GRAPH_API_BASE}/me/oauth2PermissionGrants`,
      );
    } catch (err) {
      // Consumer outlook.com path: 403 Forbidden because the user
      // has no AAD identity. Not a revocation; legitimate "feature
      // not available for this account type". Return empty.
      if (err instanceof GraphApiError && (err.status === 403 || err.status === 404)) {
        return [];
      }
      throw err;
    }
    const findings: OAuthGrantFinding[] = [];
    for (const g of grants.value) {
      // Resolve clientId → app display name. Best-effort; if the
      // service-principal lookup fails we still surface the grant
      // with the clientId as the app_name.
      let appName = g.clientId;
      try {
        const sp = await this.callApi<GraphServicePrincipal>(
          access,
          `${GRAPH_API_BASE}/servicePrincipals/${g.clientId}`,
        );
        if (sp.displayName) appName = sp.displayName;
      } catch {
        // ignore — appName stays as the clientId
      }
      const scopes = g.scope.split(/\s+/).filter(Boolean).map((s) => s.toLowerCase());
      // Excessive scope: anything with Mail.ReadWrite / Mail.Send /
      // full_access_as_user is worth surfacing. The user gave US
      // Mail.Read only; any other app with write scope is a real
      // BEC enablement vector.
      const concern: OAuthGrantFinding['concern'] = scopes.some(
        (s) => /mail\.readwrite|mail\.send|full_access_as_user/i.test(s),
      )
        ? 'excessive_scope'
        : 'unrecognized';
      findings.push({
        app_id: g.clientId,
        app_name: appName,
        scopes,
        granted_at: null,
        concern,
      });
    }
    return findings;
  }

  async getRecentLogins(
    credentials: LinkedAccountCredentials,
  ): Promise<LoginAnomalyFinding[]> {
    const access = await this.ensureAccessToken(credentials);
    let signIns: GraphSignInsResponse;
    try {
      signIns = await this.callApi<GraphSignInsResponse>(
        access,
        `${GRAPH_API_BASE}/auditLogs/signIns?$top=50&$orderby=createdDateTime desc`,
      );
    } catch (err) {
      // Consumer outlook.com / Personal accounts: 403 because
      // auditLogs requires AuditLog.Read.All AND an AAD tenant.
      // 404 on tenants without Premium AAD. Both legitimately mean
      // "not available" — return empty, NOT RevokedError.
      if (err instanceof GraphApiError && (err.status === 403 || err.status === 404)) {
        return [];
      }
      throw err;
    }
    const findings: LoginAnomalyFinding[] = [];
    for (const s of signIns.value) {
      const occurred = s.createdDateTime ? new Date(s.createdDateTime) : new Date();
      const city = s.location?.city ?? '';
      const country = s.location?.countryOrRegion ?? '';
      const location = [city, country].filter(Boolean).join(', ') || 'unknown';
      const device = [s.deviceDetail?.displayName, s.deviceDetail?.operatingSystem]
        .filter(Boolean)
        .join(' / ') || 'unknown';
      // Risk-based concern. Microsoft's own risk score is the
      // primary signal; failed-then-success comes from status
      // errorCode != 0 followed by success on the same account.
      // We surface ANY non-low risk for the compromise check.
      const risk = (s.riskLevelAggregated ?? s.riskLevelDuringSignIn ?? '').toLowerCase();
      const concern: LoginAnomalyFinding['concern'] =
        risk === 'high' || risk === 'medium'
          ? 'unusual_geo'
          : s.status?.errorCode && s.status.errorCode !== 0
            ? 'failed_then_success'
            : 'unusual_device';
      // Only surface findings the operator wants to see. A pure
      // status=success / risk=low row isn't interesting.
      if (risk && risk !== 'none' && risk !== 'low') {
        findings.push({ occurred_at: occurred, location, device, concern });
      } else if (s.status?.errorCode && s.status.errorCode !== 0) {
        findings.push({ occurred_at: occurred, location, device, concern: 'failed_then_success' });
      }
    }
    return findings;
  }

  async revoke(_credentials: LinkedAccountCredentials): Promise<void> {
    // Microsoft does NOT have a public OAuth-token-revoke endpoint
    // for v2.0 / consumer accounts. Tokens auto-expire at
    // oauth_expires_at and refresh tokens require the user to
    // re-consent if they're revoked on the user's side via
    // https://account.live.com/consent/Manage. iOS deep-links to
    // that page on unlink. Local DB flips status='revoked' as the
    // authoritative state.
    return;
  }

  // ---------- internals ----------

  private async ensureAccessToken(creds: LinkedAccountCredentials): Promise<string> {
    if (!creds.oauth_token) {
      throw new RevokedError('microsoft', 'no access token on credentials');
    }
    const now = Date.now();
    if (!creds.oauth_expires_at || creds.oauth_expires_at.getTime() - now > 60_000) {
      return creds.oauth_token;
    }
    if (!creds.oauth_refresh_token) {
      throw new RevokedError('microsoft', 'access token expired and no refresh token available');
    }
    if (!this.clientId || !this.clientSecret) {
      throw new Error('MicrosoftGraphProvider not configured: MICROSOFT_OAUTH_CLIENT_ID / CLIENT_SECRET required for refresh');
    }
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
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.oauth_refresh_token!,
      client_id: this.clientId!,
      client_secret: this.clientSecret!,
      scope: GRAPH_SCOPES,
    }).toString();
    const resp = await this.httpFetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // Microsoft returns 400 invalid_grant / interaction_required on
      // a permanently-revoked refresh token; 401 on token-level
      // rejection. Both are permanent.
      if (resp.status === 400 || resp.status === 401) {
        throw new RevokedError('microsoft', `refresh failed (${resp.status}): ${text.slice(0, 200)}`);
      }
      throw new TransientError('microsoft', `refresh failed (${resp.status}): ${text.slice(0, 200)}`);
    }
    const tokens = (await resp.json()) as MicrosoftTokenResponse;
    creds.oauth_token = tokens.access_token;
    creds.oauth_expires_at = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;
    if (tokens.refresh_token) creds.oauth_refresh_token = tokens.refresh_token;
    if (this.onTokenRefreshed) await this.onTokenRefreshed(creds);
    return tokens.access_token;
  }

  private async callApi<T>(accessToken: string, url: string): Promise<T> {
    let resp: Awaited<ReturnType<HttpFetch>>;
    try {
      resp = await this.httpFetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      throw new TransientError('microsoft', `network error: ${err instanceof Error ? err.message : 'unknown'}`);
    }
    if (resp.ok) return (await resp.json()) as T;
    const status = resp.status;
    const text = await resp.text().catch(() => '');
    if (status === 401) {
      throw new RevokedError('microsoft', `unauthorized (401): ${text.slice(0, 200)}`);
    }
    // Adversarial-review M2 fix: 403 disambiguation. Microsoft uses
    // 403 for BOTH "scope was revoked by the user" AND "feature not
    // available for this account type" (consumer outlook.com hitting
    // an AAD-only endpoint). We need to distinguish — silently
    // treating a scope revocation as "feature unavailable" leaves
    // email_accounts.status='active' and bills the user for a
    // silently-broken service.
    //
    // Microsoft's documented error codes for scope-level denial
    // include `Authorization_RequestDenied` and explicit
    // `accessDenied` codes. Feature-unavailable cases use codes
    // like `Request_BadRequest` with serviceNotAvailable, or just
    // generic Forbidden with no auth code marker. We map the
    // explicit scope-denial codes to RevokedError; everything
    // else stays GraphApiError so endpoint-specific handlers
    // (getOAuthGrants, getRecentLogins) can choose to return [].
    if (status === 403 && /Authorization_RequestDenied|accessDenied|insufficient_scope|invalid_grant/i.test(text)) {
      throw new RevokedError('microsoft', `forbidden — scope revoked (403): ${text.slice(0, 200)}`);
    }
    if (status >= 500 || status === 429) {
      throw new TransientError('microsoft', `provider ${status}: ${text.slice(0, 200)}`);
    }
    throw new GraphApiError(status, `graph status ${status}: ${text.slice(0, 200)}`);
  }

  /**
   * Normalize a Graph Message resource into the provider-agnostic
   * IncomingMessage shape.
   *
   * Public test seam.
   */
  _normalizeMessageForTests(raw: GraphMessage): IncomingMessage {
    return this.normalizeMessage(raw);
  }

  private normalizeMessage(raw: GraphMessage): IncomingMessage {
    const from = raw.from
      ? {
          display: raw.from.emailAddress?.name ?? '',
          address: normalizeAddress(raw.from.emailAddress?.address ?? ''),
        }
      : { display: '', address: '' };

    // Graph's replyTo is an ARRAY (multiple Reply-To addresses are
    // legal RFC-5322). IncomingMessage models a single reply_to;
    // we take the first. BEC signal is the presence of ANY
    // reply-to-divergence, so collapsing to the first is fine.
    const reply_to = raw.replyTo && raw.replyTo.length > 0
      ? {
          display: raw.replyTo[0]!.emailAddress?.name ?? '',
          address: normalizeAddress(raw.replyTo[0]!.emailAddress?.address ?? ''),
        }
      : null;

    const to: EmailAddress[] = (raw.toRecipients ?? []).map((r) => ({
      display: r.emailAddress?.name ?? '',
      address: normalizeAddress(r.emailAddress?.address ?? ''),
    }));
    const cc: EmailAddress[] = (raw.ccRecipients ?? []).map((r) => ({
      display: r.emailAddress?.name ?? '',
      address: normalizeAddress(r.emailAddress?.address ?? ''),
    }));

    const body_text = raw.body?.contentType === 'text' ? raw.body.content ?? '' : '';
    const body_html = raw.body?.contentType === 'html' ? raw.body.content ?? '' : '';

    // internetMessageHeaders is a name/value array. Some headers
    // may appear multiple times (Received, ARC chain). Build the
    // lower-cased multi-value map.
    const headers = new Map<string, string | string[]>();
    for (const h of raw.internetMessageHeaders ?? []) {
      const k = h.name.toLowerCase();
      const existing = headers.get(k);
      if (existing === undefined) {
        headers.set(k, h.value);
      } else if (Array.isArray(existing)) {
        existing.push(h.value);
      } else {
        headers.set(k, [existing, h.value]);
      }
    }

    // Adversarial-review M1 fix: attachments come inline via
    // `$expand=attachments` on the delta URL. No extra round trip
    // needed per attachment-bearing message. Inline-only / pixel-
    // tracker attachments (isInline=true) are still emitted —
    // BEC images frequently phone home from inline tracking pixels,
    // so the scoring engine wants to see them.
    const attachments: IncomingAttachment[] = (raw.attachments ?? []).map((a) => {
      const filename = a.name ?? '';
      const cid = (a.contentId ?? '').replace(/^<|>$/g, '');
      const filenameForHash = filename || cid || 'inline';
      return {
        id: a.id,
        filename_hash: indexHash(filenameForHash),
        content_type: (a.contentType ?? 'application/octet-stream').toLowerCase(),
        size_bytes: a.size ?? -1,
        content_sha256: null,
      };
    });

    const auth_results = pickAuthResults(headers);

    const received_at = raw.receivedDateTime
      ? new Date(raw.receivedDateTime)
      : new Date();

    return {
      external_message_id: raw.id,
      received_at,
      from,
      reply_to,
      to,
      cc,
      subject: raw.subject ?? '',
      body_text,
      body_html,
      headers: Object.fromEntries(headers),
      attachments,
      auth_results,
    };
  }

  /**
   * Auxiliary fetch — list attachments for a message that
   * hasAttachments=true. Called by the scoring engine on-demand
   * because each attachment list is its own Graph round trip.
   * Returned attachments lack content_sha256 (computed by VirusTotal
   * cache lookup on the bytes).
   */
  async fetchAttachmentsList(input: {
    credentials: LinkedAccountCredentials;
    external_message_id: string;
  }): Promise<IncomingAttachment[]> {
    const access = await this.ensureAccessToken(input.credentials);
    const resp = await this.callApi<GraphAttachmentsResponse>(
      access,
      `${GRAPH_API_BASE}/me/messages/${input.external_message_id}/attachments?$select=id,name,contentType,size,isInline,contentId`,
    );
    return (resp.value ?? []).map((a) => {
      const filename = a.name ?? '';
      const cid = (a.contentId ?? '').replace(/^<|>$/g, '');
      const filenameForHash = filename || cid || 'inline';
      return {
        id: a.id,
        filename_hash: indexHash(filenameForHash),
        content_type: (a.contentType ?? 'application/octet-stream').toLowerCase(),
        size_bytes: a.size ?? -1,
        content_sha256: null,
      };
    });
  }
}

// ---------- helpers (shared shape with gmail.ts) ----------

function hasBodyOrAttachments(msg: IncomingMessage): boolean {
  return msg.body_text.length > 0 || msg.body_html.length > 0 || msg.attachments.length > 0;
}

/**
 * Adversarial-review H4 fix: merge verdicts across all
 * Authentication-Results headers. Microsoft (unlike Gmail)
 * frequently writes MULTIPLE AR headers per inbound — one for
 * spf, one for dkim, one for dmarc, sometimes per hop. The first
 * AR header may carry only one of the three verdicts; the others
 * may be on the second / third header. Taking the first AR
 * header naively loses verdicts.
 *
 * Merge rule: first non-`none` verdict per axis wins. If two
 * headers both carry an SPF result, the first one's value is
 * kept (closest-MTA-wins, which is what RFC 8601 implies).
 */
function pickAuthResults(headers: Map<string, string | string[]>): AuthenticationResults {
  const merged: AuthenticationResults = { spf: 'none', dkim: 'none', dmarc: 'none' };
  const arRaw = headers.get('authentication-results');
  if (arRaw !== undefined) {
    const arList = Array.isArray(arRaw) ? arRaw : [arRaw];
    for (const line of arList) {
      const parsed = parseAuthResults(line);
      for (const k of ['spf', 'dkim', 'dmarc'] as const) {
        if (merged[k] === 'none' && parsed[k] !== 'none') merged[k] = parsed[k];
      }
    }
    if (merged.spf !== 'none' || merged.dkim !== 'none' || merged.dmarc !== 'none') {
      return merged;
    }
  }
  // ARC fallback for mailing-list traffic where the original verdict
  // is relayed via ARC-Authentication-Results.
  const arcRaw = headers.get('arc-authentication-results');
  if (arcRaw !== undefined) {
    const arcList = Array.isArray(arcRaw) ? arcRaw : [arcRaw];
    for (const line of arcList) {
      const parsed = parseAuthResults(line);
      for (const k of ['spf', 'dkim', 'dmarc'] as const) {
        if (merged[k] === 'none' && parsed[k] !== 'none') merged[k] = parsed[k];
      }
    }
  }
  return merged;
}

/**
 * Canonical delta endpoint URL with the `$select` + `$expand`
 * clauses that bind on attachment metadata inline (M1 fix). Used
 * for first-poll AND the "no deltaLink / no nextLink" recovery
 * branch (H2 fix). $expand=attachments with $select keeps the
 * page response bounded (attachment bytes are NOT pulled here —
 * only metadata; bytes come via fetchAttachmentBytes on demand).
 */
function buildDeltaUrl(top: number): string {
  return (
    `${GRAPH_API_BASE}/me/mailFolders/inbox/messages/delta?` +
    `$top=${top}` +
    `&$select=id,internetMessageId,receivedDateTime,from,replyTo,toRecipients,ccRecipients,subject,body,hasAttachments,internetMessageHeaders` +
    `&$expand=attachments($select=id,name,contentType,size,isInline,contentId)`
  );
}

function parseAuthResults(raw: string): AuthenticationResults {
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
