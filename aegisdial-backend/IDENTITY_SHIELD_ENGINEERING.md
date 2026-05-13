# Identity Shield — Engineering Spec

**Strategy reference:** `RECOVERY_AND_IDENTITY_SHIELDS.md` (positioning, loop, AI-as-analyst, fundraise frame).
**This doc:** phase-by-phase build plan, table schemas, file deliverables, test expectations.

Same pattern as Email Shield + Recovery Shield. Phased commits, adversarial pass at the end.

---

## Phase ledger

| Phase | Scope | Effort | Parallelizable? |
|---|---|---|---|
| **I-P1** | Migrations 068–074 + types | S | No |
| **I-P2** | Active-threats service + scorer hooks (Live/SMS/Email) | M | No |
| **I-P3a** | Enzoic + HIBP ingest worker | M | **Yes** (parallel with P3b, P3c) |
| **I-P3b** | Telegram chatter listener (scaffold — empty seed table OK) | L | **Yes** |
| **I-P3c** | Darknet market crawler (scaffold — empty seed table OK) | L | **Yes** |
| **I-P4** | `/v1/identity-shield/*` route surface | M | No |
| **I-P5** | Dashboard tile + push digest scheduler | M | No |
| **I-P6** | AI threat-landscape meta-analyst | M | **Yes** (with R-P6) |
| **I-P7** | Admin dashboard `/v1/admin/identity-shield/*` + intel-source health | M | **Yes** (with R-P6) |
| **I-P8** | Adversarial review pass | S | **Yes** (with R-P7) |
| **I-P9** | E2E scenario + operator runbook + commit | M | No |

**Total: ~7 phases of build + 2 polish.** ~4–5 weeks single-engineer; ~3 weeks with 3-agent fan-out at P3.

---

## I-P1 — Migrations + types

Seven new tables. Numbering reserved **068–074**.

### 068_identity_monitors.sql
```sql
-- Per-user list of what we watch.
CREATE TABLE identity_monitors (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monitor_kind              TEXT NOT NULL CHECK (monitor_kind IN
    ('email','phone_e164','ssn_last4_hash','dob_hash','name_address_hash')),
  -- Plaintext (for email/phone) OR hash (for SSN/DOB/composite-PII).
  -- SSN/DOB are NEVER stored plaintext. Email/phone are plaintext because
  -- they're already plaintext in email_accounts / user profile.
  watched_value             TEXT NOT NULL,
  -- Per-user salt for hash kinds. NULL for plaintext kinds.
  salt_hex                  TEXT,
  active                    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, monitor_kind, watched_value)
);
CREATE INDEX idx_monitors_active ON identity_monitors(user_id) WHERE active;
CREATE INDEX idx_monitors_by_kind_value ON identity_monitors(monitor_kind, watched_value) WHERE active;
```

### 069_identity_breaches.sql
```sql
-- Global breach catalog, synced from HIBP + Enzoic. NOT per-user.
CREATE TABLE identity_breaches (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  breach_name               TEXT NOT NULL,            -- "LinkedIn", "Exactis", ...
  source                    TEXT NOT NULL CHECK (source IN ('hibp','enzoic','aegisdial_internal')),
  source_breach_id          TEXT NOT NULL,            -- HIBP/Enzoic's own ID for re-sync
  domain                    TEXT,                     -- "linkedin.com"
  breach_date               DATE,
  added_date                TIMESTAMPTZ,
  pwn_count                 BIGINT,
  data_classes              TEXT[] NOT NULL DEFAULT '{}',
  is_verified               BOOLEAN NOT NULL DEFAULT FALSE,
  is_sensitive              BOOLEAN NOT NULL DEFAULT FALSE,
  description               TEXT,
  synced_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_breach_id)
);
CREATE INDEX idx_breaches_recent ON identity_breaches(synced_at DESC);
```

