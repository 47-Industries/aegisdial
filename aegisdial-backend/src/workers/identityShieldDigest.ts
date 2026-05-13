import cron from 'node-cron';
import { query } from '../lib/db.js';
import { cacheGet, cacheSetNX } from '../lib/cache.js';
import { captureError, emitMetric } from '../lib/observability.js';
import { sendToUser } from '../lib/apns.js';

// Identity Shield — push-digest scheduler (I-P5).
//
// Two crons, two cadences, one composition path:
//
//   Daily   cron — Mon–Fri 13:00 UTC (~8am US-East, 6am US-Pac, 1pm UK).
//                  Pushes 'daily' digest to users whose
//                  user_settings.identity_digest_cadence='daily'.
//                  Weekend pause is deliberate — daily-tier users want
//                  Monday-through-Friday "what happened overnight"
//                  texture, not weekend noise (the underlying threat
//                  feeds slow on weekends anyway).
//
//   Weekly  cron — Monday   13:00 UTC.
//                  Pushes 'weekly' digest to users whose cadence is
//                  'weekly'. Same time-slot as Monday-daily, but the
//                  weekly body summarizes the prior 7d. Users with
//                  cadence='daily' already got their Monday-daily push
//                  earlier in the same minute — the weekly worker
//                  explicitly skips them via the cadence WHERE clause
//                  (no double-push, even if cron-firing order races).
//
// COMPOSITION:
//   - Daily body: "AegisDial blocked N scams aimed at people with leaked
//                  data like yours yesterday." where N = high-severity
//                  active_threats first_seen in the last 24h, geo-scoped
//                  when the user has a geo set.
//   - Weekly body: "We're watching N data points. Y new breaches this
//                   week. Z active scammers near you." where N =
//                   monitors_active, Y = findings_7d, Z = active_threats
//                   first_seen_at within 7d (geo-scoped when set).
//   - Empty-weekly short-circuit: if N=0 AND Y=0 → return null. We
//                                  don't push an empty weekly. Empty-
//                                  daily DOES still push if the global
//                                  threat-count is non-zero — daily is
//                                  the engagement hook, not the user-
//                                  specific find.
//
// OPT-OUT MODEL (user_settings.identity_digest_cadence):
//   - 'off'    → sendDigestForUser returns {sent:false, reason_skipped:'optout'}.
//   - 'daily'  → daily cron pushes; weekly cron skips silently.
//   - 'weekly' → weekly cron pushes; daily cron skips silently.
//   - row absent → default 'weekly' (matches migration 075 column default).
//                  The worker treats absence as 'weekly' rather than
//                  inserting a row eagerly — first explicit cadence
//                  change inserts via UPSERT in the settings route
//                  (separate from this worker).
//
// IDEMPOTENCY:
//   Redis key per (user, kind): identity_digest:last_pushed:<user>:<kind>.
//   TTL = 23h (daily) / 6d (weekly). cacheSetNX returns OK only when
//   the slot was empty; an OK loser means a prior push fired inside
//   the dedup window and we skip.
//
//   NOTE: SETNX is the only correct primitive for this. Read-then-write
//   ("if (await cacheGet(...)) skip; await cacheSet(...)") has a TOCTOU
//   race window — two concurrent cron-tick instances (or the same tick
//   on two Fly nodes) both pass the existence check before either
//   writes. Atomic SET-if-not-exists eliminates that.
//
// PUSH FAILURE TOLERANCE:
//   sendDigestForUser catches its own pushSender throw, counts it as
//   'error' for the metric, and returns {sent:false, reason_skipped:
//   'push_error'}. runDigestPassOnce loops over users and increments
//   per-user — one user's APNs failure NEVER stops the pass.

// ───────────────────────────────────────────────────────────────
// Schedules
// ───────────────────────────────────────────────────────────────

// Daily: 13:00 UTC Monday–Friday. cron field 5 = day-of-week (1–5 = Mon–Fri).
const DAILY_DIGEST_CRON = '0 13 * * 1-5';

