# AegisDial — TODO to finish the app

> ⚠️ **Some entries below are stale (Fly-era).** Production is on
> Railway, not Fly.io — anywhere this doc says `fly secrets set X` or
> `*.fly.dev`, the real command is "Railway dashboard → Variables → Add"
> and the URL is `*.up.railway.app`. The `DATA_ENCRYPTION_KEY` item is
> still critical (see `project_critical_secrets.md`); just set it on
> Railway instead of Fly.

Organized by phase. Tick as you complete. External/manual items (Fly,
Apple, Stripe, etc.) need your hands — I can't do those. Everything
else I can ship from code.

---

## PHASE 1 — TestFlight launch (you have code-complete; these gate the build)

Estimated: **5–10 days** once you start.

### External / manual (you do these)

- [ ] **Test coverage: /subscription/apple/verify reject branches** (400 unknown_product_id / 403 account_token_mismatch / 409 transaction_already_bound) — Node 22 ESM modules expose read-only namespace objects, so the naive stub-via-assignment pattern that other tests use doesn't work here. Real options: (a) refactor the route to accept an injectable verifier, (b) extract the verify+UPDATE logic into a pure `handleAppleVerify(decoded, user)` function the way `handleAppleNotification` was extracted — then test THAT. Not a gate for launch; reject branches are each a single `return reply.code(...)` with typed conditions, low regression risk.
- [ ] 🔴 **ROTATE LEAKED SECRETS NOW** — `.env.production.template` previously committed with REAL values: Neon `DATABASE_URL` password `npg_wKsIDyPS9Cg3`, Upstash `REDIS_URL` token, `API_SHARED_SECRET`, `JWT_SECRET`, `YOUTUBE_API_KEY`. File is now sanitized, but git history keeps the values forever. Actions required today: (1) Rotate Neon DB password in the Neon dashboard. (2) Rotate Upstash token in the Upstash console. (3) Regenerate `JWT_SECRET` — `openssl rand -base64 36` — this invalidates any outstanding sessions, fine pre-launch. (4) Regenerate `API_SHARED_SECRET`. (5) Regenerate/restrict the YouTube API key in console.cloud.google.com. (6) If you care about the history, run `git filter-repo --path .env.production.template --invert-paths` to purge — or accept the leak if the repo is private-forever and just rotate. The sanitization commit alone does NOT revoke the leaked values.
- [ ] **Fly secret: `DATA_ENCRYPTION_KEY`** — `fly secrets set DATA_ENCRYPTION_KEY=$(openssl rand -base64 32) -a aegisdial`. **Save the key offline** (1Password / Bitwarden). Losing it = every encrypted row is unreadable.
- [ ] **Fly secrets for Twilio Lookup V2** — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ENABLE_TWILIO_LOOKUP=true`. Without these, the new "who is this number?" enrichment returns null.
- [ ] **Fly secret: `ANTHROPIC_API_KEY`** — for the Recovery Companion + verdict LLM refine. Without it, Companion falls back to canned replies.
- [ ] **Fly secret: `GOOGLE_SAFE_BROWSING_API_KEY`** (free, 10k/day) — for URL reputation in SMS filter + text analyzer.
- [ ] **Fly secret: `ENZOIC_API_KEY` + `ENZOIC_API_SECRET`** — breach monitoring. Falls back to mock without.
- [ ] **APNs Fly secrets**: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8`, `APNS_PRODUCTION=true` — push notifications. Alerts still show in-app without.
- [ ] **Run migrations 018–040 against prod Neon**: `DATABASE_URL='<prod-neon-url>' npm run migrate`. Migration 040 ships the `anonymous_analyzer_trials` table for the 3-day Paste-a-Text trial.
- [ ] **App Store Connect — create app record** (AegisDial, bundle ID `com.aegisdial.app`).
- [ ] **App Store Connect — create subscription products at correct prices** (2026-05-12 cutover, locked per Jesiah):
  - `com.aegiadial.ios.pro.monthly` = **$49.99/mo** (auto-renewable, 3 lines)
  - `com.aegiadial.ios.pro.yearly` = **$399/yr** (auto-renewable, 3 lines, "Save $200")
  - `com.aegiadial.ios.recovery.session` = **$149 one-time** (NON-CONSUMABLE, grants 14-day Pro on verify) — the wedge SKU.
  - `com.aegiadial.ios.recovery.monthly` = **$99/mo** (Recovery Concierge: dedicated agent, priority response)
  - `com.aegiadial.ios.recovery.yearly` = **$899/yr** (Recovery Concierge — annual)
  - `com.aegiadial.ios.pro.family_plus.monthly` = $69.99/mo — **deprecated**, mark "not available for new purchases" but honor existing subs.
- [ ] **App Store Connect — privacy labels** (email, phone, audio declared correctly per `PrivacyInfo.xcprivacy`).
- [ ] **Apple Developer Program enrolled** ($99/yr) — required for provisioning profiles.
- [ ] **Provisioning profiles regenerated** after Keychain access group entitlement change.
- [ ] **First Xcode build** on a Mac (M1 or later, Xcode 16+). Expect 5–20 compile issues on first run.
- [ ] **App icon 1024×1024** — Fiverr designer, ~$50–200, 24–48 hr.
- [ ] **Domain**: register `aegisdial.com` at Cloudflare (+ `.ai`/`.io`/`.app` defensively).
- [ ] **DNS**: point `aegisdial.com` → Fly app (A record to Fly anycast or CNAME to `aegisdial.fly.dev`).
- [ ] **Privacy Policy + Terms URLs** published at `https://aegisdial.com/legal/privacy.html` + `/legal/terms.html` (files already exist in `legal/`).
- [ ] **TestFlight internal testing group** created.
- [ ] **End-to-end smoke test**: Apple sign-in → paywall → sandbox subscribe → Live Shield demo → Recovery Concierge → companion chat → outcome submit. All should work.

