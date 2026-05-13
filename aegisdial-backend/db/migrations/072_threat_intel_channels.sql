-- Identity Shield — curated list of threat-intel sources.
--
-- The Telegram chatter listener (I-P3b worker) and the darknet
-- market crawler (I-P3c worker) both read this table to know which
-- channels / markets to observe. Empty table = workers idle and do
-- nothing. Seeded by Jesiah (~80 channels + ~10 markets at launch),
-- then maintained by the AI threat-landscape meta-analyst (I-P6)
-- via the candidate-review queue.
--
-- OBSERVER-ONLY POSTURE — load-bearing for legal posture:
-- AegisDial is an OBSERVER on these sources. We:
--   - NEVER purchase from darknet markets.
--   - NEVER engage in Telegram channels (no posts, no DMs, no
--     reactions, no replies).
--   - NEVER operate sock-puppet accounts pretending to be buyers.
--   - NEVER initiate contact with sellers / channel admins / other
--     channel members.
--   - NEVER pay for access (no premium-channel subscriptions, no
--     market vendor-buyer-bonds, no escrow deposits).
-- These are not norms — they're architectural invariants. Every
-- worker that reads this table is a read-only consumer. There is no
-- write path from AegisDial code into any source listed here. The
-- bot accounts join channels in passive mode; the Tor crawler GETs
-- listing pages and never POSTs. Operator runbook codifies these as
-- non-negotiable; the I-P8 adversarial review verifies the absence
-- of any write surface against these sources.
--
-- CURATED-BY-AI-AND-JESIAH MODEL:
-- Constella / Flashpoint hire ex-FBI analysts at $150–250k/yr to
-- curate equivalent lists. AegisDial replaces them with an LLM
-- meta-analyst (the threatLandscapeAnalyst service, I-P6) that:
--   1. Discovers new candidate channels from cross-references in
--      already-classified scammer chatter, populates the sibling
--      table threat_intel_candidates.
--   2. Flags dormant channels (yield drop) for removal.
--   3. Re-classifies capability tags weekly.
-- Jesiah owns the strategic editorial — 15 min/day reviewing the
-- candidate queue via /v1/admin/intel/candidates. The AI does the
-- 24/7 monitoring; Jesiah makes the human judgment call on
-- "is this source worth tracking?" That split is the wedge.
--
-- SOURCE_KIND VOCABULARY:
--   'telegram'        — public Telegram channel observed by the
--                       chatter-listener bot fleet
--   'darknet_market'  — Tor-accessible credential market crawled
--                       by the daily darknet crawler
--
-- STATUS VOCABULARY:
--   'candidate'  — discovered, awaiting approval (rare here; usually
--                  candidates live in threat_intel_candidates first)
--   'active'     — workers poll this source
--   'dormant'    — yield collapsed; kept for historical attribution
--                  on past active_threats rows; workers skip
--   'removed'    — explicitly disabled (pivoted to honeypot, taken
--                  down, or operator deemed off-strategy)
--   'honeypot'   — confirmed as a sting / monitoring trap; do not
--                  visit (Tor exit-node liability if logged)
--
-- CAPABILITY_TAGS VOCABULARY (free-form array; convention-enforced):
--   'carding', 'bank_logs', 'dox_for_hire', 'scampage', 'otp_bot',
--   'refund_method', 'sextortion_script'
-- New tags emerge as the underground innovates; the AI analyst's
-- weekly re-tag pass adds tags, the SOP doc captures definitions.
--
-- PRIVACY POSTURE:
-- This table holds NO user data and NO PII. It's purely operational
-- metadata. Safe to back up and replicate without privacy review.
--
-- RETENTION: indefinite. Historical channel records are needed to
-- attribute past active_threats rows ("this number was flagged
-- because @oldchannel mentioned it in 2026").
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS threat_intel_channels (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind                 TEXT NOT NULL CHECK (source_kind IN ('telegram','darknet_market')),
  -- Telegram: '@channelname' or 't.me/+invite_hash' for private
  -- channels. Darknet market: '<marketname>.onion' canonical hostname
  -- (without scheme).
  source_handle               TEXT NOT NULL,
  -- Human-readable name shown in the admin UI. May differ from the
  -- handle (e.g., a channel renames; we keep the original handle as
  -- the matching key for past active_threats provenance).
  display_name                TEXT NOT NULL,
  -- Capability tags. Free-form text array; conventions in header.
  capability_tags             TEXT[] NOT NULL DEFAULT '{}',
  -- ISO 3166-1 alpha-2 codes the channel targets. Empty array = no
  -- inferred geo (global / generic).
  geo_relevance               TEXT[] NOT NULL DEFAULT '{}',
  status                      TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN
    ('candidate','active','dormant','removed','honeypot')),
  added_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Who approved (typically Jesiah's user_id). NULL for AI-discovered
  -- candidates that haven't been approved yet.
  added_by                    UUID REFERENCES users(id),
  -- Most recent message timestamp observed by the worker. NULL until
  -- the worker has polled at least once successfully.
  last_message_observed_at    TIMESTAMPTZ,
  -- Rolling 7-day count of messages the per-message classifier
  -- categorized as scam-relevant. Drives the meta-analyst's
  -- dormancy-detection: if this drops below threshold, recommend
  -- status='dormant'. Updated nightly by the meta-analyst worker.
  classified_message_count_7d INTEGER NOT NULL DEFAULT 0,
  -- Dedup constraint: a channel handle appears at most once per
  -- source_kind. ON CONFLICT DO UPDATE for the meta-analyst's
  -- nightly re-tag / dormancy pass.
  UNIQUE (source_kind, source_handle)
);

-- Hot path: workers iterate "give me everything active for my
-- source_kind". Partial index keeps the working set small —
-- dormant/removed/honeypot channels are excluded.
CREATE INDEX IF NOT EXISTS idx_intel_channels_active
  ON threat_intel_channels(source_kind) WHERE status = 'active';

COMMENT ON TABLE threat_intel_channels IS
  'Identity Shield — curated Telegram channels + darknet markets observed by the chatter listener + darknet crawler. OBSERVER-ONLY posture: no engagement, no purchases, no sock puppets. AI-curated (threatLandscapeAnalyst discovers candidates) and Jesiah-approved (admin queue). The wedge vs Constella/Flashpoint: 24/7 LLM analyst instead of ex-FBI human analysts.';

COMMENT ON COLUMN threat_intel_channels.source_handle IS
  'Telegram: @channelname or t.me/+invite_hash. Darknet market: <marketname>.onion (no scheme). Matching key for past active_threats provenance — preserved across channel renames.';

COMMENT ON COLUMN threat_intel_channels.status IS
  'candidate → active (approval) → dormant (yield collapse) → removed (operator disabled) | honeypot (confirmed trap, do not visit). Workers only poll status=active rows.';

COMMENT ON COLUMN threat_intel_channels.classified_message_count_7d IS
  'Rolling 7d count of scam-relevant messages from this channel. Drives the meta-analyst dormancy-detection: a sustained drop flags the channel for status=dormant.';

COMMENT ON COLUMN threat_intel_channels.capability_tags IS
  'Free-form capability tags (carding, bank_logs, dox_for_hire, scampage, otp_bot, refund_method, sextortion_script, …). Re-tagged weekly by the AI meta-analyst to track underground pivots.';