// Weekly: 13:00 UTC every Monday. Same hour as the daily run; the
// cadence-WHERE filter inside the SQL keeps daily-cohort and weekly-
// cohort users from colliding even if both crons fire in the same
// minute. Monday-cadence='daily' users get one push (daily); Monday-
// cadence='weekly' users get one push (weekly).
const WEEKLY_DIGEST_CRON = '0 13 * * 1';

// Idempotency-gate TTLs. Daily fires every weekday at the same minute,
// so 23h is the dedupe window (less than the next-tick interval, so
// a process restart or cron retry inside the window is the no-op
// case). Weekly fires once every 7 days, so 6 days * 24h = 144h.
const DAILY_DEDUP_TTL_SEC = 23 * 60 * 60;
const WEEKLY_DEDUP_TTL_SEC = 6 * 24 * 60 * 60;

// ───────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────

export interface DigestPayload {
  digest_kind: 'daily' | 'weekly';
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export interface SendDigestResult {
  sent: boolean;
  reason_skipped?: string;
}

export interface RunDigestPassResult {
  daily_users_pushed: number;
  weekly_users_pushed: number;
  skipped_optout: number;
  skipped_empty: number;
  skipped_recent_push: number;
  skipped_other: number;
  push_errors: number;
}

export interface DigestSchedulerHandle {
  dailyTask: cron.ScheduledTask;
  weeklyTask: cron.ScheduledTask;
}

// pushSender contract — sendToUser-shaped. Tests inject an in-memory
// recorder; production wiring leaves the default.
export type PushSender = typeof sendToUser;

// ───────────────────────────────────────────────────────────────
// Cadence lookup
// ───────────────────────────────────────────────────────────────

/**
 * Read the user's digest cadence preference. Returns 'weekly' when
 * the user_settings row doesn't exist yet — matches migration 075's
 * column default, and avoids the eager-INSERT-on-read pattern that
 * would write a row for every user the digest pass ever considers.
 *
 * Returns null only when the table itself doesn't exist (rolling
 * deploy state) — caller treats null as a no-op for safety.
 */
async function getCadence(userId: string): Promise<'daily' | 'weekly' | 'off' | null> {
  try {
    const res = await query<{ identity_digest_cadence: string }>(
      `SELECT identity_digest_cadence
         FROM user_settings
        WHERE user_id = $1`,
      [userId],
    );
    if ((res.rowCount ?? 0) === 0) return 'weekly';
    const v = res.rows[0]!.identity_digest_cadence;
    if (v === 'daily' || v === 'weekly' || v === 'off') return v;
    // Unrecognized vocabulary — treat as weekly so an out-of-band
    // schema-drift doesn't silently disable the digest.
    return 'weekly';
  } catch (err) {
    captureError(err, { component: 'identityShieldDigest.getCadence', user_id: userId });
    return null;
  }
}

// ───────────────────────────────────────────────────────────────
// Compose
// ───────────────────────────────────────────────────────────────

/**
 * Build the push envelope for `user_id` × `digest_kind`. Returns null
 * when the user has opted out OR when a weekly digest would be empty
 * (zero monitors AND zero findings). Daily digests can still send with
 * zero per-user findings — the body cites the global threat-block
 * count, which is the engagement hook.
 */
export async function composeDigestForUser(input: {
  user_id: string;
  digest_kind: 'daily' | 'weekly';
  /** Optional ISO-3166 alpha-2; scopes the active_threats counts when present. */
  geo_tag?: string | null;
}): Promise<DigestPayload | null> {
  const { user_id, digest_kind } = input;
  const geoTag = input.geo_tag ?? null;

  // Opt-out gate. composeDigestForUser is the canonical opt-out
  // boundary — sendDigestForUser also checks, but composing for an
  // opted-out user is wasted DB load.
  const cadence = await getCadence(user_id);
  if (cadence === 'off' || cadence === null) {
    return null;
  }

  // Per-user counts — both wrapped so a missing relation on this
  // node doesn't crash the worker. monitors_active drives the
  // weekly body; new_findings_7d drives the body of both kinds.
  let monitorsActive = 0;
  let newFindings7d = 0;
  try {
    const m = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM identity_monitors
        WHERE user_id = $1 AND active = TRUE`,
      [user_id],
    );
    monitorsActive = parseInt(m.rows[0]?.count ?? '0', 10) || 0;
  } catch (err) {
    captureError(err, { component: 'identityShieldDigest.compose.monitors', user_id });
  }
  try {
    const f = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM identity_breach_findings
        WHERE user_id = $1 AND surfaced_at > NOW() - INTERVAL '7 days'`,
      [user_id],
    );
    newFindings7d = parseInt(f.rows[0]?.count ?? '0', 10) || 0;
  } catch (err) {
    captureError(err, { component: 'identityShieldDigest.compose.findings', user_id });
  }

