# Live Shield v4 — Operator Runbook

**Audience:** anyone flipping the V4 feature flags in prod or staging.
**Prereq:** Phases 0–18 deployed; PR #10 (`feat/live-shield-v4-phase0`) merged.

V4 ships dormant. Every code path is gated, every emit is short-
circuited, every behavior change is guarded by an `_ENABLED` flag
that defaults `false` in prod. This runbook is the cutover plan
that turns it on safely.

---

## 1. Mental model

V4 augments V3, never replaces it. V3's risk score keeps running; V4
publishes a parallel `(playbook_id, stage, stage_confidence)` tuple
alongside. Every V4 surface is gated by:

1. **Master flag** `V4_PLAYBOOK_AWARE_ENABLED` — keeps the whole
   subsystem dormant. Default `false`.
2. **Feature flags** per behavior change, e.g.
   `V4_PLAYBOOK_SCORE_BOOST_ENABLED`, `V4_PLAYBOOK_B3_GATE_BYPASS_ENABLED`.
   Default `false`.
3. **Telemetry flags** that default `true`, e.g.
   `V4_PLAYBOOK_STAGE_TIMING_TELEMETRY_ENABLED`,
   `V4_B4_CLAIM_COVERAGE_TELEMETRY_ENABLED`. They only emit when
   the master flag is on, so the default-true is safe; the operator
   doesn't have to flip two switches to start collecting calibration
   data.

**Order of operations:** master ON → wait for calibration window
→ check scorecard → flip individual behavior flags one at a time.

---

## 2. Calibration triangle

Before flipping ANY behavior flag, check these four operator surfaces
under bearer auth. They are the read-only signal that v4 is sane:

| Endpoint | Phase | Answers |
|---|---|---|
| `GET /admin/v4/calibration-scorecard?hours=24` | 14 | Single yes/no verdict + per-axis flagged lists |
| `GET /admin/v4/stage-timing?hours=24` | 11 | Per-(playbook, stage) timing-window verdict distribution |
| `GET /admin/v4/claim-coverage?hours=24` | 12 | Per-playbook B4 claim expectation gap/surprise diff |
| `GET /admin/v4/stage-confidence?hours=24` | 13 | Per-(playbook, stage) classifier confidence distribution |
| `GET /admin/v4/sentinel-coverage?hours=24` | 17 | Per-playbook B3 sentinel-fire coverage |
| `GET /admin/v4/sessions/:id/classifications` | 15 | Drill into one session's full classification timeline |

The scorecard verdict is the gate. **`ship_ready`** means the other
four are clean and have enough data. **`needs_calibration`** means
something is flagged — look at `body.timing.flagged`,
`body.claim_coverage.flagged`, `body.confidence.flagged` for triage.
**`insufficient_data`** means not enough traffic — wait longer or
override with `?min_events=N`.

---

## 3. Hourly alerting (Phase 16)

A cron task at minute 27 runs `runCalibrationCheckSingleFlight` and
fires Sentry alerts on regression:

| Severity | Trigger |
|---|---|
| **CRITICAL** | `ship_ready` / `insufficient_data` → `needs_calibration` |
| **CRITICAL** | `ship_ready` → `insufficient_data` (lost data) |
| **WARNING** | `needs_calibration` → `needs_calibration` with NEW flagged pair |
| **INFO** | anything → `ship_ready` (recovery) |
| **none** | master flag off, first run, OFF→ON transition (baseline reset) |

Manual trigger: `POST /admin/v4/calibration-check`. Bypasses the
single-flight lock; doesn't write a snapshot.

Snapshot lives in Redis at key `v4_scorecard_snapshot:v1`, TTL 7
days.

---

## 4. Cutover sequence

### Stage A — turn telemetry ON (passive, low-risk)

V4 telemetry has been emitting in dev/staging since merge. To start
collecting calibration data in prod:

```bash
fly secrets set V4_PLAYBOOK_AWARE_ENABLED=true -a <app-name>
```

This is the ONLY env var that needs to change at this stage. The
default-true telemetry flags will now emit alongside the v3 surface.
No behavior change — every behavior flag is still off.

**Wait window:** 24–72 hours, depending on traffic volume. The
scorecard needs `min_events=50` per axis for a non-insufficient
verdict. With current call volumes, that's roughly 12 hours of
realistic traffic.

### Stage B — verify calibration

Run hourly:

```bash
curl -H "Authorization: Bearer $API_SHARED_SECRET" \
  https://<app>/admin/v4/calibration-scorecard | jq .overall
```

Expected progression:

1. **Hour 0 to ~12**: `verdict: "insufficient_data"` — normal.
2. **Hour 12+**: `verdict: "needs_calibration"` OR `"ship_ready"`.

If `needs_calibration` persists past hour 24, drill into the
flagged axes via Phase 11/12/13/15 endpoints. Common findings:

- **Timing drift**: `typical_duration_seconds` bounds in
  `src/data/playbooks.ts` need recalibration against real traffic.
- **Claim surprise**: a playbook's `PLAYBOOK_CLAIM_EXPECTATIONS`
  list is missing a claim type the LLM keeps finding — add it.
- **Confidence low**: classifier prompt is weak for that pair —
  iterate on `stageClassifier.ts` system prompt with a few real
  examples.

### Stage C — enable behavior flags one at a time

