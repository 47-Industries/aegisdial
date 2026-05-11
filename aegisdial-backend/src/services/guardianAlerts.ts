import { query } from '../lib/db.js';
import { redis } from '../lib/cache.js';
import { emitMetric } from '../lib/observability.js';
import { config } from '../config.js';

// R8 per-recipient family-alert cooldown — the original Phase 5 PR
// shipped per-shield_takeover-kind suppression but missed the broader
// reviewer note: a session that triggers multiple alert kinds in
// quick succession (e.g. shield_critical at t=0, safe_word_failed at
// t=5s, recovery_started at t=10s) still pages the same family
// member three times in 10 seconds. Critical severity bypasses the
// cooldown by design — the post-dismiss escalation fires critical
// 30s after the original shield_critical, and Mom should see both
// regardless of any anti-spam window.
//
// Implementation: Redis atomic INCR with first-set TTL. Returns 1 on
// the first call in the window (allow), >1 on subsequent (suppress).
// Failure mode: Redis down → fail-open (allow the alert). Auditable
// via `v3.guardian_alert.cooldown_fail_open` metric.
const FAMILY_ALERT_COOLDOWN_SECONDS = 60;

function cooldownKey(recipientId: string, subjectId: string): string {
  return `guardian_alert:cooldown:${recipientId}:${subjectId}`;
}

/**
 * Test-only escape hatch. Production code never calls this — cooldown
 * keys are managed exclusively by `filterByCooldown` (the production
 * path) via INCR + EXPIRE. Tests need to reset state between cases
 * because the same SUBJECT+GUARDIANS fixtures fire multiple emits in
 * the same node:test process; without this, the second test would
 * see all guardians suppressed.
 *
 * Returns the number of keys deleted (informational only).
 *
 * Sixth-pass adversarial fix (MEDIUM-3): refuses when
 * `config.NODE_ENV === 'production'`. Reading from `config` (which
 * zod-defaults to 'development') instead of `process.env.NODE_ENV`
 * (which is undefined under `node --test`) means the env-unset case
 * cannot accidentally fall through to "allowed in prod." The threat
 * model here is "a future developer accidentally imports this from a
 * route handler" — only prod is the real harm scenario; wiping a 60s
 * cooldown in staging is harmless.
 */
export async function _resetCooldownForTests(
  subjectUserId: string,
  guardianIds: string[],
): Promise<number> {
  if (config.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.warn(
      '[guardianAlerts] _resetCooldownForTests refused — config.NODE_ENV is production',
    );
    return 0;
  }
  // Parallel del — same shape as the production filter.
  const results = await Promise.all(
    guardianIds.map((gid) =>
      redis.del(cooldownKey(gid, subjectUserId)).catch(() => 0),
    ),
  );
  return results.reduce((acc, n) => acc + n, 0);
}

/**
 * Returns the subset of guardianIds that have NOT been alerted about
 * this subject within the cooldown window. Critical severity skips
 * the check entirely (returns input unchanged) — the cooldown is an
 * anti-spam mechanism for chatty info/warning kinds, not a safety
 * gate on real emergencies.
 *
 * Side effect: for every guardian that passes the gate, the cooldown
 * key is set/refreshed so subsequent lower-severity pings within the
 * window get suppressed. Critical sends ALSO set the key so a
 * critical at t=0 then a recovery_started at t=5 is correctly
 * suppressed (the critical "claimed" the recipient's attention for
 * the next minute).
 */
