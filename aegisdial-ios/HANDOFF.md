# AegisDial iOS — Handoff

This is the iOS counterpart to the AegisDial backend. Read the **backend repo's `HANDOFF.md` first** for product context (what AegisDial is, why, security model, pricing, positioning). This document covers iOS-specific setup, architecture, and what's left.

---

## 1. You need a Mac to build this

Xcode runs only on macOS. Options if you don't own one:
- **MacinCloud / MacStadium** — rent in the cloud, ~$10–30/mo
- **Xcode Cloud** — Apple's CI/CD, free tier covers this app size
- **Borrow a Mac** for an afternoon

Required: **Xcode 16+** (for iOS 18 Live Caller ID Lookup) and **XcodeGen** (`brew install xcodegen`).

## 2. First-time setup

```bash
brew install xcodegen
cd aegisdial-ios
xcodegen generate
open AegisDial.xcodeproj
```

In Xcode:
1. Select project → Signing & Capabilities
2. Team: pick your Apple Developer team. Bundle ID is `com.aegisdial.app`.
3. Capabilities enabled per target: Sign In with Apple, App Attest, Live Caller ID Lookup (extension), Keychain Sharing (`com.aegisdial.app.shared`)
4. Set backend URL in `AegisDial/Networking/Endpoint.swift` → `APIConfig.baseURL`
5. Build + Run on a device or simulator

For local backend testing on a physical device, use your Mac's LAN IP (e.g. `http://192.168.86.41:3000`) so the device on the same WiFi can reach it.

## 3. Targets (4)

```
AegisDial            — main app (iOS 18+, SwiftUI, Swift 5.10, strict concurrency)
CallerIDExtension    — Live Caller ID Lookup (CallKit verdict)
SMSFilterExtension   — ILMessageFilter + URL reputation
AegisDialWatch       — watchOS 11+ companion (End Shield button, status tile)
```

All defined in `project.yml`; bundle IDs:
- `com.aegisdial.app`
- `com.aegisdial.app.CallerID`
- `com.aegisdial.app.SMSFilter`
- `com.aegisdial.app.watchkitapp`

## 4. Repo layout

```
AegisDial/
  App/                    — Entry point, AppDelegate, root view
  Theme/                  — AegisColor, AegisType, motion tokens
  Networking/             — APIClient, Endpoint, AegisError, generated types
  Auth/                   — Sign-in-with-Apple, email/password, App Attest
  Features/
    Onboarding/           — OnboardingView, FeatureTourView, age gate, paywall
    Home/                 — HomeView (Live Shield + Recovery twin hero cards)
    LiveShield/           — Consent sheet, active session, transcript
    Recovery/             — Concierge, Companion (chat + voice), evidence locker
    Family/               — Plan, contacts, named guardian, safe-word challenge
    Breach/               — Monitored identifiers, exposure list
    Guardian/             — Dashboard, alerts, challenge initiate sheet
    Settings/             — Subscription status, privacy, export, phone capture
    BulkReports/          — Aggregate FTC/IC3 report list + detail
  Resources/              — Localizable.xcstrings, PrivacyInfo.xcprivacy
  Info.plist
  AegisDial.entitlements
CallerIDExtension/        — CXCallDirectoryProvider implementation
SMSFilterExtension/       — ILMessageFilterExtension + Safe Browsing
AegisDialWatch/           — Watch root view, status tile, End Shield
Assets.xcassets/          — App icon, color set tokens, symbol set
scripts/                  — XcodeGen helpers
project.yml               — XcodeGen project spec — edit this, NOT the .xcodeproj
TESTFLIGHT_CHECKLIST.md   — Pre-submission checklist
README.md                 — Quick-start
```

## 5. Three sign-in methods

1. **Sign in with Apple** (required by App Store when any third-party auth is offered)
2. **Email + password**
3. **Continue as Guest** (anonymous, device-ID bound, free tier only)

App Attest signs every backend call with a hardware-attested key on top of all three.

## 6. Keychain access group (CRITICAL)

`com.aegisdial.app.shared` with `$(AppIdentifierPrefix)` expansion. Set in **all 4 target entitlement files**. Simulator skips the access-group attribute via `#if !targetEnvironment(simulator)` to avoid `errSecMissingEntitlement`.

If you regenerate provisioning profiles or change the team, **re-export the entitlements and re-sign all 4 targets** — a missed target = silent token-not-found in production.

## 7. StoreKit + subscription status

