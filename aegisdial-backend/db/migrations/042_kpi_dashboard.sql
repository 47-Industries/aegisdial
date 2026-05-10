-- 042_kpi_dashboard.sql
--
-- Internal founder KPI dashboard. Adds:
--   1. plan_prices  — SQL-side mirror of src/lib/plans.ts so MRR can be
--      computed in Postgres without round-tripping through Node. Update
--      via a new migration if pricing changes.
--   2. Five materialized views — one per dashboard KPI that's expensive
--      enough to want caching (DAU stays a live query, ~one per minute).
--
-- All views are 1-row wide and refreshed CONCURRENTLY by src/lib/kpis.ts
-- with a 60s cooldown. The unique index on each is solely there to make
-- CONCURRENTLY refresh legal — without it Postgres locks readers out
-- during refresh.

-- ── Plan price reference ──────────────────────────────────────────
-- monthly_price_cents normalises annual SKUs to their monthly equivalent
-- so SUM(monthly_price_cents) over active subs == MRR cents.
CREATE TABLE IF NOT EXISTS plan_prices (
  product_id           TEXT PRIMARY KEY,
  monthly_price_cents  INTEGER NOT NULL CHECK (monthly_price_cents >= 0)
);

-- Mirror src/lib/plans.ts at the time of migration. ON CONFLICT update
-- so re-running the migration after a price change picks up the new
-- value (though the canonical path is a fresh migration with a new
-- INSERT...ON CONFLICT).
INSERT INTO plan_prices (product_id, monthly_price_cents) VALUES
  ('com.aegiadial.ios.pro.monthly',              4999),
  ('com.aegiadial.ios.pro.yearly',               2492),  -- 29900 / 12, rounded
  ('com.aegiadial.ios.pro.family_plus.monthly',  6999),
  ('com.aegiadial.ios.recovery.session',         9900)   -- one-time 30d, count once
ON CONFLICT (product_id) DO UPDATE
  SET monthly_price_cents = EXCLUDED.monthly_price_cents;

-- ── 1. MRR ───────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS mv_kpi_mrr;
CREATE MATERIALIZED VIEW mv_kpi_mrr AS
SELECT
  1 AS singleton,                                      -- forces 1 row
  COALESCE(SUM(p.monthly_price_cents), 0)::BIGINT AS mrr_cents,
  NOW() AS computed_at
FROM subscriptions s
JOIN plan_prices p ON p.product_id = s.provider_product_id
WHERE s.status = 'active'
  AND s.current_period_end > NOW();
CREATE UNIQUE INDEX mv_kpi_mrr_singleton_idx ON mv_kpi_mrr (singleton);

-- ── 2. Active subscribers ────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS mv_kpi_active_subs;
CREATE MATERIALIZED VIEW mv_kpi_active_subs AS
SELECT
  1 AS singleton,
  COUNT(DISTINCT user_id)::BIGINT AS active_subscribers,
  NOW() AS computed_at
FROM subscriptions
WHERE status = 'active'
  AND current_period_end > NOW();
CREATE UNIQUE INDEX mv_kpi_active_subs_singleton_idx ON mv_kpi_active_subs (singleton);

-- ── 3. Scam blocks today ─────────────────────────────────────────
-- call_blocked event is fired by src/routes/liveShield.ts on session
-- end when risk_level=='critical' AND outcome IN ('user_hung_up',
-- 'user_called_guardian'). All UTC.
DROP MATERIALIZED VIEW IF EXISTS mv_kpi_blocks_today;
CREATE MATERIALIZED VIEW mv_kpi_blocks_today AS
SELECT
  1 AS singleton,
  COUNT(*)::BIGINT AS blocks_today,
  NOW() AS computed_at
FROM analytics_events
WHERE event = 'call_blocked'
  AND created_at >= DATE_TRUNC('day', NOW())
  AND created_at <  DATE_TRUNC('day', NOW()) + INTERVAL '1 day';
CREATE UNIQUE INDEX mv_kpi_blocks_today_singleton_idx ON mv_kpi_blocks_today (singleton);

-- ── 4. Recoveries this month ─────────────────────────────────────
-- recovery_completed event fires when recovery_sessions.status flips
-- active→completed. See src/routes/recovery.ts.
DROP MATERIALIZED VIEW IF EXISTS mv_kpi_recoveries_month;
CREATE MATERIALIZED VIEW mv_kpi_recoveries_month AS
SELECT
  1 AS singleton,
  COUNT(*)::BIGINT AS recoveries_month,
  NOW() AS computed_at
FROM analytics_events
WHERE event = 'recovery_completed'
  AND created_at >= DATE_TRUNC('month', NOW())
  AND created_at <  DATE_TRUNC('month', NOW()) + INTERVAL '1 month';
CREATE UNIQUE INDEX mv_kpi_recoveries_month_singleton_idx ON mv_kpi_recoveries_month (singleton);

-- ── 5. Cancellations this month ──────────────────────────────────
-- subscription_cancelled is an existing event fired by Apple/Stripe
-- webhook handlers (src/lib/stripeVerify.ts, src/lib/appleVerify.ts)
-- when a sub transitions to status='cancelled'.
DROP MATERIALIZED VIEW IF EXISTS mv_kpi_cancellations_month;
CREATE MATERIALIZED VIEW mv_kpi_cancellations_month AS
SELECT
  1 AS singleton,
  COUNT(*)::BIGINT AS cancellations_month,
  NOW() AS computed_at
FROM analytics_events
WHERE event = 'subscription_cancelled'
  AND created_at >= DATE_TRUNC('month', NOW())
  AND created_at <  DATE_TRUNC('month', NOW()) + INTERVAL '1 month';
CREATE UNIQUE INDEX mv_kpi_cancellations_month_singleton_idx ON mv_kpi_cancellations_month (singleton);

-- Supporting index for DAU live query — counts distinct user_ids over
-- the last 24 hours. analytics_events already has
-- idx_analytics_events_user_time (user_id, created_at DESC) which
-- covers the (user_id IS NOT NULL, created_at >= NOW()-1d) scan.
-- No new index needed.
