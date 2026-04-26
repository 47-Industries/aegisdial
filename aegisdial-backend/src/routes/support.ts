import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { optionalAppUser } from '../lib/auth.js';
import { sendEmail } from '../lib/email.js';
import { track } from '../lib/analytics.js';
import { encryptString } from '../lib/crypto.js';

// In-app support contact. Writes a ticket row + emails the ops address
// so a human sees it. Works for both signed-in and signed-out users
// (signed-out falls back to the email in the body).

const SCHEMA = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  category: z.enum(['question','bug','billing','feature','other']).optional(),
  email: z.string().email().optional(),
  app_version: z.string().max(40).optional(),
  device_model: z.string().max(80).optional(),
  ios_version: z.string().max(40).optional(),
});

export async function supportRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/support/contact',
    // Use optionalAppUser — anyone can file a ticket, but attribute to
    // the user row when we have it.
    //
    // Rate-limit is dual-tier:
    //   - anonymous (no JWT)   → 3/hour per IP
    //   - authenticated (JWT)  → 20/hour per user
    // The unauthed path is the abuse surface — open internet, no auth,
    // writes a row + fires a real email to ops inbox. 3/hr/IP is still
    // plenty for a confused user retrying + typo'ing the captcha, but
    // shuts down a scripted spam flood. Authed users get a much higher
    // ceiling because we can attribute + ban at the account level.
    {
      preHandler: [optionalAppUser],
      config: {
        rateLimit: {
          max: (req) => (req.appUser ? 20 : 3),
          timeWindow: '1 hour',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const parsed = SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const userId = req.appUser?.id ?? null;
      const email =
        parsed.data.email ??
        (userId
          ? (
              await query<{ email: string | null }>(
                `SELECT email FROM users WHERE id = $1`,
                [userId],
              )
            ).rows[0]?.email ?? null
          : null);

      if (!email && !userId) {
        return reply.code(400).send({
          error: 'email_required',
          message: 'We need an email address to reply to you.',
        });
      }

      // Subject + body + email are all envelope-encrypted at rest.
      // The forwarded ops email below still carries the plaintext so
      // staff can triage + reply without DB access. We keep the legacy
      // `email` plaintext column populated during the transitional
      // window (migration 032 is additive; a follow-up drops the
      // plaintext column) so /auth/export and the admin surface keep
      // resolving the reply-to address.
      const emailCt = email ? encryptString(email) : null;
      const ins = await query<{ id: string }>(
        `INSERT INTO support_tickets
            (user_id, email, email_ct, subject, subject_ct, body, body_ct, category,
             app_version, device_model, ios_version)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING id`,
        [
          userId,
          email,
          emailCt,
          '',
          encryptString(parsed.data.subject),
          '',
          encryptString(parsed.data.body),
          parsed.data.category ?? 'other',
          parsed.data.app_version ?? null,
          parsed.data.device_model ?? null,
          parsed.data.ios_version ?? null,
        ],
      );
      const ticketId = ins.rows[0]!.id;

      // Forward to ops inbox.
      void sendEmail({
        userId,
        to: 'support@aegisdial.com',
        template: 'support_ticket_forward',
        data: {
          ticket_id: ticketId,
          from_email: email,
          from_user_id: userId,
          subject: parsed.data.subject,
          body: parsed.data.body,
          category: parsed.data.category ?? 'other',
          app_version: parsed.data.app_version,
          device_model: parsed.data.device_model,
          ios_version: parsed.data.ios_version,
        },
      });

      void track('support_ticket_filed', {
        userId,
        properties: { category: parsed.data.category ?? 'other' },
      });

      return reply.send({ ticket_id: ticketId, status: 'open' });
    },
  );
}
