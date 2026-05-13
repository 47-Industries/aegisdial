// Email Shield — provider-agnostic types.
//
// The scoring engine (P6-P10) consumes IncomingMessage. The three
// provider backends (Gmail, Microsoft Graph, IMAP — P3-P5) emit it.
// Keeping the boundary narrow here means the scoring engine never
// branches on `provider`, and a future fourth backend slots in with
// zero scoring-side churn.
//
// All identifiers that could be PII are pre-canonicalized at this
// boundary: addresses are lowercase, headers are name-lowered,
// timestamps are Date objects (not strings), domains are eTLD+1 (not
// full hostnames — the scoring engine's reputation rollup depends on
// this). The provider implementations are responsible for the
// canonicalization; the scoring engine MUST assume the invariants hold.

/**
 * One mailbox address as it appeared in a message header. Display
 * is what the sender wrote ("John Smith" or empty); address is the
 * RFC-5321 envelope ("john@example.com", always lowercased by the
 * provider before reaching scoring).
 */
export interface EmailAddress {
  /** Display name as in the header, or '' if absent. NOT trimmed of quotes. */
  display: string;
  /** Lowercased RFC-5321 address. Provider guarantees lowercase. */
  address: string;
}

/**
 * One attachment on the message. Body bytes are NOT materialized
 * here — the scoring engine asks for hash + metadata only. If a
 * scoring rule needs the bytes (e.g., VirusTotal upload for an
 * unknown hash), the provider exposes `fetchAttachmentBytes(id)`.
 *
 * filename_hash uses indexHash() (peppered) — a filename like
 * "Q4_payroll.xlsx" is identifying.
 */
export interface IncomingAttachment {
  /** Provider-issued attachment id (Gmail attachmentId / Graph id / IMAP MIME part). */
  id: string;
  /** Peppered hash of the filename. NEVER store filename plaintext. */
  filename_hash: string;
  /** MIME content-type as the sender reported it. Lowercased. */
  content_type: string;
  /** Size in bytes. -1 if unknown (rare; some IMAP backends defer Content-Length). */
  size_bytes: number;
  /**
   * SHA-256 of the attachment bytes. Computed by the provider on
   * first fetch and cached on the IncomingAttachment row so VirusTotal
   * lookups can hit on hash without re-downloading. May be null on
   * very large attachments the provider skipped (>25 MB by default).
   */
  content_sha256: string | null;
}

/**
 * Email authentication-results header parse. The provider extracts
 * SPF/DKIM/DMARC verdicts from the Authentication-Results / ARC
 * headers and surfaces them here. Values are the provider's
 * verdict, which mirrors RFC 8601: 'pass' | 'fail' | 'none' |
 * 'softfail' | 'neutral' | 'temperror' | 'permerror'.
 *
 * Provider invariant: if the header is missing, all three are 'none'.
 * Scoring engine treats 'none' as a weaker signal than 'fail'.
 */
export interface AuthenticationResults {
  spf: 'pass' | 'fail' | 'none' | 'softfail' | 'neutral' | 'temperror' | 'permerror';
  dkim: 'pass' | 'fail' | 'none' | 'softfail' | 'neutral' | 'temperror' | 'permerror';
  dmarc: 'pass' | 'fail' | 'none' | 'softfail' | 'neutral' | 'temperror' | 'permerror';
}

/**
 * Normalized incoming message. The scoring engine sees ONLY this
 * shape — never a Gmail GmailMessage, never a Graph Message, never
 * an ImapFlow FetchMessageObject.
 *
 * Body invariants:
 *   - body_text is the user-visible plain-text body, with quoted
 *     reply chains stripped (the provider's responsibility). May be
 *     empty if the message was HTML-only and the provider couldn't
 *     downconvert.
 *   - body_html is the raw HTML (for URL extraction; the scoring
 *     engine never displays it). May be empty.
 *   - At least ONE of body_text / body_html is non-empty (no
 *     bodyless messages reach scoring; provider drops them).
 *
 * PII at this boundary IS NOT YET REDACTED. The scoring engine
 * itself runs digit-redaction before INSERT to email_scans. Holding
 * unredacted bodies in memory inside the request scope is fine;
 * persisting them is forbidden.
 */
export interface IncomingMessage {
  /**
   * Provider-issued message ID. For Gmail/Graph this is the native
   * messageId; for IMAP, "UIDVALIDITY:UID". Used to dedupe in
   * email_scans (UNIQUE constraint at the DB layer).
   */
  external_message_id: string;
  /** When the message landed at the provider. Already a Date (not RFC-2822 string). */
  received_at: Date;
  /** From-header. Provider guarantees lowercased address. */
  from: EmailAddress;
  /**
   * Reply-To header if present, else null. BEC indicator: divergent
   * reply-to from from-address is one of the strongest signals.
   */
  reply_to: EmailAddress | null;
  /** To recipients. May contain the user's address; the scoring engine doesn't care which. */
  to: EmailAddress[];
  /** Cc recipients. Often empty. */
  cc: EmailAddress[];
  /** Subject as written. NOT yet truncated or redacted; scoring engine does that. */
  subject: string;
  /** Plain-text body, quote-stripped. May be empty (HTML-only messages). */
  body_text: string;
  /** Raw HTML body, for URL extraction. May be empty. */
  body_html: string;
  /**
   * Selected message headers. Lowercase names. Provider includes at
   * least: 'message-id', 'return-path', 'received' (array — most
   * recent first), 'authentication-results', 'list-unsubscribe',
   * 'x-mailer'. Other headers MAY be present; scoring rules MUST
   * tolerate absence of any.
   */
  headers: Record<string, string | string[]>;
  attachments: IncomingAttachment[];
  /** Parsed SPF/DKIM/DMARC verdicts. */
  auth_results: AuthenticationResults;
}

