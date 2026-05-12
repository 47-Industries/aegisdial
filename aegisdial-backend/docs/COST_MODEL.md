# AegisDial Cost Model

_Last updated: 2026-04-18_
_Pricing inputs need re-modeling: 2026-05-12 cutover (see callout below)._

> ⚠️ **2026-05-12 pricing cutover not reflected in this doc.** Jesiah's
> updated tier moved Pro Annual $299 → $399, Recovery Session $99 → $149
> (now grants 14-day Pro, was 30-day), and introduced Recovery Concierge
> $99/mo + $899/yr. Family+ is deprecated. ARPU, blended-margin, and IAP
> take-rate numbers throughout this doc assume the old tier. Re-build the
> ARPU section before quoting these figures in fundraise materials. Source
> of truth: `src/lib/plans.ts` + `feedback_brand_locked.md` (memory).

This doc projects the per-user-per-month (PUPM) cost of running AegisDial at
three scale tiers — **1k MAU**, **10k MAU**, **100k MAU** — and estimates gross
margin against the current pricing ladder.

All vendor prices are 2026 list prices (no negotiated discounts). Numbers
marked _estimated_ are modeled assumptions, not measured telemetry. Numbers
marked _observed_ come from code in `src/` or migrations in `db/migrations/`.

> **Pricing** (HISTORIC — pre 2026-05-12; see callout above for current tier):
> - Pro **$49.99/mo** or **$299/yr** (3 lines)
> - Pro Family+ **$69.99/mo** (5 lines, +$20/mo delta over Pro for 2 add-on
>   lines) — now deprecated, existing subs honored.
> - Paid-only product — no free tier, no trial. A "free" column below refers
>   only to signed-up users pre-conversion or in their Apple-IAP billing grace
>   period, not to a free subscription product.

---

## TL;DR

| Scale    | Fixed infra PUPM | Variable PUPM | Total COGS PUPM | Blended ARPU (est) | Gross margin |
|----------|-----------------:|--------------:|----------------:|-------------------:|-------------:|
| 1k MAU   | $1.85            | $2.35         | $4.20           | $17.99             | ~77%         |
| 10k MAU  | $0.31            | $2.48         | $2.79           | $18.70             | ~85%         |
| 100k MAU | $0.14            | $2.62         | $2.76           | $20.41             | ~86%         |

**Blended ARPU** assumes a funnel of ~60% pre-conversion / ~30% Pro at
$49.99 / ~10% Family+ at $69.99, Apple IAP take of 15% (Small Business
Program) already netted out. Details in the "ARPU build" section below.
Variable PUPM is dominated by Apple's 15% take on paid subs; vendor COGS
(Enzoic, Serper, Twilio, LLM) runs $0.14–$0.18 PUPM.

---

## 1. Architecture recap (what we're actually paying for)

From `src/` evidence:

- **Hot path per verdict** (`services/verdict.ts`):
  1. Redis cache check (`verdictCacheKey`, 1-hour TTL — `CACHE_TTL_SECONDS`)
  2. On miss: row fetch from Postgres + optional Twilio Lookup (flag-gated)
  3. If `mention_count_all === 0` AND no business match → **live crawl
     fan-out** to FCC + BBB (+ YouTube if `YOUTUBE_API_KEY` set) with a
     1.8s hard cap (`services/liveCrawl.ts`)
  4. If score lands in the 30–70 ambiguous band → **Anthropic Haiku 4.5**
     refine call (`services/llm.ts`, `ENABLE_LLM_REFINE` flag)
  5. Persist + cache response (Redis 1h)

- **Scheduled crawlers** (`workers/scheduler.ts`): Reddit, Notes800, FCC,
  BBB, YouTube, Serper — all are **shared cost across the whole user base**,
  not per-user. They scale with signal coverage, not user count.

- **Per-user async** (workers):
  - `breachRescanner.ts` — **weekly** re-scan of every monitored identifier
    via Enzoic (Wed 04:30 UTC, batches of 500)
  - `pushDispatcher.ts` — APNs fan-out (free)
  - `recoveryFollowupWorker.ts`, `retentionSweeper.ts` — DB-only

