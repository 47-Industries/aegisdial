import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, withTx } from '../lib/db.js';
import { requireAppUser, requireProTier, optionalAppUser } from '../lib/auth.js';
import { normalizeE164 } from '../lib/phone.js';
import { stepsForScamType, type ScamType } from '../lib/recoverySteps.js';
import { resolveRecoveryPreload } from '../services/v4RecoveryPreload.js';
import { emitGuardianAlert } from '../services/guardianAlerts.js';
import { track } from '../lib/analytics.js';
import { trackRecoveryCompleted } from '../lib/internalEvents.js';
import {
  encryptJSON,
  readMaybeEncryptedJSON,
  encryptString,
  readMaybeEncrypted,
  encryptInt,
  decryptInt,
} from '../lib/crypto.js';
import {
  generateFtcReport,
  generateIc3Report,
  type EvidenceItem,
  type ReportContext,
} from '../services/reportGenerator.js';
import {
  generateCompanionReply,
  type CompanionMessage,
  type CompanionSessionContext,
} from '../services/recoveryCompanion.js';
import { describeScamType } from '../lib/scamTypeDescriptions.js';
import { analyzeText } from '../services/textAnalyzer.js';
import { redis } from '../lib/cache.js';

// Recovery Concierge endpoints. Wired for the "I just got scammed — what
// do I do?" moment. Kyle's positioning: we stop more loss than insurance
// pays out by guiding the first 15 minutes of recovery. These endpoints
// are the server side of that experience; the iOS app renders the steps.

const START_SCHEMA = z.object({
  scam_number: z.string().optional(),
  // SMS Shield → Recovery handoff. If the user scanned a text that came
  // back fraud/suspicious and taps "I got scammed by this", the iOS app
  // passes the sms_scans.id here. We hydrate scam_number from the scan's
  // sender_e164 and stitch the scan's body_excerpt into the description
  // (still envelope-encrypted at rest). User-supplied scam_number /
  // description win over hydrated values if both are present.
  sms_scan_id: z.string().uuid().optional(),
  // Email Shield → Recovery handoff. Mirrors the sms_scan_id pattern:
  // when a user opens the compromise-check or scan-detail screen on a
  // 'fraud' / 'suspicious' verdict and taps "I got scammed by this",
  // iOS passes the email_scans.id. We hydrate description with the
  // sender_domain + subject_excerpt (already digit-redacted at scan
  // time — no plaintext PII surfaces). Ownership enforced via
  // WHERE user_id = $2 — leaked UUIDs can't open cross-user sessions.
  email_scan_id: z.string().uuid().optional(),
  scam_type: z
    .enum([
      // Impersonation
      'bank_impersonation', 'irs_impersonation', 'irs_refund_bait',
      'ssa_impersonation', 'law_enforcement_impersonation',
      'fbi_dea_impersonation', 'uscis_ice_impersonation', 'digital_arrest',
      'medicare_impersonation', 'medicare_advantage_switch', 'utility_shutoff',
      // Tech / credential theft
      'tech_support', 'fake_refund_scam', 'apple_icloud_locked',
      'google_account_takeover', 'sim_swap_port_out',
      'banking_app_push_bombing', 'quishing_qr_phishing',
      'clickfix_malware', 'brokerage_401k_phishing',
      // Bank / financial impersonation
      'bank_employee_impersonation',
      // Emotional family
      'parent_teacher_spoof',
      // Crypto exchange spoof
      'coinbase_support_spoof',
      // Emotional
      'grandchild_emergency', 'ai_voice_clone_family', 'virtual_kidnapping',
      'sextortion', 'romance_scam', 'pig_butchering',
      // Financial
      'zelle_venmo_support_scam', 'bitcoin_atm_scam', 'gift_card_scam',
      'investment_scam', 'crypto_scam', 'debt_collection_phantom',
      'car_warranty_expiration', 'home_warranty_scam', 'subscription_trap',
      'advance_fee_inheritance', 'lottery_sweepstakes',
      // Services / property
      'employment_scam', 'rental_scam', 'timeshare_resale',
      'solar_panel_scam', 'moving_company_hostage',
      'home_repair_storm_chaser', 'funeral_cremation_scam', 'pet_scam',
      // Health / benefits / education
      'student_loan_forgiveness', 'veterans_benefits_buyout',
      'affordable_care_act_scam', 'tax_prep_identity_theft',
      // Civic / seasonal
      'charity_scam', 'political_donation_scam_pac',
      'census_survey_scam', 'fema_disaster_relief_fraud',
      // Text / smishing
      'package_redelivery', 'unpaid_toll',
      // Re-victimization
      'recovery_scam_secondary',
      'generic',
      // Legacy aliases accepted
      'romance', 'investment',
    ])
    .optional(),
  amount_lost_usd: z.number().nonnegative().optional(),
  description: z.string().max(2000).optional(),
  named_guardian_user_id: z.string().uuid().optional(),
});

const COMPANION_MSG_SCHEMA = z.object({
  message: z.string().min(1).max(2000),
});

const QUICK_COMPANION_SCHEMA = z.object({
  message: z.string().min(1).max(2000),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(2000) }))
    .max(24)
    .default([]),
});

const TRIAGE_START_SCHEMA = z.object({
  scam_number: z.string().optional(),
  description: z.string().max(2000).optional(),
});

const TRIAGE_RESOLVE_SCHEMA = z
  .object({
    resolved_as: z.enum([
      'scam_confirmed_no_loss',
      'converted_to_recovery',
      'not_a_scam',
      'unclear',
    ]),
    // Required when converting. The same enum as START_SCHEMA's scam_type.
    scam_type: z.string().optional(),
    amount_lost_usd: z.number().nonnegative().optional(),
    named_guardian_user_id: z.string().uuid().optional(),
  })
  .refine(
    (d) => d.resolved_as !== 'converted_to_recovery' || !!d.scam_type,
    { message: 'scam_type required when converting to recovery', path: ['scam_type'] },
  );

const ANALYZE_TEXT_SCHEMA = z.object({
  text: z.string().min(1).max(4000),
  sender: z.string().max(200).optional(),
  // Stable anonymous ID the iOS app keeps in Keychain so we can stitch
  // pre-signup analyzer usage to the eventual user_id. Optional — older
  // clients won't send it, signed-in users don't need it.
  anonymous_id: z.string().min(8).max(120).optional(),
});

const OUTCOME_SCHEMA = z.object({
  recovered_any: z.boolean().optional(),
  recovered_cents: z.number().int().nonnegative().optional(),
  notes: z.string().max(4000).optional(),
  step_feedback: z.record(
    z.string(),
    z.object({ helpful: z.boolean(), note: z.string().max(500).optional() }),
  ).optional(),
  mood_before: z.number().int().min(1).max(5).optional(),
  mood_after: z.number().int().min(1).max(5).optional(),
  told_family: z.boolean().optional(),
  reported_to_police: z.boolean().optional(),
});

const COMPLETE_STEP_SCHEMA = z.object({
  status: z.enum(['completed', 'skipped', 'in_progress']),
});

const EVIDENCE_ADD_SCHEMA = z.object({
  kind: z.enum(['note', 'amount', 'photo', 'phone', 'wallet', 'account', 'transaction']),
  payload: z.record(z.string(), z.unknown()),
});

// Process-level circuit breaker for LLM-backed endpoints. Guards against a
// runaway cost scenario (compromised JWT, bot farm, stuck client loop)
// by bounding the number of LLM-powered requests per minute per server
// instance. Fly runs multiple instances; this is per-instance and
// deliberately conservative — under normal load we're far below the cap.
const LLM_BUDGET_PER_MIN = 600;           // 10/s/instance sustained
const llmBudgetWindow = { start: 0, count: 0 };
function llmBudgetGuard(
  _req: { ip?: string; appUser?: { id: string } },
  reply: { code: (s: number) => { send: (body: unknown) => unknown } },
  done: (err?: Error) => void,
) {
  const now = Date.now();
  // Sliding 60s window — reset on minute boundary.
  if (now - llmBudgetWindow.start > 60_000) {
    llmBudgetWindow.start = now;
    llmBudgetWindow.count = 0;
  }
  llmBudgetWindow.count++;
  if (llmBudgetWindow.count > LLM_BUDGET_PER_MIN) {
    reply.code(503).send({
      error: 'llm_budget_exhausted',
      message: 'Too many AI requests right now. Try again in a minute.',
    });
    return;
  }
  done();
}

