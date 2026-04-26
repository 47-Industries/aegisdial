export interface RawMention {
  source: string;
  source_ref: string;
  url?: string;
  snippet: string;
  author?: string;
  observed_at?: Date;
}

export interface NormalizedMention {
  e164: string;
  source: string;
  source_ref: string;
  url: string | null;
  snippet: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  scam_category: string | null;
  severity: number;
  weight: number;
  observed_at: Date;
}

export interface CrawlResult {
  source: string;
  fetched: number;
  mentioned_numbers: number;
  inserted: number;
  skipped: number;
  errors: number;
  duration_ms: number;
}

export interface Crawler {
  readonly name: string;
  readonly enabled: boolean;
  readonly cronExpr: string;
  run(): Promise<CrawlResult>;
}
