# Identity Shield — Operator Runbook

**Audience:** anyone deploying, troubleshooting, or auditing Identity Shield in prod or staging.
**Prereq:** Migrations 068–076 applied; `identityShieldRoutes`, `adminIdentityShieldRoutes`, `statsRoutes`, `identityShieldIngest`, `telegramChatterListener`, `darknetMarketCrawler`, and `threatLandscapeAnalyst` registered in `src/server.ts`.

Identity Shield is Pro-only. Most of its surface is graceful-degrading — the only HARD env-var requirement is the database. Every paid feed (HIBP, Enzoic) and intel source (Telegram, Tor) is optional at the env layer; the catalog sync still runs against the public HIBP catalog endpoint with no key, the per-user breach scan idles cleanly when Enzoic creds are missing, and the chatter listener / darknet crawler idle gracefully when their bot fleet / Tor proxy are unconfigured. The system never crashes for missing creds — it just runs less rich.

---

## 1. Mental model

Identity Shield is built around two halves that meet in `active_threats`:

| Half | Surface | What it does | Dependencies |
|---|---|---|---|
| **Pre-incident intel** | `identityShieldIngest`, `telegramChatterListener`, `darknetMarketCrawler` | Watch the user's identity perimeter (email + phone + SSN-hash + DOB-hash + name+address-hash); observe public scammer chatter + darknet listings; populate `identity_breaches`, `identity_breach_findings`, `active_threats` | HIBP / Enzoic API + Telegram bot fleet + Hetzner Tor proxy + Anthropic API for the classifier |
| **Cross-shield enrichment** | `lookupThreat()` in `activeThreats.ts` — read on every Live/SMS/Email scan | Live/SMS/Email scorers consult `active_threats` per scan; on hit, verdict scores boost and the iOS alert footer renders "Identity Shield context" copy | Same `active_threats` table the intel half writes into |

The AI-as-analyst wedge sits on top:

| Surface | What it does | Triggers |
|---|---|---|
| **`threatLandscapeAnalyst`** | Reads classified-artifact context strings + cross-references; surfaces NEW candidate channels for Jesiah's approval queue; flips dormant channels; re-tags capabilities; writes quarterly briefings | Daily cron (discover + dormancy + retag), quarterly cron (briefing) |
| **Admin candidate queue** | `/v1/admin/intel/candidates` — Jesiah's 15-minute-daily review surface; approve → channel promoted into `threat_intel_channels` with `status='active'` | Read on demand; mutate via approve/reject endpoints |

**Observer-only legal posture is architectural, not aspirational.** The Telegram listener has no `sendMessage()` surface — it only exposes `getMessages()`. The darknet crawler routes every request through `fetchListingPage()` which hard-codes `GET` and runs a boot-time self-test that throws on any non-GET verb. There is no path from AegisDial code into any market or channel that posts, replies, joins, bids, or buys.

---

## 2. Required env vars

Set on Fly via `fly secrets set ... -a <app>`. Everything below is optional unless flagged REQUIRED — the system degrades gracefully when an optional feed is unset.

