import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { query } from '../lib/db.js';
import {
  encryptString,
  readMaybeEncrypted,
} from '../lib/crypto.js';
import { cacheSet, cacheGet, cacheGetAndDelete } from '../lib/cache.js';
import { emitMetric, captureError } from '../lib/observability.js';
import { GmailProvider } from '../services/email/gmail.js';
import { MicrosoftGraphProvider } from '../services/email/microsoftGraph.js';
import { ImapProvider } from '../services/email/imap.js';
import { resolveTamperAlert } from '../services/email/inboxTamperDetector.js';
import { runSuspiciousSentAudit } from '../services/email/suspiciousSentAudit.js';
import { checkBreachExposure } from '../services/email/hibpBreachCheck.js';
import {
  type EmailProvider,
  type LinkedAccountCredentials,
} from '../services/email/types.js';
import { config } from '../config.js';

// Email Shield — /v1/email/* routes. iOS-facing surface.
//
// Pro-gated end-to-end: every route requires an active paid
// subscription (requireProTier middleware after requireAppUser).
// The "Email Shield is bundled into Pro" decision from
// EMAIL_SHIELD.md is enforced HERE — there is no free tier surface.
//
// Endpoint inventory:
//   - POST /v1/email/accounts/oauth/init        — generate OAuth URL
//   - POST /v1/email/accounts/oauth/callback    — exchange code, persist
//   - POST /v1/email/accounts/imap/link         — IMAP credentials path
//   - GET  /v1/email/accounts                   — list user's linked inboxes
//   - DELETE /v1/email/accounts/:id             — unlink + revoke
//   - GET  /v1/email/scans                      — per-user scan history
//   - GET  /v1/email/settings                   — read email_scan_mode
//   - POST /v1/email/settings                   — update email_scan_mode
//   - POST /v1/email/compromise-check           — one-click "is my email compromised"
//
// OAUTH STATE STORAGE: short-lived Redis entries (10-minute TTL),
// keyed by a 32-byte hex state token. The token round-trips
// through the consent flow and binds the callback to the user_id
// that initiated it — CSRF protection.
//
// PII POSTURE: OAuth tokens / app passwords are envelope-encrypted
// at INSERT time and NEVER returned in any response body. The list
// endpoint deliberately excludes them. The compromise-check
// endpoint decrypts them in-process to call the provider's audit
// methods, then discards.

const OAUTH_STATE_TTL_SEC = 600; // 10 minutes
const OAUTH_STATE_KEY_PREFIX = 'email-oauth-state:';

const InitOAuthSchema = z.object({
  provider: z.enum(['gmail', 'microsoft']),
});

const CallbackOAuthSchema = z.object({
  provider: z.enum(['gmail', 'microsoft']),
  code: z.string().min(1).max(2048),
  state: z.string().min(32).max(128),
});

const ImapLinkSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().positive().max(65535),
  username: z.string().min(1).max(254),
  credential: z.string().min(1).max(1024),
  credential_kind: z.enum(['app_password', 'oauth_bearer']),
});

const SettingsSchema = z.object({
  email_scan_mode: z.enum(['disabled', 'manual_only', 'auto']),
});

const CompromiseCheckSchema = z.object({
  email_account_id: z.string().uuid(),
});

const TamperAlertRespondSchema = z.object({
  decision: z.enum(['confirmed', 'denied']),
});