async function filterByCooldown(
  guardianIds: string[],
  subjectUserId: string,
  severity: GuardianAlertSeverity,
  kind: GuardianAlertKind,
): Promise<string[]> {
  // Critical severity always goes through. We still set the cooldown
  // key (via the same INCR) so subsequent lower-severity pings are
  // suppressed.
  const isCritical = severity === 'critical';

  // Sixth-pass adversarial fix (MEDIUM-1): parallelize per-guardian
  // INCRs. A 10-member plan was paying 10 serial Redis RTTs (~50-100ms
  // on Upstash), partially undoing the multi-row-INSERT wall-clock win
  // the original PR called out. Each INCR is independent — `Promise.all`
  // is a single async wave with no atomicity penalty (each key's INCR
  // is still atomic Lua via incrWithTtl). Per-guardian try/catch is
  // preserved by mapping errors to a sentinel `null`.
  const counts = await Promise.all(
    guardianIds.map((gid) =>
      redis
        .incrWithTtl(cooldownKey(gid, subjectUserId), FAMILY_ALERT_COOLDOWN_SECONDS)
        .catch(() => null as number | null),
    ),
  );

  const allowed: string[] = [];
  let criticalBypassCount = 0;
  let suppressedCount = 0;
  let failOpenCount = 0;
  for (let i = 0; i < guardianIds.length; i++) {
    const gid = guardianIds[i]!;
    const count = counts[i];
    if (count === null) {
      // Redis down for this guardian — fail-open. The alternative
      // (suppress on error) means a Redis outage silently mutes ALL
      // family alerts, which is worse than the occasional double-fire.
      allowed.push(gid);
      failOpenCount++;
      continue;
    }
    if (count === 1 || isCritical) {
      allowed.push(gid);
      if (count > 1 && isCritical) criticalBypassCount++;
    } else {
      suppressedCount++;
    }
  }

  // Sixth-pass adversarial fix (LOW-3): emit aggregated metric per
  // call, not per guardian. The old per-guardian emit overcounted by
  // family size — a 5-member plan with one critical bypass fired the
  // metric 5×, breaking rate-based alerting. Now one tag per call
  // with a `count` payload so downstream can aggregate honestly.
  if (criticalBypassCount > 0) {
    emitMetric('v3.guardian_alert.critical_bypassed_cooldown', {
      kind,
      count: String(criticalBypassCount),
    });
  }
  if (suppressedCount > 0) {
    emitMetric('v3.guardian_alert.suppressed_by_cooldown', {
      kind,
      count: String(suppressedCount),
    });
  }
  if (failOpenCount > 0) {
    emitMetric('v3.guardian_alert.cooldown_fail_open', {
      kind,
      count: String(failOpenCount),
    });
  }

  return allowed;
}

// guardianAlerts — emits rows into guardian_alerts for each guardian
// tied to a subject user via family_plans + family_contacts.
//
// Who counts as a "guardian" for a given subject user?
//   1. Any family_contact flagged is_guardian=TRUE the subject has
//      registered. That contact is a phone number — but if the number
//      matches a user in the system, that user is the guardian.
//   2. Members on the same family_plan — the plan OWNER is an implicit
//      guardian for any member.
//
// We fan out to the union of those two sets (dedup by user_id) so the
// adult child / spouse hears the alert regardless of how they're
// wired.

export type GuardianAlertKind =
  | 'shield_critical'
  | 'shield_family_emergency'
  | 'safe_word_failed'
  | 'breach_new'
  | 'recovery_started'
  // Live Shield v3 — B3 post-dismiss escalation. Fires when the user
  // dismissed a B3 takeover and continued-critical persisted for 30+s.
  | 'shield_post_dismiss';

export type GuardianAlertSeverity = 'info' | 'warning' | 'critical';

export interface EmitArgs {
  subjectUserId: string;
  kind: GuardianAlertKind;
  severity?: GuardianAlertSeverity;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  // Guardian user_ids to omit from this fan-out. Used when a more specific
  // alert (e.g. a critical named-guardian ping) was already sent to the
  // same user — we don't want them getting both banners.
  excludeUserIds?: string[];
  // Restrict fan-out to these specific guardian user_ids. Used for the
  // "user picked ONE specific person to tell" path — without this, the
  // first-person "they picked *you*" copy ships to every guardian on
  // the plan, which is dishonest for everyone but the named one.
  // Still filtered through `guardianUserIdsFor`, so a non-guardian id
  // passed here is dropped.
  onlyUserIds?: string[];
}

/**
 * Find every guardian user_id for a subject. Returns at most N distinct
 * uuids. Includes:
 *   - family_plan owners when subject is a member (or the subject owns
 *     a plan and there are OTHER members on it)
 *   - family_contact phone numbers (is_guardian=TRUE) that resolve to
 *     an existing users row via email? no — family_contacts stores
 *     phone, not user_id. We can't auto-resolve to a user without more
 *     plumbing, so this function currently only pulls plan-based
 *     guardians. The contact-based route is wired elsewhere (explicit
 *     "notify my guardian" button with the saved phone).
 */
