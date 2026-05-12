import { createHash } from 'node:crypto';
import {
  PLAYBOOK_CLAIM_EXPECTATIONS,
  PLAYBOOKS,
  PLAYBOOKS_BY_ID,
  type B4ClaimType,
  type PlaybookId,
} from '../data/playbooks.js';

// Live Shield v4 — Phase 12 — B4 × playbook claim-expectation diff.
//
// Every playbook seed lists the B4 claim types we EXPECT the scammer
// to make for that playbook (PLAYBOOK_CLAIM_EXPECTATIONS). The B4
// claim extractor uses that list as a non-destructive prompt bias.
//
// Phase 12 closes the loop: emit a metric at every successful
// extraction tagged with (playbook_id, claim_type, expected) and turn
// that signal into a calibration view:
//
//   - GAP: playbook expected claim_type X but we never see X extracted
//          on any session classified into that playbook → the
//          expectation list is reaching for a claim that doesn't
//          actually come up, OR the LLM is missing the cue.
//
//   - SURPRISE: LLM extracts claim_type Y on a playbook that didn't
//               expect Y → either PLAYBOOK_CLAIM_EXPECTATIONS is
//               miscalibrated (add Y), or the classifier misjudged
//               this call's playbook.
//
// Both surface to the operator before any V4_PLAYBOOK_*_ENABLED flag
// flips to ON in prod, same gate-rationale as Phase 11.

export const B4_CLAIM_TYPES: readonly B4ClaimType[] = [
  'bank_affiliation',
  'agency_affiliation',
  'account_tail',
  'case_number',
  'employee_identity',
  'geographic_location',
] as const;

const B4_CLAIM_TYPE_SET = new Set<string>(B4_CLAIM_TYPES);

/**
 * Pure predicate: is `claim_type` in the expected list for `playbook_id`?
 *
 * Returns:
 *   - true: claim_type IS in PLAYBOOK_CLAIM_EXPECTATIONS[playbook_id]
 *   - false: claim_type is a valid B4 type but NOT in the expected list
 *   - null: playbook_id doesn't resolve (stale data after rollback)
 *           OR claim_type is not a canonical B4 type
 *
 * The null sentinel is important — the emit site treats it as
 * "don't emit a metric for this case" (the diff is undefined when
 * we can't even classify the inputs).
 */
export function isClaimTypeExpected(
  playbook_id: string | null | undefined,
  claim_type: string | null | undefined,
): boolean | null {
  if (!playbook_id || !claim_type) return null;
  if (!PLAYBOOKS_BY_ID.has(playbook_id as PlaybookId)) return null;
  if (!B4_CLAIM_TYPE_SET.has(claim_type)) return null;
  const expected = PLAYBOOK_CLAIM_EXPECTATIONS[playbook_id as PlaybookId];
  return expected.includes(claim_type as B4ClaimType);
}

// ---------------------------------------------------------------------------
// Aggregation — turn raw metric_counters rows into the calibration view
// ---------------------------------------------------------------------------

export interface ClaimCoverageMetricRow {
  playbook_id: string;
  claim_type: string;
  expected: 'true' | 'false' | string;
  count: number;
}

export interface ExpectedClaimObservation {
  claim_type: B4ClaimType;
  count: number;
}

