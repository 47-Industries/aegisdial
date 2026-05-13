# Recovery Shield + Identity Shield — Strategic + Product Spec

**Status:** Brainstorm draft, 2026-05-12. Two paired features that close the AegisDial loop.
**Pitch:** Recovery finds a scam. Identity prevents the next one. Both share data.

---

## 1. The thesis

Today AegisDial is three real-time shields (Live / SMS / Email) plus a recovery flow tucked inside Pro. That's good but it's still **reactive on intake, reactive on recovery** — we only see a user once they've already been targeted.

Adding two new shields completes the loop:

```
                    ┌────────────────────────────────┐
                    │       USER LIFE-CYCLE          │
                    │                                │
                    │   pre-incident   post-incident │
                    │        ↓               ↑       │
                    │   IDENTITY        RECOVERY     │
                    │   SHIELD          SHIELD       │
                    │   (watch what     (act on what │
                    │    might happen)   just hit)   │
                    └────────────────────────────────┘
                                ↕
                    feeds data both ways: every recovery case
                    seeds prevention intel; every prevention
                    miss surfaces a new recovery case
```

**Recovery Shield = customer acquisition.** People who got scammed Google "how do I get my money back" — we own that funnel.

**Identity Shield = retention engine.** Pro users keep their sub active because they get a daily/weekly "we're watching" push and an alert when their data surfaces in a new dump.

**Both stay inside Pro.** No separate tier. The retention math falls apart if churning users lose the shield that gave them the daily emotional reason to renew.

---

## 2. Naming + family

Existing family:
- **Live Shield** — calls
- **SMS Shield** — texts
- **Email Shield** — inbox

New family members:
- **Recovery Shield** — post-incident: trace, document, refer
- **Identity Shield** — pre-incident: watch, alert, feed the other shields

**Marketing line:** "Five shields. One app. The only consumer-grade fraud product that prevents AND recovers."

---

## 3. Recovery Shield — "build it as a strong product"

The current Recovery Concierge is good but tucked-away. Recovery Shield is the same flow, **rebranded, expanded, and front-doored** with substantial new capability.

### What's already shipped (live in Pro)
- Multi-step recovery flow per scam-type (60+ playbooks)
- Companion chat (AI counselor for emotional + procedural support)
- Family/guardian-alert fan-out
- SMS Shield → Recovery handoff (sms_scan_id)
- Email Shield → Recovery handoff (email_scan_id) — shipped today

### What's new in Recovery Shield v1

**Five capability pillars:**

1. **Trace.** Two parallel sub-features:
   - **Wire / ACH trace agent** — guided flow that auto-fills the user's bank chargeback form, generates the SWIFT recall letter for international wires, walks the user through Reg E dispute language. Most banks recall within 72h if the user pushes correctly; most users don't know to push.
   - **Crypto chain trace** — on-chain analysis via Etherscan / Blockchair / Arkham APIs. Tags exchange-deposit addresses (Binance, Coinbase, Kraken hot wallets). Generates a "frozen-funds petition" letter to the exchange's legal department with the on-chain evidence attached. ~3–5% recovery rate is candid; we don't oversell.

2. **Document.** Auto-generated legal packet:
   - **FBI IC3 complaint** (form filling + narrative)
   - **FTC complaint** (ReportFraud.ftc.gov)
   - **CFPB complaint** (for bank-side failures)
   - **State AG complaint** (50-state form library)
   - **Notarized affidavit template** (for insurance claims)
   - **Demand letter** to the scammer-controlled entity if recoverable (LLC, exchange, payment processor)
   - **Credit-freeze + fraud-alert request letters** to the three bureaus
   - **Police report assistance** — state-specific form auto-fill plus a "what to say to the desk officer" script

3. **Refer.** A vetted specialist marketplace inside the app:
   - **Asset-recovery attorneys** (state-licensed, vetted, top-of-bar)
   - **Blockchain forensics firms** (CipherTrace, Chainalysis-tier; or smaller for retail cases)
   - **Identity-restoration specialists** for SSA / IRS / bank reissue
   - **Cyber-insurance claims assistance** (consult on home / cyber policy use)
   - Specialists pay AegisDial a **referral fee** (10–20% of their fee on the engagement) — *NOT* the user. The user pays the specialist directly at their normal rate. We never take a cut of recovered funds.

