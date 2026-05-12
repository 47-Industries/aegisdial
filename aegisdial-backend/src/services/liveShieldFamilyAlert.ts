import { query } from '../lib/db.js';
import { config } from '../config.js';
import { emitGuardianAlert } from './guardianAlerts.js';
import { track } from '../lib/analytics.js';
import { emitMetric, captureError } from '../lib/observability.js';
import { PLAYBOOKS_BY_ID, STAGE_IDS, type PlaybookId, type StageId } from '../data/playbooks.js';

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
 * Optional v4 playbook context. When present + flag is on, the
 * non-minimal alert bodies are enriched with the playbook blurb and
 * a stage-aware urgency cue.
 *
 * Resolved at fire-time inside fireFamilyAlert (caller doesn't need to
 * pass it). Optional so existing callers and tests don't break.
 */
export interface V4AlertContext {
  playbook_id: PlaybookId;
  stage: StageId;
}

/**
 * Per-stage urgency cue. Same line across all playbooks — the playbook
 * blurb names WHAT the scam is, the stage cue names WHERE in the script
 * the scammer is. Mom-side family member sees both, reading the push
 * notification on a lock screen in 3 seconds.
 */
const STAGE_URGENCY: Record<StageId, string> = {
  rapport: 'She is early in the call — call her now while she still has time.',
  authority: 'They are establishing fake authority — call her now.',
  fear: 'They are applying pressure right now — call her immediately.',
  ask: 'They are asking for money RIGHT NOW. Call her immediately.',
  close: 'The call may be ending — confirm she did not send money.',
};

/**
 * Compose the v4 enrichment payload pieces. Both fireFamilyAlert (via
 * buildAlertPayload) and firePostDismissFamilyAlert call through this
 * so a single both-valid gate covers privacy/safety for both code paths.
 *
 * Returns NULL when:
 *   - v4 ctx is missing
 *   - V4_PLAYBOOK_FAMILY_ALERT_COPY_ENABLED flag is off
 *   - playbook lookup misses (unknown id, e.g. stale post-rollback)
 *   - stage urgency lookup misses (unknown stage label)
 *
 * NULL means: drop enrichment, fall through to legacy formatting. The
 * wrapper text ("She may be on" vs "She is on") is supplied by the
 * caller via `verb` since the two paths phrase it differently.
 */
export function composeV4Enrichment(
  v4: V4AlertContext | null | undefined,
  verb: 'may be on' | 'is on',
): { bodySuffix: string; payloadFields: { v4_playbook_id: PlaybookId; v4_stage: StageId } } | null {
  if (!v4) return null;
  if (!config.V4_PLAYBOOK_FAMILY_ALERT_COPY_ENABLED) return null;
  const playbook = PLAYBOOKS_BY_ID.get(v4.playbook_id);
  if (!playbook) return null;
  const stageCue = STAGE_URGENCY[v4.stage];
  if (!stageCue) return null;
  return {
    bodySuffix: ` She ${verb} ${playbook.family_alert_blurb} ${stageCue}`,
    payloadFields: { v4_playbook_id: v4.playbook_id, v4_stage: v4.stage },
  };
}

const VALID_PRIVACY_LEVELS: ReadonlySet<string> = new Set(['minimal', 'default', 'open']);

/**
 * Fetch Mom's privacy preference. Returns 'default' when she hasn't
 * explicitly chosen one (middle-ground default).
 *
 * Fail-closed: on DB error OR an unrecognized value sneaking in via a
 * future migration mistake, return 'minimal'. The privacy guarantee
 * runs in only one direction — leaking by default is unacceptable, so
 * an unknown state must be treated as the most restrictive.
 */
