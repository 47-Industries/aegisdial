import cron from 'node-cron';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { emitMetric } from '../lib/observability.js';

// Live Shield v3 — A1 hot-numbers cache populator.
//
// What it does (per spec section "A1 cache miss"):
// Periodically recomputes the top-N highest-risk numbers from the
// mentions table and lands them in the a1_hot_numbers table. The iOS
// Call Directory Extension reads this set on its sync cycle and
// shows lock-screen warnings for any inbound call from one of these
// numbers.
//
// Cache eligibility rule (initial proposal — locked in spec, tunable):
// A number qualifies for the hot-numbers cache only if at least one of:
//
//   1. ≥3 negative mentions across at least 2 distinct sources, OR
//   2. ≥1 confirmed FCC complaint, OR
//   3. ≥5 anonymized AegisDial user blocks in the past 30 days, OR
//   4. The number triggered a critical-risk Live Shield session
//      in the past 30 days
//
// We're optimizing for TRUST over COVERAGE. Conservative cache
// eligibility means warnings are highly credible — Mom can verify
// each one against the receipts. Once Mom learns to ignore "yellow
// checking…" labels we've broken the product.
//
// Cron: every V3_A1_CACHE_RECOMPUTE_INTERVAL_MINUTES (default 360 = 6h).
// Single in-flight: the runOnce guard prevents two cron ticks from
// stomping each other if the recompute takes longer than the interval.

let runInFlight = false;

export interface PopulatorStats {
  candidates_scanned: number;
  qualified: number;
  cache_size_after: number;
  removed: number;
  duration_ms: number;
}

/**
 * Recompute the hot-numbers cache once. Idempotent and safe to call
 * directly from tests + admin endpoints.
 */