### 070_identity_breach_findings.sql
```sql
-- Per-user per-breach match record. INSERT-once; UPDATE only severity.
CREATE TABLE identity_breach_findings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monitor_id                UUID NOT NULL REFERENCES identity_monitors(id) ON DELETE CASCADE,
  breach_id                 UUID NOT NULL REFERENCES identity_breaches(id) ON DELETE CASCADE,
  severity                  TEXT NOT NULL CHECK (severity IN ('informational','caution','critical')),
  surfaced_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_acknowledged_at      TIMESTAMPTZ,
  remediation_completed_at  TIMESTAMPTZ,
  UNIQUE (user_id, monitor_id, breach_id)
);
CREATE INDEX idx_findings_user_new ON identity_breach_findings(user_id, surfaced_at DESC)
  WHERE user_acknowledged_at IS NULL;
```

### 071_active_threats.sql
```sql
-- The single most important table. Live scorers read this every scan.
CREATE TABLE active_threats (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  threat_kind               TEXT NOT NULL CHECK (threat_kind IN
    ('phone_e164','email_address','crypto_wallet','url_host','ip_address')),
  threat_value              TEXT NOT NULL,
  severity                  TEXT NOT NULL CHECK (severity IN
    ('informational','caution','warning','confirmed_scammer')),
  -- Where this came from. Drives admin UI + transparency.
  provenance                TEXT NOT NULL,            -- 'aegisdial_recovery:CASE_ID', 'telegram_channel:CHANNEL_ID', 'darknet_market:MARKET_ID:LISTING_ID', 'enzoic_breach:BREACH_ID', 'hibp:BREACH_NAME'
  -- Free-form context for the per-shield alert footer.
  context_text              TEXT,
  -- Soft geo-targeting (for prioritizing region-relevant alerts).
  geo_tag                   TEXT,                     -- 'US', 'UK', 'AU', or NULL for global
  first_seen_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                TIMESTAMPTZ,              -- NULL = no expiry; 'caution' threats expire 90d
  UNIQUE (threat_kind, threat_value, provenance)
);
CREATE INDEX idx_threats_by_value ON active_threats(threat_kind, threat_value)
  WHERE expires_at IS NULL OR expires_at > NOW();
CREATE INDEX idx_threats_recent ON active_threats(last_seen_at DESC);
```

### 072_threat_intel_channels.sql
```sql
-- Curated list of Telegram channels + darknet markets we observe.
CREATE TABLE threat_intel_channels (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind               TEXT NOT NULL CHECK (source_kind IN ('telegram','darknet_market')),
  source_handle             TEXT NOT NULL,            -- '@channelname' or 'marketname.onion'
  display_name              TEXT NOT NULL,
  capability_tags           TEXT[] NOT NULL DEFAULT '{}',  -- 'carding','bank_logs','dox_for_hire','scampage','otp_bot','refund_method','sextortion_script'
  geo_relevance             TEXT[] NOT NULL DEFAULT '{}',  -- ISO codes
  status                    TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN
    ('candidate','active','dormant','removed','honeypot')),
  added_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by                  UUID REFERENCES users(id),
  last_message_observed_at  TIMESTAMPTZ,
  classified_message_count_7d INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_kind, source_handle)
);
CREATE INDEX idx_intel_channels_active ON threat_intel_channels(source_kind) WHERE status = 'active';
```

### 073_threat_intel_candidates.sql
```sql
-- AI meta-analyst's discovered candidates awaiting Jesiah's approval.
CREATE TABLE threat_intel_candidates (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind               TEXT NOT NULL CHECK (source_kind IN ('telegram','darknet_market')),
  source_handle             TEXT NOT NULL,
  discovered_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Why the analyst flagged it. References to citing channels.
  rationale                 JSONB NOT NULL,           -- { cited_by: [...], mention_count: N, sample_evidence: [...] }
  candidate_score           NUMERIC(4,3) NOT NULL,    -- 0.000-1.000
  decision                  TEXT,                     -- NULL = pending; 'approved' | 'rejected'
  decided_at                TIMESTAMPTZ,
  decided_by                UUID REFERENCES users(id),
  UNIQUE (source_kind, source_handle)
);
CREATE INDEX idx_candidates_pending ON threat_intel_candidates(discovered_at DESC)
  WHERE decision IS NULL;
```

