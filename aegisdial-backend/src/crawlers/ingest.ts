import { query, withTx } from '../lib/db.js';
import { cacheInvalidate, verdictCacheKey } from '../lib/cache.js';
import { extractPhoneNumbers, windowSnippet } from './phone.js';
import { classifyMention } from './sentiment.js';
import type { NormalizedMention, RawMention } from './types.js';

export interface IngestStats {
  mentioned_numbers: number;
  inserted: number;
  skipped: number;
  errors: number;
  affected_e164s: Set<string>;
}

export async function ingestRawMentions(
  raws: RawMention[],
): Promise<IngestStats> {
  const stats: IngestStats = {
    mentioned_numbers: 0,
    inserted: 0,
    skipped: 0,
    errors: 0,
    affected_e164s: new Set<string>(),
  };

  const normalized: NormalizedMention[] = [];
  for (const raw of raws) {
    const numbers = extractPhoneNumbers(raw.snippet);
    if (numbers.length === 0) continue;
    stats.mentioned_numbers += numbers.length;
    for (const e164 of numbers) {
      const snippet = windowSnippet(raw.snippet, e164.replace('+1', '')).slice(0, 1000);
      const cls = classifyMention(snippet || raw.snippet);
      const sourceRef =
        raw.source_ref && numbers.length > 1
          ? `${raw.source_ref}#${e164}`
          : raw.source_ref;
      normalized.push({
        e164,
        source: raw.source,
        source_ref: sourceRef,
        url: raw.url ?? null,
        snippet: snippet || raw.snippet.slice(0, 1000),
        sentiment: cls.sentiment,
        scam_category: cls.scam_category,
        severity: cls.severity,
        weight: cls.weight,
        observed_at: raw.observed_at ?? new Date(),
      });
    }
  }

  if (normalized.length === 0) return stats;

  for (const m of normalized) {
    try {
      await persistMention(m);
      stats.inserted += 1;
      stats.affected_e164s.add(m.e164);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        stats.skipped += 1;
      } else {
        stats.errors += 1;
      }
    }
  }

  await Promise.all(
    [...stats.affected_e164s].map((e164) => cacheInvalidate(verdictCacheKey(e164))),
  );

  return stats;
}

async function persistMention(m: NormalizedMention): Promise<void> {
  await withTx(async (client) => {
    await client.query(
      `INSERT INTO mentions (
         e164, source, source_ref, url, snippet, sentiment, scam_category,
         severity, weight, observed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
      [
        m.e164,
        m.source,
        m.source_ref,
        m.url,
        m.snippet,
        m.sentiment,
        m.scam_category,
        m.severity,
        m.weight,
        m.observed_at,
      ],
    );

    const isScamCategory =
      m.scam_category !== null &&
      ['scam', 'phishing', 'impersonation', 'robocall'].includes(m.scam_category);

    await client.query(
      `INSERT INTO numbers (e164, mention_count_all, mention_count_30d, spoof_reports_30d, sources, last_seen)
       VALUES ($1, 1, 1, $2, jsonb_build_object($3::text, 1), NOW())
       ON CONFLICT (e164) DO UPDATE SET
         mention_count_all = numbers.mention_count_all + 1,
         mention_count_30d = numbers.mention_count_30d + 1,
         spoof_reports_30d = numbers.spoof_reports_30d + $2,
         sources = COALESCE(numbers.sources, '{}'::jsonb) ||
                   jsonb_build_object(
                     $3::text,
                     COALESCE((numbers.sources->>$3)::int, 0) + 1
                   ),
         last_seen = NOW()`,
      [m.e164, isScamCategory ? 1 : 0, m.source],
    );
  });
}

export async function recomputeAggregatesForNumber(e164: string): Promise<void> {
  await query(
    `UPDATE numbers
       SET mention_count_30d = COALESCE(sub30.cnt, 0),
           mention_count_all = COALESCE(suball.cnt, 0),
           spoof_reports_30d = COALESCE(sub_spoof.cnt, 0),
           sentiment_neg_ratio = COALESCE(sub_sent.neg_ratio, 0),
           sources = COALESCE(sub_src.sources, '{}'::jsonb)
     FROM (
       SELECT COUNT(*)::int AS cnt FROM mentions
        WHERE e164 = $1 AND created_at > NOW() - INTERVAL '30 days'
     ) sub30,
     (
       SELECT COUNT(*)::int AS cnt FROM mentions WHERE e164 = $1
     ) suball,
     (
       SELECT COUNT(*)::int AS cnt FROM mentions
        WHERE e164 = $1
          AND scam_category IN ('scam','phishing','impersonation','robocall')
          AND created_at > NOW() - INTERVAL '30 days'
     ) sub_spoof,
     (
       SELECT CASE WHEN COUNT(*) = 0 THEN 0::real
                   ELSE (COUNT(*) FILTER (WHERE sentiment = 'negative'))::real / COUNT(*)::real
              END AS neg_ratio
         FROM mentions WHERE e164 = $1
     ) sub_sent,
     (
       SELECT jsonb_object_agg(source, cnt) AS sources FROM (
         SELECT source, COUNT(*)::int AS cnt FROM mentions
          WHERE e164 = $1 GROUP BY source
       ) s
     ) sub_src
     WHERE numbers.e164 = $1`,
    [e164],
  );
}