/** Per-playbook diff between expected claim types and observed traffic. */
export interface PlaybookClaimCoverage {
  playbook_id: PlaybookId;
  /** Static — from PLAYBOOK_CLAIM_EXPECTATIONS. */
  expected_types: B4ClaimType[];
  /** Expected types that appeared at least once (with counts). */
  expected_observed: ExpectedClaimObservation[];
  /**
   * Expected types that NEVER appeared in the window — the GAP signal.
   * Empty array when every expected type has at least one observation.
   */
  expected_missing: B4ClaimType[];
  /**
   * Claim types that appeared but were NOT in the expected list for
   * this playbook — the SURPRISE signal. Either the expectation list
   * is too narrow (add this type), or the classifier is misjudging
   * this call's playbook.
   */
  unexpected_observed: ExpectedClaimObservation[];
  /** Total claim extractions tagged with this playbook in the window. */
  total: number;
  /**
   * Operator-facing rollup verdict.
   *   - 'no_data': total === 0 (no claim extractions for this playbook)
   *   - 'aligned': all expected types observed AND no unexpected types
   *   - 'gap':     at least one expected type has zero observations
   *                AND no unexpected types observed
   *   - 'surprise': at least one unexpected type observed (may also
   *                 have gaps — surprise dominates because it
   *                 implies the expectation list OR the classifier
   *                 is wrong, the more actionable signal)
   */
  calibration: 'aligned' | 'gap' | 'surprise' | 'no_data';
}

export interface ClaimCoverageSummary {
  hours: number;
  total_events: number;
  /**
   * 12-char SHA256 prefix of the current PLAYBOOK_CLAIM_EXPECTATIONS
   * map. MEDIUM-3 adversarial fix: the summarizer re-derives
   * expected/unexpected from the live map (not the emitted `expected`
   * tag), so editing the map mid-window re-grades pre-edit data.
   * Operators looking at a cliff in `unexpected_observed` after a
   * deploy that changed the map cannot distinguish "calibration is
   * improving" from "I just moved the goalposts on already-emitted
   * data" without a stable map-version marker. Pin this hash on any
   * dashboard screenshot — if it changes between two views, the
   * goalposts moved.
   */
  expectations_hash: string;
  rows: PlaybookClaimCoverage[];
  /**
   * MEDIUM-1-style adversarial-defense field (matches Phase 11): rows
   * whose playbook_id or claim_type fell outside the canonical
   * taxonomy, surfaced so an upstream emitter typo doesn't render as
   * a no_data row indistinguishable from genuine zero traffic.
   */
  dropped_off_taxonomy: {
    count: number;
    samples: ClaimCoverageMetricRow[];
  };
}

/**
 * 12-char SHA256 prefix of the canonical PLAYBOOK_CLAIM_EXPECTATIONS
 * map. Stable across processes for a given source-of-truth snapshot
 * — used as the version marker in dashboard responses.
 *
 * Exported for tests + for any future cross-reference (e.g. an
 * /admin/v4/expectations endpoint that returns the live map).
 */
export function getExpectationsHash(): string {
  // Use the sorted-keys JSON so the hash is invariant under map-key
  // ordering changes (which can happen across TS transpile passes).
  const ordered: Record<string, readonly string[]> = {};
  for (const k of Object.keys(PLAYBOOK_CLAIM_EXPECTATIONS).sort()) {
    ordered[k] = PLAYBOOK_CLAIM_EXPECTATIONS[k as PlaybookId];
  }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex').slice(0, 12);
}

const OFF_TAX_SAMPLE_CAP = 10;

/**
 * Pure reshape from raw GROUP BY rows to the dashboard view. Zero-
 * fills against the full 14-playbook taxonomy.
 *
 * Off-taxonomy rows (unknown playbook id, unknown claim type, or
 * malformed `expected` tag) surface in dropped_off_taxonomy instead
 * of being silently merged — Phase 11 lesson applied here.
 */
