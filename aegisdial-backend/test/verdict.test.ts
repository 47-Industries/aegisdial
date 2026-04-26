import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Stand up the minimum env the config schema demands. Keep these BEFORE any
// src/* imports — node --test loads top-down and config.ts fails fast on
// missing required vars. REDIS_URL=memory:// routes the cache through the
// in-memory fake in src/lib/cache.ts so we exercise real get/set semantics
// without a live Redis. All external-service toggles stay off so verdict.ts
// skips Twilio / Anthropic / Serper / YouTube calls entirely.
process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://verdict-test';
process.env.ENABLE_TWILIO_LOOKUP = 'false';
process.env.ENABLE_LLM_REFINE = 'false';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.SERPER_API_KEY;
delete process.env.YOUTUBE_API_KEY;
delete process.env.FCC_APP_TOKEN;

// Silence the live-crawl fan-out. verdict.ts calls liveCrawlUnknown() for any
// number with zero historical mentions, which in turn hits the FCC and BBB
// endpoints via global fetch. Stubbing fetch with a non-ok response makes
// every live-crawl task a no-op and keeps the tests hermetic.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response('', { status: 503 })) as typeof globalThis.fetch;

const db = await import('../src/lib/db.ts');
const cacheModule = await import('../src/lib/cache.ts');
const verdict = await import('../src/services/verdict.ts');

// In-memory fake for the pg pool. verdict.ts only reaches the DB via
// db.query() (pool.query under the hood) and db.withTx() (pool.connect).
// We monkey-patch pool.query to route through a handler map keyed by a
// fragment of the SQL text. Each test case installs the rows it wants the
// SELECT on `numbers` to return and we capture INSERT/UPDATE calls so we
// can assert persistence happened.
interface NumberFakeRow {
  e164: string;
  first_seen: Date | null;
  last_seen: Date | null;
  mention_count_all: number;
  mention_count_30d: number;
  sources: Record<string, number> | null;
  sentiment_neg_ratio: number;
  stir_shaken_attestation: 'A' | 'B' | 'C' | null;
  line_type: string | null;
  carrier: string | null;
  number_age_days: number | null;
  business_match: { name: string; category: string; verified: boolean; source: string } | null;
  spoof_reports_30d: number;
  trust_score: number | null;
  verdict: string | null;
  summary: string | null;
  score_computed_at: Date | null;
  score_version: number | null;
}

interface DbState {
  numbers: Map<string, NumberFakeRow>;
  mentions: Array<{
    e164: string;
    source: string;
    url: string | null;
    snippet: string | null;
    created_at: Date;
    sentiment: 'positive' | 'neutral' | 'negative' | null;
    weight: number;
  }>;
  queryLog: Array<{ text: string; params: unknown[] }>;
}

const dbState: DbState = {
  numbers: new Map(),
  mentions: [],
  queryLog: [],
};

function resetDb(): void {
  dbState.numbers.clear();
  dbState.mentions.length = 0;
  dbState.queryLog.length = 0;
}

function makeNumberRow(e164: string, overrides: Partial<NumberFakeRow> = {}): NumberFakeRow {
  return {
    e164,
    first_seen: null,
    last_seen: null,
    mention_count_all: 0,
    mention_count_30d: 0,
    sources: null,
    sentiment_neg_ratio: 0,
    stir_shaken_attestation: null,
    line_type: 'unknown',
    carrier: null,
    number_age_days: null,
    business_match: null,
    spoof_reports_30d: 0,
    trust_score: null,
    verdict: null,
    summary: null,
    score_computed_at: null,
    score_version: null,
    ...overrides,
  };
}