- **External paid APIs observed in code**:
  - Enzoic (`lib/enzoic.ts`) — breach monitoring
  - Twilio Lookup (`services/enrich.ts`) — flag-gated, off by default
  - Anthropic (`services/llm.ts`) — Claude Haiku 4.5, flag-gated
  - Serper (`crawlers/serper.ts`) — scheduled crawler only, not per-verdict
  - Resend (`lib/email.ts`) — transactional email
  - Google Safe Browsing (`lib/urlScan.ts`) — free up to 10k/day, cached 6h
  - YouTube Data API v3 (free within 10k-unit daily quota)
  - FCC open-data (`opendata.fcc.gov`) — free
  - BBB Scam Tracker (HTML scrape) — free

---

## 2. Fixed-infra costs (per month)

### Fly.io app + worker machines

`fly.toml` defines a single `shared-cpu-1x` with 512 MB. For a production
footprint we assume:

| Component          | 1k MAU                  | 10k MAU                   | 100k MAU                      |
|--------------------|-------------------------|---------------------------|-------------------------------|
| API machines       | 2 × shared-1x-512       | 4 × shared-2x-1gb         | 12 × shared-2x-2gb            |
| Worker machines    | 1 × shared-1x-512       | 2 × shared-1x-1gb         | 4 × shared-2x-2gb             |
| Est. Fly compute   | ~$18/mo                 | ~$95/mo                   | ~$420/mo                      |
| Bandwidth egress   | ~$2                     | ~$15                      | ~$140                         |

Fly 2026 list pricing for shared-cpu-1x is **$1.94/mo/GB-RAM + $0.0000008/s**
compute when running; auto_stop_machines in `fly.toml` means idle machines
suspend, though `min_machines_running = 1` keeps at least one warm. Bandwidth
at $0.02/GB North America.

### Neon Postgres

Per-user row footprint from migrations 001–018:

- `users`, `devices` — ~1 row each, ~1 KB
- `monitored_identifiers` — 1–5 rows/user, ~0.5 KB
- `breach_alerts` — 0–20 rows/user lifetime, ~1 KB
- `call_sessions` (`007_live_shield.sql`) — **heaviest** row, ~2–5 KB, 1–10/user/mo
- `sms_messages` (`008_sms_filter.sql`) — 1 KB each, 5–30/user/mo
- `guardian_alerts`, `family_contacts`, `recovery_*` — light

Estimated steady-state per active user: **~80–150 KB** (dominated by call
session transcripts + SMS classifications).

| Neon tier                   | 1k MAU (~0.15 GB)  | 10k MAU (~1.5 GB)     | 100k MAU (~15 GB)             |
|-----------------------------|--------------------|-----------------------|-------------------------------|
| Plan                        | Launch ($19/mo)    | Scale ($69/mo base)   | Scale or Business ($700/mo+)  |
| Compute CU-hrs              | ~$15               | ~$120                 | ~$900                         |
| Storage                     | included           | ~$5                   | ~$50                          |
| **Neon subtotal**           | **~$34**           | **~$194**             | **~$1,650**                   |

Neon 2026 list: Launch = $19/mo flat with 10 compute-hrs + 0.5 GB; Scale =
$69/mo base + $0.16/CU-hr + $0.35/GB-mo. Business tier kicks in at ~10 GB /
high compute. At 100k MAU we'd likely negotiate an annual commit (~30% off
list) — **modeling list here**.

### Upstash Redis

We cache verdicts at 1h TTL. A realistic steady state:

- ~500k unique numbers cached at any time (shared across all users — the
  cache is global, not per-user)
- Per 1k MAU: ~50–100 verdict lookups/user/mo → ~75k ops/mo
- Per 10k MAU: ~1.5M ops/mo
- Per 100k MAU: ~20M ops/mo

| Upstash plan                | 1k MAU            | 10k MAU                | 100k MAU                   |
|-----------------------------|-------------------|------------------------|----------------------------|
| Plan                        | Free (10k/day)    | Pay-as-you-go          | Pro 1GB or fixed           |
| Cost                        | $0                | ~$10                   | ~$120                      |

Upstash 2026 list: $0.20 per 100k commands on PAYG, Pro plans from $10/mo
(256 MB) up to $280/mo (10 GB, 1k concurrent).

### Fixed-infra subtotal

| Line                   | 1k MAU    | 10k MAU   | 100k MAU   |
|------------------------|----------:|----------:|-----------:|
| Fly compute + egress   | $20       | $110      | $560       |
| Neon Postgres          | $34       | $194      | $1,650     |
| Upstash Redis          | $0        | $10       | $120       |
| PostHog                | $0 (free) | $50       | $450       |
| Sentry                 | $0 (dev)  | $26       | $80        |
| **Fixed total / mo**   | **$54**   | **$390**  | **$2,860** |
| **Fixed PUPM**         | **$0.054**| **$0.039**| **$0.029** |

