import { config } from '../config.js';
import { ingestRawMentions } from '../crawlers/ingest.js';
import { rescoreNumber } from '../crawlers/rescore.js';
import type { RawMention } from '../crawlers/types.js';
import { cacheSetNX, cacheInvalidate } from '../lib/cache.js';

// Per-verdict live-crawl: when someone looks up a number we've never seen,
// fan out to external sources in parallel. We split the budget in two:
//
//   VISIBLE_BUDGET_MS  — how long the user waits before we return. Short,
//                        so the p95 verdict stays under 1s.
//   BACKGROUND_BUDGET_MS — how long the crawl keeps running AFTER we
//                          return, so the result lands in the cache for
//                          the next user looking up the same number.
//
// Combined with single-flight via Redis, this means:
//   - User #1 on a new scam number gets a fast "unknown" (or whatever
//     our rule-based row has) in < 1s.
//   - The crawl finishes in the background, caching the enriched row.
//   - User #2+ (the scam is blasting thousands) hits a warm cache.
const VISIBLE_BUDGET_MS = 700;
const BACKGROUND_BUDGET_MS = 2_500;
const SINGLEFLIGHT_TTL_SECONDS = 30;
const FCC_ENDPOINT = 'https://opendata.fcc.gov/resource/3xyp-aqkj.json';
const BBB_LIST_URL = 'https://www.bbb.org/scamtracker/lookupscam';
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface LiveCrawlStats {
  sources_tried: string[];
  sources_hit: string[];
  mentions_inserted: number;
  duration_ms: number;
  timed_out: boolean;
}

/**
 * Synchronous caller-visible crawl. Runs every source in parallel but
 * only *waits* VISIBLE_BUDGET_MS before returning. Sources that finish
 * in time ingest + rescore; sources that don't keep running in the
 * background (up to BACKGROUND_BUDGET_MS) and update the row so the
 * NEXT user looking up the same number hits a warm cache.
 *
 * Single-flight via Redis: if another request is already crawling this
 * e164, we return empty stats immediately and let the in-flight crawl
 * finish. Prevents thundering-herd on popular scam numbers.
 */
export async function liveCrawlUnknown(e164: string): Promise<LiveCrawlStats> {
  const start = performance.now();
  const stats: LiveCrawlStats = {
    sources_tried: ['fcc', 'bbb_recent'],
    sources_hit: [],
    mentions_inserted: 0,
    duration_ms: 0,
    timed_out: false,
  };

  // Single-flight: first caller sets a Redis flag; concurrent callers
  // for the same number skip the crawl. Flag auto-expires so a crashed
  // worker never permanently blocks future crawls.
  const lockKey = `crawl:inflight:${e164}`;
  const locked = await tryAcquireLock(lockKey, SINGLEFLIGHT_TTL_SECONDS);
  if (!locked) {
    // Another request is already crawling this number; return fast.
    stats.duration_ms = Math.round(performance.now() - start);
    return stats;
  }

  // Bundle each task with its name so the "which source actually hit"
  // accounting doesn't drift when YouTube is conditional. Previously
  // `sourceNames[i]` indexed by position in `winners` (a filtered
  // array), which produced mislabeled sources_hit entries.
  interface LabeledTask {
    name: string;
    promise: Promise<RawMention[] | null>;
    settled: boolean;
    value?: RawMention[] | null;
  }
  const tasks: LabeledTask[] = [
    { name: 'fcc',          promise: withTimeout(liveFcc(e164), BACKGROUND_BUDGET_MS, 'fcc'),          settled: false },
    { name: 'bbb_recent',   promise: withTimeout(liveBbbRecent(e164), BACKGROUND_BUDGET_MS, 'bbb_recent'), settled: false },
  ];
  if (config.YOUTUBE_API_KEY) {
    stats.sources_tried.push('youtube_search');
    tasks.push({
      name: 'youtube_search',
      promise: withTimeout(liveYouTubeSearch(e164), BACKGROUND_BUDGET_MS, 'youtube_search'),
      settled: false,
    });
  }
  // Mark `settled=true` synchronously as each promise resolves so we can
  // partition winners/losers after the budget window without a fragile
  // Promise.race-against-a-sentinel trick.
  for (const t of tasks) {
    t.promise.then((v) => { t.settled = true; t.value = v; },
                    () => { t.settled = true; t.value = null; });
  }

  // Wait up to VISIBLE_BUDGET_MS OR until every task has settled.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, VISIBLE_BUDGET_MS);
    let settledCount = 0;
    for (const t of tasks) {
      t.promise.then(() => {
        settledCount++;
        if (settledCount === tasks.length) { clearTimeout(timer); resolve(); }
      }).catch(() => {
        settledCount++;
        if (settledCount === tasks.length) { clearTimeout(timer); resolve(); }
      });
    }
  });

  // Ingest whatever came back in the visible window. Winners are tasks
  // that have `settled=true` by now; losers keep running in background.
  const visibleRaws: RawMention[] = [];
  const losers: Promise<RawMention[] | null>[] = [];
  for (const t of tasks) {
    if (t.settled) {
      if (t.value && t.value.length > 0) {
        stats.sources_hit.push(t.name);
        visibleRaws.push(...t.value);
      }
    } else {
      losers.push(t.promise);
    }
  }
  if (visibleRaws.length > 0) {
    const ingest = await ingestRawMentions(visibleRaws);
    stats.mentions_inserted = ingest.inserted;
    if (ingest.affected_e164s.has(e164)) {
      try {
        await rescoreNumber(e164);
      } catch { /* ignored — next rescorer tick catches it */ }
    }
  }

  stats.duration_ms = Math.round(performance.now() - start);
  stats.timed_out = losers.length > 0;

  // Fire-and-forget: finish the slow sources in the background. When
  // they resolve we ingest + rescore the row so the next caller sees
  // the fresher data.
  if (losers.length > 0) {
    void finalizeInBackground(e164, losers, lockKey);
  } else {
    // All sources finished in the visible window — release the lock
    // immediately so a retrigger isn't blocked.
    void releaseLock(lockKey);
  }

  return stats;
}

