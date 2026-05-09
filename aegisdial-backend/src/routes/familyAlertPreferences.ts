import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { requireAppUser } from '../lib/auth.js';
import type { PrivacyLevel } from '../services/liveShieldFamilyAlert.js';

// Live Shield v2: Mom-controlled privacy level for family-plan alerts.
//
// GET  /v1/family-alert/preferences — returns the user's current level
// PUT  /v1/family-alert/preferences — sets the level
//
// Three levels (locked in LIVE_SHIELD.md):
//   minimal — risk score + scam type only
//   default — adds the matched red-flag phrases (≤5)
//   open    — adds a transcript view link family can open
//
// Default for users who haven't picked is 'default' — the middle ground.

const PRIVACY_LEVELS = ['minimal', 'default', 'open'] as const;

const PUT_SCHEMA = z.object({
  privacy_level: z.enum(PRIVACY_LEVELS),
});

export async function familyAlertPreferencesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/family-alert/preferences',
    { preHandler: [requireAppUser] },
    async (req, reply) => {
      const user = req.appUser!;
      const row = await query<{ privacy_level: PrivacyLevel }>(
        `SELECT privacy_level FROM family_alert_preferences WHERE user_id = $1`,
        [user.id],
      );
      return reply.send({
        privacy_level: row.rows[0]?.privacy_level ?? 'default',
        is_default: row.rows.length === 0,
      });
    },
  );

  app.put(
    '/v1/family-alert/preferences',
    { preHandler: [requireAppUser] },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = PUT_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      // Upsert — creates the row on first set, overwrites on subsequent.
      await query(
        `INSERT INTO family_alert_preferences (user_id, privacy_level)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE
           SET privacy_level = EXCLUDED.privacy_level,
               updated_at = NOW()`,
        [user.id, parsed.data.privacy_level],
      );

      return reply.send({ privacy_level: parsed.data.privacy_level });
    },
  );
}
