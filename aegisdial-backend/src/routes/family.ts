import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query, withTx } from '../lib/db.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { currentTier, ensureTierPersisted } from '../lib/subscription.js';

// Family plan endpoints. Flow:
//   1. Pro-tier user calls POST /v1/family/invite — if they don't have a
//      family_plan yet, we create one and auto-enroll them as 'owner'.
//      We then generate a short human-typable code that expires in 7 days.
//   2. The invited user installs the app, signs in, and calls
//      POST /v1/family/accept with the code. We validate capacity, mark the
//      invite accepted, and insert a family_members row with role='member'.
//   3. All other endpoints (status, revoke, remove) are owner-only.
//
// Seat math: a plan's capacity is included_lines + addon_lines. Seats taken =
// existing members + currently pending invites. Owner counts as one seat.

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_PENDING_INVITES = 5;
// Base32 alphabet minus 0/O/I/1 to avoid user-typing confusion.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

const inviteSchema = z.object({
  label: z.string().max(60).optional(),
  invited_contact: z.string().max(120).optional(),
});

const acceptSchema = z.object({
  code: z.string().min(4).max(20),
});

export async function familyRoutes(app: FastifyInstance): Promise<void> {
  // Create or retrieve the authenticated user's plan and mint a new invite.
  // Requires pro tier — only paying subscribers can invite.
  app.post(
    '/v1/family/invite',
    {
      preHandler: [requireAppUser, requireProTier],
      // 10 invites/hour/user. Plans cap at MAX_PENDING_INVITES (5), so
      // in a healthy flow a user hits that first. 10/hr is a softer
      // outer guard against an attacker racing accept-then-invite to
      // oversell seats, and against an automated spammer using the
      // invited_contact field as a "send a message from aegisdial"
      // email vector.
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
      const body = inviteSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

      // A user can only be part of one plan at a time. If they're already
      // a member of someone else's plan, they can't create their own.
      const existingMembership = await query<{ role: string }>(
        `SELECT role FROM family_members WHERE user_id = $1`,
        [user.id],
      );
      if (existingMembership.rows[0]?.role === 'member') {
        return reply.code(409).send({
          error: 'already_on_other_plan',
          message: "You're on another family plan. Leave it first to start your own.",
        });
      }

      let code: string;
      try {
        const result = await withTx(async (client) => {
          // Ensure the plan exists and the caller is its owner.
          const plan = await client.query<{ id: string; included_lines: number; addon_lines: number }>(
            `INSERT INTO family_plans (owner_user_id, included_lines, addon_lines)
             VALUES ($1, 3, 0)
             ON CONFLICT (owner_user_id) DO UPDATE SET updated_at = NOW()
             RETURNING id, included_lines, addon_lines`,
            [user.id],
          );
          const pId = plan.rows[0]!.id;

          await client.query(
            `INSERT INTO family_members (family_plan_id, user_id, role)
             VALUES ($1, $2, 'owner')
             ON CONFLICT (family_plan_id, user_id) DO NOTHING`,
            [pId, user.id],
          );

          // Capacity check.
          const capacity = plan.rows[0]!.included_lines + plan.rows[0]!.addon_lines;
          const seatsUsed = await client.query<{ seats: string }>(
            `SELECT (
               (SELECT COUNT(*) FROM family_members WHERE family_plan_id = $1)
             + (SELECT COUNT(*) FROM family_invites
                 WHERE family_plan_id = $1 AND status = 'pending' AND expires_at > NOW())
             ) AS seats`,
            [pId],
          );
          const used = Number(seatsUsed.rows[0]!.seats);
          if (used >= capacity) {
            throw new CapacityError(used, capacity);
          }

          // Rate-limit pending invites to prevent spam.
          const pending = await client.query<{ count: string }>(
            `SELECT COUNT(*) AS count
               FROM family_invites
              WHERE family_plan_id = $1 AND status = 'pending' AND expires_at > NOW()`,
            [pId],
          );
          if (Number(pending.rows[0]!.count) >= MAX_PENDING_INVITES) {
            throw new RateLimitError();
          }

          // Mint the invite INSIDE the transaction so the capacity
          // check + insert are atomic. Previously the INSERT happened
          // after the transaction closed, letting two concurrent
          // invite requests both pass the capacity check (reads don't
          // conflict) and both INSERT — oversell by one.
          let code = '';
          for (let attempt = 0; attempt < 5; attempt++) {
            const candidate = generateCode();
            try {
              await client.query(
                `INSERT INTO family_invites (
                   family_plan_id, code, label, invited_contact, created_by_user_id, expires_at
                 ) VALUES ($1, $2, $3, $4, $5, NOW() + ($6::text || ' milliseconds')::interval)`,
                [
                  pId,
                  candidate,
                  body.data.label ?? null,
                  body.data.invited_contact ?? null,
                  user.id,
                  String(INVITE_TTL_MS),
                ],
              );
              code = candidate;
              break;
            } catch (err) {
              const pgCode = (err as { code?: string }).code;
              if (pgCode === '23505') continue;
              throw err;
            }
          }
          if (!code) throw new CodeGenerationError();

          return { planId: pId, code };
        });
        code = result.code;
      } catch (err) {
        if (err instanceof CodeGenerationError) {
          return reply.code(500).send({ error: 'code_generation_failed' });
        }
        if (err instanceof CapacityError) {
          return reply.code(409).send({
            error: 'plan_at_capacity',
            seats_used: err.used,
            capacity: err.capacity,
            message:
              'Your family plan has no free seats. Remove a member, or upgrade to Family+ ($69.99/mo, 5 lines).',
          });
        }
        if (err instanceof RateLimitError) {
          return reply.code(429).send({
            error: 'too_many_pending_invites',
            message: 'You already have the maximum number of pending invites.',
          });
        }
        throw err;
      }

      // planId + code are now both returned from the atomic transaction
      // above. Old post-tx INSERT loop removed — it allowed two
      // concurrent requests to both pass the capacity check (reads
      // don't conflict) and both INSERT afterwards, overselling by one.

      const { track } = await import('../lib/analytics.js');
      void track('family_invite_sent', {
        userId: user.id,
        properties: { has_label: !!body.data.label },
      });
      return reply.send({
        code,
        label: body.data.label ?? null,
        expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        share_message: buildShareMessage(code, body.data.label),
      });
    },
  );

  // Accept an invite. Requires authenticated user but NOT pro — the whole
  // point is that the invited user joins and inherits the owner's tier.
  app.post(
    '/v1/family/accept',
    {
      preHandler: requireAppUser,
      // 10 attempts/minute/user. The invite code space is 32^8 ≈ 10^12
      // so brute force is already impractical, but rate-limiting the
      // accept endpoint shuts down a compromised-JWT loop that's just
      // spraying codes looking for any valid hit. 1-minute window so a
      // legitimate user mistyping their code a handful of times isn't
      // locked out for an hour.
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      const body = acceptSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      const normalizedCode = body.data.code.trim().toUpperCase().replace(/-/g, '');

      let planId: string | null = null;
      try {
        planId = await withTx(async (client) => {
          const invite = await client.query<{
            id: string;
            family_plan_id: string;
            expires_at: Date;
            status: string;
          }>(
            `SELECT id, family_plan_id, expires_at, status
               FROM family_invites
              WHERE code = $1 AND status = 'pending'
              LIMIT 1
              FOR UPDATE`,
            [normalizedCode],
          );
          if (invite.rows.length === 0) {
            throw new InviteNotFoundError();
          }
          const row = invite.rows[0]!;
          if (row.expires_at.getTime() <= Date.now()) {
            await client.query(
              `UPDATE family_invites SET status = 'expired' WHERE id = $1`,
              [row.id],
            );
            throw new InviteExpiredError();
          }

          // The accepting user can't already be on a plan.
          const existing = await client.query<{ role: string }>(
            `SELECT role FROM family_members WHERE user_id = $1`,
            [user.id],
          );
          if (existing.rows.length > 0) {
            throw new AlreadyOnPlanError();
          }

          // Capacity recheck (invites consume seats, but a racing accept could
          // squeeze past if we don't lock).
          const planRow = await client.query<{ included_lines: number; addon_lines: number; owner_user_id: string }>(
            `SELECT included_lines, addon_lines, owner_user_id FROM family_plans WHERE id = $1 FOR UPDATE`,
            [row.family_plan_id],
          );
          if (planRow.rows.length === 0) {
            throw new InviteNotFoundError();
          }
          const capacity = planRow.rows[0]!.included_lines + planRow.rows[0]!.addon_lines;
          // Count members AND OTHER still-pending invites (excluding the
          // one we're accepting right now). A plan with cap=3, 1 member,
          // and 2 other pending invites that both get accepted would
          // oversell without the invite count — this matches the
          // create-invite capacity check's shape.
          const seatsUsed = await client.query<{ count: string }>(
            `SELECT (
               (SELECT COUNT(*) FROM family_members WHERE family_plan_id = $1)
             + (SELECT COUNT(*) FROM family_invites
                 WHERE family_plan_id = $1 AND status = 'pending'
                   AND expires_at > NOW() AND id <> $2)
             ) AS count`,
            [row.family_plan_id, row.id],
          );
          const used = Number(seatsUsed.rows[0]!.count);
          if (used >= capacity) {
            throw new CapacityError(used, capacity);
          }

          // The accepting user can't be the plan owner themselves.
          if (planRow.rows[0]!.owner_user_id === user.id) {
            throw new CantJoinOwnPlanError();
          }

          await client.query(
            `INSERT INTO family_members (family_plan_id, user_id, role)
             VALUES ($1, $2, 'member')`,
            [row.family_plan_id, user.id],
          );
          await client.query(
            `UPDATE family_invites
                SET status = 'accepted', accepted_by_user_id = $2, accepted_at = NOW()
              WHERE id = $1`,
            [row.id, user.id],
          );
          return row.family_plan_id;
        });
      } catch (err) {
        if (err instanceof InviteNotFoundError)
          return reply.code(404).send({ error: 'invite_not_found' });
        if (err instanceof InviteExpiredError)
          return reply.code(410).send({ error: 'invite_expired' });
        if (err instanceof AlreadyOnPlanError)
          return reply.code(409).send({ error: 'already_on_plan' });
        if (err instanceof CantJoinOwnPlanError)
          return reply.code(409).send({ error: 'cannot_join_own_plan' });
        if (err instanceof CapacityError)
          return reply.code(409).send({
            error: 'plan_at_capacity',
            seats_used: err.used,
            capacity: err.capacity,
          });
        throw err;
      }

      // Refresh the accepting user's tier so /v1/verdict works immediately.
      const tier = await currentTier(user.id);
      await ensureTierPersisted(user.id, tier);

      const { track } = await import('../lib/analytics.js');
      void track('family_invite_accepted', {
        userId: user.id,
        properties: { family_plan_id: planId },
      });
      return reply.send({ family_plan_id: planId, tier, joined_at: new Date().toISOString() });
    },
  );

  // Get my current family-plan status. Works for both owners and members.
  app.get('/v1/family', { preHandler: requireAppUser }, async (req, reply) => {
    const user = req.appUser!;
    const my = await query<{ family_plan_id: string; role: string }>(
      `SELECT family_plan_id, role FROM family_members WHERE user_id = $1`,
      [user.id],
    );
    if (my.rows.length === 0) {
      return reply.send({ on_plan: false });
    }
    const planId = my.rows[0]!.family_plan_id;
    const role = my.rows[0]!.role;

    const [plan, members, invites] = await Promise.all([
      query<{ id: string; owner_user_id: string; included_lines: number; addon_lines: number; created_at: Date }>(
        `SELECT id, owner_user_id, included_lines, addon_lines, created_at
           FROM family_plans WHERE id = $1`,
        [planId],
      ),
      query<{
        user_id: string;
        role: string;
        label: string | null;
        added_at: Date;
        display_name: string | null;
      }>(
        `SELECT fm.user_id, fm.role, fm.label, fm.added_at, u.display_name
           FROM family_members fm
           JOIN users u ON u.id = fm.user_id
          WHERE fm.family_plan_id = $1
          ORDER BY fm.added_at ASC`,
        [planId],
      ),
      role === 'owner'
        ? query<{
            id: string;
            code: string;
            label: string | null;
            expires_at: Date;
            created_at: Date;
          }>(
            `SELECT id, code, label, expires_at, created_at
               FROM family_invites
              WHERE family_plan_id = $1 AND status = 'pending' AND expires_at > NOW()
              ORDER BY created_at DESC`,
            [planId],
          )
        : Promise.resolve({ rows: [] as unknown[] } as never),
    ]);

    const planRow = plan.rows[0]!;
    const capacity = planRow.included_lines + planRow.addon_lines;
    const memberCount = members.rows.length;
    const pendingCount = (invites.rows as unknown as { id: string }[]).length;

    return reply.send({
      on_plan: true,
      role,
      plan: {
        id: planRow.id,
        owner_user_id: planRow.owner_user_id,
        included_lines: planRow.included_lines,
        addon_lines: planRow.addon_lines,
        capacity,
        seats_used: memberCount,
        seats_available: Math.max(0, capacity - memberCount - pendingCount),
        created_at: planRow.created_at.toISOString(),
      },
      members: members.rows.map((m) => ({
        user_id: m.user_id,
        role: m.role,
        label: m.label,
        display_name: m.display_name,
        added_at: m.added_at.toISOString(),
        is_you: m.user_id === user.id,
      })),
      pending_invites: (invites.rows as unknown as Array<{
        id: string;
        code: string;
        label: string | null;
        expires_at: Date;
        created_at: Date;
      }>).map((i) => ({
        id: i.id,
        code: i.code,
        label: i.label,
        expires_at: i.expires_at.toISOString(),
        created_at: i.created_at.toISOString(),
      })),
    });
  });

  // Owner revokes a pending invite before it's accepted.
  app.delete(
    '/v1/family/invite/:id',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const result = await query(
        `UPDATE family_invites
            SET status = 'revoked'
          WHERE id = $1
            AND status = 'pending'
            AND family_plan_id IN (SELECT id FROM family_plans WHERE owner_user_id = $2)`,
        [id, user.id],
      );
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: 'invite_not_found_or_not_pending' });
      }
      return reply.send({ revoked: true });
    },
  );

  // Owner removes a member (or member removes themselves).
  app.delete(
    '/v1/family/member/:user_id',
    { preHandler: requireAppUser },
    async (req, reply) => {
      const actor = req.appUser!;
      const { user_id: targetUserId } = req.params as { user_id: string };

      const my = await query<{ family_plan_id: string; role: string; owner_user_id: string }>(
        `SELECT fm.family_plan_id, fm.role, fp.owner_user_id
           FROM family_members fm
           JOIN family_plans fp ON fp.id = fm.family_plan_id
          WHERE fm.user_id = $1`,
        [actor.id],
      );
      if (my.rows.length === 0) return reply.code(404).send({ error: 'not_on_plan' });
      const { family_plan_id, owner_user_id } = my.rows[0]!;

      const isOwner = actor.id === owner_user_id;
      const isSelf = actor.id === targetUserId;
      if (!isOwner && !isSelf) {
        return reply.code(403).send({ error: 'only_owner_or_self_can_remove' });
      }
      if (isSelf && isOwner) {
        return reply.code(409).send({
          error: 'owner_cannot_remove_self',
          message: 'Cancel the subscription instead of leaving a plan you own.',
        });
      }

      const removed = await withTx(async (client) => {
        const result = await client.query(
          `DELETE FROM family_members
            WHERE family_plan_id = $1 AND user_id = $2 AND role = 'member'`,
          [family_plan_id, targetUserId],
        );
        if (result.rowCount === 0) {
          return false;
        }

        // B10 — If the departing member was the named guardian on any
        // OTHER plan-member's open recovery session, clear that pointer
        // so the named-guardian fan-out never targets a non-member.
        // Wrapped in the same tx as the DELETE so we never leave a
        // dangling pointer if a pooled connection dies mid-sequence.
        await client.query(
          `UPDATE recovery_sessions
              SET named_guardian_user_id = NULL
            WHERE named_guardian_user_id = $1
              AND user_id IN (
                SELECT user_id FROM family_members WHERE family_plan_id = $2
              )`,
          [targetUserId, family_plan_id],
        );

        // Also drop any still-pending ownership-transfer row where the
        // departing user was on either side of the handshake — an
        // expired / cancelled transfer is less surprising than an
        // accept-endpoint that suddenly 404s.
        await client.query(
          `UPDATE family_ownership_transfers
              SET cancelled_at = NOW()
            WHERE family_plan_id = $1
              AND (from_user_id = $2 OR to_user_id = $2)
              AND accepted_at IS NULL
              AND cancelled_at IS NULL`,
          [family_plan_id, targetUserId],
        );
        return true;
      });
      if (!removed) {
        return reply.code(404).send({ error: 'member_not_found' });
      }

      // Recompute the removed user's tier (they may lose pro access).
      const newTier = await currentTier(targetUserId);
      await ensureTierPersisted(targetUserId, newTier);
      return reply.send({ removed: true, target_tier: newTier });
    },
  );

  // -------------------------------------------------------------------
  // Plan-owner transfer. Two-step flow so a typo on the owner's side
  // never instantly hands off the subscription:
  //   1. Current owner POSTs /v1/family/transfer/request naming an
  //      existing plan member → we mint a 24-hour token, persist a
  //      transfer row, return the token. iOS shows a "ask Mom to paste
  //      this token" sheet.
  //   2. Target user POSTs /v1/family/transfer/accept with the token.
  //      We verify the token, the plan still has both users, and swap
  //      owner_user_id + member roles atomically.
  // -------------------------------------------------------------------
  const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;

  app.post(
    '/v1/family/transfer/request',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = transferRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const newOwnerId = parsed.data.new_owner_user_id;
      if (newOwnerId === user.id) {
        return reply.code(400).send({ error: 'cannot_transfer_to_self' });
      }

      try {
        const result = await withTx(async (client) => {
          // Caller must own a plan.
          const plan = await client.query<{ id: string }>(
            `SELECT id FROM family_plans WHERE owner_user_id = $1 FOR UPDATE`,
            [user.id],
          );
          if (plan.rows.length === 0) {
            throw new NotOwnerError();
          }
          const planId = plan.rows[0]!.id;

          // Target must currently be a 'member' (not 'owner' — that's
          // the caller — and not absent).
          const target = await client.query<{ role: string }>(
            `SELECT role FROM family_members
              WHERE family_plan_id = $1 AND user_id = $2`,
            [planId, newOwnerId],
          );
          if (target.rows.length === 0 || target.rows[0]!.role !== 'member') {
            throw new TargetNotMemberError();
          }

          // Invalidate any previous pending transfer on this plan. The
          // partial unique index lets us freely insert a new one after
          // the cancel is committed; without this step a second
          // request would hit the unique violation.
          await client.query(
            `UPDATE family_ownership_transfers
                SET cancelled_at = NOW()
              WHERE family_plan_id = $1
                AND accepted_at IS NULL
                AND cancelled_at IS NULL`,
            [planId],
          );

          const token = randomBytes(16).toString('base64url');
          const tokenHash = createHash('sha256').update(token).digest('hex');
          const inserted = await client.query<{ id: string; expires_at: Date }>(
            `INSERT INTO family_ownership_transfers
               (family_plan_id, from_user_id, to_user_id, token_hash, expires_at)
             VALUES ($1, $2, $3, $4, NOW() + ($5::text || ' milliseconds')::interval)
             RETURNING id, expires_at`,
            [planId, user.id, newOwnerId, tokenHash, String(TRANSFER_TTL_MS)],
          );
          return {
            id: inserted.rows[0]!.id,
            token,
            expires_at: inserted.rows[0]!.expires_at.toISOString(),
          };
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof NotOwnerError) {
          return reply.code(403).send({ error: 'not_plan_owner' });
        }
        if (err instanceof TargetNotMemberError) {
          return reply.code(400).send({ error: 'target_not_plan_member' });
        }
        throw err;
      }
    },
  );

  app.post(
    '/v1/family/transfer/accept',
    { preHandler: [requireAppUser] },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = transferAcceptSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      try {
        const planId = await withTx(async (client) => {
          // The DB only stores sha256(token). Hash what the caller
          // submitted and look up by that — the DB doesn't know the raw
          // token, so a leaked backup or a support-tool DB read can't
          // be used to accept pending transfers.
          const submittedHash = createHash('sha256')
            .update(parsed.data.token)
            .digest('hex');
          const row = await client.query<{
            id: string;
            family_plan_id: string;
            from_user_id: string;
            to_user_id: string;
            expires_at: Date;
            accepted_at: Date | null;
            cancelled_at: Date | null;
          }>(
            `SELECT id, family_plan_id, from_user_id, to_user_id,
                    expires_at, accepted_at, cancelled_at
               FROM family_ownership_transfers
              WHERE token_hash = $1
              FOR UPDATE`,
            [submittedHash],
          );
          if (row.rows.length === 0) throw new TransferNotFoundError();
          const t = row.rows[0]!;
          if (t.cancelled_at !== null) throw new TransferNotFoundError();
          if (t.accepted_at !== null) throw new TransferAlreadyAcceptedError();
          if (t.expires_at.getTime() <= Date.now()) {
            throw new TransferExpiredError();
          }
          if (t.to_user_id !== user.id) throw new TransferNotForYouError();

          // Both parties must STILL be on the plan. Lazy invalidation —
          // membership churn between request + accept should poison the
          // transfer rather than silently mis-route ownership.
          const both = await client.query<{ user_id: string; role: string }>(
            `SELECT user_id, role FROM family_members
              WHERE family_plan_id = $1 AND user_id = ANY($2::uuid[])`,
            [t.family_plan_id, [t.from_user_id, t.to_user_id]],
          );
          const roleByUser = new Map(both.rows.map((r) => [r.user_id, r.role]));
          if (
            roleByUser.get(t.from_user_id) !== 'owner' ||
            roleByUser.get(t.to_user_id) !== 'member'
          ) {
            throw new TransferMembershipStaleError();
          }

          // Atomic swap: update plan's owner + swap member roles.
          await client.query(
            `UPDATE family_plans SET owner_user_id = $1, updated_at = NOW() WHERE id = $2`,
            [t.to_user_id, t.family_plan_id],
          );
          await client.query(
            `UPDATE family_members SET role = 'member'
              WHERE family_plan_id = $1 AND user_id = $2`,
            [t.family_plan_id, t.from_user_id],
          );
          await client.query(
            `UPDATE family_members SET role = 'owner'
              WHERE family_plan_id = $1 AND user_id = $2`,
            [t.family_plan_id, t.to_user_id],
          );
          await client.query(
            `UPDATE family_ownership_transfers
                SET accepted_at = NOW()
              WHERE id = $1`,
            [t.id],
          );
          return t.family_plan_id;
        });

        // Recompute both tiers — the new owner now holds the
        // subscription source-of-truth for the plan.
        const newOwnerTier = await currentTier(user.id);
        await ensureTierPersisted(user.id, newOwnerTier);
        return reply.send({ accepted: true, family_plan_id: planId });
      } catch (err) {
        if (err instanceof TransferNotFoundError) {
          return reply.code(404).send({ error: 'transfer_not_found' });
        }
        if (err instanceof TransferExpiredError) {
          return reply.code(410).send({ error: 'transfer_expired' });
        }
        if (err instanceof TransferAlreadyAcceptedError) {
          return reply.code(409).send({ error: 'transfer_already_accepted' });
        }
        if (err instanceof TransferNotForYouError) {
          return reply.code(403).send({ error: 'transfer_not_for_you' });
        }
        if (err instanceof TransferMembershipStaleError) {
          return reply.code(409).send({ error: 'transfer_membership_stale' });
        }
        throw err;
      }
    },
  );
}