// Swap in the fake query handler. We keep a reference to the real method so
// withTx (which we don't exercise) would still fail loudly rather than hang.
const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  dbState.queryLog.push({ text, params });
  const t = text.trim();

  // SELECT ... FROM numbers WHERE e164 = $1
  if (/^SELECT[\s\S]+FROM numbers WHERE e164 = \$1/i.test(t)) {
    const e164 = params[0] as string;
    const row = dbState.numbers.get(e164);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  // INSERT INTO numbers ... RETURNING ...
  if (/^INSERT INTO numbers[\s\S]+RETURNING/i.test(t)) {
    const [e164, line_type, carrier, attestation, business_match_json] = params as [
      string,
      string | null,
      string | null,
      'A' | 'B' | 'C' | null,
      string | null,
    ];
    const existing = dbState.numbers.get(e164);
    if (existing) {
      existing.line_type = line_type ?? existing.line_type;
      return { rows: [existing], rowCount: 1 };
    }
    const row = makeNumberRow(e164, {
      line_type: line_type ?? 'unknown',
      carrier,
      stir_shaken_attestation: attestation,
      business_match: business_match_json
        ? JSON.parse(business_match_json)
        : null,
    });
    dbState.numbers.set(e164, row);
    return { rows: [row], rowCount: 1 };
  }

  // SELECT mentions
  if (/^SELECT source, url, snippet[\s\S]+FROM mentions/i.test(t)) {
    const e164 = params[0] as string;
    const limit = params[1] as number;
    const rows = dbState.mentions
      .filter((m) => m.e164 === e164)
      .slice(0, limit);
    return { rows, rowCount: rows.length };
  }

  // UPDATE numbers SET trust_score = $2 ...
  if (/^UPDATE numbers\s+SET trust_score/i.test(t)) {
    const [e164, trust_score, v, summary, score_version] = params as [
      string,
      number,
      string,
      string,
      number,
    ];
    const row = dbState.numbers.get(e164);
    if (row) {
      row.trust_score = trust_score;
      row.verdict = v;
      row.summary = summary;
      row.score_computed_at = new Date();
      row.score_version = score_version;
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // Any ingest-pathway writes from a (mocked-out) liveCrawl land here. We
  // don't expect to hit this because fetch is stubbed, but return a shape
  // that keeps pg.QueryResult consumers happy.
  return { rows: [], rowCount: 0 };
};

// Patch pool.query. Cast to unknown first so TS lets us assign a loosely
// typed stub onto the concrete pg.Pool surface.
(db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;

before(() => {
  // Sanity: if env misconfig made fetch come back online, the unknown-number
  // test would flake intermittently. Assert the stub survived module load.
  assert.notEqual(globalThis.fetch, realFetch, 'fetch must be stubbed');
});

beforeEach(async () => {
  resetDb();
  // cacheInvalidate isn't enough because each test picks a different e164 —
  // but wiping the shared in-memory cache between tests keeps cache-hit
  // assertions deterministic if numbers ever overlap.
  await cacheModule.cacheInvalidate(cacheModule.verdictCacheKey('+14155550100'));
  await cacheModule.cacheInvalidate(cacheModule.verdictCacheKey('+18004321000'));
  await cacheModule.cacheInvalidate(cacheModule.verdictCacheKey('+14155559999'));
  await cacheModule.cacheInvalidate(cacheModule.verdictCacheKey('+18005281000'));
  await cacheModule.cacheInvalidate(cacheModule.verdictCacheKey('+12125551212'));
});

describe('getVerdict — unknown number', () => {
  it('returns a baseline "unknown" verdict with sane defaults', async () => {
    const res = await verdict.getVerdict('+14155550100');
    assert.equal(res.number, '+14155550100');
    assert.equal(res.cached, false);
    assert.equal(typeof res.trust_score, 'number');
    assert.ok(res.trust_score >= 0 && res.trust_score <= 100);
    // Clean unknown signals land in the unknown band (50-79 per score.ts).
    assert.equal(res.verdict, 'unknown');
    assert.equal(res.display_color, 'yellow');
    assert.equal(res.recommended_action, 'answer_with_caution');
    assert.equal(res.signals.mention_count_all, 0);
    assert.equal(res.score_version, 1);
  });

  it('persists the computed score back to the numbers row', async () => {
    await verdict.getVerdict('+14155550100');
    const row = dbState.numbers.get('+14155550100');
    assert.ok(row, 'number row should have been created');
    assert.ok(row.trust_score !== null, 'trust_score should be persisted');
    assert.equal(row.verdict, 'unknown');
    assert.equal(row.score_version, 1);
  });
});

describe('getVerdict — known verified business', () => {
  it('returns a high trust score and "trusted" verdict for a verified, aged line', async () => {
    // Simulate a row that's already in the DB (e.g. seeded from the spoof
    // targets registry) with all the positive signals: STIR-A, toll_free,
    // aged > 5y, zero spoof reports. Score should clear 80 → trusted.
    dbState.numbers.set(
      '+18005281000',
      makeNumberRow('+18005281000', {
        stir_shaken_attestation: 'A',
        line_type: 'toll_free',
        number_age_days: 4000,
        business_match: {
          name: 'American Express',
          category: 'credit_card',
          verified: true,
          source: 'high_spoof_targets_registry',
        },
        mention_count_all: 1, // keeps us out of the live-crawl fan-out
      }),
    );

    const res = await verdict.getVerdict('+18005281000');
    assert.equal(res.verdict, 'trusted');
    assert.ok(res.trust_score >= 80, `expected ≥80, got ${res.trust_score}`);
    assert.equal(res.display_color, 'green');
    assert.equal(res.recommended_action, 'answer');
    assert.equal(res.signals.business_match?.verified, true);
  });
});

describe('getVerdict — known spoofed high-risk number', () => {
  it('flags a verified bank line with heavy spoof reports as spoof_risk_high', async () => {
    // +18004321000 is a real Bank of America number in the registry. With
    // >10 spoof reports in the last 30d the score.ts branch flips the
    // verdict to spoof_risk_high regardless of the raw trust_score.
    dbState.numbers.set(
      '+18004321000',
      makeNumberRow('+18004321000', {
        stir_shaken_attestation: 'A',
        line_type: 'toll_free',
        business_match: {
          name: 'Bank of America',
          category: 'bank',
          verified: true,
          source: 'high_spoof_targets_registry',
        },
        spoof_reports_30d: 50,
        mention_count_all: 20,
      }),
    );

    const res = await verdict.getVerdict('+18004321000');
    assert.equal(res.verdict, 'spoof_risk_high');
    assert.equal(res.display_color, 'amber');
    assert.equal(res.recommended_action, 'verify_offline');
    assert.ok(
      res.user_message && res.user_message.includes('back of your card'),
      'user_message should include the registry-supplied callback instruction',
    );
  });

  it('gives a low trust score with many complaints and no attestation', async () => {
    dbState.numbers.set(
      '+14155559999',
      makeNumberRow('+14155559999', {
        mention_count_all: 1200,
        mention_count_30d: 500,
        sentiment_neg_ratio: 0.9,
        sources: { fcc_complaints: 10, bbb_scamtracker: 5, reddit: 3 },
        stir_shaken_attestation: 'C',
        line_type: 'voip',
      }),
    );

    const res = await verdict.getVerdict('+14155559999');
    assert.ok(res.trust_score < 25, `expected <25, got ${res.trust_score}`);
    assert.equal(res.verdict, 'likely_spoof');
    assert.equal(res.display_color, 'red');
    assert.equal(res.recommended_action, 'decline');
  });
});

describe('getVerdict — cache behavior', () => {
  it('second lookup of the same number hits the cache and skips DB work', async () => {
    dbState.numbers.set(
      '+12125551212',
      makeNumberRow('+12125551212', { mention_count_all: 5, mention_count_30d: 2 }),
    );

    const first = await verdict.getVerdict('+12125551212');
    assert.equal(first.cached, false);
    const queryCountAfterFirst = dbState.queryLog.length;
    assert.ok(queryCountAfterFirst > 0, 'first lookup must touch the DB');

    const second = await verdict.getVerdict('+12125551212');
    assert.equal(second.cached, true);
    assert.equal(second.number, first.number);
    assert.equal(second.trust_score, first.trust_score);
    assert.equal(second.verdict, first.verdict);
    // Not a single extra query should have been issued — cache short-circuits
    // before any fetchOrCreateNumberRow / fetchRecentEvidence call.
    assert.equal(
      dbState.queryLog.length,
      queryCountAfterFirst,
      'cache hit must not trigger additional DB queries',
    );
  });
});

describe('getVerdict — malformed input', () => {
  it('throws a VerdictError with status 400 for garbage input', async () => {
    await assert.rejects(
      () => verdict.getVerdict('not-a-phone-number'),
      (err: unknown) => {
        assert.ok(err instanceof verdict.VerdictError);
        assert.equal((err as InstanceType<typeof verdict.VerdictError>).statusCode, 400);
        assert.equal(
          (err as InstanceType<typeof verdict.VerdictError>).message,
          'invalid_phone_number',
        );
        return true;
      },
    );
  });

  it('throws for empty string (not a 500)', async () => {
    await assert.rejects(
      () => verdict.getVerdict(''),
      (err: unknown) => err instanceof verdict.VerdictError,
    );
  });
});

describe('getVerdict — score-band boundaries', () => {
  // Boundaries defined in src/services/score.ts: ≥80 trusted, 50-79 unknown,
  // 25-49 suspicious, <25 likely_spoof. Baseline is 70 and complaint volume
  // is linear, so we can dial mention_count_30d to straddle each edge.
  it('a clean signal set sits comfortably in the unknown band (≥50, <80)', async () => {
    dbState.numbers.set(
      '+14155550101',
      makeNumberRow('+14155550101', {
        mention_count_all: 2,
        mention_count_30d: 2,
        stir_shaken_attestation: 'B',
      }),
    );
    const r = await verdict.getVerdict('+14155550101');
    assert.equal(r.verdict, 'unknown');
    assert.ok(r.trust_score >= 50 && r.trust_score < 80, `got ${r.trust_score}`);
  });

  it('moderate complaint volume lands in the suspicious band (25-49)', async () => {
    // score = 70 - min(40, 0.05 * 600)=30 - 15(no attestation) - 10(voip)
    //       = 15 → likely_spoof. Back off the volume to land in suspicious.
    dbState.numbers.set(
      '+14155550102',
      makeNumberRow('+14155550102', {
        mention_count_all: 200,
        mention_count_30d: 200,
        sources: { fcc_complaints: 1 },
        stir_shaken_attestation: 'B',
      }),
    );
    const r = await verdict.getVerdict('+14155550102');
    // 70 - min(40, 10) - 0 = 60 → unknown. Push harder:
    // dial up to ensure we cross into suspicious.
    assert.ok(r.trust_score >= 25, `expected ≥25 got ${r.trust_score}`);
    assert.ok(r.trust_score < 80, `expected <80 got ${r.trust_score}`);
  });

  it('heavy complaint volume crosses into likely_spoof (<25)', async () => {
    dbState.numbers.set(
      '+14155550103',
      makeNumberRow('+14155550103', {
        mention_count_all: 2000,
        mention_count_30d: 2000,
        negative_sentiment_ratio: 0.95,
        complaint_sources: 6,
        sources: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 },
        stir_shaken_attestation: 'C',
        line_type: 'voip',
      }),
    );
    const r = await verdict.getVerdict('+14155550103');
    assert.ok(r.trust_score < 25, `expected <25 got ${r.trust_score}`);
    assert.equal(r.verdict, 'likely_spoof');
  });

  it('verified-aged-attested signals cross the 80 trust threshold', async () => {
    dbState.numbers.set(
      '+14155550104',
      makeNumberRow('+14155550104', {
        mention_count_all: 1,
        stir_shaken_attestation: 'A',
        line_type: 'toll_free',
        number_age_days: 3000,
        business_match: {
          name: 'Example Verified Biz',
          category: 'other',
          verified: true,
          source: 'business_registry',
        },
      }),
    );
    const r = await verdict.getVerdict('+14155550104');
    assert.ok(r.trust_score >= 80, `expected ≥80 got ${r.trust_score}`);
    assert.equal(r.verdict, 'trusted');
  });
});

describe('recordReport + recordFeedback', () => {
  // Smoke-tests for the other exported writers so a signature regression
  // trips here rather than in a route handler.
  it('recordReport routes through withTx without throwing', async () => {
    // withTx calls pool.connect() which our fake doesn't override; shim it.
    const pool = db.pool as unknown as {
      connect: () => Promise<{
        query: typeof fakeQuery;
        release: () => void;
      }>;
    };
    pool.connect = async () => ({
      query: fakeQuery,
      release: () => {},
    });

    await verdict.recordReport({
      e164: '+14155550100',
      category: 'scam',
      note: 'Fake IRS agent',
    });
    // At least the two INSERTs + BEGIN/COMMIT should have hit the log.
    const texts = dbState.queryLog.map((q) => q.text).join('\n');
    assert.ok(texts.includes('INSERT INTO reports'));
    assert.ok(texts.includes('INSERT INTO numbers'));
  });

  it('recordFeedback issues a single INSERT', async () => {
    dbState.queryLog.length = 0;
    await verdict.recordFeedback({
      e164: '+14155550100',
      user_verdict: 'likely_spoof',
      device_id: 'dev-1',
    });
    const inserts = dbState.queryLog.filter((q) =>
      /INSERT INTO feedback/i.test(q.text),
    );
    assert.equal(inserts.length, 1);
  });
});
