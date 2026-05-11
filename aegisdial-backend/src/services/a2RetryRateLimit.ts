import { config } from '../config.js';
import { redis } from '../lib/cache.js';
import { emitMetric, captureError } from '../lib/observability.js';

// Live Shield v3 — A2 retry-notification rate limiter (Redis-backed).
//
// Replaces the original Postgres-COUNT-based gate in routes/blocks.ts.
// The Postgres version did:
//
//   SELECT COUNT(*) FROM block_retry_attempts WHERE ... AND notification_sent
//   SELECT COUNT(*) FROM block_retry_attempts WHERE ... AND e164 = ...
//   if both counts < caps: INSERT with notification_sent = TRUE
//
// — three non-atomic round-trips. A burst of retry-attempts from a
// flaky iOS client (or a malicious one) where N requests interleave
// between the SELECTs and the INSERT all see "0 prior eligible" and
// each get notification_sent=TRUE. Rate limit blown.
//
// Redis INCR + EXPIRE is atomic, single round-trip, and exactly what
// we need. Two counters per (user, time-window):
//
//   v3:a2:rl:day:{user_id}   — TTL 24h, cap V3_A2_RETRY_NOTIFY_RATE_PER_24H
//   v3:a2:rl:num:{user_id}:{e164}  — TTL 1h, cap V3_A2_RETRY_NOTIFY_PER_NUMBER_HOURLY
//
// Both must be under their respective caps for the attempt to be
// eligible for an individual push; otherwise it rolls into the daily
// digest (same downstream semantics as before).
//
// Failure mode: Redis down → fail SAFE (treat as eligible). The
// alternative (fail closed = always digest) would silently break the
// A2 retry-push UX during a Redis outage, which is worse than briefly
// allowing the cap to slip while we page someone. Capacity protection
// at higher levels (Stripe-tier limits, APNs delivery caps) catches
// the rare blown-cap case.

export interface RateLimitDecision {
  eligible: boolean;
  /** Reason when not eligible — for observability / debug. */
  reason:
    | 'eligible'
    | 'day_cap_exceeded'
    | 'hourly_per_number_exceeded'
    | 'redis_unavailable'
    | 'kill_switch';
  /** New count values after the increment — useful for tests + alarms. */
  day_count: number;
  hourly_count: number;
}

const DAY_TTL_SECONDS = 24 * 60 * 60;
const HOUR_TTL_SECONDS = 60 * 60;

/**
 * Atomically check + reserve a notification slot for this user + e164.
 * Returns whether the attempt is eligible for an individual push. The
 * counter is INCREMENTED whether or not we accept (so the cap means
 * "rolling window total attempts" not "approved attempts" — same
 * semantics the original SELECT COUNT had with notification_sent=TRUE
 * filter, plus this includes deliberate burst attempts as evidence
 * a client is misbehaving).
 *
 * Decrement-on-reject would let a bursty client churn the counter and
 * permanently park at cap-1. Don't.
 */
export async function tryReserveRetryNotification(
  user_id: string,
  e164: string,
): Promise<RateLimitDecision> {
  // M-2 emergency kill-switch. If Redis is down or a scammer is
  // actively pumping the system, ops can flip this to fail-closed
  // (all → digest) without a deploy. Default false = normal operation.
  if (config.V3_A2_RETRY_NOTIFY_KILL_SWITCH) {
    void emitMetric('v3.a2.kill_switch_engaged', {});
    return {
      eligible: false,
      reason: 'kill_switch',
      day_count: 0,
      hourly_count: 0,
    };
  }

  const dayCap = config.V3_A2_RETRY_NOTIFY_RATE_PER_24H;
  const hourCap = config.V3_A2_RETRY_NOTIFY_PER_NUMBER_HOURLY;

  // H-2 fix: check the per-number HOUR cap FIRST. A flaky iOS client
  // retrying the same blocked number 10× must not consume 10 slots
  // out of the per-user day budget — otherwise a single bad network
  // event gags legit alerts from OTHER numbers for the rest of the
  // day. By gating on hour cap before touching the day counter, the
  // 2nd–10th flaky retries are rejected without spending any day
  // budget. The original SQL semantics did this via filtering on
  // notification_sent=TRUE; this restores it.
  //
  // M-1 fix: incrWithTtl is a single atomic round-trip (Lua-backed
  // on real Redis, single-statement on InMemoryCache). The old
  // INCR + EXPIRE 2-RTT pattern had a crash window between them
  // where a process death could orphan a key with no TTL — slow
  // leak in Upstash + stuck counter for the unlucky user.
  let hourlyCount: number;
  try {
    const hourKey = `v3:a2:rl:num:${user_id}:${e164}`;
    hourlyCount = await redis.incrWithTtl(hourKey, HOUR_TTL_SECONDS);
  } catch (err) {
    captureError(err, { component: 'a2RetryRateLimit.hour', user_id });
    void emitMetric('v3.a2.rate_limit_redis_unavailable', {});
    return {
      eligible: true,
      reason: 'redis_unavailable',
      day_count: 0,
      hourly_count: 0,
    };
  }

  if (hourlyCount > hourCap) {
    void emitMetric('v3.a2.rate_limit_hourly_per_number_exceeded', { user_id });
    return {
      eligible: false,
      reason: 'hourly_per_number_exceeded',
      day_count: 0, // day counter NOT touched — preserves old semantics
      hourly_count: hourlyCount,
    };
  }

  // Hour cap is under limit. NOW INCR the day counter.
  let dayCount: number;
  try {
    const dayKey = `v3:a2:rl:day:${user_id}`;
    dayCount = await redis.incrWithTtl(dayKey, DAY_TTL_SECONDS);
  } catch (err) {
    captureError(err, { component: 'a2RetryRateLimit.day', user_id });
    void emitMetric('v3.a2.rate_limit_redis_unavailable', {});
    return {
      eligible: true,
      reason: 'redis_unavailable',
      day_count: 0,
      hourly_count: hourlyCount,
    };
  }

  if (dayCount > dayCap) {
    void emitMetric('v3.a2.rate_limit_day_cap_exceeded', { user_id });
    return {
      eligible: false,
      reason: 'day_cap_exceeded',
      day_count: dayCount,
      hourly_count: hourlyCount,
    };
  }

  return {
    eligible: true,
    reason: 'eligible',
    day_count: dayCount,
    hourly_count: hourlyCount,
  };
}

/**
 * Test-only — clear the counter keys for a (user, e164). Lets unit
 * tests reset state between assertions without flushing the whole
 * Redis instance.
 */
export async function _resetRateLimitForTests(
  user_id: string,
  e164: string,
): Promise<void> {
  try {
    await redis.del(`v3:a2:rl:day:${user_id}`);
    await redis.del(`v3:a2:rl:num:${user_id}:${e164}`);
  } catch (err) {
    // L-1: warn instead of swallow so a real bug doesn't hide here.
    // Normal flow shouldn't error — del is idempotent on missing keys.
    // eslint-disable-next-line no-console
    console.warn('[a2RetryRateLimit] _resetRateLimitForTests del failed', {
      user_id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
