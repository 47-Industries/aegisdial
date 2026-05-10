# Live Shield v3 — Brainstorm + Spec
**Status:** brainstorming. No code yet. Continues the v2 work — see `LIVE_SHIELD.md`.
**Started:** 2026-05-10

---

## Context — what v2 already did (recap)

v2 covers the IN-call experience: hybrid risk engine, family alerts, AI coaching, auto-handoff to recovery. Live Shield v2 PR open: https://github.com/ceomakeithappen/aegisdial-backend/pull/2

**v2 is complete from a backend perspective.** v3 is the next horizon — the layers v2 deliberately deferred.

---

## The full brainstorm canvas (30+ ideas across 6 categories)

These are the dimensions Live Shield could expand into. Most won't ship; capturing all so the strategy is conscious, not accidental.

### A. Pre-call layer (before the phone rings)
- **A1. Push pre-warning** — fire a push notification the moment an inbound call arrives, BEFORE Mom answers, citing live fraud-graph context.
- **A2. Auto-decline known-bad numbers at OS level** — CallKit Call Directory Extension. Numbers in our fraud graph never ring her phone.
- **A3. Caller ID Premium — paid feature** — "Verified by AegisDial" badge for trusted callers (family, banks, doctors). Trust signal as product, $9.99/mo upsell.
- **A4. Targeting alerts** — "Your number was probed 3× this week by known scam clusters. Expect a call in 48hr." Proactive intelligence.

### B. In-call layer (during the call — what v2 covers)
- **B1. Whisper mode (Apple Watch / AirPods)** — haptic pulse on Mom's wrist when risk crosses 50, no need to look at phone.
- **B2. AI takes over the call** — AegisDial AI answers FOR Mom: "Hi, I'm helping screen calls. What's this regarding?" Sam Altman concept. ElevenLabs + OpenAI Realtime.
- **B3. Auto-mute the user during critical moments** — when user is about to read SSN/card number, AegisDial mutes their mic. Like a seatbelt.
- **B4. Real-time fact-checking the caller** — caller claims to be "Officer Mike Davis FBI Boston." AegisDial cross-checks: badge, office, name. Returns "this person doesn't exist" mid-call.
- **B5. Multi-party live shield** — three-way call where AegisDial silently observes. Family member can be third party. AegisDial coaches via push.

### C. Post-call layer (the recovery moment)
- **C1. The first 15 minutes, automated** — auto-file FTC complaint, auto-initiate credit freeze (Equifax/Experian/TransUnion APIs), auto-notify bank fraud line. Mom confirms with Face ID. 15 min → 60 sec.
- **C2. Bank integration — block the wire** — partner with Chase/BofA/Wells. Critical call → real-time signal to bank fraud team. Wire transfers in next 30 min get 2-hour delay + verification call.
- **C3. AI-generated police report packet** — complete IC3 + state AG + local police PDFs, ready to file.
- **C4. Family scam debrief** — AI video narration of what happened, sent to family plan automatically.

### D. Network effects layer (the moat)
- **D1. Family trust graph** — every family adds trusted callers (hairdresser, doctor, friend). Unknown callers get elevated scrutiny. Compounds with every family.
- **D2. Cross-AegisDial fraud network** — Mom in Sacramento gets scam call 9:47am, by 9:51am 47 other AegisDial users have been called by same number. Auto-block at network. Scammer numbers die in <5 minutes.
- **D3. Crowd-sourced scam scripts** — every critical transcript contributes (anonymized) to regex catalog + LLM training. AegisDial sees scam scripts before any other product on Earth.
- **D4. AegisDial Family network identity** — every Pro user becomes verified caller to other Pro users. Trust radiates through network.

### E. Adjacent revenue layers
- **E1. AegisDial for Banks** — SaaS API, $0.10/call risk score on inbound/outbound. B2B that funds consumer growth.
- **E2. AegisDial for Carriers** — Verizon/T-Mobile/AT&T license carrier-level risk engine. Phase 3 of `COMPANY_OS.md`.
- **E3. Insurance product** — partner with underwriter. $2.99/mo extra = $10k fraud insurance. Viable because we PREVENT.
- **E4. Elder-care community partnerships** — AARP, Meals on Wheels, NCOA bulk-license to members. Distribution at scale.

### F. Distribution / awareness layers
- **F1. The viral product moment** — when AegisDial blocks a $4,300 scam, user shares redacted screenshot. "AegisDial just stopped a $4,300 scam call to my mom" → Instagram-share flywheel.
- **F2. The "scam scout" content engine** — weekly anonymized scam-of-the-week. Daily tweet automation feeds this.
- **F3. The "AegisDial Sound"** — distinctive audio chime when critical alert fires. Family members in same house hear Mom's phone and know what's happening from another room.
- **F4. The PR moment** — "AegisDial Quarterly Fraud Report." Total scams blocked, $ saved, top scripts. Press fixture.

---

## v3 priorities — locked 2026-05-10

Jesiah picked **5 features for v3** out of the 30+ ideas:

