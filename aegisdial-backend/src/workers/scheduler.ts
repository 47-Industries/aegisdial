import cron from 'node-cron';
import { config } from '../config.js';
import { RedditCrawler } from '../crawlers/reddit.js';
import { Notes800Crawler } from '../crawlers/notes800.js';
import { FccCrawler } from '../crawlers/fcc.js';
import { BbbCrawler } from '../crawlers/bbb.js';
import { YouTubeCrawler } from '../crawlers/youtube.js';
import { SerperCrawler } from '../crawlers/serper.js';
import { rescoreStale } from '../crawlers/rescore.js';
import { verifyAllSpoofTargets } from './spoofTargetVerifier.js';
import {
  startGuardianAlertEscalator,
  stopGuardianAlertEscalator,
  type EscalatorHandle,
} from './guardianAlertEscalator.js';
import { runCalibrationCheckSingleFlight } from './v4CalibrationAlerter.js';
import { captureMessage, emitMetric } from '../lib/observability.js';
import type { Crawler, CrawlResult } from '../crawlers/types.js';

export interface ScheduledCrawler {
  crawler: Crawler;
  task: cron.ScheduledTask;
  lastResult?: CrawlResult;
  running: boolean;
}

export interface SchedulerHandles {
  crawlers: ScheduledCrawler[];
  rescorerTask: cron.ScheduledTask;
  spoofVerifierTask: cron.ScheduledTask;
  guardianEscalator: EscalatorHandle;
  v4CalibrationTask: cron.ScheduledTask;
}

export function buildCrawlers(): Crawler[] {
  return [
    new RedditCrawler(),
    new Notes800Crawler(),
    new FccCrawler(),
    new BbbCrawler(),
    new YouTubeCrawler(),
    new SerperCrawler(),
  ];
}

const running = new Map<string, boolean>();
const lastResult = new Map<string, CrawlResult>();

export async function runCrawlerOnce(crawler: Crawler): Promise<CrawlResult> {
  if (running.get(crawler.name)) {
    console.log(`[crawler:${crawler.name}] skip — already running`);
    return {
      source: crawler.name,
      fetched: 0,
      mentioned_numbers: 0,
      inserted: 0,
      skipped: 0,
      errors: 0,
      duration_ms: 0,
    };
  }
  running.set(crawler.name, true);
  const start = performance.now();
  try {
    console.log(`[crawler:${crawler.name}] start`);
    const result = await crawler.run();
    lastResult.set(crawler.name, result);
    console.log(
      `[crawler:${crawler.name}] done fetched=${result.fetched} mentions=${result.mentioned_numbers} inserted=${result.inserted} skipped=${result.skipped} errors=${result.errors} ${result.duration_ms}ms`,
    );
    return result;
  } catch (err) {
    console.error(`[crawler:${crawler.name}] failed`, err);
    return {
      source: crawler.name,
      fetched: 0,
      mentioned_numbers: 0,
      inserted: 0,
      skipped: 0,
      errors: 1,
      duration_ms: Math.round(performance.now() - start),
    };
  } finally {
    running.set(crawler.name, false);
  }
}

