import { config } from '../config.js';
import { ingestRawMentions } from './ingest.js';
import { rescoreNumber } from './rescore.js';
import type { CrawlResult, Crawler, RawMention } from './types.js';

// YouTube Data API v3. We poll scam-alert channels' recent uploads via the
// uploads-playlist trick (swap channel prefix UC→UU to get the channel's
// auto-generated uploads playlist) and extract phone numbers from video
// titles and descriptions, which is where scam-alert channels actually put
// scammer contact info. Cost: 1 unit per channel per run. 6 channels hourly
// = 144 units/day, well under the 10k free quota.
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

const SCAM_ALERT_CHANNELS: { id: string; name: string }[] = [
  { id: 'UCgmhcAFfPVx_AMSf89HGh_A', name: 'Kitboga' },
  { id: 'UCUZb_t6bIRSwyUeEaU6e5xQ', name: 'Scammer Payback' },
  { id: 'UC4nbIeL4SVgoy6SXcxtWcHg', name: 'Jim Browning' },
  { id: 'UCM_otIhJLheY9WYuMQiDNZQ', name: 'Pleasant Green' },
  { id: 'UC6gGnQ2nJTsYJWY8vBRl75w', name: 'Scammer Revolts' },
  { id: 'UC3rHY_GZLvQI12fWqGxDcSw', name: 'Behind the Scams' },
];

const VIDEOS_PER_CHANNEL = 50;

interface YtPlaylistItem {
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    resourceId?: { videoId?: string };
  };
}

interface YtListResponse<T> {
  items?: T[];
  error?: { code?: number; message?: string };
}

export class YouTubeCrawler implements Crawler {
  readonly name = 'youtube';
  readonly cronExpr = '35 * * * *'; // once an hour, :35 past

  get enabled(): boolean {
    return !!config.YOUTUBE_API_KEY;
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

    if (!config.YOUTUBE_API_KEY) {
      result.duration_ms = Math.round(performance.now() - start);
      return result;
    }

    const raws: RawMention[] = [];
    for (const ch of SCAM_ALERT_CHANNELS) {
      try {
        const items = await fetchChannelUploads(ch.id, config.YOUTUBE_API_KEY);
        result.fetched += items.length;
        for (const it of items) {
          const title = it.snippet?.title ?? '';
          const description = it.snippet?.description ?? '';
          const videoId = it.snippet?.resourceId?.videoId;
          const publishedAt = it.snippet?.publishedAt;
          if (!videoId) continue;
          raws.push({
            source: 'youtube_video',
            source_ref: videoId,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            snippet: `[${ch.name}] ${title}\n\n${description}`.slice(0, 4000),
            observed_at: publishedAt ? new Date(publishedAt) : new Date(),
          });
        }
      } catch (err) {
        console.error(`youtube channel ${ch.id} error`, (err as Error).message);
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
}

// UC→UU trick: a channel's auto-generated uploads playlist ID is the channel
// ID with the first two characters swapped from "UC" to "UU". Documented
// behavior since API v3 launched, still current as of 2026.
function channelIdToUploadsPlaylistId(channelId: string): string {
  if (!channelId.startsWith('UC')) return channelId;
  return `UU${channelId.slice(2)}`;
}

async function fetchChannelUploads(
  channelId: string,
  apiKey: string,
): Promise<YtPlaylistItem[]> {
  const playlistId = channelIdToUploadsPlaylistId(channelId);
  const params = new URLSearchParams({
    part: 'snippet',
    playlistId,
    maxResults: String(VIDEOS_PER_CHANNEL),
    key: apiKey,
  });
  const res = await fetch(`${YT_BASE}/playlistItems?${params}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`youtube http ${res.status} ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as YtListResponse<YtPlaylistItem>;
  if (body.error) throw new Error(`youtube api ${body.error.code}: ${body.error.message}`);
  return body.items ?? [];
}