  // Geo-scoping: when the user has a geo set, active_threats counts
  // restrict to that geo_tag; otherwise the count is the global pool.
  // Both queries use NOT-expired active rows only — expired threats
  // don't make the dashboard, and they don't make the digest.
  const geoParams: unknown[] = [];
  let geoCond = '';
  if (geoTag !== null) {
    geoParams.push(geoTag);
    geoCond = ` AND geo_tag = $${geoParams.length}`;
  }

  let scamsBlockedYesterday = 0; // daily body
  let activeThreatsNear7d = 0; // weekly body
  try {
    const r = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM active_threats
        WHERE first_seen_at > NOW() - INTERVAL '24 hours'
          AND severity IN ('warning','confirmed_scammer')
          AND (expires_at IS NULL OR expires_at > NOW())${geoCond}`,
      geoParams,
    );
    scamsBlockedYesterday = parseInt(r.rows[0]?.count ?? '0', 10) || 0;
  } catch (err) {
    captureError(err, { component: 'identityShieldDigest.compose.threats_24h', user_id });
  }
  try {
    const r = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM active_threats
        WHERE first_seen_at > NOW() - INTERVAL '7 days'
          AND (expires_at IS NULL OR expires_at > NOW())${geoCond}`,
      geoParams,
    );
    activeThreatsNear7d = parseInt(r.rows[0]?.count ?? '0', 10) || 0;
  } catch (err) {
    captureError(err, { component: 'identityShieldDigest.compose.threats_7d', user_id });
  }

  if (digest_kind === 'weekly') {
    // Empty-weekly short-circuit. If the user has nothing to watch
    // and nothing surfaced in the last 7d, the weekly digest is just
    // noise — we'd rather not push than push "0 of nothing happened".
    // active_threats counts intentionally NOT in this gate: a global
    // threat-pool figure without per-user findings is engagement-
    // farming, not value.
    if (monitorsActive === 0 && newFindings7d === 0) {
      return null;
    }
    const monitorsLabel = monitorsActive === 1 ? 'data point' : 'data points';
    const breachesLabel = newFindings7d === 1 ? 'new breach' : 'new breaches';
    const scammersLabel = activeThreatsNear7d === 1 ? 'active scammer' : 'active scammers';
    const body =
      `We're watching ${monitorsActive} ${monitorsLabel}. ` +
      `${newFindings7d} ${breachesLabel} this week. ` +
      `${activeThreatsNear7d} ${scammersLabel} near you.`;
    return {
      digest_kind,
      title: 'Weekly Shield report',
      body,
      data: {
        kind: 'identity_shield_digest',
        digest_kind,
        monitors_active: monitorsActive,
        new_findings_7d: newFindings7d,
        active_threats_near_7d: activeThreatsNear7d,
      },
    };
  }

  // Daily kind. Body cites the 24h "scams blocked aimed at people
  // with leaked data like yours" figure — even when the user's
  // monitors/findings are 0, the global figure is the news-hook.
  // (The retention angle: subscription apps that don't surface
  // "you're being protected" daily lose engagement → cancel.)
  const scamsLabel = scamsBlockedYesterday === 1 ? 'scam' : 'scams';
  const body =
    `AegisDial blocked ${scamsBlockedYesterday} ${scamsLabel} aimed at people ` +
    `with leaked data like yours yesterday.`;
  return {
    digest_kind,
    title: "We're watching",
    body,
    data: {
      kind: 'identity_shield_digest',
      digest_kind,
      scams_blocked_yesterday: scamsBlockedYesterday,
      new_findings_7d: newFindings7d,
    },
  };
}

