# Live Shield — Brainstorm + Spec
**Status:** brainstorming. No code changes yet. Decisions land here as we make them so we don't waste tokens rebuilding the wrong thing.
**Started:** 2026-05-09

---

## What Live Shield is today (the baseline we're improving)

**One-line:** the iOS feature that protects users *during* a phone call by listening for scam phrases and warning them in real-time.

### Current flow
1. User answers a call, taps "Shield this call" in the app
2. iOS shows two-party-consent disclosure → user confirms
3. iOS starts on-device speech recognition (SFSpeechRecognizer) — audio never leaves the phone
4. As the user/caller talk, iOS streams text chunks to `POST /v1/live-shield/:id/transcript`
5. Backend matches against ~100 scam-phrase regex patterns (`src/lib/scamPhrases.ts`)
6. Backend re-scores the running session — produces `risk_score` (0–100) + `risk_level` (low/medium/high/critical)
7. iOS surfaces warnings in real time as risk escalates
8. On `critical` → backend pushes alert to the user's family/guardians
9. On family-emergency patterns → backend suggests calling family back / safe-word check
10. User hangs up → iOS calls `/end`, session locks

### What's good about today's version
- **Privacy moat:** audio stays on-device, transcripts encrypted at rest
- **Explainable:** every warning maps to a labeled phrase pattern
- **Co-occurrence scoring:** combos like "impersonation + payment + isolation" trigger high bonuses (the universal scam fingerprint)
- **Family fan-out:** guardians get notified when things escalate
- **No false-positive epidemic:** regex tuning is conservative

### What's limiting about today's version
- **Pure regex.** Misses anything the patterns don't anticipate. AI voice clones, novel scripts, foreign-language scams, paraphrased asks all slip through.
- **Reactive only.** Fires once words are said. Can't pre-warn based on caller history.
- **Passive.** Surfaces a warning. Doesn't actually intervene.
- **English only.** Older immigrant populations (heavily targeted) get zero coverage in their native language.
- **No tone/emotion analysis.** Scams have a distinctive emotional cadence we ignore entirely.
- **No deepfake detection.** AI voice clones impersonating family are the fastest-growing threat category.
- **No outbound protection.** "Recovery scam" callbacks to fake 1-800 numbers from Google searches aren't covered.
- **No real-time coaching.** Tells user something's wrong, doesn't tell them what to say.
- **No behavioral baseline.** Doesn't know who the user actually talks to.

---

## The strategic question

Live Shield is the **prevention** half of AegisDial's locked positioning ("the only fraud product that prevents AND recovers"). Recovery Concierge is the recovery half.

Whatever we build here has to:
1. **Be visibly better than LifeLock + Truecaller + Apple's built-in.** The pitch line is "we stop the call before a dime leaves your account." The product has to actually do that, demonstrably, in a 60-second demo.
2. **Generate a moat we control.** Every call processed should make the next call's detection smarter (the data flywheel from `COMPANY_OS.md`).
3. **Survive a Demo Day live demo.** If we put Jesiah on stage, plays a real scam clip, Live Shield has to flag it correctly within 5 seconds. No exceptions.

---

## The dimensions of improvement (where we can take this)

These are vectors, not options — we'll likely combine several. Numbered for reference in the brainstorm.

### A. INTELLIGENCE LAYER — what the engine actually understands
- **A1. LLM-based behavioral analysis.** Beyond regex, send the running transcript to Claude/GPT every N seconds for "is this a scam, why, confidence." Catches paraphrased scripts.
- **A2. On-device CoreML model.** Trained on our scam corpus. Lower latency, no network round-trip, no data egress.
- **A3. Voice tone / emotion detection.** Hume API or similar. Scams have distinctive urgency/threat/false-intimacy cadence.
- **A4. Deepfake / voice-clone detection.** AI-generated voice has detectable artifacts. Critical for the "grandchild emergency" category.
- **A5. Multi-language pattern coverage.** Spanish, Mandarin, Tagalog at minimum. The targeted populations.
- **A6. Behavioral baseline per user.** Learn who they actually talk to → unknown caller asking for money at 9pm gets elevated scrutiny vs. their daughter.

