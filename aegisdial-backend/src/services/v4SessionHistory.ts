import { query } from '../lib/db.js';
import { redactSensitiveDigits } from './sentinelMatcher.js';
import { bucketConfidence, type ConfidenceBucket } from '../lib/confidenceBuckets.js';

// Live Shield v4 — Phase 15 — per-session classification history.
//
// Closes the triage loop the calibration scorecard (Phase 14) opens.
// Operator workflow: scorecard surfaces a flagged (playbook, stage)
// pair → operator drills into a representative session to see the
// actual timeline of classifier commits — every transition, every
// confidence, every truncated rationale.
//
// Data source: b4_playbook_stage_events (migration 051). One row per
// committed transition, including the initial commit (from_* fields
// are null on initial). Plus current v4_* state from call_sessions
// so the operator sees where the call ended up.

export interface SessionClassificationEvent {
  occurred_at: string; // ISO
  from_playbook_id: string | null;
  from_stage: string | null;
  to_playbook_id: string;
  to_stage: string;
  /** 0..100 (call_sessions scale — same as v4_stage_confidence). */
  confidence: number;
  /**
   * Same value mapped to the Phase 13 dashboard's confidence-bucket
   * vocabulary, so an operator who jumps between this endpoint and
   * /admin/v4/stage-confidence doesn't have to do unit math
   * (M-1 adversarial fix — Phase 13 buckets operate on 0..1, this
   * endpoint emits 0..100; without this field the operator would
   * have to divide by 100 then re-bucket by hand).
   */
  confidence_bucket: ConfidenceBucket;
  trigger_event_id: string | null;
  /**
   * Classifier rationale with sensitive digit sequences redacted.
   * HIGH-1 adversarial-review fix: the raw `reasoning` text can
   * paraphrase or quote the scammer's audio chunk, which routinely
   * includes the victim's spoken card/account-tail digits, case
   * numbers, and phone numbers. The classifier prompt asks for
   * "the deciding evidence" — that evidence is the literal scammer
   * speech, by design. Surfacing it through an admin endpoint
   * without redaction is a PII leak. We pass it through the same
   * `redactSensitiveDigits` helper the push-dispatcher uses for the
   * exact same reason. Empty strings are normalized to null
   * (LOW-2 cosmetic fix).
   */
  reasoning: string | null;
}

export interface SessionClassificationHistory {
  session_id: string;
  /** Session-end snapshot from call_sessions. Null when the session
   *  doesn't exist OR has no v4 classification at all. */
  current: {
    v4_playbook_id: string | null;
    v4_stage: string | null;
    v4_stage_confidence: number | null;
    v4_classified_at: string | null;
    v4_transition_count: number;
  } | null;
  /** Chronological — earliest first. */
  events: SessionClassificationEvent[];
  /** True when the call_sessions row exists for `session_id`. False
   *  → the session_id is unknown to the system; events will be empty. */
  session_exists: boolean;
}

interface CallSessionRow {
  id: string;
  v4_playbook_id: string | null;
  v4_stage: string | null;
  v4_stage_confidence: number | null;
  v4_classified_at: Date | null;
  v4_transition_count: number | null;
}

interface StageEventRow {
  occurred_at: Date;
  from_playbook_id: string | null;
  from_stage: string | null;
  to_playbook_id: string;
  to_stage: string;
  confidence: number;
  trigger_event_id: string | null;
  reasoning: string | null;
}

/**
 * Fetch the v4 classification history for a single session. Returns
 * { session_exists: false, current: null, events: [] } when the
 * session id is unknown — operator gets a clean 404-shaped body
 * instead of an opaque empty result.
 *
 * Two queries (sequential): the call_sessions snapshot + the
 * b4_playbook_stage_events timeline. Sequential rather than parallel
 * because the snapshot query is the single source of truth for
 * "does this session exist?" — empty events on a parallel fetch
 * could mean either "session unknown" or "session exists but never
 * classified" and the route needs to map those to 404 vs 200
 * respectively. (LOW-1 docstring fix from adversarial review —
 * earlier comment had the rationale upside-down.)
 */
export async function getSessionClassificationHistory(
  session_id: string,
): Promise<SessionClassificationHistory> {
  const sessRes = await query<CallSessionRow>(
    `SELECT id,
            v4_playbook_id,
            v4_stage,
            v4_stage_confidence,
            v4_classified_at,
            v4_transition_count
       FROM call_sessions
      WHERE id = $1`,
    [session_id],
  );
  if (sessRes.rowCount === 0) {
    return { session_id, current: null, events: [], session_exists: false };
  }
  const sess = sessRes.rows[0]!;

  const evRes = await query<StageEventRow>(
    `SELECT occurred_at,
            from_playbook_id,
            from_stage,
            to_playbook_id,
            to_stage,
            confidence,
            trigger_event_id,
            reasoning
       FROM b4_playbook_stage_events
      WHERE session_id = $1
      ORDER BY occurred_at ASC, id ASC`,
    [session_id],
  );

  return {
    session_id,
    session_exists: true,
    current: {
      v4_playbook_id: sess.v4_playbook_id,
      v4_stage: sess.v4_stage,
      v4_stage_confidence: sess.v4_stage_confidence,
      v4_classified_at: sess.v4_classified_at?.toISOString() ?? null,
      v4_transition_count: sess.v4_transition_count ?? 0,
    },
    events: evRes.rows.map((r) => {
      // M-2 defense in depth: schema is plain TEXT with no length
      // CHECK; classifier truncates at 500 today but a future writer
      // (backfill, manual SQL, alt-classifier) could write multi-KB.
      // Slice in the response mapper too so the JSON response stays
      // bounded regardless of how the row landed.
      const raw = r.reasoning ? r.reasoning.slice(0, 500) : null;
      // H-1: redact card/account/phone/MFA digit sequences before
      // surfacing to the admin endpoint. The classifier prompt
      // explicitly invites quoted scammer speech as "deciding
      // evidence" — that speech often includes the victim's spoken
      // last-four / case number / etc.
      const reasoning = raw ? redactSensitiveDigits(raw) || null : null;
      return {
        occurred_at: r.occurred_at.toISOString(),
        from_playbook_id: r.from_playbook_id,
        from_stage: r.from_stage,
        to_playbook_id: r.to_playbook_id,
        to_stage: r.to_stage,
        confidence: r.confidence,
        // r.confidence is 0..100 in DB; bucketConfidence wants 0..1.
        confidence_bucket: bucketConfidence(r.confidence / 100),
        trigger_event_id: r.trigger_event_id,
        reasoning,
      };
    }),
  };
}
