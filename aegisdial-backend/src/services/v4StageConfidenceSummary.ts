import { query } from '../lib/db.js';
import {
  summarizeStageConfidenceRows,
  type StageConfidenceMetricRow,
  type StageConfidenceSummary,
} from '../lib/stageConfidenceCoverage.js';

// Live Shield v4 — Phase 13 — admin-route data fetcher for the
// stage-confidence calibration view. Pattern mirrors Phase 11
// (timing) and Phase 12 (claim coverage): one SQL GROUP BY pass
// against metric_counters, then pure-function reshape.

export async function getStageConfidenceSummary(
  hours: number,
): Promise<StageConfidenceSummary> {
  const res = await query<{
    playbook_id: string;
    stage: string;
    confidence_bucket: string;
    count: string;
  }>(
    `SELECT
       tags->>'playbook_id'       AS playbook_id,
       tags->>'stage'             AS stage,
       tags->>'confidence_bucket' AS confidence_bucket,
       SUM(value)::bigint         AS count
     FROM metric_counters
     WHERE name = 'v4.classifier.classified'
       AND bucket > NOW() - $1::INTERVAL
     GROUP BY 1, 2, 3`,
    [`${hours} hours`],
  );

  const rows: StageConfidenceMetricRow[] = res.rows.map((r) => ({
    playbook_id: r.playbook_id,
    stage: r.stage,
    confidence_bucket: r.confidence_bucket,
    count: Number(r.count),
  }));

  return summarizeStageConfidenceRows(rows, { hours });
}
