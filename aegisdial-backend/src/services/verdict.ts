import { query, withTx } from '../lib/db.js';
import {
  cacheGet,
  cacheSet,
  cacheSetNX,
  cacheInvalidate,
  verdictCacheKey,
} from '../lib/cache.js';
import { normalizeE164 } from '../lib/phone.js';
import { computeScore, SCORE_VERSION } from './score.js';
import { twilioLookup } from './enrich.js';
import { refineWithLLM } from './llm.js';
import { lookupHighSpoofTarget } from './highSpoofTargets.js';
import { liveCrawlUnknown } from './liveCrawl.js';
import { lookupPhone } from './phoneLookup.js';
import type {
  BusinessMatch,
  EvidenceItem,
  NumberSignals,
  VerdictResponse,
} from '../types.js';

const CACHE_TTL_SECONDS = 60 * 60;

// ---------------------------------------------------------------------------
// Single-flight lock for the verdict hot path.
//
// Problem: a popular scam number can trigger 10k+ concurrent verdict requests.
// Without coordination, each request performs the full (expensive) compute
// path — DB reads, Twilio lookup, live crawl, LLM refinement — producing a
// thundering herd.
//
// Design: a short Redis sentinel key (`verdict:lock:<e164>`) indicates that
// some other request is currently computing. Followers poll the verdict
// cache key for up to ~1500ms at 50ms intervals; when the leader populates
// the cache, followers return that result for free. If the poll times out
// (leader is slow or crashed), followers fall through and compute anyway —
// correctness over liveness.
//
// Why Redis-down falls through: a duplicate verdict compute is merely
// expensive, not incorrect. Blocking a real user's call-screening verdict
// on a transient Redis outage would be a much worse failure mode. So every
// lock op is wrapped in try/catch and treated as "no lock held" on error.
// Operability > correctness here.
//
// Lock is actively DELETED (not tombstoned) on release so followers
// starting immediately after see no lock and can acquire cleanly. The
// 10s TTL is the backstop if the leader crashes before deleting.
// ---------------------------------------------------------------------------
const LOCK_TTL_SECONDS = 10;
const POLL_INTERVAL_MS = 50;
const POLL_MAX_MS = 1500;

function verdictLockKey(e164: string): string {
  return `verdict:lock:${e164}`;
}

async function tryAcquireLock(e164: string): Promise<boolean> {
  try {
    // Atomic SET NX EX — prevents the GET-then-SET race between
    // multiple Fly instances. If the key already exists, the caller
    // is a follower and should poll the cache.
    return await cacheSetNX(verdictLockKey(e164), 1, LOCK_TTL_SECONDS);
  } catch {
    // Redis hiccup — proceed without a lock rather than blocking the user.
    return true;
  }
}

async function releaseLock(e164: string): Promise<void> {
  try {
    // DEL the lock key — no tombstone. Next follower that sees the
    // absence immediately becomes the next leader. This is the
    // intended "lock released" semantic; writing an empty string
    // with 1s TTL caused tombstone-poisoning where the next acquire
    // saw the empty value and treated it as "lock held".
    await cacheInvalidate(verdictLockKey(e164));
  } catch {
    // Best-effort; the 10s lock TTL is our backstop if this fails.
  }
}

async function pollForCachedVerdict(
  cacheKey: string,
): Promise<VerdictResponse | null> {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const cached = await cacheGet<VerdictResponse>(cacheKey);
      if (cached) return cached;
    } catch {
      // Redis flake — stop polling and let caller compute.
      return null;
    }
  }
  return null;
}

interface NumberRow {
  e164: string;
  first_seen: Date | null;
  last_seen: Date | null;
  mention_count_all: number;
  mention_count_30d: number;
  sources: Record<string, number> | null;
  sentiment_neg_ratio: number;
  stir_shaken_attestation: 'A' | 'B' | 'C' | null;
  line_type: NumberSignals['line_type'];
  carrier: string | null;
  number_age_days: number | null;
  business_match: BusinessMatch | null;
  spoof_reports_30d: number;
  trust_score: number | null;
  verdict: string | null;
  summary: string | null;
  score_computed_at: Date | null;
  score_version: number | null;
}

interface RecentMentionRow {
  source: string;
  url: string | null;
  snippet: string | null;
  created_at: Date;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  weight: number;
}

