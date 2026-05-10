// Schema documentation for the NL→SQL Claude prompt.
//
// Kept in its own file so:
//   1. The system prompt stays readable in nlSql.ts.
//   2. We can iterate on the schema description without touching
//      Claude prompt logic.
//   3. The same string can be shown in the dashboard UI for the
//      operator's reference (e.g. as a "what tables can I ask about?"
//      affordance — not yet wired but easy to add).
//
// The schema covers exactly the tables in sqlSafe.ts ALLOWED_TABLES.
// If you add a table to that allowlist, mirror the docs here so
// Claude can use it.

export const SCHEMA_DOCS = `
TABLES (allowlist — only these may be queried):

analytics_events(
  id           BIGSERIAL,
  user_id      UUID NULL,             -- null for pre-signup events
  anonymous_id TEXT NULL,
  event        TEXT,                  -- snake_case, see event values below
  properties   JSONB,
  created_at   TIMESTAMPTZ
)
  Common event values:
    user_signed_up, user_signed_in, user_deleted_account,
    subscription_started, subscription_cancelled,
    shield_started, shield_critical, shield_ended,
    call_blocked,                    -- critical scam call where user hung up
    recovery_started, recovery_step_completed, recovery_completed,
    sms_junk_classified,
    breach_monitor_added, breach_new_exposure,
    guardian_alert_seen, guardian_challenge_started, guardian_challenge_responded,
    onboarding_started, onboarding_tour_completed, onboarding_tour_skipped,
    permission_granted, permission_denied

subscriptions(
  user_id              UUID,
  provider             TEXT,           -- 'apple_storekit' | 'stripe' | 'admin_grant'
  provider_product_id  TEXT,           -- e.g. 'com.aegiadial.ios.pro.monthly'
  status               TEXT,           -- 'active' | 'in_grace' | 'expired' | 'revoked' | 'cancelled'
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  auto_renew           BOOLEAN,
  created_at           TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ
)

recovery_sessions(
  id                UUID,
  user_id           UUID,
  scam_type         TEXT,             -- e.g. 'irs_impersonation', 'romance', 'package_redelivery'
  amount_lost_cents INTEGER,          -- can be 0 if no money was lost
  status            TEXT,             -- 'active' | 'completed' | 'abandoned'
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ NULL,
  updated_at        TIMESTAMPTZ
)

recovery_steps(
  session_id   UUID,
  step_key     TEXT,
  ordinal      INTEGER,
  status       TEXT,                  -- 'pending' | 'in_progress' | 'completed' | 'skipped'
  completed_at TIMESTAMPTZ NULL
)

call_sessions(
  id                   UUID,
  user_id              UUID,
  started_at           TIMESTAMPTZ,
  ended_at             TIMESTAMPTZ NULL,
  duration_seconds     INTEGER,
  risk_score           INTEGER,        -- 0-100
  risk_level           TEXT,           -- 'low' | 'medium' | 'high' | 'critical'
  triggered_categories TEXT[],
  outcome              TEXT NULL       -- 'user_hung_up' | 'user_completed' | 'user_called_guardian' | 'user_abandoned' | 'unknown'
)

breach_alerts(
  user_id       UUID,
  identifier_id UUID,
  source        TEXT,
  created_at    TIMESTAMPTZ
)

guardian_alerts(
  user_id    UUID,
  severity   TEXT,                    -- 'info' | 'warning' | 'critical'
  seen_at    TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ
)

plan_prices(
  product_id          TEXT,            -- matches subscriptions.provider_product_id
  monthly_price_cents INTEGER          -- annual SKUs already normalized to /12
)

MATERIALIZED VIEWS (precomputed KPIs, refreshed every 60s, 1 row each):

mv_kpi_mrr(mrr_cents BIGINT, computed_at TIMESTAMPTZ)
mv_kpi_active_subs(active_subscribers BIGINT, computed_at TIMESTAMPTZ)
mv_kpi_blocks_today(blocks_today BIGINT, computed_at TIMESTAMPTZ)
mv_kpi_recoveries_month(recoveries_month BIGINT, computed_at TIMESTAMPTZ)
mv_kpi_cancellations_month(cancellations_month BIGINT, computed_at TIMESTAMPTZ)

EXAMPLES:

Q: How many users signed up in the last 7 days?
A: SELECT COUNT(*) FROM analytics_events WHERE event = 'user_signed_up' AND created_at > NOW() - INTERVAL '7 days'

Q: What are the top 5 scam types for completed recoveries this month?
A: SELECT scam_type, COUNT(*) AS n FROM recovery_sessions WHERE status = 'completed' AND completed_at >= DATE_TRUNC('month', NOW()) GROUP BY scam_type ORDER BY n DESC LIMIT 5

Q: How many critical calls happened in the last 24 hours by outcome?
A: SELECT outcome, COUNT(*) FROM call_sessions WHERE risk_level = 'critical' AND started_at > NOW() - INTERVAL '24 hours' GROUP BY outcome

Q: What's our gross MRR right now?
A: SELECT mrr_cents FROM mv_kpi_mrr

Q: Which subscription product is most popular?
A: SELECT provider_product_id, COUNT(*) FROM subscriptions WHERE status = 'active' GROUP BY provider_product_id ORDER BY 2 DESC
`.trim();
