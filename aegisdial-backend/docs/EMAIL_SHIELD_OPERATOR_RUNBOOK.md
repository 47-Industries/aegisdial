# Email Shield — Operator Runbook

**Audience:** anyone deploying, troubleshooting, or auditing Email Shield in prod or staging.
**Prereq:** Migrations 057–061 applied; the Email Shield routes (`src/routes/emailShield.ts`) and admin routes (`src/routes/adminEmailShield.ts`) registered in `src/server.ts`.

Email Shield is Pro-only. Unlike Live Shield v4, Email Shield does NOT ship behind feature flags — once the migrations land and the OAuth env vars are set, the feature is live for any Pro user who links an inbox. This runbook is what you need to keep the lights on.

---

## 1. Mental model

Email Shield has three pillars. Each is independently degradable: a Pillar 3 failure does not take Pillar 1 or 2 down with it.

| Pillar | Surface | What it does | Dependencies |
|---|---|---|---|
| **1 — Real-time scanning** | `POST /v1/email/scan`, provider polling worker | BEC + phishing + lookalike + attachment heuristics per incoming message | OAuth tokens (Gmail/Microsoft) or IMAP creds, scoring engine |
| **2 — Dashboard** | `GET /v1/email/scans`, `GET /v1/stats/summary` | Scan history, verdict timeline, home-screen badges | `email_scans`, `email_tamper_alerts` tables |
| **3 — Compromise check** | `POST /v1/email/compromise-check` | Five-detector audit: inbox rules, OAuth grants, login anomalies, suspicious-sent, HIBP breach exposure | Provider API access + `HIBP_API_KEY` (optional) |

Plus a fourth surface that sits between Pillars 1 and 3:

| **Tamper alerts** | `GET/POST /v1/email/tamper-alerts*` | "Did you delete this?" push when a non-fraud email is deleted within 10 min of arrival | Polling worker observes delete events |

---

## 2. Required env vars

Set on Fly via `fly secrets set ... -a <app>` (mirrors the V4 pattern).

```bash
# Gmail OAuth — required for Gmail provider
fly secrets set GOOGLE_OAUTH_CLIENT_ID=... -a <app>
fly secrets set GOOGLE_OAUTH_CLIENT_SECRET=... -a <app>
fly secrets set GOOGLE_OAUTH_REDIRECT_URI=https://<app>.fly.dev/v1/email/oauth/callback/gmail -a <app>

# Microsoft Graph OAuth — required for Microsoft provider
fly secrets set MICROSOFT_OAUTH_CLIENT_ID=... -a <app>
fly secrets set MICROSOFT_OAUTH_CLIENT_SECRET=... -a <app>
fly secrets set MICROSOFT_OAUTH_REDIRECT_URI=https://<app>.fly.dev/v1/email/oauth/callback/microsoft -a <app>

# HIBP — optional, degrades gracefully if unset.
# Without this, the breach_exposure detector returns
# { email_checked: false, reason_skipped: 'no_api_key' } and the
# compromise check still works with the other 4 detectors.
fly secrets set HIBP_API_KEY=... -a <app>
```

**IMAP needs no env vars.** It accepts app-password / OAuth-bearer credentials at link time, stored envelope-encrypted in `email_accounts.credentials_ciphertext`.

---

## 3. Admin dashboards

All routes are bearer-auth via `requireBearer` (shared secret = `$API_SHARED_SECRET`). All time-bounded; no per-user PII; aggregate-only.

| Endpoint | Returns |
|---|---|
| `GET /v1/admin/email-shield/summary` | Active Pro inboxes, per-provider counts, scans 24h/7d/30d, verdict distribution 7d, compromise reports 7d, tamper alerts 7d |
| `GET /v1/admin/email-shield/scans-timeline` | Per-day buckets 30d: `{date, scans, fraud_count, suspicious_count}` |
| `GET /v1/admin/email-shield/top-fraud-senders` | Top 20 sender_domains by fraud verdict, last 30d |
| `GET /v1/admin/email-shield/compromise-distribution` | Per-finding-key counts (which detector is producing signal) |
| `GET /v1/admin/email-shield/tamper-alert-resolution` | Funnel %: confirmed / denied / expired / pending, last 30d |

Quick health probe (paste-and-run):

```bash
curl -H "Authorization: Bearer $API_SHARED_SECRET" \
  https://<app>.fly.dev/v1/admin/email-shield/summary | jq .
```

If this returns 200 with non-empty counts, the migrations are applied and the route registration is wired.

---

## 4. Cutover playbook

### Stage A — migrations

```bash
# Apply 057-061 in order:
psql $DATABASE_URL -f db/migrations/057_email_shield_accounts.sql
psql $DATABASE_URL -f db/migrations/058_email_shield_scans.sql
psql $DATABASE_URL -f db/migrations/059_email_shield_compromise_reports.sql
psql $DATABASE_URL -f db/migrations/060_email_shield_settings.sql
psql $DATABASE_URL -f db/migrations/061_email_tamper_alerts.sql
```

