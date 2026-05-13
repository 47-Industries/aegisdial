# Email Shield — design doc

Status: design • Started 2026-05-11 • Author: Jesiah + Claude

## Why this exists

Same gap as Live Shield and SMS Shield, just one surface over. Consumer
email security is broken — Gmail/Outlook spam filters catch obvious
spam but not targeted Business Email Compromise (BEC), which the FBI
puts at $43B in losses (IC3 2023). Every product that does BEC + inbox
audit is enterprise-only ($5–15/user/mo through IT procurement —
Proofpoint, Mimecast, Abnormal, Material, Cloudflare Area 1, Microsoft
Defender for O365). Individuals, sole-props, and SMB founders — the
exact people most targeted — have nothing.

**Pitch:** "Enterprise email security, for the rest of us."

**Positioning thread:**
- Live Shield catches scammers **on the phone**
- SMS Shield catches scammers **in texts**
- Email Shield catches scammers **in your inbox**
- Recovery catches what slipped through everywhere

One mental model, same red/yellow/green verdict scale, same explainable
reasons format, same `/v1/*/scans` shape.

## Three pillars

### Pillar 1 — Real-time inbox scanning

Every new message scored on arrival. Surfaced to iOS as a banner
("12 clean, 1 needs attention this week") and a per-message verdict
on the same scale as SMS Shield: `safe` / `suspicious` / `fraud`.

Signal sources (deterministic, cheap, no LLM dependency at launch):
- **BEC pattern library** — money-request + urgency + new-sender + wire-instructions, "your CFO needs this today", invoice-redirect, gift-card-purchase requests, payroll-redirect
- **Display-name vs from-domain mismatch** — `"Bank of America" <alerts@bofa-secure.support>`
- **Reply-to vs from-address divergence** — common BEC trick to siphon replies to attacker
- **Lookalike sender domain** — typosquatting on the user's contact list (paypa1.com, bankofarnerica.com); reuse the smishing-keyword + IDN-homograph logic
- **Attachment scan** — hash against VirusTotal (free tier 500/day, then API key); flag macro-bearing Office docs, ISO/IMG containers (common malware-delivery), encrypted ZIPs without legit context
- **URL reputation** — reuse `urlScan.ts` (already does GSB + heuristic + brand-domain allowlist)
- **New-contact-with-urgency** — first message from a sender never in the user's reply history that contains urgency tokens
- **Authentication failure** — SPF/DKIM/DMARC fail/none in the headers (provider-supplied)
- **Header anomalies** — Received-chain mismatch, suspicious mailer client

LLM augmentation deferred to a later phase behind its own flag — same
trust-first default as SMS Shield.

### Pillar 2 — Inbox dashboard

Per-message verdict timeline, last 30 days, with:
- Filter to flagged-only (the SMS-Shield UX shape)
- Per-thread risk drill-down: why this one was flagged
- "Show me messages from senders I've never replied to" view
- Sender-reputation roll-up: "this domain has been flagged 4 times across AegisDial users"

### Pillar 3 — Account compromise check

**The differentiator.** Nothing consumer does this today.

One-click "is my email compromised right now" report covering:
- **Inbox-rule audit** — BEC attackers' #1 move is adding a hidden
  forward rule (`from:CEO → forward to attacker → delete`). Pull
  every rule, flag forwards-to-external, delete-on-receive,
  hide-from-inbox rules
- **OAuth grant audit** — list every app with read/write access to
  the inbox. Flag apps the user doesn't recognize, apps with
  known-malicious fingerprints, apps with excessive scope
- **Suspicious-sent audit** — scan Sent folder for messages with
  wire-transfer / invoice / payroll-change language the user
  probably didn't send themselves
- **Login anomaly** — pull recent sign-in events from Gmail/Graph,
  flag geographic / device anomalies
- **HIBP cross-check** — is the address in a recent breach? Combined
  with above signals, "your email leaked AND something weird is
  happening" is the real-time-compromise signal
- **Free one-time scan, paid continuous monitoring** — same hook as
  Credit Karma. Maximizes top-of-funnel; converts users who see a
  real finding

