import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { query } from '../lib/db.js';
import { signAppJwt, verifyAppleIdToken } from '../lib/jwt.js';
import { currentTier } from '../lib/subscription.js';
import { track } from '../lib/analytics.js';
import { sendEmail } from '../lib/email.js';
import { requireAppUser } from '../lib/auth.js';
import { normalizeE164 } from '../lib/phone.js';

const BCRYPT_ROUNDS = 10;

// Minimum age to sign up. 13+ keeps us well clear of COPPA. iOS client
// prompts for birth year on signup; we only store the year (not a full
// DOB — we don't need the extra PII for a gate).
const MIN_AGE_YEARS = 13;
function currentYear(): number {
  return new Date().getUTCFullYear();
}
function dobYearMeetsMinimum(dobYear: number): boolean {
  return currentYear() - dobYear >= MIN_AGE_YEARS;
}

const appleBodySchema = z.object({
  id_token: z.string().min(20),
  display_name: z.string().max(120).optional(),
  // Required for NEW signups; returning users hit the `existing.rows.length`
  // branch and never look at this field. Client always sends it on first
  // Apple signin, omits on return.
  dob_year: z.number().int().min(1900).max(2100).optional(),
});

const emailSignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  display_name: z.string().max(120).optional(),
  dob_year: z.number().int().min(1900).max(2100),
});

const emailLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, '6-digit numeric code required'),
  new_password: z.string().min(8).max(200),
});

// 6-digit numeric code via cryptographically-secure RNG. Bcrypt-hashed
// before storage so a DB dump doesn't give an attacker live codes.
import { randomInt } from 'node:crypto';
function generateResetCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