4. **Coach.** Deeper integration of the existing Companion:
   - 24/7 AI coach trained on recovery procedure (not just emotional support)
   - Real-time question answering during a bank-fraud-line call ("they're asking for X, what do I say?")
   - Step-state tracking — knows where the user is in the flow and what's blocked
   - Multi-language (priority: English, Spanish — high prevalence in scam victim demographics)

5. **Restore.** Identity restoration playbooks:
   - **SSN compromise** — 12-step playbook ending in IRS Form 14039 + SSA appointment
   - **Bank takeover** — account closure + reissue across all four major banks
   - **Email takeover** — Gmail/Microsoft account recovery (works with Email Shield's compromise-check findings)
   - **Apple ID / iCloud takeover** — separate playbook (Apple has its own recovery process)
   - **Crypto exchange account lock** — major-exchange-specific (Coinbase, Kraken, Binance.US)

### Pricing

- **Recovery Concierge** (current) — included in Pro at no extra charge. Covers steps 1–5 procedural guidance, doc generation up to the basic packet, companion chat.
- **Recovery Plus** — **$249 one-time** unlock per case, available for losses ≥ $5,000 (soft floor; users below threshold can still pay). Adds:
  - Wire/crypto trace agents
  - Full legal packet (IC3 / FTC / CFPB / state AG / demand letter / affidavit)
  - Specialist warm-handoff (one referral included; subsequent referrals are user-pays-specialist)
  - Priority coach (1-hour SLA on companion responses; otherwise default ~5min)
- **NO success fee.** Ever. We never make money from the user's loss itself.
  - Why: regulatory blast radius (state recovery-services licensing, money-transmitter laws), brand integrity ("the only product that doesn't profit from your loss"), economic reality (success rates don't justify the model).
  - We make money from: Pro subscription + Recovery Plus unlock + specialist referral fees.

### Pricing rationale (anchor table)

| Provider | Service | Cost |
|---|---|---|
| Asset-recovery attorney | Retainer for crypto case | $1,500–$5,000 |
| PI for wire-trace work | 10-hour case | $1,500–$3,000 |
| LifeLock / Aura | Annual ID-theft protection | $200–$330/yr |
| Notario-style scam recovery (often illegal) | Per-case | $500–$5,000 + 30% success |
| **Recovery Plus (us)** | Per-case, no success fee | **$249 flat** |

**$249 is the cheapest legitimate option in the category by a wide margin AND comes inside an app the user already trusts.** That's the pitch.

### Recovery Shield — technical surfaces to build

| Surface | Effort | New table? |
|---|---|---|
| `wire_trace_cases` table — per-case state, dispute letter generated, bank ack received | M | Yes |
| `crypto_trace_cases` table — wallet, chain, hops analyzed, exchange tagged | M | Yes |
| `legal_documents` table — generated doc PDFs (or HTML), download links, signing state | M | Yes |
| `specialist_referrals` table — referral_id, specialist_id, case_id, status, fee owed | M | Yes |
| `specialists` table — vetted partners, capabilities, jurisdictions, commission % | S | Yes |
| `recovery_plus_purchases` table — Apple IAP receipt, case_id, expires_at (none — perpetual) | S | Yes |
| `/v1/recovery/plus/purchase` — IAP-verify + unlock | S | No |
| `/v1/recovery/trace/wire` + `/v1/recovery/trace/crypto` — guided agents | L | No |
| `/v1/recovery/documents/generate` — packet generator (LLM + templates) | M | No |
| `/v1/recovery/specialists/refer` — marketplace handoff with deep-link | S | No |
| `/v1/admin/recovery-shield/*` — admin dashboards (cases, conversion, referral payouts) | M | No |
| Apple IAP product `recovery_plus_one_time` configuration | S | No (App Store Connect) |

**Total estimate:** ~3–4 weeks for one engineer to ship the v1 cut. Wire-trace and crypto-trace agents are the heaviest (each is essentially a multi-turn LLM agent with state). Documents generator can reuse the Companion's LLM plumbing.

---

## 4. Identity Shield — pre-incident intel

The retention engine. The differentiator vs LifeLock / Aura / Identity Guard is the **loop into the other shields** — nobody else has the real-time call/SMS/email surface to wire breach data into. That sentence is the whole feature.

### What it does

1. **Watches** the user's identity perimeter:
   - Email addresses (primary, aliases, work)
   - Phone numbers
   - SSN (last-4 input; we never store full SSN — match-by-hash via Enzoic / SpyCloud's pre-hashed indexes)
   - Date of birth + address (composite-PII match)
   - Credit-card BIN ranges (warn on dumps that include the user's bank's range)
   - Children's PII (for family-plan users — child identity theft is high-value attacker target)

2. **Alerts** on:
   - New breach surfacing the user's email
   - Credential dump containing the user's password (Enzoic's NTLM/SHA1 hash match — never plaintext)
   - SSN appearing on a sale list
   - Phone number listed in a scammer-target list (from our own AegisDial intel)
   - Family member's PII surfacing (with consent, per family-plan model)

3. **Feeds the other shields:**
   - Live Shield scorer reads `identity_shield_alerts` table. A call from a number known to be active in scammer-chatter gets a score boost. Already-confirmed-scammer numbers go straight to `critical`.
   - SMS Shield same — incoming SMS from a number on our active-threat list gets a verdict bump.
   - Email Shield same — Pillar 3 already integrates HIBP; we'd extend it to also pull from our own active-threat list (cheaper, fresher, more relevant data).

### Data sources (v1)

| Source | Cost | Coverage | Lag |
|---|---|---|---|
| **HIBP** | $4/mo | Breach exposure | days–weeks |
| **Enzoic** | ~$0.005/check | Password dumps, credential pairs | hours–days |
| **Our own AegisDial scam DB** | $0 marginal | Active scammer phone numbers, emails, wallets | real-time |
| **Telegram scammer-services channel listener** | ~$50/mo infra | Live scammer chatter — CC fullz, bank logs, dox-for-hire, scampage marketplaces | minutes |
| **Dark-web market crawler (Tor)** | ~$200/mo infra | Credential dumps, fullz listings, SSN sale lists from successor markets to Genesis / Russian Market | hours–daily |

**Why we build instead of buy:** Constella ($5–15k/mo) and Flashpoint ($25k+/mo) repackage the same public Telegram + darknet sources for B2B threat-intel teams. We're consumer-grade so we don't need their slick UI or compliance bundle — we need the raw feed wired into the shields. Building it ourselves is ~10× cheaper and the data becomes proprietary IP. Every month we run it, our active-threats DB gets denser than any one paid vendor's.

#### Telegram listener — implementation sketch

- Stand up 3–5 Telegram bot accounts (rotation prevents bans).
- Join the ~80 known scammer-services channels (carding, bank-log, dox-for-hire, scampage marketplaces, "OTP-bot" service channels, refund-method channels, sextortion-script-share channels). The channel list is curated; refresh quarterly.
- Each message → LLM classifier extracts: (a) artifact type (phone / email / wallet / SSN-fragment / target-list), (b) intent (advertising for sale, sharing fresh dump, recruiting accomplices), (c) confidence.
- Confirmed artifacts → `active_threats` with provenance = `telegram_channel:<channel_id>`.
- LLM also extracts target geography (US-only, UK-only, IRS-impersonation, etc.) so we can tag region-relevance for the user's dashboard.
- We are **observers only** — never buyers, never sellers, never sock-puppet engagement. That's the clean legal line.

#### Dark-web market crawler — implementation sketch

- Tor proxy fleet (3 exit nodes, rotation) at ~$200/mo on a separate VPS provider (NOT Fly — Fly's TOS doesn't love Tor).
- Daily crawl of known credential markets (current top successors to Genesis: Russian Market, BriansClub, 2easy, Bitify, etc. — refreshed list quarterly).
- Parser pulls listing metadata: dump date, claimed source, record count, sample fields.
- Sample fields (usually first-3-rows-redacted) → match against `identity_monitors` via hash.
- Match → `identity_breach_findings` row with provenance = `darknet_market:<market_id>:<listing_id>`.
- Listings on AegisDial users' geo get fast-track ingestion (US lists < 1h, others < 24h).

#### Legal + reputational posture

- We are observers, never participants. **No purchases. No engagement. No sock-puppet accounts pretending to be buyers.** Every architectural decision reinforces this.
- Frame externally: *"AegisDial monitors public criminal marketplaces so you don't have to. Every threat we find, we tell you about — and we block it from reaching you across calls, texts, and email."* This frames us as defender, not voyeur.
- Counsel review needed before launch on: (a) Tor exit-node liability if a node is logged accessing X marketplace, (b) Telegram TOS — reading public channels via bot accounts is gray-area but defensible, (c) defamation exposure if we mark a number/email as "scammer" and it's a false positive.
- We never publish the raw data we collect. Active-threats stays internal — exposed only as per-user alerts (severity + artifact-match) and admin-only dashboards.

### Identity Shield — feature surfaces

1. **Dashboard tile** on home screen:
   ```
   ┌─────────────────────────────────────┐
   │  Identity Shield                    │
   │  ─────────────────                  │
   │  3 emails monitored                 │
   │  Last breach found: 5 days ago      │
   │  Active threats near you: 12 (↑3)   │
   │                                     │
   │  [Review breaches →]                │
   └─────────────────────────────────────┘
   ```

2. **Breach detail screen** — per-finding card showing what leaked, severity, remediation steps (each linked into a Recovery flow).

3. **Family monitor** — for Pro+Family users, child PII monitoring (different consent flow; legal review needed before launch).

4. **Daily/weekly digest push:**
   - Daily: "AegisDial blocked X scams aimed at people with leaked data like yours yesterday."
   - Weekly: "We're watching N data points for you. Y new breaches this week. Z active scammers near you."
   - This is the retention copy. Calibrate cadence to avoid push fatigue.

5. **Cross-shield enrichment in alerts:** Every Live/SMS/Email Shield alert now carries an "Identity Shield context" footer when applicable:
   - "This caller's number is on our active-threat list (last seen targeting users with leaked data from the 2024 ATT breach)."
   - That's the magic sentence.

### Identity Shield — technical surfaces

| Surface | Effort | New table? |
|---|---|---|
| `identity_monitors` — per-user list of monitored identifiers (emails, phones, ssn-hashes, dob-hash) | S | Yes |
| `identity_breaches` — cached breach catalog (synced from HIBP + Enzoic) | M | Yes |
| `identity_breach_findings` — per-user per-breach match record | S | Yes |
| `active_threats` — phone/email/wallet/IP list synthesized from our own scam DB + Enzoic/HIBP + Telegram + darknet markets | M | Yes |
| `active_threats_ingest_worker` — daily worker that pulls Enzoic + HIBP deltas + rolls up our own scam intel | M | No |
| `telegram_chatter_listener` — long-running worker, 3-5 bot accounts in rotation, LLM classifier per message → active_threats | L | No |
| `darknet_market_crawler` — daily Tor-proxied scraper, listing parser, hash-match against identity_monitors | L | No |
| `intel_source_health` — admin view: per-source ingest rate, classification accuracy spot-checks, bot-ban detection | S | Yes |
| `/v1/identity-shield/monitors` — CRUD on monitored identifiers | S | No |
| `/v1/identity-shield/findings` — list breach findings | S | No |
| `/v1/identity-shield/threats/near` — active-threat list scoped to user's region (for the dashboard counter) | S | No |
| Live/SMS/Email scorer extension — read `active_threats` on every scan, score-boost if hit | M | No |
| `/v1/admin/identity-shield/*` — admin dashboards | M | No |
| Push notification scheduler — daily/weekly digests | M | No |

**Total estimate:** ~5 weeks for one engineer to ship the v1 cut (was 3 before scammer-chatter scope; the Telegram listener + darknet crawler add ~2 weeks each, partially parallel).

---

## 5. The loop — concrete data flows

This section is the differentiator. Every other competitor builds one product. We're building two paired products that get smarter at each other's expense.

**Recovery → Identity (incident becomes intel):**
- User starts a Recovery case for a scam phone number → `recovery_sessions.scam_number` populates → background worker emits a row into `active_threats` with severity `confirmed_scammer` and the case_id as evidence.
- Same for scam email addresses, scam wallets, scam URLs.
- Every other user now has those artifacts on their active-threat list within seconds.

**Identity → Recovery (intel becomes prevention OR recovery case):**
- Identity Shield finds the user's email in a fresh credential dump → emit synthetic `breach_alert` → Live/SMS/Email scorers score-boost any future inbound matching the leaked-credential-usage pattern.
- If a Live Shield call gets blocked AND the caller's number matches an active-threat row sourced from another user's recovery case, we tell the user: "We blocked a call from a number active in a scam reported by another AegisDial user." (Privacy-preserving — never disclose who reported.)
- If a user reports being scammed AFTER an Identity alert ("yes I saw the breach, then this happened"), we auto-pre-fill a Recovery case with the breach as context.

**Recovery → Recovery (intel becomes case-quality):**
- Generated legal packets get smarter case-by-case as we accumulate which arguments win which bank chargebacks (telemetry → prompt tuning → output quality).

**Identity → Identity (intel becomes coverage):**
- Our own scam DB is fresher and more relevant than Enzoic/HIBP for retail-scam targets. Over time the proportion of value coming from our own DB grows. By month 12 we expect ≥50% of active-threat alerts to come from our own data, not paid feeds.

That last point is what justifies the company at a valuation. **The longer AegisDial runs, the better its intel gets, and the worse the gap is for any competitor trying to enter.** Identity Shield is the moat.

---

## 6. Adversarial cases

Per the "always do an adversarial pass" rule, here are the failure modes to design around now, not after we ship.

### A. Re-victimization

The single biggest risk in this category. People who got scammed are 5× more likely to get scammed again — specifically by **recovery-scam operations** posing as legitimate services. Florida has the highest concentration of these.

**How we defend:**
- Recovery Plus pricing is fixed and transparent at $249. No upsells inside the flow. No "but if you pay $X more we can guarantee recovery" copy ever.
- We NEVER take a percentage of recovered funds. Period. This is the single hardest-to-fake honesty signal in the category.
- Specialist marketplace is curated, not open. We vet every specialist, take their bar/license number, verify quarterly.
- Active-threat list includes known recovery-scam operations (advertise to scrape their domains/numbers).

### B. False positives in Identity Shield

If we tell a user "your phone is on a scammer-target list" and it's not, we lose them.

**How we defend:**
- Severity tiers: `informational` (e.g., breach exposure), `caution` (e.g., credential dump with weak hash match), `critical` (e.g., active scammer-call source). Push notifications fire only on `caution+`.
- Per-finding evidence drill-down — user can tap any alert and see the source breach name, date, and what specifically leaked. Builds trust.
- Family-shared alerts require consent — never auto-monitor a guardian's phone without their explicit opt-in.

### C. SSN handling

We collect SSN-last-4 (or hash) for Identity Shield matching. This is a security liability.

**How we defend:**
- Store only as `sha256(ssn || per_user_salt)`. Never the plaintext.
- Match against Enzoic/SpyCloud only via their pre-hashed indexes — we never send SSN over the wire in clear.
- Per-user salt rotates yearly; old hashes get re-derived during sweep.
- Apple Keychain holds the original SSN on-device only; backend never sees it.

### D. Crypto-trace overselling

The 3–5% recovery rate is candid. If we let users *feel* like recovery is likely, churn after a failed case will be devastating.

**How we defend:**
- Recovery Plus screen has a clear "what to expect" panel: "For crypto cases, recovery success ranges 0–5% depending on exchange cooperation. The trace report and legal packet are useful evidence even when funds are unrecoverable — for tax write-offs, insurance claims, and law enforcement."
- We sell the *evidence package*, not the recovery promise. That's the legally and ethically clean framing.

### E. Cost runaway

Enzoic at $0.005/check × 100k Pro users × 30 monitored identifiers × 1 check/day = $4,500/day = $135k/mo. Identity Shield can eat the Pro margin if we're not careful.

**How we defend:**
- Tiered check cadence: emails daily, phone weekly, SSN monthly (SSN dumps surface slowly).
- Cache aggressively — once we know a credential is in a breach, we don't re-check it; we re-check the *catalog* monthly and diff.
- Pre-aggregate breach data once into our own `identity_breaches` table; per-user matching is a cheap SQL join, not a paid API call.
- The above brings cost per Pro user to ~$0.30/mo, well within the Pro margin.

---

## 7. v1 cut — what ships, what doesn't

### Recovery Shield v1 ships
- All existing Recovery Concierge functionality, rebranded
- Wire-trace agent (US bank chargeback flow)
- Crypto-trace agent (Etherscan + Blockchair + Arkham; exchange-tagging)
- Auto-generated legal packet (IC3, FTC, CFPB, state AG, affidavit, demand letter)
- Specialist marketplace (8–12 specialists at launch, geo-spread across 5 high-volume states)
- Apple IAP for Recovery Plus
- Admin dashboard

### Recovery Shield v2 (deferred)
- Police-report assistance (state-specific form auto-fill)
- Insurance claim assistance (cyber/homeowner's policy guidance)
- International wire trace (SWIFT recall in non-US correspondent banks)
- Identity restoration playbooks (SSN, bank takeover, Apple ID takeover)

### Identity Shield v1 ships
- Email + phone + SSN-hash monitoring against HIBP + Enzoic + our own scam DB
- **Telegram scammer-services channel listener** (~80 curated channels, 3-5 rotating bot accounts, LLM classifier)
- **Dark-web market crawler** (Tor proxy fleet, daily crawl of top credential markets, hash-match against monitors)
- Active-threats feed wired into Live / SMS / Email scorers
- Dashboard tile + breach detail screen
- Daily/weekly digest pushes
- Cross-shield "Identity Shield context" footer on all alerts
- Admin dashboard with intel-source health monitoring

### Identity Shield v2 (deferred)
- Family monitor (child PII; needs legal review)
- Credit monitoring (TransUnion/Experian API; competitive parity with LifeLock)
- Dark-web takedown service (mostly theater in this category; can hold)
- Constella/Flashpoint feeds (only if our own crawlers can't match coverage — re-evaluate at month 6)

---

## 8. Build order + timeline (aggressive)

Assuming one engineer (Dean) full-time, no other priorities:

| Week | Identity Shield | Recovery Shield |
|---|---|---|
| 1 | Tables + Enzoic/HIBP ingest worker | Wire-trace agent (LLM + state machine) |
| 2 | Active-threats wiring into Live + SMS + Email scorers | Crypto-trace agent (chain APIs + exchange tagging) |
| 3 | Telegram listener (bot fleet, channel join, LLM classifier) | Legal packet generator (templates + LLM stitching) |
| 4 | Darknet market crawler (Tor proxy, listing parser, hash match) | Specialist marketplace + IAP |
| 5 | Dashboard tile + push digest scheduler + intel-source health admin | E2E test + admin dashboard |
| 6 | Admin dashboard + adversarial pass | Soft launch |
| 7 | E2E test + soft launch to a 100-user cohort | General availability |
| 8 | General availability | — |

**Total: ~8 weeks** to ship both shields end-to-end (was 6 before scammer-chatter scope). Parallelizable across two engineers to ~5 weeks calendar. The Telegram listener and darknet crawler are the new long poles; both need standalone infra (bot accounts, Tor proxy fleet, dedicated VPS).

---

## 9. Open decisions before we spec-code

1. **Which dark-web data source first — Enzoic or SpyCloud?** Enzoic is cheaper ($0.005/check, SMB-friendly contract, no annual minimum). SpyCloud is gold-standard but ~$25k/year minimum. Recommend Enzoic for v1.
2. **Specialist marketplace launch partners.** Need to identify 8–12 specialists across asset-recovery law, blockchain forensics, identity-restoration before launch. Kyle/Dean network? Outbound BD?
3. **Apple IAP product configuration.** Non-consumable in-app purchase with App Store Connect setup. Subject to Apple's 30% (15% after year 1 for sub). On a $249 purchase, $174 net. Specialist referral fees stack on top. Acceptable margin.
4. **Push notification cadence governance.** Daily digest risks fatigue. Weekly digest risks under-engagement. A/B test cohorts at GA.
5. **Family-plan extension to Identity Shield.** Probably yes, but defer to v2 to keep v1 lean.
6. **Legal review of:** SSN-hash collection, generated-document liability (we are NOT giving legal advice — strict disclaimers needed), specialist-referral-fee model (FTC referral disclosure), active-threats DB's defamation exposure, **AND Tor + Telegram observer posture** (operating Tor exit-node-adjacent crawlers + bot accounts on scammer channels — needs explicit "observer only" written policy).
7. **Bot-account sourcing for Telegram listener.** Need 3–5 phone numbers (Google Voice / TextNow won't work — Telegram blocks VoIP). Burner SIMs from prepaid carriers, rotated quarterly. Operational cost ~$50/mo for the SIMs + carrier fees.
8. **Tor proxy hosting.** Fly TOS is not Tor-friendly. Options: Hetzner (cheap, Tor-tolerant), Vultr (mid-tier), self-hosted VPS (cheapest, more ops). Recommend Hetzner $200/mo for 3 nodes with rotation.
9. ~~**Curated channel/market list ownership.**~~ **DECIDED 2026-05-12:** AI is the threat-intel analyst; Jesiah is the strategic approver. This is structurally the right answer and a material differentiation lever — see §12.

---

## 10. The fundraise frame

This bundle is the strongest argument we have for raising at the valuation we want.

**Before these two shields:** "We're a consumer fraud app with three real-time shields." Investor compares to RoboKiller, Truecaller, Aura. Median outcome: $5–20M ARR consumer SaaS, $50–200M exit.

**After these two shields:** "We're a fraud-data network. Every user we save makes every other user safer. Recovery is the acquisition front-door; Identity is the retention engine; the data loop is the moat that gets stronger every month." Investor compares to Palantir-for-consumers, Recorded Future-for-individuals. Outcome trajectory: data network business at SaaS-multiple-plus-data-network-premium.

The pitch deck slide writes itself: a diagram of the five shields with arrows showing how recovery cases feed prevention intel feed shield score boosts feed more block events feed more recovery handoffs feed more intel. **The closed loop is the company.**

---

## 11. Action items (from this brainstorm)

- [ ] Approve / push back on the $249 Recovery Plus pricing
- [ ] Approve / push back on the specialist-referral-fee model (no success fee on user)
- [ ] Approve Enzoic as the v1 paid data source
- [ ] Approve build-our-own scammer-chatter (Telegram + darknet) vs paid feeds
- [ ] Open BD conversations with 8–12 specialists
- [ ] Legal review meeting before spec-coding starts (SSN hash, doc liability, defamation, **Tor/Telegram observer posture**)
- [ ] Source 3–5 burner SIMs for Telegram bot accounts
- [ ] Provision Hetzner Tor proxy VPS fleet
- [ ] Decide who owns the channel/market curation list (Dean? contracted analyst?)
- [ ] Decide build sequencing — Recovery Shield first, Identity Shield first, or parallel
- [ ] Spin out individual engineering specs (RECOVERY_SHIELD_ENGINEERING.md, IDENTITY_SHIELD_ENGINEERING.md) once strategy is locked

---

**Status:** ready for review + pushback. Iterate on this doc, then we split into engineering specs and start phase-cutting like we did for Email Shield.

---

## 12. AI-as-analyst — the meta-classifier

Locked in 2026-05-12: **AI is the threat-intel analyst.** Jesiah is the strategic approver, not the curator. This isn't a budget hack; it's an architectural advantage.

### What human analysts actually do
1. **Discover.** Find new scammer channels / new market URLs as the underground migrates.
2. **Triage.** Decide which channels are still producing scammer chatter vs. gone-dormant / honeypotted / pivoted to a different scam vertical.
3. **Tag.** Annotate channels by capability (carding / bank-logs / dox-for-hire / scampage / OTP-bot service / refund-method / sextortion-script-share).
4. **Geo-relevance.** Decide which channels target US victims vs. UK vs. EU.
5. **Report.** Produce weekly/quarterly threat-landscape briefings.

Constella/Flashpoint hire ex-FBI / ex-IC analysts at $150–250k/yr to do this. We replace them with a meta-classifier LLM that runs continuously.

### The meta-analyst architecture

A second-tier LLM (call it **`threatLandscapeAnalyst`**) runs on top of the raw message stream:

1. **Discovery loop** — every classified scammer-channel message includes outbound references ("join @newchannel for fresh dumps" / "available on freshmarket.onion"). The meta-analyst extracts these references, dedupes, ranks by mention frequency, and produces a daily **candidate-channels queue**. Jesiah reviews, approves additions in the admin UI, one-click adds them to the listener.
2. **Dormancy detection** — per-channel signal: classification yield (scammer-relevant message rate), member count delta, posting frequency. A channel that goes from 50 scam-msg/day to 3/week gets flagged as decaying; below a threshold the analyst recommends removal.
3. **Capability tagging** — re-classifies each channel weekly based on its current content distribution. Carding channels can pivot to OTP-bot services overnight; tags need to track that.
4. **Geo-relevance** — message-language detection + scam-script keywords (e.g., "IRS" → US, "HMRC" → UK, "Centrelink" → AU). Per-channel rollup → admin can filter "show me only US-relevant channels."
5. **Quarterly threat-landscape briefing** — auto-generated markdown report: "This quarter the underground migrated X→Y. Top 5 emerging channels. Top 5 declining. Geographic shift. New scam-type emergence."

### What Jesiah owns

- **Initial seed list** of ~80 channels and ~10 markets to bootstrap discovery (one-time effort, ~1 weekend).
- **Approval queue** review — 15 minutes daily reviewing AI-recommended additions/removals via admin UI.
- **Strategic editorial** — saying "yes that emerging channel is worth tracking" or "no, that's a honeypot."
- **Curation criteria SOP** — a written doc that captures *what makes a channel worth tracking*. The AI uses this as its system prompt; Jesiah updates the SOP, the AI applies it. Living document.

### Why this is a wedge, not a hack

Three reasons the AI-analyst model isn't just cost arbitrage:

1. **24/7 coverage with sub-minute latency.** Constella analysts work business hours; their stuff lags by 48–72 hours. Our meta-analyst runs continuously and can flag a new channel emerging at 3am Bucharest time before any competitor's analyst is awake.
2. **Compounds with our raw data.** Constella's analysts work off a generic feed. Our analyst works off a feed already filtered for *consumer-retail-scam relevance* by the per-message classifier. The same channel discovered by both vendors gets richer annotation in our pipeline because our analyst sees "this channel keeps getting cited in our recovery cases."
3. **The story for the pitch deck.** "Constella has 40 analysts. We have one — but ours never sleeps and never misses a market migration. Every threat we find feeds five real-time shields blocking scams on consumer phones." That's a fundable line.

### Technical surfaces added

| Surface | Effort | New table? |
|---|---|---|
| `threat_intel_channels` — curated channel list + status (active / candidate / dormant / removed) + capability tags + geo-relevance | S | Yes |
| `threat_intel_candidates` — AI-discovered candidates pending Jesiah's approval | S | Yes |
| `threatLandscapeAnalyst` daily worker — runs the meta-classifier across the last 24h's classified messages, populates candidates, flags dormancy, updates tags | M | No |
| `threat_landscape_briefings` — quarterly auto-generated markdown reports | S | Yes |
| `/v1/admin/intel/candidates` — list pending candidates, approve/reject endpoint | S | No |
| `/v1/admin/intel/briefings` — latest threat-landscape report | S | No |
| Admin UI: candidate review queue + channel-list editor + briefing reader | M | No |

**Effort:** ~1 week added to Identity Shield v1 (~9 weeks total for the bundle, ~6 weeks parallelized). The meta-analyst is mostly an LLM-orchestration layer over already-collected data.

### What this means for the fundraise pitch

The deck now has a slide that says:

> **The world's first AI-native consumer fraud-data network.**
> Five real-time shields. A recovery engine. A pre-emptive intel network. An AI analyst that runs 24/7.
> We don't hire ex-FBI analysts. We hire the LLM that does the job better — and we ship it to a hundred thousand phones.

That's the line that turns this from a $50M consumer app into a $1B fraud-data infrastructure pitch.
