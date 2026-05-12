-- Live Shield v4 — Phase 0 — playbook-aware scoring foundation.
--
-- v3 evaluates each call as if it's a brand-new puzzle. ~95% of phone
-- scams follow one of ~12 well-known scripts. v4 makes the playbook
-- itself a first-class object: every Live Shield session gains a
-- `(playbook_id, stage, stage_confidence)` tuple maintained alongside
-- the risk score. The score tells how dangerous; the playbook tuple
-- tells what's happening and what comes next.
--
-- Rollout posture: AUGMENTATION, NOT REPLACEMENT. v2 risk-scoring
-- keeps running unchanged; v4 publishes its tuple alongside. Feature-
-- flagged behind V4_PLAYBOOK_AWARE_ENABLED so PRs ship dormant in
-- prod until cutover. v2's months of calibration are preserved.
--
-- This migration is additive-only: every CREATE TABLE uses IF NOT
-- EXISTS, every ALTER TABLE uses ADD COLUMN IF NOT EXISTS with a
-- default. Safe to run against a database that has v3 deployed and
-- serving traffic.
--
-- Three concerns:
--   1. The playbook library (b4_playbooks) — JSON schemas for the
--      12 initial playbooks plus future additions.
--   2. The per-session classification state (call_sessions
--      additions) — current playbook_id, stage, confidence, and
--      a small audit trail of transitions.
--   3. Per-stage classifier audit (b4_playbook_stage_events) —
--      one row per stage transition for tuning + recap UI.

-- =========================================================================
-- 1. Playbook library
-- =========================================================================
--
-- Each row is one playbook. The `stages_json` column holds the
-- ordered stage list + expected phrases + counter-scripts per the
-- LIVE_SHIELD_V4.md schema. Stored as JSONB so we can refine in
-- place without per-stage schema migration churn — the seed in
-- src/data/playbooks.ts is the canonical source, this table is a
-- runtime mirror that admin can hot-tune without redeploying.
--
-- `enabled` lets ops disable a playbook in production (e.g. a
-- mis-calibrated rollout). Disabled playbooks are skipped by the
-- classifier; their existing sessions keep their last-classified
-- tuple but receive no further updates.

CREATE TABLE IF NOT EXISTS b4_playbooks (
  id                    TEXT        PRIMARY KEY,        -- 'irs_impersonation', 'bank_impersonation', etc.
  display_name          TEXT        NOT NULL,
  description           TEXT,
  stages_json           JSONB       NOT NULL,            -- ordered stage list + per-stage phrases
  counter_scripts       JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- array of strings
  recovery_steps_link   TEXT,                              -- references recovery_catalog key
  demographic_priors    JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- { elderly: 0.6, working_adult: 0.3, young: 0.1 }
  enabled               BOOLEAN     NOT NULL DEFAULT TRUE,
  schema_version        INT         NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot-path queries filter on enabled. Most calls match zero
-- playbooks initially, so a partial index keeps lookups cheap.
CREATE INDEX IF NOT EXISTS idx_b4_playbooks_enabled
  ON b4_playbooks (id) WHERE enabled = TRUE;

-- =========================================================================
-- 2. Per-session classification state on call_sessions
-- =========================================================================
--
-- These columns are READ on every transcript chunk (alongside risk
-- score, llm_score, b4_score_boost) and updated only when the
-- stage classifier transitions. Stable-state ticks (same playbook,
-- same stage) do not write to avoid hot-row contention with v2's
-- existing risk_score UPDATE.
--
-- v4_playbook_id NULL = no playbook detected yet (the common state
-- early in a call). Once set, only the classifier updates it.
-- v4_stage NULL when playbook is NULL.
-- v4_stage_confidence in 0..100 (same scale as risk_score) so iOS
-- can treat it the same way for UI density choices.

ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS v4_playbook_id          TEXT,
  ADD COLUMN IF NOT EXISTS v4_stage                TEXT,
  ADD COLUMN IF NOT EXISTS v4_stage_confidence     SMALLINT
    CHECK (v4_stage_confidence IS NULL OR v4_stage_confidence BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS v4_classified_at        TIMESTAMPTZ,
  -- Cumulative count of stage transitions this session — used by
  -- the post-call recap + by the classifier's stability heuristic
  -- ("we've changed stage 8 times in 30s — confidence is shot").
  ADD COLUMN IF NOT EXISTS v4_transition_count     INT         NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_call_sessions_v4_playbook
  ON call_sessions (v4_playbook_id) WHERE v4_playbook_id IS NOT NULL;

-- =========================================================================
-- 3. Per-stage classifier audit
-- =========================================================================
--
-- One row per stage transition. The classifier writes here when it
-- decides (playbook, stage, confidence) is meaningfully different
-- from the prior state. Used for:
--   - Post-call recap UI (timeline of "they tried this, then this")
--   - Classifier calibration tuning (offline analysis)
--   - Family-alert preempt ("Mom is at stage 'fear', avg time to
--     'ask' is 90s — call her now")
--
-- Retention: pruned by retention_sweeper alongside other v3 tables.
-- Volume estimate: 5–20 rows per scam call, fewer on safe calls.

CREATE TABLE IF NOT EXISTS b4_playbook_stage_events (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            UUID        NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Transition shape — null `from_*` for the first classification
  -- of a session (entry into a playbook).
  from_playbook_id      TEXT,
  from_stage            TEXT,
  to_playbook_id        TEXT        NOT NULL,
  to_stage              TEXT        NOT NULL,
  confidence            SMALLINT    NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  -- Triggering chunk's transcript_event id so the recap UI can
  -- show "the model decided this when caller said: <quote>".
  trigger_event_id      UUID,
  -- Free-form classifier rationale (truncated to 500 chars by the
  -- service). Stored to help operations tune the prompt later.
  reasoning             TEXT,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b4_playbook_stage_events_session
  ON b4_playbook_stage_events (session_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_b4_playbook_stage_events_playbook
  ON b4_playbook_stage_events (to_playbook_id, occurred_at DESC);

COMMENT ON TABLE b4_playbooks IS
  'v4 playbook library — each row is one scam script. JSON schemas live in src/data/playbooks.ts; this table is the runtime mirror.';
COMMENT ON TABLE b4_playbook_stage_events IS
  'v4 audit trail — one row per (playbook, stage) transition the classifier emits during a session.';
COMMENT ON COLUMN call_sessions.v4_playbook_id IS
  'Currently-detected v4 playbook for this session. NULL = no playbook (default before classifier fires). Updated by services/stageClassifier.ts.';