```bash
# HIBP — shared with Email Shield; identity_shield reuses the key for
# both per-user scans and (less critical) the hourly catalog sync.
# Without this, the catalog sync still works (public endpoint, no key)
# but per-user findings stop accruing.
fly secrets set HIBP_API_KEY=... -a <app>

# Enzoic — per-user credential-exposure scan. Requires BOTH key and
# secret to be set; either missing = the daily Enzoic batch is a no-op
# with a single startup log line.
fly secrets set EMAIL_SHIELD_ENZOIC_API_KEY=... -a <app>
fly secrets set EMAIL_SHIELD_ENZOIC_SECRET=... -a <app>

# Optional per-day cost cap on the Enzoic batch. When set, the scanner
# shuffles the user list and samples only the first N users that day.
# Over a 7-day window every user is sampled at least once at the
# default sub-cap; set this to ~5000 for a 35k-user base if cost
# pressure builds. Unset = scan everyone every day.
fly secrets set ENZOIC_DAILY_USER_CAP=5000 -a <app>

# Telegram bot account fleet — 5 burner-SIM-backed accounts in
# rotation. Each account requires all THREE of (API_ID, API_HASH,
# PHONE) populated; SESSION is optional (gramjs auto-creates one on
# first connect). A partially-populated fleet works (2-3 accounts is
# acceptable headroom against per-account rate limits); zero accounts =
# the listener idles cleanly.
fly secrets set TELEGRAM_BOT_ACCOUNT_1_API_ID=... -a <app>
fly secrets set TELEGRAM_BOT_ACCOUNT_1_API_HASH=... -a <app>
fly secrets set TELEGRAM_BOT_ACCOUNT_1_PHONE=+1555... -a <app>
fly secrets set TELEGRAM_BOT_ACCOUNT_1_SESSION=... -a <app>
# ... repeat for _2 through _5

# Hetzner Tor SOCKS5 proxy — REQUIRED to enable the darknet crawler.
# Missing = the crawler idles. Production posture is 3 Tor exit nodes
# behind a SOCKS5 frontend with rotation; the env vars below point at
# the frontend.
fly secrets set DARKNET_CRAWLER_TOR_SOCKS5_HOST=... -a <app>
fly secrets set DARKNET_CRAWLER_TOR_SOCKS5_PORT=9050 -a <app>

# Anthropic — REQUIRED for the per-message Telegram classifier AND
# the daily threat-landscape meta-analyst. Without this, the listener
# still polls but every message is dropped at the classifier boundary
# (single startup log line), and the analyst's discovery pass returns
# 0 candidates per day. Shared with Live Shield + SMS Shield v3 stack.
fly secrets set ANTHROPIC_API_KEY=... -a <app>
```

**No secrets bleed into logs.** HIBP / Enzoic / Anthropic keys are pulled from `config.ts` and never echoed by `captureError` (each capture-call passes only the component name + non-sensitive context). The Tor proxy host/port is operationally sensitive but not a credential; it appears in startup logs intentionally so the operator can confirm posture from the first line.

---

## 3. Admin dashboards

All routes are bearer-auth via `requireBearer` (shared secret = `$API_SHARED_SECRET`). All time-bounded; aggregate-only; the only PII-shaped surface is `active-threats-distribution?include_values=true` which is gated behind an explicit opt-in query param (audit-logged).

| Endpoint | Returns |
|---|---|
| `GET /v1/admin/identity-shield/summary` | Active monitors total + per-kind, findings 7d+30d by severity, active_threats by severity (live snapshot), intel-source heartbeat (last sync per HIBP/Enzoic/Telegram/Darknet) |
| `GET /v1/admin/identity-shield/breaches-timeline` | Per-day 30d buckets: `{date, findings_count, by_severity}` |
| `GET /v1/admin/identity-shield/active-threats-distribution[?include_values=true]` | Live `active_threats` snapshot: by_severity + by_provenance_prefix; sample `threat_value`s ONLY when `include_values=true` (capped 5 per bucket, audit-logged) |
| `GET /v1/admin/identity-shield/intel-source-health` | Per-channel/per-market: `status, last_message_observed_at, classified_message_count_7d, active_threats_produced_7d` |
| `GET /v1/admin/intel/candidates[?status=pending\|approved\|rejected][&source_kind=telegram\|darknet_market]` | AI-discovered candidate queue, ordered by candidate_score DESC |
| `POST /v1/admin/intel/candidates/:id/approve` | Promote → `threat_intel_channels` row with status=active; transactional; 409 on already-decided / collision |
| `POST /v1/admin/intel/candidates/:id/reject` | Terminal-state rejection; optional `reason` stored on rationale JSONB |
| `GET /v1/admin/intel/briefings/latest` | Latest quarterly briefing markdown + structured metrics; digit-runs + email-shaped tokens redacted in transit (I-M4 defense-in-depth) |
| `GET /v1/admin/intel/briefings[?limit=N]` | Briefing index (id + period tuple); body fetched separately |
| `GET /v1/admin/intel/briefings/:id` | One briefing by id; same redaction pass as `/latest` |

Quick health probe:

```bash
curl -H "Authorization: Bearer $API_SHARED_SECRET" \
  https://<app>.fly.dev/v1/admin/identity-shield/summary | jq .
```

200 with non-empty counters = migrations applied + admin routes wired. Any 5xx = check `server.ts` registration order or the migration ledger.

---