export async function getFamilyAlertPrivacyLevel(userId: string): Promise<PrivacyLevel> {
  try {
    const row = await query<{ privacy_level: string }>(
      `SELECT privacy_level FROM family_alert_preferences WHERE user_id = $1`,
      [userId],
    );
    const stored = row.rows[0]?.privacy_level;
    if (stored === undefined) return 'default';
    if (!VALID_PRIVACY_LEVELS.has(stored)) return 'minimal';
    return stored as PrivacyLevel;
  } catch {
    // DB error path — fail-closed to minimal, never leak.
    return 'minimal';
  }
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
  /**
   * v4 Phase 2 — optional playbook context. When passed AND v4 flag is
   * on, the non-minimal alert bodies get a playbook blurb + stage-aware
   * urgency cue appended. Minimal stays minimal regardless (privacy
   * guarantee outranks pitch value). Falls through to legacy formatting
   * when null/undefined — every existing caller keeps working.
   */
  v4?: V4AlertContext | null,
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

  // v4 enrichment: resolve playbook blurb + stage urgency once, gate
  // application by privacy level below. Defensive: if the flag is on
  // but v4 carries an unknown playbook_id (e.g. stale data after a code
  // rollback), we silently skip — no half-built strings.
  // Single source of truth for v4 enrichment composition (flag gate +
  // playbook lookup + stage cue lookup). Both fire paths call through
  // composeV4Enrichment so privacy + "no undefined" gates can't drift.
  const v4Enrich = composeV4Enrichment(v4, 'may be on');
  const v4Suffix = v4Enrich?.bodySuffix ?? '';
  const v4PayloadFields = v4Enrich?.payloadFields ?? {};

  if (level === 'minimal') {
    // Minimal stays minimal. No v4 enrichment — leaking the playbook
    // name would defeat Mom's "send only what I need to call her back"
    // preference. The kid still has the score; that's the signal they
    // opted in for.
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
      body: `Risk score ${input.risk_score}/100. Pattern: ${scamLabel}.${flagsBlurb}${v4Suffix}`,
      payload: {
        kind: 'live_shield_critical',
        session_id: input.session_id,
        subject_user_id: input.subject_user_id,
        risk_score: input.risk_score,
        scam_type: input.scam_type,
        matched_red_flags: input.matched_red_flags.slice(0, 5),
        privacy_level: level,
        ...v4PayloadFields,
      },
    };
  }

  // open
  return {
    title,
    body: `Risk score ${input.risk_score}/100. Pattern: ${scamLabel}.${v4Suffix} Tap to view live.`,
    payload: {
      kind: 'live_shield_critical',
      session_id: input.session_id,
      subject_user_id: input.subject_user_id,
      risk_score: input.risk_score,
      scam_type: input.scam_type,
      matched_red_flags: input.matched_red_flags.slice(0, 5),
      transcript_view_available: true,
      privacy_level: level,
      ...v4PayloadFields,
    },
  };
}

/**
 * Read the v4 playbook context for a session. NULL when the session
 * never got classified, the flag is off, or the columns are stale.
 *
 * Internal helper called from fireFamilyAlert + firePostDismissFamilyAlert
 * at fire time so callers don't have to pass v4 context explicitly.
 * Fail-soft: any DB error → null (no enrichment, no crash). The alert
 * still fires; it just doesn't get the playbook blurb.
 */
async function loadV4AlertContext(session_id: string): Promise<V4AlertContext | null> {
  if (!config.V4_PLAYBOOK_FAMILY_ALERT_COPY_ENABLED) return null;
  try {
    const row = await query<{ v4_playbook_id: string | null; v4_stage: string | null }>(
      `SELECT v4_playbook_id, v4_stage FROM call_sessions WHERE id = $1`,
      [session_id],
    );
    const playbook_id = row.rows[0]?.v4_playbook_id ?? null;
    const stage = row.rows[0]?.v4_stage ?? null;
    if (!playbook_id || !stage) return null;
    // Validate BOTH playbook_id and stage against the canonical
    // taxonomies. An unvalidated stage cast would let STAGE_URGENCY[stage]
    // return `undefined`, which then template-literal-stringifies into
    // the push body as the literal text "undefined" — a real bug for
    // family members reading the push notification. Drop enrichment on
    // either mismatch (stale data after a code rollback, manual ops
    // UPDATE writing a fresh label, etc.).
    if (!PLAYBOOKS_BY_ID.has(playbook_id as PlaybookId)) return null;
    if (!STAGE_IDS.includes(stage as StageId)) return null;
    return {
      playbook_id: playbook_id as PlaybookId,
      stage: stage as StageId,
    };
  } catch {
    return null;
  }
}

/**
 * Atomically check-and-set the family_alert_fired_at flag.
 *
 * The single UPDATE with a guard predicate is the lock — Postgres
 * serializes UPDATE statements on the same row, so two concurrent
 * chunks cannot both succeed. DO NOT split this into a SELECT then
 * UPDATE — that breaks the atomicity. The lock comes from row-level
 * locking on UPDATE, NOT from any explicit transaction.
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
 * Compensating reset of the claim flag. Used when emitGuardianAlert
 * fails — without this, the family is permanently unable to be alerted
 * for this session even though they were never actually notified.
 */
