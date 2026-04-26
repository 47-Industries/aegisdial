import cron from 'node-cron';
import { query } from '../lib/db.js';
import { scanIdentifier } from '../services/breachScan.js';
import { readMaybeEncrypted } from '../lib/crypto.js';

// Weekly breach re-scanner. Walks every monitored identifier older than
// 6 days and runs it through Enzoic again. New exposures surface as new
// breach_alerts rows.
//
// Cron: Wednesdays at 04:30 UTC (mid-week US-evening/late-night so
// alerts land before morning). Batch-limits per run to avoid vendor
// rate-limit storms — we walk up to 500 identifiers per tick and
// resume next tick if more remain.

const WEEKLY_CRON = '30 4 * * 3'; // Wed 04:30 UTC
const BATCH_LIMIT = 500;

export interface RescannerHandle {
  task: cron.ScheduledTask;
}

export async function runBreachRescanOnce(): Promise<{
  processed: number;
  new_alerts: number;
}> {
  const stale = await query<{
    id: string;
    user_id: string;
    kind: 'email' | 'phone';
    display_value: string;
    display_value_ct: string | null;
  }>(
    `SELECT id, user_id, kind, display_value, display_value_ct
       FROM monitored_identifiers
      WHERE last_scanned_at IS NULL
         OR last_scanned_at < NOW() - INTERVAL '6 days'
      ORDER BY last_scanned_at NULLS FIRST
      LIMIT $1`,
    [BATCH_LIMIT],
  );
  // Concurrent scan with an 8-way pool. Each scanIdentifier() is ~300ms
  // of Enzoic HTTP time; serial was ~2.5 min for a full 500-row batch.
  // 8-way brings it to ~20s. Below Enzoic's documented rate limits.
  const CONCURRENCY = 8;
  const rows = stale.rows;
  let newAlerts = 0;
  let idx = 0;
  async function worker() {
    while (idx < rows.length) {
      const r = rows[idx++]!;
      try {
        const plain = readMaybeEncrypted(r.display_value_ct) ?? r.display_value;
        const report = await scanIdentifier(r.user_id, r.id, r.kind, plain);
        newAlerts += report.new_alerts;
      } catch (err) {
        const { captureError } = await import('../lib/observability.js');
        captureError(err, { component: 'breachRescanner', monitored_id: r.id });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker()),
  );
  return { processed: stale.rows.length, new_alerts: newAlerts };
}

export function startBreachRescanner(): RescannerHandle {
  const task = cron.schedule(
    WEEKLY_CRON,
    () => {
      void (async () => {
        const started = Date.now();
        const result = await runBreachRescanOnce();
        // eslint-disable-next-line no-console
        console.log('[breach-rescanner] complete', {
          ...result,
          duration_ms: Date.now() - started,
        });
      })();
    },
    { timezone: 'UTC' },
  );
  return { task };
}

export function stopBreachRescanner(handle: RescannerHandle): void {
  handle.task.stop();
}