1. **A1 — Push pre-warning** (priority #1 — start here)
2. **A2 — Auto-decline known-bad numbers at OS level**
3. **B3 — Auto-mute the user during critical moments**
4. **B4 — Real-time fact-checking the caller**
5. **B5 — Multi-party live shield**

The shape of v3: **before the call (A1, A2)** + **deeper protection during (B3, B4, B5)**. v2 assumed Mom answered. v3 changes that assumption — most calls don't even get through, and the ones that do are surrounded by harder protections.

---

## A1 — Push pre-warning (deep brainstorm)

### THE FOUNDING PRIMITIVE (locked 2026-05-10)

Jesiah's clarification: **AegisDial's differentiation is live web crawling of unknown numbers from the open internet — Reddit posts, YouTube comments, BBB reports, FCC complaints, scam-tracking forums — at the moment of the call. With sources preserved.**

This is what no other product does:
- Truecaller has a closed crowdsourced database
- LifeLock pulls from credit bureaus, not phone scam reports
- Hiya works at carrier level with structured data, not user reports
- Apple's "Spam Likely" is an opaque carrier signal

**AegisDial pulls Reddit, YouTube, BBB, FCC, Google search results in real time, synthesizes risk, AND shows Mom the receipt — a tappable link to the original Reddit thread or YouTube comment that flagged this number as a scam.**

Provenance is the moat. Mom's daughter doesn't have to trust AegisDial — she can tap and read the original source herself.

### What we already have built (verified in code today)

The crawler infrastructure already exists:
- `src/services/liveCrawl.ts` — `liveCrawlUnknown(e164)` orchestrator with 700ms visible budget + 2.5s background budget + Redis single-flight
- `src/crawlers/reddit.ts` — Reddit scam-call mention crawler
- `src/crawlers/bbb.ts` — BBB Scam Tracker scrape
- `src/crawlers/fcc.ts` — FCC Robocall Database (Socrata API)
- `src/crawlers/youtube.ts` — YouTube comment search for scam reports
- `src/crawlers/notes800.ts` — 800notes.com scam directory
- `src/crawlers/serper.ts` — Google general search wrapper
- `src/crawlers/sentiment.ts` — sentiment analysis on raw mentions
- `src/crawlers/ingest.ts` + `rescore.ts` — normalize and score mentions
- `src/services/phoneLookup.ts` — phone number metadata (Ekata + IPQS)

The `NormalizedMention` schema already preserves what we need:
```typescript
{
  source: 'reddit' | 'bbb' | 'fcc' | 'youtube' | 'notes800' | 'serper',
  source_ref: string,       // forum post ID, BBB report ID, etc.
  url: string | null,       // ← the link Mom can tap to verify
  snippet: string,          // ← the actual text mentioning her caller
  sentiment: 'positive' | 'neutral' | 'negative',
  scam_category: string,    // matches our scam taxonomy
  severity: number,
  observed_at: Date,
}
```

**A1 is not a new feature. A1 is surfacing existing infrastructure at a new moment (pre-answer instead of post-call lookup) with a new UX (the sources panel).**

### What it does — corrected

The moment Mom's iPhone receives an inbound call from an unknown or flagged number:

1. **Cache check (on-device, <100ms)** — if number is in our top-10k high-risk cache, fire the warning instantly. Cache populated nightly by the existing crawler scheduler.
2. **Cache miss → fast crawl** — backend's `liveCrawlUnknown` runs the parallel crawl with 700ms visible budget. APNs push lands ~1-2s later if mentions found.
3. **Mom sees**:
   ```
   🚨 Possible scam — flagged on Reddit, BBB, and 2 other sites
   Pattern: IRS impersonation
   "Got a call from this number claiming to be the IRS — same script as the scam I read about" — Reddit, 2 days ago
   [ Decline ]  [ See all 7 sources ]
   ```
4. **Mom taps "See all 7 sources"** → list of every Reddit thread, YouTube comment, BBB report, FCC complaint mentioning this exact number, each with a "Read it →" link to the original.

### Why this is the highest-leverage v3 feature
- Most users wouldn't need v2's mid-call coaching if they'd never picked up the call
- v3 shifts the product from "we save you mid-call" to "you don't get the call in the first place — and if you do, here's the receipts proving it's a scam"
- Provenance with sources is what wins skeptics. Adult children who don't trust "AI fraud detection" trust a tappable Reddit link.

### What we already have
- **iOS 18 Live Caller ID Lookup API** — Apple-supported. When inbound call arrives, iOS queries our extension synchronously for ~100ms. We return label + spam category. Already integrated for the basic "Spam Likely" UX.
- **APNs (Apple Push Notification Service)** — full backend support, configured for v2 family alerts.
- **Backend fraud-graph data** — `call_sessions` table contains every shielded call's outcome, peer_e164, risk_level. The aggregation needed for "47 users this week" is one SQL query away.

### Open dimensions to decide

The SOURCE-of-signal dimension is now LOCKED: live web crawl via existing `liveCrawlUnknown` infra. The remaining dimensions:

**Dim 1: HOW she sees it (UX surface)**
- (a) Custom CallKit label only — fits in 100ms cache window, no extra UX
- (b) CallKit label + push notification 1-2s later with sources
- (c) Full-screen overlay before answer — most dramatic, requires VoIP CallKit ownership
- (d) CallKit label + push + full-screen for critical only — tiered by risk

**Dim 2: HOW MUCH detail in the lock-screen notification vs. tap-through detail screen**
- (a) Minimal in notification ("Likely scam"), all detail in tap-through screen
- (b) Top 1-2 source citations in notification, full list in tap-through
- (c) Full source list inline (long notification, but no tap needed to see receipts)

**Dim 3: WHAT happens on the cache miss case**
When an unknown number rings and we have NO data yet, we have ~100ms in the CallKit window but `liveCrawlUnknown` takes 700ms+:
- (a) Show "AegisDial: checking…" label for the duration of the ring; push lands during/after ring with the result
- (b) Stay silent during ring; push lands after with "Caller you didn't recognize was actually X — call back if needed"
- (c) Conservative default: only warn on cached/known numbers, silent on unknowns

**Dim 4: PRIVACY for the cross-user fraud graph contribution (separate from the open web)**
The OPEN WEB data is public — Reddit posts, YouTube comments, BBB reports are all public. No privacy issue.
But once Mom blocks a number, do we contribute that signal to other AegisDial users?
- (a) Fully opt-in
- (b) Default-on with toggle
- (c) Anonymized only (number + outcome, no user)
- (d) Tier-based — Pro users opt-in, Family+ users contribute by default in exchange for network access

**Dim 5: WHAT happens when she taps the notification**
- (a) Decline the call
- (b) Decline + auto-block this number forever
- (c) Decline + alert family ("Mom's getting targeted again")
- (d) Decline + start AegisDial Recovery in case money already moved
- (e) See sources panel first (the receipts), then choose

### What's hard
- Apple's iOS 18 API gives us ~100ms to respond synchronously when the call rings. Not enough time to do a complex backend query unless cached. Need a local on-device cache of high-risk numbers, refreshed in background.
- Push notifications can't be guaranteed to land BEFORE the ring — APNs has 1-3s latency. Cache + CallKit label is the only path to true "before the ring" UX.
- iOS background app refresh is throttled. The fraud-graph cache must update opportunistically, not on demand.

### What's easy
- Backend endpoint that returns risk for a phone number — trivial, ~30 lines of SQL on `call_sessions`.
- Push payload format — reuse v2's `family_alert_fired` infrastructure.
- The cache logic is bounded — top 10,000 highest-risk numbers covers >99% of incoming calls.

### Demo Day moment for A1
> *"Watch what happens when I get a call from a known scam number."*
>
> [Phone rings. Before Jesiah hits answer, iPhone shows full-screen red banner: "🚨 IRS impersonation scam — 47 reports in 7 days"]
>
> *"This call would never have reached my mom. AegisDial declined it before her phone even rang."*

---

## A2 — Auto-decline known-bad numbers (deep brainstorm)

### What it does
Numbers above a critical-risk threshold are auto-declined at the OS level via CallKit Call Directory Extension. Mom's phone doesn't ring at all. The call goes straight to voicemail, or is silently rejected.

### Why this matters
A1 lets Mom DECIDE not to answer. A2 removes the decision entirely. For elderly users with cognitive load issues or for repeat-target numbers, this is more humane.

### Open dimensions
- **Threshold**: at what risk level do we auto-decline? Critical only? Based on confirmed scam reports vs. predicted?
- **Override**: can Mom whitelist a number that AegisDial blocked? (Yes — required by Apple guidelines)
- **Family override**: can the daughter remotely whitelist a number for Mom?
- **Notification**: does Mom see "AegisDial blocked a call from X"?
- **Voicemail behavior**: silent reject vs. send to voicemail?

### Tech reality
- CallKit Call Directory Extension is the Apple-blessed path. Limited to ~100k entries — the highest-risk numbers in our fraud graph.
- Extension is loaded on-device, refreshed daily. No real-time updates possible at the OS level.
- The 100k limit forces curation: only "confirmed scam" numbers (multiple users reported) get this treatment.

---

## B3 — Auto-mute during critical moments (deep brainstorm)

### What it does
When v2's Live Shield detects critical risk + the user is about to give up sensitive info (SSN, card number, account number), AegisDial auto-mutes Mom's mic. She literally cannot transmit the data.

### Why this matters
Some users won't hang up even when warned. The "I just need to verify my account" moment is when scams convert. Removing the user's ability to leak the data IS the protection.

### Open dimensions
- **Trigger pattern**: regex on user-side speech ("my social is", "card number is")? Or detect *intent to share* via LLM?
- **Mute duration**: how long? 5 seconds? Until risk drops?
- **User feedback**: does Mom know she was muted? (Should yes — confused silence is worse)
- **Override**: can Mom force unmute? (Probably yes, but with a 3-second cool-down)
- **Edge case**: what if she WAS giving the info to a real person? (Trust-graph check — verified contacts skip this)

### Tech reality
- iOS 18 doesn't give third-party apps direct access to the system mic during a call. **THIS MIGHT NOT BE BUILDABLE** as currently scoped — needs investigation.
- Workaround: AegisDial owns the call (VoIP via CallKit), so we control the audio pipeline.
- Or: detect the moment via on-device speech recognition + push a "WAIT — don't say that" overlay. User mutes themselves.

### Honest read
- True auto-mute = needs deeper Apple integration than currently exists. Maybe future iOS.
- "Big visible warning before user speaks the number" = buildable today, almost as effective.

---

## B4 — Real-time fact-checking the caller (deep brainstorm)

### What it does
Caller says "I'm Officer Mike Davis from FBI Boston field office, badge 4527." AegisDial cross-checks against public records:
- Does the FBI Boston office have a Mike Davis?
- Does badge 4527 exist?
- Real-time return: "AegisDial cannot verify this caller's claim. Real FBI agents would not call you about this."

### Why this matters
Specificity is the scam's hook. Bad actors invent specific badge numbers, IRS case numbers, doctor names. If we can fact-check at the rate of conversation, we destroy the believability.

### Open dimensions
- **Data sources**: which public records are queryable in real-time?
  - FBI public-affairs office directory
  - State medical board databases (doctor verification)
  - SEC EDGAR for "investment advisor" claims
  - Local police force rosters (most NOT public — workaround?)
- **Latency budget**: 3-5 seconds per fact check is workable. Longer breaks immersion.
- **Confidence model**: what do we say when we can't verify? "Unverifiable" vs. "doesn't exist" — big legal difference.
- **Coverage gaps**: most claims (doctor names, IRS agent IDs) aren't in public databases. Honest about coverage.

### Tech reality
- The "verifier" is itself an AI agent: Claude reads the claim, queries appropriate APIs, synthesizes a risk verdict.
- Could be a beautiful Claude tool-use demo — Claude calling FBI directory API, SEC API, etc.
- 80% of calls won't have anything verifiable. The 20% that do are the SCARIEST scams (impersonating real authority).

---

## B5 — Multi-party live shield (deep brainstorm)

### What it does
A three-way call where the third party is AegisDial AI, silently observing. Family member can also be the third party — they see the live transcript + risk score, can speak up at any moment.

### Why this matters
Live Shield v2 family alerts are async (push notification). v3 is sync — the daughter is LIVE on the call without anyone realizing. She intervenes at the exact right moment.

### Open dimensions
- **Who's on the call**: AegisDial AI only? Family member silently? Both?
- **Audibility**: silent observer vs. can-speak observer
- **Recording**: is this recorded? Big legal question (two-party consent states)
- **Initiation**: how does the third party join? Auto-on-critical? Family-member-tapping-button?
- **Privacy disclosure**: caller (the scammer!) doesn't know he's being recorded — legal in 38 states, illegal in 12

### Tech reality
- Twilio Conference Bridging is the standard mechanism. ~$0.01/min per leg.
- iOS supports 5-way calling natively — could use Apple's call merge.
- Legal reality: must be transparent about recording in 12 states. AegisDial AI as observer (not recorded) sidesteps this; live family-member silent observation does NOT.

---

## Locked positioning for v3

The story for v3 is: **"v2 saves you during the call. v3 means the call doesn't even happen — and if it does, you're not alone."**

Marketing line: *"AegisDial v3 — protection that starts before the phone rings."*

---

## Open question across all 5 picks

Most of these features change AegisDial from a single-user app to a **network product**. The fraud graph (D2 in the brainstorm) becomes the moat. Should v3 EXPLICITLY make this network architecture the load-bearing piece?

If yes: v3's scope expands beyond just A1/A2/B3/B4/B5 to include the fraud-graph + cross-user contribution flow. That's the real Phase 3 strategy from `COMPANY_OS.md`.

If no: v3 is 5 isolated features. Each protects an individual user. Easier to ship, smaller moat.

---

## Decisions log (filled in as we make calls)

### 2026-05-10 — A1 founding primitive: live web crawl with provenance
The differentiator is pulling Reddit, YouTube, BBB, FCC, and search results in
real time when an unknown number calls — and showing Mom the receipts (tappable
links to original posts/comments/reports). The crawler infrastructure already
exists in `src/services/liveCrawl.ts` and `src/crawlers/*`. v3 surfaces this at
a new moment (pre-answer) with a new UX (sources panel).

**Implication:** A1 is mostly an iOS UX build + a thin backend API that wraps
existing services. Not a from-scratch crawler build.

### 2026-05-10 — A1 notification UX: Minimal banner + tap for sources
Lock screen shows: *"🚨 Possible scam — flagged on Reddit, BBB +2 sites."* One
tap opens the full sources panel with every URL.

**Why:** cleanest UX, doesn't overwhelm Mom on the lock screen, the receipts
are one tap away when she wants them. The drama in the demo is the SOURCES
PANEL, not the lock-screen banner — that's where Jesiah taps and the audience
sees 7 tappable Reddit/YouTube/BBB links.

**Implication:** simple iOS notification template + a single detail-screen
SwiftUI view. The detail screen is the hero UI of A1.

### 2026-05-10 — A1 cache miss: conservative — warn only on known-bad
On brand-new numbers (not in our top-10k cache), stay silent during the ring.
We're optimizing for TRUST over COVERAGE — once Mom learns to ignore "yellow
checking…" labels we've broken the product.

**Implication:** the on-device cache is the load-bearing piece. The cache
needs to refresh nightly (or more often) with the highest-risk numbers from
our backend. The cache eligibility rule is what separates "warn" from
"silent" — needs to be tuned conservatively.

**Cache rule (initial proposal, refine later):**
A number is in the top-10k cache only if:
- ≥3 negative mentions across at least 2 distinct sources, OR
- ≥1 confirmed scam report from FCC database, OR
- The number is internally flagged from a critical-risk Live Shield session

This means most warnings will be highly credible. The Reddit thread and the
BBB report and the FCC complaint all corroborate. Mom can tap and verify.

---

### 2026-05-10 — A1 cross-user contribution: default-on, with settings toggle
When Mom blocks a number through AegisDial, an anonymized signal (number +
outcome only, no user identifier) flows into the cross-user fraud graph.
Other AegisDial users called by that number in the future see it cited. Mom
can toggle this off in settings. Most won't.

**Why:** the network effect is the compounding moat (Category D in the
brainstorm). Default-on is the right balance — strong network growth without
losing user trust. The privacy story stays clean because no user-identifying
data ever leaves Mom's account.

**Implication:** new backend endpoint to ingest user-block signals into the
fraud graph. Pairs with existing crawler-derived signals — same `mentions`
table, with `source = 'aegisdial_user_block'` joining the existing source
list (`reddit`, `bbb`, etc.). Same scoring pipeline.

### 2026-05-10 — A1 on-tap action: open sources panel first, then she chooses
Tap notification → sources panel slides up with all 7 (or N) tappable
Reddit/YouTube/BBB/FCC links → big red DECLINE button + small "answer anyway"
link at the bottom of the panel → she chooses with full context.

**Why:** this is the locked product thesis in action. Receipts are the moat.
Mom (and especially her skeptical adult children) doesn't have to trust AI —
she taps the Reddit thread, reads it herself, and decides. Auto-blocking on
tap would be paternalistic and removes the educational moment.

**Implication:** the sources panel is the HERO UI of A1. It needs to feel
weighty — clearly named sources, real snippets, dates, tappable URLs. Not
a generic "view details" sheet.

---

## A1 — locked spec (synthesized)

**The feature in one paragraph:**
When an inbound call rings on Mom's phone from a number in AegisDial's
top-10k risk cache, her lock screen shows: *"🚨 Possible scam — flagged on
Reddit, BBB +N sites."* One tap opens the sources panel — every Reddit
post, YouTube comment, BBB report, FCC complaint, and AegisDial-user block
that mentions this number, each with a tappable URL to verify. She declines
or answers from there. If she declines, an anonymized signal contributes
to the fraud graph for the next AegisDial user called by the same number.

### What's built today (~70% of the work)
- `liveCrawlUnknown(e164)` orchestrator with parallel source crawl + 700ms visible budget
- Crawlers for Reddit, BBB, FCC, YouTube, Notes800, Serper search
- `mentions` table preserves source name + URL + snippet + sentiment + scam_category
- `phoneLookup` service with Ekata + IPQS metadata
- Push infrastructure (APNs) ready to go
- Risk scoring pipeline already feeds `call_sessions.risk_level`

### What's not built (the v3 A1 work)

**Backend (~3 days):**
- Top-10k hot-numbers cache populator job (nightly cron, refresh based on rolling 7-day mentions weight)
- New endpoint `GET /v1/lookup/pre-call-risk?e164=X` — wraps cache lookup, falls through to `liveCrawlUnknown` for cache miss (conservative: returns "no warning" if no cached data)
- New endpoint `POST /v1/lookup/contribute-block` — Mom's block becomes an anonymized signal in the `mentions` table with `source='aegisdial_user_block'`
- Settings table extension or reuse of `family_alert_preferences` for cross-user contribution toggle

**iOS (~6 days):**
- CallKit Call Directory Extension that queries the on-device cache instantly (under Apple's 100ms sync window)
- Background sync to refresh the on-device cache from `/v1/lookup/cache-snapshot`
- Push notification handler with new banner format
- **Sources panel SwiftUI view** — the hero UI. List of mentions, each with: source icon (Reddit/BBB/YouTube/FCC), snippet of the actual text, date, tappable "Read on [source] →" button
- Decline action handler that calls `/v1/lookup/contribute-block` (when toggle is on) and dispatches family alert if Mom is on a family plan
- Settings screen: cross-user contribution toggle (default on)

**Total estimate: ~9 days for one engineer.** Most weight on iOS — the backend is mostly "wire existing services to new endpoints."

### Cache eligibility rule (initial)
A number lives in the top-10k cache only if at least one of:
- ≥3 negative mentions across at least 2 distinct sources, OR
- ≥1 confirmed FCC complaint, OR
- ≥5 anonymized AegisDial user blocks in the past 30 days, OR
- The number was internally flagged from a critical-risk Live Shield session

Tune over time. False-positive sensitivity is the dial.

### Demo Day moment (locked)
> *"Watch what happens when I get a call from a number flagged on the open web."*
>
> [Phone rings. Lock screen lights up red: *"🚨 Possible scam — flagged on Reddit, BBB +5 sites."* Jesiah taps. Sources panel slides up — 7 entries, each tappable. He taps the Reddit one — opens the actual thread on r/Scams from 4 days ago, a victim describing the same script. He swipes back, taps DECLINE.]
>
> *"This call would never have reached my mom. AegisDial pulled the receipts from the open web, showed her exactly where this number had been flagged, and let her decide. The Reddit thread proved it — she didn't have to trust me, AI, or anyone else. The crowd already had her back."*

### What this changes about AegisDial's pitch

**Before v3:** "We detect scams in real time."
**After v3:** "We surface the open internet's collective scam-detection at the moment your phone rings — with the receipts."

That's a fundamentally different category. We're not competing with Truecaller's database or LifeLock's reimbursement product. We're the **real-time interface to crowdsourced fraud knowledge** that nobody else has built.

---

## A2 — User-blocked numbers enforced at the OS level

> **Founding principle (locked 2026-05-09):** AegisDial never autonomously blocks anyone. The on-device block list contains only numbers the user has personally chosen to block. A2 is the OS-level *enforcement* of those manual blocks — not autonomous detection. False positives are mathematically impossible because the user is the only thing that puts a number on the list.

**One-sentence spec:**
> When the user blocks a number (from the call log, from a Live Shield critical session, or from tapping DECLINE+BLOCK on an A1 sources panel), that block is enforced silently at the OS level — the number can never reach her phone again, even on retries from the same scammer using the same line.

**How this differs from A1:**
- A1 surfaces a *warning* (with receipts) when an unknown but high-risk number rings. The user decides.
- A2 *enforces* the user's prior decision. Once she's said "block this", the OS never even rings for that number again.

A1 is the warning layer. A2 is the memory layer.

**Apple's primitive:** [CallKit Call Directory Extension](https://developer.apple.com/documentation/callkit/cxcalldirectoryprovider). It's an iOS extension that ships an on-device list of phone-number entries. Two flavors:
- **Identification entries** — show a label on the incoming call screen (e.g., "Likely Spam — AegisDial"). Up to ~unlimited.
- **Blocking entries** — silently block the call from ringing. Capped at ~50k–100k entries depending on iOS version. Way more than any individual user will ever block — non-issue at the user level.

The extension runs in a sandbox. It cannot phone home in real time. It synchronizes its on-device list from our backend on a schedule (we call `CXCallDirectoryManager.reloadExtension()` from the main app whenever the user adds or removes a block).

### Where "Block" surfaces as a user action

The block-the-number primitive needs four entry points across the app:

1. **End of a Live Shield session** — when the call wraps and the score was critical/high, the post-call screen offers "Block this caller forever" as the primary CTA.
2. **A1 sources panel** — alongside "Just decline this once", a "Decline + Block forever" button.
3. **In-app call log** — long-press any recent call → "Block this number".
4. **A2 push notification** — when a previously-blocked number tries again, the notification offers "View receipts" (so the user sees that her past block is doing its job). NOT "Unblock" — she intentionally blocked them; we don't second-guess.

All four entry points hit the same backend route: `POST /v1/blocks` with `{ e164, reason_code, source_surface }`. That route:
- Persists the block in the user's `user_blocks` table
- Triggers a sync to the user's Call Directory Extension via APNs silent push
- Also flows the anonymized signal into the cross-user fraud graph (per A1's already-locked default-on toggle, which the user can disable in settings)

### Dimensions that survived the corrected framing

The original "5 dimensions" became 3 once the autonomous-blocking framing was killed:

1. ❌ ~~Threshold~~ — N/A. The user IS the threshold.
2. ✅ **Default state** — still real (the iOS extension still requires user permission to enable)
3. ✅ **Transparency** — still real (when a previously-blocked number retries, what does the user see?)
4. ❌ ~~Whitelist / appeal~~ — N/A. The user can't wrongly-block her own pharmacy without intending to. Unblock is just "delete from my block list."
5. 🟢 **Cache strategy** — trivial. Apple's 100k cap is irrelevant when the list is only the user's personal blocks.

The two surviving dimensions are locked in the sections below.

### 2026-05-09 — A2 default state: ON by default (with iOS-required permission gate)
The OS-level enforcement is enabled the moment the user finishes onboarding, so that the very first time she taps "Block" on a scammer, the block actually works. The product position is: *"When you block a number, AegisDial makes sure they never reach you again."*

**The iOS technical reality:** Call Directory Extensions can NOT be programmatically enabled. iOS forces the user to manually flip a toggle in Settings → Phone → Call Blocking & Identification → AegisDial. This is by Apple design — the user must consent to a third-party app participating in the call-blocking pipeline.

**So "on by default" actually means:** during the onboarding flow, we treat this exactly like Notifications permission:
1. Step 4 of onboarding: "When you block a scammer, we make sure they can't get back through. iOS needs you to turn this on once."
2. Tap "Enable Block Enforcement" → app deep-links to `App-Prefs:Phone&path=CallBlocking` with a coachmark overlay pointing at the AegisDial row.
3. User flips the toggle ONE time. Returns to app. Coachmark dismisses. Block enforcement is now active forever (until manually disabled).
4. If user skips this step, we re-prompt every 7 days with an in-app banner. The setting in our app shows "⚠ Pending — finish enabling in iOS Settings, otherwise your blocks won't be enforced."

**The legal posture:**
- The Apple permission flip IS the user's affirmative consent for AegisDial to participate in call blocking. Each individual block is an additional explicit user action — there is no autonomous block decision anywhere in the system.
- We log the timestamp of when the extension was first enabled — call this our "enforcement consent timestamp" for any audit trail.
- Marketing copy is honest about who's blocking: *"You decide who to block. We make sure they can't get back through."*

**Implication for build:**
- New onboarding screen + deep-link logic in iOS app
- Background watcher for `CXCallDirectoryManager.getEnabledStatusForExtension` — drives the "Pending" badge
- Settings screen toggle that re-deep-links if user wants to disable
- A2 status in the app dashboard (enabled / pending / disabled)

### 2026-05-09 — A2 transparency: push notification per blocked retry + in-app log
When a number the user has already blocked tries to call her again, the OS extension drops the call silently AND fires a low-priority push: *"AegisDial · A scammer you blocked tried again — tap to see who."* Tap opens the in-app block-history detail with the original block reason and Mom's recorded reason code.

**Why this is the right call:**
- **Each enforced block is a moment of value-proof.** Mom sees the app *working* — the scammer she blocked last week tried again, and her phone never rang. That's a renewal-driving moment.
- **Adult kids on the family plan see it too.** "AegisDial blocked 3 scammer retries on Mom's phone this week" lands in the weekly family digest. Justifies the $49.99/mo.
- **Reuses existing UI.** Zero new screens — the in-app block-history view already lists the user's blocks. We just add an "Attempted again at HH:MM" entry under the relevant row.
- **It's the difference between silent and transparent enforcement.** Truecaller blocks silently and you have to dig for the log. AegisDial tells you, in real time, *"that scammer you reported? They tried you again. We dropped it."*

**Rate-limiting (still important — a single scam number can dial Mom 20 times in a day):**
- Max 3 individual retry-blocked notifications per 24h. Beyond that, group into a single "AegisDial · 4 more retry attempts blocked today — tap for details" digest.
- Notifications are silent + no banner during user-set quiet hours (default 9pm–8am local). The block still happens; the notification is deferred to the next morning's digest.
- Per-number cooldown: if the same blocked number retries 5 times in an hour (autodialer pattern), we coalesce into one notification per hour for that number.
- Backend respects per-user rate limit on `POST /v1/push/block-notify`; client-side iOS code also rate-limits as a safety net.

**Implication for build:**
- Existing APNs infra handles delivery — no new push pipeline.
- New notification category `AEGISDIAL_BLOCK_RETRY` with one action: "View in app" (no "unblock" — she chose to block).
- New endpoint `GET /v1/blocks/explain?e164=X` returns the user's original block reason + timestamp + the call-attempt history of that number against her phone.
- Rate-limit state lives in Redis (`block_notify:rate:{user_id}` keyed by day; `block_notify:per_number:{user_id}:{e164}` keyed by hour).

---

## A2 — locked spec (synthesized)

**The feature in one paragraph:**
The user blocks a number through any of four entry points (Live Shield post-call screen, A1 sources panel, in-app call log, or settings). That block flows to the iOS Call Directory Extension. From that moment forward, when that number dials her phone, iOS silently drops the call before her phone ever rings. A low-priority push notification tells her the scammer tried again, with the receipts of her original block — proof the app is doing what she paid for.

### What's built today
- Existing `user_blocks` table in the schema (was already there for in-app block UX, just not enforced at OS level)
- Existing APNs push infrastructure
- Existing `mentions` table to flow anonymized block signals into the cross-user fraud graph (per A1's locked design)
- Existing in-app block-history view

### What's not built (the v3 A2 work)

**Backend (~1.5 days):**
- New `POST /v1/blocks` route that handles all four entry-point surfaces with a unified `reason_code` enum + `source_surface` enum
- New `GET /v1/blocks/snapshot?since=<ts>` route returning the user's E.164 block list — used by the iOS extension's sync job
- New `GET /v1/blocks/explain?e164=X` route returning the user's block metadata for tap-to-receipts
- New retry-detection hook: when an APNs CallKit observer reports a dropped-by-extension call, fire `POST /v1/push/block-notify` with rate-limit logic
- Settings hook so the user can disable cross-user fraud-graph contribution (already locked under A1 — same toggle)

**iOS (~3 days):**
- Onboarding screen: "Enable Block Enforcement" with deep-link to Settings → Phone → Call Blocking + coachmark
- Background watcher for `CXCallDirectoryManager.getEnabledStatusForExtension` driving the "Pending" badge
- Call Directory Extension itself (the .appex bundle) — populated by background sync from `/v1/blocks/snapshot`
- "Block this number" surfaces wired into all four entry points
- Block-history detail view extended with "Attempted again at HH:MM" sub-entries
- Settings screen: A2 status (Enabled / Pending / Disabled), cross-user contribution toggle (default on)
- Notification handler for `AEGISDIAL_BLOCK_RETRY` category

**Total estimate: ~4.5 days for one engineer.** A2 is significantly cheaper than A1 because we're not building any of the crowdsourced/ML threshold infra that the wrong framing implied — just a clean enforcement-of-user-intent layer.

### Demo Day moment (locked)
> *"Last month, this number called my mom. She tapped Block. Watch what happens when they try again."*
>
> [Phone is silent. Lock screen stays dark. After three full seconds, a low-priority push slides down from the top: *"AegisDial · A scammer you blocked tried again — tap to see who."* Jesiah taps. The in-app history opens — there's the original Reddit thread Mom saw before she blocked, and a fresh "Attempted again 4 seconds ago" stamp.]
>
> *"That call would have rung. It would have woken her up. It would have started the script all over again. Instead, AegisDial remembered her decision — and the scammer hit a wall."*

### What this changes about AegisDial's pitch

**Before v3:** "We help you decide who to trust on every call."
**After A1 + A2:** "We help you decide once. Then we make that decision permanent — for you, and for the next family that gets the same call."

A1 + A2 together turn AegisDial from a per-call decision tool into a **memory layer** for the family. Mom decides once. The system remembers forever. The scammer that tried Mom yesterday tries Carol tomorrow — and Carol sees Mom's anonymized signal in her sources panel.

This is the lock-in moat. Truecaller has identification. LifeLock has reimbursement. Nobody else has memory.

---

## B3 — Stop Mom from saying the compromising thing

> **Original brainstorm framing:** *"Auto-mute the user during critical moments."*
>
> **iOS technical reality:** Third-party apps cannot mute the microphone of a regular carrier phone call. Apple gates that off. We can only mute mic in calls we own (CallKit-bridged VoIP via Twilio) — that's B5 territory, not B3.
>
> **Reframed B3 spec (working draft):** Use whatever iOS DOES allow to interrupt Mom's verbal flow at the exact moment she's about to compromise herself, so she stops talking long enough to hear AegisDial's warning.

### The intervention surfaces iOS DOES allow

We can't mute the mic. But we can do all of these:

1. **Visual interrupt** — full-screen red takeover with massive copy ("DO NOT SAY YOUR SSN — THIS IS A SCAM"). Phone app stays in background; AegisDial pulls to foreground with critical-priority push that auto-launches.
2. **Haptic burst** — three short Apple Watch taps + one long iPhone Taptic engine pulse. Wakes Mom up from auto-pilot. Doesn't reveal anything to the scammer.
3. **Audio cue in Mom's ear only** — if she's wearing AirPods (or speakerphone-off with earpiece), we can play a short Siri-voice line *"Pause — this is AegisDial. Don't say it."* through the AirPods/earpiece audio output stack. The scammer hears nothing if she's on AirPods. (Audible to scammer if she's on speakerphone — separate handling.)
4. **Apple Watch wrist tap with text** — for users with the Watch, a glanceable card: *"⚠ STOP TALKING — Scam confirmed."*
5. **Voice-over-call hijack** (PARTIAL) — we can NOT inject audio into the carrier call's downlink, but we CAN play audio out of the iPhone speaker. If Mom's on speakerphone, the *"Pause — this is AegisDial"* voice will be audible to BOTH parties — which actually still works, because it interrupts the script flow.

### The 5 dimensions to lock for B3

1. **PRIMARY MECHANISM** — which of the above is the hero intervention? (Visual takeover, haptic, audio-to-Mom, Watch tap, or layered combo?)
2. **TRIGGER** — what fires the intervention? (Live Shield score crosses critical? User says specific high-risk strings like a 9-digit number? AI predicts she's about to read a card number?)
3. **HARDWARE FALLBACK** — what does Mom get if she has no AirPods AND no Apple Watch AND her phone is in her pocket?
4. **DISMISS / OVERRIDE** — can Mom dismiss the warning if it's a false positive? (Sticky for N seconds, or one-tap dismiss, or holds until call ends?)
5. **ESCALATION TO FAMILY** — does triggering B3 also fire the family alert (via the v2 family infrastructure we already shipped)? Always? Only on confirmed-critical?

### Initial framing thoughts (before we walk dimensions)

- **The hero is probably layered, not a single mechanism.** A single intervention misses people. Ideal: visual takeover + haptic + (if AirPods) Mom's-ear voice all fire at once. Maximum chance Mom snaps out of the scam-script trance.
- **The trigger MUST come from Live Shield's existing scoring.** We already have the regex+Claude hybrid pipeline shipping in v2. B3 just consumes the `score = critical` event. Don't build a second ML pipeline.
- **Speakerphone is the dominant case for elders.** Most 65+ users use speakerphone. Audio-to-ear-only is great for AirPods users but won't be the default surface — visual takeover has to carry the load for speakerphone-on-table cases.
- **Demo Day moment writes itself.** Mom on speakerphone, scammer says *"now read me the code on the back of your card"*, phone screen goes red, voice booms out *"PAUSE — DO NOT READ THAT CODE."* Scammer panics, hangs up. End scene.

We walk these one at a time, same pattern as A1 and A2.

### 2026-05-10 — B3 primary mechanism: visual takeover only
The hero intervention is a single mechanism: a full-screen red takeover with massive copy, auto-launched to foreground via critical-priority push at the moment Live Shield's score crosses critical.

**Why this beats the layered alternatives for v3:**
- **~2 days iOS build vs ~5 days for the layered version.** v3 has a Demo-Day deadline, not a v4 polish budget.
- **The dominant elder use case is speakerphone with phone on the table.** Mom is sitting with the phone in front of her, screen visible. A red flash on the screen catches the eye even mid-sentence.
- **Visual takeover doesn't degrade.** Voice in AirPods only works for AirPods users. Haptic only works if she feels it. The screen is always available when it's available — and when it's not (face-down/pocket), no mechanism works anyway, so we don't lose anything by not stacking them.
- **Clean upgrade path.** v3.5 can layer haptic on top without changing the trigger pipeline. v4 can add voice-in-ear. The trigger architecture is designed to fan out to multiple surfaces; we just only wire one in v3.

**Accepted limitation:** if Mom's phone is face-down on the table, in her pocket, or has the screen off, B3 v3 doesn't intervene. We document this in the family-onboarding copy: *"Tip: keep her phone screen-up during long calls — AegisDial works best when she can see it."*

**Implication for build:**
- New iOS view: `LiveShieldCriticalTakeoverView.swift` — full-screen red, system-large copy, single dismiss button
- Critical-priority push category that auto-foregrounds the app on receipt (via `UNNotificationContent.relevanceScore = 1.0` + interruption-level `.critical`)
- Backend hook: when Live Shield session score transitions to `critical`, fire `POST /v1/push/critical-takeover` to that user
- Telemetry: log every fire event, every dismiss, every "Mom kept talking anyway" outcome (correlated with whether she shared info per the post-call recovery flow)

### 2026-05-10 — B3 trigger: critical event OR Mom-side keyword sentinel
The takeover fires whichever of these happens first in a session:

**Path A (existing v2 infrastructure):**
Live Shield session score transitions to `critical` via the regex + Claude hybrid pipeline. No new code — just consume the existing event.

**Path B (new in v3):**
Mom-side audio is routed through STT in real time, and a sentinel-regex layer evaluates each transcript chunk against high-risk patterns:
- 9 consecutive spoken digits → SSN read aloud
- 16 consecutive spoken digits → card number read aloud
- "my card number is" / "the code is" / "my password is" / "my routing number is" / "my account number is"
- 6-digit pattern within 20 seconds of the scammer using an MFA-code phrase ("verification code", "security code", "auth code")
- "yes I authorize" / "I confirm" within 30 seconds of any payment-keyword context

If any sentinel matches, fire takeover IMMEDIATELY — don't wait for Claude.

**Why "OR" is the right call (not "AND"):**
- Path A catches *threats from the scammer*. Path B catches *moments from Mom*. They cover different halves of the danger window.
- Latency on Path B is ~50ms (regex on streamed STT chunks). Latency on Path A is 800ms–1.5s (Claude). Path B wins the race when Mom is mid-utterance.
- We accept some false-positive risk on Path B because the dismiss UX (locked next) makes false fires recoverable in <1s.

**Sentinel context-gating to keep false positives down:**
- "9 consecutive digits" only fires if the scammer-side audio in the last 60 seconds contained ANY of: "social security", "verify your identity", "ssn", "tax id", "social". If Mom is just reading off a phone number or a tracking code, no fire.
- "16 consecutive digits" same — gated on prior payment/card-related context from scammer side.
- "the code is" gated on prior MFA-prompt context.
- Pure prefix-only matches ("my card is in the drawer") don't qualify — sentinel requires *digit sequences* to actually trigger, not just the phrase.

**Implication for build:**
- New STT route for Mom-side audio (currently only scammer-side is transcribed in v2). Use the same Whisper-streaming pipeline.
- New `src/services/sentinelMatcher.ts` — runs regex set on each Mom-side transcript chunk + a 60-second rolling window of scammer-side context for gating.
- New `src/lib/sentinelPatterns.ts` — the regex pattern library (versioned, hot-pushable from backend without app release).
- Audit log of every sentinel fire: which pattern matched, what gating context, did it correlate with a real scam outcome. Tunes the pattern set over time.
- When Path B fires, also bump the Live Shield session score to `critical` so the rest of v2's machinery (family alert, post-call recovery handoff) kicks in.

**Build add: ~1.5 days backend (Mom-side STT routing + sentinel matcher + pattern library), ~0 iOS (the takeover view is the same regardless of which path fires).**

### 2026-05-10 — B3 dismiss + escalation: sticky + 'I'm safe' tap + family-alert backstop
The takeover is sticky — no casual one-tap dismiss. Mom must affirmatively tap 'I'm safe' to clear it. AegisDial keeps listening after the dismiss. If Live Shield's score stays critical, the family alert fires.

**The full sequence:**

```
T = 0.0s   Red full-screen takeover blazes on.
           Big copy: "STOP — SCAM CONFIRMED. DO NOT SHARE INFO."
           No dismiss button visible yet.

T = 0–5s   Sticky hold. Mom CANNOT dismiss. The scammer's high-pressure
           script is forced to wait — she physically can't make this go
           away. This is the structural intervention.

T = 5.0s   "I'm safe" button fades in at the bottom of the screen.
           Requires a 3-second long-press to confirm (prevents both
           accidental taps and scammer-rushed dismissals).

T = 8.0s   If she completes the long-press: takeover dismisses.
           Phone returns to call. AegisDial banner stays in status bar:
           "AegisDial is still watching this call."

T = 8s+    AegisDial Live Shield continues running. Score is monitored
           every transcript chunk. If score stays critical for 30+
           seconds AFTER dismiss AND Mom keeps talking, fire the
           family alert via v2's family infrastructure.

T = 38s+   Family alert sent. Mom's adult kid gets a push:
           "Mom is on a high-risk call right now — she dismissed our
            warning and the scam signals haven't stopped. Tap to call
            her or see the live transcript."
```

**Why this is the right design:**
- **Sticky 0–5s breaks the scammer's pressure script.** The scammer cannot talk Mom past it — she physically cannot dismiss. Five seconds of the scammer waiting in silence is enough to break their flow.
- **3-second long-press prevents both error modes.** Accidental dismiss is impossible (Mom can't pocket-dismiss it). Scammer-coached dismiss is harder (the scammer would have to coach Mom through "now press AND hold for three full seconds" — which itself is the kind of weird instruction that triggers her own suspicion).
- **Post-dismiss watch is the safety net.** Mom has agency to dismiss the warning if she's truly safe. But if she's NOT safe and was just pressured into dismissing, AegisDial doesn't give up — the family alert fires automatically when continued danger is detected. She doesn't have to ask for help; help comes.
- **Family alert reuses v2 infrastructure.** Already shipped. Same `family_alerts` table, same APNs delivery, same family privacy levels. Zero new infra for the escalation path.

**What "stays critical for 30+ seconds" means:**
- AegisDial Live Shield re-scores every new transcript chunk (existing v2 behavior).
- We require continuous critical state for 30 seconds — not just one momentary spike. This filters out cases where the scammer changes tactic and the score drops back to medium after the dismiss.
- The 30-second window is configurable from backend config (no app release needed to tune).

**Implication for build:**
- iOS: stickytimer + delayed button reveal + long-press handler in `LiveShieldCriticalTakeoverView.swift`
- iOS: persistent "AegisDial is still watching" status-bar banner after dismiss
- Backend: new `dismiss_event` log on the session — captures `(timestamp, score_at_dismiss, mom_continued_speaking_seconds)`
- Backend: post-dismiss watcher that compares current critical-state timer against the 30-second threshold; on cross, fire family alert via existing `dispatchFamilyAlert(session_id)` path
- Family-alert template: new copy variant for the "post-dismiss continued risk" case (different from the v2 first-detection alert) — emphasizes she dismissed and is STILL in danger

**Build add: ~1 day iOS + ~0.5 days backend (the family-alert dispatch is already there, just adding a new trigger condition + a different copy variant).**

---

## B3 — locked spec (synthesized)

**The feature in one paragraph:**
At the moment Live Shield detects a critical scam event OR the keyword sentinel matches Mom's own speech (about to read her SSN, card number, MFA code, password, etc.), AegisDial fires a full-screen red takeover that auto-launches the app to foreground. The screen is sticky for 5 seconds — no dismiss possible — forcing the scammer's pressure script to wait. After 5 seconds, an 'I'm safe' button appears requiring a 3-second long-press to confirm. If Mom dismisses, AegisDial keeps Live Shield running silently and a status-bar banner reads "AegisDial is still watching." If the call stays critical for 30+ seconds after dismiss, the family alert fires automatically using v2's existing family infrastructure.

### What's built today (from v2)
- Live Shield hybrid scoring pipeline (regex + Claude Haiku)
- Critical event detection
- Family alert dispatch with privacy levels (`dispatchFamilyAlert(session_id)`)
- APNs critical-priority push delivery
- Scammer-side STT pipeline

### What's not built (the v3 B3 work)

**Backend (~2 days total):**
- Mom-side STT routing (currently only scammer-side is transcribed)
- `src/services/sentinelMatcher.ts` + `src/lib/sentinelPatterns.ts` (regex pattern library, hot-pushable)
- Sentinel context-gating logic (60-second rolling scammer-side window)
- Post-dismiss watcher: tracks continuous-critical timer, fires family alert at 30s
- Dismiss event audit log + telemetry pipeline
- New family-alert copy variant for "post-dismiss continued risk"

**iOS (~3 days total):**
- `LiveShieldCriticalTakeoverView.swift` — full-screen red, system-large copy, 5s sticky timer, fade-in 'I'm safe' button, 3s long-press handler
- Critical-priority push handler that auto-foregrounds the app on receipt
- Persistent "AegisDial is still watching this call" status-bar banner (post-dismiss)
- Hooks into the existing v2 family-alert receive path (no new code needed for the receiving side)

**Total estimate: ~5 days for one engineer.** Lighter than A1's 9 days, on par with A2's 4.5.

### Demo Day moment (locked)
> *"Watch what happens when Mom is about to read her social security number to a scammer."*
>
> [Phone audio plays: scammer says *"to verify your identity, please read me your social..."* Mom starts: *"three... four... seven..."* — the screen blazes red instantly. Massive copy: **STOP — SCAM CONFIRMED. DO NOT SHARE INFO.** No dismiss button. Five seconds of silence on the call audio — the scammer is waiting, confused. The 'I'm safe' button fades in. Jesiah doesn't tap it.]
>
> *"In a real call, Mom would tap 'I'm safe' if she truly was. But if she didn't — if the scammer pressured her into dismissing it — AegisDial would keep watching. Thirty seconds of continued critical signals, and her son's phone would buzz: 'Mom dismissed our warning. She's still on the call. Tap to help.' She doesn't have to ask for help. Help comes."*

### What this changes about AegisDial's pitch

**Before B3:** "We tell you it's a scam."
**After B3:** "We physically interrupt the moment of compromise. And if you dismiss us under pressure, your family is automatically pulled in."

B3 is the most aggressive intervention in the v3 set — it's the only feature that actively *stops the call from working as the scammer intended*. A1 warns. A2 enforces past decisions. B3 intervenes in the present moment.

---

## B4 — Real-time fact-checking the caller

> **One-line spec:** When the scammer makes a verifiable claim during the call ("I'm with Wells Fargo's fraud department", "your case number is 47291", "your account ending in 4-7-2-1 was compromised"), AegisDial extracts the claim, runs it against public/contracted data sources via Claude tool-use, and exposes "DOESN'T CHECK OUT" inline as the call unfolds.

**Why this matters more than people realize:**
Most phone scams pivot on a fake authority claim that *could* be verified but never is. The scammer says they're from the IRS — Mom doesn't call the IRS to confirm. The scammer says her account ending in "4-7-2-1" — Mom doesn't pull her actual card to compare. The scammer says "case number 47291" — there is no case 47291 anywhere. **The lies are checkable; people just don't check.** B4 makes the check happen automatically and surfaces the result inline.

This is also where Claude tool-use is the *native* fit — better than A1 (pre-call lookup) or B3 (visual interrupt). Claude streams the transcript, recognizes claim shapes, calls verification tools, and reports findings. The LLM is doing detective work the way a forensic investigator would.

### What kinds of claims are eligible to fact-check

Categorizing the universe of scammer claims by checkability:

| Claim type | Example | Checkable how |
|---|---|---|
| Bank affiliation | "I'm with Chase fraud dept" | Is the calling number on Chase's published outbound number list? |
| Government agency | "This is the IRS Criminal Investigation Division" | IRS publishes their actual contact channels; agencies don't cold-call from random numbers |
| Account-tail digits | "Your account ending in 4721" | Compare against user's actual on-file last-4 (we have this from onboarding for some users; can ask politely) |
| Case/reference numbers | "Case #47291 in our system" | Real institutions have predictable case-number formats; many scammers use random integers |
| Employee name + title | "This is Officer Williams from..." | Cross-reference public agency staff directories (federal at usa.gov, etc.) |
| Caller ID spoofing | (the displayed number itself) | We already detect this via STIR/SHAKEN attestation level + carrier metadata in v2 |
| Geographic claim | "I'm at the federal courthouse downtown" | Reverse phone lookup origin city vs claimed location |
| Time-bound urgency | "You have 24 hours before warrant" | Pattern match — agencies don't issue warrants on phone calls |

### The 5 dimensions to lock for B4

1. **CLAIM-EXTRACTION MECHANISM** — how does AegisDial recognize that a claim was made worth fact-checking? (Regex patterns? Dedicated Claude pass? Same Claude as Live Shield with new tools?)

2. **VERIFICATION DATA SOURCES** — what does Claude query against? (Curated bank/agency directory we maintain? Public web search? AegisDial's own crawler results? User's on-file account-tail? Some combo?)

3. **HOW FINDINGS ARE SURFACED** — when a claim doesn't check out, where does Mom (and the watching family member) see it? (Inline transcript banner? B3-style takeover? Live Shield score boost only? Claude's voice in earpiece?)

4. **CONFIDENCE THRESHOLD** — Claude can say "false", "true", or "can't verify". When do we surface "DOESN'T CHECK OUT" vs stay silent? Three buckets, very different UX.

5. **LATENCY MODEL** — fact-checks take 1–5 seconds (tool-use round trip + Claude reasoning). Are findings surfaced as they arrive (delayed by N seconds), batched and surfaced at end of session, or only when Live Shield score is already elevated?

### Initial framing thoughts

- **Reuse v2's transcript stream — don't build a parallel pipeline.** Live Shield already has scammer-side audio → STT → Claude. B4 is a layer on top of that same flow.
- **Start with a small, high-confidence tool set.** Two or three verification tools that cover 80% of common scams (bank affiliation + agency affiliation + account-tail compare). Don't try to verify everything in v3.
- **The hero finding is "the claimed bank doesn't have outbound calls from this number."** That single finding alone, surfaced as "Wells Fargo never calls from this number — confirmed" inline, is more convincing than any other AegisDial signal.
- **Do NOT surface "verified true" findings.** If a scammer claims something we can't disprove, we stay quiet. Surfacing "VERIFIED" creates a trust attack surface (a sophisticated scammer learns the trigger and games it).
- **Latency is fine if framed right.** Even 5 seconds late, surfacing "Wait — they said they're from Chase, but Chase doesn't call from this number" mid-call is a banger moment. Mom doesn't need it instantaneous; she needs it before she hands over money.

We walk these one at a time, same pattern as A1, A2, B3.

### 2026-05-10 — B4 claim-extraction: dedicated Claude pass with structured output
Each transcript chunk goes to TWO Claude calls in parallel:
1. **Claude #1 — Live Shield risk scoring** (already shipping in v2)
2. **Claude #2 — B4 claim extraction** (new in v3)

Claude #2 has a single job: read the chunk + recent context, output a structured JSON list of verifiable claims the scammer made. The output schema is fixed:

```typescript
type ExtractedClaim =
  | { type: 'bank_affiliation'; bank_name: string; raw_quote: string }
  | { type: 'agency_affiliation'; agency_name: string; raw_quote: string }
  | { type: 'account_tail'; last_4_digits: string; raw_quote: string }
  | { type: 'case_number'; number: string; claimed_institution: string; raw_quote: string }
  | { type: 'employee_identity'; name: string; title: string; org: string; raw_quote: string }
  | { type: 'geographic_location'; claimed_location: string; raw_quote: string };
```

A separate verifier service consumes the claim list and runs each claim through its data source (locked in dimension #2 next). Findings flow into a session-level `b4_findings` collection that the iOS UI subscribes to.

**Why two passes instead of one:**
- **Separation of concerns.** Risk scoring and claim extraction are different LLM jobs with different prompts, different output formats, different evolution paths. Coupling them creates a single brittle prompt that does both poorly.
- **Independent evolution.** v3.5 might add 5 new claim types — that only requires updating Claude #2's schema, not Claude #1.
- **Independent failure modes.** If claim extraction's LLM breaks, risk scoring keeps working. v2 functionality isn't held hostage to v3 feature work.
- **Parallel execution.** The two calls fire simultaneously. End-to-end latency is `max(risk_score_latency, claim_extraction_latency)`, not the sum.

**Cost:** Roughly 2x current per-chunk LLM spend. Acceptable for v3 — Haiku 4.5 pricing absorbs this comfortably. We can optimize to a single pass later if cost becomes the binding constraint, but architectural clarity > marginal cost in v3.

**Implication for build:**
- New file: `src/services/claimExtractor.ts` — wraps the dedicated Claude #2 call with the structured-output prompt
- New prompt: tight extraction-only instructions, JSON schema, examples covering all 6 claim types
- Concurrency: claim extractor invoked from the same `processTranscriptChunk()` orchestrator that already calls the risk scorer in v2 — just `Promise.all([scoreChunk(), extractClaims()])`
- Persistence: extracted claims land in a new `b4_extracted_claims` table keyed by `(session_id, chunk_id)` — needed for both the verifier and post-call audit
- Telemetry: latency p50/p95 of Claude #2, cost per session

### 2026-05-10 — B4 verification sources: curated directory + live web search (two layers)
The verifier service consults sources in this strict order, falling through only when an earlier layer has no answer:

**Layer 1 — AegisDial curated directory (high-precision):**
A manually-maintained JSON file checked into the repo + a hot-pushable Postgres table for runtime updates. Contents:
- Top 50 US banks → published outbound number ranges + the rule "no bank cold-calls about fraud — they ask you to call them back at the number on the card"
- Major federal agencies (IRS, SSA, Medicare, FBI, U.S. Marshals) → published contact channels + the rule "these agencies don't make collection calls"
- Account-tail comparison against user's on-file last-4 (collected during AegisDial onboarding for users who consent — gracefully no-op for users who didn't)
- Known scam-script phrases ("federal warrant via phone", "iTunes gift cards as payment", etc.) — instant red flag

This layer answers: `bank_affiliation`, `agency_affiliation`, `account_tail`, plus serves as a sanity filter for any other claim ("does this employee even claim to be from an org we know?")

**Layer 2 — Serper web search via Claude tool-use:**
For claims Layer 1 can't answer (case numbers, employee names, geographic claims, novel agency claims), Claude invokes a `webSearch(query)` tool that hits Serper. Claude reads the results and decides whether the claim checks out, can't be verified, or is contradicted.

This layer reuses the **same Serper integration A1 already uses** for the live web crawl. No new vendor contract, no new infrastructure. Same client, new query patterns.

**Why this layered approach is the right call:**
- **Layer 1 catches the highest-value scams (bank/agency impersonation) with near-zero false positives.** This is where most of the dollar damage happens; precision matters most.
- **Layer 2 extends coverage to the long tail** without adding a new dependency. It's the same "we live-crawl the web and show the receipts" DNA that makes A1 work — applied to claim verification instead of number reputation.
- **Provenance survives end-to-end.** Every B4 finding carries the source it was checked against — for Layer 1, the curated entry; for Layer 2, the actual search-result snippet + URL. Mom can tap to see *exactly* what proved the scammer was lying.

**Finding-result schema (what the verifier outputs per claim):**

```typescript
type Finding = {
  claim: ExtractedClaim;
  result: 'contradicted' | 'cannot_verify' | 'consistent';
  confidence: number;     // 0..1
  reasoning: string;      // Claude's one-sentence explanation
  source_layer: 'curated' | 'web_search';
  source_url: string | null;       // for web_search
  source_snippet: string | null;   // for web_search
  source_curated_entry_id: string | null;  // for curated
}
```

**Important rule (locked):** if `result === 'consistent'`, we DO NOT surface anything to Mom. Only `'contradicted'` findings produce visible UI. (`'cannot_verify'` findings can boost the Live Shield risk score quietly but don't trigger user-facing UI.)

This is a security decision — surfacing "verified true" creates a trust attack surface. A sophisticated scammer learns the pattern and feeds claims that pass the verifier to manufacture trust. We never validate the scammer.

**Implication for build:**
- New file: `src/data/curatedB4Directory.json` — initial seed entries (top 50 banks, top 10 agencies, top 30 scam-script phrases)
- New table: `b4_curated_overrides` — hot-pushable additions/corrections without app deploy
- New file: `src/services/b4Verifier.ts` — orchestrator: tries curated first, falls back to Serper, packages `Finding`
- Claude tool definition: `webSearch(query: string) -> { results: Array<{title, snippet, url}> }`
- New table: `b4_findings` keyed by `(session_id, claim_id)`, holds the full `Finding` plus the post-call audit trail
- Serper rate limit + cost monitoring (we already have this from A1; just adds new query volume)

**Layer 1 build: ~1 day (seed + DB migration). Layer 2 build: ~1 day (orchestrator + tool wiring + finding persistence). Total ~2 days backend.**

### 2026-05-10 — B4 surface: B3-style takeover for contradicted findings (one per claim-type)
Every B4 finding with `result === 'contradicted'` AND `confidence >= 0.9` fires a full-screen red takeover identical in shape to B3's, but with finding-specific copy.

**Visual example:**

```
┌─────────────────────────────────────────────┐
│                                             │
│           THEY SAID                          │
│         "WELLS FARGO FRAUD"                 │
│                                             │
│    Wells Fargo never calls from this        │
│    number.                                  │
│                                             │
│    [ Tap to see source ]                    │
│                                             │
│         (5s sticky timer)                    │
│                                             │
│         [ I'm safe ] (long-press)            │
│                                             │
└─────────────────────────────────────────────┘
```

The dismiss + escalation behavior is identical to B3 — sticky 5s, 'I'm safe' requires 3-second long-press, post-dismiss family-alert backstop on continued critical state.

**Rate limit: max one takeover per claim-type per session.** The session tracks which claim types have already fired a takeover. Repeated contradictions on the same claim type (same scammer repeating the Wells Fargo line three times) don't re-fire — the first takeover is the impactful one; repeats train Mom to dismiss. Different claim types within the same call (bank affiliation, then case number, then employee identity) still each get their own takeover — those are NEW lies, each worth interrupting for.

This rate limit is tunable from backend config without an app release. Per-claim-type cap of 1 is the v3 starting point.

**Lower-confidence findings (`< 0.9`) handling:**
- DON'T fire a takeover.
- DO add to a session-level `findings` collection that the in-app post-call recap surfaces ("Things that didn't check out during this call: Wells Fargo affiliation, case number 47291...").
- DO bump the Live Shield risk score by `w_b4 * confidence`, feeding B3's existing critical trigger as a secondary escalation path.

**Why "B3-style takeover" is the right UX:**
- **Reuses 100% of the takeover component** we're building for B3. Zero new iOS UI. The component just needs a polymorphic content slot ({ headline, body, source_tap_payload }).
- **Caught lies are the most convincing AegisDial signal we'll ever produce.** Risk scores are abstract. "Wells Fargo never calls from this number" is concrete, falsifiable, and persuasive. Surfacing it weakly buries it.
- **The adult-kid use case loves this.** When Mom forwards a confused "what was that?" to her son after the call, the in-app recap shows the receipts. Renewal-driving moment.

**The confidence-threshold dimension (#4) becomes critical given this UX choice.** If we surface findings as full takeovers, the cost of a false-positive contradiction is high (Mom dismisses an interrupt that was actually wrong, learns to ignore future ones). We address that in dimension #4 next.

**Implication for build:**
- Refactor B3's `LiveShieldCriticalTakeoverView.swift` into a generic `CriticalInterruptView.swift` with a content-slot API
- B3 instantiates it with B3's copy; B4 instantiates it with the per-finding copy
- Backend dispatch: when a contradicted finding lands at confidence ≥ 0.9, check the per-session per-claim-type cap, then push a `b4_takeover` event over the same APNs critical-priority channel B3 uses
- New table: `b4_takeover_dispatched` to enforce the per-claim-type cap with a UNIQUE constraint on `(session_id, claim_type)`
- iOS push handler routes `b4_takeover` events into the same critical-interrupt presenter as B3 events
- Tap-to-see-source action in the takeover deep-links into the in-app source-detail view (same component A1's sources panel uses, just rendered for a single finding instead of a list)

### 2026-05-10 — B4 confidence threshold: ≥0.95 contradicted fires takeover
Initial threshold: takeover fires only when `result === 'contradicted'` AND `confidence >= 0.95`. Lower-confidence contradictions (0.50–0.94) bump the Live Shield score quietly and surface in the post-call recap, but don't interrupt.

**Why ≥0.95 is right at launch:**
- The cost of a wrong takeover is high — Mom dismisses an interrupt that was actually accurate (real Wells Fargo rep), then the next time AegisDial flags a real scam she dismisses that too. Trust in the takeover is the binding constraint.
- B4 isn't the only safety net. Live Shield's general regex+Claude critical-trigger still catches scams that don't depend on B4 verifying claims. We're not leaving Mom unprotected if B4 stays silent on a 0.85 finding.
- Backend-tunable. We ship adaptive: collect post-call user-feedback ("was that finding right?") for 60 days, then lower the threshold from config if Claude is well-calibrated.

**Implication for build:**
- Backend config: `b4_takeover_threshold` defaulting to 0.95, hot-reloadable
- New post-call user-feedback prompt: "AegisDial said the caller wasn't really from [bank/agency] — was that right?" with [Yes / No / Not sure] buttons. Feedback persisted to `b4_feedback` table for calibration analysis.
- Telemetry: per-claim-type accuracy, false-positive rate, missed-true-positive rate (estimable from post-call recovery actions).

**Treatment of `cannot_verify` and `consistent`:**
- `cannot_verify`: silent, +small score boost. Don't interrupt. Don't show. The risk score eventually carries the signal upstream into B3's existing critical-trigger if multiple cannot-verify findings stack.
- `consistent`: NOTHING. No score change, no UI, no log. Locked security rule from dimension #2. We never validate the scammer.

### 2026-05-10 — B4 latency: silent verify, fire when ready (no time cap)
The verifier runs silently. No "verifying..." indicator. No yellow caution banner. Mom and the watching adult kid see nothing during the verification gap. When a finding arrives, the takeover fires — no matter how long the verification took.

**Critical UX rule (locked):** the takeover ALWAYS quotes the original scammer claim verbatim, with the time-stamp of when it was said. Sample takeover copy:

> *"At 3:14 PM, the caller said: 'Hi, this is Wells Fargo's fraud department.'*
> *Wells Fargo never calls from this number — confirmed."*

The verbatim quote + timestamp grounds the takeover even if it lands 10–30 seconds after the original lie. Mom sees "they said this; we checked; they were lying" — the temporal gap doesn't erode the impact because the message is structured as a *delivered receipt*, not a real-time alert.

**Why no time cap:**
- A 30-second-late takeover with a verbatim quote is still hugely impactful. Mom hadn't reacted yet anyway; she's still on the same call with the same scammer running the same script.
- Time caps create complexity (per-finding TTL, edge cases around session-end-during-verification) for marginal UX wins.
- Simplicity wins for v3. If we discover post-launch that very-late findings actively hurt UX, we add the cap from backend config.

**Why no visible "verifying..." indicator:**
- Surfacing a loading state trains Mom to wait for AegisDial to confirm before reacting on her own. That's a regression. We want her independent judgment to fire FIRST and AegisDial to be the safety net, not the gate.
- A loading state for `consistent` findings feels like AegisDial silently saying "I checked and it was fine" — security attack surface we explicitly avoided in dimension #2.
- The takeover surprise is the magic. Pre-warning the user that a check is happening kills the surprise.

**Implication for build:**
- No new UI states needed for the verification gap — the existing call view stays untouched.
- Persist claim timestamp on extraction; render it in the takeover copy when the finding fires.
- Verifier service has no per-finding deadline at launch; sessions ending mid-verification still complete the verification and log the finding for post-call recap (just no takeover, since the call is over).

---

## B4 — locked spec (synthesized)

**The feature in one paragraph:**
A second Claude pass runs in parallel with v2's risk-scoring Claude on every transcript chunk. It extracts verifiable claims the scammer made (bank affiliation, agency affiliation, account-tail digits, case numbers, employee identity, geographic claims) into a structured JSON list. A verifier service checks each claim against a layered data set — Layer 1 is AegisDial's curated directory of bank/agency outbound channels and account-tail compare; Layer 2 is Serper web search via Claude tool-use. Any contradicted finding at confidence ≥ 0.95 fires a B3-style red full-screen takeover quoting the original lie verbatim with timestamp ("At 3:14 PM the caller said 'Hi, this is Wells Fargo fraud' — Wells Fargo never calls from this number"). Sticky 5s, 'I'm safe' long-press dismiss, post-dismiss family-alert backstop — exactly like B3, polymorphic content. Per-claim-type cap of one takeover per session prevents fatigue. No visible verification indicator; no time cap; consistent findings produce nothing.

### What's built today (from v2 + A1)
- Live Shield v2 transcript-streaming pipeline with scammer-side STT
- Claude (Haiku 4.5) integration for the existing risk-scoring pass
- Serper integration (from A1's crawler infrastructure)
- Phone-lookup service with Ekata + IPQS metadata
- APNs critical-priority push delivery (will be reused for B4 takeovers)
- B3's `CriticalInterruptView.swift` (refactored from `LiveShieldCriticalTakeoverView.swift` to be polymorphic)
- A1's source-detail view (reused for the tap-to-see-source action in B4 takeovers)

### What's not built (the v3 B4 work)

**Backend (~4 days total):**
- `src/services/claimExtractor.ts` — dedicated Claude pass with structured-output prompt + 6 claim type schemas
- `src/data/curatedB4Directory.json` — initial seed (top 50 banks, top 10 federal agencies, top 30 scam-script phrases)
- `src/services/b4Verifier.ts` — orchestrator: tries curated directory first, falls back to Serper web search
- Claude tool definition: `webSearch(query) -> { title, snippet, url }[]`
- New table: `b4_extracted_claims` keyed by `(session_id, chunk_id)`
- New table: `b4_findings` keyed by `(session_id, claim_id)` with full `Finding` struct
- New table: `b4_curated_overrides` for hot-pushable curated additions
- New table: `b4_takeover_dispatched` with UNIQUE `(session_id, claim_type)` for the per-type cap
- New table: `b4_feedback` for post-call calibration data
- Backend config: `b4_takeover_threshold` (default 0.95, hot-reloadable)
- APNs dispatch route for `b4_takeover` event
- Post-call recap aggregator: includes B4 findings (all confidence levels) in the call summary

**iOS (~2 days total):**
- Refactor B3's takeover view into the polymorphic `CriticalInterruptView.swift` with content slots (already partially in B3's plan)
- Push handler routes `b4_takeover` events into the same critical-interrupt presenter
- Tap-to-see-source action deep-links to A1's existing source-detail view rendered for one item
- Post-call recap UI extension: "What we checked" section showing all B4 findings with their results
- Post-call user-feedback prompt UI ("was that finding right?")

**Total estimate: ~6 days for one engineer.** B4 is the most ambitious of the four locked features — but it's also the one with the highest pitch leverage. "We caught the lie as they told it" is the single most persuasive sentence in the AegisDial deck.

### Demo Day moment (locked)
> *"Watch what happens when this scammer claims to be from a real bank."*
>
> [Phone audio plays: scammer says *"Hi, this is Wells Fargo's fraud department. We've detected suspicious activity..."* Three seconds pass. Mom on speakerphone says *"Oh dear, what's going on?"* Then — the screen blazes red. Massive copy:]
>
> > **AT 3:14 PM, THE CALLER SAID:**
> > **"Hi, this is Wells Fargo's fraud department."**
> >
> > Wells Fargo never calls from this number — confirmed.
> >
> > [ Tap to see source ]
>
> [Jesiah taps the source link. The actual Wells Fargo customer-service page slides up showing the bank's published phone numbers — none of them match the calling number. Jesiah swipes back; the call is still live; the scammer is still talking; he hangs up.]
>
> *"This is real-time fact-checking. The scammer told a lie that could be checked. AegisDial checked it. It quoted them back to themselves — at 3:14 PM, you said this — and then it showed the proof from Wells Fargo's own website. The lie collapsed in 4 seconds."*

### What this changes about AegisDial's pitch

**Before B4:** "We detect scam patterns."
**After B4:** "We catch their lies as they tell them — and we show you the receipt."

B4 is the first time any phone-safety product offers *real-time forensic verification* of a caller's claims. Truecaller checks the number. LifeLock reimburses post-fact. AegisDial does what a forensic investigator would do — it verifies the claim against ground truth, in real time, with provenance.

This is the AegisDial moat in its purest form: A1 surfaces what the open web already knows about the *number*. B4 surfaces what the open web knows about the *claim*. Together they're a comprehensive real-time interface to crowdsourced + institutional fraud knowledge that nobody else has built.

---

## B5 — Multi-party live shield

> **One-line spec:** When Mom is on a high-risk call, AegisDial brings a third party into the conversation so she's not alone — either her adult child from the family plan, an AegisDial human safety operator, or the AegisDial AI itself as a speaking participant.

**Why this matters:**
A1, A2, B3, B4 all give Mom *information* — a warning, a takeover, a quoted lie. But information alone often isn't enough to break the scammer's grip. Scammers are highly trained at maintaining authority *despite* warnings. The single most reliable scam-breaker is **another human voice on the line** ("Mom, hang up — that's not the IRS"). B5 makes that human (or AI surrogate) reliably available.

**The architectural fork that defines B5:**
You can NOT bring a third party into a regular carrier phone call from a third-party iOS app. Apple doesn't let you. The two paths around this:

1. **iOS native 5-way merge** — Mom manually merges in another caller using iOS's built-in conference UI. AegisDial can prompt her to do it but cannot execute it. Most legally clean, least reliable (Mom has to perform the merge during a stressful moment).

2. **Twilio bridge / AegisDial-controlled call** — the inbound call to Mom is routed through AegisDial's infrastructure (Twilio Programmable Voice). We own the audio bridge. We can add/remove participants, inject AI voice, record (where legal). Most reliable, biggest legal+technical lift, requires Mom's number to be a Twilio-managed number OR carrier-level call forwarding.

**The legal landscape:**
Twelve US states require two-party consent for any third party to join a call. If we bridge through Twilio and add a participant without disclosure, we expose ourselves to wiretapping liability. Workaround: an automated voice prompt at the moment of join — *"This is AegisDial. A safety contact has joined this call."* — given audibly to all parties. That counts as disclosure under most state laws but isn't bulletproof.

### Modes B5 could include

| Mode | Who joins | Build complexity | Legal risk | "wow" factor |
|---|---|---|---|---|
| **(a) Family one-tap join** | Adult child from family plan | Medium (Twilio bridge + iOS push tap-to-join) | Low (with disclosure prompt) | High |
| **(b) AI-as-participant** | AegisDial Claude voice via Twilio | High (real-time voice synth + Twilio + LLM-driven dialogue) | Medium | Highest |
| **(c) Human operator on-demand** | Paid AegisDial safety op | Highest (24/7 op staffing + queue + escalation pathways) | Low | Medium |
| **(d) iOS 5-way merge prompt** | Whoever Mom manually merges | Lowest (just a UI prompt) | None (Mom does the action) | Low |

### Pre-dimension scope question

B5 is the most ambitious feature on the list. Total v3 build for A1+A2+B3+B4 already lands at ~24–25 engineering days. Adding all four B5 modes would push v3 into 8+ weeks for a solo engineer. Most v3-shippable scopes:

- **Minimum:** Mode (d) only (iOS 5-way merge prompt). Mom hits a button, gets a coachmark *"Tap Add Call → pick from your family contacts → tap Merge."* AegisDial does NOT control the audio. ~1 day build.
- **Realistic v3:** Mode (a) only (family one-tap join via Twilio bridge). When critical fires, the family alert push has a "Join the call" button that bridges the kid in via Twilio with disclosure prompt. ~5–7 days build.
- **Aspirational v3:** Modes (a) + (b) (family + AI as participant). The AI mode is the demo-day stunner but doubles the build. ~12–14 days build.

The first dimension to lock for B5 is which of these scopes we're committing to.

### 2026-05-10 — B5 scope: family one-tap join only (realistic v3) — ROLLED BACK FROM ASPIRATIONAL
**Rollback note (2026-05-10):** We initially locked the aspirational scope (family-join + AI-as-participant). When we got to the technical-path dimension (Twilio bridge architecture), it surfaced an unsolvable problem at the v3 budget: AI-auto-injection mid-call requires us to own the entire audio bridge from the start, which forces us into either carrier-level call forwarding (operationally heavy, recurring infra cost, can silently break) or a separate Shield Number that scammers won't even dial (defeats the use case). Rather than scope-fight the bridge architecture, we scoped DOWN B5.

**Locked v3 scope:** family one-tap join only. AI-as-participant moves to v3.5/v4.

**The downgrade buys us:**
- No need for always-on Twilio bridge / forwarding / Shield Number
- ~5–7 days build instead of ~12–14
- v3 total drops from ~36–38 days to ~30 days
- Per-call legal disclosure model is cleaner than always-on
- Family-join works fine on a per-call basis (Twilio conference initiated when family taps "Join")
- AI-as-participant becomes a clear v3.5 milestone with shipping v3 user data to inform the design

**The downgrade costs us:**
- Lose the "AI cuts in at critical moment" demo-day stunner. Demo day moment is now "kid joins call and tells scammer to back off" — still impactful, less novel.
- "You're not alone" thesis softens slightly — it's still real (family is one tap away), but loses the "AI safety operator on every call" framing.

**Working principle this confirmed:** when scope creep collides with an unsolvable architectural problem, scope down rather than scope-fight the problem. The aspirational scope wasn't wrong as a destination — it was wrong as a v3 starting line.

### 2026-05-10 — B5 disclosure model: SUPERSEDED by direct-dial mechanics
The audible-disclosure model was locked under the assumption that AegisDial would own a Twilio audio bridge. With the bridge mechanics now locked as **direct iOS-native cellular call from kid to Mom + iOS native merge** (see dimension #3 below), there's no AegisDial-controlled audio path to play the disclosure on.

The legal exposure also collapses: when the kid uses iOS native Add Call + Merge, this is just a normal 3-way call between family members. AegisDial isn't in the audio path. The scammer wasn't "added by AegisDial" — they were already on the call with Mom; the kid joined via the same primitive Apple has shipped to every iPhone for 15 years. No two-party-consent exposure exists for AegisDial because we don't own or record the audio.

**The audit-trail substitute** is the in-app transcript event: AegisDial marks "Safety contact joined: [Tyler] at 3:14 PM" in the live transcript and persists it on the session record. The transcript already covers consent for v2 (Mom opted into transcript-streaming when enabling Live Shield); the join event is just one more system marker on it.

(The Twilio + AI-disclosure language is preserved in our notes for v3.5/v4 when the AI-as-participant scope returns and we DO need an audio bridge.)

**Open dimensions left to lock for B5 (now narrower):**
2. **TRIGGER** — does the family-join button surface only on critical events, or persistently during any call?
3. **BRIDGE MECHANICS** — when the family member taps "Join", what happens technically? (Twilio dials Mom's existing number for a 3-way conference she has to merge? Twilio dials both parties into a fresh conference she has to merge into? Or simplest of all — push the family member to just call Mom directly with no AegisDial bridge?)
4. **EXIT MODEL** — how does the family member leave? Auto when call ends? Mom can kick them? They hang up themselves?

We walk these next.

### 2026-05-10 — B5 trigger surface: critical-event push only, with two actions
The 'Join the call' button only appears in the family alert push notification. The push only fires on existing critical-detection triggers (v2 Live Shield critical OR the locked B3 post-dismiss escalation). Push has TWO actions:

1. **[Join the call]** — initiates audio bridge (mechanics locked next)
2. **[See live transcript]** — opens streaming text view that stays live until Mom's call ends, regardless of whether kid joined audibly

**Why two actions:**
- Transcript visibility gives the family member context to *decide* whether the audio-join is necessary. Some critical events resolve quickly (Mom hangs up on her own); the kid can read along, see the resolution, and skip the bridge.
- Transcript is a parallel channel of intervention. Even if audio-bridge fails (iOS merge friction), the kid has full visibility into what's said and can text Mom or call her separately.
- Reuses existing v2 family-transcript infrastructure (already shipping in PR #2). Zero new backend work for the transcript surface.

**Why NO always-on dashboard surface:**
- Privacy: family-plan members shouldn't be able to browse-and-join Mom's calls anytime. Tied to AegisDial's critical-event judgment is the right boundary.
- Scope: keeps v3 lean.
- Trust: Mom knows family can only listen when AegisDial deems critical, not on a whim.

**Implication for build:**
- Push notification template: two action buttons, with the deep-link payload carrying the conference ID + transcript stream ID
- Reuse existing v2 family-transcript view (no new iOS UI for transcript)
- New iOS push handler routes the two actions appropriately

### 2026-05-10 — B5 bridge mechanics: direct iOS-native call (no Twilio bridge)
When the kid taps [Join the call] on the family alert push, AegisDial initiates a **regular outbound cellular call** from the kid's iPhone to Mom's number. No Twilio. No AegisDial-controlled audio bridge. iOS native conference (Add Call + Merge) handles everything.

**The flow:**

```
T = 0s    Kid sees push: "Mom is on a high-risk call right now."
          Buttons: [Join the call] [See live transcript]

T = 1s    Kid taps [Join the call].
          AegisDial opens iOS Phone app with Mom's number pre-loaded.
          (One-tap fallback: "Tap to call Mom now.")

T = 2s    Kid's iPhone dials Mom's number via regular cellular outbound.
          AegisDial backend logs the join-initiation event.
          Live transcript marks: "Safety contact Tyler is calling..."

T = 5s    Mom's iPhone shows incoming call from Tyler (her real son).
          Mom recognizes him. She has three choices:
            (a) Tap red "End" to hang up on scammer + answer Tyler
            (b) Tap green "Hold + Answer" to put scammer on hold + answer Tyler
            (c) Use iOS native Add Call + Merge to bring Tyler into the conference
                with the scammer (3 taps).

T = 6s    Mom answers (any of the three options).
          AegisDial backend logs: "Safety contact joined at HH:MM:SS."
          Transcript marks: "✅ Safety contact Tyler joined the call."

T = ...   Tyler is now on the line with Mom (and scammer if she merged).
          Tyler is also still seeing the live transcript on his phone
          for context on what was being said before he joined.

T = end   Either party hangs up. AegisDial logs the join-end event.
```

**Why this is the right v3 call (locked):**
- **~2 days build instead of ~5–7.** Massive scope reduction at the cost of "kid hears the scam in progress."
- **Reliability is high.** No Twilio dependency. No iOS-merge requirement (Mom can choose to merge or just hang up on the scammer). No carrier forwarding. No special infrastructure.
- **Legal posture is bulletproof.** AegisDial isn't in the audio path. The kid using iOS native conference is no different from any normal 3-way family call. Two-party-consent doesn't apply.
- **Mom retains all her choices.** She can hang up on the scammer to answer Tyler. She can put the scammer on hold and talk to Tyler privately. She can merge them. She decides at the moment.
- **Audit trail still exists** — the join event is recorded in our backend AND marked in the live transcript stream the family is watching. That's the audit trail substitute for not having a Twilio recording.
- **The "kid never hears the scammer in progress" cost is mitigated** by the live transcript. Tyler reads what's being said before he calls. He has full context. By the time Mom answers him, he can say "Mom, hang up — that's not actually the IRS, I just read the whole script."

**The thing we lose vs the Twilio version:**
- The audible "AegisDial — a safety contact has joined this call" disclosure that announces to the scammer that backup just arrived. That moment was a strong scam-breaker on its own. With the direct-dial flow, the scammer only knows backup arrived if Mom merges them in.
- A Demo-Day "AegisDial-controlled disclosure" moment. Live demo will instead show "kid sees push, calls Mom via AegisDial deep-link, transcript marks 'safety contact joined,' Mom hangs up on scammer." Less novel, still impactful.

**Implication for build:**
- iOS: family alert push gets two action buttons; [Join the call] handler opens Phone app with Mom's number pre-dialed via `tel:` URL with deep-link confirmation
- Backend: new `/v1/family/initiate-join` endpoint — logs the event, fires a real-time transcript marker over the existing v2 family-transcript stream
- Backend: `/v1/family/join-completed` callback (best-effort — fires when AegisDial detects Mom answered, via Live Shield's existing call-state hooks; non-blocking)
- Transcript view: render new `system_event` type for "Safety contact joined" markers
- Push handler: deep-link routes `[Join the call]` → Phone app dial; `[See live transcript]` → in-app transcript stream

**Total B5 build estimate: ~2 days for one engineer.** Far below the ~5–7 days the realistic-v3-with-Twilio scope suggested.

### 2026-05-10 — B5 exit model: native iOS handling (no AegisDial state to manage)
With direct-dial mechanics, exit is whatever iOS already does for phone calls:
- Kid hangs up → their call ends, Mom continues with whatever she's doing
- Mom hangs up on Kid → same
- Mom hangs up on scammer (after merging) → conference reverts to Mom+Kid, normal call
- All parties hang up → all calls end normally

AegisDial backend logs `safety_contact_left` when Live Shield's existing call-state hooks detect the kid's call ended. Transcript marks: "Safety contact Tyler left the call at HH:MM."

No special exit logic needed. iOS owns the lifecycle.

---

## B5 — locked spec (synthesized)

**The feature in one paragraph:**
When Live Shield detects a critical event on Mom's call, the existing v2 family alert push fires to the family-plan members — but in v3, the push gets two action buttons: [Join the call] and [See live transcript]. Tapping [See live transcript] opens a streaming text view of the call (reuses v2 transcript infrastructure). Tapping [Join the call] deep-links to the iOS Phone app with Mom's number pre-dialed; the kid's iPhone places a regular cellular outbound call to her. Mom answers via iOS native UI — she can hang up on the scammer to answer the kid, put the scammer on hold, or use iOS native Add Call + Merge to bring everyone into a 3-way conference. AegisDial logs the join initiation and completion events on the session record AND marks them as system events in the live transcript ("Safety contact Tyler joined at 3:14 PM"). No Twilio bridge. No AegisDial-controlled audio. No two-party-consent exposure. ~2 days of engineering work.

### What's built today (from v2)
- Family alert push delivery infrastructure with privacy levels
- Family transcript streaming view (already shipped in PR #2)
- Live Shield call-state hooks
- Family-plan membership table

### What's not built (the v3 B5 work)

**Backend (~1 day):**
- `POST /v1/family/initiate-join` — logs the join initiation event, fires a system marker into the family transcript stream
- `POST /v1/family/join-completed` — best-effort callback when Live Shield detects Mom answered; updates the transcript marker to ✅
- `POST /v1/family/safety-contact-left` — fires when Live Shield detects the kid's call ended
- New `system_event` types in the transcript stream: `safety_contact_initiating`, `safety_contact_joined`, `safety_contact_left`

**iOS (~1 day):**
- Update family alert push notification template: add [Join the call] and [See live transcript] action buttons
- Push handler routes [Join the call] → opens iOS Phone app dialer with Mom's number pre-populated via `tel:` URL + deep-link confirmation screen
- Push handler routes [See live transcript] → opens in-app streaming transcript view (already exists in v2)
- Transcript view extension: render new `system_event` markers with the right styling (a small chip in the timeline)

**Total estimate: ~2 days for one engineer.**

### Demo Day moment (locked)
> *"Watch what happens when AegisDial detects this is critical and Mom is alone."*
>
> [Phone audio plays scam in progress. AegisDial fires B3+B4 takeovers as already shown. Then — across the demo stage, a SECOND iPhone (the family member's) buzzes. The push notification slides down: "Mom is on a high-risk call right now." Two buttons: [Join the call] [See live transcript]. The "kid" presenter taps [See live transcript] first. The streaming transcript fills the screen — they read along, see what the scammer said. Then they tap [Join the call]. Their phone dials Mom. Mom's iPhone (still in the scam call) shows incoming call from her son. She taps "End + Answer." The scammer is gone. The kid is on the line.]
>
> *"AegisDial doesn't replace family. It summons them. The kid had full context from the transcript. The call from him was one tap away. And in the moment Mom most needed someone, her son was on the other end of the line — not a chatbot, not an AI, not a stranger. Her son."*

### What this changes about AegisDial's pitch

**Before B5:** "We tell you it's a scam. We catch their lies. We interrupt the moment of compromise."
**After B5:** "And when none of that's enough, your family is one tap away — with full context."

B5 in this scoped form is the most honest feature in v3. It doesn't try to replace human protection with AI. It just makes human protection arrive at the right moment, with the right information. That's a more durable thesis than "AI safety operator on every call" — it's grounded in what families already do for elders, just made faster and better-informed.

The aspirational AI-as-participant scope returns in v3.5/v4 once we have v3 user data showing where family-join was insufficient — at which point the AI is a clear addition to a working product, not a from-scratch bet.

---

## v3 — final summary (all 5 features locked 2026-05-10)

| Feature | Build | Status |
|---|---|---|
| **A1** Push pre-warning with provenance | ~9 days | ✅ Locked |
| **A2** User-blocked numbers enforced at OS level | ~4.5 days | ✅ Locked |
| **B3** Visual takeover at moment of compromise | ~5 days | ✅ Locked |
| **B4** Real-time fact-checking the caller | ~6 days | ✅ Locked |
| **B5** Family one-tap join via direct dial | ~2 days | ✅ Locked |

**Total v3 budget: ~26.5 engineering days for a solo engineer (~5.5 weeks).**

### What this earns AegisDial

- A1 makes "we surface what the open web already knows" a real-time experience at the moment of ring
- A2 turns user decisions into permanent OS-level enforcement
- B3 physically interrupts the moment of compromise with sticky takeover + family-alert backstop
- B4 catches the scammer's lies as they tell them, with verbatim quote and source receipts
- B5 brings family in with full context when AI alone isn't enough

### The v3 thesis (locked, post-rollback)

> "v2 saved you during the call. v3 makes sure the call doesn't even happen — and when it does, you're not alone. The internet's collective scam-detection is in your pocket. Your family is one tap away."

### What v3 explicitly defers to v3.5/v4

- AI-as-participant (full Twilio bridge + ElevenLabs + Sonnet 4.6 dialogue agent)
- AegisDial Shield Number (alternate identity / always-on bridge)
- Carrier-level forwarding integration
- Live audio analysis of Mom's outbound calls
- Cross-AegisDial network effects beyond the cross-user fraud-graph signals already locked in A1/A2

These are all clear v3.5+ destinations once v3 ships and we have user data on where the gaps actually are.

---

## Cross-feature integration map

The five v3 features are NOT independent. They reuse components and share data structures. This map is the "what breaks if you change X" reference for the build phase.

### Shared iOS components

```
                      ┌─────────────────────────────────────┐
                      │   CriticalInterruptView.swift       │
                      │   (full-screen red takeover with    │
                      │    sticky timer + long-press)       │
                      └─────────────────────────────────────┘
                                ▲                    ▲
                                │                    │
                  ┌─────────────┘                    └────────────┐
                  │                                                │
            ┌─────────────┐                              ┌─────────────────┐
            │ B3 takeover │                              │ B4 takeover     │
            │ (critical   │                              │ (contradicted   │
            │  event)     │                              │  finding ≥0.95) │
            └─────────────┘                              └─────────────────┘

                      ┌─────────────────────────────────────┐
                      │   SourcesPanelView.swift            │
                      │   (list of mentions, each with      │
                      │    source/snippet/url/timestamp)    │
                      └─────────────────────────────────────┘
                                ▲                    ▲
                                │                    │
                  ┌─────────────┘                    └────────────┐
                  │                                                │
            ┌─────────────┐                              ┌─────────────────┐
            │ A1 sources  │                              │ B4 tap-to-see-  │
            │ panel (full │                              │ source (single  │
            │ list)       │                              │ finding)        │
            └─────────────┘                              └─────────────────┘
```

**Implication:** the polymorphic `CriticalInterruptView` and `SourcesPanelView` MUST be built first as v3 foundation work. B3 ships them; A1 and B4 both depend on them being polymorphic from day one. If they ship as feature-specific in B3/A1, B4 will need a refactor pass that costs 2 extra days.

### Shared backend services

| Component | Owner feature | Consumed by |
|---|---|---|
| `liveCrawlUnknown(e164)` orchestrator | A1 | A1 (pre-call), B4 (verifier as fallback) |
| `mentions` table | A1 | A1 (cache eligibility), A2 (block-signal contributions), B4 (provenance for verifier findings) |
| `phoneLookup` (Ekata + IPQS) | v2 (existing) | A1 (metadata in sources panel), B4 (verifier sub-tool) |
| `user_blocks` table | A2 | A2 (extension sync), A1 (block-signal source), family/audit trail |
| Live Shield risk-scoring Claude | v2 (existing) | B3 (critical trigger), B4 (parallel pass) |
| Mom-side STT pipeline | B3 (NEW in v3) | B3 (sentinel matcher), B4 (claim context window) |
| Scammer-side STT pipeline | v2 (existing) | All v3 features that consume transcript |
| `family_alert` dispatch | v2 (existing) | B3 (post-dismiss escalation), B5 (initial trigger) |
| Family transcript stream | v2 (existing) | B5 (system_event markers for safety-contact join) |
| Serper integration | A1 (existing in crawler) | A1 (live crawl), B4 (Layer 2 web search) |
| ElevenLabs / Sonnet 4.6 / Twilio | NONE in v3 | (deferred to v3.5/v4 — note absence) |

**Critical reuse insight:** B4 has heavy dependencies on B3's Mom-side STT routing AND on A1's `liveCrawlUnknown` AND on the polymorphic `CriticalInterruptView`. **B4 cannot start until B3 and A1 are at least partially in.** This drives the build order locked below.

### Shared cross-user signals

A1 introduces the cross-user fraud-graph contribution toggle (default-on, in settings). That toggle controls THREE behaviors:

1. **A1:** When user blocks a number from the sources panel's "Decline + Block" action, the anonymized signal flows into `mentions` with `source='aegisdial_user_block'`.
2. **A2:** When user blocks via any of the 4 surfaces (live shield post-call, A1 sources panel, in-app log, settings), the anonymized signal flows into `mentions` with `source='aegisdial_user_block'`.
3. **B4 (no contribution path):** B4 only consumes the fraud-graph as input via `mentions`; it doesn't produce new signals.

**Implication:** the toggle's UI + backend live in A2's settings module but its effect is multi-feature. Document it in one place; reference from A1, A2.

### Shared scoring + escalation chain

```
Live Shield session ─→ Live Shield Claude scoring (v2)
                       │
                       ├─→ score: critical → B3 takeover fires
                       │
                       └─→ B4 parallel claim-extraction Claude
                              │
                              ├─→ contradicted ≥0.95 → B4 takeover fires
                              │     (per-claim-type cap of 1)
                              │
                              ├─→ contradicted 0.50–0.94 → silent score boost
                              │     → may push score to critical → B3 fires
                              │
                              └─→ cannot_verify → silent score boost
                                    → may push score to critical → B3 fires

Both takeovers (B3 + B4) ─→ same dismiss/escalation behavior
                            │
                            └─→ post-dismiss watcher (30s continuous critical)
                                  └─→ family alert via v2 family-alert dispatch
                                        └─→ B5 push notification with [Join] [Transcript]
```

**Implication:** B3, B4, and B5 are not separate features — they're a chain. A finding from B4 can become a B3 takeover via score boost. A B3 takeover that gets dismissed becomes a B5 family alert. Building any of them in isolation produces broken-feeling UX.

### Shared transcript event types (new in v3)

The v2 family transcript stream gets new `system_event` types:

| Event | Fired by | Visible to |
|---|---|---|
| `live_shield_critical_entered` | v2 risk scorer | family transcript view |
| `b3_takeover_fired` | B3 | family transcript view |
| `b3_takeover_dismissed` | B3 | family transcript view |
| `b4_finding_contradicted` | B4 | family transcript view |
| `b4_takeover_fired` | B4 | family transcript view |
| `family_alert_dispatched` | B3 escalation OR v2 critical | family transcript view (kid sees their own arrival) |
| `safety_contact_initiating` | B5 | family transcript view |
| `safety_contact_joined` | B5 | family transcript view |
| `safety_contact_left` | B5 | family transcript view |

**Implication:** Dean writes ONE event-emit helper that all five features call into. Dean writes ONE renderer in the iOS family transcript view that handles all event types via a switch. Don't fragment.

### What this map tells the build

1. **Foundation week:** polymorphic `CriticalInterruptView`, polymorphic `SourcesPanelView`, Mom-side STT routing, the new transcript event taxonomy. Nothing feature-specific yet.
2. **A1 + A2** can build in parallel after foundation week (different code paths, only share `mentions` table).
3. **B3** layers onto foundation + A1/A2 (uses the same `CriticalInterruptView`, fires the same family-alert).
4. **B4** layers onto B3 (depends on Mom-side STT, polymorphic interrupt view, the parallel-Claude pattern).
5. **B5** layers last (lightest feature, depends on family-alert + transcript event types being live).

This is the build-order argument for the dependency graph (gap #4) — coming up next.

---

## Database schema additions (consolidated)

Single migration file: `migrations/046_v3_live_shield_v3.sql`. Built in one shot rather than per-feature so foreign keys can be defined inline.

### New tables

```sql
-- A1: top-N hot-numbers cache (the on-device extension reads from this)
CREATE TABLE a1_hot_numbers (
  e164 TEXT PRIMARY KEY,
  risk_weight DOUBLE PRECISION NOT NULL,
  mention_count INTEGER NOT NULL,
  primary_sources TEXT[] NOT NULL,  -- ['reddit', 'bbb', 'fcc', ...]
  last_recomputed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_a1_hot_numbers_recomputed ON a1_hot_numbers (last_recomputed_at);
CREATE INDEX idx_a1_hot_numbers_weight ON a1_hot_numbers (risk_weight DESC);

-- A2: user's personal block list (extension of v2 user_blocks; if v2's already exists, this is ALTER)
CREATE TABLE user_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  e164 TEXT NOT NULL,
  reason_code TEXT NOT NULL,  -- 'live_shield_critical' | 'a1_sources_panel' | 'call_log' | 'settings'
  source_surface TEXT NOT NULL,  -- where in the app the block was triggered
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  contributed_to_graph BOOLEAN NOT NULL DEFAULT true,  -- gated by user's settings toggle
  UNIQUE (user_id, e164)
);
CREATE INDEX idx_user_blocks_user ON user_blocks (user_id);
CREATE INDEX idx_user_blocks_blocked_at ON user_blocks (blocked_at DESC);

-- A2: track when a previously-blocked number tries again
CREATE TABLE block_retry_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  e164 TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notification_sent BOOLEAN NOT NULL DEFAULT false,
  notification_grouped BOOLEAN NOT NULL DEFAULT false  -- true if rate-limited into digest
);
CREATE INDEX idx_block_retry_user_time ON block_retry_attempts (user_id, attempted_at DESC);

-- B3: dismiss event audit log
CREATE TABLE b3_dismiss_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  takeover_fired_at TIMESTAMPTZ NOT NULL,
  dismissed_at TIMESTAMPTZ NOT NULL,
  score_at_dismiss DOUBLE PRECISION NOT NULL,
  trigger_path TEXT NOT NULL,  -- 'live_shield_critical' | 'sentinel_keyword'
  family_alert_escalated BOOLEAN NOT NULL DEFAULT false,
  mom_continued_speaking_seconds INTEGER  -- nullable; populated post-call
);
CREATE INDEX idx_b3_dismiss_session ON b3_dismiss_events (session_id);

-- B3: sentinel matcher pattern library (hot-pushable)
CREATE TABLE b3_sentinel_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_name TEXT NOT NULL UNIQUE,
  regex_source TEXT NOT NULL,
  required_scammer_context_regex TEXT,  -- 60-second rolling window gate; nullable means no gate
  scammer_context_window_seconds INTEGER NOT NULL DEFAULT 60,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- B4: per-chunk extracted claims (output of Claude #2)
CREATE TABLE b4_extracted_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  chunk_id UUID NOT NULL,
  claim_type TEXT NOT NULL,  -- 'bank_affiliation' | 'agency_affiliation' | 'account_tail' | 'case_number' | 'employee_identity' | 'geographic_location'
  claim_value JSONB NOT NULL,  -- the structured payload (varies by type)
  raw_quote TEXT NOT NULL,
  spoken_at TIMESTAMPTZ NOT NULL,  -- when the scammer said it
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_b4_claims_session ON b4_extracted_claims (session_id);

-- B4: verifier findings (one per claim, includes verification result)
CREATE TABLE b4_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES b4_extracted_claims(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  result TEXT NOT NULL,  -- 'contradicted' | 'cannot_verify' | 'consistent'
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reasoning TEXT NOT NULL,
  source_layer TEXT NOT NULL,  -- 'curated' | 'web_search'
  source_url TEXT,
  source_snippet TEXT,
  source_curated_entry_id UUID,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_b4_findings_session ON b4_findings (session_id);
CREATE INDEX idx_b4_findings_result_conf ON b4_findings (result, confidence DESC) WHERE result = 'contradicted';

-- B4: curated directory overrides (hot-pushable additions to the JSON seed)
CREATE TABLE b4_curated_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type TEXT NOT NULL,  -- 'bank' | 'agency' | 'rule'
  org_name TEXT NOT NULL,
  data JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- B4: track which (session, claim_type) combos already fired a takeover (per-type cap of 1)
CREATE TABLE b4_takeover_dispatched (
  session_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  claim_type TEXT NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finding_id UUID NOT NULL REFERENCES b4_findings(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, claim_type)
);

-- B4: post-call user-feedback for calibration
CREATE TABLE b4_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id UUID NOT NULL REFERENCES b4_findings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feedback TEXT NOT NULL,  -- 'correct' | 'wrong' | 'unsure'
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- B5: family-join event log
CREATE TABLE b5_safety_contact_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  family_member_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  protected_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,  -- 'initiating' | 'joined' | 'left'
  event_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_b5_events_session ON b5_safety_contact_events (session_id);
```

### Existing tables that get ALTERED

```sql
-- A1: cross-user contribution toggle on user-settings (or family_alert_preferences if reusing)
ALTER TABLE user_settings ADD COLUMN cross_user_contribution_enabled BOOLEAN NOT NULL DEFAULT true;

-- A1: extend mentions to include AegisDial-user-block as a source
-- (no schema change; just a new value of `source` column — make sure CHECK constraint allows it)
ALTER TABLE mentions DROP CONSTRAINT IF EXISTS mentions_source_check;
ALTER TABLE mentions ADD CONSTRAINT mentions_source_check
  CHECK (source IN ('reddit', 'bbb', 'fcc', 'youtube', 'notes800', 'serper', 'aegisdial_user_block'));

-- B3: consent + STT preferences
ALTER TABLE user_settings ADD COLUMN mom_side_stt_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE call_sessions ADD COLUMN b3_takeover_fired_at TIMESTAMPTZ;
ALTER TABLE call_sessions ADD COLUMN b3_takeover_dismissed_at TIMESTAMPTZ;

-- B4: per-session aggregate state (denormalized for query speed)
ALTER TABLE call_sessions ADD COLUMN b4_findings_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_sessions ADD COLUMN b4_contradicted_count INTEGER NOT NULL DEFAULT 0;
```

### Backend config keys (hot-reloadable, stored in `app_config` table)

| Key | Type | Default | Purpose |
|---|---|---|---|
| `a1.hot_numbers_cache_size` | int | 10000 | Top-N for the iOS extension cache |
| `a1.cache_recompute_interval_minutes` | int | 360 | Cron interval (6h default) |
| `b3.sticky_seconds` | int | 5 | Takeover sticky duration |
| `b3.dismiss_long_press_seconds` | int | 3 | "I'm safe" long-press requirement |
| `b3.post_dismiss_family_alert_seconds` | int | 30 | Continuous-critical window before family alert |
| `b3.notification_rate_limit_per_24h` | int | 3 | Max non-grouped retry pushes per day |
| `b4.takeover_threshold` | float | 0.95 | Confidence cutoff for takeover firing |
| `b4.score_boost_low_conf_weight` | float | 0.15 | Weight applied to low-conf contradicted findings into Live Shield score |
| `b4.score_boost_cannot_verify_weight` | float | 0.05 | Weight applied to cannot_verify findings |

---

## API surface (consolidated)

All routes are versioned under `/v1`. All routes require an authenticated user via the existing v2 JWT bearer token unless explicitly marked `[no auth]`.

### A1 — pre-call risk + sources panel

| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/v1/lookup/pre-call-risk?e164=X` | Lookup if number is in hot-numbers cache; returns risk metadata for the lock-screen banner | Cache miss → returns `{ in_cache: false }`; never falls through to live crawl (conservative cache-miss policy) |
| GET | `/v1/lookup/sources?e164=X` | Full sources panel data — array of mentions with provenance | Gated by user auth; returns up to 50 mentions sorted by recency × severity |
| GET | `/v1/lookup/cache-snapshot?since=<ts>` | Diff-update endpoint for the iOS Call Directory Extension's local cache | Streams adds/removes since timestamp; used by background sync |

### A2 — user blocks + OS-level enforcement

| Method | Path | Purpose | Notes |
|---|---|---|---|
| POST | `/v1/blocks` | Create a user block (any of the 4 surfaces) | Body: `{ e164, reason_code, source_surface }`; idempotent on (user_id, e164) |
| DELETE | `/v1/blocks/:e164` | Remove a user block | |
| GET | `/v1/blocks/snapshot?since=<ts>` | Diff-update for the iOS Call Directory Extension | Returns list of E.164 + remove markers since timestamp |
| GET | `/v1/blocks/explain?e164=X` | Returns user's original block reason + retry-attempt history | Used by A2 retry-notification tap-to-see-receipts |
| POST | `/v1/blocks/contribution-toggle` | Update cross-user contribution preference | Body: `{ enabled: bool }`; affects all 4 block surfaces |

### B3 — visual takeover

| Method | Path | Purpose | Notes |
|---|---|---|---|
| POST | `/v1/push/critical-takeover` | Internal — fires the critical-priority push to the user | Called by Live Shield's existing critical-event handler + sentinel matcher |
| POST | `/v1/sessions/:id/dismiss` | iOS reports the user dismissed the takeover | Body: `{ takeover_kind: 'b3' \| 'b4', score_at_dismiss }` |
| (internal) | `b3.sentinelMatcher` (worker) | Subscribes to Mom-side STT chunks; fires on regex+gate match | Not an HTTP route — internal worker |

### B4 — fact-checking

| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/v1/findings/:session_id` | All findings for a session (post-call recap) | Includes `result`, confidence, source provenance |
| POST | `/v1/findings/:id/feedback` | User submits "was this finding right?" | Body: `{ feedback: 'correct' \| 'wrong' \| 'unsure' }` |
| (internal) | `b4.claimExtractor` (worker) | Parallel Claude pass on each transcript chunk | Not an HTTP route |
| (internal) | `b4.verifier` (worker) | Curated lookup → Serper fallback → finding | Not an HTTP route |

### B5 — family one-tap join

| Method | Path | Purpose | Notes |
|---|---|---|---|
| POST | `/v1/family/initiate-join` | Family member taps [Join the call] | Body: `{ session_id }`; logs event, fires transcript marker |
| POST | `/v1/family/join-completed` | Live Shield's call-state hooks detect Mom answered the safety contact | Internal callback; fires `safety_contact_joined` transcript marker |
| POST | `/v1/family/safety-contact-left` | Live Shield's call-state hooks detect the safety-contact call ended | Internal callback; fires `safety_contact_left` transcript marker |

### Push notification categories (APNs)

| Category | Triggered by | Actions |
|---|---|---|
| `AEGISDIAL_PRECALL_WARNING` | A1 cache hit on inbound | (default tap → opens sources panel) |
| `AEGISDIAL_BLOCK_RETRY` | A2 — previously-blocked number retried | "View in app" |
| `AEGISDIAL_CRITICAL_TAKEOVER` | B3 OR B4 takeover | (auto-foregrounds app via interruption-level `.critical`) |
| `AEGISDIAL_FAMILY_ALERT` | v2 critical OR B3 post-dismiss escalation | "Join the call", "See live transcript" |

---

## Build order / dependency graph

The five features are NOT independent build streams. Some components must exist before others can begin. This is the topological order Dean follows — deviating costs rework.

### Phase 0 — Foundation week (~3 days, blocks everything)

These are the shared components that every later phase depends on. They MUST be built first.

| Day | Task | Files | Why first |
|---|---|---|---|
| 1 | Migration 046 | `migrations/046_v3_live_shield_v3.sql` | Every backend feature reads/writes these tables; nothing compiles without the schema |
| 1 | Backend config keys + hot-reload helper | `src/config/v3.ts` | Every feature reads these |
| 2 | Polymorphic `CriticalInterruptView.swift` | iOS | B3 + B4 both need it polymorphic from day one |
| 2 | Polymorphic `SourcesPanelView.swift` | iOS | A1 (full list) + B4 (single finding) both reuse |
| 3 | New transcript `system_event` types + emit helper | `src/services/transcriptEvents.ts` | All five features emit events into the family transcript |
| 3 | Mom-side STT routing | `src/services/momSideStt.ts` | B3 sentinel matcher + B4 claim extractor both consume |

**Phase 0 gate:** all six items green-checked before any feature work begins.

### Phase 1 — Independent feature builds (run in parallel)

After Phase 0, A1 and A2 are fully independent and can be built simultaneously by separate engineers (or one engineer alternating).

#### A1 stream (~9 days)

| Day | Task |
|---|---|
| 1 | A1 hot-numbers cache populator job (cron, 6h interval) |
| 2 | `GET /v1/lookup/pre-call-risk` + `GET /v1/lookup/sources` + `GET /v1/lookup/cache-snapshot` |
| 3–4 | iOS: Call Directory Extension cache sync + lookup wiring |
| 5–6 | iOS: pre-call notification template + handler |
| 7–8 | iOS: Sources panel content view (using polymorphic `SourcesPanelView`) |
| 9 | iOS: settings screen for cross-user contribution toggle + onboarding integration |

#### A2 stream (~4.5 days)

| Day | Task |
|---|---|
| 1 | `POST /v1/blocks` + `DELETE` + `/snapshot` + `/explain` + retry-detection hook |
| 2 | iOS: Onboarding "Enable Block Enforcement" screen + Settings deep-link + status watcher |
| 2 | iOS: Block-action surfaces in 4 entry points (Live Shield post-call, A1 sources panel, in-app log, settings) |
| 3 | iOS: `AEGISDIAL_BLOCK_RETRY` notification handler + in-app block-history view extension |
| 3.5 | Backend: rate-limiter + per-number coalescing for retry notifications |
| 4 | Backend: Call Directory Extension snapshot diff-stream optimization |
| 4.5 | iOS: A2 status surfaces in dashboard (Enabled / Pending / Disabled) |

### Phase 2 — B3 (~5 days, must come before B4)

B3 layers on top of Phase 0 and creates a few primitives B4 then reuses.

| Day | Task |
|---|---|
| 1 | `src/services/sentinelMatcher.ts` + `src/lib/sentinelPatterns.ts` (regex pattern library) |
| 1 | Sentinel context-gating logic (60-second rolling scammer-side window) |
| 2 | `POST /v1/push/critical-takeover` route + critical-priority APNs delivery |
| 2 | `b3_dismiss_events` audit logging + post-dismiss watcher (30s continuous-critical → family alert) |
| 3 | iOS: critical-priority push handler that auto-foregrounds the app |
| 3 | iOS: configure `CriticalInterruptView` instance for B3 (sticky 5s, 3s long-press, "I'm safe" → dismiss) |
| 4 | iOS: persistent "AegisDial is still watching this call" status-bar banner (post-dismiss) |
| 4 | Family-alert dispatch hook for "post-dismiss continued risk" copy variant |
| 5 | End-to-end test: critical event → takeover → dismiss → 30s wait → family alert fires |

### Phase 3 — B4 (~6 days, requires B3 in)

B4 requires `CriticalInterruptView` polymorphic (Phase 0), Mom-side STT (Phase 0), and the takeover-dispatch APNs path (Phase 2).

| Day | Task |
|---|---|
| 1 | `src/services/claimExtractor.ts` — dedicated Claude #2 with structured-output schema |
| 1 | `src/data/curatedB4Directory.json` — top-50 banks + top-10 federal agencies + top-30 scam-script phrases |
| 2 | `src/services/b4Verifier.ts` — curated-first → Serper-fallback orchestrator |
| 2 | `webSearch(query)` Claude tool definition |
| 3 | `b4_takeover_dispatched` enforcement (per-claim-type cap) + APNs dispatch via `AEGISDIAL_CRITICAL_TAKEOVER` |
| 3 | Backend: integrate B4 score-boost into Live Shield's existing scoring pipeline (low-conf contradicted + cannot_verify) |
| 4 | iOS: configure `CriticalInterruptView` instance for B4 (verbatim quote + timestamp + tap-to-source) |
| 4 | iOS: Tap-to-see-source → opens single-finding instance of `SourcesPanelView` |
| 5 | Backend: `GET /v1/findings/:session_id` + `POST /v1/findings/:id/feedback` |
| 5 | iOS: post-call recap UI extension — "What we checked" section with all findings |
| 6 | iOS: post-call user-feedback prompt (tunes confidence threshold over time) |

### Phase 4 — B5 (~2 days, last because lightest)

B5 depends on family-alert + transcript-event taxonomy being live, both of which are in by Phase 2/3.

| Day | Task |
|---|---|
| 1 | `POST /v1/family/initiate-join` + `/join-completed` + `/safety-contact-left` |
| 1 | New transcript `system_event` markers for all three B5 events |
| 2 | iOS: Family alert push template — two action buttons [Join the call] [See live transcript] |
| 2 | iOS: [Join the call] handler — opens iOS Phone with Mom's number pre-dialed via `tel:` URL + deep-link confirmation screen |
| 2 | iOS: Family transcript view extension — render new `system_event` markers as timeline chips |

### Phase 5 — Pre-ship hardening (~2 days)

| Day | Task |
|---|---|
| 1 | Adversarial code review (parallel-agent pattern, like v2's 4 CRITICAL + 6 HIGH session) |
| 1 | Fix everything red |
| 2 | Cross-feature E2E test: A1 → user blocks → A2 enforces → next call from same number → blocked silently |
| 2 | Cross-feature E2E test: critical event → B3 + B4 takeover → dismiss → 30s → B5 family alert → kid taps Join → transcript marker fires |
| 2 | Demo Day end-to-end script rehearsal |

### Total ordered timeline

```
Phase 0 (Foundation)       → 3 days  (must complete first; nothing else can start)
Phase 1 (A1 + A2 parallel) → 9 days  (longest is A1 at 9d; A2 finishes at 4.5d)
Phase 2 (B3)               → 5 days  (cannot start until Phase 0; A1/A2 may still be in flight)
Phase 3 (B4)               → 6 days  (cannot start until B3 + Phase 0 in)
Phase 4 (B5)               → 2 days  (cannot start until B3 + transcript events in)
Phase 5 (Hardening)        → 2 days  (after all features in)

Critical path (single engineer):  3 + 9 + 5 + 6 + 2 + 2 = 27 days
Critical path (two engineers parallelizing Phase 1):  3 + 9 + 5 + 6 + 2 + 2 = 27 days*
                                                      *Phase 1's A1 is the long pole regardless

Solo engineer estimate: ~27 working days = ~5.5 weeks of focused build.
```

### What CAN'T be parallelized

- Phase 0 must finish before Phase 1.
- B4 cannot start before B3 (Mom-side STT shared, takeover view shared, score-boost integrates into B3's escalation chain).
- Phase 5 hardening cannot start before all features in.

### What CAN be parallelized

- A1 and A2 are fully independent after Phase 0.
- B5 can start in parallel with B4 once B3's transcript-events are live (saves ~2 days off the critical path on a 2-engineer team).

### What's risky and might slow this

- iOS Apple App Review may push back on critical-priority push that auto-foregrounds the app during a call. **Mitigation:** test as soon as Phase 2 day 3 is in, not at Phase 5. Discover early.
- Mom-side STT cost at scale could exceed budget. **Mitigation:** track cost per session in Phase 0; sentinel-matcher work can be skipped (degrade B3 to Live-Shield-critical-only trigger) if Whisper costs prohibitive.
- The B3 sentinel context-gating regex ruleset is not fully written yet. **Mitigation:** Phase 2 day 1 includes "writing the patterns" as a real engineering task — it's not free.

---

## Risk register

Surprises Dean shouldn't have to discover during build. Each entry: what could break, why, mitigation, and when to validate.

### R1 — Apple App Review may reject critical-priority push that auto-foregrounds during a call
**Severity: HIGH. Probability: medium.**

Apple's interruption-level `.critical` push is gated. Apps must declare a Critical Alerts entitlement and justify the use case. Auto-foregrounding the app during a phone call has very little public precedent — phone-safety category apps may or may not qualify. If rejected, the entire B3 + B4 takeover UX collapses; we'd fall back to a non-foregrounding push that Mom may never see.

**Mitigation:**
- Apply for the Critical Alerts entitlement in week 1 (it's a separate developer-portal request, not just an Info.plist key)
- Submit the v2 build to App Review with the entitlement added (low-risk submission to test the waters before v3 fights through)
- Build a fallback: if entitlement is denied, B3 + B4 use a high-priority but non-critical push, with a sticky-banner-on-launch fallback for users who DO open the app

**Validate by:** Phase 2 day 3 (early, not at the end).

### R2 — iOS Call Directory Extension entry limit may not fit our use case
**Severity: MEDIUM. Probability: low for v3 (we're using user blocks only, ~hundreds of entries per user).**

Apple's CallKit Call Directory has historically capped blocking entries at 50k–100k depending on iOS version. v3 A2 is well under the cap because it's only the user's personal block list. But if A1's hot-numbers cache is implemented as a **blocking** extension (it isn't — it's an **identification** extension which is uncapped), the cap matters.

**Mitigation:**
- Make sure A1 uses the `CXCallDirectoryProvider`'s identification path (not blocking). A1 only WARNS via lock-screen banner; A2 is the only feature that BLOCKS at OS level.
- Document this distinction in the iOS code comments — it's easy to confuse.

**Validate by:** Phase 1 (A1 stream) day 3 — first time the iOS extension is exercised.

### R3 — Whisper / STT cost at scale could blow the unit economics
**Severity: MEDIUM. Probability: medium at v3 launch, HIGH at growth scale.**

v2 already streams scammer-side audio through Whisper. v3's Mom-side STT (B3 sentinel matcher + B4 claim extractor's context window) **doubles** Whisper minutes per call. At 200 min/mo per user × $0.006/min × 2 streams = ~$2.40/mo per user. On $49.99 revenue that's ~5% cost. Manageable, but we'd want to know if it's actually that cost vs higher.

**Mitigation:**
- Phase 0 day 3 instrument Whisper-minutes-per-session telemetry. Watch p50/p95.
- Build a backend config flag `b3.mom_side_stt_enabled` — can disable at runtime if cost blows up.
- If Mom-side STT becomes prohibitive, B3 degrades to Live-Shield-critical-only trigger (no sentinel matcher). Functional but with a tighter intervention window.

**Validate by:** Phase 0 day 3 + ongoing in production telemetry.

### R4 — Sentinel regex false positives are inherent to regex; need real-world tuning
**Severity: MEDIUM. Probability: HIGH.**

The B3 sentinel matcher fires on patterns like "9 consecutive digits" gated by 60-second scammer-side context. This will false-positive on edge cases (Mom reading a tracking number, dictating an address, helping a grandkid with homework). Each false positive trains Mom to dismiss B3 takeovers.

**Mitigation:**
- The sentinel pattern library is in a hot-pushable Postgres table, not hardcoded — we tune live without app releases.
- Phase 5 hardening includes adversarial test cases for known false-positive scenarios.
- The dismiss-event audit log captures every fire + outcome — we have signal to tune from week 1 of production.
- Consider a "false positive — don't show again" user-feedback path on the dismiss screen (deferred to v3.5; flag here for awareness).

**Validate by:** Phase 5 hardening + first 30 days of production telemetry.

### R5 — Account-tail comparison requires onboarding data we may not have
**Severity: MEDIUM. Probability: medium.**

B4's `account_tail` claim verification compares against the user's actual on-file last-4. This data isn't in v2's onboarding flow — we don't ask Mom for her bank-account or card last-4 today. Adding this is a real onboarding-redesign task.

**Mitigation:**
- v3 ships with `account_tail` verification gracefully no-op-ing for users who didn't provide last-4 data (returns `cannot_verify`)
- Onboarding-redesign ask "Add your card last-4 for stronger fraud protection?" is a soft v3 add, can ship after main features in
- Marketing line for users who don't add: "Add your card last-4 to enable account-number verification on calls."

**Validate by:** Phase 3 (B4) day 5 — make sure the gracefully-no-op path actually works.

### R6 — Curated B4 directory becomes maintenance burden
**Severity: LOW immediate, MEDIUM long-term. Probability: HIGH long-term.**

Top-50 banks change, federal agencies update their published numbers, scam scripts evolve. A curated directory is value at launch but ages without ongoing maintenance.

**Mitigation:**
- The hot-pushable `b4_curated_overrides` table allows additions without app releases
- Quarterly review process flagged in v3 launch playbook (post-launch, not pre)
- Long-term: AegisDial Support Ops can collect "wrong finding" feedback from users via the existing `b4_feedback` table; convert into directory updates

**Validate by:** Quarterly cadence post-launch.

### R7 — CallKit + VoIP push interaction can confuse iOS
**Severity: HIGH. Probability: low if done carefully.**

The B3 takeover relies on a critical-priority push that auto-foregrounds the app *during* a phone call. iOS has historically had bugs where VoIP-push + CallKit interactions go sideways (calls disconnect, push delivers but app doesn't foreground, etc.). This is **especially dicey** because we're not a VoIP app — we're a regular app trying to interrupt a CallKit-presented call.

**Mitigation:**
- Phase 2 day 3 onwards, test on multiple physical devices across iOS 17 / 18 / 19 (not simulator)
- Document the exact push payload + entitlements that work
- Have a fallback: if the push doesn't reliably auto-foreground, the B3 takeover degrades to a sticky banner that Mom sees only when she opens the app — still useful post-call

**Validate by:** Phase 2 day 3 + Phase 5 hardening.

### R8 — Family-alert escalation could double-fire (B3 post-dismiss + v2 critical detection)
**Severity: LOW. Probability: medium.**

v2 already fires a family alert on initial critical detection. B3 v3 fires another family alert on post-dismiss + 30s continuous critical. Without de-dup logic, the family member could get TWO pushes for the same call — first when critical fires, second when the post-dismiss watcher trips.

**Mitigation:**
- Backend de-dup: per-session per-family-member, only one family-alert push allowed in any 60-second window. Subsequent triggers update the existing push payload via APNs replacement, not new push.
- Phase 2 day 4 explicitly includes "verify only ONE push fires per session" as a test case.

**Validate by:** Phase 2 day 4 + Phase 5 cross-feature E2E.

### R9 — The B3 + B4 takeover UX may overwhelm Mom on a real scam call
**Severity: MEDIUM. Probability: medium.**

A worst-case session: B3 fires takeover at 0:30, Mom dismisses, B4 fires takeover at 1:00 (different claim type), Mom dismisses, B4 fires another at 1:45 (different claim type), Mom dismisses... etc. Per-claim-type cap helps but doesn't eliminate.

**Mitigation:**
- Per-session takeover budget cap (e.g., max 4 total takeovers per session including B3 + all B4 types). Beyond that, fall back to in-app log + score boost only.
- The post-dismiss family-alert escalation is the safety net once dismissals stack up.
- User feedback ("did this fire too often?") collected post-call.

**Validate by:** Phase 5 cross-feature E2E + first 30 days of production.

### R10 — Two-party-consent legal posture for transcript collection (existing v2 risk, surfaces again in v3)
**Severity: HIGH. Probability: low (v2 already handles).**

v3 doesn't introduce new transcript-collection — Mom-side STT is collecting Mom's own audio (her phone, her consent). But B5's transcript-streaming-to-family member raises a question: is the family member viewing the live transcript a "third-party recording"?

**Mitigation:**
- v2 already gates transcript-streaming behind Mom's consent during onboarding (existing privacy-level controls)
- v3 reuses the same consent model — no new ask
- Legal review (already engaged for v2) confirms before ship that B5's family-transcript view is consistent with the existing consent
- Family member is a designated trusted contact, not a random third party — distinguishing this in our consent copy

**Validate by:** Phase 5 — legal review pass before TestFlight beta widening.

---

## Privacy + consent model

This section consolidates every consent surface across the v3 features so Dean has one place to reason about it. The high-level rule:

> **Every new data flow in v3 piggybacks on a consent the user has already given OR introduces a single explicit toggle. We never silently expand the consent envelope.**

### Consent surfaces (in order of when the user encounters them)

#### 1. Onboarding — first-launch consent flow

The v2 onboarding already collects:
- Phone-number verification
- Family-plan setup (if joining as a protected user)
- Notification permission
- Live Shield audio analysis consent (the v2 "we listen for scam patterns" agreement)

**v3 ADDITIONS to onboarding:**

| New ask | Default | Where in onboarding | Required? |
|---|---|---|---|
| Enable Block Enforcement (Call Directory Extension) | enabled | New screen, Step 4 | Optional but recommended; A2 doesn't function without it |
| Cross-user contribution toggle (anonymized block signals) | ON | Step 5, single line + toggle | Optional; users can decline |
| Mom-side STT for sentinel matcher (B3) | ON | Bundled into existing Live Shield consent screen | Reframed copy: "AegisDial listens to both sides of the call to protect you" |
| Account-tail collection (B4) | (skipped initially) | Soft prompt, post-onboarding | Optional, can be enabled later |

**Onboarding consent copy (locked principles):**
- Plain English, 5th-grade reading level. Mom reads this, not a lawyer.
- Each ask is one screen. No bundling.
- Each ask explains the WHY in one sentence.
- "What does this mean?" link for the curious; not required for completion.

#### 2. In-app settings — granular controls

All v3 toggles surface in Settings → Privacy & Protection. The user can review and change after onboarding.

| Setting | Stored in | Default |
|---|---|---|
| OS-level block enforcement (A2) | iOS Settings (Apple-owned) | per onboarding choice |
| Cross-user contribution (A1/A2 fraud-graph signals) | `user_settings.cross_user_contribution_enabled` | ON |
| Mom-side STT (B3) | `user_settings.mom_side_stt_enabled` | ON |
| Family-plan transcript visibility (existing v2) | `family_alert_preferences` (existing v2 table) | as configured in v2 |
| Block notifications (A2 retry alerts) | `user_settings.block_retry_notifications_enabled` | ON |
| B4 takeover threshold (advanced) | `user_settings.b4_takeover_threshold_user_override` (nullable) | NULL → use backend default |

#### 3. Per-call consent prompts

**None.** v3 deliberately does not add per-call consent prompts. Every protection action is governed by the persistent settings above. Per-call prompts during a stressful scam call would be exactly the wrong UX.

#### 4. Family-plan member consent (the "watching" side)

A family-plan member who taps [See live transcript] on a critical-event push is consenting to view live data about the protected user (Mom). Two relevant facts:

- Mom already consented to family-plan transcript visibility during her v2 onboarding, governed by her chosen privacy level (minimal/default/open). This survives v3 unchanged.
- The family member's tap-to-view is itself a positive consent action. The push notification UI clearly identifies what's about to happen.
- The B5 [Join the call] action requires a tap; tapping = consent to be in a phone call (which is intuitive).

#### 5. Audit-trail data retention

We retain audit-trail records (block events, dismiss events, finding records, family-join events) under v2's existing 14-table retention sweep. v3 adds the new tables to that sweep:

- `user_blocks`: retained while user account active; deleted on account deletion (no time-based sweep — user explicitly created these)
- `block_retry_attempts`: retained for 90 days, then aggregated and individual records purged
- `b3_dismiss_events`: retained for 90 days, then aggregated
- `b4_extracted_claims`, `b4_findings`, `b4_takeover_dispatched`: retained for 90 days, then aggregated
- `b4_feedback`: retained for 12 months (calibration analysis), then aggregated
- `b5_safety_contact_events`: retained for 90 days, then aggregated

Retention worker is the existing v2 cron — Dean adds the new tables to its config, doesn't write new code.

### Cross-user contribution privacy guarantees

When the user has cross-user contribution enabled, the only data that flows out of their account into the cross-user fraud graph is:

```jsonc
{
  "e164": "+15555550142",         // the blocked number (NOT the user's number)
  "source": "aegisdial_user_block", // marker
  "scam_category": null,            // optional, only if user supplied a reason
  "severity": 0.7,                  // computed from reason_code
  "weight": 1.0,                    // standard
  "observed_at": "2026-05-09T..."   // anonymized to nearest hour
}
```

Things that explicitly DO NOT flow:
- The user's own E.164 number
- Any user identifier
- The user's transcript or audio
- Any name, address, or other PII
- The exact timestamp (rounded to hour)

This is the core privacy promise of A1 + A2's network-effect feature. Every public-facing copy must be consistent with this.

### Legal review checklist (Phase 5 hardening)

Before TestFlight beta widens, the following must be reviewed:
- [ ] All onboarding screens reviewed for plain-language compliance
- [ ] Cross-user contribution copy reviewed against state-by-state privacy laws
- [ ] B5 family-transcript consent flow reviewed against existing v2 consent model
- [ ] Mom-side STT consent reviewed (now collecting more audio than v2)
- [ ] Audit-trail retention reviewed against any active CCPA / state-privacy access requests
- [ ] App Store privacy nutrition label updated with new data categories

---

## Telemetry plan

What we instrument so we can see whether v3 is actually working in the wild. Every event has a clear consumer (a dashboard or a backend job).

### Event taxonomy

All events emit to the existing v2 telemetry pipeline (Postgres `events` table with hourly aggregation; same shape as v2). New event types in v3:

#### A1 events

| Event | When | Properties | Consumer |
|---|---|---|---|
| `a1.cache_lookup` | Inbound call lookup | `e164_hash, in_cache, latency_ms` | Cache hit-rate dashboard |
| `a1.warning_shown` | Pre-call notification displayed | `e164_hash, source_count, primary_sources` | Warning effectiveness dashboard |
| `a1.sources_panel_opened` | User taps notification | `e164_hash, time_from_warning_ms` | Engagement |
| `a1.source_link_tapped` | User taps a specific source | `source, e164_hash` | Which sources drive trust? |
| `a1.action_taken` | Decline / answer-anyway / decline+block | `action, e164_hash` | Decline rate; block-conversion rate |

#### A2 events

| Event | When | Properties | Consumer |
|---|---|---|---|
| `a2.extension_status_change` | iOS extension enabled/disabled | `enabled, days_since_install` | Adoption funnel |
| `a2.block_created` | New user block | `surface, reason_code, contributed_to_graph` | Block-creation rate by surface |
| `a2.block_retry_blocked` | Previously-blocked number tries again | `e164_hash, days_since_block` | Retry-rate; "scammers come back" data |
| `a2.retry_notification_shown` | Push delivered | `grouped_into_digest, hours_into_quiet_hours` | Notification fatigue tuning |

#### B3 events

| Event | When | Properties | Consumer |
|---|---|---|---|
| `b3.takeover_fired` | Critical takeover displayed | `trigger_path, score_at_fire` | Fire-rate; trigger distribution |
| `b3.takeover_dismissed` | User completed long-press dismiss | `seconds_to_dismiss, score_at_dismiss` | Trust signal: how fast do users dismiss? |
| `b3.takeover_held_through_call_end` | User did NOT dismiss | `seconds_held, call_end_reason` | "She trusted us" vs "she fumbled" signal |
| `b3.post_dismiss_family_alert` | Family alert escalated | `seconds_after_dismiss, score_when_fired` | Escalation effectiveness |
| `b3.sentinel_match` | Mom-side regex fired | `pattern_name, scammer_context_present, took_takeover_action` | Pattern accuracy |

#### B4 events

| Event | When | Properties | Consumer |
|---|---|---|---|
| `b4.claim_extracted` | Claude #2 returned a claim | `claim_type, latency_ms` | Extractor performance |
| `b4.verification_completed` | Verifier returned a finding | `result, confidence, source_layer, latency_ms` | Verification accuracy + cost |
| `b4.takeover_fired` | Contradicted ≥0.95 fired | `claim_type, confidence, source_layer` | Fire rate by claim type |
| `b4.takeover_suppressed_by_cap` | Per-claim-type cap blocked a fire | `claim_type` | How often does cap actually trigger? |
| `b4.feedback_submitted` | User answered "was that right?" | `finding_id, feedback, claim_type, confidence` | Calibration tuning over time |

#### B5 events

| Event | When | Properties | Consumer |
|---|---|---|---|
| `b5.family_alert_received` | Push delivered to family member | `family_member_id_hash` | Reach |
| `b5.transcript_view_opened` | Family taps [See live transcript] | `seconds_after_alert` | "Read along" engagement |
| `b5.join_initiated` | Family taps [Join the call] | `seconds_after_alert` | Join-conversion rate |
| `b5.join_completed` | Mom answers the family member | `seconds_after_initiate` | Reliability of direct-dial path |
| `b5.scammer_dropped_after_join` | Inferred from call-end timing | `seconds_after_join` | "Scam-breaker" effectiveness |

### Dashboards (built in Phase 5)

1. **v3 Adoption** — % of users with each feature active (extension enabled, cross-user toggle on, etc.)
2. **v3 Effectiveness** — funnel: scam call → A1 warning → user blocks → A2 retry caught (the "did the system work end-to-end?" metric)
3. **B3 + B4 Takeover Health** — fire rate, dismiss-time distribution, false-positive estimate from feedback
4. **Cost per session** — Whisper + Claude + Serper $ per protected call; alarm if it exceeds $0.50
5. **Family-plan engagement** — alerts received vs viewed vs joined; cross-user contribution rate

### Alerts

| Alert | Threshold | Owner |
|---|---|---|
| B4 takeover false-positive rate >15% (rolling 7d) | from `b4.feedback_submitted` data | Dean (engineering) |
| Whisper cost per session >$0.30 | from cost-tracking | Jesiah (founder) |
| A2 extension adoption <40% of new installs | from `a2.extension_status_change` | Jesiah (onboarding UX) |
| Critical-priority push delivery failure rate >5% | from APNs response codes | Dean |
| Family alert → join conversion <20% | from `b5.join_completed / b5.family_alert_received` | Jesiah (B5 UX) |

---

## Demo Day master script

The 4-minute end-to-end demo that hits all five v3 features in sequence. This is the script Jesiah rehearses, not the engineering spec — but Dean needs to know the demo flow because the build must support it.

### Setup (before demo starts)

- Two iPhones: "Mom's phone" (the protected user) and "Tyler's phone" (the family-plan adult kid). Both visible to audience.
- Demo scammer voice plays from a third device representing the inbound caller.
- Mom's phone is in family plan with Tyler. Cross-user contribution toggle ON. All v3 features enabled.
- A pre-seeded scam number in our hot-numbers cache with a fully populated sources panel (5+ Reddit/BBB/FCC mentions). The scammer "calls" from this number.
- Mom has previously blocked one OTHER scam number in a past test session (so we can demo A2 retry).

### Script (with rough timing)

#### 0:00–0:30 — Setup the world

> *"Phone scams are a $10.3 billion problem. The current generation of phone-safety apps tells you a number MIGHT be a scam. AegisDial v3 changes the question. We're going to show you what happens to one phone call, end to end, in five real moments."*

#### 0:30–1:00 — A2 retry blocked silently (the proof of past protection)

> *"Last week, Mom blocked this number after a Live Shield session caught it scamming her. Watch what happens when they try again."*

A pre-recorded scam number redials Mom's phone. Mom's phone stays silent. Audience sees the silence (no ring, no notification). Three seconds later a low-priority push slides down on Mom's phone:

> *AegisDial · A scammer you blocked tried again — tap to see who.*

> *"That call would have woken her up. Started the script all over again. Instead, AegisDial remembered her decision — silently."*

#### 1:00–1:45 — A1 pre-call warning (the open-web crawl moment)

> *"Now watch what happens when an unknown number calls — one we've never seen, but the open internet has."*

Demo scammer calls from a NEW number. Mom's phone rings. Lock screen blazes red:

> *🚨 Possible scam — flagged on Reddit, BBB +5 sites.*

Tap. Sources panel slides up: 7 entries, each with source icon, snippet, date, tappable URL. Jesiah taps the Reddit link → opens the actual r/Scams thread on the demo iPad → audience sees a real victim describing the same script.

> *"Mom didn't have to trust me, AI, or anyone else. The crowd already had her back. The receipts were one tap away."*

#### 1:45–2:30 — She answers anyway (B3 + B4 stack)

Mom taps "Answer anyway" (the secondary option in the sources panel). Demo scammer says: *"Hi, this is Wells Fargo's fraud department. We've detected suspicious activity on your account ending 4-7-2-1..."*

A few seconds later, B4 fires. The screen blazes red:

> **AT 3:14 PM, THE CALLER SAID:**
> **"Hi, this is Wells Fargo's fraud department."**
> Wells Fargo never calls from this number — confirmed.
> [ Tap to see source ]

Jesiah taps the source. The actual Wells Fargo customer-service page slides up showing their published outbound numbers — none match the calling number.

> *"AegisDial caught the lie as it was told. Quoted them back to themselves. Showed Mom the receipt from Wells Fargo's own website."*

Jesiah swipes back. Demo scammer continues: *"Now please verify your social security number — read me your social..."* Mom (audio) starts: *"three... four..."* — B3's sentinel matcher fires. Screen blazes red:

> **STOP — SCAM CONFIRMED.**
> **DO NOT SHARE INFO.**
> *(5s sticky timer)*
> *[ I'm safe ]* (long-press)

> *"AegisDial caught Mom mid-sentence — before she could finish. The screen is sticky for five seconds. The scammer waits in silence. The script collapses."*

Jesiah does NOT dismiss. The audience watches the 5-second hold.

#### 2:30–3:15 — B5 family arrives (the human moment)

Cut to Tyler's phone. A push slides down:

> *AegisDial · Mom is on a high-risk call right now.*
> *[Join the call] [See live transcript]*

Tyler taps [See live transcript] first. The streaming view opens — audience sees the conversation populating in real time, including the system markers:
- 🟥 *Live Shield: critical*
- 🟥 *B4: "Wells Fargo affiliation" — DOESN'T CHECK OUT*
- 🟥 *B3: takeover fired — sentinel "social security" pattern matched*

> *"Tyler reads along. He has full context. He sees what we caught. Now watch."*

Tyler taps [Join the call]. His iPhone dials Mom's number. Mom's iPhone (still on the takeover screen) gets a second incoming call from "Tyler". Mom taps "End + Answer". The scammer is gone. Tyler is on the line:

> Tyler (audio): *"Mom, hang up. That was a scam. I just read the whole thing."*

A new system marker fires in both phones' transcript views:
- ✅ *Safety contact Tyler joined the call at 3:14 PM*

#### 3:15–3:45 — The thesis

> *"Five features. Five moments. One protected call."*
>
> *"v2 saved you during the call. v3 means the call doesn't even happen — and when it does, you're not alone."*
>
> *"AegisDial isn't a scam-detection app. It's the real-time interface to crowdsourced fraud knowledge — backed by your family. That's the moat. That's why we win."*

#### 3:45–4:00 — The ask

> *"We're shipping this in 5.5 weeks. We're raising $1.5M on a $10–12M post-money cap. If you live in the consumer-iOS-subscription category and you've ever wished there was a thoughtful product protecting your parents, we want to talk."*

### What the build must support for this demo

- **A2 retry detection working end-to-end** (Phase 1 day 4)
- **A1 cache hit + sources panel rendering smoothly** (Phase 1 day 8)
- **B4 takeover with verbatim quote + tap-to-source** (Phase 3 day 4)
- **B3 sentinel firing on "social security" or 9-digit-spoken pattern** (Phase 2 day 1)
- **B5 family transcript streaming with system_event markers visible** (Phase 4 day 2)
- **All five features visible in single session** — Phase 5 E2E test must include the demo scenario as a passing test

### Demo rehearsal cadence

- Phase 5 day 2: full demo dry-run with engineering
- Pre-Demo-Day week: 3 dry runs with timed delivery
- Day-of: minimum 1 fresh-device run on backup hardware before going on stage

---

## Test / review plan

What gets tested how, and which features need outside review.

### Unit tests (per feature, ongoing during build)

Standard pattern from v2 — every backend service has unit tests with the existing Bun test setup. Coverage gates:
- Backend services: ≥80% line coverage on new code
- iOS views: snapshot tests for `CriticalInterruptView` (B3 + B4 modes), `SourcesPanelView` (A1 list + B4 single mode)
- Critical paths: 100% on the score-merge logic, the sentinel matcher gating, and the per-claim-type cap enforcement

### Integration tests (Phase 5 hardening)

End-to-end scenarios that span features:

1. **The demo path** — A2 retry detected silently → A1 warning fires on new number → user answers → B4 catches lie → sentinel fires B3 takeover → user dismisses → 30s continuous critical → family alert → kid joins
2. **The dismiss-then-recover path** — B3 takeover fires → user dismisses → score drops below critical within 30s → family alert NOT fired (verify the watcher correctly de-escalated)
3. **The cap-blocked path** — B4 fires takeover for "Wells Fargo" claim → scammer repeats it → second fire suppressed by per-claim-type cap → low-conf finding still feeds risk score
4. **The disabled-extension path** — A2 extension turned OFF in iOS Settings → block actions still persist server-side → "Pending" badge visible → no enforcement happens → no false errors

### Adversarial code review (Phase 5 day 1)

Reuse the v2 pattern. Spawn 4–5 parallel general-purpose subagents with disjoint scope (A1, A2, B3, B4, B5+integration) to find issues. Plus one verification agent that reviews their findings.

**Expected outcome based on v2's experience:** 4 CRITICAL + 6 HIGH issues. Budget Phase 5 day 1 for finding them, Phase 5 day 2 for fixing.

Specific things to look for (lessons from v2):
- Race conditions in cross-feature state (B3 + B4 both trying to fire takeover at once)
- Missing consent enforcement (any new data flow that bypasses the cross-user toggle)
- Regex false-positive surface (sentinel patterns)
- Idempotency gaps (push notifications that could double-fire)
- Prompt injection risk (B4's claim extractor handling adversarial transcript content)
- Score-merge attack surface (B4 score boost + B3 trigger interaction)

### Manual test scenarios (real devices)

Phase 2 day 3 onwards, run on real devices not simulator. Required scenarios:
- Critical-priority push delivery on iOS 17, 18, 19
- Call Directory Extension cache sync with 100k+ entries
- Mom-side STT on speakerphone + AirPods + earpiece
- Family alert push → tap → app opens to right view (not crashing)
- B5 [Join the call] → Phone app deep-link opens correctly with Mom's number pre-dialed

### User testing (Phase 5)

5 real users (mix of demographic ages, including elder targets) walk through:
- Onboarding (does it feel intrusive? do they make it past Step 4?)
- Receiving an A1 warning (do they understand it?)
- Receiving a B3 takeover (do they panic? does the 5s sticky feel too long?)
- Family-plan member viewing live transcript (do they understand it?)

### Legal review (Phase 5 day 1, parallel with adversarial)

Engaged legal counsel reviews:
- Onboarding consent flow copy
- Cross-user contribution privacy claims
- Mom-side STT consent
- B5 family-transcript consent
- App Store privacy nutrition label
- State-by-state two-party-consent posture (B5 confirmed clean; verify nothing else slipped in)

### Apple App Review preflight

Phase 5 day 2: TestFlight-only build submitted to App Review with all v3 features visible.
- Critical Alerts entitlement decision (R1 from risk register)
- Privacy nutrition label updated
- Description copy reviewed for "we make medical/financial claims" risk
- Edge cases that historically trip review: anything that auto-foregrounds during a call

---

## Migration / rollout plan

How v3 ships without disrupting v2 TestFlight users.

### Feature-flag architecture

All v3 features ship behind backend flags in `app_config`:

```sql
-- Feature flags (default OFF for v2 users; flipped per cohort)
INSERT INTO app_config (key, value, description) VALUES
  ('v3.a1.enabled', 'false', 'Pre-call warnings + sources panel'),
  ('v3.a2.enabled', 'false', 'OS-level block enforcement'),
  ('v3.b3.enabled', 'false', 'Critical takeover + sentinel matcher'),
  ('v3.b4.enabled', 'false', 'Real-time fact-checking'),
  ('v3.b5.enabled', 'false', 'Family one-tap join');
```

The iOS app reads these flags at launch via `GET /v1/config` (existing v2 endpoint, just gets new keys). UI surfaces are conditionally rendered. Backend services check flags before firing pushes / running new pipelines.

### Rollout cohorts

| Cohort | Size | When | Flags enabled |
|---|---|---|---|
| Internal alpha (Jesiah + Dean + 3 design partners) | 5 | Phase 5 day 2 | All five flags ON |
| TestFlight beta wave 1 | ~20 (existing v2 testers who opt in) | Day after alpha green-light | All five flags ON |
| TestFlight beta wave 2 | ~50 (new testers) | 1 week after wave 1 green | All five flags ON |
| Public TestFlight | unlimited | After wave 2 + adversarial-review fixes shipped | All flags ON |
| App Store production | per Apple review | After App Store approval | All flags ON |

### Rollback path

If any v3 feature shows trouble in production:
- Backend flag → flipped to `false` via `app_config` UPDATE → no app release needed
- iOS gracefully degrades (UI surfaces hide, no calls to disabled endpoints)
- Existing v2 functionality unaffected

This is the same rollback architecture v2 uses for its critical features — Dean already knows the pattern.

### Database migration safety

Migration `046_v3_live_shield_v3.sql` is **additive only**:
- Only `CREATE TABLE` and `ALTER TABLE ADD COLUMN` (with defaults) — no DROP, no NOT NULL on existing data
- Compatible with current v2 deploys running against the same DB during the window when migration has run but new code hasn't shipped
- Reversal is a separate `046_rollback.sql` if absolutely needed (drops only the tables created in 046; existing v2 tables left alone)

### iOS app version

v3 ships as a single new app version: `2.0.0` (semantically: major bump). v2 users are auto-upgraded via TestFlight; production users via App Store.

There is NO "v2 vs v3" coexistence on the same install — once a user's app is upgraded, all five v3 features become controlled by their respective backend flags. We never need to support a mixed-version client base beyond the natural rollout window.

### Communication to v2 testers

When wave 1 begins, send TestFlight email + in-app banner:
> *"AegisDial v3 is live for you. Five new ways we protect you and the family member you're protecting. Tap [What's new] in the app to see what's changed."*

A "What's new" screen on first-launch-after-update walks through the five features with screenshots — not as onboarding (that's already done) but as a touchpoint.

### Production launch criteria

v3 ships to production App Store only when:
- [ ] All 5 features green in adversarial review
- [ ] All 5 features tested on real devices iOS 17+18+19
- [ ] Legal review pass complete
- [ ] Apple App Review approved with Critical Alerts entitlement
- [ ] Wave 2 telemetry shows: cost per session <$0.50, B4 false-positive rate <10%, A2 extension adoption ≥40%
- [ ] Rollback plan tested (flip a flag in staging, verify graceful degradation)
- [ ] Demo Day master script rehearsed and timed under 4 minutes