const transferRequestSchema = z.object({
  new_owner_user_id: z.string().uuid(),
});
const transferAcceptSchema = z.object({
  token: z.string().min(8).max(100),
});

// ----- helpers -----

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

function buildShareMessage(code: string, label?: string | null): string {
  const name = label ? `${label}, ` : '';
  return `${name}I added you to my AegisDial family plan — bank-grade protection for every call. Install AegisDial from the App Store, then enter code ${code} in Settings → Family Plan.`;
}

class CapacityError extends Error {
  constructor(public used: number, public capacity: number) {
    super('plan_at_capacity');
  }
}
class RateLimitError extends Error {
  constructor() { super('too_many_pending_invites'); }
}
class CodeGenerationError extends Error {
  constructor() { super('code_generation_failed'); }
}
class InviteNotFoundError extends Error {
  constructor() { super('invite_not_found'); }
}
class InviteExpiredError extends Error {
  constructor() { super('invite_expired'); }
}
class AlreadyOnPlanError extends Error {
  constructor() { super('already_on_plan'); }
}
class CantJoinOwnPlanError extends Error {
  constructor() { super('cannot_join_own_plan'); }
}
class NotOwnerError extends Error {
  constructor() { super('not_plan_owner'); }
}
class TargetNotMemberError extends Error {
  constructor() { super('target_not_plan_member'); }
}
class TransferNotFoundError extends Error {
  constructor() { super('transfer_not_found'); }
}
class TransferExpiredError extends Error {
  constructor() { super('transfer_expired'); }
}
class TransferAlreadyAcceptedError extends Error {
  constructor() { super('transfer_already_accepted'); }
}
class TransferNotForYouError extends Error {
  constructor() { super('transfer_not_for_you'); }
}
class TransferMembershipStaleError extends Error {
  constructor() { super('transfer_membership_stale'); }
}
