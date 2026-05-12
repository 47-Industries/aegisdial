import { query } from '../lib/db.js';
import { PLAYBOOKS, PLAYBOOKS_BY_ID, type PlaybookId } from '../data/playbooks.js';

// Live Shield v4 — Phase 17 — sentinel × playbook coverage view.
//
// Phases 11/12/13 cover the v4 classifier's own correctness. Phase
// 17 cross-references the OTHER half of Live Shield — the B3
// sentinel matcher — against the playbook lock.
//
// Question this answers: "for each playbook, are the B3 sentinels
// firing at all? Or is there a playbook we've classified into
// hundreds of times whose sentinels never trigger — i.e., a
// coverage gap that means B3 won't catch anything for that script?"
//
// Source data: v3.sentinel_matcher.fired emissions, now tagged
// {pattern, v4_playbook_id} since Phase 17 (sentinelMatcher.ts).
// Pre-Phase-17 emissions have no v4_playbook_id tag — they land in
// dropped_off_taxonomy so historical drift is visible. The 'none'
// playbook tag is REAL data (sentinel fired before v4 classification
// locked on); it surfaces in its own `none_playbook` bucket — that's
// expected, not an off-taxonomy drop.
//
// SENTINEL VALUE: the literal string 'none' marks pre-classification
// fires. PlaybookId is a closed TypeScript union and no canonical
// playbook is named 'none' — defended at runtime by the type system
// + a `data/playbooks.ts` invariant. If a future playbook is ever
// added with id='none' the aggregator would silently route its
// fires into none_playbook (LOW-1 from the Phase 17 adversarial
// review); the SENTINEL_RESERVED_IDS test below pins the invariant.
//
// TIMING NOTE: the v4_playbook_id tag reflects the v4 lock at
// SENTINEL-MATCH-FETCH time, not strictly at FIRE time. The
// classifier can commit a new lock between the pre-loop v4Ctx
// fetch and the per-pattern emit. Magnitude is bounded by chunk
// evaluation duration (~tens of ms) — drift is small but real.
// Surfaced here so the operator knows pre-classification noise has
// a long tail in the 'none' bucket. (MEDIUM-2 adversarial note.)

export interface SentinelFireRow {
  playbook_id: string;
  pattern: string;
  count: number;
}

export interface PatternFireCount {
  pattern: string;
  count: number;
}

export interface PlaybookSentinelCoverage {
  playbook_id: PlaybookId;
  total_fires: number;
  /** Patterns that fired for this playbook in the window, count desc. */
  patterns: PatternFireCount[];
  /**
   * Operator-facing rollup:
   *   - 'no_data': total_fires === 0 (no sentinel coverage at all
   *               for this playbook in the window — possible
   *               coverage gap)
   *   - 'covered': >= 1 pattern fired
   *
   * 'no_data' is the actionable signal — playbooks with zero
   * sentinel firings need pattern additions (or are correctly
   * non-sentinel-able and should be marked as such).
   */
  coverage: 'covered' | 'no_data';
}

export interface SentinelCoverageSummary {
  hours: number;
  total_events: number;
  /** Per-playbook breakdown, one per canonical playbook (14 rows). */
  rows: PlaybookSentinelCoverage[];
  /**
   * Sentinel fires that happened BEFORE v4 lock-on (playbook_id =
   * 'none' tag). NOT a defect — sentinels routinely fire early in
   * the call before the classifier has enough context. Surfaced so
   * the operator can see "X% of fires are pre-classification" as a
   * separate calibration signal.
   */
  none_playbook: {
    total_fires: number;
    patterns: PatternFireCount[];
  };
  /**
   * Fires whose playbook_id tag doesn't match the canonical
   * taxonomy (pre-Phase-17 untagged emissions OR a stale playbook
   * id post-rollback). Phase 11/12/13 surfacing pattern applied.
   */
  dropped_off_taxonomy: {
    count: number;
    samples: SentinelFireRow[];
  };
}

const OFF_TAX_SAMPLE_CAP = 10;

/**
 * Reserved sentinel-value contract: 'none' MUST NOT be a canonical
 * PlaybookId. The aggregator's `r.playbook_id === 'none'` check runs
 * BEFORE the canonical taxonomy lookup, so a collision would route
 * real data into the pre-classification bucket. Tests assert this
 * invariant against the live PLAYBOOKS list.
 */
export const RESERVED_PLAYBOOK_ID_NONE = 'none' as const;

