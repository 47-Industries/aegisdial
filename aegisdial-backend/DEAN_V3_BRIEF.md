# Live Shield v3 — Cover Brief for Dean
**Authored 2026-05-10. This is a 10-minute orientation, not the spec. The full spec is in `LIVE_SHIELD_V3.md` (2,376 lines).**

---

## TL;DR

Five features, ~27 engineering days, ~5.5 weeks for one engineer:

| # | Feature | Build | One-line |
|---|---|---|---|
| A1 | Push pre-warning + sources panel | ~9d | live web crawl receipts at the moment of ring |
| A2 | User-blocked numbers OS-enforced | ~4.5d | she blocks once, never rings again |
| B3 | Visual takeover at moment of compromise | ~5d | sticky red interrupt + family-alert backstop |
| B4 | Real-time fact-checking the caller | ~6d | catches the lie verbatim with sources |
| B5 | Family one-tap join via direct dial | ~2d | kid is one tap away with full transcript context |

The thesis: *"v2 saved you during the call. v3 means the call doesn't even happen — and when it does, you're not alone."*

---

## The Good News (don't rebuild this)

| Already exists | Where | Reused by |
|---|---|---|
| `liveCrawlUnknown(e164)` orchestrator + 6 crawlers | `src/services/liveCrawl.ts`, `src/crawlers/*` | A1 (primary), B4 (verifier fallback) |
| `mentions` table with `NormalizedMention` schema | v2 schema | A1, A2 (cross-user signal), B4 (provenance) |
| Live Shield risk-scoring Claude pipeline | `src/services/liveShield.ts` | B3 (critical trigger), B4 (parallel pass) |
| `phoneLookup` (Ekata + IPQS) | v2 services | A1, B4 |
| Family-alert dispatch + privacy levels | v2 family-alert infra | B3 escalation, B5 trigger |
| Family transcript streaming view | iOS, shipped in PR #2 | B5 (no new iOS UI for transcript) |
| Serper search integration | A1's crawler | B4 (Layer 2 verification) |
| APNs critical-priority push delivery | v2 | B3, B4 takeovers |

v3 is mostly **integration work + new iOS surfaces**, not from-scratch infrastructure. Reuse aggressively.

---

## How to read `LIVE_SHIELD_V3.md` (recommended order)

The doc is long because it's complete, not because it's hard. Read in this order:

| Pass | Lines | Time | What you get |
|---|---|---|---|
| 1 | 1277–1311 (final summary) | 5 min | The 30-second pitch on what v3 is |
| 2 | 1313–1437 (integration map) | 10 min | What's shared, what's not, what blocks what |
| 3 | 1675–1812 (build order) | 15 min | Phase-by-phase day plan; this is your sprint outline |
| 4 | 391–1276 (locked specs per feature) | 45 min | Full feature specs with rationale |
| 5 | 1438–1674 (schema + API) | 15 min | The migration + endpoint reference |
| 6 | 1813–2043 (risks + privacy) | 15 min | Things that bite if you don't see them coming |
| 7 | 2044–2376 (telemetry + demo + test + migration) | 20 min | Polish and ship plan |

Total: ~2 hours to fully internalize. Pass 1+2+3 alone (~30 min) gets you started.

---

## Where I want your eyes specifically

These are where I expect (and want) push-back. Be direct — same as v2's review:

1. **R1 in the risk register — Apple Critical Alerts entitlement.** I claim B3 + B4 takeovers auto-foreground the app via interruption-level `.critical`. If Apple doesn't grant the entitlement, the entire takeover UX collapses to a sticky-banner-on-launch fallback. Tell me whether you think that's a real risk or paranoia. (See `LIVE_SHIELD_V3.md:1820`.)

2. **The `CriticalInterruptView` polymorphism call.** I claim B3 should ship the view as polymorphic from day 1 because B4 reuses it. But polymorphism upfront has a cost. If you'd rather B3 ship feature-specific and B4 refactors later, push back — I scoped it ~2d either way.

3. **The B4 dedicated-Claude-pass design (vs. tools on the Live Shield Claude).** I picked the dedicated pass because it doubles cost but cleans up architecture. If you think the cost-doubling matters more than the separation-of-concerns at v3 scale, push back. (See `LIVE_SHIELD_V3.md:847`.)

4. **The Mom-side STT cost question (R3).** I budgeted ~5% revenue for doubled Whisper minutes. If you've seen unit-economic numbers from v2 that suggest this is actually 10–15%, that's a real problem and B3's sentinel matcher might need to be deferred to v3.5.

5. **Anything in the schema migration 050 that strikes you as wrong.** I sketched 9 new tables + ALTERs. Foreign keys, defaults, indices — all of it is fair game for review. I'd rather rewrite the migration once than ship something that has to be hot-fixed.

---

## Where I'm uncertain (your call wins)

- **Build order with one engineer vs. two.** If you can grab a contractor for Phase 1, A1 and A2 parallelize cleanly and we ship sooner. If you're solo, the 27-day critical path holds.
- **Whether to ship `b3.mom_side_stt_enabled` as a runtime flag or hardcoded ON.** Risk register says flag; cleaner code says hardcoded. Your call based on deploy hygiene preference.
- **Curated B4 directory format (JSON vs Postgres).** I propose JSON-in-repo for the seed + Postgres overrides for hot-pushable. If you'd rather have it all in Postgres for easier ops, swap it.
- **Whether B5's Phase 4 day count (2) is realistic.** It's the smallest feature in the set. I might be underestimating because I'm too excited about how clean the direct-dial approach is.

---

## Where to start (Phase 0 = foundation week, blocks everything)

```
Day 1: Migration 050 + backend config keys + hot-reload helper
Day 2: Polymorphic CriticalInterruptView.swift (iOS)
       Polymorphic SourcesPanelView.swift (iOS)
Day 3: New transcript system_event types + emit helper
       Mom-side STT routing
```

After Phase 0, A1 and A2 are independent and parallelizable. B3 follows. B4 needs B3 in. B5 follows B3.

---

## Working principles (from the v2 adversarial-review session)

These are the lessons we banked from v2's PR #2 review where the adversarial agent caught 4 CRITICAL + 6 HIGH issues. Apply them upfront on v3:

1. **Atomic UPDATE-with-WHERE-guard for any concurrent claim.** Race conditions in B3 + B4 are the most likely re-finding.
2. **Idempotency on every push notification path.** R8 in the risk register flags double-fire on family-alert; bake idempotency keys in from day 1.
3. **Consent enforcement at every new data flow.** The cross-user contribution toggle is the single source of truth — every block-signal write checks it.
4. **No fail-open on privacy.** If a privacy check fails, deny by default. Never silently fall through.
5. **Adversarial review BEFORE the spec leaves your hands.** Phase 5 day 1 is non-negotiable.

---

## When you're ready

Push back on whatever feels wrong before you start coding. Once we're aligned, the 5-phase build order in `LIVE_SHIELD_V3.md:1675` is your sprint outline.

Demo Day timing: ~5.5 weeks from kickoff. Don't break that without a conversation first.

— Jesiah