async function finalizeInBackground(
  e164: string,
  pending: Promise<RawMention[] | null>[],
  lockKey: string,
): Promise<void> {
  try {
    const settled = await Promise.allSettled(pending);
    const raws: RawMention[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value && r.value.length > 0) {
        raws.push(...r.value);
      }
    }
    if (raws.length > 0) {
      const ingest = await ingestRawMentions(raws);
      if (ingest.affected_e164s.has(e164)) {
        try { await rescoreNumber(e164); } catch { /* ignore */ }
      }
    }
  } finally {
    await releaseLock(lockKey);
  }
}

async function tryAcquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  try {
    // Atomic SET NX EX — prevents the GET-then-SET race where two Fly
    // instances both see the key absent and both acquire. verdict.ts
    // uses the same primitive for the same reason.
    return await cacheSetNX(key, 'inflight', ttlSeconds);
  } catch {
    // If Redis is down we fall through without a lock — better to crawl
    // twice than to block altogether.
    return true;
  }
}

async function releaseLock(key: string): Promise<void> {
  try {
    // DEL the key, don't tombstone with an empty string. A tombstone
    // with 1s TTL was re-read as "lock held" by the next caller,
    // blocking legitimate retries for up to a second after release.
    await cacheInvalidate(key);
  } catch {
    // best effort; the crawl's own TTL is the backstop.
  }
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        console.error(`liveCrawl[${label}] error`, (err as Error).message);
        resolve(null);
      },
    );
  });
}

// -------- FCC: direct caller_id_number filter --------

interface FccRow {
  id?: string;
  caller_id_number?: string;
  issue?: string;
  issue_type?: string;
  issue_date?: string;
  date_created?: string;
  method?: string;
  type_of_call_or_messge?: string;
}