The migrations are idempotent (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`). Re-running is a no-op.

### Stage B — env vars

Set GOOGLE_*, MICROSOFT_*, and (optionally) HIBP_API_KEY per §2. Fly restarts the app on each `fly secrets set`.

### Stage C — verify routes

```bash
curl -H "Authorization: Bearer $API_SHARED_SECRET" \
  https://<app>.fly.dev/v1/admin/email-shield/summary | jq .active_inboxes
```

Expected: `0` on a fresh deploy. Any 5xx means migrations didn't apply or `adminEmailShieldRoutes` isn't registered in `server.ts`.

### Stage D — smoke an inbox link

Use a test Gmail account:

```bash
# 1. Get authorization URL
curl -H "Authorization: Bearer $USER_JWT" \
  https://<app>.fly.dev/v1/email/link/start \
  -d '{"provider":"gmail"}' -H 'Content-Type: application/json'

# 2. Open returned auth_url in browser, complete OAuth
# 3. Backend completes the callback and inserts an email_accounts row
# 4. Verify:
curl -H "Authorization: Bearer $USER_JWT" \
  https://<app>.fly.dev/v1/email/accounts | jq .
```

A linked account should show `status: 'active'`. If `status: 'auth_required'`, the OAuth token refresh failed — re-link.

### Stage E — smoke a compromise check

```bash
curl -X POST -H "Authorization: Bearer $USER_JWT" \
  https://<app>.fly.dev/v1/email/compromise-check \
  -d '{"email_account_id":"<account_id>"}' -H 'Content-Type: application/json' | jq .
```

Expected response shape:

```json
{
  "id": "...",
  "email_account_id": "...",
  "overall_verdict": "clean | concerns | compromised",
  "findings": { "inbox_rules": [...], "oauth_grants": [...], ... },
  "generated_at": "2026-05-12T...",
  "from_cache": false
}
```

---

## 5. Common failure modes

### HIBP 429 / `reason_skipped: 'rate_limited'`

Symptom: `breach_exposure.reason_skipped === 'rate_limited'` in compromise-check responses.

Cause: HIBP enforces a per-IP rate limit (~1.5s between requests on free tier, faster on paid). Bursts from many concurrent compromise-checks blow through it.

Fix: results are cached 6h on `sha256(email)` — repeat checks for the same inbox are free. 429s only happen on first-call bursts. If sustained, upgrade the HIBP tier or pace the per-(user, account) rate limit lower (already capped at 1/hour).

### OAuth token refresh failure

Symptom: `email_accounts.status` flips to `'auth_required'`. Compromise check returns `502 compromise_check_failed`.

Cause: Google / Microsoft revoked the refresh token (user removed grant, or password reset, or 6-month inactivity for unverified apps).

Fix: user must re-link the inbox via `/v1/email/link/start`. The status flip is intentional — we don't auto-retry forever and burn API quota.

### IMAP timeout

Symptom: provider call hangs ~30s then `502 compromise_check_failed`.

Cause: user's IMAP server is slow or rejecting bursts. Common with Proton (which has rate limits more aggressive than Gmail).

Fix: per-call timeout is 30s in `ImapProvider`. If a specific provider domain (`proton.me`, `fastmail.com`) is consistently slow, raise the timeout for that provider's path.

### Tamper-alert push not arriving

Symptom: user reports deleting an email and never seeing the "Did you delete this?" push.

Diagnostic ladder:
1. **Verdict was `fraud`** → expected; we don't push for fraud-verdict deletes (the user is supposed to delete those).
2. **Delete outside 10-min window** → expected; window is short by design (real attackers delete within seconds).
3. **Pending cap reached** → user already has 5 pending tamper alerts; subsequent deletes silently skip. Visible via `/v1/email/tamper-alerts?status=pending`.
4. **APNs failure** → push is best-effort; the DB row exists. Surfaces on next iOS foreground via `GET /v1/email/tamper-alerts`.

Check the detector's skip reasons via the metric `email_shield.tamper_skipped` grouped by tag `reason`.

### Compromise verdict stuck on `concerns`

Symptom: user runs compromise-check repeatedly; gets `concerns` every time even though they remediated.

Cause: `clean` reports cache for 6h; `concerns` / `compromised` reports do NOT cache. The next call re-runs all 5 detectors. If they keep returning the same finding, the issue isn't cache — it's that the finding is still present.

Common culprit: an OAuth grant the user thought they revoked but is actually still active (Google's revoke page sometimes lags). Drill into `findings.oauth_grants` to see which app is still granted.

---

## 6. Retention model

| Table | Retention | Sweeper |
|---|---|---|
| `email_accounts` | Indefinite (until user unlinks) | None — cascade-deletes on user delete |
| `email_scans` | 30 days | `retentionSweeper.ts` daily 04:07 UTC |
| `email_compromise_reports` | 90 days | `retentionSweeper.ts` |
| `email_tamper_alerts` | **Effective ~30 days** (FK cascade from `email_scans`); 90d ceiling | `retentionSweeper.ts` + `expireStaleTamperAlerts()` for 72h pending→expired flip |

The tamper-alert effective retention is shorter than the 90d ceiling because `scan_id REFERENCES email_scans(id) ON DELETE CASCADE` — when a scan is swept at 30d, its child tamper alerts go with it. This is deliberate; the alert is meaningless without the scan it points to.

---

## 7. Rate limits

Per-route, per-user. All keyed via `userKeyedLimit` so one user can't starve another.

| Route | Limit | Purpose |
|---|---|---|
| `POST /v1/email/scan` | 60/min | Manual paste scans |
| `POST /v1/email/compromise-check` | 10/hour route-level; **1/hour per (user, email_account_id)** | Cap real provider round-trips |
| `GET /v1/email/tamper-alerts` | 60/min | iOS foreground polling |
| `POST /v1/email/tamper-alerts/:id/respond` | 30/min | User taps confirm/deny |
| `GET /v1/email/scans` | 60/min | History scroll |
| `POST /v1/email/link/start`, `/callback` | 5/min | OAuth burst protection |

The per-(user, account) hourly cap on compromise-check is enforced INSIDE the handler via Redis (`cacheGet`/`cacheSet`), AFTER the cached-clean check. A cache hit doesn't consume quota.

---

## 8. Privacy posture

| What we store at rest | Where | Notes |
|---|---|---|
| Provider credentials (OAuth tokens, IMAP password) | `email_accounts.credentials_ciphertext` | Envelope-encrypted with `DATA_ENCRYPTION_KEY` |
| User's email address (display_email) | `email_accounts.display_email` | Plaintext — needed to render "linked: foo@gmail.com" in iOS |
| Sender domain | `email_scans.sender_domain` | eTLD+1 only, plaintext, never local-part |
| Subject excerpt | `email_scans.subject_excerpt` | 80-char cap + digit-redacted at write time |
| Compromise-check findings | `email_compromise_reports.findings` (JSONB) | Descriptive only — never raw bodies, tokens, or IPs |
| Tamper-alert sender/subject | `email_tamper_alerts.{sender_domain,subject_excerpt}` | Same redaction as `email_scans` |

What we do NOT store: message bodies (post-scan), OAuth refresh tokens in plaintext, IP addresses of senders, attachment binaries (we only hash filenames + extensions).

Push notifications use GENERIC bodies — sender_domain and subject_excerpt are carried in the APNs `data` payload, rendered only inside the unlocked app. This avoids leaking inbox identity to lock screen, CarPlay, watchOS Continuity, etc.

---

## 9. Operational guarantees (pinned by tests)

| Property | Pinned by |
|---|---|
| Cross-user `email_scan_id` recovery handoff returns 404, never opens cross-user session | `test/recoveryEmailHandoff.test.ts` |
| Tamper-alert respond endpoint enforces user_id scoping | `test/inboxTamperDetector.test.ts` (cross-user case) |
| Tamper-alert push body is generic (no sender_domain on lock screen) | `test/inboxTamperDetector.test.ts` (privacy assertion) |
| Cron-expired tamper alerts do NOT set `responded_at` | `test/inboxTamperDetector.test.ts` (H3 case) |
| Compromise-check race: 3 concurrent denials produce ≤1 compromise report | `test/inboxTamperDetector.test.ts` (race-safe case) |
| HIBP API key never appears in logs / errors / response | `test/hibpBreachCheck.test.ts` |
| HIBP cache deduplicates repeat calls | `test/hibpBreachCheck.test.ts` |
| Suspicious-sent never echoes user-supplied text in `reason` | `test/suspiciousSentAudit.test.ts` |
| Stats summary returns 200 with all zeros when any email_* table is missing (rolling-deploy state) | `test/statsSummary.test.ts` |
| Admin routes all 401 without bearer | `test/adminEmailShield.test.ts` |

---

## 10. Quick reference — composite verdict logic

```ts
// emailShield.ts compromise-check handler
if (hasExternalForward || hasHighSent) overall_verdict = 'compromised';
else if (Object.keys(findings).length > 0) overall_verdict = 'concerns';
else overall_verdict = 'clean';
```

Where:
- `hasExternalForward` = inbox-rules detector found a `forward_to_external` rule.
- `hasHighSent` = suspicious-sent detector found a `confidence === 'high'` outbound BEC pattern.

Breach exposure, OAuth grants, and login anomalies alone never escalate beyond `concerns` — they're useful context but not high-confidence active-compromise signals.

---

## 11. Phase ledger

| Phase | Surface |
|---|---|
| P1 | Migrations 057–061, data model |
| P2 | `EmailProvider` interface, normalized `IncomingMessage` type |
| P3–P5 | Gmail, Microsoft Graph, IMAP providers |
| P6–P10 | Scoring engine — BEC patterns, attachments, lookalikes, auth headers, composition |
| P11–P14 | `/v1/email/*` route surface |
| P15–P19 | Compromise-check engine (inbox rules, OAuth grants, login anomalies, suspicious-sent, HIBP) + tamper-alert detector |
| P20–P22 | Retention sweep, GDPR export coverage, stats summary integration, recovery-pool handoff |
| P23 | Admin dashboard `/v1/admin/email-shield/*` |
| P24 | This runbook |
| P25 | End-to-end scenario test |

All on branch `feat/live-shield-v4-phase0`.