## 4. Cutover playbook

### Stage A — migrations

```bash
psql $DATABASE_URL -f db/migrations/068_identity_monitors.sql
psql $DATABASE_URL -f db/migrations/069_identity_breaches.sql
psql $DATABASE_URL -f db/migrations/070_identity_breach_findings.sql
psql $DATABASE_URL -f db/migrations/071_active_threats.sql
psql $DATABASE_URL -f db/migrations/072_threat_intel_channels.sql
psql $DATABASE_URL -f db/migrations/073_threat_intel_candidates.sql
psql $DATABASE_URL -f db/migrations/074_threat_landscape_briefings.sql
psql $DATABASE_URL -f db/migrations/075_user_settings_identity_digest.sql
psql $DATABASE_URL -f db/migrations/076_telegram_artifact_pending_review.sql
```

All idempotent (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`). Re-running is a no-op.

### Stage B — env vars

Set the env vars in §2 in the order you have them. The system will run with NONE of them set — the worker cron still ticks, the catalog sync runs against the public HIBP endpoint (no key required), and the routes return empty datasets. You add each feed when its operational dependency is ready:

- HIBP key → unblocks per-user breach findings
- Enzoic creds → unblocks password-dump findings
- Telegram fleet (after SIMs are sourced) → unblocks chatter ingest
- Anthropic key (you already have one for Live Shield v3) → unblocks classifier + meta-analyst
- Tor proxy host/port (after Hetzner provisioned) → unblocks darknet crawler

### Stage C — verify routes

```bash
curl -H "Authorization: Bearer $API_SHARED_SECRET" \
  https://<app>.fly.dev/v1/admin/identity-shield/summary | jq .
```

Expected on fresh deploy: 200 with all counters zero. The `intel_ingest_health` block reports `null` for any source that hasn't produced a heartbeat metric yet.

### Stage D — order burner SIMs + register Telegram bot accounts

**Operational task, NOT a code blocker.** AegisDial ships the listener in scaffold mode (zero accounts = idle, no throws). Once SIMs arrive:

1. Acquire 5 burner SIMs (rotate quarterly — see operational checklist below).
2. Register each as a Telegram account via the official mobile flow.
3. Capture `(api_id, api_hash, phone, session_string)` per account from `my.telegram.org`.
4. Set the env triples (§2). Fly restarts the listener on each `fly secrets set`.
5. The first 5-minute poll cycle picks up the accounts; startup log line reports `Telegram listener starting with N bot account(s)`.

**Account-ban handling:** the listener's `FleetRotator` flips an account to "dead" after 2 consecutive session-restore failures. When `liveCount < 2` the operator should rotate fresh SIMs in. The `identity_shield.telegram_bot_health` metric (tagged `account_index` + `alive`) fires per cycle so PagerDuty / dashboard can alert.

### Stage E — provision Hetzner Tor proxy fleet

**Operational task, NOT a code blocker.** AegisDial ships the crawler in scaffold mode (no Tor host = idle, single startup log line). Production posture is 3 Tor exit nodes behind a SOCKS5 frontend with rotation; the env vars in §2 point at the frontend. Until that's wired the crawler scaffold-runs against a stub that returns `{html: '', status: 200}` — every market gets a "successful zero-listing" response and the cycle records zero findings. Same scaffold semantics as the empty channel table.

**Tor TOS reminder:** Fly's TOS does NOT love Tor. Hetzner is the documented choice. See `docs/RECOVERY_AND_IDENTITY_SHIELDS.md §4` for the legal frame.

### Stage F — source initial channel / market seed list

**Jesiah personal curation, NOT a code blocker.** The `threat_intel_channels` table ships empty. Until Jesiah loads the ~80-channel seed list, both the Telegram listener and the darknet crawler idle gracefully. Loading is done either by:

- Admin-side INSERT directly into `threat_intel_channels` for the initial bootstrap (one-time, ~80 rows), OR
- Approving AI-discovered candidates via `POST /v1/admin/intel/candidates/:id/approve` once the meta-analyst starts surfacing them.

The curation SOP (`what makes a channel worth tracking`) lives in Jesiah's editorial doc — that's the analyst's system-prompt grounding. Update the SOP, the AI applies it on the next daily pass.

### Stage G — verify ingest health

```bash
curl -H "Authorization: Bearer $API_SHARED_SECRET" \
  https://<app>.fly.dev/v1/admin/identity-shield/intel-source-health | jq .
```

Per-source rows include `last_message_observed_at`, `classified_message_count_7d`, and `active_threats_produced_7d`. A healthy channel after 24h should show non-zero `classified_message_count_7d`. A market should show non-null `last_message_observed_at`. Dormant channels (classified_count_7d < 5) are automatically flipped by the meta-analyst's dormancy sub-pass.

---

## 5. Common failure modes

### HIBP 429 / `reason: rate_limited`

Symptom: `identity_shield.hibp_catalog_sync_failed` metric fires with `reason=rate_limited`; per-user scans return `new_findings: 0`.

Cause: HIBP per-IP rate limit (~1.5s between requests on free tier).

Fix: results are cached 6h on `sha256(email)` (shared with Email Shield's HIBP wrapper). 429s only happen on first-call bursts. If sustained, upgrade the HIBP tier — the per-user scan in `scanAllUsersHibpOnce` iterates sequentially, so a paid tier with 100 req/s headroom eliminates the burst issue entirely.

### Enzoic schema drift

Symptom: `identity_shield.enzoic_schema_drift` metric fires with tag `reason=no_username` or `unknown_username`; expected findings don't surface.

Cause: Enzoic's batch endpoint response shape changed — entries no longer carry a `username` / `query` / `email` field, OR Enzoic returned a username we didn't query.

Fix: this is BY DESIGN the safe path (I-H3 adversarial-review fix). Better to miss findings than mis-attribute them across users. Operator should:

1. Check the Enzoic dashboard for API version changes / deprecation notices.
2. If a contract change is real, extend `EnzoicAccountResponse` in `src/workers/identityShieldIngest.ts` with the new field name.
3. The fallback path (positional pairing) is intentionally not implemented — it was the original cross-user breach vector.

### Telegram bot account banned

Symptom: `identity_shield.telegram_bot_health` metric fires with `alive=false` for a specific `account_index`. Alert when `liveCount < 2` from the per-cycle metric.

Cause: Telegram detected behavioral fingerprint of a non-human account. Causes vary — usually the burner SIM was previously flagged, or the account joined too many channels too fast on first login.

Fix:

1. Rotate the SIM (operational — burner-SIM lifecycle).
2. Regenerate the api_id / api_hash via `my.telegram.org`.
3. Update the env triple for that `_N_` index.
4. Process restart picks up the fresh account on the next poll cycle (the `dead` flag resets on process boot — see `FleetRotator` constructor).

Fleet posture floor: at least 2 live accounts to maintain rotation rhythm. With <2 the `FleetRotator` exhausts on long channel lists and the cycle ends early with `reason: fleet_exhausted`.

### Tor proxy outage

Symptom: `identity_shield.darknet_crawl` metric fires with `reason: network` repeatedly; `darknet_market_backoff` metric advances steps.

Cause: Hetzner outage, Tor exit-node ban, or SOCKS5 frontend died.

Fix: the crawler self-backs-off (1h → 4h → 24h cap). No manual intervention needed for short outages. For sustained outages:

1. SSH the Hetzner VPS; verify Tor service health (`systemctl status tor`).
2. Rotate the exit nodes (the rotation script is documented in the Hetzner runbook, separate doc).
3. Once the SOCKS5 frontend is healthy, the next daily cron pass automatically picks up.

The crawler has NO clearnet fallback — that's the observer-only invariant. Tor down = crawler idles.

### Telegram artifact user-match (I-M3) — operator review queue

Symptom: a row appears in `telegram_artifact_pending_review` with `decision = NULL`.

Cause: A scammer-services channel posted a real user's phone or email as "burner for sale" or in a "fresh dump" message. The listener's I-M3 gate (`findMatchingUserId` in `telegramChatterListener.ts`) caught the user-match BEFORE the artifact reached `active_threats`. The row is held for admin review instead of poisoning the catalog against the user themselves.

Fix path: admin queue review.

1. Inspect the row's `provenance` to trace back to the originating message.
2. Decide:
   - **Legitimate scammer re-use** (rare — the scammer happened to acquire the user's old SIM): mark `decision = 'approved'` and INSERT manually into `active_threats` out-of-band.
   - **Poisoning attempt** (expected outcome): mark `decision = 'rejected'`. No further action — the user's phone/email is NEVER added to `active_threats` from chatter alone.

A v2 of the gate will surface a per-user "someone tried to poison your identifier" notification (UX TBD). For v1 the operator handles it.

### Active-threats poisoning via stale recovery cases

Symptom: a popular phone number (e.g., a customer-service line) appears in `active_threats` with `severity = confirmed_scammer`.

Cause: the recovery observer wrote a `confirmed_scammer` row based on a single attesting case. The I-M5 adversarial-review fix already pins `confirmed_scammer` to NEVER expire and IGNORE caller-provided `expires_at` overrides — that's the write-side defense. Promotion to `confirmed_scammer` from the recovery observer ALSO requires ≥2 distinct attesting cases (validation lives in the recovery observer worker, not in `activeThreats.ts`).

Fix path:

1. Inspect the row's `provenance` (`aegisdial_recovery:<case_id>`) to find the source case.
2. If the case is bogus (refund-scam recovery operation false-positive), reject the case in the recovery admin.
3. The `active_threats` row stays — `confirmed_scammer` is intentionally write-once-permanent (rationale: a victim-attested scam phone is still a scam phone two years later). For genuine retirement, use the admin retirement table (separate operator surface, not the worker write path).

### Quarterly briefing not generated

Symptom: `/v1/admin/intel/briefings/latest` returns 404 `no_briefing_yet` after a quarter boundary.

Cause: the quarterly cron didn't fire, OR the LLM call failed (Anthropic outage / timeout / parse failure).

Fix:

1. Check the cron logs — the quarterly job is part of the analyst worker, not the daily pass.
2. Manually invoke `generateQuarterlyBriefing` via the worker entry point (operator runbook command — TBD as a script in `src/scripts/`).
3. Briefing generation is idempotent on the `(period_start, period_end)` UNIQUE — re-runs are safe.

---

## 6. Retention model

| Table | Retention | Sweeper |
|---|---|---|
| `identity_monitors` | 90 days post soft-delete (`active = FALSE`) | `retentionSweeperIdentityShield` daily |
| `identity_breaches` | Indefinite (global catalog) | Never swept — small dataset, audit-relevant |
| `identity_breach_findings` | 90 days post `remediation_completed_at` | `retentionSweeperIdentityShield` daily |
| `active_threats` | Tier-driven via `expires_at`: informational=30d, caution=90d, warning=365d; **`confirmed_scammer` NEVER expires** | Hard-delete on TTL expiry (NOT soft) |
| `threat_intel_channels` | Indefinite (operational artifact — preserved across status flips so old `active_threats` rows retain provenance attribution) | Never swept |
| `threat_intel_candidates` | Indefinite | Never swept — rejected candidates are the AI's training signal |
| `threat_landscape_briefings` | Indefinite | Never swept |
| `telegram_artifact_pending_review` | FK CASCADE on user delete; admin-decided rows sweepable post-90d | `retentionSweeperIdentityShield` (sweeps decided rows; pending rows preserved) |

The `confirmed_scammer` never-expires rule is load-bearing — it's the only way to keep a victim-attested scam phone flagged across multi-year scammer campaigns. Documented in `db/migrations/071_active_threats.sql` and pinned by I-M5 (`resolveExpiry()` ignores caller-supplied `expires_at` for that tier).

---

## 7. Rate limits

Per-route, per-user. Every Pro route is keyed via `userKeyedLimit` so one user can't starve another. Mirrors the Email Shield pattern.

| Route | Limit | Purpose |
|---|---|---|
| `GET /v1/identity-shield/monitors` | 60/min | iOS list fetch |
| `POST /v1/identity-shield/monitors` | 30/min | Add monitor (hash kinds have a server-side salt-derivation cost — bounded) |
| `DELETE /v1/identity-shield/monitors/:id` | 30/min | Soft-delete |
| `GET /v1/identity-shield/findings` | 60/min | Findings list (with severity + acknowledged filters) |
| `POST /v1/identity-shield/findings/:id/acknowledge` | 30/min | User taps "got it" |
| `POST /v1/identity-shield/findings/:id/remediate` | 30/min | User finished Recovery flow |
| `GET /v1/identity-shield/threats/near` | 60/min | Dashboard tile counter (5-minute response-cache in Redis per-user-per-geo) |
| `GET /v1/identity-shield/digest/preview` | 60/min | Preview the daily-digest body for the Settings → Notifications toggle |

Admin routes are bearer-only (no per-user limit) — operator-scoped traffic is bounded by Jesiah's reviewing cadence, not by request volume.

---

## 8. Privacy posture

| What we store at rest | Where | Notes |
|---|---|---|
| Email address (plaintext) | `identity_monitors.watched_value` | Lowercased canonical form; the user's email is already plaintext in `users.email` |
| Phone E.164 (plaintext) | `identity_monitors.watched_value` | Already plaintext in `users.phone_number` |
| SSN-last-4 (HASHED) | `identity_monitors.watched_value` | `sha256(salt_hex \|\| 'ssn4' \|\| plaintext)` — plaintext NEVER persists |
| DOB (HASHED) | `identity_monitors.watched_value` | `sha256(salt_hex \|\| 'dob' \|\| 'YYYY-MM-DD')` |
| Name+address (HASHED) | `identity_monitors.watched_value` | `sha256(salt_hex \|\| 'na' \|\| 'first last\|zip')` |
| Per-user salt | `identity_monitors.salt_hex` | 32-byte hex; per (user_id, monitor_kind); NEVER returned to client |
| Breach catalog | `identity_breaches` | Global catalog — no per-user data |
| Per-user findings | `identity_breach_findings` | (user_id, monitor_id, breach_id) tuples; no plaintext leakage |
| Active threats | `active_threats` | Attacker artifacts only (scam phone/email/wallet/host); NO per-user PII |
| Telegram pending review | `telegram_artifact_pending_review` | Operator-visible only; never returned on user-facing routes |

What we do NOT store: full SSN (only last-4-hash), DOB plaintext, name+address plaintext, raw Telegram message bodies (we extract artifacts + intent + cross-references and discard the body), raw darknet listing HTML (we extract sample_records and discard the page).

**Hash scheme canonical pin (I-H1, 2026-05-12):**

```
digest = sha256( salt_hex || tag || plaintext )
  where tag ∈ { 'ssn4', 'dob', 'na' }
```

Three call sites use this scheme: `src/routes/identityShield.ts` (the POST /monitors INSERT path), `src/workers/darknetMarketCrawler.ts` (the listing-match path), `db/migrations/068_identity_monitors.sql` (the column comment). Any future scheme change MUST touch all three together or the route → crawler hand-off silently mismatches and every SSN finding goes missing.

**Push notification body is GENERIC.** The digest push and per-finding push never include the user's email, phone, SSN, or any identifier — only counts ("3 monitors, 2 new findings this week"). Per-finding context lands in the APNs `data` payload, rendered only inside the unlocked app — same posture as Email Shield's tamper-alert push.

**Observer-only posture is architectural:**

- Telegram listener: `TelegramClient` interface exposes only `getMessages()`. There is NO `sendMessage()`, `reply()`, or `join()` surface. Adding one is a categorical violation flagged by I-P8 adversarial review.
- Darknet crawler: `fetchListingPage()` hard-codes `method='GET'`. A boot-time self-test throws on any non-GET verb passed via the `_unsafeMethod` test hook — regression surfaces at process start, not in production months later.

**Briefing markdown digit-redaction (I-M4):** the LLM-generated briefing body is supposed to receive only aggregate stats. As defense-in-depth, the admin briefing routes (`GET /v1/admin/intel/briefings/latest` and `:id`) scrub digit-runs of 4+ chars and email-shaped tokens before sending. The redaction count is emitted as a metric — a spike alerts the operator to either a prompt regression or an upstream PII leak.

---

## 9. Operational guarantees (pinned by tests)

| Property | Pinned by |
|---|---|
| SSN/DOB/name+address plaintext NEVER persists; only canonical-scheme hashes land in `identity_monitors.watched_value` | `test/identityShieldRoutes.test.ts` + `test/identityShieldScenarioE2E.test.ts` |
| Telegram user-PII poisoning (I-M3) routes user-matched artifacts to `telegram_artifact_pending_review`, NOT `active_threats` | `test/telegramChatterListener.test.ts` + `test/identityShieldScenarioE2E.test.ts` |
| Enzoic batch pairs by username, not by index — out-of-order / skipped entries don't cross-attribute | `test/identityShieldIngest.test.ts` (I-H3 cases) |
| HIBP key never appears in logs / errors / response | `test/hibpBreachCheck.test.ts` |
| `confirmed_scammer` `active_threats` rows ignore caller-supplied `expires_at` (I-M5 poisoning defense) | `test/identityActiveThreats.test.ts` |
| Darknet crawler observer-only: `fetchListingPage` rejects any non-GET verb (boot-time self-test) | `test/darknetMarketCrawler.test.ts` |
| Darknet hash-match uses canonical sha256(salt \|\| tag \|\| plaintext) scheme (I-H1) | `test/darknetMarketCrawler.test.ts` + `test/identityShieldScenarioE2E.test.ts` |
| Per-user salt isolation — identical SSN plaintext under different salts produces distinct digests | `test/identityShieldScenarioE2E.test.ts` (cross-user isolation case) |
| Briefing body digit-runs + email tokens redacted before admin send (I-M4) | `test/adminIdentityShield.test.ts` |
| Candidate approve is transactional + idempotent (409 on already-decided / channel collision) | `test/adminIdentityShield.test.ts` |
| Cross-shield enrichment: `lookupThreat()` returns max-severity row across multiple provenances for the same artifact | `test/identityActiveThreats.test.ts` |
| Stats summary returns 200 with all zeros when any identity_* table is missing (rolling-deploy state) | `test/statsSummary.test.ts` |
| Admin routes all 401 without bearer | `test/adminIdentityShield.test.ts` |
| Push digest body contains NO per-user PII (no email, no phone, no SSN) | `test/identityShieldDigest.test.ts` + `test/identityShieldScenarioE2E.test.ts` |
| End-to-end happy path: monitors POST → HIBP catalog → per-user scan → darknet match → telegram I-M3 → admin summary → analyst candidate → approve → digest preview → stats | `test/identityShieldScenarioE2E.test.ts` (this file) |

---

## 10. AI-as-analyst flow

The wedge — what makes this product different from Constella / Flashpoint / LifeLock. Captured in `RECOVERY_AND_IDENTITY_SHIELDS.md §12`; operationalized as the daily analyst pass.

```
Daily 03:00 UTC — runDailyAnalystPass():
  ├── discoverCandidatesOnce()
  │     SELECT last-24h active_threats whose context_text mentions
  │     channel handles → LLM extracts cross-references → upsert
  │     into threat_intel_candidates (rationale: analyst_rationales)
  ├── detectDormancyOnce()
  │     UPDATE threat_intel_channels SET status='dormant' WHERE
  │     status='active' AND classified_message_count_7d < 5
  └── retagCapabilitiesOnce()
        Per active channel: LLM reads last-7d artifact context_text
        → returns capability_tags[] + confidence; only persists when
        confidence >= 0.7 (preserves curated state on weak signal)

Quarterly — generateQuarterlyBriefing():
  Aggregates the quarter's metrics (channels added/removed/dormant,
  active_threats produced, top capability_tags, geo distribution) →
  LLM writes the briefing body_markdown → INSERT into
  threat_landscape_briefings on (period_start, period_end) UNIQUE
