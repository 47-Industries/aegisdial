import type { FastifyInstance } from 'fastify';
import { query } from '../lib/db.js';
import { requireAppUser } from '../lib/auth.js';

// Engagement stats. The #1 retention hook for subscription safety
// apps ("you avoided 12 scams this week") — without this users
// forget the app is working. LifeLock's dashboard shows this
// prominently; we do the same.
//
// Cheap queries: every column is already indexed by user_id + time.
// Result size is constant, so rate-limiting isn't required.

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/stats/summary',
    { preHandler: [requireAppUser] },
    async (req, reply) => {
      const user = req.appUser!;

      const [
        shieldsThisWeek,
        criticalAvoided30d,
        breachesFound30d,
        smsJunkedAllTime,
        criticalAllTime,
      ] = await Promise.all([
        query<{ count: string }>(
          `SELECT COUNT(*)::TEXT AS count FROM call_sessions
            WHERE user_id = $1 AND started_at > NOW() - INTERVAL '7 days'`,
          [user.id],
        ),
        query<{ count: string }>(
          `SELECT COUNT(*)::TEXT AS count FROM call_sessions
            WHERE user_id = $1
              AND started_at > NOW() - INTERVAL '30 days'
              AND risk_level = 'critical'`,
          [user.id],
        ),
        query<{ count: string }>(
          `SELECT COUNT(*)::TEXT AS count FROM breach_alerts
            WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'`,
          [user.id],
        ),
        query<{ count: string }>(
          `SELECT COUNT(*)::TEXT AS count FROM sms_classifications
            WHERE user_id = $1 AND action = 'junk'`,
          [user.id],
        ),
        query<{ count: string }>(
          `SELECT COUNT(*)::TEXT AS count FROM call_sessions
            WHERE user_id = $1 AND risk_level = 'critical'`,
          [user.id],
        ),
      ]);

      return reply.send({
        shields_this_week: Number(shieldsThisWeek.rows[0]!.count),
        critical_calls_avoided_30d: Number(criticalAvoided30d.rows[0]!.count),
        breaches_found_30d: Number(breachesFound30d.rows[0]!.count),
        scams_blocked_all_time:
          Number(smsJunkedAllTime.rows[0]!.count) +
          Number(criticalAllTime.rows[0]!.count),
      });
    },
  );
}
