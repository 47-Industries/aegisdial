import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { emitMetric } from '../lib/observability.js';
import {
  emitSystemEvent,
  safetyContactInitiating,
  safetyContactJoined,
  safetyContactLeft,
} from '../services/transcriptEvents.js';

// Live Shield v3 — B5 family-join routes.
//
// Three endpoints called by the FAMILY MEMBER's iPhone (not Mom's):
//
//   POST /v1/family/initiate-join
//     Family taps [Join the call] on the family-alert push. iOS
//     opens the Phone app with Mom's number pre-dialed via tel:
//     URL. This endpoint logs the initiation + fires a transcript
//     marker so the rest of the family-plan sees "Tyler is calling
//     Mom" in real time.
//
//   POST /v1/family/join-completed
//     Best-effort callback when iOS detects the call connected.
//     Marks the b5_safety_contact_events row as 'joined' and
//     fires the corresponding transcript marker.
//
//   POST /v1/family/safety-contact-left
//     Fires when the family member's call to Mom ends. Closes
//     out the audit trail.
//
// Authorization model (locked in spec section "B5 transparency"):
//   - All three routes require the family member's auth (req.appUser)
//   - Authorization step: verify the family member shares a
//     family_plan_id with the protected user (the session's user_id)
//   - 403 otherwise; 404 if the session/protected user can't be found
//
// No audio routing — iOS native conference handles that. Our backend
// is purely an audit-trail + transcript-event source. This is the
// architectural decision that sidesteps two-party-consent legal
// exposure entirely (we don't own the audio, we don't record it).

const InitiateJoinSchema = z.object({
  session_id: z.string().uuid(),
});

const JoinCompletedSchema = z.object({
  session_id: z.string().uuid(),
});

const SafetyContactLeftSchema = z.object({
  session_id: z.string().uuid(),
  duration_seconds: z.number().int().nonnegative().optional(),
});

export async function familyJoinRoutes(app: FastifyInstance): Promise<void> {
  if (!config.V3_B5_ENABLED) {
    return;
  }

  // -------------------------------------------------------------------------
  // POST /v1/family/initiate-join
  // -------------------------------------------------------------------------

  app.post(
    '/v1/family/initiate-join',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const familyMember = req.appUser!;
      const parsed = InitiateJoinSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }

      const auth = await authorizeFamilyMember(familyMember.id, parsed.data.session_id);
      if (auth.kind !== 'ok') {
        return reply.code(auth.kind === 'session_not_found' ? 404 : 403)
          .send({ error: auth.kind });
      }

      // Persist the initiation event.
      await query(
        `INSERT INTO b5_safety_contact_events
           (session_id, family_member_user_id, protected_user_id, event_type)
         VALUES ($1, $2, $3, 'initiating')`,
        [parsed.data.session_id, familyMember.id, auth.protected_user_id],
      );

      // Fire transcript marker so the family-transcript view shows
      // "Tyler is calling Mom" in real time.
      void emitSystemEvent(
        safetyContactInitiating(parsed.data.session_id, auth.protected_user_id, {
          family_member_user_id: familyMember.id,
        }),
      );

      emitMetric('v3.b5.join_initiated', {});

      return reply.code(201).send({
        session_id: parsed.data.session_id,
        protected_user_id: auth.protected_user_id,
        initiated_at: new Date().toISOString(),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/family/join-completed
  // -------------------------------------------------------------------------

  app.post(
    '/v1/family/join-completed',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const familyMember = req.appUser!;
      const parsed = JoinCompletedSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body' });
      }

      const auth = await authorizeFamilyMember(familyMember.id, parsed.data.session_id);
      if (auth.kind !== 'ok') {
        return reply.code(auth.kind === 'session_not_found' ? 404 : 403)
          .send({ error: auth.kind });
      }

      await query(
        `INSERT INTO b5_safety_contact_events
           (session_id, family_member_user_id, protected_user_id, event_type)
         VALUES ($1, $2, $3, 'joined')`,
        [parsed.data.session_id, familyMember.id, auth.protected_user_id],
      );

      void emitSystemEvent(
        safetyContactJoined(parsed.data.session_id, auth.protected_user_id, {
          family_member_user_id: familyMember.id,
        }),
      );

      emitMetric('v3.b5.join_completed', {});

      return reply.code(201).send({
        session_id: parsed.data.session_id,
        joined_at: new Date().toISOString(),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/family/safety-contact-left
  // -------------------------------------------------------------------------

  app.post(
    '/v1/family/safety-contact-left',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const familyMember = req.appUser!;
      const parsed = SafetyContactLeftSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body' });
      }

      const auth = await authorizeFamilyMember(familyMember.id, parsed.data.session_id);
      if (auth.kind !== 'ok') {
        return reply.code(auth.kind === 'session_not_found' ? 404 : 403)
          .send({ error: auth.kind });
      }

      await query(
        `INSERT INTO b5_safety_contact_events
           (session_id, family_member_user_id, protected_user_id, event_type)
         VALUES ($1, $2, $3, 'left')`,
        [parsed.data.session_id, familyMember.id, auth.protected_user_id],
      );

      void emitSystemEvent(
        safetyContactLeft(parsed.data.session_id, auth.protected_user_id, {
          family_member_user_id: familyMember.id,
          duration_seconds: parsed.data.duration_seconds ?? 0,
        }),
      );

      emitMetric('v3.b5.safety_contact_left', {});

      return reply.code(201).send({
        session_id: parsed.data.session_id,
        left_at: new Date().toISOString(),
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Authorization helper
// ---------------------------------------------------------------------------

type AuthResult =
  | { kind: 'ok'; protected_user_id: string }
  | { kind: 'session_not_found' }
  | { kind: 'not_in_same_family_plan' };

/**
 * Verify the requesting family member has authorization to act on
 * this session. The check:
 *
 *   1. Find the protected user (session.user_id).
 *   2. Verify family member and protected user are on the same family
 *      plan via family_members.
 *
 * Returns the protected user's id on success; structured failure
 * codes otherwise so the caller can return the right HTTP status.
 */
async function authorizeFamilyMember(
  family_member_user_id: string,
  session_id: string,
): Promise<AuthResult> {
  const session = await query<{ user_id: string }>(
    `SELECT user_id FROM call_sessions WHERE id = $1`,
    [session_id],
  );
  if (session.rows.length === 0) {
    return { kind: 'session_not_found' };
  }
  const protected_user_id = session.rows[0]!.user_id;

  // The family-member can't be the same person as the protected user
  // (Mom can't be her own safety contact). This also catches the
  // dev-bearer / synthetic-user case where the same UUID would
  // erroneously authorize.
  if (protected_user_id === family_member_user_id) {
    return { kind: 'not_in_same_family_plan' };
  }

  const sharedPlan = await query<{ family_plan_id: string }>(
    `SELECT fm1.family_plan_id
       FROM family_members fm1
       JOIN family_members fm2 ON fm2.family_plan_id = fm1.family_plan_id
      WHERE fm1.user_id = $1
        AND fm2.user_id = $2
      LIMIT 1`,
    [family_member_user_id, protected_user_id],
  );

  if (sharedPlan.rows.length === 0) {
    return { kind: 'not_in_same_family_plan' };
  }

  return { kind: 'ok', protected_user_id };
}
