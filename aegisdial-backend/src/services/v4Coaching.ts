import { config } from '../config.js';
import { PLAYBOOKS_BY_ID, type PlaybookId } from '../data/playbooks.js';

// Live Shield v4 — Phase 3 — counter-script coaching surface.
//
// When the classifier has locked onto a playbook with sufficient
// confidence, the per-chunk transcript response carries that playbook's
// proven hang-up phrases ("counter-scripts") so iOS can render a
// "Say this to make them hang up" coaching card inline.
//
// This is the single most pitch-defining v4 feature: v3 catches the
// scammer; v4 also tells Mom exactly what to say. Compounds with the
// risk-level UI — at high/critical risk we want concrete actionable
// text on screen, not generic "be careful."
//
// Three gates compose:
//   1. V4_PLAYBOOK_COACHING_ENABLED flag (defaults OFF — coaching
//      surfaces ship dormant until the playbook lock is calibrated
//      to be stable for early-call sessions).
//   2. Stage-confidence floor (V4_PLAYBOOK_COACHING_MIN_CONFIDENCE,
//      default 0.7 — higher than the commit floor; coaching is more
//      consequential than just labeling the session).
//   3. Playbook lookup hit (drop the surface if PLAYBOOKS_BY_ID misses
//      — same shape as the Phase 2 family-alert validation: never
//      surface stale/half-resolved data).
//
// Output capped at V4_PLAYBOOK_COACHING_MAX_LINES (default 3). The
// playbook seeds order counter_scripts strongest-first, so top-N is
// the strongest-N.

/**
 * Resolve the counter-script surface for a session. Returns NULL when
 * any gate fails — the response builder treats that as "no v4 coaching
 * field in the response body."
 *
 * Pure function over the inputs: no DB, no Anthropic. Cheap to call on
 * every chunk; the transcript route reads v4_playbook_id +
 * v4_stage_confidence once via the existing SELECT and passes them in.
 *
 * Inputs are the RAW DB values (string | null, number | null). We
 * validate playbook_id against PLAYBOOKS_BY_ID rather than relying on
 * the caller's type cast — same defense-in-depth pattern as Phase 2's
 * composeV4Enrichment.
 */
export function resolveCoachingSurface(args: {
  v4_playbook_id: string | null;
  /** 0..100 (matches column scale), not 0..1. */
  v4_stage_confidence: number | null;
}): {
  playbook_id: PlaybookId;
  counter_scripts: string[];
} | null {
  if (!config.V4_PLAYBOOK_COACHING_ENABLED) return null;
  const { v4_playbook_id, v4_stage_confidence } = args;
  if (!v4_playbook_id || v4_stage_confidence == null) return null;

  // Confidence floor — convert config float (0..1) to the 0..100 scale
  // of the column. Comparisons inclusive at the floor since the column
  // is integer-rounded; 0.7 in config → 70 in column → "70 or above
  // qualifies." Avoids off-by-one rejections of a 70-confidence
  // session when the float floor was set to 0.7.
  const floorPct = Math.round(config.V4_PLAYBOOK_COACHING_MIN_CONFIDENCE * 100);
  if (v4_stage_confidence < floorPct) return null;

  const playbook = PLAYBOOKS_BY_ID.get(v4_playbook_id as PlaybookId);
  if (!playbook) return null;
  if (playbook.counter_scripts.length === 0) return null;

  const max = config.V4_PLAYBOOK_COACHING_MAX_LINES;
  return {
    playbook_id: playbook.id,
    counter_scripts: playbook.counter_scripts.slice(0, max),
  };
}