## Provider support — ALL email providers

User confirmed 2026-05-11: support every provider at launch. Three
backends, one scoring engine.

| Provider tier | API | Push | Notes |
|---|---|---|---|
| **Gmail** | Gmail API + OAuth | Gmail Push (Pub/Sub) | First-class, lowest latency |
| **Microsoft 365 / Outlook.com** | Microsoft Graph + OAuth | Graph subscriptions | Same shape as Gmail; covers outlook.com, hotmail.com, live.com, consumer + sole-prop |
| **Generic IMAP fallback** | IMAP + per-provider OAuth where available, app-password otherwise | Polling (IDLE if supported) | iCloud, Proton, Yahoo, FastMail, custom domains. No push — poll every 60s with IDLE-aware connection pooling. App passwords for providers without OAuth |

Connector boundary: a single `EmailProvider` interface with three
implementations (`gmail.ts`, `microsoftGraph.ts`, `imap.ts`). Scoring
engine sees a normalized `IncomingMessage` shape regardless of
backend.

## Cross-pool integration (mirrors SMS Shield pattern)

Email Shield is **first-class data**, not a siloed feature. From day
one it participates in:

1. **Retention sweep** — `email_scans` table, 30d window
2. **GDPR Art. 20 export** — `/v1/users/me/export` includes
   `email_scans` rows (subject_excerpt is digit-redacted, body never
   stored)
3. **`/v1/stats/summary`** — `email_scams_blocked_30d` joins the
   home-screen "scams blocked" hook
4. **SMS-Shield → Recovery handoff** symmetric — `email_scan_id` to
   `/v1/recovery/start`, hydrates `scam_number` (if a phone number
   appears in the email body) and `description` (from
   `subject_excerpt`)
5. **Cross-pool scammer graph** — `a1HotNumbersPopulator` consumes
   sender domains AND phone-numbers-extracted-from-flagged-emails.
   Same promotion-gate pattern: number must already be in
   `recent_mentions`; email-only senders feed a separate
   sender-domain reputation table

## Privacy posture (non-negotiable)

- **OAuth tokens** envelope-encrypted at rest (same pattern as
  `recovery_*_ct` columns). Keychain on iOS.
- **Message body NEVER stored at rest.** We persist
  `external_message_id`, `from_address_hash`, `sender_domain`,
  `subject_excerpt` (80 chars, digit-redacted), `verdict`,
  `triggered_categories`, `reasons`, `url_findings`,
  `attachment_findings`. Same posture as SMS Shield.
- **Minimum OAuth scope** — request `gmail.readonly` not
  `gmail.modify`. We classify; we never delete or modify the user's
  mail. The iOS app can offer "open in Gmail" links but the backend
  has read-only.
- **Revocation respected** — if the user revokes the OAuth grant on
  Google/Microsoft's side, the next poll fails, we mark the account
  `revoked`, surface in iOS, and stop scoring within one poll cycle
- **Account deletion cascades** — `email_accounts.user_id` has
  `ON DELETE CASCADE`, so `DELETE /v1/users/me` wipes tokens +
  scans in one transaction

## Pricing tier — Pro-only

Confirmed 2026-05-11: Email Shield is paid-only, bundled into the
existing AegisDial Pro subscription. No free tier.

- **Pro subscribers**: full Email Shield — unlimited real-time
  inbox scanning, continuous compromise monitoring, the one-click
  "is my email compromised right now" report, Family Plan
  visibility for parents protecting kids / aging relatives
- **Free users**: paywall on every Email Shield surface. Upsell
  copy: "Pro covers your phone, your texts, AND your inbox."
- **Family Plan**: inherits Pro for all members; fanout to
  guardians

Enforcement: backend gate via `requireProTier` middleware (same
pattern as `/v1/recovery/*`). iOS gates the entire Email Shield tab
behind subscription state. No partial-access leak.

Marketing impact: simpler story ("one subscription, three shields"),
higher ARPU per Pro user, more honest about the unit economics
(OAuth + push subscriptions + attachment scanning have a real
per-user cost). Acquisition hook moves from "free email check" to
"Pro now includes Email Shield" — a real subscription expansion event.

