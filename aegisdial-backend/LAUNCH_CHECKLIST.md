# AegisDial Launch Checklist

> ⚠️ **Partially stale.** Section 4 ("Fly.io production secrets audit")
> and any `fly secrets set …` commands assume Fly.io. Production is on
> **Railway** — substitute "Railway dashboard → service → Variables".
> `*.fly.dev` URLs don't resolve; the live API is at
> `https://aegisdial-api-production.up.railway.app`. Everything else
> (Apple, App Store Connect, Stripe, RevenueCat steps) is still valid.

Everything that requires your hands on an external system. The code side is
done; this list is what you — Kyle — need to run, click, or configure before
TestFlight goes wide.

Work top to bottom. Each step has an exact command or link.

---

## 1. Production encryption key (HARD BLOCKER)

The server now refuses to start in production if `DATA_ENCRYPTION_KEY` is the
dev default. Generate a real one and set it as a Fly secret:

```bash
openssl rand -base64 32
# copy the output, then:
fly secrets set DATA_ENCRYPTION_KEY='<paste the value>' -a aegisdial
```

**Critical:** save a copy of this key somewhere you will not lose (1Password,
Bitwarden). Losing it means every encrypted row is permanently unreadable —
transcripts, breach monitors, recovery evidence, support tickets.

---

## 2. Run migrations against production Neon

Four new migrations were added this session:

- `018_envelope_encryption.sql` — adds `_ct` columns to monitored_identifiers + recovery_evidence
- `019_age_gate.sql` — adds `users.dob_year`
- `020_encrypt_transcripts.sql` — adds `_ct` columns to transcript_events + scam_phrase_hits
- `021_encrypt_support_tickets.sql` — adds `_ct` columns to support_tickets
- `022_encrypt_recovery_session.sql` — adds `_ct` columns to recovery_sessions

Run against production:

```bash
# from ~/aegisdial-backend, with DATABASE_URL pointed at prod Neon:
DATABASE_URL='<prod-neon-url>' npm run migrate
```

All migrations are additive and idempotent (`IF NOT EXISTS` guards). Safe to
re-run.

---

## 3. App Store Connect price update (2026-05-12 cutover)

