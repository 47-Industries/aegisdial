# AegisDial — Backend Handoff

> ⚠️ **Hosting section is stale.** This doc lists "Hosting: Fly.io" and
> describes `fly.toml` / `scripts/setup-fly-secrets.sh`. Production is on
> **Railway** (single platform for app + Postgres + Redis). The
> `fly.toml` may still live in-repo as archaeology, but it's not the
> source of truth — Railway's UI is. iOS API base is
> `https://aegisdial-api-production.up.railway.app`. Everything outside
> the hosting paragraphs (Fastify shape, schema, routing, auth, dual-write
> pattern, etc.) is still accurate.

This document is the single source of truth for getting a new engineer productive on the AegisDial backend in under a day. Read top to bottom before touching code.

---

## 1. What AegisDial is (in one paragraph)

AegisDial is a consumer phone-call safety iOS app. It is the **first** consumer fraud product to integrate **prevention** (Live Shield caller-ID verdicts, SMS filter, safe-words, breach monitoring, guardian alerts) **AND recovery** (15-minute Recovery Concierge flow that walks a victim through credit freeze → FTC complaint → bank fraud transfer → family notification, plus an AI Companion). Every other product picks one. Truecaller / Hiya / Apple Live Caller ID / RoboKiller do prevention. AARP / FTC do recovery. AegisDial does both, in one app.

## 2. Why it exists (founder narrative — verbatim)

> "I know about this industry. When you're scrolling on Reddit, you can see everything. People are really victims from this. And the reason why we're not free is because we're not here to teach you something. We're here to protect you. The reason why the consumer will be paying for years upon years is because we're here to save them from losing their life savings. A scam is a psychological event."

Use this framing in every external surface (App Store, paywall, landing page, pitch deck). The LTV comp class is **credit monitoring / home alarm / life insurance** (7-year retention), NOT meditation apps.

## 3. Product surface

**Prevention pillars (5):**
1. **Live Shield** — real-time caller-ID verdict + transcript + critical hang-up button
2. **SMS filter** — iOS `ILMessageFilterExtension` + URL reputation via Google Safe Browsing
3. **Safe-words** — guardian challenge flow ("Mom, what's our family safe word?") to defeat AI voice clones
4. **Breach monitoring** — Enzoic email/phone exposure alerts
5. **Guardian alerts** — named guardian gets the first SMS when a critical call happens; broadcast to other guardians

**Recovery surface:**
- **Recovery Concierge** — 52-type catalog of scam recoveries with deterministic FTC + IC3 narratives, evidence locker (PhotosPicker), step tracker
- **AI Companion** — `claude-sonnet-4-6` chat that walks victims through next steps in plain language; voice mode (`AVSpeechSynthesizer` en-US)
- **Triage** — paste-a-text analyzer (free, 3-day anonymous trial) for "is this message a scam?"
- **Bulk crime reports** — when 10+ victims of the same scam in 7d window, generate aggregate FTC/IC3 reports surfaced to all victims

**iOS targets (4):**
- `AegisDial` (main app)
- `CallerIDExtension` (CallKit caller-ID)
- `SMSFilterExtension` (ILMessageFilter)
- `AegisDialWatch` (watchOS companion — End Shield button, status tile)

## 4. Architecture

```
iOS app (4 targets) ──► HTTPS/JSON ──► Fastify backend (Fly.io)
                                       │
                                       ├──► Postgres (Neon) — 35+ migrations, envelope-encrypted PII
                                       ├──► Redis (Upstash) — rate limits, cache, single-flight locks
                                       ├──► Apple StoreKit S2S notifications (subscription state)
                                       ├──► Twilio Lookup V2 (caller enrichment)
                                       ├──► Enzoic (breach monitoring)
                                       ├──► Anthropic (Recovery Companion + verdict refine)
                                       ├──► Google Safe Browsing (SMS URL reputation)
                                       ├──► APNs (push)
                                       ├──► Resend (transactional email — 30d/90d follow-ups)
                                       └──► Sentry + PostHog (observability)
```