export async function getVerdict(
  rawNumber: string,
  country: string = 'US',
): Promise<VerdictResponse> {
  const start = performance.now();

  const e164 = normalizeE164(rawNumber, country);
  if (!e164) {
    throw new VerdictError('invalid_phone_number', 400);
  }

  const cacheKey = verdictCacheKey(e164);
  const cached = await cacheGet<VerdictResponse>(cacheKey);
  if (cached) {
    return {
      ...cached,
      latency_ms: Math.round(performance.now() - start),
      cached: true,
    };
  }

  // Single-flight: if another request is already computing this number,
  // briefly wait for their result instead of firing the expensive path
  // ourselves. See helper block at top of file for design rationale.
  const acquired = await tryAcquireLock(e164);
  if (!acquired) {
    const polled = await pollForCachedVerdict(cacheKey);
    if (polled) {
      return {
        ...polled,
        latency_ms: Math.round(performance.now() - start),
        cached: true,
      };
    }
    // Leader is slow or crashed — fall through and compute ourselves.
  }

  try {
    return await computeVerdict(e164, cacheKey, start);
  } finally {
    if (acquired) {
      await releaseLock(e164);
    }
  }
}

async function computeVerdict(
  e164: string,
  cacheKey: string,
  start: number,
): Promise<VerdictResponse> {
  let row = await fetchOrCreateNumberRow(e164);

  // Unknown number: fan out to external sources in parallel. The crawl
  // has a SHORT visible budget (~700ms) and continues in the background
  // past that so the next user hits a warm cache. Evidence + public-
  // info lookups fire in parallel with the crawl so they're free
  // latency under the crawl's wall-clock.
  const isUnknown = row.mention_count_all === 0 && !row.business_match;
  const [, publicInfo, evidenceFirst] = await Promise.all([
    isUnknown ? liveCrawlUnknown(e164) : Promise.resolve(null),
    lookupPhone(e164),
    fetchRecentEvidence(e164, 10),
  ]);
  let evidence = evidenceFirst;
  if (isUnknown) {
    row = await fetchOrCreateNumberRow(e164);
    // Re-fetch evidence only if the crawl actually ingested something
    // new (mention_count_all bumped from 0). Avoids a wasted RTT on
    // the common case where the crawl yielded nothing.
    if (row.mention_count_all > 0) {
      evidence = await fetchRecentEvidence(e164, 10);
    }
  }

  const signals: NumberSignals = {
    mention_count_30d: row.mention_count_30d,
    mention_count_all: row.mention_count_all,
    negative_sentiment_ratio: row.sentiment_neg_ratio,
    complaint_sources: row.sources ? Object.keys(row.sources).length : 0,
    first_seen: row.first_seen ? row.first_seen.toISOString() : null,
    last_seen: row.last_seen ? row.last_seen.toISOString() : null,
    stir_shaken_attestation: row.stir_shaken_attestation,
    carrier: row.carrier,
    line_type: row.line_type ?? 'unknown',
    number_age_days: row.number_age_days,
    business_match: row.business_match,
    spoof_reports_30d: row.spoof_reports_30d,
  };

  const base = computeScore({ e164, signals });

  let trust_score = base.trust_score;
  let verdict = base.verdict;
  let summary = base.summary;
  let user_message = base.user_message;
  let display_color = base.display_color;
  let recommended_action = base.recommended_action;

  const inAmbiguousBand = trust_score >= 30 && trust_score <= 70;
  if (inAmbiguousBand || signals.business_match) {
    const refined = await refineWithLLM({
      e164,
      signals,
      evidence,
      base_score: trust_score,
      base_verdict: verdict,
    });
    if (refined) {
      const delta = clamp(refined.adjusted_score - trust_score, -15, 15);
      trust_score = clamp(trust_score + delta, 0, 100);
      summary = refined.summary || summary;
    }
  }

  const freshness_seconds = row.score_computed_at
    ? Math.round((Date.now() - row.score_computed_at.getTime()) / 1000)
    : null;

  await persistScore(e164, trust_score, verdict, summary);

  const response: VerdictResponse = {
    number: e164,
    trust_score,
    verdict,
    summary,
    user_message,
    display_color,
    recommended_action,
    evidence,
    signals,
    public_info: publicInfo
      ? {
          owner_name: publicInfo.owner_name,
          line_type: publicInfo.line_type,
          carrier_name: publicInfo.carrier_name,
          country_code: publicInfo.country_code,
          city: publicInfo.city,
          state_code: publicInfo.state_code,
          is_spoofable: publicInfo.is_spoofable,
          is_likely_burner: publicInfo.is_likely_burner,
          is_overseas: publicInfo.is_overseas,
          burner_service: publicInfo.burner_service,
          spam_risk_score: publicInfo.spam_risk_score,
          sources: publicInfo.sources,
        }
      : null,
    latency_ms: Math.round(performance.now() - start),
    freshness_seconds,
    score_version: SCORE_VERSION,
    cached: false,
  };

  await cacheSet(cacheKey, response, CACHE_TTL_SECONDS);

  return response;
}

