import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v3 — Phase 1 route tests.
//
// Covers:
//   /v1/blocks (POST/DELETE/snapshot/explain/retry-attempt/contribution-toggle)
//   /v1/lookup/pre-call-risk
//   /v1/lookup/sources
//   /v1/lookup/cache-snapshot
//
// Same in-memory pool-mock pattern as test/routesAuthBreach.test.ts:
// env vars set BEFORE any src/* imports, dynamic imports, SQL-prefix
// matching fake query function manipulating a local store.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v3-phase1';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v3-phase1-test';
process.env.ALLOW_DEV_BEARER = 'true';
process.env.ENZOIC_MOCK = 'true';
// Both Phase 1 features must be enabled or the routes won't register.
process.env.V3_A1_ENABLED = 'true';
process.env.V3_A2_ENABLED = 'true';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { blocksRoutes } = await import('../src/routes/blocks.ts');
const { lookupRoutes } = await import('../src/routes/lookup.ts');
const { _resetRateLimitForTests } = await import('../src/services/a2RetryRateLimit.ts');

const DEV_USER_ID = '00000000-0000-0000-0000-000000000000';
const SHARED_SECRET = process.env.API_SHARED_SECRET!;
const TEST_E164 = '+14155550199';
const OTHER_E164 = '+14155550100';

// -------------------------------------------------------------------------
// Fake DB state
// -------------------------------------------------------------------------

interface BlockRow {
  id: string;
  user_id: string;
  e164: string;
  reason_code: string;
  source_surface: string;
  blocked_at: Date;
  contributed_to_graph: boolean;
}
interface RetryRow {
  id: string;
  user_id: string;
  e164: string;
  attempted_at: Date;
  notification_sent: boolean;
  notification_grouped: boolean;
}
interface MentionRow {
  e164: string;
  source: string;
  source_ref: string | null;
  url: string | null;
  snippet: string | null;
  sentiment: string | null;
  scam_category: string | null;
  severity: number | null;
  weight: number;
  observed_at: Date | null;
  created_at: Date;
}
interface HotNumberRow {
  e164: string;
  risk_weight: number;
  mention_count: number;
  primary_sources: string[];
  last_recomputed_at: Date;
}
interface PrefsRow {
  user_id: string;
  privacy_level: string;
  cross_user_contribution_enabled: boolean;
  mom_side_stt_enabled: boolean;
  block_retry_notifications_enabled: boolean;
}
interface DbState {
  blocks: BlockRow[];
  retry_attempts: RetryRow[];
  mentions: MentionRow[];
  hot_numbers: HotNumberRow[];
  prefs: Map<string, PrefsRow>;
  uuid_counter: number;
}
const dbState: DbState = {
  blocks: [],
  retry_attempts: [],
  mentions: [],
  hot_numbers: [],
  prefs: new Map(),
  uuid_counter: 0,
};

function resetDb(): void {
  dbState.blocks.length = 0;
  dbState.retry_attempts.length = 0;
  dbState.mentions.length = 0;
  dbState.hot_numbers.length = 0;
  dbState.prefs.clear();
  dbState.uuid_counter = 0;
}

