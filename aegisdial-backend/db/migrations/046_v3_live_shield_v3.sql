-- Live Shield v3 — schema additions for the five v3 features.
--
-- This migration is additive-only: every CREATE TABLE uses IF NOT EXISTS,
-- every ALTER TABLE uses ADD COLUMN IF NOT EXISTS with a default. It is
-- safe to run against a database that has v2 deployed and serving traffic.
--
-- Maps to the five v3 features:
--   A1 — Push pre-warning + sources panel
--   A2 — User-blocked numbers OS-enforced
--   B3 — Visual takeover at moment of compromise
--   B4 — Real-time fact-checking the caller
--   B5 — Family one-tap join via direct dial
--
-- See LIVE_SHIELD_V3.md for the full spec; the section "Database schema
-- additions (consolidated)" maps each table below to its feature(s).

-- =========================================================================
-- A1 — Top-N hot-numbers cache that the iOS Call Directory Extension reads
-- =========================================================================

CREATE TABLE IF NOT EXISTS a1_hot_numbers (
  e164                TEXT        PRIMARY KEY,
  risk_weight         REAL        NOT NULL,
  mention_count       INTEGER     NOT NULL,
  primary_sources     TEXT[]      NOT NULL,  -- ['reddit', 'bbb', 'fcc', ...]
  last_recomputed_at  TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_a1_hot_numbers_recomputed
  ON a1_hot_numbers (last_recomputed_at);
CREATE INDEX IF NOT EXISTS idx_a1_hot_numbers_weight
  ON a1_hot_numbers (risk_weight DESC);

-- =========================================================================
-- A2 — User's personal block list (the on-device extension syncs from this)
-- =========================================================================
--
-- Distinguishing note: this table holds USER-INITIATED blocks only. AegisDial
-- never autonomously adds to it. The four entry points (Live Shield post-call
-- screen, A1 sources panel, in-app call log, settings) all funnel through
-- POST /v1/blocks which writes here.

CREATE TABLE IF NOT EXISTS user_blocks (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  e164                     TEXT        NOT NULL,
  reason_code              TEXT        NOT NULL,
  source_surface           TEXT        NOT NULL CHECK (source_surface IN
                             ('live_shield_post_call','a1_sources_panel','call_log','settings')),
  blocked_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  contributed_to_graph     BOOLEAN     NOT NULL DEFAULT TRUE,
  UNIQUE (user_id, e164)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_user
  ON user_blocks (user_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked_at
  ON user_blocks (blocked_at DESC);

-- A2 — Track when a previously-blocked number tries again. Powers the
-- AEGISDIAL_BLOCK_RETRY push notification + in-app block-history view.

CREATE TABLE IF NOT EXISTS block_retry_attempts (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  e164                     TEXT        NOT NULL,
  attempted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notification_sent        BOOLEAN     NOT NULL DEFAULT FALSE,
  notification_grouped     BOOLEAN     NOT NULL DEFAULT FALSE  -- true = rolled into digest
);

CREATE INDEX IF NOT EXISTS idx_block_retry_user_time
  ON block_retry_attempts (user_id, attempted_at DESC);

-- =========================================================================
-- B3 — Dismiss event audit log + sentinel matcher pattern library
-- =========================================================================

CREATE TABLE IF NOT EXISTS b3_dismiss_events (
  id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                      UUID        NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  user_id                         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  takeover_fired_at               TIMESTAMPTZ NOT NULL,
  dismissed_at                    TIMESTAMPTZ NOT NULL,
  score_at_dismiss                INTEGER     NOT NULL,
  trigger_path                    TEXT        NOT NULL CHECK (trigger_path IN
                                    ('live_shield_critical','sentinel_keyword','b4_finding')),
  family_alert_escalated          BOOLEAN     NOT NULL DEFAULT FALSE,
  mom_continued_speaking_seconds  INTEGER     -- nullable; populated post-call
);

CREATE INDEX IF NOT EXISTS idx_b3_dismiss_session
  ON b3_dismiss_events (session_id);

-- B3 — Hot-pushable sentinel pattern library. Patterns evaluated against
-- Mom-side STT chunks; each match optionally gated by a 60-second rolling
-- window of scammer-side context.

CREATE TABLE IF NOT EXISTS b3_sentinel_patterns (
  id                                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_name                       TEXT        NOT NULL UNIQUE,
  regex_source                       TEXT        NOT NULL,
  required_scammer_context_regex     TEXT,                  -- nullable = no gate
  scammer_context_window_seconds     INTEGER     NOT NULL DEFAULT 60,
  enabled                            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- B4 — Claim extraction, verification findings, curated directory, audit
-- =========================================================================

CREATE TABLE IF NOT EXISTS b4_extracted_claims (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID        NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  chunk_id      UUID        NOT NULL,
  claim_type    TEXT        NOT NULL CHECK (claim_type IN
                  ('bank_affiliation','agency_affiliation','account_tail',
                   'case_number','employee_identity','geographic_location')),
  claim_value   JSONB       NOT NULL,
  raw_quote     TEXT        NOT NULL,
  spoken_at     TIMESTAMPTZ NOT NULL,
  extracted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b4_claims_session
  ON b4_extracted_claims (session_id);

CREATE TABLE IF NOT EXISTS b4_findings (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id                 UUID        NOT NULL REFERENCES b4_extracted_claims(id) ON DELETE CASCADE,
  session_id               UUID        NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  result                   TEXT        NOT NULL CHECK (result IN
                             ('contradicted','cannot_verify','consistent')),
  confidence               REAL        NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reasoning                TEXT        NOT NULL,
  source_layer             TEXT        NOT NULL CHECK (source_layer IN ('curated','web_search')),
  source_url               TEXT,
  source_snippet           TEXT,
  source_curated_entry_id  UUID,
  verified_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b4_findings_session
  ON b4_findings (session_id);
-- Partial index — most queries filter to "contradicted ≥ 0.95" for takeover dispatch.
CREATE INDEX IF NOT EXISTS idx_b4_findings_contradicted_conf
  ON b4_findings (result, confidence DESC) WHERE result = 'contradicted';

-- B4 — Hot-pushable additions/corrections to the curated directory seed.
-- Seed lives in src/data/curatedB4Directory.json; this table layers
-- runtime overrides on top.

CREATE TABLE IF NOT EXISTS b4_curated_overrides (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type  TEXT        NOT NULL CHECK (entry_type IN ('bank','agency','rule')),
  org_name    TEXT        NOT NULL,
  data        JSONB       NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- B4 — Per-(session, claim_type) takeover cap enforcement. UNIQUE PK is the
-- enforcement mechanism: INSERT OR FAIL means "cap already hit, suppress".

CREATE TABLE IF NOT EXISTS b4_takeover_dispatched (
  session_id  UUID        NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  claim_type  TEXT        NOT NULL,
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finding_id  UUID        NOT NULL REFERENCES b4_findings(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, claim_type)
);

-- B4 — Post-call user-feedback captured for confidence-threshold calibration.
-- Surfaced in-app via the post-call recap prompt.

CREATE TABLE IF NOT EXISTS b4_feedback (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id    UUID        NOT NULL REFERENCES b4_findings(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feedback      TEXT        NOT NULL CHECK (feedback IN ('correct','wrong','unsure')),
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- B5 — Family-join event log. iOS handles the actual call (no Twilio bridge);
-- this table is the audit trail substitute.
-- =========================================================================

CREATE TABLE IF NOT EXISTS b5_safety_contact_events (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id              UUID        NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  family_member_user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  protected_user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type              TEXT        NOT NULL CHECK (event_type IN
                            ('initiating','joined','left')),
  event_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b5_events_session
  ON b5_safety_contact_events (session_id);

-- =========================================================================
-- Cross-feature — system_event persistence on the family transcript stream
-- =========================================================================
--
-- All five v3 features emit system_event markers (B3 takeover fired, B4
-- finding contradicted, safety contact joined, etc.) into the family
-- transcript so the watching adult kid sees a timeline of what AegisDial
-- did. Vocabulary is fixed in src/services/transcriptEvents.ts —
-- adding new event types requires a code change AND an update to the
-- integration map in LIVE_SHIELD_V3.md.

CREATE TABLE IF NOT EXISTS transcript_system_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID        NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type    TEXT        NOT NULL,  -- vocabulary in transcriptEvents.ts; not CHECK-constrained
                                       -- so we can ship new event types without a migration
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transcript_system_events_session
  ON transcript_system_events (session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcript_system_events_user_time
  ON transcript_system_events (user_id, occurred_at DESC);

-- =========================================================================
-- ALTERs to existing v2 tables
-- =========================================================================

-- family_alert_preferences is the v2 per-user-preferences table; v3 extends
-- it rather than introducing a new user_settings table.

ALTER TABLE family_alert_preferences
  ADD COLUMN IF NOT EXISTS cross_user_contribution_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS mom_side_stt_enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS block_retry_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- call_sessions tracks the B3 takeover lifecycle inline so that post-call
-- recap queries don't have to join across tables.

ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS b3_takeover_fired_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS b3_takeover_dismissed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS b4_findings_count         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS b4_contradicted_count     INTEGER NOT NULL DEFAULT 0;

-- mentions doesn't have a CHECK constraint on `source` in v2 (it's free-text),
-- so adding 'aegisdial_user_block' as a new value requires no schema change.
-- Documenting here so future engineers know the value is real.
COMMENT ON COLUMN mentions.source IS
  'Origin of the mention. v2: reddit | bbb | fcc | youtube | notes800 | serper. '
  'v3 adds: aegisdial_user_block (anonymized user-block contribution, gated '
  'by family_alert_preferences.cross_user_contribution_enabled).';
