import { config } from '../config.js';
import {
  PLAYBOOKS_BY_ID,
  STAGE_IDS,
  type PlaybookId,
  type StageId,
} from '../data/playbooks.js';

// Live Shield v4 — Phase 3C — Recovery Concierge playbook preload.
//
// When a recovery session was opened with v4_playbook_id set (Phase 2's
// /end-route handoff wrote it), this helper resolves the per-playbook
// preload fields that iOS uses to render a playbook-specific recovery
// surface instead of generic triage prompts.
//
// "We saw IRS impersonation — here are your 4 specific steps."
//
// Single source of truth: the playbook seed in src/data/playbooks.ts.
// The recovery_steps table is per-session and is seeded from the
// existing scam_type catalog at create time — this preload helper
// surfaces playbook-level context ALONGSIDE those steps so iOS can
// render a header card ("you were targeted by X scam") and link to the
// playbook's recovery_steps_link key. Phase 4 will move the per-step
// content to be playbook-keyed; Phase 3 keeps it backward-compatible.
//
// Gates: V4_PLAYBOOK_RECOVERY_PRELOAD_ENABLED (default OFF) + playbook
// lookup must hit + stage taxonomy must be valid. Returns NULL on any
// gate miss — caller treats NULL as "no preload, use generic triage."

export interface RecoveryPreload {
  /** The playbook the live-shield call was running. */
  playbook_id: PlaybookId;
  /** Human-readable scam name for the recovery header card. */
  playbook_display_name: string;
  /** Family-side blurb (reused from Phase 2 alert copy — same content lives in code). */
  blurb: string;
  /** Stage the call ended at. Drives which recovery checkpoint iOS starts at. */
  ended_at_stage: StageId | null;
  /** Reference into the recovery_catalog. NULL when the playbook seed had no link. */
  recovery_steps_link: string | null;
  /**
   * Top-N counter-scripts. Surfaced on the recovery screen as a
   * "what to say if they call back" card — many scammers re-target
   * the same victim, so counter-scripts are useful post-call too.
   */
  counter_scripts: string[];
}

/**
 * Resolve the playbook preload for a recovery session.
 *
 * Pure function over inputs. No DB. Inputs are the raw recovery_sessions
 * column values (string | null). Validates the playbook id against
 * PLAYBOOKS_BY_ID and the stage against the canonical taxonomy — same
 * defense-in-depth pattern as Phase 2's composeV4Enrichment and Phase
 * 3A's resolveCoachingSurface.
 *
 * Returns NULL when:
 *   - V4_PLAYBOOK_RECOVERY_PRELOAD_ENABLED is OFF
 *   - v4_playbook_id is NULL (legacy recovery session, cold session)
 *   - playbook_id doesn't resolve (stale data after rollback)
 *
 * v4_stage NULL is tolerated — iOS still gets the playbook context,
 * just no stage-specific checkpoint nudge.
 */
export function resolveRecoveryPreload(args: {
  v4_playbook_id: string | null;
  v4_stage: string | null;
}): RecoveryPreload | null {
  if (!config.V4_PLAYBOOK_RECOVERY_PRELOAD_ENABLED) return null;
  const { v4_playbook_id, v4_stage } = args;
  if (!v4_playbook_id) return null;
  const playbook = PLAYBOOKS_BY_ID.get(v4_playbook_id as PlaybookId);
  if (!playbook) return null;

  // Stage validation: if present but unknown, drop it (don't fail the
  // whole preload — playbook context is still useful without stage).
  // Uses the canonical STAGE_IDS from src/data/playbooks.ts so a future
  // taxonomy expansion stays in sync automatically.
  const validStage = v4_stage && STAGE_IDS.includes(v4_stage as StageId)
    ? (v4_stage as StageId)
    : null;

  return {
    playbook_id: playbook.id,
    playbook_display_name: playbook.display_name,
    blurb: playbook.family_alert_blurb,
    ended_at_stage: validStage,
    recovery_steps_link: playbook.recovery_steps_link,
    counter_scripts: playbook.counter_scripts.slice(0, 3),
  };
}