## Data model (sketch)

### `email_accounts`
- `id UUID PK`
- `user_id UUID FK → users(id) ON DELETE CASCADE`
- `provider TEXT CHECK IN ('gmail', 'microsoft', 'imap')`
- `provider_account_id TEXT` — Google sub / MS oid / IMAP user
- `display_email TEXT` — for UI surface only
- `oauth_token_ct TEXT` — envelope-encrypted
- `oauth_refresh_token_ct TEXT NULL`
- `imap_host TEXT NULL`, `imap_port INT NULL` — for IMAP backend
- `app_password_ct TEXT NULL` — IMAP fallback
- `status TEXT CHECK IN ('active', 'revoked', 'auth_failed', 'paused')`
- `last_poll_at TIMESTAMPTZ`
- `last_history_id TEXT NULL` — Gmail historyId / Graph delta token / IMAP UIDVALIDITY+UIDNEXT
- `created_at`, `updated_at`

### `email_scans`
- `id UUID PK`
- `user_id UUID FK → users(id) ON DELETE CASCADE`
- `email_account_id UUID FK → email_accounts(id) ON DELETE CASCADE`
- `external_message_id TEXT` — Gmail/Graph message ID; for IMAP, UIDVALIDITY:UID
- `from_address_hash TEXT` — sha256 of normalized address
- `sender_domain TEXT` — eTLD+1 of sender, plaintext for sender-rep aggregation
- `subject_excerpt TEXT` — first 80 chars, digit-redacted
- `fraud_score SMALLINT CHECK 0..100`
- `verdict TEXT CHECK IN ('safe', 'suspicious', 'fraud')`
- `triggered_categories JSONB`
- `reasons JSONB`
- `url_findings JSONB`
- `attachment_findings JSONB`
- `scanned_at TIMESTAMPTZ`
- Indexes: `(user_id, scanned_at DESC)`, partial
  `(user_id, scanned_at DESC) WHERE verdict IN ('suspicious','fraud')`,
  `(sender_domain, scanned_at DESC) WHERE verdict IN ('fraud')` for
  global sender-rep rollups

### `email_compromise_reports`
- `id UUID PK`
- `user_id UUID FK → users(id) ON DELETE CASCADE`
- `email_account_id UUID FK → email_accounts(id) ON DELETE CASCADE`
- `overall_verdict TEXT CHECK IN ('clean', 'concerns', 'compromised')`
- `findings JSONB` — typed: inbox_rules, oauth_grants,
  suspicious_sent, login_anomalies, breach_exposure
- `generated_at TIMESTAMPTZ`

## Phase plan (estimate ~18–22 phases, mirror Live Shield v4 cadence)

Each phase: design → code → tests → adversarial subagent → fix
findings → commit → push.

**Foundation**
- P1 — Data model: migrations for `email_accounts`, `email_scans`,
  `email_compromise_reports`; retention sweep entries; GDPR export
  scaffolding placeholders
- P2 — `EmailProvider` interface + `IncomingMessage` normalized type
- P3 — Gmail backend: OAuth flow, history-id polling, message fetch

**Provider expansion (parallel-safe)**
- P4 — Microsoft Graph backend (delta queries, push subscriptions)
- P5 — IMAP backend (IDLE, app-password OAuth fallback)

**Scoring**
- P6 — BEC pattern library + display-name/from-domain mismatch
  detector + reply-to divergence
- P7 — Attachment scan service (VirusTotal integration with cache +
  rate budget)
- P8 — Lookalike sender detector (reuse smishing-keyword + IDN
  homograph from `urlScan.ts`)
- P9 — Authentication header parser (SPF/DKIM/DMARC)
- P10 — Score composition (mirror `smsManualScore.ts`)

**Routes**
- P11 — `POST /v1/email/accounts/link` (OAuth init)
- P12 — `GET /v1/email/scans` (per-user history, flagged_only filter)
- P13 — `GET/POST /v1/email/settings`
- P14 — `POST /v1/email/compromise-check` (the one-click report)