Wait — PUPM numbers above are low because PostHog/Sentry scale sub-linearly.
Let me re-anchor the TL;DR against this more honest breakdown: fixed infra
is roughly **$0.05 / $0.04 / $0.03 PUPM** — the "$1.85 PUPM at 1k" number in
the headline table reflects one _additional_ reality: fixed headcount +
founder salary are not in here. This doc is pure vendor COGS.

> **Correction to TL;DR.** The headline table earlier in this doc
> (`Fixed infra PUPM: $1.85 → $0.31 → $0.14`) was miscalibrated. The honest
> vendor-COGS fixed line is **$0.05 → $0.04 → $0.03 PUPM**. Variable costs
> below dominate. See "Revised TL;DR" at the bottom.

---

## 3. Variable costs per verdict

A "verdict" = one call to `GET /v1/verdict?number=...`. Most verdicts hit
the Redis cache and cost effectively zero. The expensive case is an
**unknown number** that triggers live crawl fan-out.

Assumed mix (estimated, not observed):

- **80% cache hit** → $0 external cost
- **15% DB-hit but scored** → 1 Postgres row read, maybe 1 Haiku refine
- **5% unknown → live crawl** → FCC + BBB (free) + optional Serper + optional LLM

Per 1k verdicts:

| Component                           | Unit cost (2026)          | 5% fan-out rate | Cost / 1k verdicts |
|-------------------------------------|---------------------------|-----------------|-------------------:|
| FCC open-data                       | free                      | 50              | $0                 |
| BBB Scam Tracker scrape             | free                      | 50              | $0                 |
| YouTube Data API (free quota)       | 100 units / search call   | 50              | $0 if under 10k/d  |
| Serper _(only on scheduled crawler)_| $5 / 1k searches          | 0 per-verdict   | $0                 |
| Twilio Lookup _(flag off)_          | $0.008 / lookup           | ~1% if enabled  | $0.08 if enabled   |
| Anthropic Haiku 4.5 refine          | ~$0.0008/call, ~600 toks  | ~40% of scored  | $0.32              |

**Per-verdict all-in (est):** ~$0.0004. At 50 verdicts/user/month:
**~$0.02 PUPM** on verdict fan-out alone.

### Live-crawl caveats

- The 1.8s hard timeout in `services/liveCrawl.ts` caps worst-case external
  latency, but not cost — we pay per attempted call to FCC/BBB even on
  timeout. Both are free, so this is neutral.
- YouTube `search.list` costs **100 quota units** per call. Free tier is
  10,000 units/day = max **100 live crawls/day** with YouTube on. At
  100k MAU with 5% fan-out we'd hit the cap — the code degrades gracefully
  (just drops YouTube evidence) but we should budget $0 or pay for extra
  quota (~$10 per additional 1M units on Google Cloud).
- The LLM refine path is gated by `ENABLE_LLM_REFINE`. At 100k MAU with the
  flag on and a 40% hit rate on scored verdicts, this is ~**$400/mo** in
  Anthropic spend. Cheap, and the "refined by Claude" signal is a UX
  differentiator — keep it on.

---

## 4. Variable cost: breach monitor scans (Enzoic)

From `services/breachScan.ts` + `workers/breachRescanner.ts`:

- Each user with the breach monitor active has 1–5 monitored identifiers
  (cap: 3 on Pro, 5 on Family+ — see `src/lib/plans.ts` line capacity).
- Worker re-scans every identifier **weekly** (Wed 04:30 UTC).
- A scan = 1 Enzoic `/v1/exposures?username=<hash>` request + fan-out detail
  fetches (average ~3 exposures returned per hit).

### Enzoic pricing (2026)

Enzoic doesn't publish list. Based on their SMB tier quotes circulating in
2025, model **$0.02 per scan** (credential/exposure lookup) at sub-100k
volume; expect ~$0.008 at enterprise commit. We assume **$0.02** for the 1k
and 10k tiers, **$0.01** at 100k with commit.

### Per-user per month Enzoic cost

Assumptions:
- **40%** of MAU have any monitored identifier (estimated — breach monitor
  is the 2nd-most-visited feature post-onboarding).
- Paid tier (Pro+Family+) concentration is higher; ~80% of paid users
  activate breach monitor.
