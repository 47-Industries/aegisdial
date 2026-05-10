import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { normalizeE164 } from '../lib/phone.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { emitMetric } from '../lib/observability.js';

// Live Shield v3 — A1 lookup routes.
//
// Three endpoints:
//
//   GET /v1/lookup/pre-call-risk?e164=X
//     Quick yes/no — is this number in the hot-numbers cache?
//     iOS Call Directory Extension uses the cache snapshot for the
//     identification entry, but the host app calls this on receiving
//     a push notification to confirm the warning is still warranted
//     (the cache could have moved between sync + the call landing).
//
//   GET /v1/lookup/sources?e164=X
//     Full sources panel data — array of mentions with provenance.
//     Powers the hero UI of A1 (the panel that slides up on tap).
//     Returns up to 50 mentions sorted by recency × severity.
//
//   GET /v1/lookup/cache-snapshot?since=<ts>
//     Diff-update endpoint for the iOS Call Directory Extension's
//     local cache. Returns the snapshot of qualified numbers since
//     the timestamp; without `since`, the full cache is returned.
//
// Cache-miss policy (locked in spec): /pre-call-risk returns
// { in_cache: false } for unknown numbers. We do NOT fall through to
// liveCrawlUnknown synchronously — that would create unbounded latency
// during a ringing call. The hot-numbers populator is the path that
// converts unknown → cached over time as crawler data accumulates.

export async function lookupRoutes(app: FastifyInstance): Promise<void> {
  if (!config.V3_A1_ENABLED) {
    return;
  }

  // -------------------------------------------------------------------------
  // GET /v1/lookup/pre-call-risk?e164=X
  // -------------------------------------------------------------------------

  app.get(
    '/v1/lookup/pre-call-risk',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const start = Date.now();
      const e164Raw = (req.query as { e164?: string }).e164;
      if (!e164Raw) {
        return reply.code(400).send({ error: 'missing_e164' });
      }
      const e164 = normalizeE164(e164Raw);
      if (!e164) {
        return reply.code(400).send({ error: 'invalid_phone_number' });
      }

      const cached = await query<{
        risk_weight: number;
        mention_count: number;
        primary_sources: string[];
        last_recomputed_at: Date;
      }>(
        `SELECT risk_weight, mention_count, primary_sources, last_recomputed_at
           FROM a1_hot_numbers
          WHERE e164 = $1`,
        [e164],
      );

      const latency_ms = Date.now() - start;
      emitMetric('v3.a1.cache_lookup', {
        in_cache: cached.rows.length > 0,
      }, latency_ms);

      if (cached.rows.length === 0) {
        return reply.send({ in_cache: false, e164 });
      }

      const row = cached.rows[0]!;
      return reply.send({
        in_cache: true,
        e164,
        risk_weight: row.risk_weight,
        mention_count: row.mention_count,
        primary_sources: row.primary_sources,
        snapshot_at: row.last_recomputed_at.toISOString(),
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/lookup/sources?e164=X
  // -------------------------------------------------------------------------
  //
  // Returns mentions for the sources panel. Filters to the most
  // credible (severity ≥ 3) and most recent (90 days) so Mom isn't
  // overwhelmed by a long list of stale low-confidence reports.
  // Cap at 50 entries — anything beyond that is renderer overload.

  app.get(
    '/v1/lookup/sources',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const e164Raw = (req.query as { e164?: string }).e164;
      if (!e164Raw) {
        return reply.code(400).send({ error: 'missing_e164' });
      }
      const e164 = normalizeE164(e164Raw);
      if (!e164) {
        return reply.code(400).send({ error: 'invalid_phone_number' });
      }

      const mentions = await query<{
        source: string;
        source_ref: string | null;
        url: string | null;
        snippet: string | null;
        sentiment: string | null;
        scam_category: string | null;
        severity: number | null;
        observed_at: Date | null;
        created_at: Date;
      }>(
        `SELECT source, source_ref, url, snippet, sentiment, scam_category,
                severity, observed_at, created_at
           FROM mentions
          WHERE e164 = $1
            AND COALESCE(severity, 0) >= 3
            AND created_at > NOW() - INTERVAL '90 days'
          ORDER BY COALESCE(severity, 0) DESC, created_at DESC
          LIMIT 50`,
        [e164],
      );

      emitMetric('v3.a1.sources_panel_data_returned', {
        count: mentions.rows.length,
      });

      return reply.send({
        e164,
        sources: mentions.rows.map((m) => ({
          source: m.source,
          source_ref: m.source_ref,
          url: m.url,
          snippet: m.snippet,
          sentiment: m.sentiment,
          scam_category: m.scam_category,
          severity: m.severity,
          observed_at: (m.observed_at ?? m.created_at).toISOString(),
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/lookup/cache-snapshot?since=<ts>
  // -------------------------------------------------------------------------
  //
  // Diff-sync endpoint for the iOS Call Directory Extension. Without
  // `since`, returns the full cache (the bootstrap path). With `since`,
  // returns rows updated after that timestamp + a `removed` array for
  // any e164 that fell out of the cache since then.
  //
  // The extension uses this to keep its on-device list current. Apple's
  // CallKit identification entries are uncapped, so we don't have to
  // worry about size — just freshness.

  app.get(
    '/v1/lookup/cache-snapshot',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const since = (req.query as { since?: string }).since;
      const sinceDate = since ? new Date(since) : null;
      if (since && (!sinceDate || Number.isNaN(sinceDate.getTime()))) {
        return reply.code(400).send({ error: 'invalid_since_timestamp' });
      }

      // Current cache contents.
      const current = await query<{
        e164: string;
        risk_weight: number;
        primary_sources: string[];
        last_recomputed_at: Date;
      }>(
        sinceDate
          ? `SELECT e164, risk_weight, primary_sources, last_recomputed_at
               FROM a1_hot_numbers
              WHERE last_recomputed_at > $1
              ORDER BY risk_weight DESC`
          : `SELECT e164, risk_weight, primary_sources, last_recomputed_at
               FROM a1_hot_numbers
              ORDER BY risk_weight DESC`,
        sinceDate ? [sinceDate] : [],
      );

      // Removed entries: numbers that WOULD have been in a since-aware
      // sync but are no longer in the cache. The populator's stale
      // sweep deletes rows that don't qualify, so we don't currently
      // have a deletion log — the extension handles this by
      // periodically requesting a full snapshot (since omitted) to
      // resync. v3.5 adds an explicit deletion log for tighter sync.
      const removed: string[] = [];

      emitMetric('v3.a1.cache_snapshot_served', {
        full_snapshot: !sinceDate,
        rows_returned: current.rows.length,
      });

      return reply.send({
        snapshot_at: new Date().toISOString(),
        added_or_updated: current.rows.map((r) => ({
          e164: r.e164,
          risk_weight: r.risk_weight,
          primary_sources: r.primary_sources,
          updated_at: r.last_recomputed_at.toISOString(),
        })),
        removed,
      });
    },
  );
}