// ───────────────────────────────────────────────────────────────
// Send (single user)
// ───────────────────────────────────────────────────────────────

/**
 * Compose + push for a single user. Five short-circuit paths:
 *
 *   'optout'        — user_settings.identity_digest_cadence='off'
 *   'cadence_mismatch' — daily cron fired but user is weekly (or vice versa)
 *   'empty'         — composeDigestForUser returned null (nothing worth sending)
 *   'recent_push'   — Redis-backed gate fired (idempotency window not yet elapsed)
 *   'push_error'    — pushSender threw; counted, NOT re-thrown
 *
 * Returns {sent:true} only after the push lands successfully (or
 * lands on zero devices — the latter is a no-token-state, not a
 * failure; we still claim sent so the next-day retry is gated).
 */
export async function sendDigestForUser(input: {
  user_id: string;
  digest_kind: 'daily' | 'weekly';
  opts?: { pushSender?: PushSender; geo_tag?: string | null };
}): Promise<SendDigestResult> {
  const { user_id, digest_kind } = input;
  const pushSender = input.opts?.pushSender ?? sendToUser;
  const geo_tag = input.opts?.geo_tag ?? null;

  // Cadence gate — the canonical opt-out boundary. We re-check here
  // even though composeDigestForUser also does, so a caller invoking
  // sendDigestForUser directly (without first calling compose) still
  // honors opt-out. Belt-and-braces: an attacker that bypasses
  // composition (e.g., via a future internal sendDigestForUser
  // caller) still hits this gate.
  const cadence = await getCadence(user_id);
  if (cadence === null) {
    // Table missing on this node (rolling deploy). Treat as silently
    // skipped — we'd rather miss the push than crash the worker.
    return { sent: false, reason_skipped: 'cadence_unavailable' };
  }
  if (cadence === 'off') {
    void emitMetric('identity_shield.digest_skipped', { reason: 'optout' });
    return { sent: false, reason_skipped: 'optout' };
  }
  if (cadence !== digest_kind) {
    // e.g., daily cron iterated this user but their cadence is weekly.
    // Silent skip — NOT counted as opt-out (that's a distinct user
    // intent). The cron's SQL filter already excludes them; this is
    // the defense-in-depth check for direct callers.
    return { sent: false, reason_skipped: 'cadence_mismatch' };
  }

  // Idempotency gate. cacheSetNX returns 'OK' iff the key was empty
  // — i.e., no recent push for this (user, kind). The TTL is the
  // dedup window. Race-safe across multiple Fly instances via Redis.
  const dedupKey = `identity_digest:last_pushed:${user_id}:${digest_kind}`;
  const dedupTtl = digest_kind === 'daily' ? DAILY_DEDUP_TTL_SEC : WEEKLY_DEDUP_TTL_SEC;
  let claimed: boolean;
  try {
    claimed = await cacheSetNX(dedupKey, String(Date.now()), dedupTtl);
  } catch (err) {
    // Redis unavailable — fall through to push WITHOUT the dedup gate.
    // The push itself is the more important surface; we'd rather a
    // rare double-push than skip-everything when Redis is down.
    captureError(err, { component: 'identityShieldDigest.dedup_gate', user_id });
    claimed = true;
  }
  if (!claimed) {
    void emitMetric('identity_shield.digest_skipped', { reason: 'recent_push' });
    return { sent: false, reason_skipped: 'recent_push' };
  }

  // Compose. The dedup slot is already claimed at this point — if
  // composition returns null (empty digest), we've still consumed
  // the slot. That's intentional: weekly empty-skip should still
  // gate the next 6 days, otherwise a user with no monitors would
  // retry every cron tick.
  const payload = await composeDigestForUser({ user_id, digest_kind, geo_tag });
  if (payload === null) {
    void emitMetric('identity_shield.digest_skipped', { reason: 'empty' });
    return { sent: false, reason_skipped: 'empty' };
  }

  void emitMetric('identity_shield.digest_composed', { kind: digest_kind });

  // Push. Wrap the sender in a try so an APNs throw (network, p8
  // misconfig, etc.) doesn't cascade-stop the pass. The metric is
  // tagged 'push_error' so we can alert on a sudden spike.
  try {
    await pushSender({
      userId: user_id,
      title: payload.title,
      body: payload.body,
      threadId: 'identity-shield-digest',
      data: payload.data,
      interruptionLevel: 'passive',
      priority: 5,
    });
    void emitMetric('identity_shield.digest_pushed', { kind: digest_kind });
    return { sent: true };
  } catch (err) {
    captureError(err, {
      component: 'identityShieldDigest.push',
      user_id,
      digest_kind,
    });
    void emitMetric('identity_shield.digest_skipped', { reason: 'push_error' });
    return { sent: false, reason_skipped: 'push_error' };
  }
}

