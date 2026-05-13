import type { FastifyInstance } from 'fastify';
import { requireBearer } from '../lib/auth.js';
import { query } from '../lib/db.js';
import { withAdminAudit } from './adminAudit.js';

// Recovery Shield — R-P6 — operator dashboard.
//
// Mirrors the /v1/admin/email-shield/* convention from Email Shield
// P23 (and the underlying /admin/v4/* convention from Live Shield v4
// Phase 11-17):
//   - Auth: `requireBearer` shared-secret gate (same surface every
//     other admin route uses)
//   - Audit + 500 sanitization: `withAdminAudit` wraps every handler
//     so a thrown pg error can't leak SQL fragments through the
//     bearer surface and every successful read emits the structured
//     audit log + access metric
//   - Read-only, time-bounded SQL: every query is scoped by a
//     literal INTERVAL clause; no "all rows ever" scans
//   - No per-user PII: aggregate counts only. specialists.display_name
//     IS surfaced because it's marketplace-public-by-design (see
//     migration 066 — specialists are a SHARED B2B partner record,
//     not user-owned). No user_id, no email, no apple_transaction_id,
//     no encrypted columns ever appear in the response.
//
// Panels:
//   1. GET /v1/admin/recovery-shield/summary               — top-level counters
//   2. GET /v1/admin/recovery-shield/cases-timeline        — per-day buckets, 30d
//   3. GET /v1/admin/recovery-shield/specialist-performance — 90d leaderboard
//   4. GET /v1/admin/recovery-shield/document-quality      — per doc_kind, 30d
//   5. GET /v1/admin/recovery-shield/refund-rate           — IAP-fraud detection
//
// All five are GET-only. There is no mutation surface in this file —
// operators tune specialist status / fee_paid_at through the existing
// admin grant + ops tooling (out of scope for the dashboard read
// layer).

interface SummaryResponse {
  open_purchases_30d: number;
  total_revenue_30d_cents: number;
  wire_cases_by_state: Record<
    | 'intake'
    | 'letter_drafted'
    | 'user_sent'
    | 'bank_acknowledged'
    | 'recalled'
    | 'denied'
    | 'closed',
    number
  >;
  crypto_cases_by_state: Record<
    | 'intake'
    | 'tracing'
    | 'exchange_identified'
    | 'petition_drafted'
    | 'user_sent'
    | 'exchange_acked'
    | 'frozen'
    | 'denied'
    | 'closed',
    number
  >;
  open_wire_cases: number;
  open_crypto_cases: number;
  legal_docs_generated_30d: number;
  referrals_30d_by_status: Record<
    | 'referred'
    | 'specialist_contacted_user'
    | 'user_engaged'
    | 'case_active'
    | 'case_closed_won'
    | 'case_closed_lost'
    | 'user_declined',
    number
  >;
  total_referrals_30d: number;
}

interface TimelineDay {
  date: string; // YYYY-MM-DD (UTC)
  wire_cases_opened: number;
  crypto_cases_opened: number;
  legal_packets_generated: number;
  referrals_created: number;
}

interface SpecialistPerformanceRow {
  specialist_id: string;
  display_name: string;
  category: string;
  referrals_count: number;
  case_closed_won_count: number;
  case_closed_lost_count: number;
  conversion_pct: number;
  fee_owed_total_cents: number;
  fee_paid_total_cents: number;
}

interface DocumentQualityRow {
  doc_kind: string;
  generated_count: number;
  avg_body_length: number;
  disclaimer_acknowledgement_rate: number;
}

interface RefundRateResponse {
  total_purchases_30d: number;
  refunded_30d: number;
  refund_pct: number;
  top_refund_window: {
    within_24h: number;
    within_7d: number;
    after_7d: number;
  };
}

/**
 * Terminal wire-case states — used to derive `open_wire_cases`. Same
 * vocabulary the CHECK constraint pins (migration 063):
 *   open: intake, letter_drafted, user_sent, bank_acknowledged
 *   terminal: recalled, denied, closed
 */
