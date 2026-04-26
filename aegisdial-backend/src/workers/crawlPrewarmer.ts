import cron from 'node-cron';
import { query } from '../lib/db.js';
import { config } from '../config.js';
import { liveCrawlUnknown } from '../services/liveCrawl.js';
import { lookupPhone } from '../services/phoneLookup.js';
import { emitMetric } from '../lib/observability.js';

// Verdict cache pre-warmer. Keeps hot numbers hot — so the 99th-percentile
// /v1/verdict request hits a warm row instead of paying for a live crawl.
//
// Trending = numbers seen in the last 48h whose score is either stale
// (>30 min old) or has never been computed. We pull the top 200 by
// last_seen DESC each tick and fan them out through the existing
// liveCrawlUnknown() + lookupPhone() paths. Both are single-flight-safe
// (Redis lock + TTL cache respectively), so if a real user request is
// mid-crawl we no-op and let theirs finish.
//
// Cron: hourly at :23 UTC. Staggered against scheduler.ts (:00, :05-ish
// rescorer, :17 spoof-verifier at 3am, :19 bulk-crime at 5am, :30 weekly
// breach-rescan) and retentionSweeper (:07 daily).

const HOURLY_CRON = '23 * * * *'; // every hour at :23 UTC
const BATCH_LIMIT = 200;
const CONCURRENCY = 6;

export interface CrawlPrewarmerHandle {
  task: cron.ScheduledTask;
}

export interface CrawlPrewarmResult {
  processed: number;
  crawled: number;
  looked_up: number;
}

export async function runCrawlPrewarmOnce(): Promise<CrawlPrewarmResult> {
  // Candidates: numbers last mentioned inside 48h with either no score yet
  // or a score older than 30 minutes. Index idx_numbers_last_seen covers
  // the ORDER BY; idx_numbers_score_computed covers the NULLS FIRST case.
  const rows = (
    await query<{ e164: string }>(
      `SELECT e164
         FROM numbers
        WHERE last_seen > NOW() - INTERVAL '48 hours'
          AND (score_computed_at IS NULL OR score_computed_at < NOW() - INTERVAL '30 minutes')
        ORDER BY last_seen DESC
        LIMIT $1`,
      [BATCH_LIMIT],
    )
  ).rows;

  let crawled = 0;
  let lookedUp = 0;
  let idx = 0;

  // Pool pattern mirrors breachRescanner: N workers share a cursor index.
  // liveCrawlUnknown() already holds a 30s Redis single-flight lock, so a
  // concurrent real-user verdict won't double-crawl; we'll just get empty
  // stats back and move on.
  async function worker(): Promise<void> {
    while (idx < rows.length) {
      const r = rows[idx++]!;
      try {
        const stats = await liveCrawlUnknown(r.e164);
        if (stats.sources_hit.length > 0) crawled += 1;
      } catch (err) {
        const { captureError } = await import('../lib/observability.js');
        captureError(err, { component: 'crawlPrewarmer', stage: 'live_crawl', e164: r.e164 });
      }
      // Paid-provider enrichment is gated — Twilio Lookup V2 / Ekata /
      // IPQS cost real money per call. At 200 rows/hr × $0.015 ≈ $72/day
      // if fired unconditionally. Only pre-warm when the operator has
      // explicitly opted in via ENABLE_CRAWL_PREWARM_LOOKUPS=true.
      if (config.ENABLE_CRAWL_PREWARM_LOOKUPS) {
        try {
          const info = await lookupPhone(r.e164);
          if (info) lookedUp += 1;
        } catch (err) {
          const { captureError } = await import('../lib/observability.js');
          captureError(err, { component: 'crawlPrewarmer', stage: 'lookup', e164: r.e164 });
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker()),
  );

  const result: CrawlPrewarmResult = {
    processed: rows.length,
    crawled,
    looked_up: lookedUp,
  };

  // One metric per counter per run — low cardinality, safe for the
  // dashboard. Fire-and-forget; emitMetric swallows its own errors.
  void emitMetric('crawl_prewarm.processed', {}, result.processed);
  void emitMetric('crawl_prewarm.crawled', {}, result.crawled);
  void emitMetric('crawl_prewarm.looked_up', {}, result.looked_up);

  return result;
}

export function startCrawlPrewarmer(): CrawlPrewarmerHandle {
  const task = cron.schedule(
    HOURLY_CRON,
    () => {
      void (async () => {
        const started = Date.now();
        const result = await runCrawlPrewarmOnce();
        // eslint-disable-next-line no-console
        console.log('[crawl-prewarmer] complete', {
          ...result,
          duration_ms: Date.now() - started,
        });
      })();
    },
    { timezone: 'UTC' },
  );
  return { task };
}

export function stopCrawlPrewarmer(handle: CrawlPrewarmerHandle): void {
  handle.task.stop();
}