export async function runA1HotNumbersPopulatorOnce(): Promise<PopulatorStats> {
  if (runInFlight) {
    return {
      candidates_scanned: 0,
      qualified: 0,
      cache_size_after: 0,
      removed: 0,
      duration_ms: 0,
    };
  }
  runInFlight = true;
  const started = Date.now();

  try {
    // Step 1: compute candidate weights from mentions table.
    //
    // The risk weight formula:
    //   weight = SUM(severity * weight * recency_decay)
    //   over negative-sentiment mentions in the last 30 days
    //
    // recency_decay: 1.0 for mentions in the last 24h, linearly down
    // to 0.3 at 30 days. Older mentions do not enter the calculation.
    //
    // We use a CTE that joins mentions to compute the score, then
    // applies the eligibility rule via separate counts for source
    // diversity, FCC complaints, and user-block counts.
    const candidates = await query<{
      e164: string;
      risk_weight: number;
      mention_count: number;
      primary_sources: string[];
      qualifies_diverse: boolean;
      qualifies_fcc: boolean;
      qualifies_user_blocks: boolean;
    }>(
      `WITH recent_mentions AS (
         SELECT e164,
                source,
                severity,
                weight,
                created_at,
                -- Linear decay from 1.0 at now to 0.3 at 30 days.
                GREATEST(0.3, 1.0 - (EXTRACT(EPOCH FROM (NOW() - created_at)) / (30 * 86400)) * 0.7) AS decay
           FROM mentions
          WHERE sentiment = 'negative'
            AND created_at > NOW() - INTERVAL '30 days'
       ),
       per_number AS (
         SELECT e164,
                SUM(COALESCE(severity, 5) * weight * decay)::REAL AS risk_weight,
                COUNT(*)::INT AS mention_count,
                ARRAY_AGG(DISTINCT source ORDER BY source) AS primary_sources,
                COUNT(DISTINCT source) AS source_count,
                COUNT(*) FILTER (WHERE source = 'fcc') AS fcc_count,
                COUNT(*) FILTER (WHERE source = 'aegisdial_user_block') AS user_block_count
           FROM recent_mentions
          GROUP BY e164
       )
       SELECT e164,
              risk_weight,
              mention_count,
              primary_sources,
              (mention_count >= 3 AND source_count >= 2) AS qualifies_diverse,
              (fcc_count >= 1)                          AS qualifies_fcc,
              (user_block_count >= 5)                   AS qualifies_user_blocks
         FROM per_number
        WHERE risk_weight > 0
        ORDER BY risk_weight DESC
        LIMIT $1`,
      [config.V3_A1_HOT_NUMBERS_CACHE_SIZE * 2], // 2x oversample so eligibility filtering still gives us cache_size hits
    );

    // Step 2: filter by eligibility rule.
    //
    // The spec includes a fourth rule — "triggered a critical-risk
    // Live Shield session" — which we evaluate via a separate query
    // since it doesn't live in mentions. We pull all qualifying
    // session-triggers from call_sessions and union with the
    // mention-derived candidates.
    const liveShieldQualifiers = await query<{ peer_e164: string }>(
      `SELECT DISTINCT peer_e164
         FROM call_sessions
        WHERE risk_level = 'critical'
          AND peer_e164 IS NOT NULL
          AND started_at > NOW() - INTERVAL '30 days'`,
    );
    const liveShieldSet = new Set(liveShieldQualifiers.rows.map((r) => r.peer_e164));

    // Cross-pool promotion gate: SMS Shield fraud/suspicious senders
    // promote already-candidate numbers across the qualification
    // threshold. A number must already appear in recent_mentions
    // (FCC list, user-block, or diverse-sources) to enter `candidates`
    // at all — pure-SMS-only scammers without mention-graph presence
    // are NOT injected here. Same constraint applies to liveShieldSet.
    // Pure-SMS injection is a separate work item (would need its own
    // weight model so SMS volume doesn't crowd out the call-side
    // signal). 30-day window matches the call-side qualifier and the
    // sms_scans retention sweep.
    // Defense-in-depth alongside the insert-time normalize in
    // src/routes/smsShield.ts: even if a legacy row was written before
    // the normalize landed (or some other writer skipped it), we filter
    // to E.164-shaped senders here so the .has(c.e164) match against
    // the recent_mentions candidates can actually hit. Alphanumeric
    // short codes ("CHASE") and bare digit strings are excluded —
    // they wouldn't match the call-side peer_e164 anyway.
    const smsShieldQualifiers = await query<{ sender_e164: string }>(
      `SELECT DISTINCT sender_e164
         FROM sms_scans
        WHERE verdict IN ('fraud', 'suspicious')
          AND sender_e164 ~ '^\\+[1-9][0-9]{6,14}$'
          AND scanned_at > NOW() - INTERVAL '30 days'`,
    );
    const smsShieldSet = new Set(smsShieldQualifiers.rows.map((r) => r.sender_e164));

    const qualified = candidates.rows.filter(
      (c) =>
        c.qualifies_diverse ||
        c.qualifies_fcc ||
        c.qualifies_user_blocks ||
        liveShieldSet.has(c.e164) ||
        smsShieldSet.has(c.e164),
    );

    const finalCacheSet = qualified.slice(0, config.V3_A1_HOT_NUMBERS_CACHE_SIZE);

    // Step 3: write to a1_hot_numbers atomically. We do this in two
    // passes:
    //   (a) UPSERT every qualified number (insert or update weight)
    //   (b) DELETE numbers that were in the cache before this run but
    //       didn't qualify this time
    //
    // Step (b) lets the iOS extension's diff-sync see the removals.
    // Without it, numbers that drop off the hot list would still be
    // returned by /v1/lookup/cache-snapshot until the row was
    // explicitly removed.
    // Single timestamp shared across this run's UPSERTs — used both
    // for last_recomputed_at on each row AND as the cutoff for the
    // stale-row sweep below.
    const runTimestamp = new Date();

    if (finalCacheSet.length > 0) {
      // Bulk UPSERT via a VALUES list. Each row contributes 4 placeholders
      // ($e164, $risk_weight, $mention_count, $primary_sources). The
      // run timestamp goes in as a single trailing parameter shared
      // across all rows.
      const placeholders: string[] = [];
      const params: unknown[] = [];
      finalCacheSet.forEach((row, idx) => {
        const base = idx * 4;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::TEXT[], $${finalCacheSet.length * 4 + 1})`,
        );
        params.push(row.e164, row.risk_weight, row.mention_count, row.primary_sources);
      });
      params.push(runTimestamp);

      await query(
        `INSERT INTO a1_hot_numbers
           (e164, risk_weight, mention_count, primary_sources, last_recomputed_at)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (e164) DO UPDATE
           SET risk_weight        = EXCLUDED.risk_weight,
               mention_count      = EXCLUDED.mention_count,
               primary_sources    = EXCLUDED.primary_sources,
               last_recomputed_at = EXCLUDED.last_recomputed_at`,
        params,
      );
    }

    // Sweep stale entries — anything not touched by this recompute.
    // last_recomputed_at < runTimestamp means the row was not upserted
    // in this pass, so it doesn't qualify and should be removed.
    const removed = await query(
      `DELETE FROM a1_hot_numbers WHERE last_recomputed_at < $1`,
      [runTimestamp],
    );

    const duration_ms = Date.now() - started;
    emitMetric('v3.a1.populator_run_completed', {
      qualified: finalCacheSet.length,
    }, duration_ms);

    return {
      candidates_scanned: candidates.rows.length,
      qualified: qualified.length,
      cache_size_after: finalCacheSet.length,
      removed: removed.rowCount ?? 0,
      duration_ms,
    };
  } finally {
    runInFlight = false;
  }
}

export interface PopulatorHandle {
  task: cron.ScheduledTask;
}

/**
 * Start the populator on its cron schedule. Returns a handle so
 * tests/teardown can stop the task cleanly.
 */
export function startA1HotNumbersPopulator(): PopulatorHandle | null {
  if (!config.V3_A1_ENABLED) {
    return null;
  }

  // node-cron uses minute-precision; convert the configured interval
  // into a cron expression. `*/N * * * *` works for N up to 59; for
  // longer intervals (default 360 = 6h) we use `0 */H * * *`.
  const intervalMin = config.V3_A1_CACHE_RECOMPUTE_INTERVAL_MINUTES;
  const cronExpr =
    intervalMin < 60
      ? `*/${intervalMin} * * * *`
      : `0 */${Math.floor(intervalMin / 60)} * * *`;

  const task = cron.schedule(cronExpr, async () => {
    try {
      const stats = await runA1HotNumbersPopulatorOnce();
      // eslint-disable-next-line no-console
      console.log('[a1-populator] run complete', stats);
    } catch (err) {
      emitMetric('v3.a1.populator_run_failed', {});
      // eslint-disable-next-line no-console
      console.error('[a1-populator] run failed', err);
    }
  });

  return { task };
}