### 074_threat_landscape_briefings.sql
```sql
-- Quarterly auto-generated reports.
CREATE TABLE threat_landscape_briefings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start              DATE NOT NULL,
  period_end                DATE NOT NULL,
  generated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  body_markdown             TEXT NOT NULL,
  metrics_jsonb             JSONB NOT NULL,           -- structured counts: channels added/removed, top tags, geo distribution
  UNIQUE (period_start, period_end)
);
```

### Types file
`src/services/identity/types.ts` — TS interfaces matching every table.

**Test bar for I-P1:** migrations idempotent; CHECK constraints enforced; FK cascades correct.

---

## I-P2 — Active-threats service + scorer hooks

`src/services/identity/activeThreats.ts`:
```ts
export async function lookupThreat(
  kind: ThreatKind,
  value: string
): Promise<ActiveThreatHit | null>;

export async function recordThreat(input: {
  kind: ThreatKind;
  value: string;
  severity: ThreatSeverity;
  provenance: string;
  context?: string;
  geo_tag?: string;
  expires_at?: Date;
}): Promise<void>;

export async function ingestThreatBatch(threats: ThreatInput[]): Promise<{ inserted: number; updated: number }>;
```

Hot path is `lookupThreat` — Live / SMS / Email scorers call this per scan. Sub-ms by hitting the partial index.

**Scorer wiring:**
- `src/services/live/liveScorer.ts` — on inbound call, lookup caller phone in active_threats. Hit → score boost.
- `src/services/sms/smsScorer.ts` — on inbound text, lookup sender phone. Hit → verdict bump.
- `src/services/email/emailScorer.ts` — on inbound email, lookup sender email + sender host. Hit → verdict bump.

Each scorer also surfaces the threat context in its alert payload so iOS can render the "Identity Shield context" footer.

**Test bar:** active_threats lookups respect expiry; scorer integrations exercise hit + miss paths; cross-user data isolation (active_threats is global; no per-user filter needed; verify no per-user data leaks in provenance strings).

---

## I-P3a — Enzoic + HIBP ingest worker (PARALLEL with P3b, P3c)

`src/workers/identityShieldIngest.ts`:

**HIBP path:** already partially exists from Email Shield. Extend to populate `identity_breaches` + create `identity_breach_findings` rows per match.

**Enzoic path:** per-user-monitor check on schedule (emails daily, phones weekly, SSN-hash monthly). Hash-based — never sends plaintext SSN.

Worker runs hourly (HIBP delta) + nightly (Enzoic batch checks).

**Test bar:** sync handles HIBP 404s gracefully; Enzoic rate-limit-respecting; idempotent re-runs don't duplicate findings.

---

## I-P3b — Telegram chatter listener (PARALLEL — scaffold ok)

`src/workers/telegramChatterListener.ts`:

Standalone Node process; not run inside the main API container (network shape differs).

**Architecture:**
- Reads `threat_intel_channels` where status='active' AND source_kind='telegram'.
- For each channel, joins via Telegram bot account (rotating pool of 3–5 accounts loaded from env).
- Reverse-polls message history every N minutes (Telegram doesn't push to bots unless they're admin).
- Per message: LLM classifier extracts artifacts + intent + confidence.
- Confirmed artifacts (high confidence) → `active_threats` INSERT with provenance `telegram_channel:<id>:<message_id>`.