/**
 * Result of an OAuth account-link flow. Returned by EmailProvider.linkAccount
 * after the user completes the consent screen. The route layer (P11)
 * envelope-encrypts oauth_token / oauth_refresh_token before INSERT.
 *
 * Plaintext lives ONLY in this object, in process memory, in the
 * /v1/email/accounts/link request scope. It MUST NOT log, MUST NOT
 * persist as plaintext, MUST NOT cross a process boundary except
 * via the encrypted column.
 */
export interface LinkedAccountCredentials {
  provider: 'gmail' | 'microsoft' | 'imap';
  /** Stable provider-side identity (Google sub / Graph oid / IMAP user). */
  provider_account_id: string;
  /** Display-only email address. Shown in iOS UI. */
  display_email: string;
  /** OAuth access token. Plaintext. About to be envelope-encrypted by the caller. */
  oauth_token: string | null;
  /** OAuth refresh token, when the provider supports refresh. */
  oauth_refresh_token: string | null;
  /** Access-token expiry. null if not exposed by the provider (rare). */
  oauth_expires_at: Date | null;
  /** IMAP only. null for gmail/microsoft. */
  imap_host: string | null;
  imap_port: number | null;
  imap_username: string | null;
  /** IMAP only. Either an OAuth token (XOAUTH2) or an app password. */
  app_password: string | null;
}

/**
 * Inbox rules audit result. One entry per concerning rule found.
 * The compromise-check engine (P15) aggregates these into the
 * `findings.inbox_rules` slice of email_compromise_reports.
 *
 * BEC signature: attackers add hidden rules to forward replies to
 * an external attacker-controlled address and immediately delete
 * the original so the victim never notices.
 */
export interface InboxRuleFinding {
  /** Provider-issued rule id. */
  rule_id: string;
  /** Rule name as the provider stores it (often empty if attacker-set). */
  name: string;
  /** Concern category. Used for findings JSONB shape. */
  concern:
    | 'forward_to_external'
    | 'delete_on_receive'
    | 'hide_from_inbox'
    | 'auto_reply_to_external';
  /** Where the rule forwards / where the action lands. */
  destination: string | null;
  /** When the provider says the rule was created (if exposed). */
  created_at: Date | null;
}

/**
 * OAuth grant audit result. One entry per app with mail-related
 * scope that the compromise-check engine flagged.
 */
export interface OAuthGrantFinding {
  /** Application identifier. Google: client_id. Graph: appId. */
  app_id: string;
  /** Human-readable app name as the provider knows it. */
  app_name: string;
  /** Scopes granted to this app. Lowercased. */
  scopes: string[];
  /** When the user originally granted access (if exposed by the provider). */
  granted_at: Date | null;
  /** Concern category. */
  concern: 'unrecognized' | 'known_malicious' | 'excessive_scope' | 'inactive_long';
}

/**
 * Login anomaly audit result. One entry per suspicious sign-in.
 */
export interface LoginAnomalyFinding {
  /** When the sign-in occurred. */
  occurred_at: Date;
  /** City / country as the provider geolocated it (may be 'unknown'). */
  location: string;
  /** Device / user-agent string the provider returned. */
  device: string;
  /** Concern category. */
  concern: 'unusual_geo' | 'unusual_device' | 'failed_then_success' | 'tor_or_vpn';
}

/**
 * The EmailProvider interface. THREE implementations, one consumer.
 *
 * P3 — gmail.ts: Gmail API + OAuth + historyId polling
 * P4 — microsoftGraph.ts: MS Graph + OAuth + delta queries
 * P5 — imap.ts: IMAP + OAuth-where-supported / app-password / IDLE
 *
 * The polling worker (P6) iterates email_accounts WHERE status='active'
 * and dispatches each to the matching provider via a registry
 * (provider name -> EmailProvider instance).
 *
 * EVERY method MUST be idempotent. The polling worker may retry on
 * network failure; calling fetchSince(cursor) twice with the same
 * cursor MUST yield the same message set in the same order.
 *
 * EVERY method MUST honor revocation. If the user revoked the OAuth
 * grant on the provider's side, the next call MUST throw a
 * RevokedError (defined in this file).
 */
export interface EmailProvider {
  readonly name: 'gmail' | 'microsoft' | 'imap';