/**
 * Family-plan-member set for a subject. Used by the v3 family-
 * transcript SSE stream to authorize who can watch Mom's call live.
 *
 * Differs from `guardianUserIdsFor`: that function returns the
 * smaller "named guardian" set (plan owner + members of plans the
 * subject OWNS), missing sibling members of a plan the subject is
 * ON. The SSE route needs the broader "everyone on the same family
 * plan" set — if Dad owns the plan and Mom + Son are members, Son
 * should be allowed to watch Mom's stream.
 *
 * This is a NEW function rather than a fix to guardianUserIdsFor
 * because changing the alert fanout's audience is a separate
 * behavior change with its own test impact. Track that as a follow-
 * up; for now, just close the SSE auth gap.
 */
export async function familyPlanMembersFor(subjectUserId: string): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `WITH plan AS (
       SELECT fm.family_plan_id
         FROM family_members fm WHERE fm.user_id = $1
     )
     -- Plan owner when subject is a member
     SELECT fp.owner_user_id AS user_id
       FROM family_plans fp
       JOIN plan ON plan.family_plan_id = fp.id
      WHERE fp.owner_user_id <> $1
     UNION
     -- Other members of plans subject is ON
     SELECT fm2.user_id AS user_id
       FROM family_members fm2
       JOIN plan ON plan.family_plan_id = fm2.family_plan_id
      WHERE fm2.user_id <> $1
     UNION
     -- Other members of plans subject OWNS
     SELECT fm3.user_id AS user_id
       FROM family_plans fp3
       JOIN family_members fm3 ON fm3.family_plan_id = fp3.id
      WHERE fp3.owner_user_id = $1
        AND fm3.user_id <> $1`,
    [subjectUserId],
  );
  const ids = new Set<string>();
  for (const r of rows.rows) ids.add(r.user_id);
  return [...ids];
}

export async function guardianUserIdsFor(subjectUserId: string): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `WITH plan AS (
       SELECT fm.family_plan_id
         FROM family_members fm WHERE fm.user_id = $1
     )
     -- Plan owners (when subject is a member)
     SELECT fp.owner_user_id AS user_id
       FROM family_plans fp
       JOIN plan ON plan.family_plan_id = fp.id
      WHERE fp.owner_user_id <> $1
     UNION
     -- Other members on a plan I own
     SELECT fm2.user_id AS user_id
       FROM family_plans fp2
       JOIN family_members fm2 ON fm2.family_plan_id = fp2.id
      WHERE fp2.owner_user_id = $1
        AND fm2.user_id <> $1`,
    [subjectUserId],
  );
  const ids = new Set<string>();
  for (const r of rows.rows) ids.add(r.user_id);
  return [...ids];
}

export interface EmitGuardianAlertResult {
  delivered: number;
  recipients: number;
  /**
   * Sixth-pass adversarial fix (MEDIUM-4): the original M-15 contract
   * had only `delivered` and `recipients`, which lets callers tell
   * "no family registered" from "INSERT failed". After R8 added per-
   * recipient cooldown, a third case appeared — "every guardian was
   * suppressed by cooldown" — which collapsed to the same recipients=0
   * shape as "no family registered." Callers that surface this to the
   * user (e.g. recovery.ts:1571 "alert my family" button) need to
   * distinguish them — "we already told everyone a minute ago" reads
   * very differently from "you have no family on this plan."
   */
  cooldownSuppressed: number;
}

