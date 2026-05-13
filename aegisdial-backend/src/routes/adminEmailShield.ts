import type { FastifyInstance } from 'fastify';
import { requireBearer } from '../lib/auth.js';
import { query } from '../lib/db.js';
import { withAdminAudit } from './adminAudit.js';

// Email Shield — P23 — operator dashboard.
//
// Mirrors the /admin/v4/* convention from Live Shield v4 (Phase 11-17):
//   - Auth: `requireBearer` shared-secret gate (same surface every other
//     admin route uses)
//   - Audit + 500 sanitization: `withAdminAudit` wraps every handler so
//     a thrown pg error can't leak SQL fragments through the bearer
//     surface and every successful read emits `v4.admin.access` for
//     forensic triage
//   - Read-only, time-bounded SQL: every query is scoped by a literal
//     INTERVAL or scanned_at >= NOW() - INTERVAL clause; no
//     "all rows ever" scans
//   - No per-user PII: aggregate counts only. `sender_domain` (eTLD+1)
//     IS surfaced because it's already plaintext in email_scans for
//     the global reputation rollup — see migration 058 comments.
//
// Panels:
//   1. GET  /v1/admin/email-shield/summary                        — top-level counters
//   2. GET  /v1/admin/email-shield/scans-timeline                 — per-day buckets, 30d
//   3. GET  /v1/admin/email-shield/top-fraud-senders              — leaderboard, 30d
//   4. GET  /v1/admin/email-shield/compromise-distribution        — finding-key signal, 30d
//   5. GET  /v1/admin/email-shield/tamper-alert-resolution        — funnel, 30d
//
// All five are GET-only. There is no mutation surface in this file —
// operators tune via env flags and migrations, not via these routes.

interface SummaryResponse {
  active_inboxes: number;
  by_provider: Record<'gmail' | 'microsoft' | 'imap', number>;
  scans: { last_24h: number; last_7d: number; last_30d: number };
  verdict_distribution_7d: Record<'safe' | 'suspicious' | 'fraud', number>;
  compromise_reports_7d: Record<'clean' | 'concerns' | 'compromised', number>;
  tamper_alerts_7d: Record<'pending' | 'confirmed' | 'denied' | 'expired', number>;
}

interface TimelineDay {
  date: string;          // YYYY-MM-DD (UTC)
  scans: number;
  fraud_count: number;
  suspicious_count: number;
}

interface TopFraudSenderRow {
  sender_domain: string;
  count: number;
  first_seen_at: string; // ISO
  last_seen_at: string;  // ISO
}

interface CompromiseDistribution {
  total_reports: number;
  by_finding: {
    inbox_rules: number;
    oauth_grants: number;
    suspicious_sent: number;
    login_anomalies: number;
    breach_exposure: number;
  };
}

interface TamperFunnel {
  total_alerts: number;
  confirmed_pct: number;
  denied_pct: number;
  expired_pct: number;
  pending_pct: number;
  by_status: {
    pending: number;
    confirmed: number;
    denied: number;
    expired: number;
  };
}

/** Round to one decimal place. Avoids 33.333333333% noise in the funnel. */
function pct(n: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((n / total) * 1000) / 10;
}