export function startScheduler(): SchedulerHandles {
  const crawlers = buildCrawlers();
  const scheduled: ScheduledCrawler[] = [];

  for (const c of crawlers) {
    if (!c.enabled) {
      console.log(`[scheduler] skip ${c.name} (disabled — missing credentials)`);
      continue;
    }
    const task = cron.schedule(c.cronExpr, async () => {
      await runCrawlerOnce(c);
    });
    scheduled.push({ crawler: c, task, running: false });
    console.log(`[scheduler] scheduled ${c.name} @ "${c.cronExpr}"`);
  }

  const rescorerTask = cron.schedule('*/5 * * * *', async () => {
    try {
      const n = await rescoreStale(200);
      if (n > 0) console.log(`[rescorer] rescored ${n} numbers`);
    } catch (err) {
      console.error('[rescorer] failed', err);
    }
  });
  console.log('[scheduler] rescorer @ every 5 min');

  // Daily at 03:17 UTC: verify every HIGH_SPOOF_TARGETS entry that has a
  // contact_urls list. A wrong number in the registry would mark a scammer
  // call as "trusted" — this job is the tripwire.
  const spoofVerifierTask = cron.schedule('17 3 * * *', async () => {
    try {
      const r = await verifyAllSpoofTargets();
      console.log(
        `[spoof-verify] cron done — ${r.targets_checked} checked, ${r.drift_count} drift, ${r.failed_count} failed, ${r.duration_ms}ms`,
      );
    } catch (err) {
      console.error('[spoof-verify] cron failed', err);
    }
  });
  console.log('[scheduler] spoof-verify @ 03:17 UTC daily');

  if (config.ENABLE_CRAWLERS && process.env.CRAWLER_RUN_ON_BOOT !== 'false') {
    setTimeout(() => {
      (async () => {
        for (const c of crawlers) {
          if (c.enabled) await runCrawlerOnce(c);
        }
      })().catch((err) => console.error('[scheduler] initial run failed', err));
    }, 3000);
  }

  // Run the spoof-target verifier 30s after boot so newly-added contact_urls
  // get checked immediately on deploy. Gated by SPOOF_VERIFY_ON_BOOT=false
  // for dev ergonomics (we don't want every local restart to spam Equifax).
  if (process.env.SPOOF_VERIFY_ON_BOOT !== 'false') {
    setTimeout(() => {
      verifyAllSpoofTargets()
        .then((r) => {
          console.log(
            `[spoof-verify] boot-run done — ${r.targets_checked} checked, ${r.drift_count} drift, ${r.failed_count} failed, ${r.duration_ms}ms`,
          );
        })
        .catch((err) => console.error('[spoof-verify] boot-run failed', err));
    }, 30_000);
  }

  // Guardian critical-alert SMS escalator. Independent of the crawlers
  // — it only touches guardian_alerts + Twilio Messages — but lives on
  // the shared scheduler lifecycle so start/stop stays centralized.
  const guardianEscalator = startGuardianAlertEscalator();

  // Live Shield v4 — Phase 16 — calibration alerter. Runs hourly,
  // compares the current scorecard verdict against the previous
  // snapshot in Redis, emits a Sentry message + metric on
  // regression. Suppressed when V4_PLAYBOOK_AWARE_ENABLED is off
  // (the worker itself checks and short-circuits — same defense as
  // Phase 1 subscriber install).
  const v4CalibrationTask = cron.schedule('27 * * * *', async () => {
    try {
      const r = await runCalibrationCheckSingleFlight();
      if ('error' in r) {
        console.error('[v4-calibration] check returned error', r.error);
      } else if ('skipped' in r) {
        // Another instance ran it; that's the whole point of the lock.
        // Silent at INFO, surfaced via metric for visibility.
      } else if (r.regression.severity !== 'none') {
        console.log(
          `[v4-calibration] ${r.regression.severity}: ${r.regression.reason}`,
        );
      }
    } catch (err) {
      // L-6 adversarial fix — the inner runCalibrationCheck already
      // catches its own errors and returns {error}, so reaching this
      // outer catch means something REALLY broke (import failure,
      // OOM, etc). Make sure it leaves a trail.
      emitMetric('v4.scorecard.cron_task_failed', {});
      captureMessage('[v4-calibration] cron task threw', 'error');
      console.error('[v4-calibration] task threw', err);
    }
  });
  console.log('[scheduler] v4-calibration @ minute 27 hourly');

  return {
    crawlers: scheduled,
    rescorerTask,
    spoofVerifierTask,
    guardianEscalator,
    v4CalibrationTask,
  };
}

export function stopScheduler(s: SchedulerHandles): void {
  for (const { task } of s.crawlers) task.stop();
  s.rescorerTask.stop();
  s.spoofVerifierTask.stop();
  stopGuardianAlertEscalator(s.guardianEscalator);
  s.v4CalibrationTask.stop();
}

export function getLastResults(): Record<string, CrawlResult | undefined> {
  const out: Record<string, CrawlResult | undefined> = {};
  for (const [k, v] of lastResult.entries()) out[k] = v;
  return out;
}