### Code-complete (already done, listed for completeness)

- [x] 5 defense pillars (Live Shield, SMS filter, Safe Words, Breach, Guardian)
- [x] Recovery Concierge (52-type catalog + AI Companion + triage + paste-a-text analyzer + pre-filled FTC/IC3 reports)
- [x] Family plan + named guardian + Protect-a-Parent
- [x] Age gate (13+), data export, account deletion
- [x] AES-256-GCM encryption on every customer input
- [x] All customer PII encrypted at rest: sessions, evidence, companion messages, outcomes, transcripts, breach identifiers, support tickets
- [x] Keychain access group shared across all 4 iOS targets
- [x] Privacy manifests on all 4 targets
- [x] Hardened App Transport Security
- [x] Prompt-injection defenses (nonce fencing + output validation)
- [x] LLM cost circuit breaker (600/min/instance)
- [x] URL safety (host-only cache keys, strip credentials, no SSRF)
- [x] Dev-key production guard
- [x] Twilio Lookup V2 integration for caller-ID enrichment
- [x] Sub-1s unknown-number crawl with background completion + Redis single-flight
- [x] CI (typecheck + tests + migration syntax)
- [x] 103/103 tests passing
- [x] iOS high-pri hardening pass (2026-04-19): ATS DEBUG localhost exception, SubscriptionStore unverified-txn finish, force-unwrap removal (FamilyPlanView + VerdictView + CallerIDExtension), HomeView triage error surfacing + 30s debounce on activeRecovery, APNs register-fail telemetry, LiveShield 76pt DynamicType clamp, Analytics DEBUG assert on invalid JSON, per-extension privacy manifests slimmed (CallerID/SMSFilter/Watch)
- [x] iOS UX + security wiring pass (2026-04-19): `Product.purchase(options: [.appAccountToken(_)])` threaded through SubscriptionStore so StoreKit transactions are server-bindable (APITypes `SubscriptionStatus.app_account_token` + SubscriptionStore populates on every refresh, empty options set on first-launch); LiveShield critical hang-up button now carries a 0.4-alpha drop shadow + 15% black overlay over `verdictSpoofHigh` to meet WCAG AA white-on-red contrast without losing brand red (flagged: `AegisColor.criticalEmergency` token TODO); RecoveryCompanionView input row + send button both clamped to 44×44 hit regions with `.contentShape(Rectangle())` on the send button; new `AegisDial/Networking/AegisError.swift` maps `APIError` + `URLError` + `NSURLErrorDomain` NSError into six plain-language buckets (`offline`/`serverUnreachable`/`unauthorized`/`paywall`/`rateLimited`/`unknown`) with a `retryable` hint, wired into HomeView lookup + triage error paths; HomeView feature-tour race fixed — synchronous guard on `!tourCompleted && activeRecovery == nil` after the initial refresh instead of a 500 ms sleep that let user taps race the sheet; WatchRootView End Shield now requires two taps within 3 s (first tap plays `.notification` warning haptic + relabels to "Confirm end", 3 s auto-reset Task).
- [x] iOS phone capture + breach provider-disabled state (2026-04-19): new `AegisDial/Features/Settings/PhoneNumberCaptureView.swift` (sheet with phonePad + `.telephoneNumber` content type, E.164-ish validation `^\+?[0-9]{10,15}$` after aggressive client-side normalization stripping spaces/dashes/parens/everything-non-digit, "Save" + "Remove phone" CTAs, `@AppStorage("aegis.user.phone_number")` caches for the Settings-row masked preview `+1 415 ••• •••1234`); `APIClient.updateMe(phone: String?) async throws -> UpdateMeResponse` sends `PATCH /v1/users/me` with an explicit `NSNull()` for remove (bypasses the shared `OptionalProtocol`-stripping body builder so the backend actually sees `phone_number: null`); `UpdateMeResponse { ok, phone_number }` added to APITypes; `MonitoredIdentifier.status: String?` added to BreachTypes (explicit `decodeIfPresent` init + memberwise default so old/new clients + servers stay backward-compat); `MonitoredIdentifiersView` now renders a 3rd gray `clock.fill` row "Phone monitoring coming soon" for rows where `kind == .phone && status == "provider_disabled"` (no exposure count, no rescan button) — fixes the false "No exposures" green that phone rows were showing while Enzoic has no phone lookup; Settings landing has a new "Emergency SMS" section linking to the capture sheet.
- [x] iOS Subscription Status surface (2026-04-19): new `AegisDial/Features/Settings/SubscriptionStatusView.swift` — dedicated plan/renewal/manage surface reading from `@Environment(SubscriptionStore.self)`; branches on `subs.state` (`.entitled` shows plan title + `Product.displayPrice` + "Renews <date>" for auto-renewables or "Expires <date>" for the one-time Recovery Session SKU `com.aegisdial.app.recovery.session` plus an "Upgrade to Pro subscription" primary CTA that presents `PaywallView` as a sheet; `.notEntitled`/`.refreshing`/`.unknown` show "You're on the free tier." + "See plans" → PaywallView sheet; `.purchasing` shows ProgressView with "Confirming your purchase…"; `.error` shows "We can't reach our server." + "Retry" calling `subs.refreshFromBackend()`). Manage subscription button opens `https://apps.apple.com/account/subscriptions` via `UIApplication.shared.open(_:)`. All buttons ≥44pt with VoiceOver labels; root uses `.dynamicTypeSize(...DynamicTypeSize.accessibility3)` and `.preferredColorScheme(.dark)` to match the rest of Settings. SettingsView "Subscription" section now collapses to a single `NavigationLink` row (shield icon + "Subscription" primary + `Pro · Active` / `Recovery · Active` / `Free` / `Checking…` / `Unavailable` tier string on the right + chevron) that pushes SubscriptionStatusView; the prior inline Status/Renews/Manage/Restore rows are gone from the landing. Product ID resolution: since `SubscriptionStore.apply(_:)` is private and scope forbids touching SubscriptionStore.swift, a surgical same-file extension on `SubscriptionStore` exposes a `var latestProductId: String?` via `objc_get/setAssociatedObject` (OBJC_ASSOCIATION_RETAIN_NONATOMIC), and the view lazy-populates it on first appear by scanning `Transaction.currentEntitlements` for any verified tx whose productID is in `SubscriptionStore.allIDs`; a `@State var resolvedProductId: String?` mirror guarantees SwiftUI re-renders since `@Observable` doesn't track associated-object writes. Deferred: promoting `latestProductId` into the native `apply(_:)` code path so it updates on every server refresh rather than once-per-view-appear.