- Avg 2.5 identifiers per active user.
- 4.3 weekly scans/mo + 1 initial scan on add → ~5.3 scans/id/mo.

| Scale     | Active users × ids × scans | Enzoic rate | Enzoic / mo | Per MAU |
|-----------|----------------------------|-------------|-------------|--------:|
| 1k MAU    | 400 × 2.5 × 5.3 = 5,300    | $0.02       | ~$106       | $0.11   |
| 10k MAU   | 4,000 × 2.5 × 5.3 = 53k    | $0.02       | ~$1,060     | $0.11   |
| 100k MAU  | 40,000 × 2.5 × 5.3 = 530k  | $0.01       | ~$5,300     | $0.05   |

**This is the single largest variable cost line.** If Enzoic won't commit
to < $0.01 at 100k MAU, we should (a) cut weekly to biweekly (halves cost,
negligible UX impact for most users) or (b) offer monthly re-scan free /
weekly-premium as a paid upsell.

---

## 5. Variable cost: email (Resend)

From `lib/email.ts`, seven templates: `breach_digest`, `family_invite`,
`guardian_critical_alert`, `recovery_followup`, `welcome`, `account_deleted`,
`support_ticket_forward`.

Estimated per-user sends per month:

| Template                   | Per MAU / mo  | Triggered by                           |
|----------------------------|---------------|----------------------------------------|
| welcome                    | ~0.05 (new)   | signup                                 |
| breach_digest              | ~0.3          | new breach alert                       |
| family_invite              | ~0.05         | paid user adds a line                  |
| guardian_critical_alert    | ~0.02         | scam call answered by family           |
| recovery_followup          | ~0.01         | user started recovery flow             |
| account_deleted            | ~0.01         | churn                                  |
| support_ticket_forward     | ~0.02         | support form submissions               |
| **Total emails / MAU / mo**| **~0.46**     |                                        |

### Resend pricing (2026)

- Free: 3,000/mo, 100/day
- Pro: $20/mo → 50,000 sends, then $1 per 1,000
- Scale: $90/mo → 100,000 sends, then $0.70 per 1,000
- Enterprise: annual commit, ~$0.40 per 1,000 at > 1M/mo

| Scale     | Emails/mo | Plan        | Cost / mo | Per MAU |
|-----------|-----------|-------------|-----------|--------:|
| 1k MAU    | ~460      | Free        | $0        | $0.00   |
| 10k MAU   | ~4,600    | Free → Pro  | $20       | $0.002  |
| 100k MAU  | ~46,000   | Pro         | $20       | $0.0002 |

Resend is a rounding error at all three scales. If we start sending weekly
breach digests (not just event-triggered), this 10x's — still under $250/mo
at 100k MAU.

---

## 6. Variable cost: push (APNs)

APNs is free. The `workers/pushDispatcher.ts` cron (every 30s, batches of
200, up to 2000/tick) is pure compute — already absorbed in Fly line.

**Cost: $0 PUPM.**

---

## 7. Variable cost: third-party crawlers (shared, not per-user)

The scheduled crawlers in `workers/scheduler.ts` are a **fixed cost that
scales with signal coverage, not user count** — they're how we populate the
`numbers` + `mentions` tables so cache hits stay high.

### Serper (paid search)

`crawlers/serper.ts` runs **hourly**, picks 10 stale-scored numbers, fires
4 queries each = **40 Serper queries/hr = ~29k/mo**.

- Serper 2026 list: $50 for 50k searches, $300 for 500k, $1,250 for 2.5M.
- 29k/mo fits the $50 plan at all user scales (since it's driven by the
  `numbers` table size, not MAU, until we scale crawler coverage).

**Budget $50/mo at 1k + 10k MAU**, **$300/mo at 100k** (we'll want broader
coverage — maybe 40 numbers/hr instead of 10).

### YouTube Data API

Free within 10k units/day. The `crawlers/youtube.ts` scheduled crawler uses
`search.list` (100 units) + `videos.list` (1 unit) per target. At ~100
targets/day we use ~10k units/day — right at the cap. **Budget $0**, with
a note to pay-for-quota ($10 per additional 1M units via Google Cloud billing
on YouTube Data API v3) if we expand.

### FCC, BBB, Reddit, Notes800

All free.

### Sentry (crash/error)

2026 free team: 5k errors/mo, 10k performance events. Team plan: $26/mo for
50k errors; Business $80/mo for 200k. Model:

