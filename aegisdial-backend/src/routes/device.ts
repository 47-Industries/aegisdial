import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { requireAppUser } from '../lib/auth.js';

// Device registration. The iOS app POSTs its APNs push token here
// after the user grants notification permission. Same device can
// come back multiple times (Apple rotates tokens on reinstall, OS
// upgrades, etc.) — we upsert on (user_id, apns_token).

const REGISTER_SCHEMA = z.object({
  apns_token: z.string().min(32).max(200),
  bundle_id: z.string().optional().default('com.aegisdial.ios'),
  environment: z.enum(['sandbox', 'production']).optional().default('sandbox'),
  device_model: z.string().max(80).optional(),
  app_version: z.string().max(40).optional(),
});

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/device/register',
    { preHandler: [requireAppUser] },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = REGISTER_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const res = await query<{ id: string }>(
        `INSERT INTO device_tokens
           (user_id, apns_token, bundle_id, environment, device_model, app_version)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, apns_token)
           DO UPDATE SET
             bundle_id = EXCLUDED.bundle_id,
             environment = EXCLUDED.environment,
             device_model = EXCLUDED.device_model,
             app_version = EXCLUDED.app_version,
             last_seen_at = NOW(),
             invalidated_at = NULL
         RETURNING id`,
        [
          user.id,
          parsed.data.apns_token,
          parsed.data.bundle_id,
          parsed.data.environment,
          parsed.data.device_model ?? null,
          parsed.data.app_version ?? null,
        ],
      );
      return reply.send({ device_id: res.rows[0]!.id });
    },
  );

  app.post(
    '/v1/device/unregister',
    { preHandler: [requireAppUser] },
    async (req, reply) => {
      const user = req.appUser!;
      const schema = z.object({ apns_token: z.string().min(1) });
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      await query(
        `UPDATE device_tokens SET invalidated_at = NOW()
          WHERE user_id = $1 AND apns_token = $2`,
        [user.id, parsed.data.apns_token],
      );
      return reply.send({ unregistered: true });
    },
  );
}
