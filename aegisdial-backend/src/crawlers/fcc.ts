import { config } from '../config.js';
import { ingestRawMentions } from './ingest.js';
import { rescoreNumber } from './rescore.js';
import type { CrawlResult, Crawler, RawMention } from './types.js';

// FCC Consumer Complaints (Socrata API)
// Dataset: CGB-Consumer-Complaints-Data (3xyp-aqkj)
// https://opendata.fcc.gov/resource/3xyp-aqkj.json
const FCC_ENDPOINT = 'https://opendata.fcc.gov/resource/3xyp-aqkj.json';

interface FccRow {
  id?: string;
  caller_id_number?: string;
  issue?: string;
  issue_type?: string;
  issue_date?: string;
  date_created?: string;
  method?: string;
  type_of_call_or_messge?: string; // note: FCC actually has this typo
}

export class FccCrawler implements Crawler {
  readonly name = 'fcc';
  readonly cronExpr = '0 */6 * * *'; // every 6 hours

  readonly enabled = true;

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

    const params = new URLSearchParams({
      $limit: '500',
      $order: 'date_created DESC',
      $where: "caller_id_number IS NOT NULL AND caller_id_number != '' AND caller_id_number != 'None'",
    });
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (config.FCC_APP_TOKEN) headers['X-App-Token'] = config.FCC_APP_TOKEN;

    let rows: FccRow[] = [];
    try {
      const res = await fetch(`${FCC_ENDPOINT}?${params}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.error(`fcc http ${res.status}`);
        result.errors += 1;
        result.duration_ms = Math.round(performance.now() - start);
        return result;
      }
      rows = (await res.json()) as FccRow[];
      result.fetched = rows.length;
    } catch (err) {
      console.error('fcc fetch error', (err as Error).message);
      result.errors += 1;
      result.duration_ms = Math.round(performance.now() - start);
      return result;
    }

    const raws: RawMention[] = rows
      .filter((r) => r.caller_id_number)
      .map((r) => {
        const observedRaw = r.issue_date ?? r.date_created;
        return {
          source: 'fcc_complaints',
          source_ref: r.id ?? `${r.caller_id_number}-${observedRaw ?? ''}`,
          url: 'https://opendata.fcc.gov/dataset/CGB-Consumer-Complaints-Data/3xyp-aqkj',
          snippet: buildFccSnippet(r),
          observed_at: observedRaw ? new Date(observedRaw) : new Date(),
        };
      });

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
}

function buildFccSnippet(r: FccRow): string {
  const parts: string[] = [];
  parts.push(`FCC complaint for caller ${r.caller_id_number ?? 'unknown'}`);
  if (r.issue) parts.push(`issue: ${r.issue}`);
  if (r.issue_type) parts.push(`issue_type: ${r.issue_type}`);
  if (r.method) parts.push(`method: ${r.method}`);
  if (r.type_of_call_or_messge) parts.push(`type: ${r.type_of_call_or_messge}`);
  const whenRaw = r.issue_date ?? r.date_created;
  if (whenRaw) parts.push(`date: ${whenRaw}`);
  parts.push('This number was reported to the FCC as unwanted, robocall, or scam-related.');
  return parts.join(' · ');
}