**Workers (cron):** `retentionSweeper` (04:07 UTC, sweeps 14 tables), `recoveryFollowupWorker` (T+1d/3d/7d/30d/90d emails), `guardianAlertEscalator` (5-min SMS escalation if guardian doesn't ack).

## 5. Tech stack

- **Runtime:** Node.js 22 (ESM), TypeScript strict
- **Web:** Fastify
- **DB:** Postgres (Neon serverless), `node-postgres` driver, hand-rolled migrations
- **Cache/queue:** Redis (Upstash), `ioredis`
- **Auth:** JWT (HS256), Sign-in-with-Apple, email/password
- **Crypto:** AES-256-GCM via Node `crypto`, see `src/lib/crypto.ts`
- **Hosting:** Fly.io (`aegisdial` app), `fly.toml` at root
- **Tests:** `node --test` (built-in), 111/111 passing
- **CI:** typecheck + tests + migration syntax (see `.github/workflows` if present)

## 6. Repo layout

```
src/
  server.ts              — Fastify bootstrap, CORS=false (native-iOS-only)
  routes/                — HTTP handlers (auth, recovery, family, breach, liveShield, ...)
  services/              — Domain logic (guardianAlerts, breachScan, recoveryCompanion, ...)
  workers/               — Cron jobs
  lib/                   — Shared utilities (crypto, jwt, apns, stripeVerify, appleVerify, ...)
db/
  migrations/            — 35+ numbered SQL files; run via `npm run migrate`
test/                    — One file per route/service
docs/                    — Internal design docs
legal/                   — Privacy policy + Terms HTML (deploy to aegisdial.com/legal/)
marketing/               — Landing page assets
scripts/
  setup-fly-secrets.sh   — One-shot Fly secrets uploader
.env.example             — Local dev template (safe to commit)
.env.production.template — Production template (no real secrets, all TODOs)
fly.toml                 — Fly app config (PORT=3000 — DO NOT override via secret)
TODO.md                  — Phase 1–5 punch list, source of truth for what's left
DEPLOY.md / DEPLOY_PLAYBOOK.md — Pre-TestFlight runbook
LAUNCH_CHECKLIST.md      — Day-of launch checklist
MARKETING.md             — Channel strategy
```

## 7. Local setup

```bash
# Prerequisites: Node 22+, Postgres 15+, Redis 7+ (or use docker-compose)
cd ~/aegisdial-backend
cp .env.example .env
# fill in DATABASE_URL, REDIS_URL, JWT_SECRET, API_SHARED_SECRET, DATA_ENCRYPTION_KEY

# Generate dev secrets
echo "JWT_SECRET=$(openssl rand -base64 36)" >> .env
echo "API_SHARED_SECRET=$(openssl rand -base64 36)" >> .env
echo "DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env

npm install
npm run migrate        # run all SQL migrations
npm test               # 111/111 should pass
npm run dev            # Fastify on PORT (default 3000)
```

`docker-compose.yml` provides Postgres + Redis if you don't have them local.

## 8. Environment variables — what each does

See `.env.production.template` for the full list with comments. Required for prod boot:

| Var | Purpose | Where to get |
|---|---|---|
| `DATABASE_URL` | Postgres | Neon dashboard |
| `REDIS_URL` | Cache + rate limit | Upstash console |
| `JWT_SECRET` | Auth token signing | `openssl rand -base64 36` |
| `API_SHARED_SECRET` | Bearer for `/admin/*` routes | `openssl rand -base64 36` |
| `DATA_ENCRYPTION_KEY` | **PII envelope encryption KEK** | `openssl rand -base64 32` — **back up in 1Password BEFORE first user signs up. Loss = unrecoverable data loss.** |
| `APPLE_CLIENT_ID` / `APPLE_BUNDLE_ID` | Apple sign-in + StoreKit | `com.aegisdial.app` |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_KEY_P8` | Push | Apple Developer → Keys |
| `ANTHROPIC_API_KEY` | Recovery Companion | console.anthropic.com |
| `RESEND_API_KEY` | Transactional email | resend.com |
| `SENTRY_DSN` / `POSTHOG_API_KEY` | Observability | sentry.io / posthog.com |

Optional but recommended: `TWILIO_ACCOUNT_SID/TOKEN`, `ENZOIC_API_KEY/SECRET`, `GOOGLE_SAFE_BROWSING_API_KEY`, `STRIPE_SECRET_KEY/WEBHOOK_SECRET`.

## 9. Security model (READ THIS BEFORE TOUCHING ANY PII)

### Envelope encryption
- AES-256-GCM via `src/lib/crypto.ts`
- Wire format: `v1:<iv_b64>:<tag_b64>:<ct_b64>`
- KEK is `DATA_ENCRYPTION_KEY` (32-byte base64), never stored in DB
- Startup guard refuses to boot if dev-default key is active in prod
- **Why:** A Postgres snapshot leak (Neon PITR, pg_dump) yields ciphertext only. KEK never hits the DB — avoids pgcrypto leak-via-dump surface.

### Encrypted columns (as of 2026-04-19)
- `monitored_identifiers.display_value_ct`
- `recovery_evidence.payload_ct`, `recovery_sessions.{description_ct, scam_e164_ct, amount_lost_cents_ct, recovered_cents_ct, notes_ct}`
- `recovery_companion_messages.content_ct`
- `recovery_outcomes.{notes_ct, step_feedback_ct}`
- `transcript_events.text_ct`
- `scam_phrase_hits.context_ct`
- `support_tickets.{body_ct, email_ct}`
- `family_contacts.display_name_ct` (dual-write w/ plaintext for liveShield matching) + `notes_ct` (ct-only)

### Plaintext by design or deferred
- `users.email`, `users.phone_number` (deferred — needs hash column for lookups)
- `family_contacts.phone_e164` (deferred — `liveShield.ts` needs plaintext for `WHERE phone_e164 = $1` until a `phone_e164_hash` migration ships)
- `sms_classifications.sender` (acceptable — usually shortcodes)

### Rules
- **Any new PII write** → `encryptString` / `encryptJSON`
- **Any new PII read** → `readMaybeEncrypted` / `readMaybeEncryptedJSON` (tolerates pre-migration rows)
- **Pattern reference:** `src/routes/recovery.ts`

### Apple StoreKit JWS binding (migration 030)
- `users.app_account_token UUID` generated server-side, returned via `/subscription/status`
- iOS sets it via StoreKit `Product.purchase(options: [.appAccountToken(uuid)])`
- `/subscription/apple/verify` rejects (403) if JWS appAccountToken ≠ caller's column
- 409s if another user already owns the `originalTransactionId`
- Allowlists subscription SKUs via `planForProductId()`

### Data retention (daily 04:07 UTC sweeper, 14 tables)
- `call_sessions` 90d, `transcript_events` 30d
- `recovery_companion_messages` 30d, `recovery_evidence/outcomes/sessions` 730d
- `phone_lookups` uses `expires_at`
- `guardian_alerts` 365d, `breach_alerts` 365d, `sms_classifications` 90d, `url_reputations` 7d
- `metric_counters` 30d (col `bucket`), `analytics_events` 180d, `email_messages` 365d

### Other controls
- **CORS:** `origin: false` (native-iOS-only API)
- **Age gate:** 13+ (COPPA safe margin), `users.dob_year`, enforced at email signup + new Apple signups
- **Data export:** `GET /v1/users/me/export` returns decrypted JSON dump, biometric-gated in iOS, 3/hr rate limit
- **Rate limits:** global 300/min + per-route limits (see `src/routes/*` — support, smsClassify, family, recovery)
- **Apple JWS binding:** see migration 030 above
- **Webhook signature verification:** Stripe (`src/lib/stripeVerify.ts` pinned to `2026-03-25.dahlia`), Apple (`src/lib/appleVerify.ts`)
- **Webhook routes bypass rate-limit** — Stripe 3-day + Apple 60-day retry storms must not be silently dropped

## 10. Pricing (LOCKED 2026-05-12 — supersedes the 2026-04-19 tier)

| SKU | Price | Lines | Product ID |
|---|---|---|---|
| Pro Monthly | **$49.99/mo** | 3 | `com.aegiadial.ios.pro.monthly` |
| Pro Annual | **$399/yr** | 3 | `com.aegiadial.ios.pro.yearly` (save $200 vs monthly) |
| Recovery Session (one-time) | **$149** | 1 | `com.aegiadial.ios.recovery.session` (NON-CONSUMABLE, grants **14-day Pro** on verify) |
| Recovery Concierge Monthly | **$99/mo** | 1 | `com.aegiadial.ios.recovery.monthly` (dedicated agent + priority) |
| Recovery Concierge Yearly | **$899/yr** | 1 | `com.aegiadial.ios.recovery.yearly` |

**Deprecated (existing subs honored, NOT offered in active paywall):**

| SKU | Price | Lines | Product ID |
|---|---|---|---|
| Pro Family+ | $69.99/mo | 5 | `com.aegiadial.ios.pro.family_plus.monthly` — mark "not available for new purchases" in ASC. No replacement 5-line tier yet. |

The $149 Recovery Session is the **wedge SKU** — backend grants 14-day Pro on verify, paywall offers it next to "$49.99/mo" as a "just need help once" option for new users. (Was $99 / 30-day pre-2026-05-12.)

## 11. Positioning (front-door vs side-door)

**Front door** (App Store, landing page, paywall, paid ads, VC pitch): lead with the integrated "stop the call AND walk you through it" story. Both pillars equal weight. Headline: *"Stop the call. And if one ever lands, we walk you through it. Nobody else does both."*

**Side door** (SEO landing pages targeting "I just got scammed", r/Scams outreach, AARP partnership): lead with **Recovery** — high-intent victim search volume, structurally undefendable by Truecaller/Hiya (their ad-supported model can't justify building it).

**Cold paid ads**: lead with **Live Shield prevention** — cold users want to avoid scams, not recover from them.

**In-app:** HomeView shows Live Shield + Recovery as twin hero cards, NOT one over the other.

Do **not** demote Live Shield in front-door surfaces. Do **not** lead with Recovery on App Store / paid ads. Do **not** pitch as "AI-powered scam recovery concierge" anywhere a cold user or investor sees it.

## 12. Status

**Code-complete since 2026-04-19.** 111/111 tests passing, typecheck clean, two full audit + hardening passes (~56 critical/high fixes). What's left is **external work**:

1. Apple Developer Program enrollment ($99/yr)
2. App Store Connect — create app record + subscription products at the 4 prices above
3. Fly.io credit card + secrets push (`scripts/setup-fly-secrets.sh`)
4. **Back up `DATA_ENCRYPTION_KEY` in 1Password** (irreversible if lost)
5. Run migrations 030–040 against prod Neon
6. Domain (`aegisdial.com` + `.ai/.io/.app` defensively) at Cloudflare Registrar
7. DNS → Fly app
8. Privacy policy + Terms published at `aegisdial.com/legal/`
9. First Mac Xcode build (M1+, Xcode 16+) — expect 5–20 compile issues
10. App icon 1024×1024 (Fiverr ~$100)
11. TestFlight Internal → External

**See `TODO.md` at repo root for the live punch list organized by Phase 1–5.** That file is authoritative — if this HANDOFF.md and TODO.md ever disagree, trust TODO.md.

**See `DEPLOY_PLAYBOOK.md` for the pre-TestFlight runbook in execution order.**

## 13. Service accounts (all on `aegisdial@outlook.com`)

| Service | Purpose | Status |
|---|---|---|
| Fly.io | Hosting | Live — needs CC for prod deploy |
| Neon | Postgres | Live |
| Upstash | Redis | Live |
| Google Cloud | YouTube API + Safe Browsing | Live |
| Apple Developer | iOS distribution | Not enrolled (action required) |
| Anthropic | Recovery Companion LLM | Need API key |
| Twilio | Lookup V2 + SMS escalation | Need account |
| Enzoic | Breach monitoring | Need account |
| Resend | Transactional email | Need account |
| Sentry | Error tracking | Need account |
| PostHog | Product analytics | Need account |
| Stripe | Web subscription backup | Need account |

## 14. Known intentional tech debt (NOT launch blockers)

- App Attest server-side verification (currently accepts silently)
- Family+ → Pro downgrade: shrink capacity + evict 4th/5th members (deprecated tier 2026-05-12, but legacy subs still need a path)
- `phone_e164` encryption (needs hash column for liveShield lookups)
- Per-user LLM budget (current guard is per-instance only)
- Worker drain on SIGTERM via AbortController
- Stagger cron workers to avoid thundering Neon
- Stripe SDK version rotation discipline (when bumping, update `STRIPE_API_VERSION`)

See "Tech-debt / nice to have" in `TODO.md` for the full list.

## 15. Out of scope (explicitly cut by founder)

- **No insurance rider.** Reasoning: avoids moral hazard, state surplus-lines filings, $48/user/yr COGS. Recovery Concierge is the substitute.
- **No human hotline.** AI-first for cost + 24/7 coverage. No BPO partner.
- **No 5-line default.** Pro plan is 3 lines, full stop. Family+ ($69.99, 5 lines) was the 5-line option but is deprecated 2026-05-12 — no replacement tier yet. New 5-line households are not currently supported on the active paywall.
- **No free tier.** Scams are a psychological event, not a utility.

## 16. Where to find more

- `TODO.md` — punch list (live)
- `DEPLOY.md` + `DEPLOY_PLAYBOOK.md` — production deploy
- `LAUNCH_CHECKLIST.md` — day-of launch
- `MARKETING.md` — channel strategy
- `docs/` — design docs
- `legal/` — privacy + ToS
- iOS repo: `aegisdial-ios` (separate GitHub repo, see its `HANDOFF.md`)

---

**Stewardship rule:** Treat this as shippable. Do not add new features unless explicitly asked. If a finding smells like "feature" not "fix", push it to Phase 2 in TODO.md.