### B. ACTIVE INTERVENTION — what the app does, not just warns
- **B1. Real-time on-screen coaching.** Not just "Scam!" but "Say: 'I need to call my bank back, goodbye.'"
- **B2. Auto-mute the user's mic.** When critical pattern hits, prevent them from saying anything more (especially card numbers, SSN).
- **B3. Inject artificial delay/static.** Frustrate scammer scripts; give user time to think.
- **B4. Conference-bridge a guardian.** Auto-add the user's adult child to the call silently so they hear what's happening.
- **B5. AI takes over the call.** "Hi, this is Mom's assistant — what's the call regarding?" Wastes scammer time, exposes script. The Sam Altman angle.
- **B6. Trigger family safe-word verification automatically.** Push to claimed-relative's phone: "Did you just ask Mom for $500?"
- **B7. Auto-record the call (where legal).** Evidence for police, FTC, IC3.

### C. PROACTIVE LAYER — before the call even connects
- **C1. Caller-ID intelligence.** Cross-reference the number against fraud graph before answering. (We already do this via iOS 18 Live Caller ID Lookup API — could go deeper.)
- **C2. Targeting alerts.** "Your number was probed 3x this week by known scam clusters — expect a call in 48hr."
- **C3. Auto-decline known scam numbers** at the OS level (CallKit extension).
- **C4. Pre-call risk briefing.** Push notification before answering: "This number has 47 scam reports."

### D. UX / PRESENTATION — how the user experiences it
- **D1. AI-generated natural warnings.** "This sounds like the IRS scam. Real IRS never calls. Hang up." — not just "Asked about gift cards."
- **D2. Haptic alerts.** Buzz pattern when user can't see the screen.
- **D3. Family co-watching.** Adult child sees Mom's risk score live on their phone, can intervene.
- **D4. Post-call AI debrief.** Full transcript replay with annotation: "Here's where they tried to manipulate you."
- **D5. Demo Day demo mode.** A "Replay a real scam" demo for investors / App Store reviewers.

### E. COVERAGE — what calls are actually protected
- **E1. Outbound call protection.** When user dials a sus 1-800 from Google, same engine runs.
- **E2. SMS Live Shield.** Real-time analysis as iMessages arrive (we have the SMS classifier, hasn't been wired into a streaming UX).
- **E3. WhatsApp/FaceTime.** Cross-app coverage. Hard with Apple's sandbox.
- **E4. Voicemail scanning.** Run the engine on inbound voicemails.

### F. INTEGRATION — connecting Live Shield to the rest of AegisDial
- **F1. Auto-handoff to Recovery Concierge** when critical. Pre-populate scam type, peer number, transcript evidence.
- **F2. Feed every session into the fraud graph.** Every block makes the next call smarter (the moat).
- **F3. Aggregate alerts.** "47 AegisDial users got the same script today — coordinated campaign."
- **F4. Bulk crime report generator** (already exists in route layer) gets a Live Shield feeder.

---

## What I'd ship as v2 if I had to pick today (strawman for you to reject or refine)

The smallest set of changes that delivers a **visibly different product** without rebuilding the foundation:

1. **A1 + B1 + D1** — add Claude-as-second-opinion every 8 seconds, return real-time coaching text the iOS UI surfaces ("Say: 'I need to verify with my bank, goodbye'"). One feature, three improvements (LLM intelligence + intervention + UX).
2. **B6** — automated family safe-word push when grandchild-emergency pattern hits. The "deepfake defense" headline feature.
3. **A4** — basic voice-clone detection on chunks the user explicitly flags as "this voice sounds wrong." Cheaper than always-on detection.
4. **F1** — auto-handoff to Recovery Concierge on `critical`. Closes the loop with the recovery half.

Reasoning: this set gives us four demo-able features for Demo Day, each on a different axis (intelligence, intervention, deepfake, integration), with a shared LLM-pipeline backbone we can extend later. It's about 2 weeks of build for Dean, fits before YC batch.

What I'd explicitly defer to Phase 3:
- Any CallKit / OS-level integration (Apple-permission heavy)
- AI-takes-over-the-call (B5 — needs Twilio bridging, ElevenLabs voice, and a full agent loop; a quarter of work)
- Multi-language (A5 — a separate corpus + tuning effort)
- Cross-app coverage (E3 — Apple sandbox blockers)

---

## Open questions for the brainstorm

1. Demo Day moment: what's the **single most jaw-dropping live demo** Live Shield can deliver in 60 seconds?
2. Threat priority: rank these scams by who AegisDial is *for* — which ones do we lead the product pitch with?
   - IRS / authority impersonation
   - Bank "safe account" scam
   - Grandchild emergency / AI voice clone
   - Tech support / remote access
   - Romance / pig butchering
3. Active intervention: which feels right — coaching the user (B1), muting the user (B2), or AI-taking-over (B5)? They're philosophically different products.
4. Privacy stance: is anything ever allowed to leave the device that doesn't today? (A1 means sending transcripts to Claude — that's a meaningful change to the privacy story.)
5. What does Dean's bandwidth look like? This will determine v2 scope.