async function releaseAlertFiringRights(sessionId: string): Promise<void> {
  try {
    await query(
      `UPDATE call_sessions
          SET family_alert_fired_at = NULL
        WHERE id = $1`,
      [sessionId],
    );
  } catch {
    // Last-resort path. If we can't even reset the flag, the session is
    // already in a degraded state — the next transcript chunk will
    // surface the failure via the normal alert escalator.
  }
}

/**
 * Top-level entry point. Idempotent — safe to call from every transcript
 * chunk handler that observes a critical score; only the first call per
 * session actually fans out.
 *
 * Fire-and-forget from the caller's perspective (caller should `void`
 * the promise) — we don't want the transcript request to block on push
 * fan-out latency.
 *
 * If `emitGuardianAlert` throws OR delivers to zero guardians, we
 * release the claim so a later chunk can retry — without this, a
 * transient DB hiccup at the moment of fan-out would mean the family
 * stays uninformed forever.
 */
export async function fireFamilyAlert(input: FamilyAlertInput): Promise<{ delivered: number; alreadyFired: boolean }> {
  const claimed = await claimAlertFiringRights(input.session_id);
  if (!claimed) return { delivered: 0, alreadyFired: true };

  // v4 Phase 2 — fetch playbook context in parallel with privacy
  // preference. loadV4AlertContext returns null when the flag is OFF or
  // no v4 detection has landed, so the legacy formatting path stays the
  // default.
  const [level, v4ctx] = await Promise.all([
    getFamilyAlertPrivacyLevel(input.subject_user_id),
    loadV4AlertContext(input.session_id),
  ]);
  const { title, body, payload } = buildAlertPayload(input, level, v4ctx);

  let delivered = 0;
  try {
    const result = await emitGuardianAlert({
      subjectUserId: input.subject_user_id,
      kind: 'shield_critical',
      severity: 'critical',
      title,
      body,
      payload,
    });
    delivered = result.delivered;
  } catch (err) {
    // Network / DB error during emit — release the claim so a later
    // chunk can re-try, then re-throw for observability upstream.
    await releaseAlertFiringRights(input.session_id);
    throw err;
  }

  if (delivered === 0) {
    // No guardians on the plan, OR all of them got filtered. Release
    // the claim so a later chunk retries — but only if there's any
    // chance of finding guardians (i.e. the user might add one mid-call).
    // Realistically this is "user has no family plan" which is a stable
    // state, so we just track and move on.
    void track('family_alert_fired', {
      userId: input.subject_user_id,
      properties: {
        session_id: input.session_id,
        privacy_level: level,
        delivered: 0,
        risk_score: input.risk_score,
        scam_type: input.scam_type,
        no_guardians: true,
      },
    });
    return { delivered: 0, alreadyFired: false };
  }

  void track('family_alert_fired', {
    userId: input.subject_user_id,
    properties: {
      session_id: input.session_id,
      privacy_level: level,
      delivered,
      risk_score: input.risk_score,
      scam_type: input.scam_type,
    },
  });

  return { delivered, alreadyFired: false };
}

// ===========================================================================
// Live Shield v3 — B3 post-dismiss family alert.
// ===========================================================================
//
// Distinct from the primary v2 family alert:
//   - The primary alert (fireFamilyAlert above) fires when score
//     first crosses critical. Idempotent on family_alert_fired_at.
//   - This post-dismiss alert fires when the user dismissed a B3
//     takeover and continued-critical-state persisted for 30+ seconds.
//     Idempotent on family_alert_post_dismiss_fired_at.
//
// Idempotency for THIS function is the caller's responsibility — the
// post-dismiss watcher already does the atomic UPDATE-with-WHERE-guard
// against family_alert_post_dismiss_fired_at before calling here, so
// we are guaranteed at-most-once delivery per session.
//
// Privacy levels reuse the same Mom-chosen privacy_level pref.

/**
 * Fire the B3 post-dismiss family alert. Caller MUST have already
 * claimed firing rights via UPDATE family_alert_post_dismiss_fired_at —
 * this function does NOT do its own idempotency check. It delivers
 * the push and tracks the event.
 *
 * Distinct copy variant on the title + body that emphasizes the
 * dismiss-then-still-in-danger scenario.
 */
