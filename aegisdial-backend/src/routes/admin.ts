import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireBearer } from '../lib/auth.js';
import { buildCrawlers, runCrawlerOnce, getLastResults } from '../workers/scheduler.js';
import { verifyAllSpoofTargets } from '../workers/spoofTargetVerifier.js';
import { rescoreStale, rescoreNumber } from '../crawlers/rescore.js';
import { normalizeE164 } from '../lib/phone.js';
import { query } from '../lib/db.js';
import { readMetrics } from '../lib/observability.js';
import { currentTier, ensureTierPersisted } from '../lib/subscription.js';

// Kyle manually grants 30-day Recovery Pro windows to users he meets via
// r/Scams, AARP partnerships, conference floors, press, etc. This endpoint
// bypasses StoreKit entirely by writing a subscription row with the new
// `admin_grant` provider. currentTier() is provider-agnostic (reads status +
// current_period_end only) so the grant lights up every Pro surface with no
// other code change. NOT idempotent by design — each call creates a new row.
const RECOVERY_GRANT_SCHEMA = z
  .object({
    email: z.string().email().optional(),
    user_id: z.string().uuid().optional(),
    days: z.number().int().optional(),
    reason: z.string().max(500).optional(),
  })
  .refine(
    (v) => (v.email !== undefined) !== (v.user_id !== undefined),
    { message: 'exactly_one_of_email_or_user_id' },
  );