The active tier (per Jesiah's locked pricing):

| Product ID | Price | Notes |
|---|---|---|
| `com.aegiadial.ios.pro.monthly` | **$49.99/mo** | 3 lines |
| `com.aegiadial.ios.pro.yearly` | **$399/yr** | 3 lines, "Save $200 vs monthly" |
| `com.aegiadial.ios.recovery.session` | **$149 one-time** | Non-consumable IAP, grants 14-day Pro on verify |
| `com.aegiadial.ios.recovery.monthly` | **$99/mo** | Recovery Concierge tier |
| `com.aegiadial.ios.recovery.yearly` | **$899/yr** | Recovery Concierge tier |

**Deprecated (existing subs honored, NOT offered to new buyers):**
- `com.aegiadial.ios.pro.family_plus.monthly` ($69.99/mo, 3 + 2 add-on lines). Set in ASC Connect to "available for existing subscribers, not for new purchases."

App Store Connect → My Apps → AegisDial → Subscriptions → Price Schedule
for each entry. Save + wait ~1 hr for propagation. StoreKit returns Apple's
price, not the code's — keep these in sync or the paywall and purchase
sheet diverge.

---

## 4. Fly.io production secrets audit

Run this once, make sure every required secret is set:

```bash
fly secrets list -a aegisdial
```

Expected (minimum for boot):
- `DATABASE_URL` — Neon connection string
- `REDIS_URL` — Upstash connection string
- `API_SHARED_SECRET` — any string ≥ 8 chars
- `JWT_SECRET` — random 32+ char secret (`openssl rand -hex 32`)
- `DATA_ENCRYPTION_KEY` — from step 1 above
- `NODE_ENV=production` — set automatically via fly.toml

Optional but strongly recommended for launch:
- `SENTRY_DSN` — error tracking
- `POSTHOG_API_KEY` — product analytics
- `RESEND_API_KEY` — transactional email
- `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_KEY_P8` / `APNS_PRODUCTION=true` — push
- `ENZOIC_API_KEY` / `ENZOIC_API_SECRET` — breach monitoring (else mock)

---

## 5. iOS build and TestFlight

See `~/aegisdial-ios/TESTFLIGHT_CHECKLIST.md` for the full Xcode → TestFlight
procedure. Key items this session changed:

- **Bundle entitlement change:** all 4 targets now declare
  `keychain-access-groups = $(AppIdentifierPrefix)com.aegisdial.app.shared`.
  Re-generate provisioning profiles in App Store Connect → Certificates,
  Identifiers & Profiles after the entitlement change, otherwise signing
  fails.
- **PrivacyInfo.xcprivacy** now present in all 4 targets — required for iOS
  17+ submission.
- **New product ID price** in the App Store Connect Subscriptions tab
  (step 3 above).

---

## 6. Domain + legal

These were in the fundraise 30-day action list and are still open:

- Register `aegisdial.com` + `.ai` / `.io` / `.app` at Cloudflare Registrar (~$60)
- Point `aegisdial.com` → the Fly app (A record to Fly anycast IPs or CNAME to
  `aegisdial.fly.dev`)
- Terms / Privacy pages live at `/legal/terms.html` and `/legal/index.html`
  in the Fly app — confirm they load at `https://aegisdial.com/legal/...`
  after DNS
- Paste both URLs into App Store Connect → App Information → Privacy Policy URL
  and Terms of Use URL

---

## 7. Smoke test before going wide

Once 1–5 are done, a 10-minute smoke test:

```bash
# Server health
curl https://api.aegisdial.com/health

# Auth (Apple) — use a real id_token from a signed-in build
curl -X POST https://api.aegisdial.com/auth/apple \
  -H 'content-type: application/json' \
  -d '{"id_token":"<real-token>","dob_year":1985}'

# Verdict (replace with a real user JWT from the above)
curl -X POST https://api.aegisdial.com/v1/verdict \
  -H 'content-type: application/json' -H 'authorization: Bearer <jwt>' \
  -d '{"number":"+18005281000"}'
```

Then from the iOS app: sign in → paywall → subscribe (sandbox) → open
Live Shield → verify consent sheet → start a demo call → confirm transcript
lands encrypted in DB:

```sql
-- Against prod Neon
SELECT id, text IS NULL AS text_null, text_ct LIKE 'v1:%' AS encrypted
  FROM transcript_events
 ORDER BY received_at DESC LIMIT 5;
-- Expected: text_null=true (or empty-string placeholder), encrypted=true
```

---

## 8. Go-wide readiness signals

Before pushing to TestFlight public beta, these should be green:

- [ ] All 5 launch-blocker steps above complete
- [ ] 77/77 tests pass (`npm test`)
- [ ] TypeScript clean (`npm run typecheck`)
- [ ] Fly deploy succeeds and `/health` returns 200
- [ ] Apple sign-in completes end-to-end in sandbox
- [ ] StoreKit sandbox purchase completes and entitlement flips
- [ ] Live Shield session end-to-end (transcript → encrypted row → verdict
      → guardian alert on critical)
- [ ] Recovery Concierge: start → complete 3 steps → mark done
- [ ] Guardian Dashboard renders at least one real alert

---

## 9. Out-of-scope but on-deck

These are not launch-blockers but are on the next-30-days list:

- Stripe Atlas incorporation + 83(b) election (48-hour window after stock grant)
- USPTO trademark filing — classes 9 + 42
- App icon + pitch deck designer (Dribbble, ~$1,500 total)
- First investor conversations scheduled
- One pilot group secured (local credit union / AARP chapter / police dept)

See `~/aegisdial-fundraise/CAPITAL_PLAN.md` for the staged raise plan.