Once scorecard is `ship_ready` (or close, with operator judgment):

```bash
# Order matters — least-invasive first.
fly secrets set V4_PLAYBOOK_STAGE_BACKFILL_ENABLED=true -a <app>     # writes v4_* columns
fly secrets set V4_PLAYBOOK_SCORE_BOOST_ENABLED=true -a <app>        # nudges risk score
fly secrets set V4_PLAYBOOK_DEMOGRAPHIC_PRIORS_ENABLED=true -a <app> # bias by age band
fly secrets set V4_B4_PLAYBOOK_GROUNDING_ENABLED=true -a <app>       # B4 prompt grounding
fly secrets set V4_PLAYBOOK_B3_GATE_BYPASS_ENABLED=true -a <app>     # B3 takeover bypass
fly secrets set V4_PLAYBOOK_RECOVERY_PRELOAD_ENABLED=true -a <app>   # recovery UX
fly secrets set V4_PLAYBOOK_RECOVERY_SCAM_TYPE_ENABLED=true -a <app> # recovery scam_type
fly secrets set V4_PLAYBOOK_COACHING_ENABLED=true -a <app>           # in-call coach
fly secrets set V4_PLAYBOOK_STAGE_TAKEOVER_ENABLED=true -a <app>     # stage-driven push
```

Wait 1–2 hours between flips. After each, re-check the scorecard
and watch Sentry for regressions.

---

## 5. Rollback

Every flag is independently rollback-safe. To kill v4 entirely:

```bash
fly secrets set V4_PLAYBOOK_AWARE_ENABLED=false -a <app>
```

The master flag short-circuits every subscriber, every emit gate,
every classifier call. The next chunk through the pipeline sees
the new state. Pinned by `test/v4FlagFlipE2E.test.ts` — Phase 18.

To kill one behavior flag without touching the master:

```bash
fly secrets set V4_PLAYBOOK_<BEHAVIOR>_ENABLED=false -a <app>
```

---

## 6. Operational guarantees

| Property | Pinned by |
|---|---|
| Master flag OFF → zero per-chunk v4 emissions | `test/v4FlagFlipE2E.test.ts` |
| Master flag flip works without restart | `test/v4FlagFlipE2E.test.ts` |
| Telemetry flag defaults TRUE are safe (master gates them) | `src/config.ts` CONVENTION NOTE comments |
| Off-taxonomy data surfaces, never silently drops | `test/v4{StageTiming,PlaybookClaimCoverage,StageConfidenceCoverage,SentinelCoverage}.test.ts` |
| Calibration alerter doesn't false-positive on master OFF→ON | `test/v4CalibrationAlerter.test.ts` (M-1 case) |
| Multi-instance deploys don't duplicate Sentry alerts | `runCalibrationCheckSingleFlight` |
| Session-history endpoint redacts PII in reasoning | `test/v4SessionHistory.test.ts` (H-1 case) |
| Phase 13 dashboard tracks Phase 0 emit vocabulary | `src/lib/confidenceBuckets.ts` + `test/v4ConfidenceBuckets.test.ts` |

---

## 7. Known calibration sources of truth

Edit these and the dashboards re-grade historical data immediately
(use `expectations_hash` in the claim-coverage response to detect
goalpost shifts):

| Source | What it gates |
|---|---|
| `src/data/playbooks.ts: PLAYBOOKS[].stages[].typical_duration_seconds` | Stage-timing verdict windows |
| `src/data/playbooks.ts: PLAYBOOK_CLAIM_EXPECTATIONS` | Claim-coverage expected types per playbook |
| `src/lib/confidenceBuckets.ts: CONFIDENCE_BUCKET_BOUNDARIES` | Stage-confidence bucket edges |
| `src/config.ts: V4_PLAYBOOK_MIN_CONFIDENCE` | Classifier commit gate |
| `src/config.ts: V4_PLAYBOOK_B3_GATE_BYPASS_MIN_CONFIDENCE` | Sentinel bypass confidence floor |

Every dashboard echoes the relevant version marker in its response
so the operator can detect when a deploy moved the goalposts.

---

## 8. Phase ledger (for changelog grep)

| Phase | Commit prefix | Surface |
|---|---|---|
| 0–9 | (pre-Phase-10) | Core v4 services: classifier, score boost, B4 grounding, recovery preload, scam-type resolver, stage takeover, etc. |
| 10 | `b8ca946` | Stage-timing telemetry emit + helper |
| 11 | `feb41d4` | Stage-timing dashboard `/admin/v4/stage-timing` |
| 12 | `a191591` | Claim-coverage telemetry + dashboard `/admin/v4/claim-coverage` |
| 13 | `0a6d94f` | Stage-confidence dashboard `/admin/v4/stage-confidence` + bucketConfidence consolidation |
| 14 | `fd2286f` | Calibration scorecard `/admin/v4/calibration-scorecard` |
| 15 | `ada368b` | Session history `/admin/v4/sessions/:id/classifications` with PII redaction |
| 16 | `96009c8` | Hourly calibration alerter (Sentry on regression) |
| 17 | `fc94b03` | Sentinel × playbook coverage `/admin/v4/sentinel-coverage` |
| 18 | `d1b6a41` | End-to-end flag-flip invariant test |
| 19 | this commit | Operator runbook |

All on branch `feat/live-shield-v4-phase0` (PR #10).