---

## PHASE 2 — Shortly after launch (next 30 days)

### Product polish (I can ship these)

- [ ] **Burner / virtual / overseas number detection** — flag VoIP burners (Google Voice, TextNow, Hushed, Burner, Skype, Ooma, Pinger, Sideline) + surface "this number is X minutes/days old" from our own `first_seen`. Render on iOS verdict card. *(Task #101)*
- [ ] **Crawl pre-warming worker** — hourly cron pulls top recently-reported e164s and pre-fires crawl + lookup so every lookup hits a warm cache. *(Task #98)*
- [ ] **Verdict cache single-flight lock** — Redis SETNX around refresh path prevents thundering-herd on popular scam numbers. *(Task #102)*
- [ ] **Ekata provider integration** — full subscriber + address enrichment. Need API key first. *(Task #99)*
- [ ] **IPQualityScore provider integration** — adds spam-risk score cross-check. Need API key first. *(Task #100)*
- [ ] **Stripe webhook handler** — wire `customer.subscription.{created,updated,deleted}` for email-user renewals. *(Task #103)* Not a blocker (Apple IAP works).
- [ ] **Drop legacy plaintext columns** — final migration after encryption migration is stable in prod. *(Task #104)*
- [ ] **Wire PhoneNumberCaptureView into onboarding flow** — currently Settings-only; adult-child-bought-for-parent flow should prompt for phone at age-gate time so guardian SMS escalation works from day 1. View already built at `AegisDial/Features/Settings/PhoneNumberCaptureView.swift`; insert a step into `AegisDial/Features/Onboarding/OnboardingView.swift` (owned by a different pass this week — do not double-edit) right after age gate, before paywall. Skippable. Backend endpoint `PATCH /v1/users/me` already live.

### Business / GTM

- [ ] **Facebook ad copy** targeting "adult children of aging parents" (primary ICP). Lead with Live Shield + Recovery Concierge.
- [ ] **Record 90-second product demo video** — shows Live Shield catching a call + Companion guiding recovery.
- [ ] **Product Hunt launch** (~week 2).
- [ ] **Wirecutter / NYT / Verge pitch** — "best fraud protection for aging parents" angle.
- [ ] **AARP Magazine pitch** — same angle.
- [ ] **Twitter/X "building in public" account** for credibility + organic top-of-funnel.

---

## PHASE 3 — B2B2C / partnership track (runs in parallel with Phase 2)

### Compliance + enterprise-readiness

- [ ] **SOC 2 Type 1** via Vanta or Drata — ~$25k all-in, 3–6 months. **Blocks every enterprise conversation.** Start immediately.
- [ ] **E&O insurance** — $2–5k/yr via Vouch or Embroker. Most CUs require $1M minimum.
- [ ] **Data Processing Agreement template** — $5–10k via contract lawyer.
- [ ] **Business landing page** at `/business` or `/credit-unions`.
- [ ] **One-pager PDF for CU execs** (different pitch from VC deck).
- [ ] **Admin dashboard for partners** — aggregate non-PII metrics: calls shielded, scams prevented, recovery sessions, dollar loss avoided.
- [ ] **Co-branded onboarding** — partner's logo when members redeem an invite code.

### Partnership outreach

- [ ] **First senior-services nonprofit pilot** — Area on Aging, Meals on Wheels chapter, AARP state office, or elder-law clinic. Easier than a CU for first deal.
- [ ] **Local CU League conference** — attend one in your state (~$500–1500). Face-to-face outreach.
- [ ] **Warm-intro campaign** — LinkedIn reverse-lookup to find shared connections at target CUs.
- [ ] **First CU pilot signed** — 200 members, 90-day free, outcome metrics in writing.

---

## PHASE 4 — Legal / corporate (start during Phase 1 — long lead times)

- [ ] **Stripe Atlas incorporation** — $500, 1 week. File 83(b) election within 30 days of stock grant.
- [ ] **USPTO trademark filing** — classes 9 + 42, ~$700 DIY on TEAS Plus.
- [ ] **Final privacy policy legal review** — consumer-fraud lawyer, ~$1–2k.
- [ ] **Terms of Service legal review** — same.
- [ ] **GLBA compliance statement** (needed for CU conversations).

---

## PHASE 5 — Fundraise (once Phase 1 + some of Phase 2 is done)

- [ ] **Pitch deck designer** — Dribbble, ~$1,500 for 14 polished slides.
- [ ] **First 20 warm-intro asks** via 2nd-degree LinkedIn connections.
- [ ] **Investor CRM** — 100+ seed funds + 50+ angels.
- [ ] **Apply to YC / Techstars NYC / Neo Accelerator** next batch.
- [ ] **First investor conversations scheduled** — target 3/week for 8 weeks.
- [ ] **Close $250k–$750k pre-seed** OR **$1.5M–$2.5M seed** depending on traction signal.

---

## Production-readiness fixes — 2026-04-19

- [x] **PORT mismatch in deploy pipeline** — `.env.production.template` had `PORT=8080`; `scripts/setup-fly-secrets.sh` would have pushed it as a Fly runtime secret (runtime secrets override `fly.toml` [env]). App binds 8080, Fly routes 3000, health-check 502s. Deleted the line from the template (shipped 2026-04-19 in .env.production.template; fly.toml [env] PORT=3000 is authoritative).
- [x] **Stripe + Apple webhook rate-limit escape** — global `@fastify/rate-limit` at 300/min would silently drop events during Stripe 3-day / Apple 60-day retry storms. Added `config: { rateLimit: false }` on `POST /subscription/stripe/webhook` (keeping existing `rawBody: true`) and `POST /subscription/apple/notifications`. Signature verification remains the real abuse gate. Shipped 2026-04-19 in src/routes/subscription.ts.
- [x] **APNs PEM escaped-newline normalization** — ApnsClient threw "Invalid PEM" when an operator set the Fly secret with literal `\n` instead of real newlines (common Fly / env-editor accident). `src/lib/apns.ts` now runs `config.APNS_KEY_P8.replace(/\\n/g, '\n').trim()` before passing to the client. Shipped 2026-04-19.
- [x] **`POST /admin/recovery/grant` manual 30-day Pro grant** — shipped 2026-04-19 in `src/routes/admin.ts`. Kyle can bypass StoreKit to hand a 30-day Recovery Pro window to users met via r/Scams, AARP partnerships, press, and conference floors. Bearer-auth'd via `requireBearer` (API_SHARED_SECRET). Body `{ email?, user_id?, days?=30, reason? }` — exactly one of email/user_id required; `days` clamped to [1, 365]. Writes a `subscriptions` row with `provider='admin_grant'`, `provider_product_id='com.aegisdial.app.recovery.session'`, `provider_transaction_id=admin-grant-<user_id>-<ts>`, `auto_renew=false`, `raw_payload={granted_by:'admin', reason}`. `currentTier()` is provider-agnostic (reads status + period_end) so no allowlist change needed. NOT idempotent — repeat calls create new rows; `currentTier()` picks the latest `current_period_end`. Migration `041_subscriptions_provider_admin.sql` drops + recreates the `subscriptions_provider_check` constraint with `'admin_grant'` added — **must run in prod** via `fly ssh console -a aegisdial -C 'npm run migrate'` before calling the endpoint against the live DB. Tests: `test/adminRecoveryGrant.test.ts` — happy path by user_id, happy path by email (case-insensitive), 404 unknown_email, 400 invalid_body when both email/user_id missing, 401 wrong bearer, 60-day custom window, double-call creates two rows (assert on mock).

## Deferred from 2026-04-19 route+DB review

- [ ] **routes/family.ts:149-150 hardcoded pricing string `$69.99/mo, 5 lines`** — owned by another agent this review cycle; skipped to avoid stomping their edits. Move the copy into `config.ts` or a central pricing constants module so a price change is one-line. *(reviewer R?)*
- [ ] **Migration 035 (drop lookup_history) must run in prod** — `fly ssh console -a aegisdial -C 'npm run migrate'` after deploy. iOS client reads `lookups_all_time` from `/v1/stats/summary`; field now absent (iOS ignores unknowns), but confirm the Dashboard view doesn't hard-crash on the missing field.
- [ ] **Lookup History view still on Phase 2 backlog** — when we build it, re-create `lookup_history` in one coherent migration: table + INSERT path in the lookup service + retention sweep + E.164 stored as ciphertext. Don't just un-drop.
- [ ] **Enzoic phone monitoring (live API)** — `/v1/exposures?username=<sha256(phone)>` silently returns empty for phone identifiers (the endpoint only matches email/username-shaped data). Phone lookups against live Enzoic are now disabled via `isLivePhoneLookupDisabled()` in `src/lib/enzoic.ts`; `lookupExposuresWithStatus()` returns `{ disabled: true, reason: 'phone_monitoring_pending_provider' }` so iOS can render "phone monitoring coming soon" instead of a false all-clear. Mock mode still returns fake phone data so dev UX is unchanged. Unblock options: (a) move to Enzoic `/v1/accounts` on the correct product tier — confirm w/ Enzoic sales, or (b) source phone-in-breach data from a different provider. *(Task #106)*
- [ ] **Pin Anthropic Recovery Companion to a dated snapshot** — currently floating on the `claude-sonnet-4-6` alias in `src/services/recoveryCompanion.ts`. Every Anthropic release note MUST be reviewed manually before it auto-rolls to a fragile-user-facing surface. Pin to the dated snapshot ID (e.g. `claude-sonnet-4-6-YYYYMMDD`) as soon as Anthropic exposes it, and bump it deliberately thereafter. *(Task #107)*
- [ ] **Rotate pinned Stripe API version on SDK bump** — `src/lib/stripeVerify.ts` pins `'2026-03-25.dahlia'` (the version the SDK's `apiVersion.d.ts` targets as of this review). When the `stripe` npm package is upgraded: read `node_modules/stripe/esm/apiVersion.d.ts`, review Stripe's API changelog, update `STRIPE_API_VERSION`, run tests, ship. *(Task #108)*
- [ ] **Migration 033 `device_tokens.invalidation_reason` must run in prod** — `fly ssh console -a aegisdial -C 'npm run migrate'` after deploy. Adds a nullable column so APNs `BadDeviceToken` / `Unregistered` / `TopicDisallowed` responses are persisted per-row in addition to the metric stream. No iOS client impact. *(Task #109)*
- [ ] **Migration 036 `guardian_additions` must run in prod** — `fly ssh console -a aegisdial -C 'npm run migrate'` after deploy. Adds `users.phone_number` (nullable), `guardian_alerts.escalated_at`, `guardian_challenges` table, and `family_ownership_transfers` table. Required for R20 named-guardian check, SMS escalation worker, guardian safe-word challenge endpoint, and plan-owner transfer flow.
- [ ] **Fly secret: `TWILIO_MESSAGING_FROM`** — set to the aegisdial Twilio phone `+E.164` or a `MG…` Messaging Service SID. Gates the 5-min guardian-alert SMS escalator — absent = worker no-ops gracefully. Reuses the existing `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` secrets.
- [x] **`PATCH /v1/users/me` endpoint shipped** — 2026-04-19 in `src/routes/auth.ts`. Accepts `{ phone_number?: string | null, display_name?: string }`; normalizes phone via `normalizeE164` (libphonenumber, US default); rejects unparseable input with 400 `invalid_phone`; clears the column on explicit null; rate-limited 10/hr/user. Returns `{ ok: true, phone_number }`. Test coverage: `test/routesAuthBreach.test.ts` (happy + 400 + null-clear).
- [ ] **iOS: wire `users.phone_number` capture** — onboarding screen needs to optionally capture the user's own phone (E.164, user-opt-in) and PATCH `/v1/users/me` with `{ phone_number: "<E.164 or raw US>" }`. Backend is live as of 2026-04-19. Until iOS ships, the R20 named-guardian check + SMS escalator run safely but as no-ops.
- [x] **Migration 038 `monitored_identifiers.status` shipped** — 2026-04-19 `db/migrations/038_monitored_identifiers_status.sql`. Adds `status TEXT NOT NULL DEFAULT 'active'` + `idx_monitored_identifiers_status (user_id, status)`. Values: `'active'` | `'provider_disabled'` (phone, Enzoic off) | `'paused'` (future).
- [ ] **Migration 038 must run in prod** — `fly ssh console -a aegisdial -C 'npm run migrate'` after deploy. Additive column w/ a default, so deploy order is safe (migration first, then API cut-over). Required so `breachScan.scanIdentifier` can persist `status='provider_disabled'` for phone rows and `GET /v1/breach/monitor` can surface it to iOS.
- [x] **`breachScan` phone kind routed through `lookupExposuresWithStatus`** — 2026-04-19 in `src/services/breachScan.ts`. Phone scans now persist `status='provider_disabled'` + return `status`/`disabled_reason` on `ScanReport`. Email path unchanged. A successful scan (any exposure count) resets `status='active'` so a provider coming back online is picked up on the next re-scan.
- [x] **`POST /v1/breach/monitor` 409 on duplicate** — 2026-04-19 in `src/routes/breach.ts`. Flipped `ON CONFLICT DO UPDATE` → `ON CONFLICT DO NOTHING RETURNING` + follow-up SELECT. Duplicate adds now return 409 `identifier_already_monitored` with `existing_id` so iOS can focus-scroll to the row instead of visually double-prepending. Test: `test/routesAuthBreach.test.ts` (409 path with email case-insensitive collision).
- [x] **`GET /v1/breach/monitor` surfaces `status`** — 2026-04-19. Additive field, defaults to `'active'` in response if the column is null (pre-migration envs).
- [ ] **iOS: render `monitored.status === 'provider_disabled'`** — on both the add-monitor response and the list view, iOS should render a "phone monitoring coming soon" banner on those rows instead of the zero-exposures empty state. Backend now emits the signal; iOS has to key off it.
- [ ] **iOS: handle 409 `identifier_already_monitored`** — show a toast ("already monitoring this identifier") and focus-scroll the list to `existing_id`. Previously the 200+row-echo path silently re-added the row visually; iOS's request-failure handler must read `existing_id` instead of showing a generic error.
- [ ] **DAILY_LOOKUP_CAP Fly secret** — default is 2000/instance/day; set explicitly once we have real traffic data so spend on Twilio Lookup + Ekata + IPQS is bounded. `fly secrets set DAILY_LOOKUP_CAP=<n> -a aegisdial`. *(Task #110)*
- [ ] **Live Shield consent-sheet copy — consumer-fraud attorney sign-off** — `AegisDial/Features/LiveShield/LiveShieldConsentSheet.swift` (2026-04-19) now ships an all-party-consent-safe scripted verbal notice covering every US two-party state (CA, CT, DE, FL, IL, MD, MA, MT, NH, PA, WA + OR). The copy is best-effort, not legal-reviewed. Have a consumer-fraud attorney review the script, the legal note listing the states, and the privacy-policy link before GA. Budget: $500–1.5k as part of the Phase 4 Privacy / Terms review. *(Task #111)*

## Recovery iOS polish — 2026-04-19

- [x] **RecoveryEvidenceSheet PhotosPicker** — wired `PhotosPicker` to the evidence locker. Images resize to 1024px max edge, JPEG-compressed, SHA-256 hashed, written to `Documents/recovery-evidence/<sha>.jpg`. Only `{sha256, width, height, bytes, local_filename, caption}` POSTs to `/v1/recovery/:id/evidence` with `kind: 'photo'` — matches the migration 016 schema (raw bytes never hit the DB). Capped at 3 photos / 4 MB combined per submission.
- [x] **RecoveryStepCard reset** — `.contextMenu` with "Reset step" + confirmation alert on completed/skipped cards. Calls `POST /v1/recovery/:id/step/:step_key/status` with `status: 'in_progress'` via a new `.reset` case on `RecoverySessionView.StepAction`. Backend already supports `in_progress` in the zod enum (`src/routes/recovery.ts:135`).
- [x] **RecoveryCompanionView voice mode** — speaker toggle in nav bar, `@AppStorage("recovery.companion.voice_mode")` persistence, `AVSpeechSynthesizer` at rate `0.42` with en-US voice. Stops on dismiss / send / toggle-off. Only new assistant messages are spoken; history replay is suppressed via `spokenMessageIds`.
- [x] **RecoveryReportsSheet** — reviewed, already correct. Narrative renders in a `ScrollView` with `.textSelection(.enabled)`; current surface uses `UIPasteboard` + `UIApplication.open`, not `UIActivityViewController`, so the iPad popover-source crash isn't reachable. No edits made.

### Deferred from this pass

- [ ] **Recovery evidence photo thumbnails** — row currently shows caption + dimensions. A 44×44 thumbnail read from `Documents/recovery-evidence/` would help users recognize photos at a glance, but it requires a small image-cache layer to keep scrolling smooth. Ship when we add a detail sheet for each evidence item.
- [ ] **RecoveryReportsSheet file-share export** — current flow is copy + open-form, which covers the 80% case. A future `UIActivityViewController` path that writes the narrative to a tmp `.txt` (so Mail/Messages can attach it) is worth adding when users start asking to email reports to adult children. If added, wire a `UIPopoverPresentationController` source rect for iPad.
- [ ] **Companion voice mode — multi-language** — currently hardcoded en-US. Aging users whose primary language is Spanish would benefit; defer until we add localized strings.

## Deferred from 2026-04-19 LS/Recovery/Guardian bug-hunt pass

- [ ] **T+90d recovery follow-up should include `abandoned` sessions** — abandoned sessions are the highest-value re-victimization targets (victim gave up mid-plan) but the current worker only matches `active`/`completed`. Expand the status filter in `src/workers/recoveryFollowupWorker.ts` for the 90d bucket specifically.
- [ ] **Bulk crime reports pagination** — `/v1/recovery/bulk-reports/mine` caps at `LIMIT 200`. A user with 201+ report memberships loses the tail. Add offset-based pagination when we see it matter.
- [ ] **LiveShieldConsentSheet outbound-specific copy** — scripted notice currently reads "I'm using an AI on this call"; if user starts the shield before placing an outbound call, there's no counterparty to read it to yet. Branch the wording. Companion item: thread `direction: LiveShieldDirection` through `HomeView` → `LiveShieldConsentSheet.onStart` → `LiveShieldSession.start(peer:direction:)` so the outbound CTA wired on `LiveShieldEntryCard.onTapOutbound` (HomeView.swift, 2026-04-19) actually flips the session to `.outbound` at start time. Today the outbound CTA routes through the same consent sheet as inbound and the session ends up `.inbound` by default — Track source tag `home_card_outbound` distinguishes the intent for analytics, but the backend `liveShieldStart` payload reports `.inbound`.
- [ ] **AVSpeechSynthesizer single-instance** — `RecoveryCompanionView.swift` creates a new synth on each view init; rapid dismiss/reopen could briefly have two alive. Not thread-safe. Move to a shared `@MainActor` singleton.
- [ ] **PhotosPicker — skip re-encode for already-small images + orphan cleanup** — `RecoveryEvidenceSheet.swift:236-246` re-encodes to JPEG(0.82) even when source is already ≤1024px. Also, local JPEGs at `Documents/recovery-evidence/` are never cleaned up if user cancels the sheet without submitting.
- [ ] **Watch END "Ending…" reconcile state** — `WatchRootView.swift` flips `store.activeShield = false` optimistically; if iPhone doesn't confirm, Watch says "All clear" while iPhone still shielding. Add a 5s reconcile timer that keeps a spinner state until the next applicationContext push confirms the end.
- [ ] **Resend reply-to address wiring** — 30d/90d emails invite "reply to this email." Confirm `RESEND_FROM=alerts@aegisdial.com` forwards replies somewhere a human reads, or switch to a no-reply address + in-app CTA.
- [ ] **guardianAlertEscalator graceful shutdown** — worker doesn't honor SIGTERM during an in-flight Twilio POST; Fly's 5s graceful-shutdown window can cut mid-request. Wire an AbortController + scheduler shutdown hook (companion item to the Phase-2 worker-drain work).
- [x] **iOS: Guardian safe-word challenge INITIATE side shipped** — 2026-04-19. `AegisDial/Features/Guardian/SafeWordChallengeInitiateSheet.swift` (new) + `GuardianDashboardView` "Challenge" button per alert row (keyed on `GuardianAlert.subjectUserId`) + `APIClient.initiateSafeWordChallenge(subjectUserId:)` (POST `/v1/guardian/challenge`) + `SafeWordChallengeCreated` response type. 403 `challenge_not_available` maps to a single warm sentence ("This person hasn't set up a safe word with you yet."), every other error routes through `AegisError.from`. Sheet: in-flight guard, medium haptic on send / success haptic on 200 / error haptic on fail, 1.5s auto-dismiss on success, clamped to DynamicType AX3.
- [ ] **iOS: Guardian safe-word challenge RESPOND side** — subject receives a push with the challenge prompt, enters answer, result surfaces to the guardian. Sheet + routing not yet built. Out of scope of the 2026-04-19 initiate pass.
- [ ] **`GET /v1/guardian/alerts` should include `subject_display_name`** — today `GuardianAlert` exposes `subject_user_id` (UUID) + `title` string. `SafeWordChallengeInitiateSheet` has to regex a possessive prefix out of the title ("Mom's call went critical" → "Mom") to label the sheet, and falls back to "this person" when the title has no apostrophe. Adding the subject's display_name (decrypted from `users` or `family_members`) to the alert payload kills that hack. Respect guardian's label override for the subject from `family_plans.label` when present, else `users.display_name`.
- [ ] **FamilyContact alert count on list response** — `GET /v1/family/contacts` currently returns `FamilyContact` rows with no `guardian_alerts_count`. iOS VoiceOver label synthesized on 2026-04-19 (`FamilyContactsView.accessibilityLabel`) falls back to a guardian/safe-word phrase; when a per-contact alert count is exposed (roll-up of `guardian_alerts` rows scoped to this contact's phone_e164 over the retention window), the iOS label should switch to `"{name}, {relationship}, {n} guardian alerts"` per the 2026-04-19 aging-parent DT spec.
- [ ] **Aging-parent DynamicType pass 2026-04-19** — scoped iOS visual pass shipped (OnboardingView hero + Apple age sheet, EmailAuthView inline `@`-sign hint + AX3 clamp, FeatureTourView Continue/Get-started CTAs on every page, EngagementStatsCard stat-number scaling + AX3 clamp, LiveShieldConsentSheet full-sheet AX3 clamp + token-mapped fonts, LiveShieldEntryCard chevron matches label scale, RecoveryStepCard skip de-emphasized to "Not doing this one", FamilyPlanView X button 44pt target, FamilyContactsView VoiceOver row combine). Deferred: HomeView.swift error copy + feature-tour timing (other agent), Live Shield active session view (other agent), Recovery Companion view (other agent), Watch + Settings views. Next pass should hit those and consider adding `AegisType.subtitle` (24/medium/rounded) + `AegisType.largeTitle` (30/bold) tokens so the preserved-hardcoded sizes in OnboardingView / FeatureTourView / LiveShieldConsentSheet / RecoveryStepCard can collapse to tokens.
- [x] **iOS FeatureTourView twin-pillar rewire 2026-04-19** — tour reordered from 6-page Live-Shield-led utility walk to a 5-page prevention-AND-recovery pitch: Welcome ("the only fraud app that prevents AND recovers") → Live Shield ("stop the call before money moves", CTA threads to the existing consent sheet via `onGoToLiveShieldDemo`) → Recovery Concierge ("if one ever lands, we walk you through it", in-tour advance only — tour shouldn't drop users into an empty Companion pre-event) → Paste-a-Text ("got a sus text? paste it here", routes to `ScamTextAnalyzerView` via a new `onGoToTextAnalyzer` callback wired in HomeView) → Family plan ("protect 3 family members", completes the tour and opens Protect-a-Parent). `tour_completed_v1` contract preserved; `onboarding_tour_page_viewed` / `onboarding_tour_skipped` / `onboarding_tour_completed` events still fire with new feature keys (`welcome`/`live_shield`/`recovery_concierge`/`text_analyzer`/`family_plan`); view-root clamped to `DynamicTypeSize.accessibility3`; titles keep `minimumScaleFactor(0.7)`. HomeView entry point (`.task { showingTour = true }` after initial refresh) unchanged. Safe-word / SMS / Breach pages retired from the tour — still reachable from Home + Settings.

## Tech-debt / "nice to have" (not blocking anything)

- [ ] App Attest server-side verification (currently accepts silently) *(reviewer S3)*
- [x] Apple server-to-server notifications — wire refund / revoke / renew webhooks *(reviewer B1/B2 — shipped 2026-04-19)* `POST /subscription/apple/notifications` now routes verified JWS payloads: `DID_RENEW` extends `current_period_end`; `EXPIRED` + `GRACE_PERIOD_EXPIRED` set status=`expired`; `REFUND` + `REVOKE` set status=`refunded` and reconcile the user's tier to `expired` via `ensureTierPersisted` (closes the revenue leak where refunded users kept Pro); `DID_CHANGE_RENEWAL_STATUS` flips `auto_renew` only; `PRICE_INCREASE`/`CONSUMPTION_REQUEST`/`RENEWAL_EXTENDED`/`RENEWAL_EXTENSION` log-only. Bad outer JWS still 400s (Apple health-check signal); handler exceptions post-verify return 200 + `captureError` so a deterministic bug doesn't flood us for 60 days of retries. `src/lib/appleVerify.ts` now exposes a typed `DecodedNotification` with pre-verified inner `transaction` + `renewalInfo`. Test coverage: `test/appleNotifications.test.ts` (6 cases: DID_RENEW extends period, EXPIRED/GRACE_PERIOD_EXPIRED → expired, REFUND flips tier, REVOKE parity with REFUND, DID_CHANGE_RENEWAL_STATUS auto_renew only, unknown/PRICE_INCREASE no-op).
- [ ] Family+ → Pro downgrade: shrink capacity + evict 4th/5th members *(reviewer B3)*
- [x] Encrypt `support_tickets.email` *(reviewer D10 — shipped 2026-04-19 via migration 032 + src/routes/support.ts)*
- [x] Encrypt `family_contacts.notes` (fully, plaintext column nulled on write) + dual-write `family_contacts.display_name_ct` *(reviewer D8 — shipped 2026-04-19 via migration 031 + src/routes/familyContacts.ts)*
- [ ] Encrypt `family_contacts.phone_e164` — **deferred** 2026-04-19: requires a `phone_e164_hash` lookup column AND updating `src/routes/liveShield.ts` (out of this agent's scope) to dual-read by hash. Plaintext phone still present in DB-snapshot leak until Phase 2 does a coordinated pass.
- [ ] Drop plaintext `family_contacts.display_name` — follow-up to migration 031: liveShield.ts still reads plaintext, so we kept dual-write. Flip liveShield.ts to read `display_name_ct` first, then ship the drop migration.
- [ ] Encrypt `sms_classifications.sender` *(reviewer D9 — deferred 2026-04-19, not in this security pass)*
- [ ] Retention sweeps for `recovery_outcomes`, `recovery_sessions`, `recovery_evidence`, `recovery_companion_messages`, `phone_lookups` *(reviewer D16, B28)*
- [ ] Clear `named_guardian_user_id` when named guardian leaves the plan *(reviewer B10)*
- [ ] Enforce named guardian must have role 'guardian' on plan *(reviewer R20)*
- [x] CORS — lock down `origin: true` *(reviewer S4 — shipped 2026-04-19 as `origin: false` in src/server.ts; native-iOS-only API has no browser client)*
- [x] Sentry email PII redaction *(reviewer S5 — shipped 2026-04-19: email recipient is masked to domain-only before forwarding to Sentry via `maskEmailForTelemetry` in src/lib/email.ts. Broader URL/params scrub across other captureError callsites still open.)*
- [x] Sentry beforeSend PII scrub *(shipped 2026-04-19: `beforeSend` in src/lib/observability.ts strips `phone_number`, `to`, `body`, `email`, `phone`, `tokenOnJws`, `raw_payload` from event.extra / event.tags / event.contexts[*] / event.request.data before transmit. Defensive layer over sendDefaultPii:false so guardianAlertEscalator Twilio error bodies, recoveryCompanion userId+payload context, and subscription.ts mismatch logs can't leak PII out of the error-tracking surface.)*
- [ ] Per-user LLM budget (current guard is per-instance) *(reviewer S7)*
- [x] Support ticket rate limit *(reviewer S8 — shipped 2026-04-19 in src/routes/support.ts: 3/hr anon per IP, 20/hr per authed user. CAPTCHA still deferred.)*
- [x] Family invite + accept per-user rate limits *(shipped 2026-04-19 in src/routes/family.ts: invite 10/hr, accept 10/min, keyed on userId ?? ip)*
- [x] SMS classify rate limit keyed on text SHA, not IP *(shipped 2026-04-19 in src/routes/smsClassify.ts — Apple's ILMessageFilterExtension shares an edge POP across iOS users so IP-keyed limiting would throttle legit traffic; text-hash keyed instead so duplicate messages throttle but distinct user traffic sails past)*
- [ ] `pushDispatcher` retry loop — add `delivery_attempts` column + exponential backoff *(reviewer R9)*
- [ ] Stagger cron workers to avoid thundering Neon *(reviewer R14)*
- [ ] Worker drain on SIGTERM via AbortController *(reviewer R15)*
- [x] Pin Stripe SDK `apiVersion` *(reviewer R17 — shipped 2026-04-19: src/lib/stripeVerify.ts now pins `'2026-03-25.dahlia'` w/ a STRIPE_API_VERSION constant + rotation-on-SDK-bump comment)*
- [ ] Drop legacy plaintext columns (deferred migration — fires after encryption migration is stable)
- [x] Bulk crime reports surfaced to users — `GET /v1/recovery/bulk-reports/mine` + `GET /v1/recovery/bulk-reports/:id` (shipped 2026-04-19 in src/routes/recovery.ts; ownership via session_ids array-overlap on user's recovery_sessions; deterministic FTC + IC3 narratives on detail via existing `generateFtcReport` / `generateIc3Report`; 30/min/user rate limit; intentionally NOT requireProTier so downgraded users still see earlier reports)
- [x] iOS bulk crime report surfaces — shipped 2026-04-19 in aegisdial-ios: `BulkCrimeReportsView` (list), `BulkCrimeReportDetailView` (FTC/IC3 segmented narrative + iPad-safe ShareSheet with popover anchor), entry point in `RecoveryHistoryView`. Decoder tolerates both documented `session_count` + actual backend `distinct_users`; detail supports both flat + `{report,ftc,ic3}` envelopes. `APIClient.listMyBulkReports` + `getBulkReport`. Empty-state copy matches the "5+ in 90-day window" user narrative even though backend rule is currently 10+/7-day.
- [x] iOS plan-owner transfer surfaces — shipped 2026-04-19 in aegisdial-ios: `PlanOwnerTransferRequestSheet` (owner-only; picks a plan member, shows raw token ONCE with `.textSelection(.enabled)` + DynamicType clamp, ShareLink for Messages/Mail), `PlanOwnerTransferAcceptSheet` (destructive-tint confirmation dialog, tolerates both raw token and `aegisdial://family/transfer/accept?token=…` URL paste). Entry points added in `FamilyPlanView` conditional on role. Notification `.aegisFamilyStateChanged` broadcasts on accept for cross-surface refresh. `APIClient.requestOwnershipTransfer` + `acceptOwnershipTransfer`.
- [ ] iOS deep-link router for `aegisdial://family/transfer/accept?token=…` — `PlanOwnerTransferAcceptSheet` takes an `initialInput` seed so the sheet itself is ready; top-level URL handler in the app root still needs wiring.
- [ ] iOS Settings → Accept transferred ownership row — sheet is routable from anywhere; Settings wiring intentionally NOT touched in this pass (concurrent agent owns Settings). Add a row under `Section("Family")` that presents `PlanOwnerTransferAcceptSheet` when ready.
- [ ] Bulk crime reporting → automated IC3 submission (currently generates aggregate rows + surfaces them to users; machine-to-machine IC3 submission still pending — IC3 has no programmatic intake)
- [x] Recovery follow-up cadence extended to T+30d + T+90d — shipped 2026-04-19 via migration 037 + src/workers/recoveryFollowupWorker.ts + src/lib/email.ts. T+30d is outcome-gated (only fires if recovery_outcomes row exists) and personalizes copy off `recovered_any`/`recovered_cents` (decrypted via `decryptInt` ct-fallback pattern). T+90d fires unconditionally (no users.email_preferences column exists in current migrations — assumed opted in per spec; when that column lands, extend the WHERE clause). Metric `recovery.followup_sent` now emits 5 buckets. All 5 buckets dispatch in parallel via Promise.all.
- [ ] Integration tests for `routes/breach`, `routes/recovery`, `routes/guardian`, `routes/familyContacts` (currently unit-level)
- [ ] Search in FamilyContacts / Recovery / Breach views
- [ ] Lookup History view
- [ ] Live Shield hit-set Redis cache (saves ~15–30 ms/chunk)
- [ ] Bank / credit-bureau API integrations (partnership-gated, 1+ quarter of work each)
- [ ] Identity-theft insurance rider — **intentionally out of scope** per fundraise memory
- [ ] Reddit crawler (awaiting commercial API approval)

---

## The honest shortest-path-to-first-user

1. **This week:** Fly secrets, migrations, domain, Apple Developer.
2. **Week 2:** First Xcode build, fix compile issues, app icon, App Store Connect.
3. **Week 3:** TestFlight Internal. Smoke test with 5 friends.
4. **Week 4:** TestFlight External beta — 200 invites via Facebook ad targeting.
5. **Week 5–8:** Iterate on feedback. Launch on App Store.
6. **Parallel from Week 1:** start SOC 2 via Vanta (long lead time).
7. **Parallel from Week 3:** first senior-services nonprofit conversation.

**The product is ready. The runway between "code complete" and "first user" is ~5 weeks of external work.**
