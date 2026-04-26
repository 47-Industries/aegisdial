import { config } from '../config.js';
import { ingestRawMentions } from './ingest.js';
import { rescoreNumber } from './rescore.js';
import { query } from '../lib/db.js';
import type { CrawlResult, Crawler, RawMention } from './types.js';

interface SerperOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
}

interface SerperResponse {
  organic?: SerperOrganicResult[];
}

export class SerperCrawler implements Crawler {
  readonly name = 'google_serper';
  readonly cronExpr = '0 * * * *'; // every hour

  get enabled(): boolean {
    return !!config.SERPER_API_KEY;
  }

  async run(): Promise<CrawlResult> {
    const start = performance.now();
    const result: CrawlResult = {
      source: this.name,
      fetched: 0,
      mentioned_numbers: 0,
      inserted: 0,
      skipped: 0,
      errors: 0,
      duration_ms: 0,
    };
    if (!this.enabled) {
      result.duration_ms = Math.round(performance.now() - start);
      return result;
    }

    const targets = await this.pickTargets();
    const raws: RawMention[] = [];

    for (const e164 of targets) {
      try {
        const queries = expandQueries(e164);
        for (const q of queries) {
          const res = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: {
              'X-API-KEY': config.SERPER_API_KEY!,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ q, num: 10, gl: 'us', hl: 'en' }),
            signal: AbortSignal.timeout(6000),
          });
          if (!res.ok) {
            result.errors += 1;
            continue;
          }
          const data = (await res.json()) as SerperResponse;
          const organic = data.organic ?? [];
          result.fetched += organic.length;
          for (const item of organic) {
            const snippet = `${item.title ?? ''}. ${item.snippet ?? ''}`.trim();
            if (!snippet) continue;
            raws.push({
              source: 'google_serper',
              source_ref: `${q}::${item.link ?? item.title ?? Math.random()}`,
              url: item.link,
              snippet: `${e164.replace('+1', '')}: ${snippet}`,
              observed_at: item.date ? new Date(item.date) : new Date(),
            });
          }
          await sleep(250);
        }
      } catch (err) {
        console.error(`serper error ${e164}`, (err as Error).message);
        result.errors += 1;
      }
    }

    const stats = await ingestRawMentions(raws);
    result.mentioned_numbers = stats.mentioned_numbers;
    result.inserted = stats.inserted;
    result.skipped = stats.skipped;
    result.errors += stats.errors;

    for (const e164 of stats.affected_e164s) {
      try {
        await rescoreNumber(e164);
      } catch {}
    }

    result.duration_ms = Math.round(performance.now() - start);
    return result;
  }

  private async pickTargets(): Promise<string[]> {
    const res = await query<{ e164: string }>(
      `SELECT e164 FROM numbers
        WHERE e164 LIKE '+1%'
          AND (score_computed_at IS NULL OR score_computed_at < NOW() - INTERVAL '24 hours')
        ORDER BY mention_count_30d DESC NULLS LAST, last_seen DESC NULLS LAST
        LIMIT 10`,
    );
    return res.rows.map((r) => r.e164);
  }
}

function expandQueries(e164: string): string[] {
  const raw = e164.replace(/^\+1/, '');
  const a = raw.slice(0, 3);
  const b = raw.slice(3, 6);
  const c = raw.slice(6);
  return [
    `"${e164}" scam`,
    `"(${a}) ${b}-${c}" scam`,
    `"${a}-${b}-${c}" reported`,
    `"${raw}" robocall`,
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