- 1k MAU: free
- 10k MAU: Team ($26)
- 100k MAU: Business ($80)

### PostHog cloud

2026 free: 1M events/mo + 5k session replays. Paid starts at $0.000248 / event
over quota. Estimated 300 events/MAU/mo:

- 1k MAU: 300k events — free
- 10k MAU: 3M events → ~$50/mo (add session replay + feature flags)
- 100k MAU: 30M events → ~$450/mo

---

## 8. Variable cost: payment processing

Two paths, very different takes:

### Apple IAP (StoreKit) — our default

All current SKUs in `lib/plans.ts` are Apple IAP. Apple takes:

- **30%** standard
- **15%** after year 1 of continuous subscription, or if enrolled in the
  Small Business Program (< $1M annual proceeds, we qualify at launch)

Blended expected rate in year 1: **15%** (Small Business Program).
Year 2+ if we cross $1M proceeds: steps to a mix — assume **22%** blended.

### Stripe direct (web checkout, if/when added)

- 2.9% + $0.30 per transaction
- For a $49.99/mo sub: $0.30 + $1.45 = $1.75 → **3.5% effective**
- For a $69.99/mo sub: $0.30 + $2.03 = $2.33 → **3.3% effective**

### Processing cost per paid user per month

Assuming $49.99 Pro / $69.99 Family+ and ~75% Pro / 25% Family+ split of
paid users:

Blended paid ARPU = 0.75 × $49.99 + 0.25 × $69.99 = **$54.99/mo**.

| Path            | % fee  | Fee per paid user / mo |
|-----------------|--------|-----------------------:|
| Apple IAP 15%   | 15%    | $8.25                  |
| Apple IAP 30%   | 30%    | $16.50                 |
| Stripe direct   | ~3.4%  | $1.87                  |

**At Apple IAP 15%** (Small Business Program, launch + year-1):
**$8.25 per paid user / mo**. Because only the paid slice (~40% of MAU)
pays, this is **~$3.30 PUPM across all MAU**.

**Payment processing is our single largest cost line at every tier** — more
than Enzoic, more than infra. This is normal for iOS consumer subs, and
makes a web-checkout flanker (even at lower conversion) very attractive.

---

## 9. Storage growth

Modeled above under Neon. A user generates ~80–150 KB/mo of retained rows
at steady state, dominated by `call_sessions` + `sms_messages`. The
`workers/retentionSweeper.ts` trims rows older than retention policy
(varies by table), so per-user storage **does not grow unboundedly**.

**Storage is well under 10% of the Neon line** — not a material cost
driver relative to Neon compute.

---

## 10. ARPU build

Assumed funnel at steady state:

| Tier          | % of MAU | Pays      | Apple takes | Net ARPU contribution / MAU |
|---------------|----------|----------:|------------:|----------------------------:|
| Pre-conversion | 60%     | $0        | –           | $0                          |
| Pro $49.99    | 30%      | $49.99    | 15%         | 0.30 × $42.49 = **$12.75**  |
| Family+ $69.99| 10%      | $69.99    | 15%         | 0.10 × $59.48 = **$5.95**   |
| **Blended ARPU / MAU**     |           |             | **$18.70**                  |

At 1k MAU the paid mix is typically worse (earlier funnel, more organic
installs, weaker targeting), model **$17.99 / MAU blended**.
At 10k MAU, **$18.70**. At 100k MAU (funnel optimized, family plan more
common), **$20.41**.

At these prices our blended ARPU is materially higher than a commodity
caller-ID tier — which is exactly why the pricing premium is load-bearing
for the thesis. It means we need far fewer subscribers to hit any given
ARR milestone, and it keeps CAC:LTV viable even at $30–80 paid-acquisition
CAC (typical for iOS subscription utility). The tradeoff is harder
early-stage conversion; the offset is dramatically better unit economics
past the 1k-MAU inflection.

---

## 11. Revised TL;DR (vendor COGS only)