export async function emitGuardianAlert(
  args: EmitArgs,
): Promise<EmitGuardianAlertResult> {
  // M-15 fix: callers (firePostDismissFamilyAlert in particular) need
  // to distinguish "delivered=0 because no family is registered" from
  // "delivered=0 because the INSERT failed". The former is OK (user
  // is solo on the plan); the latter is a real outage that should
  // page someone. `recipients` is the count of guardian IDs the
  // INSERT actually ran for (post-cooldown) — read it alongside
  // `delivered` and `cooldownSuppressed` to tell all three cases apart.
  const allGuardianIds = await guardianUserIdsFor(args.subjectUserId);
  const excluded = new Set(args.excludeUserIds ?? []);
  const only = args.onlyUserIds ? new Set(args.onlyUserIds) : null;
  const guardianIds = allGuardianIds.filter((id) => {
    if (excluded.has(id)) return false;
    if (only && !only.has(id)) return false;
    return true;
  });
  if (guardianIds.length === 0) {
    return { delivered: 0, recipients: 0, cooldownSuppressed: 0 };
  }

  // R8 per-recipient 60s cooldown — filter out guardians who were
  // alerted about this subject in the last minute (unless this is a
  // critical-severity event, which bypasses anti-spam). The post-
  // dismiss escalation by design fires critical at t=30s after the
  // initial shield_critical; both must land. recipients count
  // reflects the POST-cooldown filtered list so callers get the
  // honest "how many people did we actually try to reach" number.
  const severity = args.severity ?? 'warning';
  const cooldownFiltered = await filterByCooldown(
    guardianIds,
    args.subjectUserId,
    severity,
    args.kind,
  );
  const cooldownSuppressed = guardianIds.length - cooldownFiltered.length;
  if (cooldownFiltered.length === 0) {
    // All guardians suppressed by cooldown. recipients=0 here means
    // the same as guardianIds.length === 0 (delivered=0, recipients=0),
    // but cooldownSuppressed > 0 disambiguates: callers that hit this
    // branch had family but suppressed them. Critical severity
    // CAN'T reach this branch by construction (bypass).
    return { delivered: 0, recipients: 0, cooldownSuppressed };
  }

  const planRes = await query<{ family_plan_id: string | null }>(
    `SELECT family_plan_id
       FROM family_members
      WHERE user_id = $1
      LIMIT 1`,
    [args.subjectUserId],
  );
  const planId = planRes.rows[0]?.family_plan_id ?? null;

  // Multi-row INSERT — one round-trip for all guardians. Shield-critical
  // alerts fan out to 5-10+ members of a large plan; the old loop was
  // 5-10x wall-clock. NOTE: iterate `cooldownFiltered`, not the original
  // `guardianIds` — otherwise we'd INSERT for users the R8 cooldown
  // just suppressed.
  let delivered = 0;
  const values: string[] = [];
  const params: unknown[] = [];
  let p = 0;
  // `severity` already declared above for the cooldown filter.
  const payloadJson = JSON.stringify(args.payload ?? {});
  for (const gid of cooldownFiltered) {
    values.push(
      `($${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p})`,
    );
    params.push(
      gid, args.subjectUserId, planId, args.kind,
      severity, args.title, args.body, payloadJson,
    );
  }
  try {
    const res = await query(
      `INSERT INTO guardian_alerts
         (guardian_user_id, subject_user_id, family_plan_id, kind,
          severity, title, body, payload)
       VALUES ${values.join(', ')}`,
      params,
    );
    delivered = res.rowCount ?? cooldownFiltered.length;
  } catch (err) {
    const { captureError } = await import('../lib/observability.js');
    captureError(err, {
      component: 'guardianAlerts',
      guardian_count: cooldownFiltered.length,
      pre_cooldown_count: guardianIds.length,
    });
  }

  // Email fan-out for critical severity. Push is best-effort (may be
  // off, device offline, token invalid); email is the guaranteed
  // channel. Same R8 cooldown-respecting filter: only email the
  // recipients we DIDN'T suppress at the push layer — otherwise
  // anti-spam at one channel is silently undone at the other.
  // Critical bypasses cooldown by design, so in practice this filter
  // is the identity for the only severity we email on.
  if (severity === 'critical' && cooldownFiltered.length > 0) {
    try {
      const { sendEmail } = await import('../lib/email.js');
      const emails = await query<{ user_id: string; email: string; display_name: string | null }>(
        `SELECT u.id AS user_id, u.email, u.display_name
           FROM users u WHERE u.id = ANY($1::uuid[]) AND u.email IS NOT NULL`,
        [cooldownFiltered],
      );
      const subject = await query<{ display_name: string | null }>(
        `SELECT display_name FROM users WHERE id = $1`,
        [args.subjectUserId],
      );
      const subjectName = subject.rows[0]?.display_name ?? 'your family member';
      for (const g of emails.rows) {
        void sendEmail({
          userId: g.user_id,
          to: g.email,
          template: 'guardian_critical_alert',
          data: {
            subject_name: subjectName,
            body: args.body,
          },
        });
      }
    } catch (err) {
      const { captureError } = await import('../lib/observability.js');
      captureError(err, { component: 'guardianAlerts.email_fanout' });
    }
  }
  return { delivered, recipients: cooldownFiltered.length, cooldownSuppressed };
}
