-- Identity Shield — AI-discovered candidate sources awaiting approval.
--
-- The meta-analyst flow: AI discovers, Jesiah approves.
--
-- META-ANALYST FLOW (see RECOVERY_AND_IDENTITY_SHIELDS.md §12 +
-- IDENTITY_SHIELD_ENGINEERING.md I-P6 for the full architectural
-- rationale):
--   1. The per-message LLM classifier (running over classified
--      Telegram traffic) extracts outbound references from every
--      scam-relevant message — "join @newchannel for fresh dumps",
--      "available on freshmarket.onion", "DM @vendor_handle for
--      logs", etc.
--   2. The daily threatLandscapeAnalyst worker dedupes references,
--      groups by candidate handle, computes a candidate_score from
--      mention frequency × source-channel quality × recency, and
--      INSERTs a row HERE for each handle we don't already track.
--   3. Jesiah reviews the queue at /v1/admin/intel/candidates
--      (15 min/day target). Each row carries a rationale JSONB with
--      sample evidence so the approval is informed, not blind.
--   4. Jesiah taps "approve" → row UPDATES decision='approved',
--      decided_at=NOW(), decided_by=Jesiah's user_id, AND the
--      candidate is promoted into threat_intel_channels with
--      status='active'.
--   5. Or taps "reject" → decision='rejected', the candidate stays
--      in this table as a record (so the same handle isn't
--      re-surfaced next week — the meta-analyst checks decision
--      history before re-INSERTing).
--
-- Why this is structurally right (not just cost arbitrage):
--   - 24/7 sub-minute discovery. Constella analysts work business
--     hours; ours never sleeps.
--   - Compounds with our own filtered feed. Constella analysts work
--     from a generic firehose; ours works from a feed pre-classified
--     for consumer-retail-scam relevance.
--   - The AI does the volume work; Jesiah does the editorial work.
--     That split is the wedge.
--
-- RATIONALE JSONB SHAPE (free-form by design, but conventional):
--   {
--     "cited_by": ["<channel_id>", "<channel_id>", ...],
--     "mention_count": <int>,
--     "first_mentioned_at": "<ISO timestamp>",
--     "sample_evidence": [
--       { "channel_id": "...", "message_id": "...", "excerpt": "..." }
--     ],
--     "capability_signal": ["carding", "bank_logs"],
--     "geo_signal": ["US"]
--   }
-- The admin UI renders sample_evidence as quoted excerpts so Jesiah
-- can read what the AI saw. Free-form JSONB lets the meta-analyst
-- evolve its rationale shape without a schema migration.
--
-- CANDIDATE_SCORE RANGE: 0.000–1.000 (NUMERIC(4,3)). Drives the
-- admin queue ordering — highest score first. Score formula lives
-- in the threatLandscapeAnalyst service and is operator-tunable.
--
-- DEDUP / RE-DISCOVERY:
-- The UNIQUE (source_kind, source_handle) prevents the meta-analyst
-- from re-INSERTing a handle it's seen before. On re-discovery the
-- analyst UPDATEs the rationale (more cited_by, fresher
-- sample_evidence) and bumps the candidate_score. A 'rejected'
-- candidate stays rejected unless an operator explicitly clears
-- the decision via SQL (rare; deliberate).
--
-- PRIVACY POSTURE:
-- No user PII. Only public channel handles + LLM-extracted excerpts
-- from already-public (per-channel-policy) scammer chatter. The
-- LLM-prompt-injection adversarial review (I-P8) covers the case
-- where a hostile message attempts to inject content via this
-- pipeline.
--
-- RETENTION: indefinite. The decision history is operationally
-- valuable (Jesiah's rejection pattern is the AI's training signal).
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS threat_intel_candidates (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind               TEXT NOT NULL CHECK (source_kind IN ('telegram','darknet_market')),
  -- Same canonical form as threat_intel_channels.source_handle. On
  -- approval, this value migrates verbatim into the channels table.
  source_handle             TEXT NOT NULL,
  discovered_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Why the analyst flagged it. References to citing channels +
  -- sample evidence. See header for conventional shape.
  rationale                 JSONB NOT NULL,
  -- 0.000–1.000. Higher = more confidence the candidate is worth
  -- tracking. Drives admin queue ordering. CHECK is implicit via
  -- NUMERIC(4,3); scorer service clamps to [0, 1] before INSERT.
  candidate_score           NUMERIC(4,3) NOT NULL,
  -- Pending: decision IS NULL. Approved: 'approved' + decided_at +
  -- decided_by. Rejected: 'rejected' + decided_at + decided_by.
  decision                  TEXT,
  decided_at                TIMESTAMPTZ,
  -- Typically Jesiah's user_id. NOT NULL after decision is non-NULL
  -- (enforced in the route handler, not at the schema layer, to
  -- avoid a complex multi-column CHECK on a mixed-state column).
  decided_by                UUID REFERENCES users(id),
  -- Dedup: an AI-discovered handle appears at most once.
  -- Re-discovery UPDATEs rationale + candidate_score; doesn't
  -- INSERT.
  UNIQUE (source_kind, source_handle)
);

-- Hot path: admin's /v1/admin/intel/candidates queue lists pending
-- candidates ordered by discovery time (newest first). Partial
-- index keeps the working set small — decided candidates fall out.
CREATE INDEX IF NOT EXISTS idx_candidates_pending
  ON threat_intel_candidates(discovered_at DESC)
  WHERE decision IS NULL;

COMMENT ON TABLE threat_intel_candidates IS
  'Identity Shield — AI-discovered candidate sources awaiting Jesiah approval. The meta-analyst flow: threatLandscapeAnalyst worker INSERTs candidates from cross-references in classified scammer chatter; admin reviews via /v1/admin/intel/candidates; approval promotes the candidate into threat_intel_channels with status=active. The wedge vs human-analyst competitors: 24/7 LLM discovery, human-only editorial.';

COMMENT ON COLUMN threat_intel_candidates.rationale IS
  'Free-form JSONB documenting why the AI flagged this candidate. Conventional keys: cited_by (channel_ids), mention_count, first_mentioned_at, sample_evidence (channel_id+message_id+excerpt), capability_signal, geo_signal. Rendered in admin UI as quoted excerpts so Jesiah can audit the AI''s judgment.';

COMMENT ON COLUMN threat_intel_candidates.candidate_score IS
  'AI-computed confidence in [0.000, 1.000]. Formula = mention_count × source_channel_quality × recency_decay (operator-tunable in threatLandscapeAnalyst service). Drives queue ordering (highest first).';

COMMENT ON COLUMN threat_intel_candidates.decision IS
  'NULL = pending review. ''approved'' = promoted into threat_intel_channels with status=active. ''rejected'' = blocked from re-INSERT on subsequent discovery. Decision history is the AI''s training signal — DO NOT prune rejected rows.';
