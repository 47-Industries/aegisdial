import type { FastifyInstance } from 'fastify';
import { query } from '../lib/db.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';

// Scam heatmap endpoint. Returns per-state aggregate counts from the
// pre-computed rollup table. Pro-gated because the insight value is
// the same consumer-signal we're selling.
//
// v1: US only (51 rows). v2 will add ZIP-level for California / Texas
// where our user density justifies the extra storage cost.

export async function heatmapRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/scams/heatmap',
    { preHandler: [requireAppUser, requireProTier] },
    async (_req, reply) => {
      const rows = await query<{
        region_code: string;
        region_name: string;
        lat: number;
        lng: number;
        reports_30d: number;
        reports_all_time: number;
        top_scam_category: string | null;
      }>(
        `SELECT region_code, region_name, lat, lng, reports_30d,
                reports_all_time, top_scam_category
           FROM scam_heatmap_regions
          ORDER BY reports_30d DESC`,
      );

      // Compute max so clients can normalize opacity.
      const max30d = rows.rows.reduce(
        (acc, r) => (r.reports_30d > acc ? r.reports_30d : acc),
        0,
      );

      return reply.send({
        regions: rows.rows,
        max_reports_30d: max30d,
        generated_at: new Date().toISOString(),
      });
    },
  );
}