**Compromise check engine**
- P15 — Inbox-rule audit (Gmail filters, Graph mailFolders rules, IMAP
  Sieve)
- P16 — OAuth grant audit (Google account permissions, MS Graph
  consents)
- P17 — Suspicious-sent audit
- P18 — Login anomaly detector
- P19 — HIBP integration + composite verdict

**Cross-pool**
- P20 — Retention sweep entry for `email_scans` +
  `email_compromise_reports`
- P21 — GDPR export inclusion
- P22 — `/v1/stats/summary` integration + Recovery handoff
  (`email_scan_id`)

**Ship readiness**
- P23 — Admin dashboards (`/admin/email-shield/summary`)
- P24 — Operator runbook (`docs/EMAIL_SHIELD_OPERATOR_RUNBOOK.md`)
- P25 — End-to-end scenario test (mirror `test/v4ScenarioE2E.test.ts`)

## What's NOT in v1

- LLM-augmented scoring (deferred behind future
  `V4_EMAIL_LLM_ENABLED`)
- Outbound DLP (preventing the user from sending sensitive data) —
  scoped to a v2 feature
- Full mailbox migration / re-scan-the-archive (start with
  forward-looking scoring only)
- Multi-tenant org features (we are consumer-first)
- Sending pre-emptive replies on the user's behalf

## Writer-side invariants (locked in via P1 adversarial review 2026-05-11)

These are NOT schema constraints — they're rules the future writers
(P2-P19) must follow. Recorded here so they don't slip between phases.

- **H1 — `from_address_hash` MUST use `indexHash()` from
  `src/lib/crypto.ts`, NOT raw `createHash('sha256')`.** Raw SHA-256
  of `jeff@enterprise.com` is rainbow-table enumerable; a Postgres
  leak would hand an attacker a directory of who-emails-whom.
  `indexHash` peppers with `HASH_PEPPER` from `KEY`. Land a unit test
  in P6 that pins the expected peppered output for a known plaintext.

- **H3 — `/v1/email/compromise-check` MUST be per-(user, account)
  rate-limited to ~1 per hour AND dedupe-cache: if the previous
  report is < 6h old and `overall_verdict='clean'`, return the
  cached row instead of running detectors + inserting a new one.**
  Without this, a buggy iOS background refresh could write 24-90
  reports per user per day. Lands in P14.

- **L3 — Subject excerpts MUST go through a digit-redaction +
  80-char-truncation helper at INSERT time.** Build `redactSubject(s)`
  alongside the existing `redactSensitiveDigits` in
  `services/sentinelMatcher.ts`. Land alongside P10 score
  composition.

- **L4 — `email_compromise_reports.findings` JSONB shape MUST be
  validated by a zod schema at the writer boundary before INSERT.**
  Will live in `src/services/email/compromiseCheck.ts`. Update the
  column COMMENT to reference the schema once it lands.

- **sender_domain MUST be the eTLD+1, not the full hostname.** Use
  a public-suffix-list package (`tldts` or `psl`) in the parser
  helper. The reputation rollup query joins on this column;
  storing `mail.google.com` instead of `google.com` defeats the
  feature.

- **OAuth scope MUST be read-only.** Gmail: `gmail.readonly`. MS
  Graph: `Mail.Read` (not `Mail.ReadWrite`). IMAP: read-only SELECT.
  Documented in iOS permission prompt copy too.

## Open questions

- Attachment scan vendor: VirusTotal (free 500/day, then 4 req/min)
  vs ClamAV self-hosted (no quota, more ops). Default plan:
  VirusTotal first, swap to ClamAV behind a flag if quota becomes a
  problem
- Gmail push vs polling: push requires Pub/Sub project setup +
  webhook receiver. Plan: ship with 60s polling P1, add push in a
  later phase
- IMAP credentials storage: app-password is plaintext-equivalent;
  envelope encrypt and rotate-friendly. No OAuth for legacy IMAP
  providers — accept the security trade-off, document it loudly
