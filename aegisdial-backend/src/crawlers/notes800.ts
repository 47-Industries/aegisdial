import * as cheerio from 'cheerio';
import { ingestRawMentions } from './ingest.js';
import { rescoreNumber } from './rescore.js';
import { query } from '../lib/db.js';
import type { CrawlResult, Crawler, RawMention } from './types.js';

const BASE = 'https://800notes.com';
const UA = 'AegisDial/0.1 (+https://aegisdial.com/bot) consumer-fraud-protection';

export class Notes800Crawler implements Crawler {
  readonly name = '800notes';
  readonly cronExpr = '*/30 * * * *'; // every 30 min

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

    const targets = await this.pickTargets();
    const raws: RawMention[] = [];

    for (const e164 of targets) {
      try {
        const rawNumber = e164.replace(/^\+1/, '');
        const dashed = rawNumber.length === 10
          ? `1-${rawNumber.slice(0, 3)}-${rawNumber.slice(3, 6)}-${rawNumber.slice(6)}`
          : rawNumber;
        const url = `${BASE}/Phone.aspx/${dashed}`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': UA,
            Accept: 'text/html',
          },
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 404) continue;
        if (!res.ok) {
          result.errors += 1;
          continue;
        }
        result.fetched += 1;
        const html = await res.text();
        const comments = parse800NotesComments(html, rawNumber);
        for (const c of comments) {
          raws.push({
            source: '800notes',
            source_ref: `${rawNumber}#${c.commentId}`,
            url,
            snippet: c.text,
            author: c.author ?? undefined,
            observed_at: c.date,
          });
        }
      } catch (err) {
        console.error(`800notes error ${e164}`, (err as Error).message);
        result.errors += 1;
      }
      await sleep(1500); // polite crawl
    }

    const stats = await ingestRawMentions(raws);
    result.mentioned_numbers = stats.mentioned_numbers;
    result.inserted = stats.inserted;
    result.skipped = stats.skipped;
    result.errors += stats.errors;

    for (const e164 of stats.affected_e164s) {
      try {
        await rescoreNumber(e164);
      } catch (err) {
        console.error(`rescore error ${e164}`, (err as Error).message);
      }
    }

    result.duration_ms = Math.round(performance.now() - start);
    return result;
  }

  private async pickTargets(): Promise<string[]> {
    const res = await query<{ e164: string }>(
      `SELECT e164 FROM numbers
        WHERE e164 LIKE '+1%'
        ORDER BY
          CASE WHEN trust_score IS NULL THEN 0 ELSE 1 END,
          score_computed_at NULLS FIRST,
          last_seen DESC NULLS LAST
        LIMIT 20`,
    );
    return res.rows.map((r) => r.e164);
  }
}

interface ParsedComment {
  commentId: string;
  author: string | null;
  date: Date;
  text: string;
}

export function parse800NotesComments(html: string, rawNumber: string): ParsedComment[] {
  const $ = cheerio.load(html);
  const out: ParsedComment[] = [];
  $('.oos_comment, .oos-comment, article.comment, div.comment').each((i, el) => {
    const text = $(el).text().trim().slice(0, 2000);
    if (!text) return;
    const dateStr = $(el).find('time, .date, .oos_date').attr('datetime') ??
      $(el).find('time, .date, .oos_date').text();
    const author = $(el).find('.author, .oos_caller, .user').first().text().trim() || null;
    const id = $(el).attr('id') ?? `idx${i}`;
    const date = dateStr ? new Date(dateStr) : new Date();
    out.push({
      commentId: id,
      author,
      date: isNaN(date.getTime()) ? new Date() : date,
      text: `${rawNumber}: ${text}`,
    });
  });
  if (out.length === 0) {
    const body = $('body').text();
    const trimmed = body.replace(/\s+/g, ' ').slice(0, 4000);
    if (trimmed.length > 100) {
      out.push({
        commentId: 'page',
        author: null,
        date: new Date(),
        text: `${rawNumber}: ${trimmed}`,
      });
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
