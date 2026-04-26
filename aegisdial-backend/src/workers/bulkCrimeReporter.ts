import cron from 'node-cron';
import { query } from '../lib/db.js';
import { captureError } from '../lib/observability.js';
import { readMaybeEncrypted, decryptInt } from '../lib/crypto.js';

// Bulk crime reporting. When N or more AegisDial users report the same
// scammer phone number in a 7-day window with matching scam_type, we
// aggregate them into a single consolidated IC3-ready report and stash
// it in bulk_crime_reports. This is the "AegisDial feeds FBI IC3 cases"
// narrative: LEO gets pattern-level data, not one-off complaints.
//
// The worker only AGGREGATES. Actual delivery to IC3 happens out-of-band
// (manual export by ops staff for now — automated API submission is a
// next-quarter project because IC3 has no programmatic intake).
//
// Cron: daily at 05:19 UTC. Threshold: 10 distinct users reporting the
// same scam_e164+scam_type in 7 days, unaggregated. Idempotent per key.

const DAILY_CRON = '19 5 * * *';
const MIN_REPORTS = 10;
const LOOKBACK_DAYS = 7;

export interface BulkReportsHandle {
  task: cron.ScheduledTask;
}

interface AggregatedGroup {
  scam_e164: string;     // decrypted from recovery_sessions.scam_e164_ct
  scam_type: string;
  distinct_users: number;
  first_seen: Date;
  last_seen: Date;
  total_amount_cents: number;
  session_ids: string[];
}

export async function runBulkCrimeReportOnce(): Promise<{
  groups_found: number;
  groups_written: number;
}> {
  // Pull every recovery_sessions row in the lookback window that has an
  // encrypted scam_e164. We decrypt in-app to group — storing the hash
  // of the decrypted number isn't worth the migration churn for this
  // daily batch job.
  const rows = await query<{
    id: string;
    user_id: string;
    scam_e164_ct: string | null;
    scam_type: string;
    amount_lost_cents: number | null;
    amount_lost_cents_ct: string | null;
    started_at: Date;
  }>(
    `SELECT id, user_id, scam_e164_ct, scam_type,
            amount_lost_cents, amount_lost_cents_ct, started_at
       FROM recovery_sessions
      WHERE started_at > NOW() - ($1 || ' days')::INTERVAL
        AND scam_e164_ct IS NOT NULL`,
    [String(LOOKBACK_DAYS)],
  );

  // Group by (plaintext phone + scam_type). Map<key, group>.
  const groups = new Map<string, AggregatedGroup & { user_ids: Set<string> }>();
  for (const r of rows.rows) {
    const plain = r.scam_e164_ct ? readMaybeEncrypted(r.scam_e164_ct) : null;
    if (!plain) continue;
    const key = `${plain}::${r.scam_type}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        scam_e164: plain,
        scam_type: r.scam_type,
        distinct_users: 0,
        first_seen: r.started_at,
        last_seen: r.started_at,
        total_amount_cents: 0,
        session_ids: [],
        user_ids: new Set(),
      };
      groups.set(key, g);
    }
    g.user_ids.add(r.user_id);
    g.session_ids.push(r.id);
    // Decrypt per-row amount for aggregation. Legacy rows with plaintext
    // amount_lost_cents and no ciphertext still contribute via fallback.
    const amt = decryptInt(r.amount_lost_cents_ct ?? null) ?? r.amount_lost_cents ?? 0;
    g.total_amount_cents += amt;
    if (r.started_at < g.first_seen) g.first_seen = r.started_at;
    if (r.started_at > g.last_seen) g.last_seen = r.started_at;
  }

  const eligible: AggregatedGroup[] = [];
  for (const g of groups.values()) {
    g.distinct_users = g.user_ids.size;
    if (g.distinct_users >= MIN_REPORTS) {
      eligible.push({
        scam_e164: g.scam_e164,
        scam_type: g.scam_type,
        distinct_users: g.distinct_users,
        first_seen: g.first_seen,
        last_seen: g.last_seen,
        total_amount_cents: g.total_amount_cents,
        session_ids: g.session_ids,
      });
    }
  }

  let written = 0;
  for (const g of eligible) {
    try {
      // Idempotent per (scam_e164, scam_type, window_end_date). If a
      // previous run already wrote today's aggregation for this key, the
      // unique index bounces us and we skip.
      const res = await query(
        `INSERT INTO bulk_crime_reports
           (scam_e164, scam_type, distinct_users, total_amount_cents,
            first_seen_at, last_seen_at, session_ids, window_end_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], CURRENT_DATE)
         ON CONFLICT (scam_e164, scam_type, window_end_date) DO NOTHING`,
        [
          g.scam_e164,
          g.scam_type,
          g.distinct_users,
          g.total_amount_cents,
          g.first_seen,
          g.last_seen,
          g.session_ids,
        ],
      );
      if ((res.rowCount ?? 0) > 0) written++;
    } catch (err) {
      captureError(err, {
        component: 'bulkCrimeReporter',
        scam_e164: g.scam_e164,
      });
    }
  }

  return { groups_found: eligible.length, groups_written: written };
}

export function startBulkCrimeReporter(): BulkReportsHandle {
  const task = cron.schedule(
    DAILY_CRON,
    () => {
      void (async () => {
        const started = Date.now();
        try {
          const r = await runBulkCrimeReportOnce();
          // eslint-disable-next-line no-console
          console.log('[bulk-crime-reporter] complete', {
            ...r,
            duration_ms: Date.now() - started,
          });
        } catch (err) {
          captureError(err, { component: 'bulkCrimeReporter.cron' });
        }
      })();
    },
    { timezone: 'UTC' },
  );
  return { task };
}

export function stopBulkCrimeReporter(handle: BulkReportsHandle): void {
  handle.task.stop();
}