async function liveFcc(e164: string): Promise<RawMention[]> {
  // FCC stores caller_id_number as a 10-digit dashed string like "864-410-0954"
  // or "8644100954". Query both to be safe.
  const ten = e164.replace(/^\+1/, '').replace(/\D/g, '');
  if (ten.length !== 10) return [];
  // Defense-in-depth: even though `ten` is guaranteed digit-only by the
  // checks above, reject anything that isn't pure digits before we
  // interpolate it into SoQL. Any future refactor that loosens the
  // validation would otherwise silently create an injection hole.
  if (!/^\d{10}$/.test(ten)) return [];
  const dashed = `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
  const params = new URLSearchParams({
    $limit: '20',
    $order: 'date_created DESC',
    $where: `caller_id_number IN ('${dashed}', '${ten}')`,
  });
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.FCC_APP_TOKEN) headers['X-App-Token'] = config.FCC_APP_TOKEN;

  const res = await fetch(`${FCC_ENDPOINT}?${params}`, {
    headers,
    signal: AbortSignal.timeout(BACKGROUND_BUDGET_MS),
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as FccRow[];
  return rows
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
}

function buildFccSnippet(r: FccRow): string {
  const parts: string[] = [`FCC complaint for caller ${r.caller_id_number ?? 'unknown'}`];
  if (r.issue) parts.push(`issue: ${r.issue}`);
  if (r.issue_type) parts.push(`issue_type: ${r.issue_type}`);
  if (r.method) parts.push(`method: ${r.method}`);
  if (r.type_of_call_or_messge) parts.push(`type: ${r.type_of_call_or_messge}`);
  const whenRaw = r.issue_date ?? r.date_created;
  if (whenRaw) parts.push(`date: ${whenRaw}`);
  parts.push('This number was reported to the FCC as unwanted, robocall, or scam-related.');
  return parts.join(' · ');
}

// -------- BBB: scan the recent-50 list for this number --------

async function liveBbbRecent(e164: string): Promise<RawMention[]> {
  // We can't search BBB server-side (client-side only), so we fetch the
  // recent feed and scan it. Low marginal cost on top of the scheduled
  // crawler's work, but catches any number that shows up there.
  const res = await fetch(BBB_LIST_URL, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(BACKGROUND_BUDGET_MS),
  });
  if (!res.ok) return [];
  const html = await res.text();
  const ten = e164.replace(/^\+1/, '').replace(/\D/g, '');
  const dashed = `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
  const paren = `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  const anyHit = html.includes(ten) || html.includes(dashed) || html.includes(paren);
  if (!anyHit) return [];
  // Pull the scam IDs from the list page and build one RawMention that
  // points at the list URL — the scheduled BBB crawler will fetch the
  // per-report detail if the number matters.
  const ids = [...new Set([...html.matchAll(/\/scamtracker\/lookupscam\/(\d+)/g)].map((m) => m[1]))];
  if (ids.length === 0) return [];
  return [
    {
      source: 'bbb_scamtracker',
      source_ref: `live-${e164}-${Date.now()}`,
      url: BBB_LIST_URL,
      snippet: `BBB Scam Tracker live hit for ${e164} · recent report IDs nearby: ${ids.slice(0, 5).join(', ')}`,
      observed_at: new Date(),
    },
  ];
}

// -------- YouTube: search.list q=<number> --------

interface YtSearchItem {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    channelTitle?: string;
  };
}

async function liveYouTubeSearch(e164: string): Promise<RawMention[]> {
  if (!config.YOUTUBE_API_KEY) return [];
  const ten = e164.replace(/^\+1/, '').replace(/\D/g, '');
  const dashed = `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
  const params = new URLSearchParams({
    part: 'snippet',
    q: dashed,
    type: 'video',
    maxResults: '5',
    key: config.YOUTUBE_API_KEY,
  });
  const res = await fetch(`${YT_BASE}/search?${params}`, {
    signal: AbortSignal.timeout(BACKGROUND_BUDGET_MS),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { items?: YtSearchItem[] };
  const items = body.items ?? [];
  return items
    .filter((it) => it.id?.videoId)
    .map((it) => ({
      source: 'youtube_video',
      source_ref: it.id!.videoId!,
      url: `https://www.youtube.com/watch?v=${it.id!.videoId}`,
      snippet: `[YouTube search hit for ${e164}] ${it.snippet?.channelTitle ?? ''}: ${it.snippet?.title ?? ''}\n\n${it.snippet?.description ?? ''}`.slice(0, 4000),
      observed_at: it.snippet?.publishedAt ? new Date(it.snippet.publishedAt) : new Date(),
    }));
}
