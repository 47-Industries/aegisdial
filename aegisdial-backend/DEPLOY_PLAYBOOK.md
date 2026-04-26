# AegisDial — Pre-TestFlight Runbook

**Goal:** From "code written, never deployed" to "TestFlight build live + every backend feature wired." Total time: ~90 minutes of your hands at the keyboard spread across this list, plus ~2–3 hours of waiting on reviews.

Every step says exactly what to click, what to paste back, and what it costs. Follow the order — later steps depend on earlier ones.

---

## Hard unblocks (you MUST do these, they can't be automated)

### ☐ 1. Apple Developer Program enrollment — $99/year — ~15 min + 24 hr wait

**URL:** https://developer.apple.com/programs/enroll/

- Sign in with the Apple ID you want all AegisDial certificates / keys / TestFlight tied to.
- Enroll as an **Individual** (fastest — 24-hour approval). Organization takes 1–2 weeks and needs a D-U-N-S number; switch later if you need it.
- Pay $99, do the 2FA on your phone.

**What you get:** a 10-character **Team ID** (visible at https://developer.apple.com/account → Membership). Paste it into two places:
- `~/aegisdial-ios/project.yml` → `DEVELOPMENT_TEAM: "XXXXXXXXXX"`
- `.env.production` → `APNS_TEAM_ID=XXXXXXXXXX`

**Blocker note:** You can't create an APNs key, upload a build, or open TestFlight without this. If you're not ready to spend $99 today, stop here and come back. Everything else below is cheap or free.

---

### ☐ 2. Fly.io credit card — free tier still free — ~2 min

**URL:** https://fly.io/dashboard/aegisdial/billing

- Add a card. Fly uses this as anti-abuse, not billing — the free tier covers a single shared-CPU 512MB machine forever.

**Verify:**
```bash
export PATH="$HOME/.fly/bin:$PATH"
fly apps create aegisdial-api --org personal
```
Should succeed (no more "payment information" error).

---

### ☐ 3. Register aegisdial.com + .ai + .io + .app — ~$60 total — ~5 min

**URL:** https://dash.cloudflare.com → Registrar (cheapest at wholesale cost)

- Buy `aegisdial.com`, `.ai`, `.io`, `.app`. Leave Cloudflare as the registrar + DNS provider — no transfer needed, DNS is immediate.
- Turn on **Cloudflare Registrar Auto-Renew** for all four.

**Why now:** Resend and the privacy policy URLs in the iOS app both point at aegisdial.com. The App Store submission will be rejected if these 404.

---

## Free-tier signups (10 minutes total — these ARE automatable but faster for you to click)

### ☐ 4. Sentry — free tier — ~2 min

**URL:** https://sentry.io/signup/

- Sign up with `aegisdial@outlook.com`.
- Create organization "aegisdial", project name "aegisdial-api", platform **Node.js**.
- On the "Get your DSN" screen copy the full `https://...@oXXXXX.ingest.us.sentry.io/XXXXX`

**Paste into** `.env.production`:
```
SENTRY_DSN=https://abc123@o4500...ingest.us.sentry.io/45001
```

### ☐ 5. PostHog — free tier (1M events/mo) — ~2 min

**URL:** https://app.posthog.com/signup

- Sign up with `aegisdial@outlook.com`, region **US** (matches POSTHOG_HOST).
- On the dashboard → Project Settings → **Project API Key** (the `phc_…` one, NOT the personal API key).

**Paste into** `.env.production`:
```
POSTHOG_API_KEY=phc_xxxxx
```

### ☐ 6. Enzoic — free dev trial — ~3 min

**URL:** https://www.enzoic.com/developers/

- Sign up → pick **Exposures API** → they'll email you a key + secret.
- Free tier: 2 500 lookups/month — plenty for closed beta. Pricing starts at ~$1.50/user/mo at scale.

**Paste into** `.env.production`:
```
ENZOIC_API_KEY=xxxxxx
ENZOIC_API_SECRET=xxxxxx
ENZOIC_MOCK=false
```

### ☐ 7. Google Safe Browsing — free (10k lookups/day) — ~3 min

You already have Google Cloud project `my-project-37237aegisdial` (your YouTube key lives there).

1. **URL:** https://console.cloud.google.com/apis/library/safebrowsing.googleapis.com?project=my-project-37237aegisdial → click **Enable**
2. Then https://console.cloud.google.com/apis/credentials?project=my-project-37237aegisdial → **Create Credentials → API Key**
3. Restrict the key: API restrictions → "Safe Browsing API"

**Paste into** `.env.production`:
```
GOOGLE_SAFE_BROWSING_API_KEY=AIzaSy...
```

### ☐ 8. Resend — free tier (3k emails/mo) — ~5 min + 15 min DNS propagation

**URL:** https://resend.com/signup

- Sign up with `aegisdial@outlook.com`.
- **Domains → Add → aegisdial.com** (requires Step 3 done).
- Copy the DKIM + MX + TXT records Resend shows you → paste into Cloudflare DNS (one click each in the Cloudflare dashboard). Wait 5–15 min for verification.
- Once verified, **API Keys → Create → Full access**.

**Paste into** `.env.production`:
```
RESEND_API_KEY=re_xxxxxxxxxxxxxxx
```

---

## APNs push key (requires Step 1 done) — ~5 min

### ☐ 9. Generate APNs .p8 auth key

**URL:** https://developer.apple.com/account/resources/authkeys/list

1. Click **+** → name "AegisDial Push" → check **Apple Push Notifications service (APNs)** → **Continue → Register**
2. Download the `.p8` file. **Apple only lets you download it ONCE.** Save it somewhere safe — I suggest `~/aegisdial-backend/certs/AuthKey_XXXXXXXXXX.p8`
3. Note the **Key ID** (10 chars, shown on the key detail page)
4. Note your **Team ID** from Step 1

**Paste into** `.env.production`:
```
APNS_KEY_ID=ABCDE12345
APNS_TEAM_ID=XXXXXXXXXX
APNS_KEY_P8="-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMG... (entire contents of the .p8 file, including BEGIN/END lines)
-----END PRIVATE KEY-----"
APNS_PRODUCTION=true
```

**Important:** `APNS_KEY_P8` is multi-line. The `scripts/setup-fly-secrets.sh` script handles multi-line values wrapped in double quotes. Keep the double quotes.

---

## Deploy the backend to Fly (~5 min)

### ☐ 10. Push secrets + deploy

```bash
cd ~/aegisdial-backend
export PATH="$HOME/.fly/bin:$PATH"

# One-time app creation (already done if Step 2 succeeded)
fly apps create aegisdial-api --org personal 2>/dev/null || true

# Push all secrets from .env.production (skips TODO/blank)
bash scripts/setup-fly-secrets.sh --app aegisdial-api

# Deploy
fly deploy --app aegisdial-api
```

**Verify:**
```bash
curl -sS https://aegisdial-api.fly.dev/health
# → {"status":"ok","ts":"..."}
```

**Flip iOS to production:**
```swift
// ~/aegisdial-ios/AegisDial/Networking/APIConfig.swift
#if DEBUG
static let baseURL = URL(string: "http://127.0.0.1:3000")!
#else
static let baseURL = URL(string: "https://aegisdial-api.fly.dev")!   // ← ship value
#endif
```

---

## iOS side (requires a Mac) — see TESTFLIGHT_CHECKLIST.md

Once the backend is live and you have a Team ID from Step 1:

```bash
cd ~/aegisdial-ios
# On Mac:
brew install xcodegen
xcodegen generate
open AegisDial.xcodeproj
```

Fill in `DEVELOPMENT_TEAM` in project.yml before generating, or set it per-target in Xcode after. First build will surface any iOS-side compile issues (we've never run xcodebuild on this code).

---

## Quick-status checklist

Copy-paste as you go so you know what's left:

```
[ ] 1. Apple Developer Program enrolled        ← $99, 24hr wait
[ ] 2. Fly.io card on file
[ ] 3. aegisdial.com + .ai + .io + .app registered
[ ] 4. Sentry DSN in .env.production
[ ] 5. PostHog API key in .env.production
[ ] 6. Enzoic API key + secret in .env.production
[ ] 7. Google Safe Browsing key in .env.production
[ ] 8. Resend domain verified + API key in .env.production
[ ] 9. APNs .p8 downloaded + pasted into .env.production
[ ] 10. fly deploy succeeded + /health returns 200
[ ] 11. iOS project.yml DEVELOPMENT_TEAM set
[ ] 12. TestFlight build uploaded (see TESTFLIGHT_CHECKLIST.md)
```

---

## If something breaks

- **Sentry DSN rejected**: paste the whole string including `https://` and the trailing `/1234567`.
- **Resend domain not verifying**: DNS TTL. Wait 15 min, retry. If still failing after an hour, the TXT record probably has smart quotes from copy-paste — re-paste as plain text.
- **Fly deploy fails on build**: check `fly logs` — usually a missing env var. Re-run `bash scripts/setup-fly-secrets.sh --app aegisdial-api --dry-run` to confirm nothing's stuck as a TODO.
- **APNs 403 on first test push**: the `.p8` needs to be the private-key PEM with its own `BEGIN/END PRIVATE KEY` headers intact, wrapped in double quotes in the .env file.
- **iOS xcodegen fails**: you forgot `DEVELOPMENT_TEAM` in project.yml. Edit it before running `xcodegen generate`.

---

## Total cost breakdown (first year)

| Item | Cost |
|---|---|
| Apple Developer Program | $99 |
| Domains (.com/.ai/.io/.app) | ~$60 |
| Fly.io (free tier) | $0 |
| Neon Postgres (free tier) | $0 |
| Upstash Redis (free tier) | $0 |
| Sentry (free tier, 5k errors/mo) | $0 |
| PostHog (free tier, 1M events/mo) | $0 |
| Resend (free tier, 3k emails/mo) | $0 |
| Enzoic (free dev trial then $1.50–$2.50/user/mo at scale) | $0–30 |
| Google Safe Browsing (free, 10k/day) | $0 |
| **Total to launch** | **~$160 + $99/yr recurring** |

Post-launch, the vendor costs scale with users — well-covered by $49.99/mo revenue.
