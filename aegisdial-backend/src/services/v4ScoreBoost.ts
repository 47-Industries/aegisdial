import { query } from '../lib/db.js';
import { emitMetric } from '../lib/observability.js';
import { config } from '../config.js';
import type { StageId } from '../data/playbooks.js';

// Live Shield v4 — Phase 2 — playbook-stage score boost.
//
// When the stage classifier locks onto a high-danger stage ('ask' or
// 'close') with confidence above V4_SCORE_BOOST_MIN_CONFIDENCE, this
// module increments call_sessions.v4_score_boost. The transcript
// route's risk-merge path reads that column on every chunk and adds
// it to the merged regex+LLM score, capped at 100.
//
// Mirror of v3's b4_score_boost mechanism (b4Orchestrator.applyB4ScoreBoost
// + the merge in routes/liveShield.ts). Kept as a separate column so
// admin dashboards can split v3 (claim-verification) boosts from v4
// (playbook-stage) boosts during the augmentation rollout.
//
// Boost is ADDITIVE and CAPPED at the SQL layer — no read-modify-write
// race window. Idempotency: a torn write only undercounts; same loss
// tolerance as B4. Caller swallows errors; boost is best-effort.

/** Stages that earn a score boost on transition-in. */
const BOOST_STAGES: ReadonlySet<StageId> = new Set<StageId>(['ask', 'close']);

/**
 * Return the boost value for a stage transition, or 0 if the stage
 * doesn't earn a boost. Reads from config so ops can tune live.
 */
export function boostForStage(stage: StageId): number {
  if (stage === 'ask') return config.V4_SCORE_BOOST_ASK;
  if (stage === 'close') return config.V4_SCORE_BOOST_CLOSE;
  return 0;
}

/** True if this (stage, confidence) pair should fire a score boost. */
export function shouldBoost(stage: StageId, confidence: number): boolean {
  if (!config.V4_PLAYBOOK_SCORE_BOOST_ENABLED) return false;
  if (!BOOST_STAGES.has(stage)) return false;
  if (confidence < config.V4_SCORE_BOOST_MIN_CONFIDENCE) return false;
  return true;
}

/**
 * Apply the v4 score boost for a session. Best-effort — DB errors are
 * logged + counted but not propagated to the caller (this fires inside
 * the classifier commit path which already swallowed its own errors).
 *
 * Idempotency: SQL-layer LEAST(100, ...) caps regardless of how many
 * times we fire. Two near-simultaneous boosts for the same session
 * will both apply (additive), but the cap keeps the column bounded.
 * Same tolerance B4 accepts.
 */
export async function applyV4ScoreBoost(
  session_id: string,
  boost: number,
): Promise<void> {
  if (boost <= 0) return;
  try {
    await query(
      `UPDATE call_sessions
          SET v4_score_boost = LEAST(100, v4_score_boost + $2),
              updated_at = NOW()
        WHERE id = $1`,
      [session_id, boost],
    );
    emitMetric('v4.score_boost.applied', { boost: String(boost) });
  } catch (err) {
    emitMetric('v4.score_boost.update_failed', {});
    // eslint-disable-next-line no-console
    console.error('[v4ScoreBoost] applyV4ScoreBoost failed', {
      session_id,
      boost,
      err: err instanceof Error ? err.message : String(err),
    });
    // Swallow — boost is best-effort. Worst case: the next chunk's
    // merge sees an undercounted boost, same tolerance as B4.
  }
}

/**
 * High-level wrapper used by the classifier commit path. Checks the
 * config gate + stage gate + confidence gate, picks the boost value,
 * and fires the UPDATE. Single entry point so the classifier doesn't
 * have to know the boost-value table.
 *
 * Returns the applied boost (0 if skipped) for telemetry.
 */
export async function maybeApplyStageBoost(args: {
  session_id: string;
  stage: StageId;
  /** 0..1 from the classifier output. */
  confidence: number;
}): Promise<number> {
  const { session_id, stage, confidence } = args;
  if (!shouldBoost(stage, confidence)) return 0;
  const boost = boostForStage(stage);
  if (boost <= 0) return 0;
  await applyV4ScoreBoost(session_id, boost);
  return boost;
}
