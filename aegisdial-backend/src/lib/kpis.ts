// KPI fetch helpers. All six numbers the dashboard renders.
//
// Five come from materialized views (see db/migrations/042_kpi_dashboard.sql)
// refreshed lazily — if no refresh has happened in the last 60s we run
// REFRESH MATERIALIZED VIEW CONCURRENTLY first, then SELECT. DAU is a
// live query against analytics_events because the 24-hour sliding
// window doesn't fit a materialized view (it'd go stale immediately).
//
// The 60-second cooldown is deliberately generous — KPIs change slowly
// at our current scale and a stale read for a few seconds is fine.

import { query } from './db.js';

export interface Kpis {
  mrr_cents: number;
  active_subscribers: number;
  dau: number;
  blocks_today: number;
  recoveries_month: number;
  cancellations_month: number;
  refreshed_at: string; // ISO timestamp of the last MV refresh
}

const REFRESH_COOLDOWN_MS = 60_000;
let lastRefreshAt = 0;
let refreshInflight: Promise<void> | null = null;

const MATERIALIZED_VIEWS = [
  'mv_kpi_mrr',
  'mv_kpi_active_subs',
  'mv_kpi_blocks_today',
  'mv_kpi_recoveries_month',
  'mv_kpi_cancellations_month',
] as const;

async function refreshAllViews(): Promise<void> {
  // Run refreshes sequentially. CONCURRENTLY is per-view and they're
  // all small (1 row each); parallelising via Promise.all is overkill
  // and complicates error reporting.
  for (const v of MATERIALIZED_VIEWS) {
    await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${v}`);
  }
}

/**
 * Lazy refresh: only kicks off a refresh if the last one was >60s ago,
 * and never more than one in flight at a time. Multiple concurrent
 * dashboard hits coalesce onto the same in-flight promise.
 */
async function maybeRefresh(): Promise<void> {
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_COOLDOWN_MS) return;

  if (refreshInflight) {
    await refreshInflight;
    return;
  }

  refreshInflight = (async () => {
    try {
      await refreshAllViews();
      lastRefreshAt = Date.now();
    } finally {
      refreshInflight = null;
    }
  })();

  await refreshInflight;
}

/**
 * Force a refresh regardless of cooldown — exposed for the dashboard's
 * "refresh now" button.
 */
export async function forceRefresh(): Promise<void> {
  await refreshAllViews();
  lastRefreshAt = Date.now();
}

/**
 * Returns all six KPIs. Triggers an MV refresh if stale.
 */
export async function getKpis(): Promise<Kpis> {
  await maybeRefresh();

  const [
    mrrRes,
    subsRes,
    blocksRes,
    recoveriesRes,
    cancellationsRes,
    dauRes,
  ] = await Promise.all([
    query<{ mrr_cents: string; computed_at: Date }>(
      'SELECT mrr_cents, computed_at FROM mv_kpi_mrr LIMIT 1',
    ),
    query<{ active_subscribers: string }>(
      'SELECT active_subscribers FROM mv_kpi_active_subs LIMIT 1',
    ),
    query<{ blocks_today: string }>(
      'SELECT blocks_today FROM mv_kpi_blocks_today LIMIT 1',
    ),
    query<{ recoveries_month: string }>(
      'SELECT recoveries_month FROM mv_kpi_recoveries_month LIMIT 1',
    ),
    query<{ cancellations_month: string }>(
      'SELECT cancellations_month FROM mv_kpi_cancellations_month LIMIT 1',
    ),
    // DAU — distinct authed users with any analytics event in the last
    // 24h. user_id IS NOT NULL filters out anonymous-id-only rows
    // (pre-signup funnel) which we don't count as "users".
    query<{ dau: string }>(
      `SELECT COUNT(DISTINCT user_id)::TEXT AS dau
         FROM analytics_events
        WHERE user_id IS NOT NULL
          AND created_at > NOW() - INTERVAL '24 hours'`,
    ),
  ]);

  const refreshedAt =
    mrrRes.rows[0]?.computed_at?.toISOString() ?? new Date(lastRefreshAt).toISOString();

  // Postgres BIGINT comes back as a string from node-postgres by
  // default — Number() is safe here because all six counts are small
  // enough to fit comfortably in a JS number for many years.
  return {
    mrr_cents:           Number(mrrRes.rows[0]?.mrr_cents ?? 0),
    active_subscribers:  Number(subsRes.rows[0]?.active_subscribers ?? 0),
    dau:                 Number(dauRes.rows[0]?.dau ?? 0),
    blocks_today:        Number(blocksRes.rows[0]?.blocks_today ?? 0),
    recoveries_month:    Number(recoveriesRes.rows[0]?.recoveries_month ?? 0),
    cancellations_month: Number(cancellationsRes.rows[0]?.cancellations_month ?? 0),
    refreshed_at:        refreshedAt,
  };
}