function makeUuid(): string {
  dbState.uuid_counter += 1;
  return `${dbState.uuid_counter.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
}

// -------------------------------------------------------------------------
// SQL-prefix matching fake query
// -------------------------------------------------------------------------

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.trim();

  // ---------- POST /v1/blocks helpers ----------

  // SELECT cross_user_contribution_enabled FROM family_alert_preferences WHERE user_id = $1
  if (/SELECT cross_user_contribution_enabled/i.test(t)) {
    const userId = params[0] as string;
    const row = dbState.prefs.get(userId);
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [{ cross_user_contribution_enabled: row.cross_user_contribution_enabled }],
      rowCount: 1,
    };
  }

  // INSERT INTO user_blocks ... ON CONFLICT (user_id, e164) DO UPDATE
  if (/^INSERT INTO user_blocks/i.test(t)) {
    const [user_id, e164, reason_code, source_surface, contributed_to_graph] = params as [
      string, string, string, string, boolean,
    ];
    const existing = dbState.blocks.find((b) => b.user_id === user_id && b.e164 === e164);
    if (existing) {
      existing.reason_code = reason_code;
      existing.source_surface = source_surface;
      return {
        rows: [{ id: existing.id, blocked_at: existing.blocked_at, was_new: false }],
        rowCount: 1,
      };
    }
    const row: BlockRow = {
      id: makeUuid(),
      user_id,
      e164,
      reason_code,
      source_surface,
      blocked_at: new Date(),
      contributed_to_graph,
    };
    dbState.blocks.push(row);
    return {
      rows: [{ id: row.id, blocked_at: row.blocked_at, was_new: true }],
      rowCount: 1,
    };
  }

  // INSERT INTO mentions (cross-user contribution path)
  if (/^INSERT INTO mentions/i.test(t)) {
    const [e164, source_ref, severity, weight] = params as [string, string, number, number];
    dbState.mentions.push({
      e164,
      source: 'aegisdial_user_block',
      source_ref,
      url: null,
      snippet: null,
      sentiment: 'negative',
      scam_category: null,
      severity,
      weight,
      observed_at: new Date(),
      created_at: new Date(),
    });
    return { rows: [], rowCount: 1 };
  }

  // ---------- DELETE /v1/blocks/:e164 ----------

  if (/^DELETE FROM user_blocks/i.test(t)) {
    const [user_id, e164] = params as [string, string];
    const before = dbState.blocks.length;
    dbState.blocks = dbState.blocks.filter(
      (b) => !(b.user_id === user_id && b.e164 === e164),
    );
    return { rows: [], rowCount: before - dbState.blocks.length };
  }

  // ---------- GET /v1/blocks/snapshot ----------

  if (/SELECT e164, blocked_at FROM user_blocks/i.test(t)) {
    const userId = params[0] as string;
    const since = params[1] as Date | undefined;
    let rows = dbState.blocks.filter((b) => b.user_id === userId);
    if (since) rows = rows.filter((b) => b.blocked_at > since);
    rows.sort((a, b) => a.blocked_at.getTime() - b.blocked_at.getTime());
    return {
      rows: rows.map((r) => ({ e164: r.e164, blocked_at: r.blocked_at })),
      rowCount: rows.length,
    };
  }

  // ---------- GET /v1/blocks/explain ----------

  if (/SELECT id, blocked_at, reason_code, source_surface\s+FROM user_blocks/i.test(t)) {
    const [user_id, e164] = params as [string, string];
    const row = dbState.blocks.find((b) => b.user_id === user_id && b.e164 === e164);
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        id: row.id,
        blocked_at: row.blocked_at,
        reason_code: row.reason_code,
        source_surface: row.source_surface,
      }],
      rowCount: 1,
    };
  }

  if (/SELECT attempted_at, notification_grouped\s+FROM block_retry_attempts/i.test(t)) {
    const [user_id, e164] = params as [string, string];
    const rows = dbState.retry_attempts
      .filter((r) => r.user_id === user_id && r.e164 === e164)
      .sort((a, b) => b.attempted_at.getTime() - a.attempted_at.getTime())
      .slice(0, 50);
    return {
      rows: rows.map((r) => ({
        attempted_at: r.attempted_at,
        notification_grouped: r.notification_grouped,
      })),
      rowCount: rows.length,
    };
  }

  // ---------- POST /v1/blocks/retry-attempt ----------

  if (/SELECT EXISTS\(/i.test(t) && /FROM user_blocks/i.test(t)) {
    const [user_id, e164] = params as [string, string];
    const exists = dbState.blocks.some((b) => b.user_id === user_id && b.e164 === e164);
    return { rows: [{ blocked: exists }], rowCount: 1 };
  }

  if (/SELECT COUNT\(\*\)::TEXT AS count\s+FROM block_retry_attempts/i.test(t) && /INTERVAL '24 hours'/i.test(t)) {
    const userId = params[0] as string;
    const count = dbState.retry_attempts.filter(
      (r) =>
        r.user_id === userId &&
        r.notification_sent &&
        !r.notification_grouped &&
        r.attempted_at > new Date(Date.now() - 24 * 60 * 60 * 1000),
    ).length;
    return { rows: [{ count: String(count) }], rowCount: 1 };
  }

  if (/SELECT COUNT\(\*\)::TEXT AS count\s+FROM block_retry_attempts/i.test(t) && /INTERVAL '1 hour'/i.test(t)) {
    const [user_id, e164] = params as [string, string];
    const count = dbState.retry_attempts.filter(
      (r) =>
        r.user_id === user_id &&
        r.e164 === e164 &&
        r.notification_sent &&
        r.attempted_at > new Date(Date.now() - 60 * 60 * 1000),
    ).length;
    return { rows: [{ count: String(count) }], rowCount: 1 };
  }

  if (/^INSERT INTO block_retry_attempts/i.test(t)) {
    const [user_id, e164, attempted_at, notification_sent, notification_grouped] = params as [
      string, string, Date, boolean, boolean,
    ];
    const row: RetryRow = {
      id: makeUuid(),
      user_id,
      e164,
      attempted_at,
      notification_sent,
      notification_grouped,
    };
    dbState.retry_attempts.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // ---------- POST /v1/blocks/contribution-toggle ----------

  if (/^INSERT INTO family_alert_preferences/i.test(t) && /cross_user_contribution_enabled/i.test(t)) {
    const [user_id, enabled] = params as [string, boolean];
    const existing = dbState.prefs.get(user_id);
    if (existing) {
      existing.cross_user_contribution_enabled = enabled;
    } else {
      dbState.prefs.set(user_id, {
        user_id,
        privacy_level: 'default',
        cross_user_contribution_enabled: enabled,
        mom_side_stt_enabled: true,
        block_retry_notifications_enabled: true,
      });
    }
    return { rows: [], rowCount: 1 };
  }

  // ---------- A1 lookup routes ----------

  // pre-call-risk: SELECT ... FROM a1_hot_numbers WHERE e164 = $1
  if (/FROM a1_hot_numbers/i.test(t) && /WHERE e164 = \$1/i.test(t)) {
    const e164 = params[0] as string;
    const row = dbState.hot_numbers.find((h) => h.e164 === e164);
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        risk_weight: row.risk_weight,
        mention_count: row.mention_count,
        primary_sources: row.primary_sources,
        last_recomputed_at: row.last_recomputed_at,
      }],
      rowCount: 1,
    };
  }

  // sources: SELECT ... FROM mentions WHERE e164 = $1 AND severity >= 3
  if (/FROM mentions\s+WHERE e164 = \$1/i.test(t)) {
    const e164 = params[0] as string;
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const rows = dbState.mentions
      .filter((m) => m.e164 === e164 && (m.severity ?? 0) >= 3 && m.created_at > cutoff)
      .sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))
      .slice(0, 50);
    return { rows, rowCount: rows.length };
  }

  // cache-snapshot: full or since
  if (/FROM a1_hot_numbers/i.test(t) && /ORDER BY risk_weight DESC/i.test(t)) {
    let rows = [...dbState.hot_numbers];
    if (params.length > 0) {
      const since = params[0] as Date;
      rows = rows.filter((h) => h.last_recomputed_at > since);
    }
    rows.sort((a, b) => b.risk_weight - a.risk_weight);
    return {
      rows: rows.map((r) => ({
        e164: r.e164,
        risk_weight: r.risk_weight,
        primary_sources: r.primary_sources,
        last_recomputed_at: r.last_recomputed_at,
      })),
      rowCount: rows.length,
    };
  }

  // Unknown query — fail loudly so we know the test missed a code path.
  throw new Error(`Unhandled query in v3 phase1 fake: ${t.slice(0, 120)}`);
};

// -------------------------------------------------------------------------
// Test harness setup
// -------------------------------------------------------------------------

interface FastifyAppLike {
  inject: (opts: unknown) => Promise<{ statusCode: number; body: string }>;
  ready: () => Promise<unknown>;
  close: () => Promise<unknown>;
}

let app: FastifyAppLike;

before(async () => {
  // Patch the pool to use our fake query.
  type Patchable = { pool: { query: typeof fakeQuery } };
  (db as unknown as Patchable).pool.query = fakeQuery as unknown as typeof fakeQuery;

  const fastifyApp = Fastify({ logger: false });
  // Mount routes. Both gated on V3_*_ENABLED (set above).
  await fastifyApp.register(blocksRoutes);
  await fastifyApp.register(lookupRoutes);
  await fastifyApp.ready();
  app = fastifyApp as unknown as FastifyAppLike;
});

beforeEach(async () => {
  resetDb();
  // HIGH #7 fix moved A2 rate-limiting to Redis; reset counters per
  // test so cross-case state doesn't poison assertions.
  await _resetRateLimitForTests(DEV_USER_ID, TEST_E164);
  await _resetRateLimitForTests(DEV_USER_ID, OTHER_E164);
});

const authHeaders = { authorization: `Bearer ${SHARED_SECRET}` };

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('A2 — POST /v1/blocks', () => {
  it('creates a new block and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/blocks',
      headers: authHeaders,
      payload: {
        e164: TEST_E164,
        reason_code: 'live_shield_critical',
        source_surface: 'live_shield_post_call',
      },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.was_new, true);
    assert.equal(body.e164, TEST_E164);
    assert.equal(dbState.blocks.length, 1);
  });

  it('is idempotent — second block of same number returns 200 was_new=false', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/blocks',
      headers: authHeaders,
      payload: {
        e164: TEST_E164,
        reason_code: 'live_shield_critical',
        source_surface: 'live_shield_post_call',
      },
    });
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/blocks',
      headers: authHeaders,
      payload: {
        e164: TEST_E164,
        reason_code: 'settings',
        source_surface: 'settings',
      },
    });
    assert.equal(res2.statusCode, 200);
    const body = JSON.parse(res2.body);
    assert.equal(body.was_new, false);
    assert.equal(dbState.blocks.length, 1);
  });

  it('rejects invalid phone number with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/blocks',
      headers: authHeaders,
      payload: {
        e164: 'not-a-number',
        reason_code: 'live_shield_critical',
        source_surface: 'live_shield_post_call',
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it('contributes to fraud graph by default (toggle ON)', async () => {
    // Default behavior: no prefs row exists → contributes_to_graph defaults TRUE.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/blocks',
      headers: authHeaders,
      payload: {
        e164: TEST_E164,
        reason_code: 'live_shield_critical',
        source_surface: 'live_shield_post_call',
      },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.contributed_to_graph, true);
    // Mention should have been written.
    assert.equal(dbState.mentions.length, 1);
    assert.equal(dbState.mentions[0]!.source, 'aegisdial_user_block');
    assert.equal(dbState.mentions[0]!.sentiment, 'negative');
  });

  it('does NOT contribute to fraud graph when toggle is OFF', async () => {
    // Pre-set the toggle OFF for the dev user.
    dbState.prefs.set(DEV_USER_ID, {
      user_id: DEV_USER_ID,
      privacy_level: 'default',
      cross_user_contribution_enabled: false,
      mom_side_stt_enabled: true,
      block_retry_notifications_enabled: true,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/blocks',
      headers: authHeaders,
      payload: {
        e164: TEST_E164,
        reason_code: 'live_shield_critical',
        source_surface: 'live_shield_post_call',
      },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.contributed_to_graph, false);
    assert.equal(dbState.mentions.length, 0);
  });
});

describe('A2 — POST /v1/blocks/retry-attempt', () => {
  it('rejects retry attempts for numbers not in the block list', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/blocks/retry-attempt',
      headers: authHeaders,
      payload: { e164: OTHER_E164 },
    });
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'number_not_blocked');
  });

  it('records retry as eligible for individual push when under rate limit', async () => {
    // First, block the number.
    await app.inject({
      method: 'POST',
      url: '/v1/blocks',
      headers: authHeaders,
      payload: {
        e164: TEST_E164,
        reason_code: 'live_shield_critical',
        source_surface: 'live_shield_post_call',
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/blocks/retry-attempt',
      headers: authHeaders,
      payload: { e164: TEST_E164 },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.notification_eligible, true);
    assert.equal(body.notification_grouped, false);
    assert.equal(dbState.retry_attempts.length, 1);
  });

  it('coalesces second retry of the same number within an hour into the digest', async () => {
    // Block the number first.
    await app.inject({
      method: 'POST',
      url: '/v1/blocks',
      headers: authHeaders,
      payload: {
        e164: TEST_E164,
        reason_code: 'live_shield_critical',
        source_surface: 'live_shield_post_call',
      },
    });

    // First retry: eligible.
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/blocks/retry-attempt',
      headers: authHeaders,
      payload: { e164: TEST_E164 },
    });
    assert.equal(JSON.parse(r1.body).notification_eligible, true);

    // Second retry within the hour: should coalesce (per-number hourly cap is 1).
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/blocks/retry-attempt',
      headers: authHeaders,
      payload: { e164: TEST_E164 },
    });
    assert.equal(r2.statusCode, 201);
    const body = JSON.parse(r2.body);
    assert.equal(body.notification_eligible, false);
    assert.equal(body.notification_grouped, true);
  });
});

describe('A2 — GET /v1/blocks/snapshot', () => {
  it('returns the user blocks sorted ascending by blocked_at', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/blocks',
      headers: authHeaders,
      payload: { e164: TEST_E164, reason_code: 'settings', source_surface: 'settings' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/blocks',
      headers: authHeaders,
      payload: { e164: OTHER_E164, reason_code: 'call_log', source_surface: 'call_log' },
    });

    const res = await app.inject({ method: 'GET', url: '/v1/blocks/snapshot', headers: authHeaders });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.blocks.length, 2);
    // Sorted ascending — first block is the first inserted.
    assert.equal(body.blocks[0].e164, TEST_E164);
  });
});

describe('A1 — GET /v1/lookup/pre-call-risk', () => {
  it('returns in_cache:false for unknown numbers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/lookup/pre-call-risk?e164=${encodeURIComponent(TEST_E164)}`,
      headers: authHeaders,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.in_cache, false);
    assert.equal(body.e164, TEST_E164);
  });

  it('returns in_cache:true with metadata for cached numbers', async () => {
    dbState.hot_numbers.push({
      e164: TEST_E164,
      risk_weight: 42.5,
      mention_count: 7,
      primary_sources: ['reddit', 'bbb', 'fcc'],
      last_recomputed_at: new Date(),
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/lookup/pre-call-risk?e164=${encodeURIComponent(TEST_E164)}`,
      headers: authHeaders,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.in_cache, true);
    assert.equal(body.risk_weight, 42.5);
    assert.equal(body.mention_count, 7);
    assert.deepEqual(body.primary_sources, ['reddit', 'bbb', 'fcc']);
  });

  it('rejects missing e164 with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/lookup/pre-call-risk',
      headers: authHeaders,
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('A1 — GET /v1/lookup/sources', () => {
  it('filters out low-severity mentions', async () => {
    dbState.mentions.push({
      e164: TEST_E164,
      source: 'reddit',
      source_ref: 'r1',
      url: 'https://reddit.com/r/Scams/...',
      snippet: 'They claimed to be from Wells Fargo',
      sentiment: 'negative',
      scam_category: 'bank_impersonation',
      severity: 7,
      weight: 0.5,
      observed_at: new Date(),
      created_at: new Date(),
    });
    dbState.mentions.push({
      e164: TEST_E164,
      source: 'serper',
      source_ref: 'r2',
      url: null,
      snippet: 'low-severity match',
      sentiment: 'neutral',
      scam_category: null,
      severity: 1, // below threshold (3) — should be filtered
      weight: 0.3,
      observed_at: new Date(),
      created_at: new Date(),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/lookup/sources?e164=${encodeURIComponent(TEST_E164)}`,
      headers: authHeaders,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0].source, 'reddit');
    assert.equal(body.sources[0].severity, 7);
  });
});