// Throw at module load if the invariant is violated — surfaces the
// bug at deploy time rather than silently mis-attributing data.
if (PLAYBOOKS_BY_ID.has(RESERVED_PLAYBOOK_ID_NONE as PlaybookId)) {
  throw new Error(
    `v4SentinelCoverageSummary: '${RESERVED_PLAYBOOK_ID_NONE}' is a reserved sentinel value but a canonical playbook now uses it. Rename the playbook or pick a different sentinel.`,
  );
}

/**
 * Pure reshape from raw GROUP BY rows to the dashboard view.
 * Zero-fills against the 14-playbook taxonomy. 'none' playbook is
 * its own non-canonical-but-expected bucket.
 */
export function summarizeSentinelCoverageRows(
  rows: readonly SentinelFireRow[],
  opts: { hours: number },
): SentinelCoverageSummary {
  // (playbook, pattern) -> count, scoped per category.
  const byPlaybook = new Map<PlaybookId, Map<string, number>>();
  const nonePatterns = new Map<string, number>();
  const offTaxonomySamples: SentinelFireRow[] = [];
  let offTaxonomyCount = 0;
  let totalEvents = 0;

  for (const r of rows) {
    if (r.playbook_id === RESERVED_PLAYBOOK_ID_NONE) {
      nonePatterns.set(r.pattern, (nonePatterns.get(r.pattern) ?? 0) + r.count);
      totalEvents += r.count;
      continue;
    }
    if (!PLAYBOOKS_BY_ID.has(r.playbook_id as PlaybookId)) {
      offTaxonomyCount += r.count;
      if (offTaxonomySamples.length < OFF_TAX_SAMPLE_CAP) offTaxonomySamples.push(r);
      // M-1 adversarial fix: off-taxonomy data still counts toward
      // total_events so the operator's "is the dashboard accurate?"
      // cross-check (sum of all axes equals total_events) holds even
      // during the pre-Phase-17 backfill window.
      totalEvents += r.count;
      continue;
    }
    const pb = r.playbook_id as PlaybookId;
    let inner = byPlaybook.get(pb);
    if (!inner) {
      inner = new Map<string, number>();
      byPlaybook.set(pb, inner);
    }
    inner.set(r.pattern, (inner.get(r.pattern) ?? 0) + r.count);
    totalEvents += r.count;
  }

  const out: PlaybookSentinelCoverage[] = [];
  for (const playbook of PLAYBOOKS) {
    const inner = byPlaybook.get(playbook.id) ?? new Map<string, number>();
    let total = 0;
    const patterns: PatternFireCount[] = [];
    for (const [pat, count] of inner) {
      patterns.push({ pattern: pat, count });
      total += count;
    }
    // Sort by count desc, tie-break by pattern name lexicographic
    // for determinism (same M-2 rationale as Phase 12).
    patterns.sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));

    out.push({
      playbook_id: playbook.id,
      total_fires: total,
      patterns,
      coverage: total > 0 ? 'covered' : 'no_data',
    });
  }

  const nonePatternsList: PatternFireCount[] = [];
  let noneTotal = 0;
  for (const [pat, count] of nonePatterns) {
    nonePatternsList.push({ pattern: pat, count });
    noneTotal += count;
  }
  nonePatternsList.sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));

  return {
    hours: opts.hours,
    total_events: totalEvents,
    rows: out,
    none_playbook: { total_fires: noneTotal, patterns: nonePatternsList },
    dropped_off_taxonomy: { count: offTaxonomyCount, samples: offTaxonomySamples },
  };
}

export async function getSentinelCoverageSummary(
  hours: number,
): Promise<SentinelCoverageSummary> {
  const res = await query<{
    playbook_id: string;
    pattern: string;
    count: string;
  }>(
    `SELECT
       tags->>'v4_playbook_id' AS playbook_id,
       tags->>'pattern'        AS pattern,
       SUM(value)::bigint      AS count
     FROM metric_counters
     WHERE name = 'v3.sentinel_matcher.fired'
       AND bucket > NOW() - $1::INTERVAL
     GROUP BY 1, 2`,
    [`${hours} hours`],
  );

  const rows: SentinelFireRow[] = res.rows.map((r) => ({
    // Pre-Phase-17 emissions had no v4_playbook_id tag; tags->>'k' on
    // a missing key returns NULL → JS null. Treat as off-taxonomy.
    playbook_id: r.playbook_id ?? '__untagged__',
    pattern: r.pattern,
    count: Number(r.count),
  }));

  return summarizeSentinelCoverageRows(rows, { hours });
}