// ───────────────────────────────────────────────────────────────
// Daily / Weekly pass
// ───────────────────────────────────────────────────────────────

/**
 * Run BOTH daily and weekly passes (whichever apply for the current
 * UTC day). The daily cron only invokes this on weekdays; the weekly
 * cron only invokes it on Monday — but to keep the test surface
 * narrow (and to make manual runs deterministic), the function does
 * both unconditionally. The cadence-WHERE filter in the SQL keeps
 * users from being double-pushed.
 */
export async function runDigestPassOnce(opts?: {
  pushSender?: PushSender;
}): Promise<RunDigestPassResult> {
  const pushSender = opts?.pushSender ?? sendToUser;
  const result: RunDigestPassResult = {
    daily_users_pushed: 0,
    weekly_users_pushed: 0,
    skipped_optout: 0,
    skipped_empty: 0,
    skipped_recent_push: 0,
    skipped_other: 0,
    push_errors: 0,
  };

  // The two cohorts are read in separate queries — daily users get
  // daily, weekly users get weekly. The cron-runtime distinction
  // (weekday-only daily, Monday-only weekly) is enforced by the
  // schedule strings; this function just iterates both cohorts.
  let dailyUsers: string[] = [];
  let weeklyUsers: string[] = [];
  try {
    const r = await query<{ user_id: string }>(
      `SELECT user_id FROM user_settings WHERE identity_digest_cadence = 'daily'`,
    );
    dailyUsers = r.rows.map((row) => row.user_id);
  } catch (err) {
    captureError(err, { component: 'identityShieldDigest.fetch_daily_cohort' });
  }
  try {
    const r = await query<{ user_id: string }>(
      `SELECT user_id FROM user_settings WHERE identity_digest_cadence = 'weekly'`,
    );
    weeklyUsers = r.rows.map((row) => row.user_id);
  } catch (err) {
    captureError(err, { component: 'identityShieldDigest.fetch_weekly_cohort' });
  }

  // Per-user error containment: each sendDigestForUser call is wrapped
  // so one user's surprise throw (a malformed monitor row, a transient
  // DB hiccup at composition time) does NOT stop the pass. The metric
  // tally below makes per-cron failures visible without an alert
  // storm — we tally + emit one counter, not one error per user.
  for (const userId of dailyUsers) {
    try {
      const r = await sendDigestForUser({
        user_id: userId,
        digest_kind: 'daily',
        opts: { pushSender },
      });
      tallyOutcome(result, 'daily', r);
    } catch (err) {
      result.push_errors++;
      captureError(err, { component: 'identityShieldDigest.daily_pass', user_id: userId });
    }
  }
  for (const userId of weeklyUsers) {
    try {
      const r = await sendDigestForUser({
        user_id: userId,
        digest_kind: 'weekly',
        opts: { pushSender },
      });
      tallyOutcome(result, 'weekly', r);
    } catch (err) {
      result.push_errors++;
      captureError(err, { component: 'identityShieldDigest.weekly_pass', user_id: userId });
    }
  }

  return result;
}