const TamperAlertListQuerySchema = z.object({
  // 'all' = no status filter. Defaults to 'pending' so a fresh iOS
  // launch hits the hot partial index.
  status: z.enum(['pending', 'confirmed', 'denied', 'expired', 'all']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

interface OAuthStateBlob {
  user_id: string;
  provider: 'gmail' | 'microsoft';
  pkce_verifier: string;
}

interface EmailAccountRow {
  id: string;
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

/**
 * Construct the right provider instance per row. The provider
 * stays construction-light (no IO at constructor time) so we
 * build it per-request.
 */
function buildProvider(provider: 'gmail' | 'microsoft' | 'imap'): EmailProvider {
  switch (provider) {
    case 'gmail':
      return new GmailProvider({
        // Worker passes onTokenRefreshed via a separate factory in
        // P-worker. Route-layer compromise-check is short-lived
        // and re-reads the row each time; we don't wire the
        // persistence callback here.
      });
    case 'microsoft':
      return new MicrosoftGraphProvider({});
    case 'imap':
      return new ImapProvider({});
  }
}

/**
 * Decrypt the relevant credential fields off a stored row into
 * the LinkedAccountCredentials shape the providers consume.
 * Plaintext lives ONLY in process memory for the request scope.
 */
function rowToCredentials(row: EmailAccountRow): LinkedAccountCredentials {
  return {
    provider: row.provider,
    provider_account_id: row.provider_account_id,
    display_email: row.display_email,
    oauth_token: readMaybeEncrypted(row.oauth_token_ct),
    oauth_refresh_token: readMaybeEncrypted(row.oauth_refresh_token_ct),
    oauth_expires_at: row.oauth_expires_at,
    imap_host: row.imap_host,
    imap_port: row.imap_port,
    imap_username: row.imap_username,
    app_password: readMaybeEncrypted(row.app_password_ct),
  };
}

/**
 * User-keyed rate limit. Pattern reused from /v1/sms/* — shared-IP
 * users (CGNAT / office / VPN) don't share quota.
 *
 * Adversarial-review H1 fix: `hook: 'preHandler'` is the critical
 * piece. `@fastify/rate-limit` defaults to the `onRequest` hook,
 * which fires BEFORE `requireAppUser` populates `req.appUser`. With
 * the default hook, `keyGenerator` always sees `appUser === undefined`
 * and silently falls through to `ip:` keying — defeating the whole
 * point of the user-keyed limit. Pinning to `preHandler` runs the
 * limiter AFTER auth so it can see the authenticated identity.
 */
const userKeyedLimit = {
  hook: 'preHandler' as const,
  keyGenerator: (req: FastifyRequest) =>
    req.appUser?.id ? `user:${req.appUser.id}` : `ip:${req.ip}`,
};

export async function emailShieldRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------
  // OAuth init — generate state + PKCE verifier, return authorize URL
  // -------------------------------------------------------------
  app.post(
    '/v1/email/accounts/oauth/init',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = InitOAuthSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const { provider } = parsed.data;
      const userId = req.appUser!.id;

      // Check provider configuration before generating state — fast
      // fail with a clear error instead of letting the callback
      // discover it.
      if (provider === 'gmail') {
        if (!config.GOOGLE_OAUTH_CLIENT_ID || !config.GOOGLE_OAUTH_REDIRECT_URI) {
          return reply.code(503).send({ error: 'gmail_not_configured' });
        }
      } else {
        if (!config.MICROSOFT_OAUTH_CLIENT_ID || !config.MICROSOFT_OAUTH_REDIRECT_URI) {
          return reply.code(503).send({ error: 'microsoft_not_configured' });
        }
      }

      // PKCE state. 32 random bytes = 64 hex chars; the verifier
      // is the high-entropy secret; the challenge (SHA-256 b64url)
      // is what goes into the authorize URL.
      const state = randomBytes(32).toString('hex');
      const verifier = randomBytes(32).toString('base64url');
      const challenge =
        provider === 'gmail'
          ? GmailProvider.pkceChallenge(verifier)
          : MicrosoftGraphProvider.pkceChallenge(verifier);

      // Stash state → {user_id, provider, verifier} in Redis with
      // a 10-minute TTL. Binds the callback to this user — an
      // attacker who intercepts the code can't redeem it for
      // someone else's account.
      const blob: OAuthStateBlob = { user_id: userId, provider, pkce_verifier: verifier };
      await cacheSet(`${OAUTH_STATE_KEY_PREFIX}${state}`, blob, OAUTH_STATE_TTL_SEC);

      const authorize_url =
        provider === 'gmail'
          ? GmailProvider.buildAuthorizeUrl({
              client_id: config.GOOGLE_OAUTH_CLIENT_ID!,
              redirect_uri: config.GOOGLE_OAUTH_REDIRECT_URI!,
              state,
              pkce_challenge: challenge,
            })
          : MicrosoftGraphProvider.buildAuthorizeUrl({
              client_id: config.MICROSOFT_OAUTH_CLIENT_ID!,
              redirect_uri: config.MICROSOFT_OAUTH_REDIRECT_URI!,
              state,
              pkce_challenge: challenge,
            });

      void emitMetric('email_shield.oauth_init', { provider });
      return reply.send({ authorize_url, state });
    },
  );

  // -------------------------------------------------------------
  // OAuth callback — exchange code, persist account
  // -------------------------------------------------------------
  app.post(
    '/v1/email/accounts/oauth/callback',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = CallbackOAuthSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const { provider, code, state } = parsed.data;
      const userId = req.appUser!.id;

      // Adversarial-review H2 fix: atomic GETDEL so two concurrent
      // callbacks with the same state can't both pass replay
      // protection. The prior cacheGet + cacheInvalidate pair was
      // two round trips; both calls could read the blob before
      // either deleted it.
      const stateKey = `${OAUTH_STATE_KEY_PREFIX}${state}`;
      const blob = await cacheGetAndDelete<OAuthStateBlob>(stateKey);
      if (!blob) {
        return reply.code(400).send({ error: 'state_expired_or_invalid' });
      }

      // CSRF protection: the state's user_id MUST match the caller.
      if (blob.user_id !== userId) {
        void emitMetric('email_shield.oauth_state_user_mismatch', { provider });
        return reply.code(400).send({ error: 'state_user_mismatch' });
      }
      if (blob.provider !== provider) {
        return reply.code(400).send({ error: 'state_provider_mismatch' });
      }

      const providerImpl = buildProvider(provider);
      let creds: LinkedAccountCredentials;
      try {
        creds = await providerImpl.linkAccount({
          provider,
          authorization_code: code,
          pkce_verifier: blob.pkce_verifier,
        } as never);
      } catch (err) {
        captureError(err, { component: 'emailShield.oauth_callback', user_id: userId, provider });
        return reply.code(502).send({ error: 'provider_link_failed' });
      }

      const persisted = await persistAccount(userId, creds);
      void emitMetric('email_shield.account_linked', { provider });
      return reply.send(persisted);
    },
  );

  // -------------------------------------------------------------
  // IMAP link — credentials path
  // -------------------------------------------------------------
  app.post(
    '/v1/email/accounts/imap/link',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = ImapLinkSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const userId = req.appUser!.id;
      const providerImpl = new ImapProvider({});
      let creds: LinkedAccountCredentials;
      try {
        creds = await providerImpl.linkAccount({
          provider: 'imap',
          host: parsed.data.host,
          port: parsed.data.port,
          username: parsed.data.username,
          credential: parsed.data.credential,
          credential_kind: parsed.data.credential_kind,
        });
      } catch (err) {
        captureError(err, { component: 'emailShield.imap_link', user_id: userId });
        const errMsg = err instanceof Error ? err.message : String(err);
        // Auth failure → 401 so iOS can prompt for a re-entered
        // password vs a transient/server error.
        if (/IMAP auth failed/.test(errMsg)) {
          return reply.code(401).send({ error: 'imap_auth_failed' });
        }
        return reply.code(502).send({ error: 'imap_link_failed' });
      }
      const persisted = await persistAccount(userId, creds);
      void emitMetric('email_shield.account_linked', { provider: 'imap' });
      return reply.send(persisted);
    },
  );

  // -------------------------------------------------------------
  // List accounts (NO tokens in response)
  // -------------------------------------------------------------
  app.get(
    '/v1/email/accounts',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const userId = req.appUser!.id;
      const res = await query<{
        id: string;
        provider: string;
        display_email: string;
        status: string;
        last_poll_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id, provider, display_email, status, last_poll_at, created_at
           FROM email_accounts WHERE user_id = $1
           ORDER BY created_at DESC`,
        [userId],
      );
      return reply.send({
        accounts: res.rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          display_email: r.display_email,
          status: r.status,
          last_poll_at: r.last_poll_at?.toISOString() ?? null,
          created_at: r.created_at.toISOString(),
        })),
      });
    },
  );

  // -------------------------------------------------------------
  // Delete account — revoke + flip local status
  // -------------------------------------------------------------
  app.delete(
    '/v1/email/accounts/:id',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const userId = req.appUser!.id;
      const { id: idRaw } = req.params as { id: string };
      // Adversarial-review L1 fix: z.string().uuid() is stricter
      // than the prior regex /^[0-9a-f-]{36}$/i (which accepted
      // 36 dashes etc.). Aligns with the compromise-check id
      // validation upstream.
      const parsedId = z.string().uuid().safeParse(idRaw);
      if (!parsedId.success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const id = parsedId.data;
      const res = await query<EmailAccountRow>(
        `SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      if (res.rowCount === 0) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const row = res.rows[0]!;
      // Best-effort revoke on the provider side. Even if it fails
      // (network, provider down), we still flip local status.
      try {
        const providerImpl = buildProvider(row.provider);
        await providerImpl.revoke(rowToCredentials(row));
      } catch (err) {
        captureError(err, { component: 'emailShield.revoke', user_id: userId });
      }
      await query(
        `UPDATE email_accounts SET status = 'revoked', updated_at = NOW() WHERE id = $1`,
        [id],
      );
      void emitMetric('email_shield.account_revoked', { provider: row.provider });
      return reply.send({ ok: true, status: 'revoked' });
    },
  );

  // -------------------------------------------------------------
  // GET /v1/email/scans — per-user scan history (mirror of SMS)
  // -------------------------------------------------------------
  app.get(
    '/v1/email/scans',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const q = req.query as { limit?: string; flagged_only?: string; email_account_id?: string };
      const rawLimit = q.limit ? parseInt(q.limit, 10) : 50;
      const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50));
      const flaggedOnly = q.flagged_only === 'true' || q.flagged_only === '1';
      // Adversarial-review M2 fix: validate email_account_id as a
      // UUID before letting it reach the SQL filter. Without this,
      // a malformed value surfaces as a 500 (Postgres 22P02
      // invalid_text_representation) instead of a clean 400.
      const accountFilterRaw = q.email_account_id ?? null;
      let accountFilter: string | null = null;
      if (accountFilterRaw) {
        const parsed = z.string().uuid().safeParse(accountFilterRaw);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid_email_account_id' });
        }
        accountFilter = parsed.data;
      }
      const userId = req.appUser!.id;

      const params: unknown[] = [userId];
      const conds: string[] = ['user_id = $1'];
      if (flaggedOnly) conds.push(`verdict IN ('suspicious', 'fraud')`);
      if (accountFilter) {
        params.push(accountFilter);
        conds.push(`email_account_id = $${params.length}`);
      }
      params.push(limit);
      const limitIdx = params.length;
      const res = await query<{
        id: string;
        email_account_id: string;
        external_message_id: string;
        from_address_hash: string;
        sender_domain: string;
        subject_excerpt: string;
        fraud_score: number;
        verdict: string;
        triggered_categories: unknown;
        reasons: unknown;
        url_findings: unknown;
        attachment_findings: unknown;
        scanned_at: Date;
      }>(
        `SELECT id, email_account_id, external_message_id, from_address_hash,
                sender_domain, subject_excerpt, fraud_score, verdict,
                triggered_categories, reasons, url_findings, attachment_findings,
                scanned_at
           FROM email_scans
          WHERE ${conds.join(' AND ')}
          ORDER BY scanned_at DESC
          LIMIT $${limitIdx}`,
        params,
      );

      return reply.send({
        scans: res.rows.map((r) => ({
          id: r.id,
          email_account_id: r.email_account_id,
          external_message_id: r.external_message_id,
          sender_domain: r.sender_domain,
          subject_excerpt: r.subject_excerpt,
          fraud_score: r.fraud_score,
          verdict: r.verdict,
          triggered_categories: r.triggered_categories,
          reasons: r.reasons,
          url_findings: r.url_findings,
          attachment_findings: r.attachment_findings,
          scanned_at: r.scanned_at.toISOString(),
        })),
        limit,
        flagged_only: flaggedOnly,
      });
    },
  );

  // -------------------------------------------------------------
  // GET /v1/email/settings — read scanning mode
  // -------------------------------------------------------------
  app.get(
    '/v1/email/settings',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const userId = req.appUser!.id;
      // Tolerate the migration-not-applied state (mirror of the H2
      // fix from SMS Shield commit 1b6e350).
      try {
        const res = await query<{ email_scan_mode: string }>(
          `SELECT COALESCE(email_scan_mode, 'manual_only')::TEXT AS email_scan_mode
             FROM users WHERE id = $1`,
          [userId],
        );
        if (res.rowCount === 0) return reply.code(404).send({ error: 'user_not_found' });
        return reply.send({
          email_scan_mode: res.rows[0]!.email_scan_mode,
          available_modes: ['disabled', 'manual_only', 'auto'],
        });
      } catch (err) {
        const pgCode = (err as { code?: string }).code;
        if (pgCode === '42703') {
          void emitMetric('email_shield.settings_column_missing', {});
          return reply.send({
            email_scan_mode: 'manual_only',
            available_modes: ['disabled', 'manual_only', 'auto'],
          });
        }
        throw err;
      }
    },
  );

  // -------------------------------------------------------------
  // POST /v1/email/settings — update scanning mode
  // -------------------------------------------------------------
  app.post(
    '/v1/email/settings',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = SettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const { email_scan_mode } = parsed.data;
      const userId = req.appUser!.id;
      try {
        const res = await query<{ id: string }>(
          `UPDATE users SET email_scan_mode = $1 WHERE id = $2 RETURNING id`,
          [email_scan_mode, userId],
        );
        if (res.rowCount === 0) return reply.code(404).send({ error: 'user_not_found' });
        void emitMetric('email_shield.settings_updated', { mode: email_scan_mode });
        return reply.send({ email_scan_mode });
      } catch (err) {
        const pgCode = (err as { code?: string }).code;
        if (pgCode === '42703') {
          void emitMetric('email_shield.settings_column_missing', {});
          return reply.code(503).send({ error: 'settings_not_yet_available' });
        }
        throw err;
      }
    },
  );

  // -------------------------------------------------------------
  // POST /v1/email/compromise-check — one-click report
  // -------------------------------------------------------------
  // Adversarial-review H3 (from EMAIL_SHIELD.md): rate-limit ~1/hour
  // per (user, email_account_id) AND dedupe-cache clean reports
  // < 6h old. Without this, a buggy iOS background refresh writes
  // 24-90 reports per user per day.
  app.post(
    '/v1/email/compromise-check',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        // Route-level limit is the upper bound; per-account dedupe
        // happens INSIDE the handler.
        rateLimit: { max: 10, timeWindow: '1 hour', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = CompromiseCheckSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const { email_account_id } = parsed.data;
      const userId = req.appUser!.id;

      // Lookup + ownership check.
      const acctRes = await query<EmailAccountRow>(
        `SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2`,
        [email_account_id, userId],
      );
      if ((acctRes.rowCount ?? 0) === 0) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const row = acctRes.rows[0]!;
      if (row.status !== 'active') {
        return reply.code(409).send({ error: 'account_not_active', status: row.status });
      }

      // Dedupe: if the previous report is < 6h old AND verdict
      // 'clean', return cached. Saves provider round-trips on
      // repeat polls. We DO NOT cache 'concerns' / 'compromised'
      // because the user may have remediated and wants a fresh
      // read.
      const cached = await query<{
        id: string;
        overall_verdict: 'clean' | 'concerns' | 'compromised';
        findings: unknown;
        generated_at: Date;
      }>(
        `SELECT id, overall_verdict, findings, generated_at
           FROM email_compromise_reports
          WHERE user_id = $1
            AND email_account_id = $2
            AND generated_at > NOW() - INTERVAL '6 hours'
            AND overall_verdict = 'clean'
          ORDER BY generated_at DESC LIMIT 1`,
        [userId, email_account_id],
      );
      if ((cached.rowCount ?? 0) > 0) {
        const c = cached.rows[0]!;
        void emitMetric('email_shield.compromise_check_cached', { verdict: c.overall_verdict });
        return reply.send({
          id: c.id,
          email_account_id,
          overall_verdict: c.overall_verdict,
          findings: c.findings,
          generated_at: c.generated_at.toISOString(),
          from_cache: true,
        });
      }

      // Adversarial-review M1 fix: per-(user, account) hourly cap.
      // ONLY applies when we're about to do real provider work —
      // a cache hit above served instantly without consuming
      // quota. The route-level limit is 10/hour per user; this
      // adds ~1/hour per (user, email_account_id) so a 5-inbox
      // Pro user doesn't share the global ceiling across all
      // five accounts.
      const perAccountKey = `email-compromise:${userId}:${email_account_id}`;
      const recentCount = await cacheGet<number>(perAccountKey);
      const COMPROMISE_CHECK_PER_ACCOUNT_HOURLY_MAX = 1;
      if ((recentCount ?? 0) >= COMPROMISE_CHECK_PER_ACCOUNT_HOURLY_MAX) {
        return reply.code(429).send({
          error: 'compromise_check_rate_limited',
          message: 'Compromise check has been run on this inbox in the last hour. Try again later.',
        });
      }

      // Run the full Pillar 3 audit. Five detectors fan out in
      // parallel — three provider-keyed (inbox rules, OAuth grants,
      // recent logins) and two independent-of-credentials
      // (suspicious-sent audit reuses provider creds; HIBP queries
      // only the email address). Each detector swallows its own
      // failure so one provider hiccup doesn't void the whole audit.
      const providerImpl = buildProvider(row.provider);
      const creds = rowToCredentials(row);
      const findings: Record<string, unknown> = {};
      try {
        const [rules, grants, logins, sentAudit, breachExposure] = await Promise.all([
          providerImpl.getInboxRules(creds).catch(() => []),
          providerImpl.getOAuthGrants(creds).catch(() => []),
          providerImpl.getRecentLogins(creds).catch(() => []),
          runSuspiciousSentAudit(providerImpl, creds).catch(() => ({
            findings: [],
            scanned_count: 0,
            window_days: 14,
          })),
          checkBreachExposure(row.display_email).catch(() => ({
            email_checked: false,
            breaches: [],
            high_severity_count: 0,
            reason_skipped: 'api_error' as const,
          })),
        ]);
        if (rules.length > 0) findings.inbox_rules = rules;
        if (grants.length > 0) findings.oauth_grants = grants;
        if (logins.length > 0) findings.login_anomalies = logins;
        if (sentAudit.findings.length > 0) findings.suspicious_sent = sentAudit;
        if (breachExposure.email_checked && breachExposure.breaches.length > 0) {
          findings.breach_exposure = breachExposure;
        }
      } catch (err) {
        captureError(err, { component: 'emailShield.compromise_check', user_id: userId });
        return reply.code(502).send({ error: 'compromise_check_failed' });
      }

      // Composite verdict. 'compromised' requires a HIGH-confidence
      // signal:
      //   - external-forward rule (attacker exfil channel)         → compromised
      //   - high-confidence suspicious-sent finding (outbound BEC) → compromised
      //   - any other finding (oauth, logins, breach, low-sent)    → concerns
      //   - no findings                                            → clean
      // Breach exposure is intentionally 'concerns'-only — finding
      // your email in a 2014 LinkedIn dump doesn't mean an attacker
      // is currently in your inbox; it means rotate the password.
      // Same for OAuth grants and login anomalies on their own.
      const rules = (findings.inbox_rules as { concern: string }[] | undefined) ?? [];
      const hasExternalForward = rules.some((r) => r.concern === 'forward_to_external');
      const sentAuditFindings = findings.suspicious_sent as
        | { findings: { confidence: string }[] }
        | undefined;
      const hasHighSent = !!sentAuditFindings?.findings.some((f) => f.confidence === 'high');
      let overall_verdict: 'clean' | 'concerns' | 'compromised';
      if (hasExternalForward || hasHighSent) overall_verdict = 'compromised';
      else if (Object.keys(findings).length > 0) overall_verdict = 'concerns';
      else overall_verdict = 'clean';

      const reportId = randomUUID();
      await query(
        `INSERT INTO email_compromise_reports
           (id, user_id, email_account_id, overall_verdict, findings)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [reportId, userId, email_account_id, overall_verdict, JSON.stringify(findings)],
      );
      void emitMetric('email_shield.compromise_check', { verdict: overall_verdict });

      // Bump the per-(user, account) hourly counter ONLY when we
      // actually ran the audit. Cache-hit on a clean prior report
      // doesn't count toward the hourly cap because no provider
      // round-trips happened.
      await cacheSet(perAccountKey, (recentCount ?? 0) + 1, 60 * 60);

      return reply.send({
        id: reportId,
        email_account_id,
        overall_verdict,
        findings,
        generated_at: new Date().toISOString(),
        from_cache: false,
      });
    },
  );

  // -------------------------------------------------------------
  // GET /v1/email/tamper-alerts — list pending "did you delete this?"
  // -------------------------------------------------------------
  app.get(
    '/v1/email/tamper-alerts',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const userId = req.appUser!.id;
      const parsedQ = TamperAlertListQuerySchema.safeParse(req.query ?? {});
      if (!parsedQ.success) {
        return reply.code(400).send({ error: 'invalid_query', details: parsedQ.error.flatten() });
      }
      const status = parsedQ.data.status === 'all' ? null : parsedQ.data.status ?? 'pending';
      const limit = parsedQ.data.limit ?? 50;

      const params: unknown[] = [userId];
      let where = 'user_id = $1';
      if (status) {
        params.push(status);
        where += ` AND status = $${params.length}`;
      }
      params.push(limit);
      const res = await query<{
        id: string;
        email_account_id: string;
        scan_id: string;
        sender_domain: string;
        subject_excerpt: string;
        delete_after_seconds: number;
        status: string;
        responded_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id, email_account_id, scan_id, sender_domain, subject_excerpt,
                delete_after_seconds, status, responded_at, created_at
           FROM email_tamper_alerts
          WHERE ${where}
          ORDER BY created_at DESC
          LIMIT $${params.length}`,
        params,
      );
      return reply.send({
        alerts: res.rows.map((r) => ({
          id: r.id,
          email_account_id: r.email_account_id,
          scan_id: r.scan_id,
          sender_domain: r.sender_domain,
          subject_excerpt: r.subject_excerpt,
          delete_after_seconds: r.delete_after_seconds,
          status: r.status,
          responded_at: r.responded_at?.toISOString() ?? null,
          created_at: r.created_at.toISOString(),
        })),
      });
    },
  );

  // -------------------------------------------------------------
  // POST /v1/email/tamper-alerts/:id/respond — confirm or deny
  // -------------------------------------------------------------
  app.post(
    '/v1/email/tamper-alerts/:id/respond',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const userId = req.appUser!.id;
      const { id: idRaw } = req.params as { id: string };
      const parsedId = z.string().uuid().safeParse(idRaw);
      if (!parsedId.success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const parsed = TamperAlertRespondSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const result = await resolveTamperAlert({
        alert_id: parsedId.data,
        user_id: userId,
        decision: parsed.data.decision,
      });
      if (!result.ok) {
        // Either the alert doesn't exist, isn't owned by this user,
        // or was already resolved. 404 is the right shape — iOS
        // can refresh the list.
        return reply.code(404).send({ error: 'not_found_or_already_resolved' });
      }
      return reply.send({
        ok: true,
        decision: parsed.data.decision,
        escalated_to_compromise_report: result.escalated_to_compromise_report,
      });
    },
  );
}

