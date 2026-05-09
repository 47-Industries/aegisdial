import { query } from '../lib/db.js';
import { emitGuardianAlert } from './guardianAlerts.js';
import { track } from '../lib/analytics.js';

// Live Shield v2 — family alert fan-out at score ≥ 75.
//
// When a shielded call crosses the critical threshold for the FIRST
// time, this service fires a push notification to every family-plan
// member. The payload respects Mom's privacy preference (set via the
// family_alert_preferences table — minimal / default / open).
//
// Idempotency: the call_sessions row carries a `family_alert_fired_at`
// timestamp. We refuse to fire twice for the same session so a call
// that bounces above and below 75 doesn't push-spam the family.

export type PrivacyLevel = 'minimal' | 'default' | 'open';

export interface FamilyAlertInput {
  session_id: string;
  subject_user_id: string;
  risk_score: number;
  scam_type: string;
  /** Plain-language labels of the regex hits that triggered this call. */
  matched_red_flags: string[];
}

/**
 * Fetch Mom's privacy preference. Returns 'default' when she hasn't
 * explicitly chosen one — middle-ground default lets families opt in
 * to either extreme.
 */
export async function getFamilyAlertPrivacyLevel(userId: string): Promise<PrivacyLevel> {
  const row = await query<{ privacy_level: PrivacyLevel }>(
    `SELECT privacy_level FROM family_alert_preferences WHERE user_id = $1`,
    [userId],
  );
  return row.rows[0]?.privacy_level ?? 'default';
}

/**
 * Build the push payload that family members will receive. Each level
 * is monotonically more revealing than the last:
 *   minimal — score + scam type only
 *   default — adds the matched red flags
 *   open    — adds a session_id pointer the iOS app can use to fetch
 *             the live transcript view
 *
 * We never put the raw transcript text directly in the payload — that's
 * a push-notification size issue (and an attack surface if a phone is
 * lost/stolen and the lock-screen preview is on). Open-level family
 * members fetch the transcript via the API with their own auth.
 */
export function buildAlertPayload(
  input: FamilyAlertInput,
  level: PrivacyLevel,
): { title: string; body: string; payload: Record<string, unknown> } {
  const scamLabel = input.scam_type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  // The title is identical across levels — short, urgent, name-free
  // (the iOS push handler injects the user's display name client-side
  // from the family roster, so the lock-screen preview reads "Mom is
  // on a high-risk call right now" without us shipping her name in the
  // payload).
  const title = 'A family member is on a high-risk call';

  if (level === 'minimal') {
    return {
      title,
      body: `Risk score ${input.risk_score}/100. Pattern: ${scamLabel}.`,
      payload: {
        kind: 'live_shield_critical',
        session_id: input.session_id,
        subject_user_id: input.subject_user_id,
        risk_score: input.risk_score,
        scam_type: input.scam_type,
        privacy_level: level,
      },
    };
  }

  if (level === 'default') {
    const flagsBlurb = input.matched_red_flags.length > 0
      ? ` Caller said: ${input.matched_red_flags.slice(0, 3).join(', ')}.`
      : '';
    return {
      title,
      body: `Risk score ${input.risk_score}/100. Pattern: ${scamLabel}.${flagsBlurb}`,
      payload: {
        kind: 'live_shield_critical',
        session_id: input.session_id,
        subject_user_id: input.subject_user_id,
        risk_score: input.risk_score,
        scam_type: input.scam_type,
        matched_red_flags: input.matched_red_flags.slice(0, 5),
        privacy_level: level,
      },
    };
  }

  // open
  return {
    title,
    body: `Risk score ${input.risk_score}/100. Pattern: ${scamLabel}. Tap to view live.`,
    payload: {
      kind: 'live_shield_critical',
      session_id: input.session_id,
      subject_user_id: input.subject_user_id,
      risk_score: input.risk_score,
      scam_type: input.scam_type,
      matched_red_flags: input.matched_red_flags.slice(0, 5),
      transcript_view_available: true,
      privacy_level: level,
    },
  };
}

/**
 * Atomically check-and-set the family_alert_fired_at flag. Returns true
 * if THIS caller is the one that won the race and should proceed with
 * fan-out; returns false if someone else (a concurrent transcript chunk)
 * already fired.
 *
 * The single UPDATE with a guard predicate is the lock — we can't
 * accidentally double-fire even under heavy concurrency on the same
 * session.
 */
async function claimAlertFiringRights(sessionId: string): Promise<boolean> {
  const result = await query(
    `UPDATE call_sessions
        SET family_alert_fired_at = NOW()
      WHERE id = $1 AND family_alert_fired_at IS NULL`,
    [sessionId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Top-level entry point. Idempotent — safe to call from every transcript
 * chunk handler that observes a critical score; only the first call per
 * session actually fans out.
 *
 * Fire-and-forget from the caller's perspective (caller should `void`
 * the promise) — we don't want the transcript request to block on push
 * fan-out latency.
 */
export async function fireFamilyAlert(input: FamilyAlertInput): Promise<{ delivered: number; alreadyFired: boolean }> {
  const claimed = await claimAlertFiringRights(input.session_id);
  if (!claimed) return { delivered: 0, alreadyFired: true };

  const level = await getFamilyAlertPrivacyLevel(input.subject_user_id);
  const { title, body, payload } = buildAlertPayload(input, level);

  const result = await emitGuardianAlert({
    subjectUserId: input.subject_user_id,
    kind: 'shield_critical',
    severity: 'critical',
    title,
    body,
    payload,
  });

  void track('family_alert_fired', {
    userId: input.subject_user_id,
    properties: {
      session_id: input.session_id,
      privacy_level: level,
      delivered: result.delivered,
      risk_score: input.risk_score,
      scam_type: input.scam_type,
    },
  });

  return { delivered: result.delivered, alreadyFired: false };
}
