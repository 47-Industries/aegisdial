import * as Sentry from '@sentry/node';
import { config } from '../config.js';
import { query } from './db.js';

// Observability — Sentry init + structured error capture + metric
// counters. Sentry is optional (graceful no-op when SENTRY_DSN is
// unset). Metrics land in Postgres for now; easy to migrate to
// Prometheus later without changing call sites.

let sentryInitialized = false;

// Keys that MUST never hit Sentry. Any occurrence in event.extra,
// event.contexts[*], event.tags, or event.request.data is overwritten
// with a placeholder. Match is case-sensitive against the exact key
// name — downstream code is responsible for not re-adding variants
// (e.g. "phoneNumber" is not on the list; normalize to `phone_number`
// or add the variant here).
const PII_KEYS: ReadonlySet<string> = new Set([
  'phone_number',
  'to',
  'body',
  'email',
  'phone',
  'tokenOnJws',
  'raw_payload',
]);

const PII_REDACTED = '[redacted]';

function scrubRecord(obj: Record<string, unknown> | undefined): void {
  if (!obj) return;
  for (const key of Object.keys(obj)) {
    if (PII_KEYS.has(key)) obj[key] = PII_REDACTED;
  }
}

// Sentry's exported Event / EventHint types pull in several transitive
// generics we don't need. Use a narrow structural type — Sentry calls
// this with a plain object at runtime.
interface ScrubbableEvent {
  extra?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | undefined>;
  request?: { data?: unknown };
}

export function beforeSend<T extends ScrubbableEvent>(event: T): T {
  try {
    scrubRecord(event.extra);
    scrubRecord(event.tags);
    if (event.contexts) {
      for (const ctxKey of Object.keys(event.contexts)) {
        scrubRecord(event.contexts[ctxKey]);
      }
    }
    if (event.request && event.request.data && typeof event.request.data === 'object') {
      scrubRecord(event.request.data as Record<string, unknown>);
    }
  } catch {
    // Never throw out of beforeSend — Sentry would drop the event
    // entirely and we'd lose the original error signal.
  }
  return event;
}

export function initObservability(): void {
  if (!config.SENTRY_DSN) {
    // eslint-disable-next-line no-console
    console.log('[observability] Sentry DSN not set — error capture is LOCAL ONLY');
    return;
  }
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
    // Scrub our own captureError(err, ctx) call-sites. `sendDefaultPii:
    // false` blocks Sentry from auto-attaching headers / IPs, but it does
    // NOT filter the `ctx` object we pass. Several call-sites forward
    // fields we must never ship off-box: guardianAlertEscalator forwards
    // Twilio error bodies that can contain phone numbers, recoveryCompanion
    // forwards userId + raw payloads, subscription.ts logs `tokenOnJws`
    // on mismatch. Strip those here so one surface is the definitive
    // scrub instead of relying on every call-site to remember.
    beforeSend,
  });
  sentryInitialized = true;
  // eslint-disable-next-line no-console
  console.log('[observability] Sentry initialized', { env: config.NODE_ENV });
}

/**
 * Capture an error with optional context. Safe to call whether or not
 * Sentry is wired — no-ops in dev without DSN.
 */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (sentryInitialized) {
    Sentry.withScope((scope) => {
      if (context) scope.setContext('context', context);
      Sentry.captureException(err);
    });
  }
  // Always log locally too — Sentry can rate-limit or drop.
  // eslint-disable-next-line no-console
  console.error('[error]', err, context ?? {});
}

export function captureMessage(msg: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  if (sentryInitialized) Sentry.captureMessage(msg, level);
}

// ---- Metric counters (Postgres-backed) ----

/**
 * Increment a named counter by 1 (or by value), bucketed to the minute.
 * Tags are stored as JSONB so they can be sliced in SQL later.
 *
 * Idempotency isn't enforced — if you call this twice for the same
 * semantic event you'll double-count. Use it for volumes, not exact
 * billing-grade counts.
 *
 * Never throws. A failed metric write must not take the request down.
 */
export async function emitMetric(
  name: string,
  tags: Record<string, string | number | boolean> = {},
  value: number = 1,
): Promise<void> {
  try {
    await query(
      `INSERT INTO metric_counters (name, tags, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (name, tags, bucket)
         DO UPDATE SET value = metric_counters.value + EXCLUDED.value`,
      [name, JSON.stringify(tags), value],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[observability] metric emit failed', { name, err });
  }
}

/**
 * Query recent metrics. Used by the admin dashboard + health probes.
 * Returns the last `hours` of buckets, optionally filtered by name.
 */
export async function readMetrics(
  opts: { hours?: number; name?: string } = {},
): Promise<Array<{ name: string; tags: Record<string, unknown>; bucket: string; value: string }>> {
  const hours = opts.hours ?? 24;
  const args: unknown[] = [`${hours} hours`];
  let where = 'bucket > NOW() - $1::INTERVAL';
  if (opts.name) {
    args.push(opts.name);
    where += ` AND name = $${args.length}`;
  }
  const rows = await query<{
    name: string;
    tags: Record<string, unknown>;
    bucket: Date;
    value: string;
  }>(
    `SELECT name, tags, bucket, value
       FROM metric_counters
      WHERE ${where}
      ORDER BY bucket DESC, name`,
    args,
  );
  return rows.rows.map((r) => ({
    name: r.name,
    tags: r.tags,
    bucket: r.bucket.toISOString(),
    value: r.value,
  }));
}

export { Sentry };
