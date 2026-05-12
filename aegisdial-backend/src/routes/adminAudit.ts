import { createHash, randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply, RouteHandlerMethod } from 'fastify';
import { emitMetric, captureError } from '../lib/observability.js';

// Live Shield v4 — Phase 20 — admin route audit + 500 sanitization.
//
// Two real residual gaps the v4 adversarial reviews surfaced:
//
//   1. AUDIT: shared-secret bearer auth means any holder can hit any
//      admin route. Without a request-side log line, a token
//      compromise has no forensic trail. Phase 15 added a one-off
//      log for the session-history endpoint specifically; this
//      module generalizes to ALL /admin/v4/* routes.
//
//   2. SANITIZATION: every v4 admin route currently uses raw
//      `await getXxxSummary()` with no try/catch. If pool.query
//      throws (table missing, connection reset, statement timeout),
//      Fastify's default error handler returns the throw message —
//      which from pg includes SQL fragments, table names, sometimes
//      column hints. Operator-facing audience, sure, but on a
//      shared-secret bearer surface the audience is anyone who got
//      the token. Sanitize to a generic body + correlation id;
//      log the real error server-side for triage.
//
// The wrapper is a higher-order function: `withAdminAudit(name, handler)`
// returns a Fastify handler with audit + try/catch + sanitization
// baked in. Each route wraps its real handler with this once.

/**
 * Optional header an operator can set to identify themselves in the
 * audit log. Falls back to 'unknown' when absent so we still emit
 * a trail even without cooperation. Forensic-trail purpose only —
 * the bearer secret is still the auth gate.
 */
export const OPERATOR_HEADER = 'x-operator-id';

/**
 * M-2 adversarial fix: hash + truncate the operator id before it
 * lands in metric_counters tags. The raw header value is unbounded
 * — an attacker (or buggy script) with the bearer could curl 10k
 * random X-Operator-Id values across one bucket-minute and explode
 * the metric_counters row count via the (name, tags, bucket)
 * uniqueness constraint. Hashing to a 12-char hex prefix bounds
 * cardinality at 2^48 while preserving stable identity for the
 * same operator. Raw value is still logged in req.log.info (server-
 * side only) so forensic triage isn't lost.
 *
 * 'unknown' sentinel (when header absent) is preserved as-is — it's
 * already low-cardinality.
 */
function operatorTagValue(rawHeader: string | undefined): string {
  if (!rawHeader) return 'unknown';
  const truncated = rawHeader.slice(0, 64);
  return createHash('sha256').update(truncated).digest('hex').slice(0, 12);
}

interface SanitizedErrorBody {
  error: 'admin_route_failed';
  /** Correlation id the operator can grep server-side logs for. */
  correlation_id: string;
  /** Route name (e.g. 'stage-timing') for human triage without
   *  leaking the actual exception text. */
  route: string;
}

/**
 * Wrap an admin route handler with audit + 500 sanitization.
 *
 * On success: emits `v4.admin.access` metric + structured info log
 * tagged by (route, operator). The handler's own return value flows
 * through unchanged.
 *
 * On exception: emits `v4.admin.failed` metric + captureError with
 * full server-side context, then returns a 500 with a
 * SanitizedErrorBody. The thrown message NEVER reaches the response
 * body, preventing DB schema / SQL fragment leak via the bearer
 * surface.
 *
 * @param routeName short identifier for the route (used in audit
 *                  metric tags + sanitized response). Should match
 *                  the route's path suffix for grep-ability,
 *                  e.g. 'stage-timing' for /admin/v4/stage-timing.
 */
export function withAdminAudit<TReply = unknown>(
  routeName: string,
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<TReply>,
): RouteHandlerMethod {
  return async function wrapped(req, reply) {
    const rawOperator = req.headers[OPERATOR_HEADER] as string | undefined;
    // Tag uses the hashed/bounded form; logs use the raw value.
    const operator = operatorTagValue(rawOperator);
    const operatorRaw = rawOperator?.slice(0, 64) ?? 'unknown';
    const correlation_id = randomUUID();
    const started = Date.now();

    try {
      const result = await handler(req, reply);
      // Only emit audit on a successful handler return. If the
      // handler called reply.code(4xx) (e.g., 400 invalid_hours),
      // it's still "successful" from a routing perspective — the
      // metric reflects "the route ran to completion."
      const duration_ms = Date.now() - started;
      void emitMetric('v4.admin.access', {
        route: routeName,
        operator,
        status: String(reply.statusCode || 200),
      });
      // Slow-query detection: anything over the 1s budget gets its
      // own metric so a dashboard alert can fire on degraded query
      // performance before users notice. Threshold tuned to the
      // expected p99 for the GROUP BY queries against
      // metric_counters under the Phase 21 partial index.
      if (duration_ms > 1000) {
        void emitMetric('v4.admin.slow_route', {
          route: routeName,
          duration_bucket: duration_ms > 5000 ? 'gt5s' : duration_ms > 2000 ? 'gt2s' : 'gt1s',
        });
      }
      req.log.info(
        {
          route: routeName,
          operator,
          operator_raw: operatorRaw,
          status: reply.statusCode || 200,
          duration_ms,
          correlation_id,
        },
        'admin.v4.access',
      );
      return result;
    } catch (err) {
      const duration_ms = Date.now() - started;
      void emitMetric('v4.admin.failed', { route: routeName, operator });
      captureError(err, {
        component: 'admin.v4',
        route: routeName,
        operator,
        correlation_id,
        duration_ms,
      });
      req.log.error(
        {
          route: routeName,
          operator,
          operator_raw: operatorRaw,
          correlation_id,
          duration_ms,
          err: err instanceof Error ? err.message : String(err),
        },
        'admin.v4.failed',
      );
      const body: SanitizedErrorBody = {
        error: 'admin_route_failed',
        correlation_id,
        route: routeName,
      };
      // M-1 adversarial fix: a handler that called reply.send() then
      // threw downstream (e.g., emitMetric inside a route after send)
      // would land in this catch. Calling reply.code().send() again
      // would emit a FST_ERR_REP_ALREADY_SENT warn. Guard with the
      // sent-check so a future code path can't trip it.
      if (reply.sent) return;
      return reply.code(500).send(body);
    }
  };
}
