import * as cheerio from 'cheerio';
import { ingestRawMentions } from './ingest.js';
import { rescoreNumber } from './rescore.js';
import type { CrawlResult, Crawler, RawMention } from './types.js';

const BASE = 'https://www.bbb.org';
const LIST_URL = `${BASE}/scamtracker/lookupscam`;
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class BbbCrawler implements Crawler {
  readonly name = 'bbb';
  readonly cronExpr = '15 */2 * * *'; // every 2 hours, :15 past the hour

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

    const ids = await this.fetchRecentScamIds();
    if (ids.length === 0) {
      result.duration_ms = Math.round(performance.now() - start);
      return result;
    }

    const raws: RawMention[] = [];
    for (const id of ids) {
      try {
        const detail = await fetchDetail(id);
        if (!detail) continue;
        result.fetched += 1;
        raws.push({
          source: 'bbb_scamtracker',
          source_ref: id,
          url: `${BASE}/scamtracker/lookupscam/${id}`,
          snippet: buildBbbSnippet(detail),
          observed_at: detail.dateReported ?? new Date(),
        });
      } catch (err) {
        console.error(`bbb detail error ${id}`, (err as Error).message);
        result.errors += 1;
      }
      await sleep(1200); // polite crawl — BBB is a public nonprofit
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

  private async fetchRecentScamIds(): Promise<string[]> {
    try {
      const res = await fetch(LIST_URL, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return [];
      const html = await res.text();
      return extractScamIds(html);
    } catch {
      return [];
    }
  }
}

export function extractScamIds(html: string): string[] {
  const ids = new Set<string>();
  const re = /\/scamtracker\/lookupscam\/(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    ids.add(m[1]);
  }
  return [...ids];
}

interface BbbReportDetail {
  id: string;
  description: string;
  scammerPhone?: string;
  scamType?: string;
  dateReported?: Date;
  targetLocation?: string;
}

async function fetchDetail(id: string): Promise<BbbReportDetail | null> {
  const url = `${BASE}/scamtracker/lookupscam/${id}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  return parseBbbReport(id, html);
}

export function parseBbbReport(id: string, html: string): BbbReportDetail {
  const $ = cheerio.load(html);
  // Strip style/script nodes so their text content doesn't pollute labeled
  // slices. BBB uses emotion-css inline styles that otherwise concatenate into
  // the middle of "Scam Type: Phishing".
  $('style, script, noscript').remove();
  const body = $('body').text().replace(/\s+/g, ' ').trim();

  const description = sliceBetween(body, 'Description', [
    "Targeted Person's Location",
    'Targeted Person',
    'Scammer Information',
  ]);
  const scamType = sliceBetween(body, 'Scam Type', ['Business name', 'Date Reported', 'Scam ID']);
  const dateReportedStr = sliceBetween(body, 'Date Reported', ['Scam ID', 'Similar to your experience']);
  const targetLocation = sliceBetween(body, "Targeted Person's Location", [
    'Scammer Information',
    'Scam Type',
  ]);

  // Scammer phone appears in the Scammer Information block. It may or may not
  // be present; when absent, phones in the description still get extracted
  // downstream by the shared phone regex.
  const phoneFromBlock = findScammerPhone($);

  const dateReported = parseBbbDate(dateReportedStr);
  return {
    id,
    description: description.slice(0, 3000),
    scammerPhone: phoneFromBlock || undefined,
    scamType: scamType || undefined,
    dateReported,
    targetLocation: targetLocation || undefined,
  };
}

function findScammerPhone($: cheerio.CheerioAPI): string | null {
  // The scammer phone is rendered as <p>(XXX) XXX-XXXX</p> adjacent to
  // <img alt="Phone number logo" ...> with a Mobile.svg icon. Fallback: scan
  // any text under a heading containing "Scammer Information".
  let phone: string | null = null;
  $('img').each((_, el) => {
    const src = $(el).attr('src') ?? '';
    const alt = ($(el).attr('alt') ?? '').toLowerCase();
    if (/Mobile\.svg|phone/i.test(src) || alt.includes('phone')) {
      const sib = $(el).parent().find('p').first().text().trim();
      if (sib && /\d/.test(sib) && sib.toLowerCase() !== 'unknown') {
        phone = sib;
        return false;
      }
    }
    return true;
  });
  return phone;
}

function sliceBetween(body: string, startLabel: string, endLabels: string[]): string {
  const i = body.indexOf(startLabel);
  if (i < 0) return '';
  const from = i + startLabel.length;
  let to = body.length;
  for (const label of endLabels) {
    const j = body.indexOf(label, from);
    if (j > 0 && j < to) to = j;
  }
  return body.slice(from, to).trim();
}

function parseBbbDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

function buildBbbSnippet(r: BbbReportDetail): string {
  const parts: string[] = [`BBB Scam Tracker report #${r.id}`];
  if (r.scamType) parts.push(`type: ${r.scamType}`);
  if (r.scammerPhone) parts.push(`scammer phone: ${r.scammerPhone}`);
  if (r.targetLocation) parts.push(`victim location: ${r.targetLocation}`);
  if (r.description) parts.push(`description: ${r.description}`);
  parts.push('This number was reported to the BBB Scam Tracker by a consumer victim or potential victim.');
  return parts.join(' · ').slice(0, 3500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