/**
 * Envelope-encrypt the credential fields and INSERT (or UPDATE on
 * re-link via UNIQUE (user_id, provider, provider_account_id)) the
 * email_accounts row. Returns the safe response shape — NO
 * credentials in the response.
 *
 * On re-link, the existing row's status is reset to 'active' (the
 * user just walked through consent again) and the credentials
 * rotated.
 */
async function persistAccount(
  userId: string,
  creds: LinkedAccountCredentials,
): Promise<{
  id: string;
  provider: string;
  display_email: string;
  status: string;
}> {
  const oauthTokenCt = creds.oauth_token ? encryptString(creds.oauth_token) : null;
  const refreshCt = creds.oauth_refresh_token ? encryptString(creds.oauth_refresh_token) : null;
  const appPwdCt = creds.app_password ? encryptString(creds.app_password) : null;

  // UPSERT keyed on the migration-057 composite UNIQUE so a re-link
  // overwrites rather than creating a duplicate row.
  const res = await query<{ id: string }>(
    `INSERT INTO email_accounts (
       user_id, provider, provider_account_id, display_email,
       oauth_token_ct, oauth_refresh_token_ct, oauth_expires_at,
       imap_host, imap_port, imap_username, app_password_ct,
       status
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active'
     )
     ON CONFLICT (user_id, provider, provider_account_id) DO UPDATE SET
       display_email = EXCLUDED.display_email,
       oauth_token_ct = EXCLUDED.oauth_token_ct,
       oauth_refresh_token_ct = EXCLUDED.oauth_refresh_token_ct,
       oauth_expires_at = EXCLUDED.oauth_expires_at,
       imap_host = EXCLUDED.imap_host,
       imap_port = EXCLUDED.imap_port,
       imap_username = EXCLUDED.imap_username,
       app_password_ct = EXCLUDED.app_password_ct,
       status = 'active',
       updated_at = NOW()
     RETURNING id`,
    [
      userId,
      creds.provider,
      creds.provider_account_id,
      creds.display_email,
      oauthTokenCt,
      refreshCt,
      creds.oauth_expires_at,
      creds.imap_host,
      creds.imap_port,
      creds.imap_username,
      appPwdCt,
    ],
  );
  return {
    id: res.rows[0]!.id,
    provider: creds.provider,
    display_email: creds.display_email,
    status: 'active',
  };
}