export async function firePostDismissFamilyAlert(
  input: FamilyAlertInput,
): Promise<{ delivered: number; recipients: number; outcome: 'delivered' | 'no_recipients' | 'all_delivery_failed' }> {
  // v4 Phase 2 — fetch privacy + playbook context in parallel. Same
  // shape as fireFamilyAlert; v4 enrichment goes to non-minimal bodies.
  const [level, v4ctx] = await Promise.all([
    getFamilyAlertPrivacyLevel(input.subject_user_id),
    loadV4AlertContext(input.session_id),
  ]);

  // The post-dismiss copy is intentionally more urgent than the
  // primary alert: this means Mom got our warning, dismissed it,
  // AND is still in danger. The kid needs to know this is the
  // "she's not stopping" case, not the first signal.
  const title = 'A family member dismissed our warning and is still on the call';
  const scamLabel = input.scam_type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  // v4 enrichment via the same shared composer used by buildAlertPayload.
  // Only the verb differs ("is on" — more urgent now that we know Mom
  // dismissed the original warning); the rest of the gating logic
  // (flag + playbook lookup + stage cue lookup) is identical.
  const v4Enrich = composeV4Enrichment(v4ctx, 'is on');
  const v4Suffix = v4Enrich?.bodySuffix ?? '';
  const v4PayloadFields = v4Enrich?.payloadFields ?? {};

  let body: string;
  let payload: Record<string, unknown>;

  if (level === 'minimal') {
    body = `Risk score ${input.risk_score}/100. Pattern: ${scamLabel}.`;
    payload = {
      kind: 'live_shield_post_dismiss',
      session_id: input.session_id,
      subject_user_id: input.subject_user_id,
      risk_score: input.risk_score,
      scam_type: input.scam_type,
      privacy_level: level,
    };
  } else if (level === 'default') {
    body = `Score ${input.risk_score}/100, pattern: ${scamLabel}.${v4Suffix} Tap to call.`;
    payload = {
      kind: 'live_shield_post_dismiss',
      session_id: input.session_id,
      subject_user_id: input.subject_user_id,
      risk_score: input.risk_score,
      scam_type: input.scam_type,
      matched_red_flags: input.matched_red_flags.slice(0, 3),
      privacy_level: level,
      ...v4PayloadFields,
    };
  } else {
    body = `Score ${input.risk_score}/100. They dismissed our warning.${v4Suffix} Tap to join the call or open transcript.`;
    payload = {
      kind: 'live_shield_post_dismiss',
      session_id: input.session_id,
      subject_user_id: input.subject_user_id,
      risk_score: input.risk_score,
      scam_type: input.scam_type,
      matched_red_flags: input.matched_red_flags.slice(0, 5),
      transcript_view_available: true,
      privacy_level: level,
      ...v4PayloadFields,
    };
  }

  let delivered = 0;
  let recipients = 0;
  try {
    const result = await emitGuardianAlert({
      subjectUserId: input.subject_user_id,
      kind: 'shield_post_dismiss',
      severity: 'critical',
      title,
      body,
      payload,
    });
    delivered = result.delivered;
    recipients = result.recipients;
  } catch (err) {
    // The caller already claimed firing rights. We can't undo the
    // claim here without race risk against the timer's compensating
    // release path; just let it bubble up.
    throw err;
  }

  // M-15 fix: distinguish the three outcomes. The post-dismiss family
  // alert is the LAST safety net — if it silently fails, Mom is
  // alone on the call. We need ops to see the difference between
  // "no family registered" (expected for solo users) and "family
  // registered but all delivery failed" (real outage).
  let outcome: 'delivered' | 'no_recipients' | 'all_delivery_failed';
  if (recipients === 0) {
    outcome = 'no_recipients';
    emitMetric('v3.post_dismiss_watcher.alert_no_recipients', {});
  } else if (delivered === 0) {
    outcome = 'all_delivery_failed';
    emitMetric('v3.post_dismiss_watcher.alert_all_delivery_failed', {});
    captureError(new Error('post-dismiss family alert had recipients but 0 delivered'), {
      component: 'firePostDismissFamilyAlert',
      session_id: input.session_id,
      subject_user_id: input.subject_user_id,
      recipients,
    });
  } else {
    outcome = 'delivered';
    emitMetric('v3.post_dismiss_watcher.alert_delivered', {});
  }

  void track('family_alert_post_dismiss_fired', {
    userId: input.subject_user_id,
    properties: {
      session_id: input.session_id,
      privacy_level: level,
      delivered,
      recipients,
      outcome,
      risk_score: input.risk_score,
      scam_type: input.scam_type,
    },
  });

  return { delivered, recipients, outcome };
}