export function summarizeClaimCoverageRows(
  rows: readonly ClaimCoverageMetricRow[],
  opts: { hours: number },
): ClaimCoverageSummary {
  // Index by (playbook_id, claim_type) -> aggregated count.
  // Track expected/unexpected separately so a row tagged with the
  // wrong `expected` value can't contaminate the gap/surprise logic.
  const observedByPb = new Map<PlaybookId, Map<B4ClaimType, number>>();
  const surpriseByPb = new Map<PlaybookId, Map<B4ClaimType, number>>();
  const offTaxonomySamples: ClaimCoverageMetricRow[] = [];
  let offTaxonomyCount = 0;
  let totalEvents = 0;

  for (const r of rows) {
    const isPbCanonical = PLAYBOOKS_BY_ID.has(r.playbook_id as PlaybookId);
    const isClaimCanonical = B4_CLAIM_TYPE_SET.has(r.claim_type);
    const isExpectedTagCanonical = r.expected === 'true' || r.expected === 'false';
    if (!isPbCanonical || !isClaimCanonical || !isExpectedTagCanonical) {
      offTaxonomyCount += r.count;
      if (offTaxonomySamples.length < OFF_TAX_SAMPLE_CAP) offTaxonomySamples.push(r);
      continue;
    }
    // Source-of-truth check: derive expected from the canonical
    // expectation map and ignore the raw tag for the gap/surprise
    // accounting. If the tag is 'true' but the map says false (or
    // vice-versa — e.g. PLAYBOOK_CLAIM_EXPECTATIONS was edited
    // mid-window), the canonical map wins. The raw tag is preserved
    // upstream for debugging but doesn't drive verdicts.
    const expectedNow = isClaimTypeExpected(r.playbook_id, r.claim_type);
    const target = expectedNow ? observedByPb : surpriseByPb;
    const pb = r.playbook_id as PlaybookId;
    const claim = r.claim_type as B4ClaimType;
    let inner = target.get(pb);
    if (!inner) {
      inner = new Map<B4ClaimType, number>();
      target.set(pb, inner);
    }
    inner.set(claim, (inner.get(claim) ?? 0) + r.count);
    totalEvents += r.count;
  }

  const out: PlaybookClaimCoverage[] = [];

  for (const playbook of PLAYBOOKS) {
    const expectedTypes = [...(PLAYBOOK_CLAIM_EXPECTATIONS[playbook.id] ?? [])];
    const observedMap = observedByPb.get(playbook.id) ?? new Map<B4ClaimType, number>();
    const surpriseMap = surpriseByPb.get(playbook.id) ?? new Map<B4ClaimType, number>();

    const expectedObserved: ExpectedClaimObservation[] = [];
    const expectedMissing: B4ClaimType[] = [];
    for (const t of expectedTypes) {
      const count = observedMap.get(t) ?? 0;
      if (count > 0) expectedObserved.push({ claim_type: t, count });
      else expectedMissing.push(t);
    }

    const unexpectedObserved: ExpectedClaimObservation[] = [];
    for (const [t, count] of surpriseMap) {
      if (count > 0) unexpectedObserved.push({ claim_type: t, count });
    }
    // Stable sort by count desc so the dashboard surfaces the loudest
    // surprise first. MEDIUM-2 adversarial fix: tie-break by
    // claim_type to make the response deterministic. SQL GROUP BY
    // has no ordering guarantee, so insertion-order ties would let
    // two consecutive dashboard hits show the same data in different
    // orders — breaks any diff/snapshot tooling and "did this
    // position change?" alerting.
    unexpectedObserved.sort(
      (a, b) => b.count - a.count || a.claim_type.localeCompare(b.claim_type),
    );

    let total = 0;
    for (const v of observedMap.values()) total += v;
    for (const v of surpriseMap.values()) total += v;

    let calibration: PlaybookClaimCoverage['calibration'];
    if (total === 0) calibration = 'no_data';
    else if (unexpectedObserved.length > 0) calibration = 'surprise';
    else if (expectedMissing.length > 0) calibration = 'gap';
    else calibration = 'aligned';

    out.push({
      playbook_id: playbook.id,
      expected_types: expectedTypes,
      expected_observed: expectedObserved,
      expected_missing: expectedMissing,
      unexpected_observed: unexpectedObserved,
      total,
      calibration,
    });
  }

  return {
    hours: opts.hours,
    total_events: totalEvents,
    expectations_hash: getExpectationsHash(),
    rows: out,
    dropped_off_taxonomy: { count: offTaxonomyCount, samples: offTaxonomySamples },
  };
}
