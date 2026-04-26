import { query } from '../lib/db.js';

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
  | 'recovery_started';

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

export async function emitGuardianAlert(args: EmitArgs): Promise<{ delivered: number }> {
  const allGuardianIds = await guardianUserIdsFor(args.subjectUserId);
  const excluded = new Set(args.excludeUserIds ?? []);
  const only = args.onlyUserIds ? new Set(args.onlyUserIds) : null;
  const guardianIds = allGuardianIds.filter((id) => {
    if (excluded.has(id)) return false;
    if (only && !only.has(id)) return false;
    return true;
  });
  if (guardianIds.length === 0) return { delivered: 0 };

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
  // 5-10x wall-clock.
  let delivered = 0;
  const values: string[] = [];
  const params: unknown[] = [];
  let p = 0;
  const severity = args.severity ?? 'warning';
  const payloadJson = JSON.stringify(args.payload ?? {});
  for (const gid of guardianIds) {
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
    delivered = res.rowCount ?? guardianIds.length;
  } catch (err) {
    const { captureError } = await import('../lib/observability.js');
    captureError(err, {
      component: 'guardianAlerts',
      guardian_count: guardianIds.length,
    });
  }

  // Email fan-out for critical severity. Push is best-effort (may be
  // off, device offline, token invalid); email is the guaranteed channel.
  if ((args.severity ?? 'warning') === 'critical' && guardianIds.length > 0) {
    try {
      const { sendEmail } = await import('../lib/email.js');
      const emails = await query<{ user_id: string; email: string; display_name: string | null }>(
        `SELECT u.id AS user_id, u.email, u.display_name
           FROM users u WHERE u.id = ANY($1::uuid[]) AND u.email IS NOT NULL`,
        [guardianIds],
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
  return { delivered };
}