const WIRE_OPEN_STATES = new Set([
  'intake',
  'letter_drafted',
  'user_sent',
  'bank_acknowledged',
]);

/**
 * Terminal crypto-case states — same logic (migration 064):
 *   open: intake, tracing, exchange_identified, petition_drafted,
 *         user_sent, exchange_acked
 *   terminal: frozen, denied, closed
 */
const CRYPTO_OPEN_STATES = new Set([
  'intake',
  'tracing',
  'exchange_identified',
  'petition_drafted',
  'user_sent',
  'exchange_acked',
]);

/** Round to one decimal place. Avoids 33.333333333% noise. */
function pct(n: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((n / total) * 1000) / 10;
}

export async function adminRecoveryShieldRoutes(app: FastifyInstance): Promise<void> {
  // -----------------------------------------------------------------
  // 1. GET /v1/admin/recovery-shield/summary
  // -----------------------------------------------------------------
  // Top-level operator view: Recovery Plus purchase + revenue this
  // month, open cases per category, legal-doc + referral throughput.
  //
  // Every sub-query is scoped to a 30-day window (or restricted to
  // non-terminal states for the open-case counts). p95 budget well
  // under the 1s slow-route threshold — every query hits a
  // (created_at|purchased_at|generated_at|referred_at) DESC index
  // from migrations 062-067.
  app.get(
    '/v1/admin/recovery-shield/summary',
    { preHandler: requireBearer },
    withAdminAudit('recovery-shield-summary', async (_req, reply) => {
      // (a) Recovery Plus purchases — 30d open (not refunded) +
      // revenue rollup. SUM(purchase_amount_cents) returns a numeric
      // string from pg; coerce to integer via parseInt.
      const purchasesRes = await query<{
        open_count: string;
        revenue_cents: string | null;
      }>(
        `SELECT
           COUNT(*)::TEXT                                                          AS open_count,
           COALESCE(SUM(purchase_amount_cents) FILTER (WHERE refunded_at IS NULL), 0)::TEXT AS revenue_cents
         FROM recovery_plus_purchases
         WHERE purchased_at >= NOW() - INTERVAL '30 days'
           AND refunded_at IS NULL`,
      );
      const open_purchases_30d =
        parseInt(purchasesRes.rows[0]?.open_count ?? '0', 10) || 0;
      const total_revenue_30d_cents =
        parseInt(purchasesRes.rows[0]?.revenue_cents ?? '0', 10) || 0;

      // (b) Wire-trace cases by state (all-time open; terminal states
      // included for full visibility — operator filters in UI).
      const wireRes = await query<{ state: string; count: string }>(
        `SELECT state, COUNT(*)::TEXT AS count
           FROM wire_trace_cases
          WHERE created_at >= NOW() - INTERVAL '365 days'
          GROUP BY state`,
      );
      const wire_cases_by_state: SummaryResponse['wire_cases_by_state'] = {
        intake: 0,
        letter_drafted: 0,
        user_sent: 0,
        bank_acknowledged: 0,
        recalled: 0,
        denied: 0,
        closed: 0,
      };
      let open_wire_cases = 0;
      for (const r of wireRes.rows) {
        const n = parseInt(r.count, 10) || 0;
        if (r.state in wire_cases_by_state) {
          wire_cases_by_state[r.state as keyof typeof wire_cases_by_state] = n;
        }
        if (WIRE_OPEN_STATES.has(r.state)) open_wire_cases += n;
      }

      // (c) Crypto-trace cases by state (same window logic).
      const cryptoRes = await query<{ state: string; count: string }>(
        `SELECT state, COUNT(*)::TEXT AS count
           FROM crypto_trace_cases
          WHERE created_at >= NOW() - INTERVAL '365 days'
          GROUP BY state`,
      );
      const crypto_cases_by_state: SummaryResponse['crypto_cases_by_state'] = {
        intake: 0,
        tracing: 0,
        exchange_identified: 0,
        petition_drafted: 0,
        user_sent: 0,
        exchange_acked: 0,
        frozen: 0,
        denied: 0,
        closed: 0,
      };
      let open_crypto_cases = 0;
      for (const r of cryptoRes.rows) {
        const n = parseInt(r.count, 10) || 0;
        if (r.state in crypto_cases_by_state) {
          crypto_cases_by_state[
            r.state as keyof typeof crypto_cases_by_state
          ] = n;
        }
        if (CRYPTO_OPEN_STATES.has(r.state)) open_crypto_cases += n;
      }

      // (d) Legal docs generated, 30d.
      const docsRes = await query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
           FROM legal_documents
          WHERE generated_at >= NOW() - INTERVAL '30 days'`,
      );
      const legal_docs_generated_30d =
        parseInt(docsRes.rows[0]?.count ?? '0', 10) || 0;

      // (e) Specialist referrals, 30d, grouped by engagement_status.
      const referralsRes = await query<{
        engagement_status: string;
        count: string;
      }>(
        `SELECT engagement_status, COUNT(*)::TEXT AS count
           FROM specialist_referrals
          WHERE referred_at >= NOW() - INTERVAL '30 days'
          GROUP BY engagement_status`,
      );
      const referrals_30d_by_status: SummaryResponse['referrals_30d_by_status'] = {
        referred: 0,
        specialist_contacted_user: 0,
        user_engaged: 0,
        case_active: 0,
        case_closed_won: 0,
        case_closed_lost: 0,
        user_declined: 0,
      };
      let total_referrals_30d = 0;
      for (const r of referralsRes.rows) {
        const n = parseInt(r.count, 10) || 0;
        if (r.engagement_status in referrals_30d_by_status) {
          referrals_30d_by_status[
            r.engagement_status as keyof typeof referrals_30d_by_status
          ] = n;
        }
        total_referrals_30d += n;
      }

      const body: SummaryResponse = {
        open_purchases_30d,
        total_revenue_30d_cents,
        wire_cases_by_state,
        crypto_cases_by_state,
        open_wire_cases,
        open_crypto_cases,
        legal_docs_generated_30d,
        referrals_30d_by_status,
        total_referrals_30d,
      };
      return reply.send(body);
    }),
  );

  // -----------------------------------------------------------------
  // 2. GET /v1/admin/recovery-shield/cases-timeline
  // -----------------------------------------------------------------
  // Per-day buckets, last 30 days, UTC: how many wire cases were
  // opened, how many crypto cases, how many legal packets generated,
  // how many specialist referrals fired. One row per day across the
  // four sub-counts.
  //
  // Implementation: four parallel date_trunc queries against four
  // distinct tables, then merged client-side into a single day-keyed
  // map. Keeping them separate (rather than a UNION ALL) preserves
  // the per-table indexes — each query hits its (created_at|
  // generated_at|referred_at) DESC index and never table-scans.
  app.get(
    '/v1/admin/recovery-shield/cases-timeline',
    { preHandler: requireBearer },
    withAdminAudit('recovery-shield-cases-timeline', async (_req, reply) => {
      const cutoff = `30 days`;
      const wireRes = await query<{ bucket: Date; count: string }>(
        `SELECT
           date_trunc('day', created_at AT TIME ZONE 'UTC') AS bucket,
           COUNT(*)::TEXT AS count
         FROM wire_trace_cases
         WHERE created_at >= NOW() - INTERVAL '${cutoff}'
         GROUP BY bucket
         ORDER BY bucket ASC
         LIMIT 30`,
      );
      const cryptoRes = await query<{ bucket: Date; count: string }>(
        `SELECT
           date_trunc('day', created_at AT TIME ZONE 'UTC') AS bucket,
           COUNT(*)::TEXT AS count
         FROM crypto_trace_cases
         WHERE created_at >= NOW() - INTERVAL '${cutoff}'
         GROUP BY bucket
         ORDER BY bucket ASC
         LIMIT 30`,
      );
      const docsRes = await query<{ bucket: Date; count: string }>(
        `SELECT
           date_trunc('day', generated_at AT TIME ZONE 'UTC') AS bucket,
           COUNT(*)::TEXT AS count
         FROM legal_documents
         WHERE generated_at >= NOW() - INTERVAL '${cutoff}'
         GROUP BY bucket
         ORDER BY bucket ASC
         LIMIT 30`,
      );
      const referralsRes = await query<{ bucket: Date; count: string }>(
        `SELECT
           date_trunc('day', referred_at AT TIME ZONE 'UTC') AS bucket,
           COUNT(*)::TEXT AS count
         FROM specialist_referrals
         WHERE referred_at >= NOW() - INTERVAL '${cutoff}'
         GROUP BY bucket
         ORDER BY bucket ASC
         LIMIT 30`,
      );

      // Merge the four streams into a single date-keyed map.
      const days = new Map<string, TimelineDay>();
      function dateKey(b: Date | string): string {
        const d = b instanceof Date ? b : new Date(b);
        return d.toISOString().slice(0, 10);
      }
      function ensureDay(key: string): TimelineDay {
        let slot = days.get(key);
        if (!slot) {
          slot = {
            date: key,
            wire_cases_opened: 0,
            crypto_cases_opened: 0,
            legal_packets_generated: 0,
            referrals_created: 0,
          };
          days.set(key, slot);
        }
        return slot;
      }
      for (const r of wireRes.rows) {
        const key = dateKey(r.bucket);
        ensureDay(key).wire_cases_opened = parseInt(r.count, 10) || 0;
      }
      for (const r of cryptoRes.rows) {
        const key = dateKey(r.bucket);
        ensureDay(key).crypto_cases_opened = parseInt(r.count, 10) || 0;
      }
      for (const r of docsRes.rows) {
        const key = dateKey(r.bucket);
        ensureDay(key).legal_packets_generated = parseInt(r.count, 10) || 0;
      }
      for (const r of referralsRes.rows) {
        const key = dateKey(r.bucket);
        ensureDay(key).referrals_created = parseInt(r.count, 10) || 0;
      }
      const sortedDays = Array.from(days.values()).sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
      );
      return reply.send({ days: sortedDays, window_days: 30, tz: 'UTC' });
    }),
  );

  // -----------------------------------------------------------------
  // 3. GET /v1/admin/recovery-shield/specialist-performance
  // -----------------------------------------------------------------
  // Per-specialist leaderboard, 90d window. Joins specialists →
  // specialist_referrals and rolls up:
  //   - referrals_count: total referrals to this specialist in 90d
  //   - case_closed_won_count / case_closed_lost_count: terminal
  //     conversion-funnel counts
  //   - conversion_pct: won / (won + lost). Computed client-side
  //     after parseInt to avoid pg numeric → JS float rounding.
  //   - fee_owed_total_cents / fee_paid_total_cents: aggregate fee
  //     ledger (BIGINT — large wire-recall commissions can be
  //     five-figure per case)
  //
  // display_name + category ARE surfaced — these are marketplace-
  // public B2B records (migration 066 — specialists are SHARED
  // resources, not user-owned). No user_id ever leaves the join.
  //
  // Hits idx_referrals_specialist (specialist_id, referred_at DESC)
  // for the join + window filter.
  app.get(
    '/v1/admin/recovery-shield/specialist-performance',
    { preHandler: requireBearer },
    withAdminAudit('recovery-shield-specialist-performance', async (_req, reply) => {
      const res = await query<{
        specialist_id: string;
        display_name: string;
        category: string;
        referrals_count: string;
        case_closed_won_count: string;
        case_closed_lost_count: string;
        fee_owed_total_cents: string | null;
        fee_paid_total_cents: string | null;
      }>(
        `SELECT
           s.id::TEXT                                                                AS specialist_id,
           s.display_name                                                            AS display_name,
           s.category                                                                AS category,
           COUNT(r.id)::TEXT                                                         AS referrals_count,
           COUNT(*) FILTER (WHERE r.engagement_status = 'case_closed_won')::TEXT     AS case_closed_won_count,
           COUNT(*) FILTER (WHERE r.engagement_status = 'case_closed_lost')::TEXT    AS case_closed_lost_count,
           COALESCE(SUM(r.fee_owed_cents), 0)::TEXT                                  AS fee_owed_total_cents,
           COALESCE(SUM(r.fee_owed_cents) FILTER (WHERE r.fee_paid_at IS NOT NULL), 0)::TEXT AS fee_paid_total_cents
         FROM specialists s
         JOIN specialist_referrals r
           ON r.specialist_id = s.id
          AND r.referred_at >= NOW() - INTERVAL '90 days'
         GROUP BY s.id, s.display_name, s.category
         ORDER BY referrals_count DESC, s.display_name ASC
         LIMIT 50`,
      );
      const rows: SpecialistPerformanceRow[] = res.rows.map((r) => {
        const referrals_count = parseInt(r.referrals_count, 10) || 0;
        const won = parseInt(r.case_closed_won_count, 10) || 0;
        const lost = parseInt(r.case_closed_lost_count, 10) || 0;
        const terminal = won + lost;
        return {
          specialist_id: r.specialist_id,
          display_name: r.display_name,
          category: r.category,
          referrals_count,
          case_closed_won_count: won,
          case_closed_lost_count: lost,
          conversion_pct: pct(won, terminal),
          fee_owed_total_cents: parseInt(r.fee_owed_total_cents ?? '0', 10) || 0,
          fee_paid_total_cents: parseInt(r.fee_paid_total_cents ?? '0', 10) || 0,
        };
      });
      return reply.send({ specialists: rows, window_days: 90 });
    }),
  );

  // -----------------------------------------------------------------
  // 4. GET /v1/admin/recovery-shield/document-quality
  // -----------------------------------------------------------------
  // Per-doc_kind metrics, 30d:
  //   - generated_count: rows produced
  //   - avg_body_length: AVG(length(body_markdown)). Body is
  //     envelope-encrypted ciphertext (v1:<iv>:<tag>:<ct>), so the
  //     length is the ciphertext byte count, not plaintext — but
  //     it's a stable proxy for "how chunky is the generated doc"
  //     (longer ciphertext == longer plaintext + same overhead).
  //     Operator-useful for spotting a degenerate template producing
  //     2-line docs.
  //   - disclaimer_acknowledgement_rate: COUNT(acknowledged_at NOT
  //     NULL) / COUNT(*). Tells the operator whether the disclaimer
  //     UX is working — a low rate (<50%) means users are generating
  //     packets and then never tapping "I understand", which means
  //     they can't download the PDF (the route refuses to serve
  //     when the column is NULL — see migration 065 comment).
  app.get(
    '/v1/admin/recovery-shield/document-quality',
    { preHandler: requireBearer },
    withAdminAudit('recovery-shield-document-quality', async (_req, reply) => {
      const res = await query<{
        doc_kind: string;
        generated_count: string;
        avg_body_length: string | null;
        acknowledged_count: string;
      }>(
        `SELECT
           doc_kind,
           COUNT(*)::TEXT                                                      AS generated_count,
           AVG(length(body_markdown))::TEXT                                    AS avg_body_length,
           COUNT(*) FILTER (WHERE user_acknowledged_disclaimer_at IS NOT NULL)::TEXT AS acknowledged_count
         FROM legal_documents
         WHERE generated_at >= NOW() - INTERVAL '30 days'
         GROUP BY doc_kind
         ORDER BY generated_count DESC`,
      );
      const rows: DocumentQualityRow[] = res.rows.map((r) => {
        const generated_count = parseInt(r.generated_count, 10) || 0;
        const acknowledged_count = parseInt(r.acknowledged_count, 10) || 0;
        // AVG() returns a numeric string; parseFloat handles decimals.
        // Round to integer (we don't care about sub-character precision).
        const avg_raw = parseFloat(r.avg_body_length ?? '0');
        const avg_body_length = Number.isFinite(avg_raw)
          ? Math.round(avg_raw)
          : 0;
        return {
          doc_kind: r.doc_kind,
          generated_count,
          avg_body_length,
          disclaimer_acknowledgement_rate: pct(
            acknowledged_count,
            generated_count,
          ),
        };
      });
      return reply.send({ docs: rows, window_days: 30 });
    }),
  );

  // -----------------------------------------------------------------
  // 5. GET /v1/admin/recovery-shield/refund-rate
  // -----------------------------------------------------------------
  // IAP-fraud / buyer's-remorse detection. Computes:
  //   - total_purchases_30d: COUNT(*)
  //   - refunded_30d: COUNT(*) WHERE refunded_at NOT NULL
  //   - refund_pct: refunded_30d / total
  //   - top_refund_window: bucket the refund-after-purchase delta:
  //       within_24h — likely buyer's-remorse / mistap
  //       within_7d  — likely Apple-mediated refund request
  //       after_7d   — likely chargeback / fraud claim
  //
  // The bucket distribution lets the operator distinguish UX issues
  // (high within_24h == confusing paywall) from IAP-fraud campaigns
  // (high after_7d == receipt-replay or chargeback fraud).
  //
  // Hits the recovery_plus_purchases purchase_at index. refunded_at
  // is not indexed (low cardinality NULL-skewed); sequential read of
  // the 30d slice is fine.
  app.get(
    '/v1/admin/recovery-shield/refund-rate',
    { preHandler: requireBearer },
    withAdminAudit('recovery-shield-refund-rate', async (_req, reply) => {
      const res = await query<{
        total: string;
        refunded: string;
        within_24h: string;
        within_7d: string;
        after_7d: string;
      }>(
        `SELECT
           COUNT(*)::TEXT                                                       AS total,
           COUNT(*) FILTER (WHERE refunded_at IS NOT NULL)::TEXT                AS refunded,
           COUNT(*) FILTER (
             WHERE refunded_at IS NOT NULL
               AND refunded_at - purchased_at <= INTERVAL '24 hours'
           )::TEXT                                                              AS within_24h,
           COUNT(*) FILTER (
             WHERE refunded_at IS NOT NULL
               AND refunded_at - purchased_at >  INTERVAL '24 hours'
               AND refunded_at - purchased_at <= INTERVAL '7 days'
           )::TEXT                                                              AS within_7d,
           COUNT(*) FILTER (
             WHERE refunded_at IS NOT NULL
               AND refunded_at - purchased_at >  INTERVAL '7 days'
           )::TEXT                                                              AS after_7d
         FROM recovery_plus_purchases
         WHERE purchased_at >= NOW() - INTERVAL '30 days'`,
      );
      const r = res.rows[0];
      const total_purchases_30d = parseInt(r?.total ?? '0', 10) || 0;
      const refunded_30d = parseInt(r?.refunded ?? '0', 10) || 0;
      const body: RefundRateResponse = {
        total_purchases_30d,
        refunded_30d,
        refund_pct: pct(refunded_30d, total_purchases_30d),
        top_refund_window: {
          within_24h: parseInt(r?.within_24h ?? '0', 10) || 0,
          within_7d: parseInt(r?.within_7d ?? '0', 10) || 0,
          after_7d: parseInt(r?.after_7d ?? '0', 10) || 0,
        },
      };
      return reply.send({ ...body, window_days: 30 });
    }),
  );
}
