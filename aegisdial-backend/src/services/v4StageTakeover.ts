import { query } from '../lib/db.js';
import { config } from '../config.js';
import { emitMetric } from '../lib/observability.js';
import { enqueueCriticalTakeoverPush } from './v3PushDispatcher.js';
import { PLAYBOOKS_BY_ID, type PlaybookId, type StageId } from '../data/playbooks.js';

// Live Shield v4 — Phase 4 — stage-transition takeover trigger.
//
// When the classifier locks onto a high-danger stage ('ask' or 'close')
// with confidence ≥ V4_STAGE_TAKEOVER_MIN_CONFIDENCE, fire a critical
// takeover push IMMEDIATELY — don't wait for the risk-score merge to
// catch up.
//
// Why this matters: the classifier sees "asking for gift cards" as
// stage='ask' the moment the chunk lands. v3's risk-merge adds the
// score-boost (Phase 2) on the NEXT chunk; the push enqueue only fires
// when the merged score crosses critical. That's 1-2 chunks of latency
// (8-16s with adaptive cadence). Phase 4 closes that gap by letting
// the classifier directly trigger the takeover.
//
// Idempotency: writes to call_sessions.b3_takeover_fired_at via the
// same atomic UPDATE-with-WHERE pattern that B3 sentinel and B4
// dispatch use. First-takeover-wins across all three paths — at most
// ONE shield_takeover push per session, regardless of which detector
// locks on first. Plus the 60s rolling-window suppression in
// enqueueCriticalTakeoverPush is defense-in-depth.
//
// Gate composition:
//   - V4_PLAYBOOK_AWARE_ENABLED (master) — gates the classifier
//     upstream; if off, no commit, no trigger call.
//   - V4_STAGE_TAKEOVER_ENABLED (this feature) — gates the trigger
//     even when v4 commits land.
//   - V3_B3_ENABLED (visual surface) — enqueueCriticalTakeoverPush
//     no-ops when this is off (no iOS takeover UI to render).
//   - Stage in {ask, close}
//   - Confidence ≥ V4_STAGE_TAKEOVER_MIN_CONFIDENCE

/** Stages that fire a takeover on transition-in. */
const TAKEOVER_STAGES: ReadonlySet<StageId> = new Set<StageId>(['ask', 'close']);

/** True if this (stage, confidence) pair should fire a takeover. */
export function shouldFireStageTakeover(stage: StageId, confidence: number): boolean {
  if (!config.V4_STAGE_TAKEOVER_ENABLED) return false;
  if (!TAKEOVER_STAGES.has(stage)) return false;
  if (confidence < config.V4_STAGE_TAKEOVER_MIN_CONFIDENCE) return false;
  return true;
}

/**
 * Try to claim takeover firing rights for this session and enqueue the
 * push if we won. Returns true when the takeover was actually enqueued
 * (this session's first takeover); false otherwise.
 *
 * Best-effort: any failure path logs + counts + returns false. The
 * calling classifier swallows the return value (fire-and-forget) so
 * a bug here cannot break v4 commits.
 */
export async function maybeFireStageTakeover(args: {
  session_id: string;
  user_id: string;
  stage: StageId;
  /** 0..1 float from the classifier output. */
  confidence: number;
  playbook_id: PlaybookId;
}): Promise<boolean> {
  const { session_id, user_id, stage, confidence, playbook_id } = args;
  if (!shouldFireStageTakeover(stage, confidence)) return false;

  // Atomic claim: only the FIRST takeover write wins. If B3 or B4
  // already claimed for this session, we no-op (cleanly: their push is
  // already in flight, and we don't want to double-push Mom).
  let claimed = false;
  try {
    const res = await query(
      `UPDATE call_sessions
          SET b3_takeover_fired_at = NOW(),
              updated_at = NOW()
        WHERE id = $1 AND b3_takeover_fired_at IS NULL`,
      [session_id],
    );
    claimed = (res.rowCount ?? 0) > 0;
  } catch (err) {
    emitMetric('v4.stage_takeover.claim_failed', {});
    // eslint-disable-next-line no-console
    console.error('[v4StageTakeover] atomic claim failed', {
      session_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  if (!claimed) {
    emitMetric('v4.stage_takeover.already_claimed', { stage });
    return false;
  }

  // Look up the playbook for the takeover copy. PLAYBOOKS_BY_ID.get
  // should always hit because the classifier wrote a validated id —
  // but defense-in-depth: if it misses, fall through with a neutral
  // display name rather than letting `undefined` reach buildTakeoverCopy.
  const playbook = PLAYBOOKS_BY_ID.get(playbook_id);
  const playbook_display_name = playbook?.display_name ?? 'a known scam pattern';

  // Confidence on the column scale (0..100) matches risk_score scale.
  // We pass this as risk_score so the existing dispatcher / iOS UI
  // surface treats it like any other critical push.
  //
  // SEMANTIC NOTE: this conflates the classifier's CONFIDENCE with
  // call-level RISK_SCORE — same pattern B4 dispatch uses today
  // (b4Orchestrator.ts uses confidence*100 as risk_score for its
  // enqueue). Dashboards filtering on `payload->risk_score` for
  // v4-triggered pushes will see confidence values, not the merged
  // risk_score from the transcript route. The `context.confidence`
  // field below carries the unambiguous value when ops needs to
  // disambiguate. Future cleanup: rename to `risk_signal` or split
  // the field semantically; out of scope for Phase 4.
  const confidencePct = Math.max(0, Math.min(100, Math.round(confidence * 100)));

  void enqueueCriticalTakeoverPush({
    session_id,
    user_id,
    trigger_path: 'v4_stage_classifier',
    risk_score: confidencePct,
    context: {
      playbook_id,
      playbook_display_name,
      stage,
      confidence: confidencePct,
    },
  }).catch((err) => {
    emitMetric('v4.stage_takeover.enqueue_failed', {});
    // eslint-disable-next-line no-console
    console.error('[v4StageTakeover] enqueue failed', {
      session_id,
      err: err instanceof Error ? err.message : String(err),
    });
  });

  emitMetric('v4.stage_takeover.fired', { stage, playbook_id });
  return true;
}