  /**
   * Complete the OAuth flow (gmail / microsoft) or validate the
   * IMAP credentials. Returns the linked-account credentials in
   * plaintext; the route layer envelope-encrypts before INSERT.
   *
   * The caller (P11 route) is responsible for the FRONT half of
   * OAuth — generating the authorize URL, handling the callback,
   * exchanging the code for tokens. This method takes the
   * post-callback state and packages it for INSERT.
   */
  linkAccount(input: OAuthCallbackPayload): Promise<LinkedAccountCredentials>;

  /**
   * Fetch new messages since the cursor. Cursor format is
   * provider-specific; the worker passes whatever
   * email_accounts.last_history_cursor held. Provider returns the
   * messages PLUS the next cursor to persist.
   *
   * Empty cursor (first poll after link) MUST mean "fetch the
   * latest ~50 messages" — never "fetch everything" (would be a
   * compliance + cost disaster on a 10-year archive).
   */
  fetchSince(input: {
    credentials: LinkedAccountCredentials;
    cursor: string | null;
    /** Per-poll cap. Worker default 100. */
    max_messages: number;
  }): Promise<{
    messages: IncomingMessage[];
    next_cursor: string;
  }>;

  /**
   * Fetch attachment bytes by attachment id. Called by the scoring
   * engine ONLY when the attachment's content_sha256 is unknown to
   * the VirusTotal cache. Bytes are streamed to VT and discarded;
   * they never persist to AegisDial storage.
   */
  fetchAttachmentBytes(input: {
    credentials: LinkedAccountCredentials;
    external_message_id: string;
    attachment_id: string;
  }): Promise<Buffer>;

  /**
   * Audit inbox / mail rules. Compromise-check Pillar 3.
   * Gmail: gmail.users.settings.filters.list
   * Graph: messageRules
   * IMAP: Sieve scripts (where the server exposes them)
   */
  getInboxRules(
    credentials: LinkedAccountCredentials,
  ): Promise<InboxRuleFinding[]>;

  /**
   * Audit third-party apps with access to the mailbox.
   * Gmail: Google account API (oauth2.v2.tokeninfo + scoped grants)
   * Graph: oauth2PermissionGrants
   * IMAP: not supported (returns []); the iOS app should surface
   *   "IMAP backends can't audit OAuth grants — your provider
   *   manages this directly"
   */
  getOAuthGrants(
    credentials: LinkedAccountCredentials,
  ): Promise<OAuthGrantFinding[]>;

  /**
   * Audit recent sign-in activity.
   * Gmail: not directly exposed via API today; this returns [] and
   *   the iOS app links out to Google's "Recent security events"
   *   page instead.
   * Graph: signIns (Azure AD audit log, requires AuditLog.Read.All)
   * IMAP: returns [] (provider-side audit, not via IMAP)
   */
  getRecentLogins(
    credentials: LinkedAccountCredentials,
  ): Promise<LoginAnomalyFinding[]>;

  /**
   * Revoke the OAuth grant on the provider side. Called when the
   * user unlinks an account. iOS app should also surface the
   * revocation in the provider's own UI for belt-and-suspenders.
   *
   * IMAP: app passwords cannot be revoked server-side via IMAP; the
   * implementation returns successfully but documents that the user
   * must revoke the app password in the provider's settings.
   */
  revoke(credentials: LinkedAccountCredentials): Promise<void>;
}

/**
 * Payload from the OAuth callback. Different providers carry
 * different fields; the implementation discriminates on `provider`.
 */
export type OAuthCallbackPayload =
  | {
      provider: 'gmail';
      authorization_code: string;
      /** PKCE code verifier the route generated at /accounts/link init. */
      pkce_verifier: string;
    }
  | {
      provider: 'microsoft';
      authorization_code: string;
      pkce_verifier: string;
    }
  | {
      provider: 'imap';
      /** RFC-3986 host. */
      host: string;
      port: number;
      username: string;
      /** Either an OAuth bearer (XOAUTH2) or an app password. */
      credential: string;
      credential_kind: 'oauth_bearer' | 'app_password';
    };

/**
 * Thrown by any EmailProvider method when the provider tells us the
 * grant is gone (HTTP 401 invalid_grant / Graph token_expired with
 * no refresh / IMAP AUTHENTICATIONFAILED). The polling worker
 * catches RevokedError, flips email_accounts.status='revoked', and
 * surfaces in iOS via /v1/email/settings.
 *
 * Distinct from a transient auth failure (one bad poll on a flaky
 * network) — providers must only throw this when they're confident
 * the user revoked or the token is permanently invalid.
 */
export class RevokedError extends Error {
  constructor(public readonly provider: 'gmail' | 'microsoft' | 'imap', message?: string) {
    super(message ?? `${provider} account access revoked`);
    this.name = 'RevokedError';
  }
}

/**
 * Thrown by EmailProvider methods on transient errors (network
 * blip, provider 5xx). The worker retries with backoff; does NOT
 * flip status.
 */
export class TransientError extends Error {
  constructor(public readonly provider: 'gmail' | 'microsoft' | 'imap', message?: string) {
    super(message ?? `${provider} transient error`);
    this.name = 'TransientError';
  }
}