```

Jesiah's role:

- **Initial seed list** (~80 channels + ~10 markets) — one-time effort.
- **15 min/day reviewing the candidate queue** — approve or reject; ~5-15 candidates per day at steady state.
- **Strategic editorial** — keep the curation SOP fresh; the analyst's system prompt reads from it.
- **Quarterly briefing review** — confirm narrative + sanity-check metrics before the briefing surfaces externally.

What the AI does instead of Jesiah:

- 24/7 message-level classification (Telegram listener — `claude-haiku-4-5`)
- Daily candidate discovery + dormancy detection + capability re-tagging (analyst — `claude-sonnet-4-6`)
- Quarterly threat-landscape briefing generation (same model as analyst)

Cost envelope:

- Per-message classifier: ~$0.0001 per message; ~80 channels × ~20 msg/day × 30 days = ~48k msg/mo → ~$5/mo
- Analyst daily pass: ~$0.15 per pass × 30 days = ~$4.50/mo
- Quarterly briefing: ~$0.50 per generation × 4/year = $2/year

Total LLM cost: ~$10/mo at steady-state. Dominant cost is bot-account SIM rotation (~$50/mo) + Hetzner Tor proxy (~$200/mo).

---

## 11. Phase ledger

| Phase | Surface |
|---|---|
| I-P1 | Migrations 068–074 + service-layer types |
| I-P2 | `active_threats` service + lookupThreat() / recordThreat() / ingestThreatBatch() + Live/SMS/Email scorer wiring |
| I-P3a | Enzoic + HIBP ingest worker (`identityShieldIngest.ts`) |
| I-P3b | Telegram chatter listener (`telegramChatterListener.ts`) — scaffold-OK on empty channel table |
| I-P3c | Darknet market crawler (`darknetMarketCrawler.ts`) — scaffold-OK on empty Tor config |
| I-P4 | `/v1/identity-shield/*` route surface (`identityShield.ts`) |
| I-P5 | Stats summary `identity_shield` tile + push digest scheduler (`identityShieldDigest.ts`) + user_settings.identity_digest_cadence (migration 075) |
| I-P6 | AI threat-landscape meta-analyst (`threatLandscapeAnalyst.ts`) |
| I-P7 | Admin dashboard `/v1/admin/identity-shield/*` + `/v1/admin/intel/*` (`adminIdentityShield.ts`) |
| I-P8 | Adversarial review pass — closed I-H1 (canonical hash scheme), I-H3 (Enzoic username pairing), I-M2 (Enzoic daily cap), I-M3 (Telegram user-PII poisoning defense, migration 076), I-M4 (briefing digit-redaction), I-M5 (active_threats expires_at floor) |
| I-P9 | This runbook + end-to-end scenario test (`test/identityShieldScenarioE2E.test.ts`) |

All on branch `feat/live-shield-v4-phase0`.

---

## 12. Pending production work (operator-flagged)

These are NOT code blockers — the system runs and degrades gracefully without them — but they're what's left before Identity Shield is materially useful in prod.

| Item | Owner | Blocking-for |
|---|---|---|
| Source 5 burner SIMs + complete Telegram bot-account registration | Operations | Telegram listener real ingest (today: scaffold) |
| Provision Hetzner VPS with Tor proxy fleet (3 exit nodes + SOCKS5 frontend rotation) | Operations | Darknet crawler real ingest (today: scaffold against stub fetcher) |
| Source initial channel + market seed list (~80 Telegram channels + ~10 markets) | Jesiah (editorial) | Both workers start producing real `active_threats` rows |
| `bun add telegram` (gramjs) in `package.json` + wire `RealTelegramClient.ensureGramjs()` past the sentinel | Engineering | Telegram listener cutover from scaffold to real ingest |
| `bun add socks-proxy-agent` + swap `stubFetchListingFn` for a SOCKS5-routed undici fetch in `darknetMarketCrawler.ts` | Engineering | Darknet crawler cutover from scaffold to real ingest |
| Hand-tuned market parsers (russian-market, BriansClub, 2easy, Bitify) — fixture-capture pass via Tor required first | Engineering | Higher-precision darknet hash-matches (today: generic regex parser falls back for unknown markets) |
| Curation SOP doc (what makes a channel worth tracking) | Jesiah (editorial) | Analyst's `DISCOVERY_SYSTEM_PROMPT` grounding fully reflects current editorial criteria |
| Counsel review: Tor observer-only posture, Telegram TOS read, defamation-exposure floor on `confirmed_scammer` | Legal (pre-launch) | App Store submission of the Identity Shield surface |
| Operator alerting hookup: PagerDuty / Slack channel on `identity_shield.telegram_bot_health` `alive=false` aggregated `liveCount < 2` | Operations | Bot-fleet outage triage faster than next daily pass |

Every item above is documented; none of them block ship-readiness of the Identity Shield BACKEND. The end-to-end scenario test (`test/identityShieldScenarioE2E.test.ts`) walks the full happy path through real code under stubbed network boundaries — the wiring is correct; what's pending is the operational + editorial layer on top.