---

## Decisions log (filled in as we make calls)

### 2026-05-09 — Demo Day moment: Live family co-watching
The Demo Day demo is a daughter watching her mom's risk score climb in real
time on her phone, then intervening. This is the emotionally devastating
moment that can't be replicated by LifeLock or Truecaller. **Implication:**
the family-plan / multi-device sync infrastructure is on the critical path
for v2, not optional.

### 2026-05-09 — Hero scam: IRS / authority impersonation
We lead the product pitch with IRS scams. Reasons: largest victim count,
investors immediately recognize it, predictable script makes detection
reliably demoable, and it's the universally-feared scam every American
adult has personally received. **Implication:** the IRS/SSA/law-enforcement
phrase patterns and combo bonuses get the most tuning attention.

### 2026-05-09 — Intervention philosophy: alert BOTH user AND family simultaneously
Not "coach the user" alone, not "tell the family" alone — both in parallel.
The user gets real-time on-screen warning + coaching; every member on the
family plan gets a real-time alert with the live risk score. The user can
act on the coaching; the family can intervene if the user doesn't.
**Implication:** every phrase hit fires two notification channels at once.
Family-plan push fan-out is on the critical path. Threshold tuning
(do family members get pinged at `high` or only `critical`?) is a follow-up
decision.

---

## Locked v2 direction (synthesizing the three decisions above)

**Live Shield v2 = the Live Family Shield.** When the user's risk score
crosses a threshold, the app fires:

