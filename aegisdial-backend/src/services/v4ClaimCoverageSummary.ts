import { query } from '../lib/db.js';
import {
  summarizeClaimCoverageRows,
  type ClaimCoverageMetricRow,
  type ClaimCoverageSummary,
} from '../lib/playbookClaimCoverage.js';

// Live Shield v4 — Phase 12 — admin-route data fetcher for the
// B4 × playbook claim-coverage view. Mirrors Phase 11's pattern:
// one SQL pass with GROUP BY against metric_counters, then hand the
// reshape off to a pure helper.
//
// The pure helper (summarizeClaimCoverageRows) lives in
// src/lib/playbookClaimCoverage.ts alongside isClaimTypeExpected so
// the gap/surprise verdict logic and the predicate that feeds the
// emit site share a single source of truth.

/**
 * Fetch + summarize claim coverage over the last N hours. Errors are
 * propagated — the admin route handler translates to 500.
 */
export async function getClaimCoverageSummary(
  hours: number,
): Promise<ClaimCoverageSummary> {
  const res = await query<{
    playbook_id: string;
    claim_type: string;
    expected: string;
    count: string;
  }>(
    `SELECT
       tags->>'playbook_id' AS playbook_id,
       tags->>'claim_type'  AS claim_type,
       tags->>'expected'    AS expected,
       SUM(value)::bigint   AS count
     FROM metric_counters
     WHERE name = 'v4.b4.claim_extracted_vs_playbook'
       AND bucket > NOW() - $1::INTERVAL
     GROUP BY 1, 2, 3`,
    [`${hours} hours`],
  );

  const rows: ClaimCoverageMetricRow[] = res.rows.map((r) => ({
    playbook_id: r.playbook_id,
    claim_type: r.claim_type,
    expected: r.expected,
    // SUM() returns numeric string for bigint safety. Realistic
    // bound: thousands of claims/day × 14 playbooks × 6 types ≈ low
    // tens-of-thousands across the 168h max window. Well below
    // Number.MAX_SAFE_INTEGER.
    count: Number(r.count),
  }));

  return summarizeClaimCoverageRows(rows, { hours });
}