const RESET_CODE_TTL_MINUTES = 15;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/auth/apple',
    {
      config: {
        // Pre-auth endpoint — no req.appUser exists yet, so we key on
        // IP. 10/min is generous for legitimate users (Apple Sign In
        // succeeds first try almost always) but kills credential
        // stuffing / token replay floods. Global 300/min/IP from
        // server.ts still applies on top.
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
    const body = appleBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    let claims;
    try {
      claims = await verifyAppleIdToken(body.data.id_token);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'apple id_token verify failed');
      return reply.code(401).send({ error: 'invalid_apple_token' });
    }

    const existing = await query<{ id: string; tier: string }>(
      `SELECT id FROM users WHERE apple_sub = $1`,
      [claims.sub],
    );

    let userId: string;
    let isNewUser = false;
    if (existing.rows.length > 0) {
      userId = existing.rows[0]!.id;
      await query(`UPDATE users SET last_seen_at = NOW() WHERE id = $1`, [userId]);
    } else {
      // Age gate for brand-new Apple signups. Apple doesn't share DOB via
      // Sign in with Apple, so the client must prompt and pass dob_year.
      if (body.data.dob_year == null) {
        return reply.code(400).send({ error: 'dob_year_required' });
      }
      if (!dobYearMeetsMinimum(body.data.dob_year)) {
        return reply.code(403).send({
          error: 'age_restriction',
          message: `AegisDial is for users aged ${MIN_AGE_YEARS}+.`,
        });
      }
      const inserted = await query<{ id: string }>(
        `INSERT INTO users (auth_method, apple_sub, email, display_name, dob_year)
         VALUES ('apple', $1, $2, $3, $4)
         RETURNING id`,
        [
          claims.sub,
          claims.email ?? null,
          body.data.display_name ?? null,
          body.data.dob_year,
        ],
      );
      userId = inserted.rows[0]!.id;
      isNewUser = true;
      void track('user_signed_up', { userId, properties: { method: 'apple' } });
      if (claims.email) {
        void sendEmail({
          userId,
          to: claims.email,
          template: 'welcome',
          data: { display_name: body.data.display_name ?? null },
        });
      }
    }
    if (!isNewUser) void track('user_signed_in', { userId, properties: { method: 'apple' } });

    const tier = await currentTier(userId);
    const token = await signAppJwt({ sub: userId, auth_method: 'apple', tier });
    return reply.send({ token, user_id: userId, tier });
  });

  app.post(
    '/auth/email/signup',
    {
      config: {
        // Pre-auth, IP-keyed. 5/min — signups are rare and a human
        // rarely needs more than 1-2 attempts. Tight cap blunts
        // automated account-creation farms (used for trial abuse +
        // referral fraud).
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
    const body = emailSignupSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const emailLower = body.data.email.toLowerCase();
    if (!dobYearMeetsMinimum(body.data.dob_year)) {
      return reply.code(403).send({
        error: 'age_restriction',
        message: `AegisDial is for users aged ${MIN_AGE_YEARS}+.`,
      });
    }
    const existing = await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [emailLower]);
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'email_already_registered' });
    }

    const hash = await bcrypt.hash(body.data.password, BCRYPT_ROUNDS);
    const inserted = await query<{ id: string }>(
      `INSERT INTO users (auth_method, email, email_hash, display_name, dob_year)
       VALUES ('email', $1, $2, $3, $4)
       RETURNING id`,
      [emailLower, hash, body.data.display_name ?? null, body.data.dob_year],
    );
    const userId = inserted.rows[0]!.id;
    void track('user_signed_up', { userId, properties: { method: 'email' } });
    void sendEmail({
      userId,
      to: emailLower,
      template: 'welcome',
      data: { display_name: body.data.display_name ?? null },
    });
    const tier = await currentTier(userId);
    const token = await signAppJwt({ sub: userId, auth_method: 'email', tier });
    return reply.send({ token, user_id: userId, tier });
  });

  // Forgot-password: send a 6-digit code to the email if it exists.
  // Returns 200 even when the email doesn't match a user — leaking
  // "this email exists in our DB" via response code is a common
  // enumeration vector. The Resend send is async/best-effort.
  app.post(
    '/auth/email/forgot-password',
    {
      config: {
        // 3/min/IP is tight. A legit user retries once or twice if
        // their first email lands in spam; a script floods this to
        // probe valid emails.
        rateLimit: { max: 3, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const body = forgotPasswordSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      const emailLower = body.data.email.toLowerCase();

      const userRes = await query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1 AND auth_method = 'email'`,
        [emailLower],
      );
      // Always pretend success — don't reveal whether the email exists.
      if (userRes.rows.length === 0) {
        return reply.send({ sent: true });
      }
      const userId = userRes.rows[0]!.id;

      // Invalidate any previous unused code for this user (the unique
      // partial index `password_reset_codes_one_unused_per_user`
      // enforces only-one-active, so we explicitly mark prior rows
      // used before inserting the new one).
      await query(
        `UPDATE password_reset_codes
            SET used_at = NOW()
          WHERE user_id = $1 AND used_at IS NULL`,
        [userId],
      );
      const code = generateResetCode();
      const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
      const expiresAt = new Date(
        Date.now() + RESET_CODE_TTL_MINUTES * 60 * 1000,
      );
      await query(
        `INSERT INTO password_reset_codes (user_id, code_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, codeHash, expiresAt.toISOString()],
      );
      void sendEmail({
        userId,
        to: emailLower,
        template: 'password_reset_code',
        data: { code, expires_in_minutes: RESET_CODE_TTL_MINUTES },
      });
      void track('password_reset_requested', { userId });
      return reply.send({ sent: true });
    },
  );

  // Reset-password: verify the 6-digit code + set a new password.
  // The route bcrypts the submitted code and compares against the
  // stored hash so a SQL-injection or db-dump scenario can't leak
  // live codes. Same generic 401 for "wrong code" + "expired code"
  // + "code already used" — granular errors leak more than they
  // help a legit user.
  app.post(
    '/auth/email/reset-password',
    {
      config: {
        // 5/min/IP — accommodates a user typo'ing the code twice
        // before fetching another email. Tighter than signup
        // because the attack surface is "guess a 6-digit code I
        // intercepted from the same email."
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const body = resetPasswordSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      const emailLower = body.data.email.toLowerCase();

      const userRes = await query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1 AND auth_method = 'email'`,
        [emailLower],
      );
      if (userRes.rows.length === 0) {
        return reply.code(401).send({ error: 'invalid_code' });
      }
      const userId = userRes.rows[0]!.id;

      const codeRes = await query<{ id: string; code_hash: string }>(
        `SELECT id, code_hash FROM password_reset_codes
          WHERE user_id = $1
            AND used_at IS NULL
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1`,
        [userId],
      );
      if (codeRes.rows.length === 0) {
        return reply.code(401).send({ error: 'invalid_code' });
      }
      const row = codeRes.rows[0]!;
      const match = await bcrypt.compare(body.data.code, row.code_hash);
      if (!match) {
        return reply.code(401).send({ error: 'invalid_code' });
      }

      // Code verified — rotate the user's password + burn the code.
      // Both queries inside the same statement so a crash between
      // them can't leave the code reusable AFTER the password is
      // already changed.
      const newHash = await bcrypt.hash(body.data.new_password, BCRYPT_ROUNDS);
      await query(
        `WITH burned AS (
           UPDATE password_reset_codes SET used_at = NOW() WHERE id = $1
         )
         UPDATE users SET email_hash = $2 WHERE id = $3`,
        [row.id, newHash, userId],
      );
      void track('password_reset_completed', { userId });
      return reply.send({ reset: true });
    },
  );

  app.post(
    '/auth/email/login',
    {
      config: {
        // Pre-auth, IP-keyed. 5/min throttles credential-stuffing
        // floods. Legitimate retries (typo'd password) easily fit;
        // a botnet rotating proxies still hits the global 300/min/IP
        // before getting deep into a wordlist.
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
    const body = emailLoginSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    const emailLower = body.data.email.toLowerCase();
    const result = await query<{ id: string; email_hash: string | null }>(
      `SELECT id, email_hash FROM users WHERE email = $1 AND auth_method = 'email'`,
      [emailLower],
    );
    if (result.rows.length === 0 || !result.rows[0]!.email_hash) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const ok = await bcrypt.compare(body.data.password, result.rows[0]!.email_hash);
    if (!ok) return reply.code(401).send({ error: 'invalid_credentials' });

    const userId = result.rows[0]!.id;
    await query(`UPDATE users SET last_seen_at = NOW() WHERE id = $1`, [userId]);
    void track('user_signed_in', { userId, properties: { method: 'email' } });
    const tier = await currentTier(userId);
    const token = await signAppJwt({ sub: userId, auth_method: 'email', tier });
    return reply.send({ token, user_id: userId, tier });
  });

  // Guest / anonymous sign-in removed 2026-04-17. AegisDial is a paid
  // subscription-only product — any unauthenticated or non-paying caller is
  // rejected by requireProTier (HTTP 402).

  app.get(
    '/auth/me',
    { preHandler: [requireAppUser] },
    async (req, reply) => {
      const user = req.appUser!;
      const result = await query<{
        id: string;
        auth_method: string;
        email: string | null;
        display_name: string | null;
        tier: string;
        created_at: Date;
      }>(
        `SELECT id, auth_method, email, display_name, tier, created_at
         FROM users WHERE id = $1`,
        [user.id],
      );
      if (result.rows.length === 0) return reply.code(404).send({ error: 'not_found' });
      return reply.send(result.rows[0]);
    },
  );

  // PATCH /v1/users/me — partial profile update.
  //
  // Today this is the "onboarding captures the user's own E.164 so the
  // R20 named-guardian check + SMS escalator can resolve them by phone"
  // endpoint. iOS PATCHes after the onboarding phone screen; until it
  // does, both downstream features run safely but as no-ops.
  //
  // `phone_number` is normalized server-side via libphonenumber (E.164,
  // US default). `null` clears the column. Invalid input returns 400
  // `invalid_phone` rather than silently dropping the field — we'd
  // rather the client re-prompt than pretend the save worked.
  //
  // Rate limit: 10/hr/user. Enough for the normal retry-a-typo pattern,
  // tight enough that a stolen JWT can't enumerate numbers.
  const patchMeSchema = z.object({
    phone_number: z.union([z.string().min(3).max(32), z.null()]).optional(),
    display_name: z.string().max(120).optional(),
  });
  app.patch(
    '/v1/users/me',
    {
      preHandler: [requireAppUser],
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 hour',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = patchMeSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      let phoneE164: string | null | undefined = undefined;
      if (parsed.data.phone_number !== undefined) {
        if (parsed.data.phone_number === null) {
          phoneE164 = null;
        } else {
          const normalized = normalizeE164(parsed.data.phone_number);
          if (!normalized) {
            return reply.code(400).send({ error: 'invalid_phone' });
          }
          phoneE164 = normalized;
        }
      }

      // Build a single UPDATE instead of one-per-field so a combined
      // patch is atomic and we take one row lock. Only touch columns
      // the client explicitly included — undefined means "don't set".
      const sets: string[] = [];
      const params: unknown[] = [];
      if (phoneE164 !== undefined) {
        params.push(phoneE164);
        sets.push(`phone_number = $${params.length}`);
      }
      if (parsed.data.display_name !== undefined) {
        params.push(parsed.data.display_name);
        sets.push(`display_name = $${params.length}`);
      }
      if (sets.length === 0) {
        // No updatable fields supplied. Echo current phone_number so
        // the client can reconcile without a second round-trip.
        const row = await query<{ phone_number: string | null }>(
          `SELECT phone_number FROM users WHERE id = $1`,
          [user.id],
        );
        return reply.send({
          ok: true,
          phone_number: row.rows[0]?.phone_number ?? null,
        });
      }

      params.push(user.id);
      try {
        const result = await query<{ phone_number: string | null }>(
          `UPDATE users SET ${sets.join(', ')}
            WHERE id = $${params.length}
            RETURNING phone_number`,
          params,
        );
        if (result.rows.length === 0) {
          return reply.code(404).send({ error: 'not_found' });
        }
        return reply.send({
          ok: true,
          phone_number: result.rows[0]!.phone_number ?? null,
        });
      } catch (err) {
        // 23505 = unique_violation. The only UNIQUE index on users that
        // this UPDATE can hit is `uq_users_phone_number` (migration 039).
        // Returning a distinct 409 lets iOS render "This phone is already
        // used by another AegisDial account" instead of a generic error.
        // Caller trying to save their OWN existing value isn't affected
        // because the UPDATE is a no-op on identical value.
        if ((err as { code?: string }).code === '23505') {
          return reply.code(409).send({ error: 'phone_already_in_use' });
        }
        throw err;
      }
    },
  );

  // GDPR Art. 20 + CCPA §1798.110 data export. Returns a JSON dump of
  // every row we hold that references this user. Biometric-gated on the
  // client (FaceID/TouchID) before the download is surfaced. Decrypts
  // envelope-encrypted columns (breach monitors, recovery evidence) so
  // the export contains the user's actual data, not ciphertext.
  //
  // Rate-limited to 3 exports per hour — a scripted loop shouldn't be
  // able to hammer this for DB load.
  app.get(
    '/v1/users/me/export',
    {
      preHandler: [requireAppUser],
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 hour',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      const { readMaybeEncrypted, readMaybeEncryptedJSON, decryptInt } = await import('../lib/crypto.js');

      // Pull from every table that holds user data. If a table doesn't
      // exist on this deploy the query throws — we swallow and record
      // the error per-section so a half-rolled-out schema still yields
      // a usable export.
      async function pull<T extends Record<string, unknown>>(
        sql: string,
      ): Promise<T[] | { error: string }> {
        try {
          const r = await query<T>(sql, [user.id]);
          return r.rows;
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }

      const [
        profile, subscriptions, familyContacts, familyMembership,
        callSessions, transcriptEvents, smsClassifications, smsScans,
        emailAccounts, emailScans, emailCompromiseReports, emailTamperAlerts,
        monitoredIdentifiers, breachAlerts,
        recoverySessions, recoveryEvidence,
        recoveryOutcomes, recoveryCompanionMessages,
        guardianAlerts,
        supportTickets, deviceTokens, emailMessages,
      ] = await Promise.all([
        pull<Record<string, unknown>>(
          `SELECT id, email, display_name, tier, created_at,
                  apple_sub, auth_method, dob_year
             FROM users WHERE id = $1`,
        ),
        pull(
          `SELECT id, provider, provider_product_id, status,
                  current_period_start, current_period_end, auto_renew,
                  created_at, updated_at
             FROM subscriptions WHERE user_id = $1`,
        ),
        pull(`SELECT * FROM family_contacts WHERE user_id = $1`),
        // family membership: either a member on a plan, or the owner of a plan
        // (or both). Return the user's membership row plus basic plan metadata.
        pull(
          `SELECT fm.family_plan_id, fm.user_id, fm.role, fm.label, fm.added_at,
                  fp.owner_user_id, fp.included_lines, fp.addon_lines
             FROM family_members fm
             JOIN family_plans fp ON fp.id = fm.family_plan_id
            WHERE fm.user_id = $1 OR fp.owner_user_id = $1`,
        ),
        pull(`SELECT * FROM call_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 5000`),
        // transcript_events has no user_id; it joins via session_id →
        // call_sessions.user_id. received_at is the ordering column.
        pull<{
          id: string; session_id: string; seq: number; speaker: string;
          text: string | null; text_ct: string | null; confidence: number | null;
          received_at: Date;
        }>(
          `SELECT t.id, t.session_id, t.seq, t.speaker, t.text, t.text_ct,
                  t.confidence, t.received_at
             FROM transcript_events t
             JOIN call_sessions s ON s.id = t.session_id
            WHERE s.user_id = $1
            ORDER BY t.received_at DESC
            LIMIT 10000`,
        ),
        pull(`SELECT * FROM sms_classifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5000`),
        // SMS Shield manual-paste scans. Stored as sha256(body) +
        // digit-redacted 80-char excerpt — never plaintext. Exporting
        // these closes the GDPR Art. 20 gap: a user asking "give me a
        // copy of every row AegisDial stores about me" should see their
        // SMS Shield activity, not just call history.
        pull(
          `SELECT id, body_sha256, body_excerpt, sender_e164, fraud_score,
                  verdict, triggered_categories, reasons, url_findings,
                  source, scanned_at
             FROM sms_scans WHERE user_id = $1
             ORDER BY scanned_at DESC LIMIT 5000`,
        ),
        // Email Shield — linked-account registry. OAuth/app-password
        // ciphertext is EXCLUDED from the export by design: it lets
        // the user see what's linked and when, but exporting
        // tokens-on-paper is a phishing-surface gift (an attacker who
        // got the export PDF would get persistent inbox read access).
        // Tokens stay envelope-encrypted at rest only.
        pull(
          `SELECT id, provider, provider_account_id, display_email,
                  status, last_poll_at, created_at, updated_at
             FROM email_accounts WHERE user_id = $1
             ORDER BY created_at DESC`,
        ),
        // Email Shield — per-message scan history. Same posture as
        // sms_scans: no body at rest, only subject_excerpt +
        // from_address_hash + sender_domain. Safe to export as-is.
        pull(
          `SELECT id, email_account_id, external_message_id,
                  from_address_hash, sender_domain, subject_excerpt,
                  fraud_score, verdict, triggered_categories, reasons,
                  url_findings, attachment_findings, scanned_at
             FROM email_scans WHERE user_id = $1
             ORDER BY scanned_at DESC LIMIT 5000`,
        ),
        // Email Shield — compromise-check reports. Findings are
        // descriptive (rule action types, app names, breach domain
        // names) — never raw payloads — so safe to export as-is.
        pull(
          `SELECT id, email_account_id, overall_verdict, findings,
                  generated_at
             FROM email_compromise_reports WHERE user_id = $1
             ORDER BY generated_at DESC LIMIT 500`,
        ),
        // Email Shield — inbox-tamper alerts ("did you delete this?"
        // pushes the user responded to or let expire). subject_excerpt
        // was already digit-redacted at scan-time; sender_domain is
        // eTLD+1 plaintext. Safe to export as-is — no PII beyond what
        // already lives on email_scans.
        pull(
          `SELECT id, email_account_id, scan_id, sender_domain,
                  subject_excerpt, delete_after_seconds, status,
                  responded_at, created_at
             FROM email_tamper_alerts WHERE user_id = $1
             ORDER BY created_at DESC LIMIT 500`,
        ),
        pull<{
          id: string; kind: string; display_value: string; display_value_ct: string | null;
          last_scanned_at: Date | null; last_scan_exposure_count: number; created_at: Date;
        }>(
          `SELECT id, kind, display_value, display_value_ct, last_scanned_at,
                  last_scan_exposure_count, created_at
             FROM monitored_identifiers WHERE user_id = $1`,
        ),
        pull(`SELECT * FROM breach_alerts WHERE user_id = $1`),
        // recovery_sessions — explicitly enumerate columns and include every
        // _ct for in-app decryption. SELECT * would leak ciphertext to the
        // user's own export (confusing) and risk exposing future internal
        // columns we haven't reviewed for export-safety.
        pull<{
          id: string; scam_type: string; status: string; mode: string;
          resolved_as: string | null; resolved_at: Date | null;
          started_at: Date; completed_at: Date | null; updated_at: Date;
          scam_e164: string | null; scam_e164_ct: string | null;
          description: string | null; description_ct: string | null;
          amount_lost_cents: number | null; amount_lost_cents_ct: string | null;
          family_plan_id: string | null; named_guardian_user_id: string | null;
        }>(
          `SELECT id, scam_type, status, mode, resolved_as, resolved_at,
                  started_at, completed_at, updated_at,
                  scam_e164, scam_e164_ct,
                  description, description_ct,
                  amount_lost_cents, amount_lost_cents_ct,
                  family_plan_id, named_guardian_user_id
             FROM recovery_sessions WHERE user_id = $1
             ORDER BY started_at DESC`,
        ),
        pull<{
          id: string; session_id: string; kind: string; payload: unknown;
          payload_ct: string | null; created_at: Date;
        }>(
          `SELECT id, session_id, kind, payload, payload_ct, created_at
             FROM recovery_evidence WHERE user_id = $1`,
        ),
        // recovery_outcomes — the flywheel data. Contains notes, step
        // feedback, and the victim's recovered-amount. Encrypted fields
        // are decrypted below.
        pull<{
          id: string; session_id: string; recovered_any: boolean | null;
          recovered_cents: number | null; recovered_cents_ct: string | null;
          notes: string | null; notes_ct: string | null;
          step_feedback_ct: string | null;
          mood_before: number | null; mood_after: number | null;
          told_family: boolean | null; reported_to_police: boolean | null;
          created_at: Date; updated_at: Date;
        }>(
          `SELECT id, session_id, recovered_any, recovered_cents, recovered_cents_ct,
                  notes, notes_ct, step_feedback_ct, mood_before, mood_after,
                  told_family, reported_to_police, created_at, updated_at
             FROM recovery_outcomes WHERE user_id = $1`,
        ),
        // recovery_companion_messages — the victim's private conversations
        // with the AI. Highest-sensitivity text in the system. Decrypted
        // before export (user asked for a copy of their own data).
        pull<{
          id: string; session_id: string; role: string;
          content: string | null; content_ct: string | null;
          crisis_detected: boolean; created_at: Date;
        }>(
          `SELECT id, session_id, role, content, content_ct,
                  crisis_detected, created_at
             FROM recovery_companion_messages WHERE user_id = $1
             ORDER BY created_at ASC`,
        ),
        // guardian_links does NOT exist as a table — the original export
        // query hallucinated it. All guardian relationships are derived
        // from family_members + family_plans (covered by familyMembership
        // above), so there's no separate guardian-link table to export.
        pull(`SELECT * FROM guardian_alerts WHERE subject_user_id = $1 OR guardian_user_id = $1`),
        pull<{
          id: string; subject: string | null; subject_ct: string | null;
          body: string | null; body_ct: string | null; category: string;
          status: string; created_at: Date;
        }>(`SELECT id, subject, subject_ct, body, body_ct, category, status, created_at
              FROM support_tickets WHERE user_id = $1`),
        // device_tokens has apns_token + environment, not device_token + platform.
        pull(`SELECT id, apns_token, environment, created_at, last_seen_at, invalidated_at
                FROM device_tokens WHERE user_id = $1`),
        pull(`SELECT * FROM email_messages WHERE user_id = $1`),
      ]);

      // Decrypt envelope-encrypted columns in place.
      const monitoredDecrypted = Array.isArray(monitoredIdentifiers)
        ? monitoredIdentifiers.map((r) => ({
            ...r,
            display_value: readMaybeEncrypted(r.display_value_ct) ?? r.display_value,
            display_value_ct: undefined,
          }))
        : monitoredIdentifiers;

      const evidenceDecrypted = Array.isArray(recoveryEvidence)
        ? recoveryEvidence.map((r) => ({
            ...r,
            payload: r.payload_ct
              ? readMaybeEncryptedJSON(r.payload_ct)
              : r.payload,
            payload_ct: undefined,
          }))
        : recoveryEvidence;

      const transcriptsDecrypted = Array.isArray(transcriptEvents)
        ? transcriptEvents.map((r) => ({
            ...r,
            text: readMaybeEncrypted(r.text_ct) ?? r.text,
            text_ct: undefined,
          }))
        : transcriptEvents;

      const supportDecrypted = Array.isArray(supportTickets)
        ? supportTickets.map((r) => ({
            ...r,
            subject: readMaybeEncrypted(r.subject_ct) ?? r.subject,
            body: readMaybeEncrypted(r.body_ct) ?? r.body,
            subject_ct: undefined,
            body_ct: undefined,
          }))
        : supportTickets;

      const sessionsDecrypted = Array.isArray(recoverySessions)
        ? recoverySessions.map((r) => ({
            ...r,
            scam_e164: readMaybeEncrypted(r.scam_e164_ct) || r.scam_e164 || null,
            description: readMaybeEncrypted(r.description_ct) || r.description || null,
            amount_lost_cents:
              decryptInt(r.amount_lost_cents_ct ?? null) ?? r.amount_lost_cents ?? null,
            scam_e164_ct: undefined,
            description_ct: undefined,
            amount_lost_cents_ct: undefined,
          }))
        : recoverySessions;

      const outcomesDecrypted = Array.isArray(recoveryOutcomes)
        ? recoveryOutcomes.map((r) => ({
            ...r,
            notes: readMaybeEncrypted(r.notes_ct) || r.notes || null,
            step_feedback: r.step_feedback_ct
              ? readMaybeEncryptedJSON(r.step_feedback_ct)
              : null,
            recovered_cents:
              decryptInt(r.recovered_cents_ct ?? null) ?? r.recovered_cents ?? null,
            notes_ct: undefined,
            recovered_cents_ct: undefined,
            step_feedback_ct: undefined,
          }))
        : recoveryOutcomes;

      const companionDecrypted = Array.isArray(recoveryCompanionMessages)
        ? recoveryCompanionMessages.map((r) => ({
            ...r,
            content: readMaybeEncrypted(r.content_ct) ?? r.content ?? '',
            content_ct: undefined,
          }))
        : recoveryCompanionMessages;

      void track('user_exported_data', { userId: user.id });

      reply.header(
        'Content-Disposition',
        `attachment; filename="aegisdial-export-${user.id}.json"`,
      );
      return reply.send({
        schema_version: 1,
        generated_at: new Date().toISOString(),
        user_id: user.id,
        notice:
          'This is a full copy of every row AegisDial stores that references your account. Values were decrypted from at-rest ciphertext before export. Keep this file private.',
        profile,
        subscriptions,
        family_contacts: familyContacts,
        family_membership: familyMembership,
        call_sessions: callSessions,
        transcript_events: transcriptsDecrypted,
        sms_classifications: smsClassifications,
        sms_scans: smsScans,
        email_accounts: emailAccounts,
        email_scans: emailScans,
        email_compromise_reports: emailCompromiseReports,
        email_tamper_alerts: emailTamperAlerts,
        monitored_identifiers: monitoredDecrypted,
        breach_alerts: breachAlerts,
        recovery_sessions: sessionsDecrypted,
        recovery_evidence: evidenceDecrypted,
        recovery_outcomes: outcomesDecrypted,
        recovery_companion_messages: companionDecrypted,
        guardian_alerts: guardianAlerts,
        support_tickets: supportDecrypted,
        device_tokens: deviceTokens,
        email_messages: emailMessages,
      });
    },
  );

  // Account deletion. App Store guideline 5.1.1(v) requires this to be
  // reachable in-app. We CASCADE-delete — every feature table
  // (call_sessions, family_contacts, breach_alerts, guardian_alerts,
  // subscriptions, etc.) references users(id) with ON DELETE CASCADE,
  // so a single DELETE wipes the user's entire footprint.
  //
  // Type-to-confirm guard: client must send {confirm: "DELETE"} in the
  // body. Keeps accidental API hits from nuking accounts.
  app.delete(
    '/v1/users/me',
    { preHandler: [requireAppUser] },
    async (req, reply) => {
      const user = req.appUser!;
      const body = z
        .object({ confirm: z.literal('DELETE') })
        .safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({
          error: 'confirm_required',
          message: 'Send {"confirm":"DELETE"} to proceed.',
        });
      }

      // Capture email for a last-minute confirmation email BEFORE we
      // cascade the row away.
      const row = await query<{ email: string | null; display_name: string | null }>(
        `SELECT email, display_name FROM users WHERE id = $1`,
        [user.id],
      );
      const email = row.rows[0]?.email ?? null;
      const displayName = row.rows[0]?.display_name ?? null;

      await query(`DELETE FROM users WHERE id = $1`, [user.id]);

      void track('user_deleted_account', {
        userId: user.id,
        properties: { had_email: !!email },
      });

      if (email) {
        // Fire-and-forget — confirmation that the account is gone.
        void sendEmail({
          userId: null, // the user row is gone now
          to: email,
          template: 'account_deleted',
          data: { display_name: displayName },
        });
      }

      return reply.send({ deleted: true });
    },
  );
}