export async function adminEmailShieldRoutes(app: FastifyInstance): Promise<void> {
  // -----------------------------------------------------------------
  // 1. GET /v1/admin/email-shield/summary
  // -----------------------------------------------------------------
  // Top-level operator view: how many Pro inboxes are live, how much
  // scanning is happening, what verdicts are coming out, what the
  // compromise + tamper surfaces are doing this week.
  //
  // All five sub-queries run sequentially against the same Postgres
  // pool. p95 budget is well under the 1s slow-route threshold from
  // withAdminAudit because each one hits a partial index from
  // migrations 057-061.
  app.get(
    '/v1/admin/email-shield/summary',
    { preHandler: requireBearer },
    withAdminAudit('email-shield-summary', async (_req, reply) => {
      // (a) active inboxes + per-provider breakdown.
      const accountsRes = await query<{
        provider: 'gmail' | 'microsoft' | 'imap';
        count: string;
      }>(
        `SELECT provider, COUNT(*)::TEXT AS count
           FROM email_accounts
          WHERE status = 'active'
          GROUP BY provider`,
      );
      const by_provider: SummaryResponse['by_provider'] = {
        gmail: 0,
        microsoft: 0,
        imap: 0,
      };
      let active_inboxes = 0;
      for (const row of accountsRes.rows) {
        const n = parseInt(row.count, 10) || 0;
        by_provider[row.provider] = n;
        active_inboxes += n;
      }

      // (b) scans counts over three rolling windows. Single query —
      // FILTER clauses against the same scanned_at index.
      const scansRes = await query<{
        last_24h: string;
        last_7d: string;
        last_30d: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE scanned_at >= NOW() - INTERVAL '24 hours')::TEXT  AS last_24h,
           COUNT(*) FILTER (WHERE scanned_at >= NOW() - INTERVAL '7 days')::TEXT    AS last_7d,
           COUNT(*) FILTER (WHERE scanned_at >= NOW() - INTERVAL '30 days')::TEXT   AS last_30d
         FROM email_scans
         WHERE scanned_at >= NOW() - INTERVAL '30 days'`,
      );
      const scans = {
        last_24h: parseInt(scansRes.rows[0]?.last_24h ?? '0', 10) || 0,
        last_7d: parseInt(scansRes.rows[0]?.last_7d ?? '0', 10) || 0,
        last_30d: parseInt(scansRes.rows[0]?.last_30d ?? '0', 10) || 0,
      };

      // (c) verdict distribution over the last 7 days.
      const verdictRes = await query<{
        verdict: 'safe' | 'suspicious' | 'fraud';
        count: string;
      }>(
        `SELECT verdict, COUNT(*)::TEXT AS count
           FROM email_scans
          WHERE scanned_at >= NOW() - INTERVAL '7 days'
          GROUP BY verdict`,
      );
      const verdict_distribution_7d: SummaryResponse['verdict_distribution_7d'] = {
        safe: 0,
        suspicious: 0,
        fraud: 0,
      };
      for (const r of verdictRes.rows) {
        verdict_distribution_7d[r.verdict] = parseInt(r.count, 10) || 0;
      }

      // (d) compromise reports over the last 7 days, grouped by verdict.
      const compromiseRes = await query<{
        overall_verdict: 'clean' | 'concerns' | 'compromised';
        count: string;
      }>(
        `SELECT overall_verdict, COUNT(*)::TEXT AS count
           FROM email_compromise_reports
          WHERE generated_at >= NOW() - INTERVAL '7 days'
          GROUP BY overall_verdict`,
      );
      const compromise_reports_7d: SummaryResponse['compromise_reports_7d'] = {
        clean: 0,
        concerns: 0,
        compromised: 0,
      };
      for (const r of compromiseRes.rows) {
        compromise_reports_7d[r.overall_verdict] = parseInt(r.count, 10) || 0;
      }

      // (e) tamper alerts over the last 7 days, grouped by status.
      const tamperRes = await query<{
        status: 'pending' | 'confirmed' | 'denied' | 'expired';
        count: string;
      }>(
        `SELECT status, COUNT(*)::TEXT AS count
           FROM email_tamper_alerts
          WHERE created_at >= NOW() - INTERVAL '7 days'
          GROUP BY status`,
      );
      const tamper_alerts_7d: SummaryResponse['tamper_alerts_7d'] = {
        pending: 0,
        confirmed: 0,
        denied: 0,
        expired: 0,
      };
      for (const r of tamperRes.rows) {
        tamper_alerts_7d[r.status] = parseInt(r.count, 10) || 0;
      }

      const body: SummaryResponse = {
        active_inboxes,
        by_provider,
        scans,
        verdict_distribution_7d,
        compromise_reports_7d,
        tamper_alerts_7d,
      };
      return reply.send(body);
    }),
  );

  // -----------------------------------------------------------------
  // 2. GET /v1/admin/email-shield/scans-timeline
  // -----------------------------------------------------------------
  // Per-day bucket of scans + fraud + suspicious counts over the last
  // 30 days, UTC. Forces the bucket to date_trunc('day', scanned_at AT
  // TIME ZONE 'UTC') so an operator pulling the data from a non-UTC
  // host gets the same daily bucketing the metric_counters table uses.
  //
  // The DB does the work — we DO NOT pull all 30d of rows back to the
  // app server and bucket in JS. ORDER BY date ASC so the response is
  // chart-ready (left → right == oldest → newest). Cap at 30 rows.
  app.get(
    '/v1/admin/email-shield/scans-timeline',
    { preHandler: requireBearer },
    withAdminAudit('email-shield-scans-timeline', async (_req, reply) => {
      const res = await query<{
        bucket: Date;
        scans: string;
        fraud_count: string;
        suspicious_count: string;
      }>(
        `SELECT
           date_trunc('day', scanned_at AT TIME ZONE 'UTC') AS bucket,
           COUNT(*)::TEXT AS scans,
           COUNT(*) FILTER (WHERE verdict = 'fraud')::TEXT      AS fraud_count,
           COUNT(*) FILTER (WHERE verdict = 'suspicious')::TEXT AS suspicious_count
         FROM email_scans
         WHERE scanned_at >= NOW() - INTERVAL '30 days'
         GROUP BY bucket
         ORDER BY bucket ASC
         LIMIT 30`,
      );
      const days: TimelineDay[] = res.rows.map((r) => {
        // date_trunc returns TIMESTAMP (no tz) when the AT TIME ZONE
        // strips the tz. Postgres ships it as a Date pinned to UTC
        // midnight; ISO-substring the YYYY-MM-DD off the front.
        const d = r.bucket instanceof Date ? r.bucket : new Date(r.bucket);
        return {
          date: d.toISOString().slice(0, 10),
          scans: parseInt(r.scans, 10) || 0,
          fraud_count: parseInt(r.fraud_count, 10) || 0,
          suspicious_count: parseInt(r.suspicious_count, 10) || 0,
        };
      });
      return reply.send({ days, window_days: 30, tz: 'UTC' });
    }),
  );

  // -----------------------------------------------------------------
  // 3. GET /v1/admin/email-shield/top-fraud-senders
  // -----------------------------------------------------------------
  // Top 20 sender_domains by fraud-verdict count in the last 30 days.
  // SOC use-case: identify campaign domains hitting multiple users so
  // we can pre-emptively flag inbound mail from them.
  //
  // Sender_domain is already plaintext eTLD+1 in migration 058 — the
  // global reputation rollup is the explicit design intent. No per-
  // user PII in the response.
  //
  // Uses idx_email_scans_sender_domain_fraud (partial WHERE verdict =
  // 'fraud') — see migration 058. Index-only scan.
  app.get(
    '/v1/admin/email-shield/top-fraud-senders',
    { preHandler: requireBearer },
    withAdminAudit('email-shield-top-fraud-senders', async (_req, reply) => {
      const res = await query<{
        sender_domain: string;
        count: string;
        first_seen_at: Date;
        last_seen_at: Date;
      }>(
        `SELECT
           sender_domain,
           COUNT(*)::TEXT     AS count,
           MIN(scanned_at)    AS first_seen_at,
           MAX(scanned_at)    AS last_seen_at
         FROM email_scans
         WHERE verdict = 'fraud'
           AND scanned_at >= NOW() - INTERVAL '30 days'
         GROUP BY sender_domain
         ORDER BY count DESC, last_seen_at DESC
         LIMIT 20`,
      );
      const senders: TopFraudSenderRow[] = res.rows.map((r) => ({
        sender_domain: r.sender_domain,
        count: parseInt(r.count, 10) || 0,
        first_seen_at: r.first_seen_at.toISOString(),
        last_seen_at: r.last_seen_at.toISOString(),
      }));
      return reply.send({ senders, window_days: 30 });
    }),
  );

  // -----------------------------------------------------------------
  // 4. GET /v1/admin/email-shield/compromise-distribution
  // -----------------------------------------------------------------
  // Counts how often each finding-key fires across compromise reports
  // in the last 30 days. Tells the operator which detector is doing
  // the work — if inbox_rules contributes 80% of signal and oauth_grants
  // contributes 0%, the OAuth detector is broken or undersampled.
  //
  // Implementation: each finding key (inbox_rules, oauth_grants,
  // suspicious_sent, login_anomalies, breach_exposure) is a top-level
  // JSON key in the `findings` JSONB column (see
  // migration 059 comment). The presence of the key (not its array
  // length) is what counts — `findings ? 'key'` is a fast jsonb
  // presence op. Multiple keys per report contribute to multiple
  // counters; sum-of-counters can exceed total_reports.
  app.get(
    '/v1/admin/email-shield/compromise-distribution',
    { preHandler: requireBearer },
    withAdminAudit('email-shield-compromise-distribution', async (_req, reply) => {
      const res = await query<{
        total_reports: string;
        inbox_rules: string;
        oauth_grants: string;
        suspicious_sent: string;
        login_anomalies: string;
        breach_exposure: string;
      }>(
        `SELECT
           COUNT(*)::TEXT                                                       AS total_reports,
           COUNT(*) FILTER (WHERE findings ? 'inbox_rules')::TEXT               AS inbox_rules,
           COUNT(*) FILTER (WHERE findings ? 'oauth_grants')::TEXT              AS oauth_grants,
           COUNT(*) FILTER (WHERE findings ? 'suspicious_sent')::TEXT           AS suspicious_sent,
           COUNT(*) FILTER (WHERE findings ? 'login_anomalies')::TEXT           AS login_anomalies,
           COUNT(*) FILTER (WHERE findings ? 'breach_exposure')::TEXT           AS breach_exposure
         FROM email_compromise_reports
         WHERE generated_at >= NOW() - INTERVAL '30 days'`,
      );
      const r = res.rows[0];
      const body: CompromiseDistribution = {
        total_reports: parseInt(r?.total_reports ?? '0', 10) || 0,
        by_finding: {
          inbox_rules: parseInt(r?.inbox_rules ?? '0', 10) || 0,
          oauth_grants: parseInt(r?.oauth_grants ?? '0', 10) || 0,
          suspicious_sent: parseInt(r?.suspicious_sent ?? '0', 10) || 0,
          login_anomalies: parseInt(r?.login_anomalies ?? '0', 10) || 0,
          breach_exposure: parseInt(r?.breach_exposure ?? '0', 10) || 0,
        },
      };
      return reply.send({ ...body, window_days: 30 });
    }),
  );

  // -----------------------------------------------------------------
  // 5. GET /v1/admin/email-shield/tamper-alert-resolution
  // -----------------------------------------------------------------
  // Funnel: last-30d tamper alerts grouped by terminal status. Tells
  // the operator whether the detector window (delete_after_seconds)
  // and threshold are tuned correctly:
  //   - confirmed > 50% → likely false-positive heavy; widen window
  //     or raise threshold
  //   - denied   > 10% → strong signal; the detector IS finding real
  //     compromises (these escalate to email_compromise_reports
  //     overall_verdict='compromised')
  //   - expired  > 30% → push-notification UX is failing; users
  //     aren't responding within 72h
  //
  // Pending count IS surfaced too — gives the operator a snapshot of
  // in-flight alerts at query time. Pending% is informational; the
  // funnel percentages (confirmed/denied/expired) only sum to 100%
  // when pending = 0.
  app.get(
    '/v1/admin/email-shield/tamper-alert-resolution',
    { preHandler: requireBearer },
    withAdminAudit('email-shield-tamper-alert-resolution', async (_req, reply) => {
      const res = await query<{
        status: 'pending' | 'confirmed' | 'denied' | 'expired';
        count: string;
      }>(
        `SELECT status, COUNT(*)::TEXT AS count
           FROM email_tamper_alerts
          WHERE created_at >= NOW() - INTERVAL '30 days'
          GROUP BY status`,
      );
      const by_status: TamperFunnel['by_status'] = {
        pending: 0,
        confirmed: 0,
        denied: 0,
        expired: 0,
      };
      for (const r of res.rows) {
        by_status[r.status] = parseInt(r.count, 10) || 0;
      }
      const total_alerts =
        by_status.pending + by_status.confirmed + by_status.denied + by_status.expired;
      const body: TamperFunnel = {
        total_alerts,
        confirmed_pct: pct(by_status.confirmed, total_alerts),
        denied_pct: pct(by_status.denied, total_alerts),
        expired_pct: pct(by_status.expired, total_alerts),
        pending_pct: pct(by_status.pending, total_alerts),
        by_status,
      };
      return reply.send({ ...body, window_days: 30 });
    }),
  );
}