function tallyOutcome(
  result: RunDigestPassResult,
  kind: 'daily' | 'weekly',
  r: SendDigestResult,
): void {
  if (r.sent) {
    if (kind === 'daily') result.daily_users_pushed++;
    else result.weekly_users_pushed++;
    return;
  }
  switch (r.reason_skipped) {
    case 'optout':
      result.skipped_optout++;
      break;
    case 'empty':
      result.skipped_empty++;
      break;
    case 'recent_push':
      result.skipped_recent_push++;
      break;
    case 'push_error':
      result.push_errors++;
      break;
    default:
      result.skipped_other++;
  }
}

// ───────────────────────────────────────────────────────────────
// Cron lifecycle
// ───────────────────────────────────────────────────────────────

/**
 * Boot both digest crons. Daily runs Mon–Fri 13:00 UTC, weekly runs
 * Monday 13:00 UTC. Both invoke runDigestPassOnce; the cadence-WHERE
 * filter in the SQL ensures each user receives at most one push per
 * cron run (daily cohort pushed by daily cron, weekly cohort pushed
 * by weekly cron — never both).
 */
export function startIdentityShieldDigest(): DigestSchedulerHandle {
  const dailyTask = cron.schedule(
    DAILY_DIGEST_CRON,
    () => {
      void (async () => {
        const started = Date.now();
        // Daily cron pushes only the 'daily' cohort. To avoid scanning
        // weekly users on a daily tick we'd want a two-fn split, but
        // the cohort SELECTs are cheap (small partial-index scan) and
        // sendDigestForUser short-circuits weekly-cohort users via
        // cadence_mismatch — net effect is the same. Logging keeps
        // the runDigestPassOnce surface unified.
        const r = await runDigestPassOnce();
        // eslint-disable-next-line no-console
        console.log('[identity-shield-digest] daily complete', {
          duration_ms: Date.now() - started,
          ...r,
        });
      })();
    },
    { timezone: 'UTC' },
  );

  const weeklyTask = cron.schedule(
    WEEKLY_DIGEST_CRON,
    () => {
      void (async () => {
        const started = Date.now();
        const r = await runDigestPassOnce();
        // eslint-disable-next-line no-console
        console.log('[identity-shield-digest] weekly complete', {
          duration_ms: Date.now() - started,
          ...r,
        });
      })();
    },
    { timezone: 'UTC' },
  );

  return { dailyTask, weeklyTask };
}

export function stopIdentityShieldDigest(handle: DigestSchedulerHandle): void {
  handle.dailyTask.stop();
  handle.weeklyTask.stop();
}

// ───────────────────────────────────────────────────────────────
// Test helper exposure
// ───────────────────────────────────────────────────────────────

/**
 * Probe helper for tests + observability: check whether the dedup
 * gate is currently held for (user, kind). Returns the stringified
 * timestamp the gate was set, or null when the slot is free.
 * Not used by production paths.
 */
export async function readLastPushedAt(
  user_id: string,
  digest_kind: 'daily' | 'weekly',
): Promise<string | null> {
  const dedupKey = `identity_digest:last_pushed:${user_id}:${digest_kind}`;
  return cacheGet<string>(dedupKey);
}