const RECOVERY_GRANT_PRODUCT_ID = 'com.fortyseven.aegisdial.recovery.session';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Metric counters dashboard — supports ?hours=1 and ?name=foo.
  // Rolled up in-memory to give a quick "how's the system right now" view.
  app.get('/admin/metrics', { preHandler: requireBearer }, async (req, reply) => {
    const q = req.query as { hours?: string; name?: string };
    const hours = q.hours ? parseInt(q.hours, 10) : 24;
    const rows = await readMetrics({ hours, name: q.name });
    // Also compute rolled-up totals per (name, tags) so operators
    // don't have to sum buckets by hand.
    const totals: Record<string, number> = {};
    for (const r of rows) {
      const key = `${r.name}|${JSON.stringify(r.tags)}`;
      totals[key] = (totals[key] ?? 0) + Number(r.value);
    }
    return reply.send({ hours, rows, totals });
  });

  app.get('/admin/crawlers', { preHandler: requireBearer }, async (_req, reply) => {
    const crawlers = buildCrawlers().map((c) => ({
      name: c.name,
      enabled: c.enabled,
      cron: c.cronExpr,
    }));
    return reply.send({ crawlers, last: getLastResults() });
  });

  app.post('/admin/crawlers/:name/run', { preHandler: requireBearer }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const crawler = buildCrawlers().find((c) => c.name === name);
    if (!crawler) return reply.code(404).send({ error: 'unknown_crawler' });
    const result = await runCrawlerOnce(crawler);
    return reply.send(result);
  });

  // Trigger the daily verifier on demand. Returns a summary of drift +
  // failures so a human can investigate before the next scheduled run.
  app.post(
    '/admin/spoof-targets/verify',
    { preHandler: requireBearer },
    async (_req, reply) => {
      const report = await verifyAllSpoofTargets();
      return reply.send({
        started_at: report.started_at.toISOString(),
        finished_at: report.finished_at.toISOString(),
        duration_ms: report.duration_ms,
        targets_checked: report.targets_checked,
        targets_skipped_no_url: report.targets_skipped_no_url,
        drift_count: report.drift_count,
        failed_count: report.failed_count,
        rows: report.rows.map((r) => ({
          target_name: r.target_name,
          contact_url: r.contact_url,
          status: r.status,
          http_status: r.http_status,
          drift_missing: r.numbers_drift_missing,
          drift_new: r.numbers_drift_new,
          error: r.error_message,
        })),
      });
    },
  );

  // Trigger verification for ONE entry by name. Useful when you just added
  // or edited a single contact_urls entry and want immediate feedback.
  app.post(
    '/admin/spoof-targets/verify/:name',
    { preHandler: requireBearer },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      // Intentionally re-use the main verifier + filter — a 3-target filtered
      // version isn't worth the duplicated code.
      const report = await verifyAllSpoofTargets();
      const matches = report.rows.filter(
        (r) => r.target_name.toLowerCase() === decodeURIComponent(name).toLowerCase(),
      );
      if (matches.length === 0) {
        return reply.code(404).send({ error: 'target_not_found_or_no_contact_urls' });
      }
      return reply.send({ rows: matches });
    },
  );

  // Latest verification status per target — what an operator pulls up to
  // see "is anything currently drifted?" without re-running the full job.
  app.get(
    '/admin/spoof-targets/report',
    { preHandler: requireBearer },
    async (_req, reply) => {
      const rows = await query<{
        target_name: string;
        target_category: string;
        contact_url: string;
        fetched_at: Date;
        http_status: number | null;
        numbers_drift_missing: string[];
        numbers_drift_new: string[];
        status: string;
        error_message: string | null;
      }>(
        `SELECT DISTINCT ON (target_name, contact_url)
           target_name, target_category, contact_url, fetched_at,
           http_status, numbers_drift_missing, numbers_drift_new,
           status, error_message
         FROM spoof_target_verifications
         ORDER BY target_name, contact_url, fetched_at DESC`,
      );
      const drift = rows.rows.filter((r) => r.status === 'drift');
      const failed = rows.rows.filter((r) => r.status === 'fetch_failed');
      const verified = rows.rows.filter((r) => r.status === 'verified').length;
      return reply.send({
        summary: {
          total_verifications: rows.rows.length,
          verified,
          drift: drift.length,
          failed: failed.length,
        },
        drifted: drift,
        failed,
      });
    },
  );

  // Manually grant a 30-day Recovery Pro window. Bypasses StoreKit. Used
  // when Kyle meets a scam victim on r/Scams / AARP / press / conferences
  // and wants to hand them the app for free. Exactly one of email/user_id
  // required. days defaults to 30, clamped to [1, 365]. Creates a new
  // subscriptions row per call — duplicate calls are intentionally NOT
  // deduped; currentTier() picks the row with the latest period_end.
  app.post('/admin/recovery/grant', { preHandler: requireBearer }, async (req, reply) => {
    const parsed = RECOVERY_GRANT_SCHEMA.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const body = parsed.data;

    // Clamp days to [1, 365]. Default 30 matches the existing Recovery SKU.
    const rawDays = body.days ?? 30;
    const days = Math.max(1, Math.min(365, Math.trunc(rawDays)));

    // Resolve to a users.id. Email match is case-insensitive.
    let userId: string | null = null;
    if (body.user_id) {
      const r = await query<{ id: string }>(
        `SELECT id FROM users WHERE id = $1 LIMIT 1`,
        [body.user_id],
      );
      userId = r.rows[0]?.id ?? null;
    } else if (body.email) {
      const r = await query<{ id: string }>(
        `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [body.email],
      );
      userId = r.rows[0]?.id ?? null;
    }
    if (!userId) return reply.code(404).send({ error: 'user_not_found' });

    // Insert a fresh subscription row. provider_transaction_id is unique per
    // call so the UNIQUE(provider, provider_transaction_id) constraint on
    // subscriptions never collides. Appending 8 random hex chars guards the
    // edge case where two rapid-fire calls land in the same millisecond.
    const grantedAt = Date.now();
    const providerTransactionId = `admin-grant-${userId}-${grantedAt}-${randomUUID().slice(0, 8)}`;
    const rawPayload = JSON.stringify({
      granted_by: 'admin',
      reason: body.reason ?? null,
    });

    const insertRes = await query<{
      current_period_start: Date;
      current_period_end: Date;
    }>(
      `INSERT INTO subscriptions (
         user_id, provider, provider_product_id, provider_transaction_id,
         status, current_period_start, current_period_end, auto_renew, raw_payload
       ) VALUES (
         $1, 'admin_grant', $2, $3, 'active',
         NOW(), NOW() + ($4 || ' days')::INTERVAL, FALSE, $5::jsonb
       )
       RETURNING current_period_start, current_period_end`,
      [userId, RECOVERY_GRANT_PRODUCT_ID, providerTransactionId, String(days), rawPayload],
    );

    const periodEnd = insertRes.rows[0]?.current_period_end ?? null;

    // Reconcile the tier column so /users/me reads 'pro' immediately.
    await ensureTierPersisted(userId, await currentTier(userId));

    return reply.send({
      ok: true,
      user_id: userId,
      current_period_end: periodEnd instanceof Date
        ? periodEnd.toISOString()
        : periodEnd,
      days_granted: days,
    });
  });

  app.post('/admin/rescore', { preHandler: requireBearer }, async (req, reply) => {
    const body = (req.body ?? {}) as { number?: string; limit?: number };
    if (body.number) {
      const e164 = normalizeE164(body.number);
      if (!e164) return reply.code(400).send({ error: 'invalid_phone_number' });
      await rescoreNumber(e164);
      return reply.send({ rescored: 1, e164 });
    }
    const n = await rescoreStale(Math.min(body.limit ?? 100, 500));
    return reply.send({ rescored: n });
  });
}
