import cron from 'node-cron';
import { captureError } from '../lib/observability.js';
import {
  runDailyAnalystPass,
  generateQuarterlyBriefing,
} from '../services/identity/threatLandscapeAnalyst.js';

// Identity Shield I-P6 — AI threat-landscape meta-analyst cron worker.
//
// Two crons, both running in the main app process (the analyst loop
// is bounded: ~200-row SELECT + ~50-channel iteration per day; nowhere
// near the long-running shape of the Telegram listener).
//
//   - Daily cron `0 5 * * *` — 05:00 UTC. AFTER the Telegram listener
//     + darknet crawler have done their morning runs, so the
//     active_threats and threat_intel_candidates tables are warmed
//     with last 24h of signal.
//
//   - Quarterly cron `0 6 1 1,4,7,10 *` — 06:00 UTC on Jan 1, Apr 1,
//     Jul 1, Oct 1. Generates the briefing for the prior quarter
//     (the analyst service computes the (period_start, period_end)
//     range itself; this cron just triggers the call).
//
// SCAFFOLD SEMANTICS (today, 2026-05-12, pre-seed-load):
// threat_intel_channels is EMPTY. The daily pass SELECTs zero
// active_threats with telegram_channel:/darknet_market: provenance
// AND zero active channels for re-tagging — no LLM calls fire. The
// quarterly briefing pulls all-zero metrics and writes a 200-word
// "this quarter we were not yet in market" row. Both are valid
// no-throw paths.
//
// Same shape as retentionSweeper.ts: returns a handle the test
// harness / SIGTERM handler can stop cleanly. The handle exposes
// BOTH scheduled tasks so the caller doesn't have to track them
// separately.

const DAILY_CRON = '0 5 * * *';
const QUARTERLY_CRON = '0 6 1 1,4,7,10 *';

export interface AnalystWorkerHandle {
  dailyTask: cron.ScheduledTask;
  quarterlyTask: cron.ScheduledTask;
}

let startupLogEmitted = false;

export function startThreatLandscapeAnalyst(): AnalystWorkerHandle {
  if (!startupLogEmitted) {
    // eslint-disable-next-line no-console
    console.log(
      '[threat-landscape-analyst] starting — daily 05:00 UTC, quarterly Q+1 day 1 06:00 UTC.',
    );
    startupLogEmitted = true;
  }

  const dailyTask = cron.schedule(
    DAILY_CRON,
    () => {
      void (async () => {
        const started = Date.now();
        try {
          const result = await runDailyAnalystPass();
          // eslint-disable-next-line no-console
          console.log('[threat-landscape-analyst] daily pass complete', {
            duration_ms: Date.now() - started,
            ...result,
          });
        } catch (err) {
          captureError(err, {
            component: 'threatLandscapeAnalystWorker.dailyCronCallback',
          });
        }
      })();
    },
    { timezone: 'UTC' },
  );

  const quarterlyTask = cron.schedule(
    QUARTERLY_CRON,
    () => {
      void (async () => {
        const started = Date.now();
        try {
          const result = await generateQuarterlyBriefing();
          // eslint-disable-next-line no-console
          console.log('[threat-landscape-analyst] quarterly briefing complete', {
            duration_ms: Date.now() - started,
            ...result,
          });
        } catch (err) {
          captureError(err, {
            component: 'threatLandscapeAnalystWorker.quarterlyCronCallback',
          });
        }
      })();
    },
    { timezone: 'UTC' },
  );

  return { dailyTask, quarterlyTask };
}

export function stopThreatLandscapeAnalyst(handle: AnalystWorkerHandle): void {
  handle.dailyTask.stop();
  handle.quarterlyTask.stop();
}

/** Test-only — reset the startup-log gate between tests. */
export function _resetStartupLogForTests(): void {
  startupLogEmitted = false;
}
