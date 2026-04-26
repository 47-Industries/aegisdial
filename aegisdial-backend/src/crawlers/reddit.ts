import { config } from '../config.js';
import { ingestRawMentions } from './ingest.js';
import { rescoreNumber } from './rescore.js';
import type { CrawlResult, Crawler, RawMention } from './types.js';

const DEFAULT_SUBS = [
  'Scams',
  'phonescams',
  'personalfinance',
  'legaladvice',
  'elderly',
  'AskOldPeople',
];

interface RedditListing {
  data?: {
    children?: Array<{
      data?: {
        id?: string;
        name?: string;
        title?: string;
        selftext?: string;
        body?: string;
        permalink?: string;
        created_utc?: number;
        url?: string;
      };
    }>;
  };
}

class RedditClient {
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private userAgent: string,
  ) {}

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.userAgent,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`reddit token ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  async fetchListing(sub: string, listing: 'new' | 'hot', limit: number): Promise<RedditListing> {
    const token = await this.ensureToken();
    const url = `https://oauth.reddit.com/r/${sub}/${listing}?limit=${limit}&raw_json=1`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': this.userAgent,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`reddit ${sub}/${listing} ${res.status}`);
    }
    return (await res.json()) as RedditListing;
  }
}

export class RedditCrawler implements Crawler {
  readonly name = 'reddit';
  readonly cronExpr = '*/15 * * * *'; // every 15 minutes

  private client: RedditClient | null = null;
  private subs: string[];

  constructor(subs: string[] = DEFAULT_SUBS) {
    this.subs = subs;
    if (config.REDDIT_CLIENT_ID && config.REDDIT_CLIENT_SECRET) {
      this.client = new RedditClient(
        config.REDDIT_CLIENT_ID,
        config.REDDIT_CLIENT_SECRET,
        config.REDDIT_USER_AGENT,
      );
    }
  }

  get enabled(): boolean {
    return this.client !== null;
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
    if (!this.client) {
      result.duration_ms = Math.round(performance.now() - start);
      return result;
    }

    const raws: RawMention[] = [];
    for (const sub of this.subs) {
      try {
        const data = await this.client.fetchListing(sub, 'new', 50);
        const items = data.data?.children ?? [];
        result.fetched += items.length;
        for (const child of items) {
          const d = child.data;
          if (!d?.name) continue;
          const text = `${d.title ?? ''}\n${d.selftext ?? d.body ?? ''}`.trim();
          if (!text) continue;
          raws.push({
            source: `reddit:r/${sub}`,
            source_ref: d.name,
            url: d.permalink ? `https://reddit.com${d.permalink}` : d.url,
            snippet: text,
            observed_at: d.created_utc ? new Date(d.created_utc * 1000) : new Date(),
          });
        }
      } catch (err) {
        console.error(`reddit crawl error r/${sub}:`, (err as Error).message);
        result.errors += 1;
      }
      await sleep(300);
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