1. **To the user, on-device:** real-time on-screen warning + AI-generated
   coaching ("This is the IRS scam. Real IRS never calls. Say: 'I need to
   verify with my accountant, hanging up.'")
2. **To every family-plan member:** push notification with the live risk
   score, the scam type detected, and a one-tap action to (a) call the
   user immediately, (b) join the call as a third party, or (c) send a
   pre-written "are you ok?" text.

The whole feature is anchored to IRS impersonation as the launch use case.
Other scam categories ride the same infrastructure but the IRS pattern
gets the most marketing/messaging weight.

---

## Next-tier decisions (locked 2026-05-09)

### Family intervention: One-tap call-back to Mom
The push notification a family member receives includes a single big
button: **"Call Mom now."** Tapping it dials Mom from their iPhone using
the standard Apple call stack. Mom sees her daughter's name on the
incoming call, hangs up on the scammer, picks up. **Implication:** no
Twilio, no carrier bridging, no audio infra — pure Apple-native push +
CallKit. Cheaper to build, more reliable to demo, almost as dramatic as
a true conference bridge. Conference bridging deferred to v3.

### Family privacy: Mom controls what they see
The family member's view is configurable by Mom in the app settings.
Default level shows **risk score + matched red-flag phrases** (e.g. "Mom:
87/100 — caller said: gift cards, pay now, IRS"). Mom can dial it down
to *risk score + scam type only* (most private) or up to *live transcript*
(maximum context). **Implication:** Mom-side privacy settings UI + a
per-alert payload-shaping service that respects her preference.

### Alert threshold: Critical only (≥75)
Family alerts ONLY fire when the risk score crosses 75. Below that, the
user gets the on-screen warning but family stays silent. Reasoning: false
positives at lower thresholds would train family to ignore alerts —
critical-only preserves the alert's urgency. **Implication:** the regex
catalog and combo bonuses for IRS impersonation (the hero scam) need to
*reliably* push to ≥75 within ~3 phrase hits. Tuning effort.

---

## Locked v2 spec — synthesized

**Live Family Shield v2** — when an AegisDial Pro user is on a call and
the running risk score crosses 75:

**On the user's phone (always):**
- Full-screen warning overlay with the scam type ("This appears to be an
  IRS impersonation scam")
- AI-generated coaching line ("Real IRS never calls. Say: 'I need to
  verify with my accountant, hanging up.'")
- Haptic + audio alert (configurable)

**On every family-plan member's phone (only at ≥75):**
- Push notification: "[Mom] is on a high-risk call right now"
- Payload contents respect Mom's privacy setting:
  - default: risk score + matched red flags
  - private: risk score + scam type only
  - open: live transcript link
- One big button: **"Call Mom now"** → dials her via CallKit

**Behind the scenes:**
- Backend logs every fire to `analytics_events` (`family_alert_fired` event)
- Auto-handoff to Recovery Concierge if call ends with `outcome=user_called_guardian`
  or critical hits + payment-fraud category fired (the "money already moved" inference)
- Every session feeds the fraud graph (Phase 1 of `COMPANY_OS.md`)

---

## Still-open decisions (continued)

### 2026-05-09 — AI layer: Hybrid (regex first, Claude joins at score ≥50)
Regex runs on every chunk for free, fast, on-device-friendly. Once the
running score crosses 50, Claude joins as a second opinion: it reads the
running transcript every 8 seconds, returns a confidence score and a
scam-type classification, and ALSO generates the coaching line for this
specific call.

**Cost envelope:**
- ~30% of shielded calls expected to cross 50
- On those calls, Claude fires ~7×/min (8s cadence) × 2 outputs each
- ~$0.02/call avg, ~$0.05 worst case for a 5-min critical call
- At $49.99/mo ARPU, well within margin

**Privacy implication:** transcripts ABOVE 50 leave the device for Claude.
This is a documented change to the privacy stance. The default disclosure
("audio never leaves the phone") becomes "audio never leaves the phone;
text leaves only when the call is already detected as suspicious." We
update the consent disclosure copy + privacy policy.

### 2026-05-09 — Coaching content: AI-generated per call
Once Claude is in the loop on critical calls, it produces the coaching
line specific to this conversation ("They just asked for gift cards —
say: 'I'll buy them in person, goodbye'") rather than pre-written
templates. Tighter, more contextual, lands harder.

**Implication:** the Claude prompt has two outputs per call:
1. Confidence + scam type (used for risk score escalation + family alert decision)
2. Coaching line (rendered on the user's screen)

We can do this in one round-trip, so cost stays in the envelope above.
Coaching line cached for the duration of the chunk so it doesn't flicker
on every keystroke.

---

## v2 — final spec

Hand this to Dean for build planning.

### Scope: 4 features, one shared infrastructure

#### Feature 1 — Hybrid risk engine
- Existing regex pipeline runs on every transcript chunk (no change)
- When score crosses 50, Claude fires every 8s with the running transcript
- Returns: `{confidence: 0-100, scam_type: string, coaching_line: string}`
- Risk score is `max(regex_score, llm_score * 0.95)` — LLM can escalate, never demote
- New analytics event: `live_shield_llm_invoked`

#### Feature 2 — Family alert fan-out at score ≥75
- New event: `live_shield_critical_hit` triggers push to every family-plan member
- Push payload respects Mom's privacy setting (3 levels: minimal / default / open)
- One-tap "Call Mom now" deep links into iOS dialer with Mom's number
- Already-shipping `emitGuardianAlert` service is the foundation — extend, don't rebuild

#### Feature 3 — Real-time on-screen coaching
- iOS displays Claude's `coaching_line` in a high-contrast banner
- Updates every 8s as the call evolves
- Haptic + audio cue on first critical-hit only (don't spam)

#### Feature 4 — Auto-handoff to Recovery Concierge
- When a call ends with `risk_level=critical` AND user's `outcome` is
  `user_hung_up` or `user_called_guardian`, server pre-creates a Recovery
  Concierge session populated with the scam type, peer number, and
  highlights from the transcript
- iOS shows "We saved you from a scam — want help with the next 15 minutes
  of recovery?" as a follow-up screen

### Build estimate (rough, before Dean reviews)

| Component | Effort | Notes |
|---|---|---|
| Backend Claude integration | 3–4 days | New service `liveShieldLlm.ts`, prompt + response schema, error handling, cost guards |
| Privacy settings backend | 1 day | New table `family_alert_preferences`, route, default migration |
| Push payload shaping | 1 day | Extend `emitGuardianAlert` with privacy-level branching |
| iOS coaching banner | 2 days | New SwiftUI overlay, debouncing, haptic/audio |
| iOS family alert + CallKit handoff | 2 days | New push category, deep link |
| iOS privacy settings screen | 1 day | Three-radio control + copy |
| Auto-handoff to Recovery | 1 day | Server-side trigger, iOS follow-up screen |
| IRS pattern tuning | 1 day | Add 10–15 IRS-specific phrases, tune combo weights |
| Tests | 2 days | Hybrid scoring tests, push payload tests, e2e |
| **Total** | **~14 days** | Two solid weeks for one engineer |

### What's deferred to v3 (90-day post-Demo Day)

- Conference bridging (Twilio + ElevenLabs voice) — biggest lift, ~quarter
- Multi-language pattern coverage (Spanish, Mandarin, Tagalog)
- Voice-clone / deepfake detection
- AI takes over the call (Sam Altman angle)
- CallKit pre-call decline of known scam numbers
- Outbound call protection (recovery-scam coverage)
- Behavioral baseline (per-user trust graph)
- Real-time live transcript view for family

### 2026-05-09 — Timeline: start Dean Monday 2026-05-11, ship ASAP
Maximum urgency. Dean starts on the Live Shield v2 build Monday.
~14-day estimate puts a working v2 in the app around 2026-05-25 if Dean
is full-time on it.

### 2026-05-09 — No "demo mode" wrapper
The app already has a demo in it (existing flow). We do NOT build a
canned scam-demo button. The product itself is the demo — when Live Shield
v2 is ready, Jesiah demos it on a real call. This forces the real thing
to be reliable enough to demo, which is the right pressure on the build.
**Implication:** every feature must work end-to-end with no fallback;
no polish-the-fake while the real flow is broken.

---

### Privacy disclosure update required
The current consent flow says "audio never leaves the phone." We need to
update to: "Your call audio never leaves your phone. If a call is
detected as high-risk, the text of the conversation may be sent to our
AI partner for additional analysis to protect you. We never store this
text and never use it for training." Surface in the consent screen
before users opt into v2.