async function fetchOrCreateNumberRow(e164: string): Promise<NumberRow> {
  const existing = await query<NumberRow>(
    `SELECT
       e164, first_seen, last_seen, mention_count_all, mention_count_30d,
       sources, sentiment_neg_ratio, stir_shaken_attestation, line_type,
       carrier, number_age_days, business_match, spoof_reports_30d,
       trust_score, verdict, summary, score_computed_at, score_version
     FROM numbers WHERE e164 = $1`,
    [e164],
  );
  if (existing.rows.length > 0) {
    return hydrateNumberRow(existing.rows[0]!);
  }

  const enriched = await twilioLookup(e164);
  const highSpoofTarget = lookupHighSpoofTarget(e164);
  const businessMatch: BusinessMatch | null = highSpoofTarget
    ? {
        name: highSpoofTarget.name,
        category: highSpoofTarget.category,
        verified: true,
        source: 'high_spoof_targets_registry',
      }
    : null;

  const inserted = await query<NumberRow>(
    `INSERT INTO numbers (
       e164, line_type, carrier, stir_shaken_attestation, business_match
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (e164) DO UPDATE SET line_type = EXCLUDED.line_type
     RETURNING e164, first_seen, last_seen, mention_count_all, mention_count_30d,
       sources, sentiment_neg_ratio, stir_shaken_attestation, line_type,
       carrier, number_age_days, business_match, spoof_reports_30d,
       trust_score, verdict, summary, score_computed_at, score_version`,
    [
      e164,
      enriched.line_type,
      enriched.carrier,
      enriched.attestation,
      businessMatch ? JSON.stringify(businessMatch) : null,
    ],
  );
  return hydrateNumberRow(inserted.rows[0]!);
}

function hydrateNumberRow(raw: NumberRow): NumberRow {
  return {
    ...raw,
    mention_count_all: Number(raw.mention_count_all ?? 0),
    mention_count_30d: Number(raw.mention_count_30d ?? 0),
    sentiment_neg_ratio: Number(raw.sentiment_neg_ratio ?? 0),
    spoof_reports_30d: Number(raw.spoof_reports_30d ?? 0),
  };
}

async function fetchRecentEvidence(
  e164: string,
  limit: number,
): Promise<EvidenceItem[]> {
  const result = await query<RecentMentionRow>(
    `SELECT source, url, snippet, created_at, sentiment, weight
     FROM mentions
     WHERE e164 = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [e164, limit],
  );
  return result.rows.map((r) => ({
    source: r.source,
    url: r.url ?? undefined,
    snippet: r.snippet ?? undefined,
    date: r.created_at.toISOString(),
    sentiment: r.sentiment ?? undefined,
    weight: Number(r.weight),
  }));
}

async function persistScore(
  e164: string,
  trust_score: number,
  verdict: string,
  summary: string,
): Promise<void> {
  await query(
    `UPDATE numbers
       SET trust_score = $2,
           verdict = $3,
           summary = $4,
           score_computed_at = NOW(),
           score_version = $5
     WHERE e164 = $1`,
    [e164, trust_score, verdict, summary, SCORE_VERSION],
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export async function recordReport(params: {
  e164: string;
  category: string;
  note?: string;
  device_id?: string;
}): Promise<void> {
  await withTx(async (client) => {
    await client.query(
      `INSERT INTO reports (e164, category, note, device_id)
       VALUES ($1, $2, $3, $4)`,
      [params.e164, params.category, params.note ?? null, params.device_id ?? null],
    );
    await client.query(
      `INSERT INTO numbers (e164, mention_count_all, mention_count_30d, spoof_reports_30d)
       VALUES ($1, 1, 1, CASE WHEN $2 IN ('scam','phishing','impersonation') THEN 1 ELSE 0 END)
       ON CONFLICT (e164) DO UPDATE SET
         mention_count_all = numbers.mention_count_all + 1,
         mention_count_30d = numbers.mention_count_30d + 1,
         spoof_reports_30d = numbers.spoof_reports_30d + CASE WHEN $2 IN ('scam','phishing','impersonation') THEN 1 ELSE 0 END,
         last_seen = NOW()`,
      [params.e164, params.category],
    );
  });
}

export async function recordFeedback(params: {
  e164: string;
  user_verdict: string;
  device_id?: string;
}): Promise<void> {
  await query(
    `INSERT INTO feedback (e164, user_verdict, device_id)
     VALUES ($1, $2, $3)`,
    [params.e164, params.user_verdict, params.device_id ?? null],
  );
}

export class VerdictError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}