export async function recoveryRoutes(app: FastifyInstance): Promise<void> {
  // Start a new recovery session. Freezes the step template at creation
  // time so the user's flow is stable even if we update the catalog later.
  app.post(
    '/v1/recovery/start',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const body = START_SCHEMA.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

      // SMS Shield handoff. If the iOS app passed sms_scan_id, look up
      // the scan to backfill scam_number + description. The scan must
      // belong to THIS user — never cross-user (a leaked scan UUID
      // shouldn't open a recovery session against someone else's record).
      // User-supplied values win; the scan is a hint, not an override.
      let smsScanSender: string | null = null;
      let smsScanExcerpt: string | null = null;
      if (body.data.sms_scan_id) {
        const scanRes = await query<{
          sender_e164: string | null;
          body_excerpt: string;
        }>(
          `SELECT sender_e164, body_excerpt
             FROM sms_scans WHERE id = $1 AND user_id = $2`,
          [body.data.sms_scan_id, user.id],
        );
        if (scanRes.rowCount === 0) {
          return reply.code(404).send({ error: 'sms_scan_not_found' });
        }
        smsScanSender = scanRes.rows[0]!.sender_e164;
        smsScanExcerpt = scanRes.rows[0]!.body_excerpt;
        // verdict deliberately NOT gated — a user who self-identifies
        // as a victim wins over a 'safe' verdict. Disagreement-with-
        // model is fine; what matters is the user wants recovery
        // guidance now. Track as analytics signal if desired later.
      }

      // Email Shield handoff. Mirrors the SMS path: lookup is scoped
      // to (id, user_id) so a leaked UUID can't open a cross-user
      // recovery session. sender_domain + subject_excerpt are already
      // sanitized (eTLD+1 only, digit-redacted excerpt) per migration
      // 058, so stitching them into a recovery description doesn't
      // leak anything beyond what's already in email_scans.
      let emailScanSender: string | null = null;
      let emailScanSubject: string | null = null;
      if (body.data.email_scan_id) {
        const scanRes = await query<{
          sender_domain: string;
          subject_excerpt: string;
        }>(
          `SELECT sender_domain, subject_excerpt
             FROM email_scans WHERE id = $1 AND user_id = $2`,
          [body.data.email_scan_id, user.id],
        );
        if (scanRes.rowCount === 0) {
          return reply.code(404).send({ error: 'email_scan_not_found' });
        }
        emailScanSender = scanRes.rows[0]!.sender_domain;
        emailScanSubject = scanRes.rows[0]!.subject_excerpt;
      }

      const scamE164 = body.data.scam_number
        ? normalizeE164(body.data.scam_number)
        : smsScanSender
          ? normalizeE164(smsScanSender)
          : null;
      const scamType: ScamType = body.data.scam_type ?? 'generic';
      const amountCents = body.data.amount_lost_usd
        ? Math.round(body.data.amount_lost_usd * 100)
        : null;
      // Description: user-supplied wins; otherwise stitch the redacted
      // SMS or Email excerpt with a "from {Shield} scan" prefix so the
      // recovery session reads like a coherent incident note.
      // body_excerpt / subject_excerpt are capped at insert time — we
      // append an ellipsis when at the cap so users see "...message
      // ended here…" instead of a hard truncation. Precedence:
      // explicit description → SMS scan excerpt → Email scan excerpt
      // (SMS wins on the rare both-passed-at-once case since the
      // SMS-Shield flow has been live longer and has richer context).
      const EXCERPT_CAP = 80;
      let description: string | undefined;
      if (body.data.description) {
        description = body.data.description;
      } else if (smsScanExcerpt) {
        description = `Reported via SMS Shield. Message excerpt: "${smsScanExcerpt}${smsScanExcerpt.length >= EXCERPT_CAP ? '…' : ''}"`;
      } else if (emailScanSubject) {
        // sender_domain is already eTLD+1; subject_excerpt is already
        // digit-redacted. Safe to include verbatim.
        const subjectTail = emailScanSubject.length >= EXCERPT_CAP ? '…' : '';
        description = emailScanSender
          ? `Reported via Email Shield. Sender: ${emailScanSender}. Subject: "${emailScanSubject}${subjectTail}"`
          : `Reported via Email Shield. Subject: "${emailScanSubject}${subjectTail}"`;
      }

      // Does the user have a family plan? Steps include a "notify family"
      // entry when they do.
      const familyPlan = await query<{ id: string }>(
        `SELECT family_plan_id AS id FROM family_members WHERE user_id = $1`,
        [user.id],
      );
      const familyPlanId = familyPlan.rows[0]?.id ?? null;

      // R20 — If a named_guardian_user_id is supplied, verify that user
      // actually has guardian role for the caller BEFORE we open the
      // tx. "Guardian role" = the caller has a family_contacts row with
      // is_guardian=TRUE whose phone_e164 matches the named user's
      // users.phone_number. Reject with 400 not_a_guardian otherwise so
      // a client can't quietly escalate-push a random plan member.
      if (body.data.named_guardian_user_id) {
        const ok = await isNamedGuardian(user.id, body.data.named_guardian_user_id);
        if (!ok) return reply.code(400).send({ error: 'not_a_guardian' });
      }

      // Session is brand-new so we're always inside the 24hr window on
      // the first step-list build. Hoisting kicks in when the user
      // reports money lost; otherwise the natural "stop the call →
      // freezes → reports" ordering stays.
      const templates = stepsForScamType(scamType, familyPlanId !== null, {
        amountLost: (amountCents ?? 0) > 0,
        withinTimeWindow: true,
      });

      const session = await withTx(async (client) => {
        // scam_e164 + description stored only as ciphertext; the plaintext
        // columns are kept empty-string placeholders so legacy readers
        // don't NPE. scam_type + amount_lost_cents remain plaintext —
        // they're non-identifying and needed for step selection.
        // If a named guardian was passed, verify they're on the user's
        // family plan before trusting the UUID (protects against spoofed
        // guardian-alert fan-out).
        let namedGuardianId: string | null = null;
        if (body.data.named_guardian_user_id) {
          const guardianCheck = await client.query<{ user_id: string }>(
            `SELECT fm.user_id FROM family_members fm
               JOIN family_plans fp ON fp.id = fm.family_plan_id
              WHERE fm.user_id = $1
                AND (fp.owner_user_id = $2 OR fp.id IN (
                  SELECT family_plan_id FROM family_members WHERE user_id = $2
                ))`,
            [body.data.named_guardian_user_id, user.id],
          );
          if (guardianCheck.rows.length > 0) {
            namedGuardianId = body.data.named_guardian_user_id;
          }
        }

        // amount_lost_cents left NULL; real value goes in encrypted
        // amount_lost_cents_ct. Aggregate consumers (bulk crime reporter,
        // outcomes analytics) decrypt per-row.
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO recovery_sessions (
             user_id, family_plan_id, scam_e164, scam_e164_ct, scam_type,
             amount_lost_cents, amount_lost_cents_ct,
             description, description_ct,
             named_guardian_user_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            user.id,
            familyPlanId,
            '',
            scamE164 ? encryptString(scamE164) : null,
            scamType,
            null,
            encryptInt(amountCents),
            '',
            description ? encryptString(description) : null,
            namedGuardianId,
          ],
        );
        const sessionId = inserted.rows[0]!.id;

        // Single multi-row INSERT for the step list. A typical playbook
        // is 10–20 steps; the old per-row loop was 10–20 serial RTTs
        // inside a transaction.
        if (templates.length > 0) {
          const stepValues: string[] = [];
          const stepParams: unknown[] = [];
          let p = 0;
          for (let i = 0; i < templates.length; i++) {
            const t = templates[i]!;
            stepValues.push(
              `($${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p})`,
            );
            stepParams.push(
              sessionId, t.step_key, i, t.title, t.body,
              t.cta_label ?? null, t.cta_url ?? null, t.phone_to_call ?? null,
            );
          }
          await client.query(
            `INSERT INTO recovery_steps (
               session_id, step_key, ordinal, title, body, cta_label, cta_url, phone_to_call
             ) VALUES ${stepValues.join(', ')}`,
            stepParams,
          );
        }
        return { sessionId, namedGuardianId };
      });
      const { sessionId: sessionUuid, namedGuardianId } = session;

      const payload = await loadSession(sessionUuid, user.id);
      void track('recovery_started', {
        userId: user.id,
        properties: {
          scam_type: scamType,
          has_scam_number: !!scamE164,
          amount_lost_cents: amountCents ?? 0,
        },
      });
      // Named-guardian path: if the user picked ONE specific person to
      // tell, send them a higher-urgency, first-person alert. Other plan
      // members still get the standard re-victimization heads-up.
      // (namedGuardianId already computed inside withTx — no re-SELECT.)

      if (namedGuardianId) {
        const userName = (
          await query<{ display_name: string | null }>(
            `SELECT display_name FROM users WHERE id = $1`,
            [user.id],
          )
        ).rows[0]?.display_name ?? 'A family member';
        void emitGuardianAlert({
          subjectUserId: user.id,
          kind: 'recovery_started',
          severity: 'critical',
          title: `${userName} needs help right now`,
          body:
            `${userName} just opened a recovery session after a scam call ` +
            `${scamType === 'generic' ? '' : `(${scamType.replace(/_/g, ' ')})`}. ` +
            `They picked you to tell first. Give them a call — they may be too shaken to reach out themselves.`,
          payload: {
            session_id: sessionUuid,
            scam_type: scamType,
            named_guardian: true,
            subject_display_name: userName,
          },
          onlyUserIds: [namedGuardianId],
        });
      }

      // Broadcast to everyone else on the plan. Exclude the named
      // guardian — they already got the higher-urgency first-person
      // alert above and we don't want them seeing two banners.
      void emitGuardianAlert({
        subjectUserId: user.id,
        kind: 'recovery_started',
        severity: 'warning',
        title: 'A family member was scammed — be extra alert',
        body:
          `Someone on your plan reported a scam call ` +
          `${scamType === 'generic' ? '' : `(${scamType.replace(/_/g, ' ')})`}. ` +
          `Scammers often re-target the same family within days. Verify any unexpected money request in person.`,
        payload: {
          session_id: sessionUuid,
          scam_type: scamType,
        },
        excludeUserIds: namedGuardianId ? [namedGuardianId] : undefined,
      });
      return reply.send(payload);
    },
  );

  // Poll the current state of a session. The iOS app calls this on each
  // step completion to get the fresh step list (we don't bother with
  // WebSockets at this scale).
  app.get(
    '/v1/recovery/:id',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      try {
        const payload = await loadSession(id, user.id);
        return reply.send(payload);
      } catch (err) {
        if (err instanceof NotFoundError) return reply.code(404).send({ error: 'session_not_found' });
        throw err;
      }
    },
  );

  // Get the user's active session (if any). Used by the iOS app to resume.
  app.get(
    '/v1/recovery/active',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const row = await query<{ id: string }>(
        `SELECT id FROM recovery_sessions
          WHERE user_id = $1 AND status = 'active'
          ORDER BY started_at DESC LIMIT 1`,
        [user.id],
      );
      if (row.rows.length === 0) return reply.send({ active: false });
      const payload = await loadSession(row.rows[0]!.id, user.id);
      return reply.send({ active: true, session: payload });
    },
  );

  // Mark a step completed / skipped / in_progress. If every step ends up
  // in {completed, skipped}, close the session.
  app.post(
    '/v1/recovery/:id/step/:step_key/status',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id, step_key } = req.params as { id: string; step_key: string };
      const body = COMPLETE_STEP_SCHEMA.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

      // Wrap the whole sequence — ownership check, step update, and
      // session auto-close — in a single transaction with SELECT ... FOR
      // UPDATE on the session row. Two concurrent completions on the last
      // open step could previously both observe "remaining == 0" and
      // rewrite completed_at on a session that's already closed; the row
      // lock forces them to serialize and the `status='active'` filter on
      // the close UPDATE means only the first one's timestamp wins.
      const outcome = await withTx(async (client) => {
        const owned = await client.query<{ status: string }>(
          `SELECT status FROM recovery_sessions
            WHERE id = $1 AND user_id = $2
            FOR UPDATE`,
          [id, user.id],
        );
        if (owned.rows.length === 0) return { kind: 'session_not_found' as const };

        const result = await client.query(
          `UPDATE recovery_steps
              SET status = $3,
                  completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE completed_at END
            WHERE session_id = $1 AND step_key = $2`,
          [id, step_key, body.data.status],
        );
        if (result.rowCount === 0) return { kind: 'step_not_found' as const };

        const remaining = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM recovery_steps
            WHERE session_id = $1 AND status NOT IN ('completed', 'skipped')`,
          [id],
        );
        let justCompleted: {
          scamType: string | null;
          amountLostCents: number | null;
          durationSeconds: number | null;
        } | null = null;
        if (Number(remaining.rows[0]!.count) === 0) {
          // `AND status='active'` — re-completing a step on an already
          // closed session (abandoned, completed) must not rewrite
          // completed_at. The original win time is the one that matters
          // for analytics and the 24-hr recovery window.
          const closeRes = await client.query<{
            scam_type: string | null;
            amount_lost_cents: number | null;
            duration_seconds: number | null;
          }>(
            `UPDATE recovery_sessions
                SET status = 'completed', completed_at = NOW(), updated_at = NOW()
              WHERE id = $1 AND status = 'active'
            RETURNING scam_type, amount_lost_cents,
                      EXTRACT(EPOCH FROM (NOW() - started_at))::INT AS duration_seconds`,
            [id],
          );
          // rowCount > 0 only when the row was actually 'active' before —
          // re-completing a step on an already-closed session no-ops here
          // and we DON'T fire the event (would double-count).
          if (closeRes.rowCount && closeRes.rows[0]) {
            const r = closeRes.rows[0];
            justCompleted = {
              scamType: r.scam_type,
              amountLostCents: r.amount_lost_cents,
              durationSeconds: r.duration_seconds,
            };
          }
        } else if (body.data.status === 'in_progress') {
          // Undo path: the user reset a previously-completed step on a
          // session that had auto-closed. Reopen the session so the
          // iOS UI reflects that the plan is active again; clearing
          // completed_at is safe because the user explicitly reopened.
          // Without this, the iOS completion footer keeps rendering and
          // the tap feels silently broken.
          await client.query(
            `UPDATE recovery_sessions
                SET status = 'active', completed_at = NULL, updated_at = NOW()
              WHERE id = $1 AND status = 'completed'`,
            [id],
          );
          await client.query(
            `UPDATE recovery_sessions SET updated_at = NOW() WHERE id = $1`,
            [id],
          );
        } else {
          await client.query(
            `UPDATE recovery_sessions SET updated_at = NOW() WHERE id = $1`,
            [id],
          );
        }
        return { kind: 'ok' as const, justCompleted };
      });

      // Founder-dashboard signal — fires only on the active→completed
      // transition (justCompleted is null on every other path) so the
      // count reflects unique session completions, not step taps.
      if (outcome.kind === 'ok' && outcome.justCompleted) {
        trackRecoveryCompleted(user.id, {
          sessionId: id,
          scamType: outcome.justCompleted.scamType,
          amountLostCents: outcome.justCompleted.amountLostCents,
          durationSeconds: outcome.justCompleted.durationSeconds,
        });
      }

      if (outcome.kind === 'session_not_found') {
        return reply.code(404).send({ error: 'session_not_found' });
      }
      if (outcome.kind === 'step_not_found') {
        return reply.code(404).send({ error: 'step_not_found' });
      }

      return reply.send(await loadSession(id, user.id));
    },
  );

  // Abandon (e.g., user dismisses the flow). Distinct from completed
  // because we surface abandoned sessions differently in analytics.
  app.post(
    '/v1/recovery/:id/abandon',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const result = await query(
        `UPDATE recovery_sessions
            SET status = 'abandoned', updated_at = NOW()
          WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        [id, user.id],
      );
      if (result.rowCount === 0) return reply.code(404).send({ error: 'session_not_found_or_not_active' });
      return reply.send({ abandoned: true });
    },
  );

  // Evidence locker — attach notes / photos / amounts / wallet addresses
  // to a recovery session. The iOS client submits text/metadata; photos
  // stay on-device and we only store a hash + caption for later recall.
  app.post(
    '/v1/recovery/:id/evidence',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const parsed = EVIDENCE_ADD_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      // Ownership check.
      const owned = await query<{ id: string }>(
        `SELECT id FROM recovery_sessions WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (owned.rows.length === 0) return reply.code(404).send({ error: 'session_not_found' });

      // Encrypt the payload at rest. The plaintext column is kept empty
      // (defaults to {}) so the row remains readable if the key is ever
      // rotated — but the real contents only live in payload_ct.
      const ct = encryptJSON(parsed.data.payload);
      const inserted = await query<{ id: string; created_at: Date }>(
        `INSERT INTO recovery_evidence (session_id, user_id, kind, payload, payload_ct)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at`,
        [id, user.id, parsed.data.kind, '{}', ct],
      );
      return reply.send({
        id: inserted.rows[0]!.id,
        kind: parsed.data.kind,
        payload: parsed.data.payload,
        created_at: inserted.rows[0]!.created_at.toISOString(),
      });
    },
  );

  app.get(
    '/v1/recovery/:id/evidence',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const rows = await query<{
        id: string;
        kind: string;
        payload: unknown;
        payload_ct: string | null;
        created_at: Date;
      }>(
        `SELECT e.id, e.kind, e.payload, e.payload_ct, e.created_at
           FROM recovery_evidence e
           JOIN recovery_sessions s ON s.id = e.session_id
          WHERE e.session_id = $1 AND s.user_id = $2
          ORDER BY e.created_at DESC`,
        [id, user.id],
      );
      return reply.send({ items: rows.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        payload: r.payload_ct
          ? readMaybeEncryptedJSON(r.payload_ct)
          : r.payload,
        created_at: r.created_at.toISOString(),
      })) });
    },
  );

  app.delete(
    '/v1/recovery/:id/evidence/:evidenceId',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id, evidenceId } = req.params as { id: string; evidenceId: string };
      const result = await query(
        `DELETE FROM recovery_evidence
           WHERE id = $1 AND session_id = $2 AND user_id = $3`,
        [evidenceId, id, user.id],
      );
      if (result.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ deleted: true });
    },
  );

  // Pre-filled FTC report. The FTC's reportfraud.ftc.gov form does not
  // accept URL pre-fill, so we return a narrative the user can paste into
  // the "What happened?" textarea plus a checklist of the structured
  // answers they'll need for the dropdowns.
  app.get(
    '/v1/recovery/:id/report/ftc',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      try {
        const ctx = await buildReportContext(id, user.id);
        return reply.send(generateFtcReport(ctx));
      } catch (err) {
        if (err instanceof NotFoundError) return reply.code(404).send({ error: 'session_not_found' });
        if (err instanceof TriageNotReadyError) {
          return reply.code(409).send({
            error: 'triage_not_resolved',
            message: "Resolve the triage session first (confirm whether it was a scam) before generating a federal report.",
          });
        }
        throw err;
      }
    },
  );

  // Pre-filled IC3 report. Same shape as FTC, but the narrative mentions
  // FBI Financial Fraud Kill Chain (FFKC) when the loss qualifies.
  app.get(
    '/v1/recovery/:id/report/ic3',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      try {
        const ctx = await buildReportContext(id, user.id);
        return reply.send(generateIc3Report(ctx));
      } catch (err) {
        if (err instanceof NotFoundError) return reply.code(404).send({ error: 'session_not_found' });
        if (err instanceof TriageNotReadyError) {
          return reply.code(409).send({
            error: 'triage_not_resolved',
            message: "Resolve the triage session first (confirm whether it was a scam) before generating a federal report.",
          });
        }
        throw err;
      }
    },
  );

  // ------------------------------------------------------------------
  // Paste-a-text analyzer. Stateless, no persistence. User pastes a
  // suspicious SMS they received, we return a trust score + verdict +
  // matched scam type + the mechanics playbook + red flags specific to
  // their text + what-to-do guidance.
  //
  // If they want to keep talking about it (e.g. "did I click? is it
  // too late?") the iOS client separately creates a triage session
  // seeded with the text — that path is the normal triage flow, not
  // this one.
  // ------------------------------------------------------------------
  app.post(
    '/v1/recovery/analyze-text',
    {
      // Free-tier viral wedge: paste-a-text scam check is the top-of-
      // funnel that pulls strangers into AegisDial without a paywall.
      // optionalAppUser → no JWT required; llmBudgetGuard still applies
      // the global per-instance LLM cap so a bot farm can't drain spend.
      // The per-IP rate limit below is the real cost-control on the
      // anonymous path; authed-user requests just inherit a per-user
      // bucket via the same keyGenerator.
      preHandler: [optionalAppUser, llmBudgetGuard],
      config: {
        // 10/hour: tight enough that an anonymous spam bot is bounded
        // (~$0.005/hr cost on Haiku) but loose enough that a real user
        // pasting a few sus texts in a row never hits the wall. Authed
        // users get the same ceiling per user-id, anonymous users per
        // IP — known imperfect for shared-NAT residential ISPs but
        // acceptable for the free tier.
        rateLimit: {
          max: 10,
          timeWindow: '1 hour',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser ?? null;
      const parsed = ANALYZE_TEXT_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      // 3-day free trial gate for ANONYMOUS users only. Authed users
      // (signed-in but not Pro) bypass this check — once you've
      // committed to even a free Apple sign-in we keep the analyzer
      // available indefinitely (still subject to the 10/hr rate limit).
      // The trial timer starts on first POST and runs 3 calendar days.
      // After that, return 402 with a friendly action code so iOS
      // can render "sign up free to keep checking texts" instead of
      // a hard wall.
      const TRIAL_DAYS = 3;
      const anonymousId = parsed.data.anonymous_id ?? null;
      if (user === null && anonymousId !== null) {
        const trial = await query<{ first_seen_at: Date; expired: boolean }>(
          `INSERT INTO anonymous_analyzer_trials (anonymous_id)
             VALUES ($1)
             ON CONFLICT (anonymous_id) DO UPDATE SET
               last_seen_at = NOW(),
               request_count = anonymous_analyzer_trials.request_count + 1
           RETURNING
             first_seen_at,
             (NOW() - first_seen_at > ($2::text || ' days')::interval) AS expired`,
          [anonymousId, String(TRIAL_DAYS)],
        );
        if (trial.rows[0]?.expired) {
          // Don't bill the LLM. Don't decrement the user's rate-limit
          // bucket more than they've already paid in this request.
          // Just tell iOS to surface the signup CTA.
          return reply.code(402).send({
            error: 'anonymous_trial_expired',
            trial_started_at: trial.rows[0].first_seen_at.toISOString(),
            trial_days: TRIAL_DAYS,
            message: 'Your free 3-day text checker trial is up. Sign up free to keep checking texts.',
          });
        }
      }

      const result = await analyzeText(parsed.data.text, parsed.data.sender);

      void track('recovery_step_completed', {
        userId: user?.id ?? null,
        anonymousId,
        properties: {
          step_key: 'analyze_text',
          verdict: result.verdict,
          scam_type: result.scam_type,
          trust_score: result.trust_score,
          llm_refined: result.llm_refined,
          authed: user !== null,
        },
      });

      return reply.send(result);
    },
  );

  // ------------------------------------------------------------------
  // Triage mode — "Is this a scam?" pre-loss consultation. Creates a
  // recovery_sessions row with mode='triage', no steps, and drops the
  // user into the Companion which is prompt-switched to triage mode.
  //
  // If triage concludes it WAS a scam and money moved, the resolve
  // endpoint converts the session in place: flips mode to 'recovery',
  // writes the confirmed scam_type, generates the full step list, and
  // fires the guardian fan-out that we suppressed on start.
  //
  // "scam_confirmed_no_loss" is our headline PR metric — scams stopped
  // before money left. We fire a dedicated analytics event for it.
  // ------------------------------------------------------------------

  // Quick companion — sessionless AI chat for trial and free-tier users.
  // Requires auth but not pro tier. Free users get 10 messages/day (Redis
  // counter); pro users are unlimited. Mirrors the client-side trial system.
  app.post(
    '/v1/recovery/companion/quick',
    {
      preHandler: [requireAppUser, llmBudgetGuard],
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 hour',
          keyGenerator: (req) => (req as { appUser?: { id: string } }).appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = QUICK_COMPANION_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      // Per-day limit for non-pro users (matches client-side trial: 10/day).
      if (user.tier !== 'pro') {
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const key = `companion_quick:${user.id}:${today}`;
        const raw = await redis.get(key);
        const count = raw ? parseInt(raw, 10) : 0;
        if (count >= 10) {
          return reply.code(429).send({
            error: 'daily_limit_reached',
            message: 'Free tier: 10 messages per day. Upgrade for unlimited access.',
          });
        }
        // Increment with 25-hour TTL so it survives past midnight safely.
        await redis.set(key, String(count + 1), 'EX', 90000);
      }

      const ctx: CompanionSessionContext = {
        mode: 'triage',
        scamType: 'generic',
        scamTypeDescription: 'suspected fraud or scam',
        amountLostUSD: null,
        sessionStartedAt: new Date(),
        openStepKeys: [],
        completedStepKeys: [],
        nextStepTitle: null,
        nextStepBody: null,
        hasFamilyPlan: false,
        hasNamedGuardian: false,
        userDisplayName: null,
      };

      const reply_ = await generateCompanionReply(ctx, parsed.data.history, parsed.data.message);

      return reply.send({
        reply: reply_.text,
        crisis_detected: reply_.crisisDetected,
      });
    },
  );

  app.post(
    '/v1/recovery/triage/start',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = TRIAGE_START_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const scamE164 = parsed.data.scam_number
        ? normalizeE164(parsed.data.scam_number)
        : null;

      const familyPlan = await query<{ id: string }>(
        `SELECT family_plan_id AS id FROM family_members WHERE user_id = $1`,
        [user.id],
      );
      const familyPlanId = familyPlan.rows[0]?.id ?? null;

      const inserted = await query<{ id: string }>(
        `INSERT INTO recovery_sessions (
           user_id, family_plan_id, scam_e164, scam_e164_ct, scam_type,
           amount_lost_cents, description, description_ct, mode
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'triage')
         RETURNING id`,
        [
          user.id,
          familyPlanId,
          '',
          scamE164 ? encryptString(scamE164) : null,
          'unknown_triage',
          null,
          '',
          parsed.data.description ? encryptString(parsed.data.description) : null,
        ],
      );
      const sessionId = inserted.rows[0]!.id;

      // No step rows are inserted in triage — the Companion does the
      // classification work; steps only exist if/when we convert to
      // recovery mode. No guardian fan-out either; we don't alarm
      // family over a maybe-scam.

      void track('triage_started', {
        userId: user.id,
        properties: {
          has_scam_number: !!scamE164,
          has_description: !!parsed.data.description,
        },
      });

      const payload = await loadSession(sessionId, user.id);
      return reply.send(payload);
    },
  );

  app.post(
    '/v1/recovery/:id/triage/resolve',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const parsed = TRIAGE_RESOLVE_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const sess = await query<{
        id: string;
        mode: string;
        resolved_as: string | null;
      }>(
        `SELECT id, mode, resolved_as FROM recovery_sessions WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (sess.rows.length === 0) return reply.code(404).send({ error: 'session_not_found' });
      if (sess.rows[0]!.mode !== 'triage') {
        return reply.code(409).send({ error: 'not_in_triage' });
      }
      // Triage is one-shot: once resolved_as is set, the session has reached
      // a terminal state. Re-resolving would resurrect a completed session
      // (e.g. flip scam_confirmed_no_loss → unclear, forcing status back
      // to active) and corrupt the PR-win metric.
      if (sess.rows[0]!.resolved_as !== null) {
        return reply.code(409).send({ error: 'already_resolved', resolved_as: sess.rows[0]!.resolved_as });
      }

      // Convert-to-recovery path: re-run the step generator for the
      // confirmed scam type, insert steps, flip mode, kick off the
      // guardian fan-out we suppressed on triage/start.
      if (parsed.data.resolved_as === 'converted_to_recovery') {
        const scamType = (parsed.data.scam_type ?? 'generic') as ScamType;
        const amountCents = parsed.data.amount_lost_usd
          ? Math.round(parsed.data.amount_lost_usd * 100)
          : null;

        // R20 — reject unknown / non-guardian named user with 400 so
        // the iOS client surfaces the error instead of silently
        // dropping to a plan-wide broadcast. Same tightened check as
        // /v1/recovery/start.
        if (parsed.data.named_guardian_user_id) {
          const ok = await isNamedGuardian(
            user.id,
            parsed.data.named_guardian_user_id,
          );
          if (!ok) return reply.code(400).send({ error: 'not_a_guardian' });
        }

        // Plan-membership validation (defense in depth — also captured
        // by isNamedGuardian's phone→contact path, but we still want to
        // confirm the user is still on the plan by the time we commit).
        let namedGuardianId: string | null = null;
        if (parsed.data.named_guardian_user_id) {
          const guardianCheck = await query<{ user_id: string }>(
            `SELECT fm.user_id FROM family_members fm
               JOIN family_plans fp ON fp.id = fm.family_plan_id
              WHERE fm.user_id = $1
                AND (fp.owner_user_id = $2 OR fp.id IN (
                  SELECT family_plan_id FROM family_members WHERE user_id = $2
                ))`,
            [parsed.data.named_guardian_user_id, user.id],
          );
          if (guardianCheck.rows.length > 0) {
            namedGuardianId = parsed.data.named_guardian_user_id;
          }
        }

        const familyPlan = await query<{ id: string }>(
          `SELECT family_plan_id AS id FROM family_members WHERE user_id = $1`,
          [user.id],
        );
        const familyPlanId = familyPlan.rows[0]?.id ?? null;
        const templates = stepsForScamType(scamType, familyPlanId !== null, {
          amountLost: (amountCents ?? 0) > 0,
          withinTimeWindow: true,
        });

        await withTx(async (client) => {
          await client.query(
            `UPDATE recovery_sessions
                SET mode = 'recovery',
                    scam_type = $2,
                    amount_lost_cents = NULL,
                    amount_lost_cents_ct = $3,
                    named_guardian_user_id = COALESCE($4, named_guardian_user_id),
                    resolved_as = 'converted_to_recovery',
                    resolved_at = NOW(),
                    updated_at = NOW()
              WHERE id = $1`,
            [id, scamType, encryptInt(amountCents), namedGuardianId],
          );
          if (templates.length > 0) {
            const stepValues: string[] = [];
            const stepParams: unknown[] = [];
            let p = 0;
            for (let i = 0; i < templates.length; i++) {
              const t = templates[i]!;
              stepValues.push(
                `($${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p})`,
              );
              stepParams.push(
                id, t.step_key, i, t.title, t.body,
                t.cta_label ?? null, t.cta_url ?? null, t.phone_to_call ?? null,
              );
            }
            await client.query(
              `INSERT INTO recovery_steps (
                 session_id, step_key, ordinal, title, body, cta_label, cta_url, phone_to_call
               ) VALUES ${stepValues.join(', ')}`,
              stepParams,
            );
          }
        });

        void track('recovery_started', {
          userId: user.id,
          properties: {
            scam_type: scamType,
            amount_lost_cents: amountCents ?? 0,
            from_triage: true,
          },
        });
        void track('triage_resolved', {
          userId: user.id,
          properties: { resolved_as: 'converted_to_recovery', scam_type: scamType },
        });

        // Named-guardian + broadcast fan-out, same as in /start.
        if (namedGuardianId) {
          const userName = (
            await query<{ display_name: string | null }>(
              `SELECT display_name FROM users WHERE id = $1`,
              [user.id],
            )
          ).rows[0]?.display_name ?? 'A family member';
          void emitGuardianAlert({
            subjectUserId: user.id,
            kind: 'recovery_started',
            severity: 'critical',
            title: `${userName} needs help right now`,
            body:
              `${userName} just confirmed they were scammed ` +
              `(${scamType.replace(/_/g, ' ')}). They picked you to tell first — give them a call.`,
            payload: { session_id: id, scam_type: scamType, named_guardian: true },
            onlyUserIds: [namedGuardianId],
          });
        }
        void emitGuardianAlert({
          subjectUserId: user.id,
          kind: 'recovery_started',
          severity: 'warning',
          title: 'A family member was scammed — be extra alert',
          body:
            `Someone on your plan reported a scam call (${scamType.replace(/_/g, ' ')}). ` +
            `Scammers often re-target the same family within days.`,
          payload: { session_id: id, scam_type: scamType },
          excludeUserIds: namedGuardianId ? [namedGuardianId] : undefined,
        });

        return reply.send(await loadSession(id, user.id));
      }

      // Terminal triage paths — update session + fire analytics.
      // The UPDATE returns prior_status so we can fire recovery_completed
      // only on the first active→completed transition (idempotent against
      // re-submitting triage on an already-resolved session).
      const newStatus =
        parsed.data.resolved_as === 'unclear' ? 'active' : 'completed';
      const updateRes = await query<{
        prior_status: string;
        scam_type: string | null;
        amount_lost_cents: number | null;
        duration_seconds: number | null;
      }>(
        `WITH prior AS (
            SELECT status FROM recovery_sessions WHERE id = $1
         )
         UPDATE recovery_sessions s
            SET resolved_as = $2,
                resolved_at = NOW(),
                status = $3,
                completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE completed_at END,
                updated_at = NOW()
           FROM prior
          WHERE s.id = $1
       RETURNING prior.status AS prior_status,
                 s.scam_type,
                 s.amount_lost_cents,
                 EXTRACT(EPOCH FROM (NOW() - s.started_at))::INT AS duration_seconds`,
        [id, parsed.data.resolved_as, newStatus],
      );

      if (parsed.data.resolved_as === 'scam_confirmed_no_loss') {
        // The headline PR metric — this is what the fundraise deck will
        // cite ("X scams stopped before loss").
        void track('scam_prevented_triage', {
          userId: user.id,
          properties: { session_id: id },
        });
      }
      void track('triage_resolved', {
        userId: user.id,
        properties: { resolved_as: parsed.data.resolved_as },
      });

      // Founder-dashboard signal — fire only on the first active→completed
      // transition. Re-submitting triage on an already-resolved session
      // (prior_status === 'completed') is a no-op for this metric.
      const updateRow = updateRes.rows[0];
      if (
        updateRow &&
        newStatus === 'completed' &&
        updateRow.prior_status !== 'completed'
      ) {
        trackRecoveryCompleted(user.id, {
          sessionId: id,
          scamType: updateRow.scam_type,
          amountLostCents: updateRow.amount_lost_cents,
          durationSeconds: updateRow.duration_seconds,
        });
      }

      return reply.send(await loadSession(id, user.id));
    },
  );

  // ------------------------------------------------------------------
  // Recovery Companion — the AI chat that sits inside every session.
  // Trauma-informed conversational guide. Every message is encrypted
  // at rest; crisis language gets routed to 988 before model call.
  // ------------------------------------------------------------------

  app.get(
    '/v1/recovery/:id/companion/messages',
    {
      preHandler: [requireAppUser, requireProTier],
      // GET history is cheap (no LLM) but spamming it still hits DB +
      // decryption per message. 30/min/user is well above any real UI
      // polling and caps abuse cost.
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      // Ownership
      const owned = await query<{ id: string }>(
        `SELECT id FROM recovery_sessions WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (owned.rows.length === 0) return reply.code(404).send({ error: 'session_not_found' });

      const rows = await query<{
        id: string;
        role: 'user' | 'assistant';
        content: string | null;
        content_ct: string;
        crisis_detected: boolean;
        created_at: Date;
      }>(
        `SELECT id, role, content, content_ct, crisis_detected, created_at
           FROM recovery_companion_messages
          WHERE session_id = $1
          ORDER BY created_at ASC
          LIMIT 500`,
        [id],
      );
      return reply.send({
        messages: rows.rows.map((r) => ({
          id: r.id,
          role: r.role,
          content: readMaybeEncrypted(r.content_ct) ?? r.content ?? '',
          crisis_detected: r.crisis_detected,
          created_at: r.created_at.toISOString(),
        })),
      });
    },
  );

  app.post(
    '/v1/recovery/:id/companion/message',
    {
      preHandler: [requireAppUser, requireProTier, llmBudgetGuard],
      config: {
        // Bound the cost surface — Sonnet 4.6 is ~10× Haiku per call.
        // 20 turns/hr is a generous real conversation; double that
        // indicates abuse.
        rateLimit: {
          max: 20,
          timeWindow: '1 hour',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const parsed = COMPANION_MSG_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      // Load session + steps to build context.
      let sessionPayload: Awaited<ReturnType<typeof loadSession>>;
      try {
        sessionPayload = await loadSession(id, user.id);
      } catch (err) {
        if (err instanceof NotFoundError) return reply.code(404).send({ error: 'session_not_found' });
        throw err;
      }

      // Companion messages only make sense on live sessions. If the user
      // (or a stale iOS tab) tries to post into a completed / abandoned
      // session we refuse — otherwise we'd pay the LLM cost for a reply
      // the user won't see, and corrupt the transcript of a closed case.
      if (sessionPayload.session.status !== 'active') {
        return reply.code(409).send({
          error: 'session_not_active',
          status: sessionPayload.session.status,
        });
      }

      // Parallelize four independent pre-LLM reads: history, a single
      // joined row that carries mode + named_guardian_user_id (used to
      // be two separate queries), users.display_name, and family
      // membership. Takes the pre-LLM path from 5 serial round-trips
      // (~100–150 ms on Neon-from-Fly) to one wall-clock round-trip.
      // MAX_HISTORY_TURNS is 24 in the companion service — pull 24.
      const [historyRows, sessionMetaRow, userRow, familyMembershipRow] = await Promise.all([
        query<{ role: 'user' | 'assistant'; content_ct: string }>(
          `SELECT role, content_ct FROM recovery_companion_messages
            WHERE session_id = $1 ORDER BY created_at ASC LIMIT 24`,
          [id],
        ),
        query<{ mode: string; named_guardian_user_id: string | null }>(
          `SELECT mode, named_guardian_user_id
             FROM recovery_sessions WHERE id = $1`,
          [id],
        ),
        query<{ display_name: string | null }>(
          `SELECT display_name FROM users WHERE id = $1`,
          [user.id],
        ),
        query<{ id: string }>(
          `SELECT family_plan_id AS id FROM family_members WHERE user_id = $1`,
          [user.id],
        ),
      ]);

      const history: CompanionMessage[] = historyRows.rows.map((r) => ({
        role: r.role,
        content: readMaybeEncrypted(r.content_ct) ?? '',
      }));

      const openSteps = sessionPayload.steps.filter(
        (s) => s.status !== 'completed' && s.status !== 'skipped',
      );
      const nextStep = openSteps[0] ?? null;

      const sessionMode: 'recovery' | 'triage' =
        sessionMetaRow.rows[0]?.mode === 'triage' ? 'triage' : 'recovery';

      const ctx: CompanionSessionContext = {
        mode: sessionMode,
        scamType: sessionPayload.session.scam_type,
        scamTypeDescription: describeScamType(sessionPayload.session.scam_type),
        amountLostUSD: sessionPayload.session.amount_lost_usd,
        sessionStartedAt: new Date(sessionPayload.session.started_at),
        openStepKeys: openSteps.map((s) => s.step_key),
        // Treat skipped as done for prompt purposes — the user moved past it.
        completedStepKeys: sessionPayload.steps
          .filter((s) => s.status === 'completed' || s.status === 'skipped')
          .map((s) => s.step_key),
        nextStepTitle: nextStep?.title ?? null,
        nextStepBody: nextStep?.body ?? null,
        hasFamilyPlan: familyMembershipRow.rows.length > 0,
        hasNamedGuardian: !!sessionMetaRow.rows[0]?.named_guardian_user_id,
        userDisplayName: userRow.rows[0]?.display_name ?? null,
      };

      const reply_ = await generateCompanionReply(ctx, history, parsed.data.message);

      // Persist both messages (encrypted). Plaintext columns carry empty
      // strings as placeholders for legacy readers.
      await withTx(async (client) => {
        await client.query(
          `INSERT INTO recovery_companion_messages
             (session_id, user_id, role, content, content_ct, crisis_detected)
           VALUES ($1, $2, 'user', $3, $4, $5)`,
          [id, user.id, '', encryptString(parsed.data.message), reply_.crisisDetected],
        );
        await client.query(
          `INSERT INTO recovery_companion_messages
             (session_id, user_id, role, content, content_ct, tokens_in, tokens_out, crisis_detected)
           VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7)`,
          [
            id,
            user.id,
            '',
            encryptString(reply_.text),
            reply_.tokensIn,
            reply_.tokensOut,
            reply_.crisisDetected,
          ],
        );
        await client.query(
          `UPDATE recovery_sessions
              SET companion_opened_at = COALESCE(companion_opened_at, NOW()),
                  companion_last_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1`,
          [id],
        );
      });

      void track('recovery_step_completed', {
        userId: user.id,
        properties: {
          step_key: 'companion_turn',
          crisis_detected: reply_.crisisDetected,
        },
      });

      return reply.send({
        reply: reply_.text,
        crisis_detected: reply_.crisisDetected,
      });
    },
  );

  // ------------------------------------------------------------------
  // Outcome capture — the flywheel. Called on session completion or
  // via the T+7d follow-up email link.
  // ------------------------------------------------------------------

  app.post(
    '/v1/recovery/:id/outcome',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const parsed = OUTCOME_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const owned = await query<{ id: string }>(
        `SELECT id FROM recovery_sessions WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (owned.rows.length === 0) return reply.code(404).send({ error: 'session_not_found' });

      const notesCt = parsed.data.notes ? encryptString(parsed.data.notes) : null;
      const feedbackCt = parsed.data.step_feedback
        ? encryptJSON(parsed.data.step_feedback)
        : null;

      await query(
        `INSERT INTO recovery_outcomes (
           session_id, user_id, recovered_any,
           recovered_cents, recovered_cents_ct,
           notes, notes_ct,
           step_feedback_ct, mood_before, mood_after, told_family, reported_to_police
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (session_id) DO UPDATE
           SET recovered_any     = COALESCE(EXCLUDED.recovered_any, recovery_outcomes.recovered_any),
               recovered_cents   = COALESCE(EXCLUDED.recovered_cents, recovery_outcomes.recovered_cents),
               recovered_cents_ct = COALESCE(EXCLUDED.recovered_cents_ct, recovery_outcomes.recovered_cents_ct),
               notes             = COALESCE(EXCLUDED.notes, recovery_outcomes.notes),
               notes_ct          = COALESCE(EXCLUDED.notes_ct, recovery_outcomes.notes_ct),
               step_feedback_ct  = COALESCE(EXCLUDED.step_feedback_ct, recovery_outcomes.step_feedback_ct),
               mood_before       = COALESCE(EXCLUDED.mood_before, recovery_outcomes.mood_before),
               mood_after        = COALESCE(EXCLUDED.mood_after, recovery_outcomes.mood_after),
               told_family       = COALESCE(EXCLUDED.told_family, recovery_outcomes.told_family),
               reported_to_police = COALESCE(EXCLUDED.reported_to_police, recovery_outcomes.reported_to_police),
               updated_at        = NOW()`,
        [
          id,
          user.id,
          parsed.data.recovered_any ?? null,
          null,  // plaintext recovered_cents stays NULL; encrypted copy below
          encryptInt(parsed.data.recovered_cents ?? null),
          '',
          notesCt,
          feedbackCt,
          parsed.data.mood_before ?? null,
          parsed.data.mood_after ?? null,
          parsed.data.told_family ?? null,
          parsed.data.reported_to_police ?? null,
        ],
      );

      void track('recovery_step_completed', {
        userId: user.id,
        properties: {
          step_key: 'outcome_submitted',
          recovered_any: parsed.data.recovered_any ?? null,
          recovered_cents: parsed.data.recovered_cents ?? null,
          told_family: parsed.data.told_family ?? null,
        },
      });

      return reply.send({ ok: true });
    },
  );

  // ------------------------------------------------------------------
  // Auto-populate hint for RecoveryStartSheet. If the user had a Live
  // Shield session in the last hour, we return its peer_e164 and the
  // top triggered_category as a scam-type hint — reducing the
  // start-sheet from "type everything" to "confirm this is right."
  // ------------------------------------------------------------------

  app.get(
    '/v1/recovery/auto-populate',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const row = await query<{
        peer_e164: string | null;
        triggered_categories: string[];
        started_at: Date;
        risk_level: string;
      }>(
        `SELECT peer_e164, triggered_categories, started_at, risk_level
           FROM call_sessions
          WHERE user_id = $1
            AND started_at > NOW() - INTERVAL '1 hour'
          ORDER BY started_at DESC LIMIT 1`,
        [user.id],
      );
      if (row.rows.length === 0) return reply.send({ suggestion: null });
      const r = row.rows[0]!;
      // Map triggered_categories → ScamType. Catalog covers the common
      // ones; fall through to 'generic' if nothing matches.
      const categoryToScamType: Record<string, string> = {
        bank: 'bank_impersonation',
        irs: 'irs_impersonation',
        ssa: 'ssa_impersonation',
        law_enforcement: 'law_enforcement_impersonation',
        tech_support: 'tech_support',
        grandchild: 'grandchild_emergency',
        ai_voice: 'ai_voice_clone_family',
        gift_card: 'gift_card_scam',
        bitcoin: 'bitcoin_atm_scam',
        crypto: 'crypto_scam',
        pig_butchering: 'pig_butchering',
        romance: 'romance_scam',
        investment: 'investment_scam',
        utility: 'utility_shutoff',
        medicare: 'medicare_impersonation',
      };
      const suggestedScamType =
        r.triggered_categories
          .map((c) => categoryToScamType[c])
          .find((s) => s) ?? 'generic';
      return reply.send({
        suggestion: {
          scam_number: r.peer_e164,
          scam_type: suggestedScamType,
          call_started_at: r.started_at.toISOString(),
          risk_level: r.risk_level,
        },
      });
    },
  );

  // ------------------------------------------------------------------
  // Bulk crime reports — the aggregate-level IC3/FTC-ready bundles
  // written by the daily bulkCrimeReporter worker when ≥10 distinct
  // users report the same scammer+scam_type in a 7-day window.
  //
  // A user "owns" a bulk report when at least one of their recovery
  // sessions is in that report's `session_ids` array. We don't expose
  // the raw session IDs (other users' sessions are mixed in) but we do
  // show the aggregate facts: how many victims, total loss, window,
  // and a generated narrative the user can render or share.
  //
  // Deliberately NOT gated on requireProTier — these are the user's
  // own submissions surfaced back to them, and we want a downgraded
  // user to still see the outcome of reports their earlier Pro
  // sessions contributed to.
  // ------------------------------------------------------------------
  app.get(
    '/v1/recovery/bulk-reports/mine',
    {
      preHandler: [requireAppUser],
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      // A bulk_crime_reports row is "mine" if any of its session_ids
      // belong to this user. The && operator is array-overlap; the
      // subquery collects the user's session UUIDs. Recovery-mode
      // sessions are the only ones that make it into the aggregator
      // (triage sessions lack scam_e164_ct), so no explicit mode
      // filter is needed.
      const rows = await query<{
        id: string;
        scam_type: string;
        distinct_users: number;
        total_amount_cents: string;
        first_seen_at: Date;
        last_seen_at: Date;
        window_end_date: Date;
        submitted_to_ic3_at: Date | null;
        submitted_to_ftc_at: Date | null;
        submitted_to_ag_at: Date | null;
        created_at: Date;
      }>(
        `SELECT bcr.id, bcr.scam_type, bcr.distinct_users, bcr.total_amount_cents,
                bcr.first_seen_at, bcr.last_seen_at, bcr.window_end_date,
                bcr.submitted_to_ic3_at, bcr.submitted_to_ftc_at, bcr.submitted_to_ag_at,
                bcr.created_at
           FROM bulk_crime_reports bcr
          WHERE bcr.session_ids && ARRAY(
                  SELECT rs.id FROM recovery_sessions rs WHERE rs.user_id = $1
                )::uuid[]
          ORDER BY bcr.window_end_date DESC, bcr.created_at DESC
          LIMIT 200`,
        [user.id],
      );
      // We don't return scam_e164 here even though the DB stores it
      // plaintext — an aggregate list view on a stranger's phone is a
      // subtle PII leak vector (e.g. a journalist phishes a victim to
      // fish the number). The detail endpoint returns it; this list
      // doesn't need it. Empty result returns an empty array, not 404
      // — per spec, "no data" is 200 `{ reports: [] }`.
      return reply.send({
        reports: rows.rows.map((r) => ({
          id: r.id,
          scam_type: r.scam_type,
          distinct_users: r.distinct_users,
          total_amount_usd: Number(r.total_amount_cents) / 100,
          first_seen_at: r.first_seen_at.toISOString(),
          last_seen_at: r.last_seen_at.toISOString(),
          window_end_date: r.window_end_date.toISOString().slice(0, 10),
          submitted_to_ic3_at: r.submitted_to_ic3_at?.toISOString() ?? null,
          submitted_to_ftc_at: r.submitted_to_ftc_at?.toISOString() ?? null,
          submitted_to_ag_at: r.submitted_to_ag_at?.toISOString() ?? null,
          created_at: r.created_at.toISOString(),
        })),
      });
    },
  );

  // Bulk report detail. Same ownership rule as /mine — the user must
  // have at least one session in session_ids. We generate the FTC +
  // IC3 narratives on-the-fly via the deterministic generator (NO
  // LLM) so the user can render them, share them, or paste them into
  // IC3's "additional information" field on their own filing.
  app.get(
    '/v1/recovery/bulk-reports/:id',
    {
      preHandler: [requireAppUser],
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      // Single round-trip: pull the report IFF the caller has a session
      // in its session_ids. Failing the ownership predicate returns an
      // empty row set → 404, same shape as other /recovery/:id lookups.
      const rows = await query<{
        id: string;
        scam_e164: string;
        scam_type: string;
        distinct_users: number;
        total_amount_cents: string;
        first_seen_at: Date;
        last_seen_at: Date;
        window_end_date: Date;
        submitted_to_ic3_at: Date | null;
        submitted_to_ftc_at: Date | null;
        submitted_to_ag_at: Date | null;
        created_at: Date;
      }>(
        `SELECT bcr.id, bcr.scam_e164, bcr.scam_type, bcr.distinct_users,
                bcr.total_amount_cents, bcr.first_seen_at, bcr.last_seen_at,
                bcr.window_end_date, bcr.submitted_to_ic3_at,
                bcr.submitted_to_ftc_at, bcr.submitted_to_ag_at, bcr.created_at
           FROM bulk_crime_reports bcr
          WHERE bcr.id = $1
            AND bcr.session_ids && ARRAY(
                  SELECT rs.id FROM recovery_sessions rs WHERE rs.user_id = $2
                )::uuid[]`,
        [id, user.id],
      );
      if (rows.rows.length === 0) {
        return reply.code(404).send({ error: 'bulk_report_not_found' });
      }
      const r = rows.rows[0]!;
      const totalUsd = Number(r.total_amount_cents) / 100;

      // Deterministic narrative — reuses the same generator that powers
      // the per-session FTC/IC3 reports. We synthesize a single "meta"
      // ReportContext representing the aggregate (one scammer number,
      // one scam type, summed loss across N victims) and tack a
      // distinct_users note into `description` so the generator's
      // narrative paragraph reflects the pattern-level nature. No LLM.
      const aggregateCtx: ReportContext = {
        scamNumber: r.scam_e164,
        scamType: r.scam_type,
        amountLostUSD: totalUsd,
        description:
          `This is an aggregate pattern report: ${r.distinct_users} distinct AegisDial ` +
          `users reported calls from this number with matching scam characteristics ` +
          `between ${r.first_seen_at.toISOString().slice(0, 10)} and ` +
          `${r.last_seen_at.toISOString().slice(0, 10)}. Combined reported loss ` +
          `across all victims: $${totalUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}.`,
        evidenceSummary: [],
        sessionStartedAt: r.first_seen_at,
        userDisplayName: null,
        userEmail: null,
      };
      const ftc = generateFtcReport(aggregateCtx);
      const ic3 = generateIc3Report(aggregateCtx);

      return reply.send({
        report: {
          id: r.id,
          scam_e164: r.scam_e164,
          scam_type: r.scam_type,
          distinct_users: r.distinct_users,
          total_amount_usd: totalUsd,
          first_seen_at: r.first_seen_at.toISOString(),
          last_seen_at: r.last_seen_at.toISOString(),
          window_end_date: r.window_end_date.toISOString().slice(0, 10),
          submitted_to_ic3_at: r.submitted_to_ic3_at?.toISOString() ?? null,
          submitted_to_ftc_at: r.submitted_to_ftc_at?.toISOString() ?? null,
          submitted_to_ag_at: r.submitted_to_ag_at?.toISOString() ?? null,
          created_at: r.created_at.toISOString(),
        },
        ftc,
        ic3,
      });
    },
  );

  // Broadcast a family alert to every guardian on the user's plan.
  // Wired to the `notify_family` step — replaces the previous dead
  // button that had a cta_label but no backend.
  app.post(
    '/v1/recovery/:id/notify-family',
    {
      preHandler: [requireAppUser, requireProTier],
      // Prevent a compromised JWT (or a stuck client retry loop) from
      // spamming every guardian on the plan with duplicate "a family
      // member was scammed" push alerts. 3/hr is higher than any real
      // user flow needs and still low enough that an attacker can't
      // weaponize this into nuisance-level push spam across a family.
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
      const { id } = req.params as { id: string };
      const sess = await query<{ scam_type: string | null; mode: string }>(
        `SELECT scam_type, mode FROM recovery_sessions WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (sess.rows.length === 0) return reply.code(404).send({ error: 'session_not_found' });
      // Don't alarm family from a triage (pre-loss) session — the whole
      // design promise of triage is we DON'T fan out until the user
      // confirms they were actually scammed.
      if (sess.rows[0]!.mode === 'triage') {
        return reply.code(409).send({
          error: 'triage_session',
          message: 'Resolve this triage first — family alerts only fire after you confirm the scam.',
        });
      }

      const result = await emitGuardianAlert({
        subjectUserId: user.id,
        kind: 'recovery_started',
        severity: 'warning',
        title: 'A family member was scammed — be extra alert',
        body:
          `Someone on your plan just opened a recovery session. Scammers often re-target the ` +
          `same family within days. If you get an unexpected call asking for money, gift cards, ` +
          `or personal info, verify with a family member you trust before doing anything.`,
        payload: { session_id: id, scam_type: sess.rows[0]!.scam_type ?? 'generic' },
      });
      return reply.send({ delivered: result.delivered });
    },
  );
}

// ---- helpers ----

async function loadSession(sessionId: string, userId: string) {
  // Kick off BOTH queries before awaiting either — they're independent,
  // so this takes loadSession from 2 serial RTTs to 1 parallel wall-clock
  // RTT. Called from 9+ endpoints, so this saves 10–30 ms per hit.
  const sessPromise = query<{
    id: string;
    user_id: string;
    family_plan_id: string | null;
    scam_e164: string | null;
    scam_e164_ct: string | null;
    scam_type: string;
    amount_lost_cents: number | null;
    amount_lost_cents_ct: string | null;
    description: string | null;
    description_ct: string | null;
    status: string;
    mode: string;
    resolved_as: string | null;
    resolved_at: Date | null;
    started_at: Date;
    completed_at: Date | null;
    updated_at: Date;
    v4_playbook_id: string | null;
    v4_stage: string | null;
  }>(
    // v4 Phase 3C — also pull v4_playbook_id + v4_stage so the recovery
    // payload can surface playbook-specific preload to iOS. These
    // columns land on recovery_sessions during the /end-route auto-
    // handoff (Phase 2). Null on legacy rows / cold sessions.
    `SELECT id, user_id, family_plan_id, scam_e164, scam_e164_ct, scam_type,
            amount_lost_cents, amount_lost_cents_ct,
            description, description_ct,
            status, mode, resolved_as, resolved_at,
            started_at, completed_at, updated_at,
            v4_playbook_id, v4_stage
       FROM recovery_sessions
      WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  const stepsPromise = query<{
    step_key: string;
    ordinal: number;
    title: string;
    body: string;
    cta_label: string | null;
    cta_url: string | null;
    phone_to_call: string | null;
    status: string;
    completed_at: Date | null;
  }>(
    `SELECT step_key, ordinal, title, body, cta_label, cta_url, phone_to_call, status, completed_at
       FROM recovery_steps WHERE session_id = $1 ORDER BY ordinal ASC`,
    [sessionId],
  );
  const [sessRow, steps] = await Promise.all([sessPromise, stepsPromise]);
  if (sessRow.rows.length === 0) throw new NotFoundError();
  const sess = sessRow.rows[0]!;
  // Empty-string coalescence: plaintext columns are written as '' when we
  // store the ciphertext, so `??` would return '' — use `||` so both null
  // and '' fall through to null for the API response.
  const scamNumber = readMaybeEncrypted(sess.scam_e164_ct) || sess.scam_e164 || null;
  const description = readMaybeEncrypted(sess.description_ct) || sess.description || null;
  const amountCents =
    decryptInt(sess.amount_lost_cents_ct ?? null) ?? sess.amount_lost_cents ?? null;
  // v4 Phase 3C — Recovery Concierge playbook preload. NULL when the
  // V4_PLAYBOOK_RECOVERY_PRELOAD_ENABLED flag is off, when v4_playbook_id
  // is not set (legacy session / cold call), or when the playbook
  // resolved to an unknown id. iOS treats NULL as "show generic
  // recovery surface" and a non-NULL object as "show playbook-aware
  // header card + counter-scripts + checkpoint suggestion."
  const v4Preload = resolveRecoveryPreload({
    v4_playbook_id: sess.v4_playbook_id,
    v4_stage: sess.v4_stage,
  });

  return {
    session: {
      id: sess.id,
      scam_number: scamNumber,
      scam_type: sess.scam_type,
      amount_lost_usd: amountCents != null ? amountCents / 100 : null,
      description: description,
      status: sess.status,
      mode: sess.mode,
      resolved_as: sess.resolved_as,
      resolved_at: sess.resolved_at?.toISOString() ?? null,
      started_at: sess.started_at.toISOString(),
      completed_at: sess.completed_at?.toISOString() ?? null,
      progress: {
        total: steps.rows.length,
        completed: steps.rows.filter((r) => r.status === 'completed').length,
        skipped: steps.rows.filter((r) => r.status === 'skipped').length,
      },
      v4_preload: v4Preload,
    },
    steps: steps.rows.map((s) => ({
      step_key: s.step_key,
      ordinal: s.ordinal,
      title: s.title,
      body: s.body,
      cta_label: s.cta_label,
      cta_url: s.cta_url,
      phone_to_call: s.phone_to_call,
      status: s.status,
      completed_at: s.completed_at?.toISOString() ?? null,
    })),
  };
}

// Assemble a ReportContext for the pre-filled-report generator. Decrypts
// the session's PII columns and the evidence payloads in one pass, then
// tacks on the user's display name + email for the narrative sign-off.
// Sentinel thrown when a caller tries to generate a federal-fraud report
// from a session that isn't ready for one — unresolved triage, or a
// triage session whose scam type is still 'unknown_triage'. The routes
// translate this into a 409 so the iOS client doesn't accidentally
// submit a nonsense narrative to FTC / IC3.
export class TriageNotReadyError extends Error {}

async function buildReportContext(sessionId: string, userId: string): Promise<ReportContext> {
  const sessRow = await query<{
    id: string;
    scam_e164: string | null;
    scam_e164_ct: string | null;
    scam_type: string;
    amount_lost_cents: number | null;
    amount_lost_cents_ct: string | null;
    description: string | null;
    description_ct: string | null;
    started_at: Date;
    mode: string;
    resolved_as: string | null;
  }>(
    `SELECT id, scam_e164, scam_e164_ct, scam_type,
            amount_lost_cents, amount_lost_cents_ct,
            description, description_ct, started_at, mode, resolved_as
       FROM recovery_sessions
      WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  if (sessRow.rows.length === 0) throw new NotFoundError();
  const sess = sessRow.rows[0]!;
  if (sess.scam_type === 'unknown_triage' || (sess.mode === 'triage' && sess.resolved_as === null)) {
    throw new TriageNotReadyError();
  }
  const amountCents =
    decryptInt(sess.amount_lost_cents_ct ?? null) ?? sess.amount_lost_cents ?? null;

  const evidenceRows = await query<{
    kind: string;
    payload: unknown;
    payload_ct: string | null;
    created_at: Date;
  }>(
    `SELECT kind, payload, payload_ct, created_at
       FROM recovery_evidence
      WHERE session_id = $1 AND user_id = $2
      ORDER BY created_at ASC`,
    [sessionId, userId],
  );

  const userRow = await query<{ email: string | null; display_name: string | null }>(
    `SELECT email, display_name FROM users WHERE id = $1`,
    [userId],
  );
  const userEmail = userRow.rows[0]?.email ?? null;
  const userDisplayName = userRow.rows[0]?.display_name ?? null;

  const scamNumber = readMaybeEncrypted(sess.scam_e164_ct) || sess.scam_e164 || null;
  const description = readMaybeEncrypted(sess.description_ct) || sess.description || null;

  const evidenceSummary: EvidenceItem[] = evidenceRows.rows.map((r) => {
    const payload = r.payload_ct
      ? (readMaybeEncryptedJSON(r.payload_ct) as Record<string, unknown>)
      : (r.payload as Record<string, unknown>);
    return {
      kind: r.kind,
      payload: payload ?? {},
      createdAt: r.created_at,
    };
  });

  return {
    scamNumber,
    scamType: sess.scam_type,
    amountLostUSD: amountCents != null ? amountCents / 100 : null,
    description,
    evidenceSummary,
    sessionStartedAt: sess.started_at,
    userDisplayName,
    userEmail,
  };
}

class NotFoundError extends Error {
  constructor() { super('not_found'); }
}

// R20 — "is this user actually a guardian of mine?" There's no
// family_members.role='guardian' value (schema constrains role to
// 'owner'|'member'), so the authoritative signal is the subject's own
// family_contacts list: an is_guardian=TRUE entry whose phone_e164
// matches users.phone_number of the named user. We additionally require
// the named user to be a member of the subject's plan so we don't light
// up a push for someone who isn't on the subscription.
async function isNamedGuardian(
  subjectUserId: string,
  namedUserId: string,
): Promise<boolean> {
  // A user can't be their own guardian — self-named guardians would
  // fan-out a "you need help" alert to themselves, which is both
  // useless and an attack surface (compromised account using itself
  // as the named guardian to trigger phantom alerts).
  if (subjectUserId === namedUserId) return false;
  const row = await query<{ user_id: string }>(
    `SELECT fm.user_id
       FROM family_members fm
       JOIN family_plans fp ON fp.id = fm.family_plan_id
       JOIN users nu ON nu.id = fm.user_id
       JOIN family_contacts fc ON fc.user_id = $1
                               AND fc.is_guardian = TRUE
                               AND fc.phone_e164 = nu.phone_number
      WHERE fm.user_id = $2
        AND (fp.owner_user_id = $1 OR fp.id IN (
          SELECT family_plan_id FROM family_members WHERE user_id = $1
        ))
      LIMIT 1`,
    [subjectUserId, namedUserId],
  );
  return row.rows.length > 0;
}