- All purchases use `Product.purchase(options: [.appAccountToken(uuid)])` where `uuid` comes from `/subscription/status` (server-generated). This binds the JWS to the user account so cross-user claim attempts return 403.
- `SubscriptionStore` (Swift `@Observable`) listens to `Transaction.updates` and handles both `.verified` (forward + finish) and `.unverified` (finish without forward — bogus txns don't re-queue every relaunch).
- Offline / transient `/subscription/status` failures keep the prior `.entitled(end)` state instead of flipping to paywall.
- `SubscriptionStatusView` (`Features/Settings/`) reads from `@Environment(SubscriptionStore.self)` and branches on `subs.state` (`.entitled` / `.notEntitled` / `.refreshing` / `.unknown` / `.purchasing` / `.error`).

## 8. Pricing & product IDs (LOCKED — backend repo HANDOFF section 10)

| Product ID | Price | Type |
|---|---|---|
| `com.aegisdial.app.pro.monthly` | $49.99/mo | auto-renewable |
| `com.aegisdial.app.pro.yearly` | $299/yr | auto-renewable |
| `com.aegisdial.app.pro.family_plus.monthly` | $69.99/mo | auto-renewable |
| `com.aegisdial.app.recovery.session` | $99 one-time | NON-CONSUMABLE |

Anything in code referencing $9.99 / $14.99 / $19.99 is stale and must be removed.

## 9. Privacy manifests

Per-target `PrivacyInfo.xcprivacy` for main app + 3 extensions. Slimmed in 2026-04-19 pass — extension manifests now declare only what each extension actually reads.

## 10. App Transport Security

ATS hardened. `NSAllowsArbitraryLoads` is **NO**. DEBUG builds have a localhost-only exception so `xcrun simctl` and on-device LAN dev work without weakening prod.

## 11. Status

**Code-complete since 2026-04-19** alongside the backend. Remaining work is external + a few iOS wiring follow-ups:

### Build / submission gates
- [ ] Apple Developer Program enrollment ($99/yr) — gates provisioning profiles
- [ ] Provisioning profiles regenerated (after Keychain access group change)
- [ ] First Mac Xcode build — expect 5–20 compile issues on first run, mostly entitlement / signing
- [ ] App icon 1024×1024 (Fiverr ~$50–200, 24–48 hr)
- [ ] App Store Connect — app record + 4 subscription products at the prices above
- [ ] Privacy labels in App Store Connect (per `PrivacyInfo.xcprivacy`)
- [ ] TestFlight Internal group → smoke test → External beta
- [ ] End-to-end smoke: Apple sign-in → paywall → sandbox subscribe → Live Shield demo → Recovery Concierge → companion chat → outcome submit

### iOS wiring follow-ups (not launch blockers)
- [ ] `users.phone_number` capture in **onboarding** flow (`PhoneNumberCaptureView.swift` exists in Settings; insert it after age gate, before paywall)
- [ ] Render `monitored.status === 'provider_disabled'` on phone breach rows ("phone monitoring coming soon" instead of false zero-exposures)
- [ ] Handle 409 `identifier_already_monitored` on breach add (toast + focus-scroll to existing row)
- [ ] Deep-link router for `aegisdial://family/transfer/accept?token=…` at app root
- [ ] Settings → Accept transferred ownership row (sheet exists, just needs the entry point)
- [ ] Companion voice mode multi-language (currently en-US hardcoded)
- [ ] Watch END "Ending…" reconcile timer (5s) so watch + phone don't desync

See `TESTFLIGHT_CHECKLIST.md` in this repo for the pre-submission gate list.

## 12. What's already shipped (selected highlights from the 2026-04-19 hardening)

- ATS DEBUG localhost exception
- SubscriptionStore unverified-txn finish (bogus txns don't loop)
- `Product.purchase(options: [.appAccountToken(_)])` threaded through
- Force-unwrap removal: FamilyPlanView + VerdictView + CallerIDExtension
- HomeView triage error surfacing + 30s debounce on activeRecovery
- APNs register-fail telemetry
- LiveShield 76pt DynamicType clamp + WCAG-AA contrast on critical hang-up button
- 44×44 hit regions on every primary CTA
- `AegisError.swift` maps APIError + URLError + NSError to 6 plain-language buckets (`offline` / `serverUnreachable` / `unauthorized` / `paywall` / `rateLimited` / `unknown`) with retryable hint
- HomeView feature-tour race fixed (synchronous guard, not 500ms sleep)
- WatchRootView End Shield: two taps within 3s + warning haptic on first
- PhoneNumberCaptureView (Settings — needs onboarding wiring as above)
- BreachTypes `MonitoredIdentifier.status: String?` + provider_disabled UI
- SubscriptionStatusView (dedicated plan/renewal/manage surface)
- BulkCrimeReportsView + Detail (FTC/IC3 segmented narrative + iPad-safe ShareSheet)
- PlanOwnerTransferRequestSheet + AcceptSheet (token shown ONCE + ShareLink)
- SafeWordChallengeInitiateSheet (RESPOND side still pending)
- FeatureTourView twin-pillar rewire: Welcome → Live Shield → Recovery → Paste-a-Text → Family
- Aging-parent DynamicType pass (8 surfaces, AX3 clamps, scaled stat numbers)

## 13. Stewardship rule

Treat this as shippable. Do not add new features unless explicitly asked. Onboarding flow + DT pass have multiple agents in flight historically — check `git log` and `git blame` before editing OnboardingView, HomeView, RecoveryCompanionView, or LiveShield active-session view to avoid stomping concurrent work.

## 14. Where to find more

- `README.md` — quick-start
- `TESTFLIGHT_CHECKLIST.md` — pre-submission checklist
- Backend repo's `HANDOFF.md` — product context + security model + pricing + positioning
- Backend `TODO.md` — live punch list across both repos