**Scaffold-OK semantics:** if `threat_intel_channels` is empty (Jesiah hasn't loaded seed yet), worker idles. No-op is safe. Once Jesiah loads channels via admin UI, worker picks them up on next poll cycle.

**Bot-account ops:**
- Env: `TELEGRAM_BOT_ACCOUNT_1_API_ID`, `_HASH`, `_PHONE` × 5
- Burner SIMs sourced separately, rotated quarterly
- Account-ban detection: if a bot fails session-restore, mark it dead, fail over to the next, alert admin

**Test bar:** classifier integration tests with fixture messages (sample scammer chatter snippets); active_threats insert verified; account-failover unit test; empty-channel-list scenario doesn't crash.

---

## I-P3c — Darknet market crawler (PARALLEL — scaffold ok)

`src/workers/darknetMarketCrawler.ts`:

Also a standalone process. Runs on a separate VPS provider (Hetzner) with Tor proxy.

**Architecture:**
- Reads `threat_intel_channels` where status='active' AND source_kind='darknet_market'.
- For each market, daily Tor crawl of credential-dump listing pages.
- Parser pulls listing metadata + sample fields (publicly displayed first-N-rows preview).
- Hash sample emails/phones → match against `identity_monitors`.
- Match → `identity_breach_findings` INSERT with provenance `darknet_market:<id>:<listing_id>`.

**Tor infra:** 3 exit nodes on Hetzner, rotation. Crawler is **observer only** — never engages, never bids, never buys.

**Scaffold-OK semantics:** same as P3b. Empty market list = idle worker.

**Test bar:** parser unit tests against fixture market HTML; hash-match logic correct; Tor failover; rate-limit per market (don't get banned).

---

## I-P4 — Routes

`src/routes/identityShield.ts`:

| Route | Auth | Purpose |
|---|---|---|
| `GET  /v1/identity-shield/monitors` | Pro | List user's monitored identifiers |
| `POST /v1/identity-shield/monitors` | Pro | Add a monitor (auto-validates kind, hashes SSN/DOB server-side from one-time-plaintext-in-request, never stored) |
| `DELETE /v1/identity-shield/monitors/:id` | Pro | Remove |
| `GET  /v1/identity-shield/findings` | Pro | List breach findings (paginated, filterable by severity + acknowledged) |
| `POST /v1/identity-shield/findings/:id/acknowledge` | Pro | Mark seen |
| `POST /v1/identity-shield/findings/:id/remediate` | Pro | Mark remediation complete |
| `GET  /v1/identity-shield/threats/near` | Pro | Active-threats count scoped to user's geo (for dashboard counter) |
| `GET  /v1/identity-shield/digest/preview` | Pro | What today's digest would say |

**Test bar:** every route 401 without auth, 402 without Pro, 404 on cross-user IDs. SSN/DOB request bodies hashed on receive, plaintext never persisted (assert by reading the DB row after insert and confirming hash format).

---

## I-P5 — Dashboard tile + push digest scheduler

Two parts:

**Dashboard tile:** new key in `/v1/stats/summary` response:
```json
"identity_shield": {
  "monitors_active": 4,
  "new_findings_7d": 3,
  "active_threats_near_user_30d": 12,
  "active_threats_delta_7d": 3
}
```

**Push digest scheduler:** `src/workers/identityShieldDigest.ts`:
- Daily push: "AegisDial blocked X scams aimed at people with leaked data like yours yesterday."
- Weekly push: "We're watching N data points. Y new breaches this week. Z active scammers near you."
- Per-user opt-out flag in user_settings; defaults to daily for engaged users, weekly for low-engagement.

**Test bar:** stats payload includes new keys; push generation idempotent (running twice in one day = one push); opt-out respected.

---

## I-P6 — AI threat-landscape meta-analyst

`src/services/identity/threatLandscapeAnalyst.ts`:

**Daily run:**
- Reads last 24h of classified Telegram messages.
- LLM extracts cross-references ("join @newchannel" / "listing on freshmarket.onion") → populates `threat_intel_candidates` if not already a known channel.
- Re-classifies active channels by yield (classified_message_count_7d update).
- Flags channels with yield <5/week as candidate-for-removal.
- Re-tags channels by current content distribution (carding → otp_bot pivot detection).

**Quarterly run:**
- Writes `threat_landscape_briefings` row — auto-generated markdown report.

**Admin surface:**
- `GET /v1/admin/intel/candidates` — pending candidates with rationale + score.
- `POST /v1/admin/intel/candidates/:id/approve` — promotes to `threat_intel_channels` with status='active'.
- `POST /v1/admin/intel/candidates/:id/reject` — closes out with decision='rejected'.
- `GET /v1/admin/intel/briefings/latest` — latest briefing markdown.

**Test bar:** candidate dedupe (don't re-discover the same channel daily); rationale JSONB shape; approve/reject state transitions; briefing generation deterministic given fixed input.

---

## I-P7 — Admin dashboard

`src/routes/adminIdentityShield.ts`:

- `GET /v1/admin/identity-shield/summary` — monitors active, findings 7d/30d, active_threats by severity, intel ingest health
- `GET /v1/admin/identity-shield/breaches-timeline` — breach surfaces per day 30d
- `GET /v1/admin/identity-shield/active-threats-distribution` — by severity + provenance
- `GET /v1/admin/identity-shield/intel-source-health` — per-channel: messages classified 7d, active_threats produced 7d, last poll timestamp; per-market: listings parsed 7d, findings produced 7d, last crawl timestamp
- `GET /v1/admin/intel/candidates` (from P6)
- `GET /v1/admin/intel/briefings/latest` (from P6)

**Test bar:** all routes 401 without bearer; aggregate-only; time-bounded.

---

## I-P8 — Adversarial review

Verification agent reads everything, looking for:
- SSN/DOB plaintext leakage (server, client, logs)
- Cross-user data leakage via `active_threats` provenance strings
- Telegram bot account compromise blast radius (one banned account shouldn't expose user data)
- Tor crawler operational hygiene (no engagement, no buying, observer-only)
- Defamation surface (calling a phone "confirmed_scammer" needs evidence trail; can the admin export it?)
- Push notification fatigue (digest dedupe, opt-out respected)
- LLM-prompt-injection through harvested Telegram messages (treat as untrusted content)
- Active-threats poisoning (can a malicious recovery case insert a popular phone number as "confirmed_scammer"? — needs guardrails)

---

## I-P9 — E2E test + runbook + commit

`test/identityShieldScenarioE2E.test.ts`:
1. User registers a monitor on email + phone
2. HIBP ingest finds the email in a new breach → finding row + push fires
3. Telegram listener observes the user's phone advertised in a scammer-services channel → active_threats row + finding
4. Live Shield call from that phone → score boost + alert footer shows "Identity Shield context: this number was advertised in a scammer-services channel 2 hours ago"
5. Stats summary reflects the surfaces

`docs/IDENTITY_SHIELD_OPERATOR_RUNBOOK.md`: env vars (HIBP_API_KEY already exists, add Enzoic creds, Telegram bot fleet, Tor proxy fleet, OpenAI/Anthropic key for classifier), cutover playbook, intel-source onboarding workflow, retention model, legal disclaimers, observer-only policy.

Commit: "Identity Shield I-P1 through I-P9 — Pro-tier pre-incident intel + AI-analyst-curated scammer-chatter".

---

## Open / blocked

- **Seed channel/market list.** Jesiah delivers tomorrow. NOT a code blocker — empty table is valid; workers idle until populated.
- **Burner SIMs.** Order ahead of I-P3b launch.
- **Hetzner Tor proxy VPS.** Provision ahead of I-P3c launch.
- **Enzoic API contract.** Need account + key before I-P3a.
- **Legal sign-off on Tor + Telegram observer posture** before prod cutover, not commit.
