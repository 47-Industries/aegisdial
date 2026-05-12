# Live Shield v4 — Playbook-Aware Live Shield

**Captured 2026-05-10 (late evening, just before sleep). Brainstorm doc, not a spec. The v4 thesis named so we can pick it up after Demo Day / after Dean reviews v3.**

---

## The insight (verbatim)

> *"We should be using the entire scam playbooks that's in our system in the live shield."*

Live Shield v3 evaluates each call as if it's a brand-new puzzle. But 95% of phone scams follow one of ~12 well-known scripts. We've accumulated huge volumes of playbook intelligence across AegisDial — and it's fragmented across services that don't talk to each other.

v4 makes the playbook itself a first-class object inside Live Shield.

---

## What we already have (fragmented)

| Asset | Location | What it knows |
|---|---|---|
| Real scam reports | `mentions` table | Thousands of victim accounts of exact scripts, phrases, asks |
| Phrase library | `src/lib/scamPhrases.ts` | Regex patterns derived from real scripts |
| Scam classifier | `src/services/liveShieldLlm.ts` | LLM-derived `scam_category` per session |
| Triggered categories | `call_sessions.triggered_categories` | Which patterns hit per call |
| B4 curated directory | `src/data/curatedB4Directory.json` | Bank/agency rules + 6 known-scam-script phrases |
| Recovery Concierge catalog | recovery flow | Per-scam-type recovery steps (which implies we know what was asked for) |

**The gap:** there is no orchestration layer that ties these together with explicit playbook *lifecycle* modeling. Risk scoring is a single number; we lose the structure.

---

## v4 thesis

> *"We don't just detect scams. We know which exact script you're hearing and what they'll say next."*

Make the playbook a first-class object. Every Live Shield session gets an additional `(playbook_id, stage, stage_confidence)` tuple maintained alongside the risk score. The score tells you *how dangerous*; the playbook tuple tells you *what's happening and what comes next*.

---

## The 12 playbooks to formalize (initial seed)

| # | Playbook | Annual US loss (FBI/FTC) | Why it matters for v4 |
|---|---|---|---|
| 1 | Bank fraud-department impersonation | high | Most-volume; B4 already partially formalized |
| 2 | IRS / SSA / Medicare impersonation | $500M+ | Highly scripted; counter-scripts exist |
| 3 | Tech-support scam | $800M+ | Targets older Windows users specifically |
| 4 | Grandparent scam | $250M+ | Voice-deepfake adjacent; long-cycle risk |
| 5 | Romance scam | $1.3B | Long-cycle; v3 is blind to this |
| 6 | Gift-card payment scam | varies | Universal exit pattern across many playbooks |
| 7 | Crypto investment scam | $3.9B | Surging fast; targets working adults |
| 8 | Sweepstakes / lottery scam | $300M+ | Classic; targets elders |
| 9 | Job-offer / fake-employer scam | growing | Targets younger users + immigrants |
| 10 | Charity / disaster-relief scam | spikes seasonally | Predictable timing windows |
| 11 | Utility shut-off scam | regional | Highly time-pressured scripts |
| 12 | Police / legal-warrant scam | $130M+ | Often culturally-targeted (immigrant communities) |

Each playbook gets a JSON schema:

```json
{
  "id": "irs_impersonation",
  "stages": [
    { "id": "rapport", "expected_phrases": [...], "typical_duration_seconds": [30, 90] },
    { "id": "authority", "expected_phrases": [...], "typical_duration_seconds": [60, 180] },
    { "id": "fear", "expected_phrases": [...], "typical_duration_seconds": [30, 120] },
    { "id": "ask", "expected_phrases": [...], "typical_payment_methods": [...] },
    { "id": "close", "expected_phrases": [...] }
  ],
  "counter_scripts": [
    "Tell them you'll call the IRS back at the number on irs.gov.",
    "Tell them you don't pay debts over the phone, period."
  ],
  "recovery_steps_link": "recovery_catalog.irs_impersonation",
  "demographic_priors": { "elderly": 0.6, "working_adult": 0.3, "young": 0.1 }
}
```

---

## What playbook awareness unlocks (concrete features)

1. **Stage-aware UI.** Stage 1 = small warning chip. Stage 4 (the ask) = full red takeover. Stage progression is a much stronger signal than raw phrase count.

2. **Predictive warnings.** "This matches the IRS-impersonation playbook. They'll ask for gift cards in the next 90 seconds. When you hear 'Apple Card' or 'Google Play card,' hang up."

3. **Per-playbook coaching lines.** Specific to scam type, not generic. "Ask them to tell you the family pet's name" for grandparent scams. "I'll call the bank back from the number on my card" for bank impersonation.

