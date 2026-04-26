import { query } from '../lib/db.js';
import { cacheInvalidate, verdictCacheKey } from '../lib/cache.js';
import { computeScore, SCORE_VERSION } from '../services/score.js';
import { recomputeAggregatesForNumber } from './ingest.js';
import type { NumberSignals, BusinessMatch, LineType, Attestation } from '../types.js';

interface NumberAggRow {
  e164: string;
  mention_count_30d: number;
  mention_count_all: number;
  sentiment_neg_ratio: number;
  sources: Record<string, number> | null;
  stir_shaken_attestation: Attestation | null;
  line_type: LineType;
  carrier: string | null;
  number_age_days: number | null;
  business_match: BusinessMatch | null;
  spoof_reports_30d: number;
  first_seen: Date | null;
  last_seen: Date | null;
}

export async function rescoreNumber(e164: string): Promise<void> {
  await recomputeAggregatesForNumber(e164);
  const row = await query<NumberAggRow>(
    `SELECT e164, mention_count_30d, mention_count_all, sentiment_neg_ratio,
            sources, stir_shaken_attestation, line_type, carrier,
            number_age_days, business_match, spoof_reports_30d,
            first_seen, last_seen
       FROM numbers WHERE e164 = $1`,
    [e164],
  );
  if (row.rows.length === 0) return;
  const r = row.rows[0]!;
  const signals: NumberSignals = {
    mention_count_30d: Number(r.mention_count_30d ?? 0),
    mention_count_all: Number(r.mention_count_all ?? 0),
    negative_sentiment_ratio: Number(r.sentiment_neg_ratio ?? 0),
    complaint_sources: r.sources ? Object.keys(r.sources).length : 0,
    first_seen: r.first_seen ? r.first_seen.toISOString() : null,
    last_seen: r.last_seen ? r.last_seen.toISOString() : null,
    stir_shaken_attestation: r.stir_shaken_attestation,
    carrier: r.carrier,
    line_type: r.line_type ?? 'unknown',
    number_age_days: r.number_age_days,
    business_match: r.business_match,
    spoof_reports_30d: Number(r.spoof_reports_30d ?? 0),
  };
  const s = computeScore({ e164, signals });
  await query(
    `UPDATE numbers
        SET trust_score = $2,
            verdict = $3,
            summary = $4,
            score_computed_at = NOW(),
            score_version = $5
      WHERE e164 = $1`,
    [e164, s.trust_score, s.verdict, s.summary, SCORE_VERSION],
  );
  await cacheInvalidate(verdictCacheKey(e164));
}

export async function rescoreStale(limit: number = 200): Promise<number> {
  const stale = await query<{ e164: string }>(
    `SELECT e164 FROM numbers
       WHERE score_computed_at IS NULL
          OR score_computed_at < NOW() - INTERVAL '1 hour'
       ORDER BY score_computed_at NULLS FIRST
       LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (const row of stale.rows) {
    try {
      await rescoreNumber(row.e164);
      n += 1;
    } catch (err) {
      console.error(`rescore failed for ${row.e164}`, err);
    }
  }
  return n;
}