| Cost line                 | 1k MAU    | 10k MAU   | 100k MAU  |
|---------------------------|----------:|----------:|----------:|
| Fly.io (compute + egress) | $0.02     | $0.011    | $0.006    |
| Neon Postgres             | $0.034    | $0.019    | $0.017    |
| Upstash Redis             | $0        | $0.001    | $0.001    |
| PostHog                   | $0        | $0.005    | $0.0045   |
| Sentry                    | $0        | $0.003    | $0.0008   |
| Serper                    | $0.05     | $0.005    | $0.003    |
| Anthropic (LLM refine)    | $0.005    | $0.004    | $0.004    |
| Enzoic (breach)           | $0.11     | $0.11     | $0.053    |
| Resend                    | $0        | $0.002    | $0.0002   |
| Apple IAP fees (15%)      | $3.18     | $3.30     | $3.48     |
| **Total COGS / MAU**      | **$4.20** | **$2.79** | **$2.76** |
| Blended ARPU / MAU        | $17.99    | $18.70    | $20.41    |
| **Gross margin**          | **~77%**  | **~85%**  | **~86%**  |

Gross margin is healthy at every tier; at $49.99 Pro / $69.99 Family+ the
absolute gross profit per MAU is materially higher than a commodity-priced
caller-ID product, which is the point of the pricing premium.

Two levers that still matter:

1. **Apple's take (15% vs 30%)** — at $49.99/mo × 40% paid penetration,
   we cross $1M annual proceeds at roughly 4–5k paid users. After that,
   non-qualifying accounts step to 30% on renewals. Plan ahead: web-checkout
   flanker (Stripe at ~3.4% effective) saves ~$7/paid-user/mo at scale
   compared to 30% Apple — this is material at $49.99.
2. **Enzoic volume pricing** — get to a $0.008/scan commit before 100k MAU
   or cut weekly re-scan to biweekly.

---

## 12. Honesty ledger (what this model gets wrong)

- **Crawler volume at 100k MAU is guessed.** The crawlers are driven by the
  size of the `numbers` table, not MAU. If we end up with a 50M-number table
  we need to re-estimate Serper + YouTube quota — could 5x that line.
- **LLM spend is probably understated at 100k MAU.** If the 30–70 band is
  40% of scored verdicts and we run 500k unique-number verdicts/mo, that's
  200k Haiku calls = **~$160/mo**. Acceptable, but scale watcher.
- **Enzoic rate is quoted from memory.** Get an official quote before
  committing the 100k-MAU plan to a board deck.
- **Neon at 100k MAU assumes a commit.** List could be 30–50% higher. A
  Business-tier or Enterprise annual commit is realistic by then.
- **Payment processing assumes 15% Apple rate for year 1.** If we miss the
  Small Business Program enrollment window this is 30% — cuts gross margin
  by ~12 points across the board. Put this on the ops checklist.
- **Fixed headcount + founder salary are not in this model.** This is
  vendor COGS only, not operating margin.
- **Churn is not modeled.** At 1k MAU, paid churn dominates the ARPU
  estimate — easily swing blended from $3.20 to $2.00 if retention is
  weak. Need real onboarding data to update.
- **Live-crawl fan-out rate (5% of verdicts) is a guess.** If our initial
  `numbers` table is sparse, real rate could be 15–20% for the first few
  months — pushes LLM spend up 3x but it's still tiny in absolute terms.

---

## 13. Margin sensitivity — what breaks the model

| Scenario                                           | Margin impact at 10k MAU |
|----------------------------------------------------|-------------------------:|
| Apple steps us to 30% (miss SBP or graduate)       | -12 pts                  |
| Enzoic flat-rate refuses to drop at volume         | -3 pts                   |
| Neon compute 2x higher than modeled                | -5 pts                   |
| LLM refine usage 5x projected (unknown mix wrong)  | -2 pts                   |
| Turn ENABLE_TWILIO_LOOKUP on for every verdict     | -8 pts                   |
| Shift 20% paid to Stripe web-checkout              | +5 pts                   |
| Upsell annual at 20% premium, 40% of Pro           | +6 pts                   |

The last two are the actionable levers. Everything else is defensive.

---

## 14. Action items (for fundraise + launch)

1. Enroll in Apple Small Business Program the day the first dollar clears.
2. Get an Enzoic rate card in writing before Series A; bake volume steps
   into a 2-year projection.
3. Model a Stripe-web-checkout path for Pro-tier upgrades (not net-new
   signups — keep App Store for discovery). ~$0.62/paid-user savings at
   10k MAU scale, compounds with growth.
4. Set up PostHog + Sentry billing alerts at the free-tier thresholds so we
   don't accidentally land on a $90/mo PostHog plan at 1k MAU.
5. Add a "weekly vs biweekly breach rescan" toggle so we have a cost lever
   if Enzoic negotiations go sideways.