4. **Playbook-aware family alerts.** "Mom is on a Wells Fargo fraud-impersonation scam. These take ~18 minutes to ask for money. You still have time to call her."

5. **Recovery-preempt.** Recovery Concierge preloads with the exact steps for THIS playbook before the call even ends. "We saw IRS impersonation. Here are your 4 specific steps."

6. **Counter-script library.** Surface phrases proven to make scammers hang up, in real time, for the detected playbook.

7. **Order-of-events confidence.** 6 phrase hits in predicted playbook order = much higher confidence than 6 random phrase hits. Sequence is itself signal.

---

## What v4 does NOT solve

- Voice deepfake detection (separate v4.5/v5 concern)
- Money-movement integration (separate banking-partnership track)
- Cross-channel correlation (calls + texts + emails — separate platform play)
- Romance-scam detection at *single-call* granularity (still requires long-cycle tracking; v4 helps but doesn't fully solve)

These remain real gaps. v4 is the playbook layer specifically.

---

## Build estimate

~10–14 days of engineering. Larger than any single v3 phase. Components:

| Component | Days | Notes |
|---|---|---|
| Playbook schema + 12 initial seeds (JSON + DB) | 2 | Curation effort using existing mentions corpus |
| Stage classifier (LLM prompt redesign) | 2 | Adds stage classification to v2's existing scoring pass |
| Per-session playbook state machine | 2 | New service tracking (playbook, stage) tuples |
| Counter-script + coaching content per playbook | 2 | Mostly product/copy work |
| Family-alert + Recovery Concierge integration | 2 | Wire playbook context into existing v2 flows |
| Playbook-aware UI surfaces (iOS) | 2 | Stage-aware UI states |
| Tests + adversarial review | 2 | Same pattern as v3 phases |

**Sequencing:** ships AFTER v3 stabilizes in production with real users for 2–4 weeks. v3 generates the data we need to validate the 12 playbooks against actual user calls before we lock the schema.

---

## Why this might be the strongest v4 thesis

Compared to the other v4 candidates I listed earlier (long-cycle tracking, voice-deepfake detection, money-movement integration, cross-channel correlation):

- **It's built on existing assets** — mentions corpus, scam_category, Recovery catalog. Less greenfield.
- **It compounds v3.** Every v3 feature (A1/A2/B3/B4/B5) gets sharper with playbook awareness. Multiplier effect.
- **It's defensible.** Competitors can copy features but can't copy our accumulated mentions corpus.
- **It's pitchable.** "We don't just detect scams — we know which exact script you're hearing and what they'll say next" is a stronger sentence than any v4 alternative.
- **It's a moat-deepener.** Each call adds to the corpus; the playbook detection gets better with use; the network effect compounds.

Long-cycle tracking and deepfake detection are also real and valuable but they're net-new ML systems. Playbook-awareness is *making the system we already have think more like a domain expert*.

---

## Open questions for next session

1. Do we curate the 12 playbooks ourselves, OR partially crowdsource from existing victim reports in `mentions`? (Probably hybrid — seed manually, refine via mentions corpus.)
2. Does v4 ship as a *replacement* for v2's scoring pipeline, or as an *augmentation* (both run in parallel)? Augmentation is safer for rollout; replacement is cleaner long-term.
3. Stage-classification latency budget — Haiku 4.5 is fast enough for v3's per-chunk extraction; can it also handle stage classification, or do we need a dedicated smaller model?
4. Do we expose the playbook detection to family members in the transcript view, or keep it backend-only? (User-facing exposure makes the demo dramatic; backend-only is the safer first cut.)
5. Cross-language playbook variants — IRS scam targeting Spanish-speaking communities uses a different script than the English-language version. Do we support multilingual playbooks at v4, or defer to v4.5?

---

## Where to pick up next session

When ready (after v3 stabilizes / after Dean reviews):

1. Curate the 12 playbook JSON schemas — start with IRS impersonation as the canonical example since the FCC corpus has the most data on it.
2. Spec the stage classifier prompt + state machine.
3. Same phased PR pattern v3 used — Phase 0 (foundation: schemas, state machine), Phase 1 (3 highest-volume playbooks shipped), Phase 2 (next 4), Phase 3 (final 5 + counter-scripts), Phase 4 (hardening).

This is a 6–8 week build sequenced against v3 going live. Likely lands ~end of summer 2026 if v3 ships cleanly in May/June.

---

**The one-line v4 pitch when we come back to this:**
*"v3 catches scammers in real time. v4 reads the script over their shoulder."*
