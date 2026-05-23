-- Identity Shield — the single most important table.
--
-- Every Live / SMS / Email scorer reads from this table on EVERY scan.
-- An inbound call's caller-phone, an inbound SMS's sender, an inbound
-- email's from-address and sender-host all hit lookupThreat() before
-- the scorer issues its verdict. A hit produces a verdict bump and an
-- "Identity Shield context" footer on the alert.
--
-- This is the moat. Every recovery case, every classified Telegram
-- scammer-chatter message, every parsed darknet listing surfaces
-- here. Over time the proportion of alerts driven by THIS table
-- exceeds the proportion driven by HIBP/Enzoic — that's the data
-- network effect that justifies the company at fundraise valuation
-- (see RECOVERY_AND_IDENTITY_SHIELDS.md §5, §10).
--
-- PARTIAL-INDEX STRATEGY FOR SUB-MS SCORER LOOKUP:
-- The scorer's hot path is:
--   SELECT severity, provenance, context_text, geo_tag
--     FROM active_threats
--    WHERE threat_kind = $1 AND threat_value = $2
--      AND (expires_at IS NULL OR expires_at > NOW())
--    ORDER BY severity DESC NULLS LAST, last_seen_at DESC
--    LIMIT 1;
-- Without a partial index this scans the full table (~10M rows
-- expected by month 12). The partial index `idx_threats_by_value`
-- is defined WHERE expires_at IS NULL OR expires_at > NOW(); the
-- planner uses it directly because the predicate is a superset of
-- the query's filter. Sub-ms lookups stay under SLA even at table
-- sizes that would otherwise require sharding.
--
-- NOTE on partial-index NOW() limitation: Postgres treats NOW() in a
-- partial-index predicate as the planning-time value when checking
-- index applicability, but the index BUILD captures NOW() at CREATE
-- time. Expired rows therefore *can* remain in the index until the
-- daily retention cron's REINDEX. The query's runtime predicate
-- (the redundant `expires_at IS NULL OR expires_at > NOW()` in the
-- WHERE) filters them out — the index just makes the working set
-- small enough to scan cheaply.
--
-- THREAT_KIND VOCABULARY:
--   'phone_e164'      — caller / SMS-sender phone (E.164 normalized)
--   'email_address'   — sender email (lowercased)
--   'crypto_wallet'   — on-chain address (BTC/ETH/etc.)
--   'url_host'        — eTLD+1 of a URL in a scam message
--   'ip_address'      — inbound IPv4/IPv6 (rarely useful; reserved)
--
-- SEVERITY VOCABULARY (4 tiers — ONE MORE than findings; the
-- 'warning' tier captures medium-confidence intel that isn't yet
-- recovery-case-confirmed):
--   'informational'      — passive intel (e.g., in a breach dump)
--   'caution'            — mentioned in scammer chatter ≥1x
--   'warning'            — confirmed scam pattern, not yet specific
--                          victim-attested
--   'confirmed_scammer'  — at least one recovery case attests
--                          this artifact attempted fraud
--
-- PROVENANCE VOCABULARY (free-form string; convention-enforced;
-- drives the admin "where did this come from?" UI and the
-- transparency story on the iOS alert footer):
--   'aegisdial_recovery:<CASE_UUID>'
--   'telegram_channel:<CHANNEL_ID>:<MESSAGE_ID>'
--   'darknet_market:<MARKET_ID>:<LISTING_ID>'
--   'enzoic_breach:<BREACH_ID>'
--   'hibp:<BREACH_NAME>'
-- Convention: the part before the first ':' is the source-type tag;
-- the rest is opaque-but-stable to that source. The (threat_kind,
-- threat_value, provenance) UNIQUE prevents the same source from
-- inserting a dup; DIFFERENT sources observing the same artifact is
-- a strength signal, not a dedupe concern (multiple rows raise
-- aggregate confidence via the scorer's max-severity selection).
--
-- EXPIRY SEMANTICS:
-- expires_at = NULL means the threat never auto-expires; only used
-- for 'confirmed_scammer' rows (a victim-attested scam phone is
-- still a scam phone two years later).
-- expires_at = NOW() + 90d for 'caution' severity (chatter mentions
-- age out — scammers rotate disposable artifacts weekly).
-- expires_at = NOW() + 365d for 'warning' severity (pattern-confirmed
-- artifacts retain relevance for a year).
-- expires_at = NOW() + 30d for 'informational' (low-confidence
-- intel ages out fastest).
-- Ranges are enforced in the recordThreat() service, not at the
-- schema layer, because operator tuning may shift them during
-- ramp-up.
--
-- ANTI-POISONING:
-- The (threat_kind, threat_value, provenance) UNIQUE doesn't prevent
-- a malicious recovery case from inserting "1-800-555-1234" as a
-- 'confirmed_scammer'. That guardrail lives in the
-- recoveryCaseObserver — a single recovery case CAN'T promote a
-- popular number to 'confirmed_scammer' alone; requires ≥2 distinct
-- attesting cases OR admin approval. See I-P8 adversarial review.
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS active_threats (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  threat_kind               TEXT NOT NULL CHECK (threat_kind IN
    ('phone_e164','email_address','crypto_wallet','url_host','ip_address')),
  -- Literal artifact value. Pre-normalized by the recordThreat()
  -- service: phone_e164 is E.164 with leading '+'; email_address is
  -- lowercased; url_host is eTLD+1 lowercased; crypto_wallet is the
  -- on-chain canonical form (mixed case for ETH checksummed
  -- addresses, lowercase for BTC).
  threat_value              TEXT NOT NULL,
  severity                  TEXT NOT NULL CHECK (severity IN
    ('informational','caution','warning','confirmed_scammer')),
  -- Where this came from. Drives admin UI + transparency.
  provenance                TEXT NOT NULL,
  -- Free-form context for the per-shield alert footer. Rendered into
  -- the iOS alert ("Identity Shield context: this number was
  -- advertised in a scammer-services channel 2 hours ago"). Kept
  -- short (<200 chars by convention) — the iOS card has limited
  -- vertical space.
  context_text              TEXT,
  -- Soft geo-targeting. ISO 3166-1 alpha-2 ('US', 'UK', 'AU') or NULL
  -- for global. Used by the dashboard counter "active threats near
  -- you" — the scorer hot path ignores this column (a known scammer
  -- phone is a scam regardless of the target geo).
  geo_tag                   TEXT,
  first_seen_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Bumped to NOW() on every fresh observation. Drives the
  -- dashboard "active threats in last 30d" filter and the freshness
  -- ordering in the scorer's SELECT.
  last_seen_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = no expiry. See header EXPIRY SEMANTICS for ranges by
  -- severity.
  expires_at                TIMESTAMPTZ,
  -- Dedup constraint: same source can't double-insert the same
  -- artifact. ON CONFLICT (threat_kind, threat_value, provenance) DO
  -- UPDATE SET last_seen_at=NOW(), severity=GREATEST(...) in the
  -- recordThreat() service.
  UNIQUE (threat_kind, threat_value, provenance)
);

-- The hot index. Every scorer hit lands here.
-- Postgres rejects NOW() in a partial-index predicate (functions in
-- index predicates must be IMMUTABLE — `42P17`). The retention cron
-- DELETEs expired rows daily, so a non-partial index here stays small
-- in steady state; the runtime WHERE in the scorer still filters any
-- not-yet-swept expired rows.
CREATE INDEX IF NOT EXISTS idx_threats_by_value
  ON active_threats(threat_kind, threat_value);

-- Admin "what arrived this hour" timeline + the retention sweep
-- (DELETE WHERE expires_at < NOW()). Descending order matches the
-- "most recent first" ordering of the admin timeline view.
CREATE INDEX IF NOT EXISTS idx_threats_recent
  ON active_threats(last_seen_at DESC);

COMMENT ON TABLE active_threats IS
  'Identity Shield — synthesized active-threat list. The single most-read table in AegisDial: every Live/SMS/Email scorer hits lookupThreat() on every scan. Partial index idx_threats_by_value keeps sub-ms lookup performance at >10M rows. UNIQUE(threat_kind, threat_value, provenance) prevents same-source dupes; DIFFERENT sources INSERTing the same artifact is a strength signal (the scorer picks max severity across rows).';

COMMENT ON COLUMN active_threats.provenance IS
  'Source attribution. Convention: <source_tag>:<source_specific_id>. Examples: aegisdial_recovery:<UUID>, telegram_channel:<CID>:<MID>, darknet_market:<MID>:<LID>, enzoic_breach:<BID>, hibp:<NAME>. The source_tag prefix drives admin UI grouping and per-shield alert-footer copy.';

COMMENT ON COLUMN active_threats.expires_at IS
  'NULL = no expiry (used for confirmed_scammer). Otherwise the recordThreat() service sets: caution → NOW()+90d, warning → NOW()+365d, informational → NOW()+30d. Retention cron DELETEs rows where expires_at < NOW() daily.';

COMMENT ON COLUMN active_threats.context_text IS
  'Free-form context rendered into the iOS alert footer. Kept short (<200 chars by convention). Example: "advertised in a scammer-services channel 2 hours ago" or "reported by another AegisDial user via recovery case (anonymized)".';

COMMENT ON COLUMN active_threats.geo_tag IS
  'Soft geo-targeting (ISO-3166 alpha-2). Used for the dashboard "active threats near you" counter only — the scorer hot path ignores geo (a scam phone is a scam regardless of caller-target geography).';
