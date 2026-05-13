import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Identity Shield I-P3a — Enzoic + HIBP ingest worker.
//
// Stubs:
//   - db.pool.query — matches the worker's SQL against an in-memory
//     model of identity_monitors / identity_breaches /
//     identity_breach_findings / active_threats.
//   - fetch — per-test override via the `opts.httpFetch` surface of
//     each exported function (matches hibpBreachCheck's pattern).
//
// Coverage matrix (12):
//   1.  HIBP catalog sync — fresh catalog inserts every breach
//   2.  HIBP catalog sync — re-run with same data → 0 added, all updated
//   3.  HIBP catalog sync — new breach → identity_breaches insert + active_threats fanout
//   4.  Per-user HIBP scan — 1 email + 2 breaches → 2 findings w/ severity by data_classes
//   5.  Per-user HIBP scan — re-run is idempotent (0 new findings)
//   6.  Per-user HIBP scan — no HIBP_API_KEY → 0, no throw
//   7.  Per-user HIBP scan — HIBP 429 → 0, no crash
//   8.  Enzoic batch — single user with multiple emails → one batched HTTP call
//   9.  Enzoic batch — no creds → 0, no throw
//   10. scanAllUsersHibpOnce iterates over every user with email monitors
//   11. Cross-user isolation: A's findings don't appear under B
//   12. Idempotency: re-running scanAllUsersHibpOnce → 0 new findings

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-identity-ingest';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://identity-ingest';
// Pre-seed BEFORE config.ts loads. Tests toggle these by mutating
// the loaded config object below.
process.env.HIBP_API_KEY = 'test-hibp-key-identity-ingest';
process.env.EMAIL_SHIELD_ENZOIC_API_KEY = 'test-enzoic-key';
process.env.EMAIL_SHIELD_ENZOIC_SECRET = 'test-enzoic-secret';

const { config } = await import('../src/config.ts');
const cache = await import('../src/lib/cache.ts');
const db = await import('../src/lib/db.ts');
const worker = await import('../src/workers/identityShieldIngest.ts');

// ────────────────────────────────────────────────────────────────
// In-memory model
// ────────────────────────────────────────────────────────────────

interface FakeMonitor {
  id: string;
  user_id: string;
  monitor_kind: 'email' | 'phone_e164';
  watched_value: string;
  active: boolean;
}
interface FakeBreach {
  id: string;
  breach_name: string;
  source: 'hibp' | 'enzoic' | 'aegisdial_internal';
  source_breach_id: string;
  domain: string | null;
  breach_date: string | null;
  added_date: string | null;
  pwn_count: number | null;
  data_classes: string[];
  is_verified: boolean;
  is_sensitive: boolean;
  description: string | null;
  synced_at: Date;
}
interface FakeFinding {
  id: string;
  user_id: string;
  monitor_id: string;
  breach_id: string;
  severity: 'informational' | 'caution' | 'critical';
  surfaced_at: Date;
}
interface FakeActiveThreat {
  id: string;
  threat_kind: string;
  threat_value: string;
  severity: string;
  provenance: string;
  context_text: string | null;
  geo_tag: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  expires_at: Date | null;
}

let fakeMonitors: FakeMonitor[] = [];
let fakeBreaches: FakeBreach[] = [];
let fakeFindings: FakeFinding[] = [];
let fakeActiveThreats: FakeActiveThreat[] = [];
let nextId = 1;

const SEV_RANK: Record<string, number> = {
  informational: 1,
  caution: 2,
  warning: 3,
  confirmed_scammer: 4,
};

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const trimmed = text.trim().replace(/\s+/g, ' ');

  // ── identity_breaches UPSERT (catalog sync path) ──────────────
  if (/^INSERT INTO identity_breaches \( breach_name, source, source_breach_id, domain, breach_date, added_date, pwn_count, data_classes, is_verified, is_sensitive, description \)/i.test(trimmed)) {
    const [
      breach_name,
      source_breach_id,
      domain,
      breach_date,
      added_date,
      pwn_count,
      data_classes,
      is_verified,
      is_sensitive,
      description,
    ] = params as [string, string, string | null, string | null, string | null, number | null, string[], boolean, boolean, string | null];
    const existing = fakeBreaches.find(
      (b) => b.source === 'hibp' && b.source_breach_id === source_breach_id,
    );
    if (existing) {
      existing.breach_name = breach_name;
      existing.domain = domain;
      existing.breach_date = breach_date;
      existing.added_date = added_date;
      existing.pwn_count = pwn_count;
      existing.data_classes = data_classes;
      existing.is_verified = is_verified;
      existing.is_sensitive = is_sensitive;
      existing.description = description;
      existing.synced_at = new Date();
      return { rows: [{ was_insert: false }], rowCount: 1 };
    }
    fakeBreaches.push({
      id: `br-${nextId++}`,
      breach_name,
      source: 'hibp',
      source_breach_id,
      domain,
      breach_date,
      added_date,
      pwn_count,
      data_classes,
      is_verified,
      is_sensitive,
      description,
      synced_at: new Date(),
    });
    return { rows: [{ was_insert: true }], rowCount: 1 };
  }

  // ── identity_breaches UPSERT (per-user scan inline path) ──────
  if (/^INSERT INTO identity_breaches \( breach_name, source, source_breach_id, domain, breach_date, added_date, pwn_count, data_classes, is_verified, is_sensitive \)/i.test(trimmed)) {
    const [
      breach_name,
      source_breach_id,
      domain,
      breach_date,
      added_date,
      pwn_count,
      data_classes,
      is_verified,
      is_sensitive,
    ] = params as [string, string, string | null, string | null, string | null, number | null, string[], boolean, boolean];
    let row = fakeBreaches.find(
      (b) => b.source === 'hibp' && b.source_breach_id === source_breach_id,
    );
    if (!row) {
      row = {
        id: `br-${nextId++}`,
        breach_name,
        source: 'hibp',
        source_breach_id,
        domain,
        breach_date,
        added_date,
        pwn_count,
        data_classes,
        is_verified,
        is_sensitive,
        description: null,
        synced_at: new Date(),
      };
      fakeBreaches.push(row);
    } else {
      row.synced_at = new Date();
    }
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // ── Enzoic identity_breaches UPSERT ───────────────────────────
  if (/^INSERT INTO identity_breaches \( breach_name, source, source_breach_id, domain, breach_date, pwn_count, data_classes, description \)/i.test(trimmed)) {
    const [
      breach_name,
      source_breach_id,
      domain,
      breach_date,
      pwn_count,
      data_classes,
      description,
    ] = params as [string, string, string | null, string | null, number | null, string[], string | null];
    let row = fakeBreaches.find(
      (b) => b.source === 'enzoic' && b.source_breach_id === source_breach_id,
    );
    if (!row) {
      row = {
        id: `br-${nextId++}`,
        breach_name,
        source: 'enzoic',
        source_breach_id,
        domain,
        breach_date,
        added_date: null,
        pwn_count,
        data_classes,
        is_verified: false,
        is_sensitive: false,
        description,
        synced_at: new Date(),
      };
      fakeBreaches.push(row);
    } else {
      row.synced_at = new Date();
    }
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // ── SELECT identity_breaches by (source, source_breach_id) ────
  if (/^SELECT id FROM identity_breaches WHERE source = 'hibp' AND source_breach_id = \$1/i.test(trimmed)) {
    const [sbid] = params as [string];
    const row = fakeBreaches.find((b) => b.source === 'hibp' && b.source_breach_id === sbid);
    return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // ── SELECT identity_monitors for user ─────────────────────────
  if (/^SELECT id, watched_value FROM identity_monitors WHERE user_id = \$1 AND monitor_kind = 'email' AND active/i.test(trimmed)) {
    const [uid] = params as [string];
    const rows = fakeMonitors
      .filter((m) => m.user_id === uid && m.monitor_kind === 'email' && m.active)
      .map((m) => ({ id: m.id, watched_value: m.watched_value }));
    return { rows, rowCount: rows.length };
  }

  // ── SELECT DISTINCT user_id FROM identity_monitors ────────────
  if (/^SELECT DISTINCT user_id FROM identity_monitors WHERE monitor_kind = 'email' AND active/i.test(trimmed)) {
    const set = new Set<string>();
    for (const m of fakeMonitors) {
      if (m.monitor_kind === 'email' && m.active) set.add(m.user_id);
    }
    const rows = [...set].map((user_id) => ({ user_id }));
    return { rows, rowCount: rows.length };
  }

  // ── SELECT identity_monitors (all email rows) for Enzoic path ─
  if (/^SELECT id, user_id, watched_value FROM identity_monitors WHERE monitor_kind = 'email' AND active/i.test(trimmed)) {
    const rows = fakeMonitors
      .filter((m) => m.monitor_kind === 'email' && m.active)
      .map((m) => ({ id: m.id, user_id: m.user_id, watched_value: m.watched_value }));
    return { rows, rowCount: rows.length };
  }

  // ── identity_breach_findings INSERT ON CONFLICT DO NOTHING ────
  if (/^INSERT INTO identity_breach_findings/i.test(trimmed)) {
    const [user_id, monitor_id, breach_id, severity] = params as [string, string, string, FakeFinding['severity']];
    const exists = fakeFindings.find(
      (f) => f.user_id === user_id && f.monitor_id === monitor_id && f.breach_id === breach_id,
    );
    if (exists) return { rows: [], rowCount: 0 };
    fakeFindings.push({
      id: `f-${nextId++}`,
      user_id,
      monitor_id,
      breach_id,
      severity,
      surfaced_at: new Date(),
    });
    return { rows: [], rowCount: 1 };
  }

  // ── ingestThreatBatch multi-row CTE (from activeThreats) ──────
  if (/^WITH input_rows AS \( SELECT/i.test(trimmed) && /INSERT INTO active_threats/i.test(trimmed)) {
    const PARAMS_PER_ROW = 8;
    const rows: Array<{ was_insert: boolean }> = [];
    for (let i = 0; i < params.length; i += PARAMS_PER_ROW) {
      const [kind, value, severity, provenance, context, geo_tag, expires_at] = params.slice(
        i,
        i + PARAMS_PER_ROW,
      ) as [string, string, string, string, string | null, string | null, Date | null, number];
      const existing = fakeActiveThreats.find(
        (r) => r.threat_kind === kind && r.threat_value === value && r.provenance === provenance,
      );
      if (existing) {
        existing.last_seen_at = new Date();
        rows.push({ was_insert: false });
      } else {
        fakeActiveThreats.push({
          id: `at-${nextId++}`,
          threat_kind: kind,
          threat_value: value,
          severity,
          provenance,
          context_text: context,
          geo_tag,
          first_seen_at: new Date(),
          last_seen_at: new Date(),
          expires_at,
        });
        rows.push({ was_insert: true });
      }
    }
    return { rows, rowCount: rows.length };
  }

  // metric_counters — swallow.
  if (/^INSERT INTO metric_counters/i.test(trimmed)) {
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`unstubbed SQL: ${trimmed.slice(0, 240)}`);
};

// HIBP cache shim — flush per-test so hibpBreachCheck doesn't carry
// breaches across cases.
async function resetHibpCache(emails: string[]): Promise<void> {
  for (const e of emails) {
    const key = 'hibp:' + createHash('sha256').update(e.toLowerCase().trim()).digest('hex');
    await cache.cacheInvalidate(key);
    await cache.cacheInvalidate(key + ':inflight');
  }
}

beforeEach(async () => {
  fakeMonitors = [];
  fakeBreaches = [];
  fakeFindings = [];
  fakeActiveThreats = [];
  nextId = 1;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
  // Restore env-driven flags between tests.
  (config as { HIBP_API_KEY?: string }).HIBP_API_KEY = 'test-hibp-key-identity-ingest';
  (config as { EMAIL_SHIELD_ENZOIC_API_KEY?: string }).EMAIL_SHIELD_ENZOIC_API_KEY = 'test-enzoic-key';
  (config as { EMAIL_SHIELD_ENZOIC_SECRET?: string }).EMAIL_SHIELD_ENZOIC_SECRET = 'test-enzoic-secret';
  // I-M2 — default to unset so legacy tests retain "scan everyone"
  // semantics; cap-specific tests opt in to a value.
  (config as { ENZOIC_DAILY_USER_CAP?: number }).ENZOIC_DAILY_USER_CAP = undefined;
  await resetHibpCache([
    'user-a@example.com',
    'user-b@example.com',
    'multi-a@example.com',
    'multi-b@example.com',
    'iso-a@example.com',
    'iso-b@example.com',
    'rate-limited@example.com',
    'no-key@example.com',
    'idem@example.com',
  ]);
});

// Helper: build a HIBP /breaches catalog response.
function hibpBreach(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    Name: 'LinkedIn',
    Title: 'LinkedIn (2012)',
    Domain: 'linkedin.com',
    BreachDate: '2012-05-05',
    AddedDate: '2016-05-21T21:35:40Z',
    PwnCount: 164611595,
    DataClasses: ['Email addresses', 'Passwords'],
    IsVerified: true,
    IsSensitive: false,
    IsRetired: false,
    Description: 'LinkedIn 2012 leak.',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ────────────────────────────────────────────────────────────────
// 1+2+3 — HIBP catalog sync
// ────────────────────────────────────────────────────────────────

describe('syncHibpCatalogOnce', () => {
  it('inserts every breach in a fresh catalog and fans out url_host threats for each domain', async () => {
    const httpFetch = async (): Promise<Response> =>
      jsonResponse([
        hibpBreach({ Name: 'LinkedIn', Domain: 'linkedin.com' }),
        hibpBreach({ Name: 'Adobe', Domain: 'adobe.com', DataClasses: ['Email addresses'] }),
      ]);
    const result = await worker.syncHibpCatalogOnce({ httpFetch });
    assert.equal(result.added, 2);
    assert.equal(result.updated, 0);
    assert.equal(fakeBreaches.length, 2);
    // Both domains land in active_threats with the expected provenance.
    const li = fakeActiveThreats.find((t) => t.provenance === 'hibp:LinkedIn');
    const ad = fakeActiveThreats.find((t) => t.provenance === 'hibp:Adobe');
    assert.ok(li);
    assert.equal(li!.threat_value, 'linkedin.com');
    assert.equal(li!.severity, 'caution');
    assert.ok(ad);
    assert.equal(ad!.threat_value, 'adobe.com');
  });

  it('re-running with the same catalog produces 0 added (all rows update synced_at)', async () => {
    const httpFetch = async (): Promise<Response> =>
      jsonResponse([
        hibpBreach({ Name: 'LinkedIn' }),
        hibpBreach({ Name: 'Adobe' }),
      ]);
    await worker.syncHibpCatalogOnce({ httpFetch });
    assert.equal(fakeBreaches.length, 2);
    const beforeThreats = fakeActiveThreats.length;
    const second = await worker.syncHibpCatalogOnce({ httpFetch });
    assert.equal(second.added, 0);
    assert.equal(second.updated, 2);
    assert.equal(fakeBreaches.length, 2);
    // active_threats NOT re-INSERTed on a stale catalog re-run — the
    // hibp fanout is gated on was_insert=true.
    assert.equal(fakeActiveThreats.length, beforeThreats);
  });

  it('new breach in next sync → identity_breaches insert + active_threats fanout', async () => {
    // First sync — single breach.
    await worker.syncHibpCatalogOnce({
      httpFetch: async (): Promise<Response> =>
        jsonResponse([hibpBreach({ Name: 'LinkedIn' })]),
    });
    assert.equal(fakeBreaches.length, 1);
    const threatsAfterFirst = fakeActiveThreats.length;
    // Second sync — same first breach + a new "Ticketmaster" entry.
    const result = await worker.syncHibpCatalogOnce({
      httpFetch: async (): Promise<Response> =>
        jsonResponse([
          hibpBreach({ Name: 'LinkedIn' }),
          hibpBreach({
            Name: 'Ticketmaster',
            Title: 'Ticketmaster (2024)',
            Domain: 'ticketmaster.com',
            DataClasses: ['Email addresses', 'Phone numbers'],
            IsSensitive: false,
          }),
        ]),
    });
    assert.equal(result.added, 1);
    assert.equal(result.updated, 1);
    assert.equal(fakeBreaches.length, 2);
    // Exactly ONE new active_threats row — Ticketmaster's.
    assert.equal(fakeActiveThreats.length, threatsAfterFirst + 1);
    const tm = fakeActiveThreats.find((t) => t.provenance === 'hibp:Ticketmaster');
    assert.ok(tm);
    assert.equal(tm!.threat_value, 'ticketmaster.com');
  });
});

// ────────────────────────────────────────────────────────────────
// 4+5+6+7 — Per-user HIBP scan
// ────────────────────────────────────────────────────────────────

describe('scanUserHibpExposureOnce', () => {
  it('creates findings with correct severity by data_classes (Passwords → critical, else → caution)', async () => {
    fakeMonitors.push({
      id: 'm-1',
      user_id: 'user-a',
      monitor_kind: 'email',
      watched_value: 'user-a@example.com',
      active: true,
    });
    const httpFetch = async (): Promise<Response> =>
      jsonResponse([
        // Breach with Passwords → critical.
        {
          Name: 'LinkedIn',
          Domain: 'linkedin.com',
          BreachDate: '2012-05-05',
          AddedDate: '2016-05-21T21:35:40Z',
          PwnCount: 164611595,
          DataClasses: ['Email addresses', 'Passwords'],
          IsVerified: true,
          IsSensitive: false,
          IsRetired: false,
        },
        // Breach without Passwords → caution.
        {
          Name: 'Adobe',
          Domain: 'adobe.com',
          BreachDate: '2013-10-04',
          AddedDate: '2014-01-01T00:00:00Z',
          PwnCount: 152445165,
          DataClasses: ['Email addresses', 'Password hints'],
          IsVerified: true,
          IsSensitive: false,
          IsRetired: false,
        },
      ]);
    const result = await worker.scanUserHibpExposureOnce('user-a', { httpFetch });
    assert.equal(result.new_findings, 2);
    assert.equal(fakeFindings.length, 2);
    const li = fakeFindings.find(
      (f) => fakeBreaches.find((b) => b.id === f.breach_id)?.source_breach_id === 'LinkedIn',
    );
    const ad = fakeFindings.find(
      (f) => fakeBreaches.find((b) => b.id === f.breach_id)?.source_breach_id === 'Adobe',
    );
    assert.equal(li!.severity, 'critical');
    assert.equal(ad!.severity, 'caution');
  });

  it('re-running is idempotent — 0 new findings the second time', async () => {
    fakeMonitors.push({
      id: 'm-1',
      user_id: 'idem-user',
      monitor_kind: 'email',
      watched_value: 'idem@example.com',
      active: true,
    });
    const httpFetch = async (): Promise<Response> =>
      jsonResponse([hibpBreach({ Name: 'LinkedIn' })]);
    const first = await worker.scanUserHibpExposureOnce('idem-user', { httpFetch });
    assert.equal(first.new_findings, 1);
    // Second run — same monitor, same breach. cacheGet in
    // hibpBreachCheck returns the cached result so HIBP isn't
    // re-hit; the finding INSERT conflicts and returns 0.
    const second = await worker.scanUserHibpExposureOnce('idem-user', { httpFetch });
    assert.equal(second.new_findings, 0);
    assert.equal(fakeFindings.length, 1);
  });

  it('returns 0 without throwing when HIBP_API_KEY is unset', async () => {
    (config as { HIBP_API_KEY?: string }).HIBP_API_KEY = undefined;
    fakeMonitors.push({
      id: 'm-1',
      user_id: 'no-key-user',
      monitor_kind: 'email',
      watched_value: 'no-key@example.com',
      active: true,
    });
    const httpFetch = async (): Promise<Response> => {
      throw new Error('should not be called without API key');
    };
    const result = await worker.scanUserHibpExposureOnce('no-key-user', { httpFetch });
    assert.equal(result.new_findings, 0);
    assert.equal(fakeFindings.length, 0);
  });

  it('survives a HIBP 429 — returns 0, does not crash', async () => {
    fakeMonitors.push({
      id: 'm-1',
      user_id: 'rl-user',
      monitor_kind: 'email',
      watched_value: 'rate-limited@example.com',
      active: true,
    });
    const httpFetch = async (): Promise<Response> =>
      new Response('Too Many Requests', { status: 429 });
    const result = await worker.scanUserHibpExposureOnce('rl-user', { httpFetch });
    assert.equal(result.new_findings, 0);
    assert.equal(fakeFindings.length, 0);
  });
});

// ────────────────────────────────────────────────────────────────
// 8+9 — Enzoic batch
// ────────────────────────────────────────────────────────────────

describe('scanAllUsersEnzoicOnce', () => {
  it('batches multiple emails into a single HTTP call', async () => {
    fakeMonitors.push(
      {
        id: 'm-a1',
        user_id: 'user-a',
        monitor_kind: 'email',
        watched_value: 'a1@example.com',
        active: true,
      },
      {
        id: 'm-a2',
        user_id: 'user-a',
        monitor_kind: 'email',
        watched_value: 'a2@example.com',
        active: true,
      },
      {
        id: 'm-a3',
        user_id: 'user-a',
        monitor_kind: 'email',
        watched_value: 'a3@example.com',
        active: true,
      },
    );
    const callUrls: string[] = [];
    const httpFetch = async (url: RequestInfo | URL): Promise<Response> => {
      callUrls.push(String(url));
      // Listing call carries `usernames=`; respond with an
      // exposure id for the first user only.
      // I-H3: each entry now carries a `username` field so the worker
      // can pair by value (not by index). The previous positional-
      // pairing path was a silent cross-user breach vector when
      // Enzoic ever reordered/skipped entries.
      if (String(url).includes('usernames=')) {
        return jsonResponse([
          { username: 'a1@example.com', count: 1, exposures: ['exp-1'] },
          { username: 'a2@example.com', count: 0, exposures: [] },
          { username: 'a3@example.com', count: 0, exposures: [] },
        ]);
      }
      // Detail call carries `id=`.
      return jsonResponse({
        id: 'exp-1',
        title: 'Sample Breach 2024',
        date: '2024-01-15',
        source: 'sample.example',
        dataClasses: ['Passwords', 'Email addresses'],
        entries: 100000,
        description: 'test',
      });
    };
    const result = await worker.scanAllUsersEnzoicOnce({ httpFetch });
    assert.equal(result.users_checked, 1);
    assert.equal(result.new_findings, 1);
    // Exactly ONE batched listing call (all 3 emails fit under the
    // 20-row batch cap).
    const listingCalls = callUrls.filter((u) => u.includes('usernames='));
    assert.equal(listingCalls.length, 1);
    // The listing URL carries all three emails.
    assert.ok(listingCalls[0]!.includes('a1%40example.com'));
    assert.ok(listingCalls[0]!.includes('a2%40example.com'));
    assert.ok(listingCalls[0]!.includes('a3%40example.com'));
    // Finding produced for the matched monitor.
    assert.equal(fakeFindings[0]!.monitor_id, 'm-a1');
    assert.equal(fakeFindings[0]!.severity, 'critical');
  });

  it('returns 0 without throwing when Enzoic creds are unset', async () => {
    (config as { EMAIL_SHIELD_ENZOIC_API_KEY?: string }).EMAIL_SHIELD_ENZOIC_API_KEY = undefined;
    fakeMonitors.push({
      id: 'm-1',
      user_id: 'user-a',
      monitor_kind: 'email',
      watched_value: 'a@example.com',
      active: true,
    });
    const httpFetch = async (): Promise<Response> => {
      throw new Error('should not be called without creds');
    };
    const result = await worker.scanAllUsersEnzoicOnce({ httpFetch });
    assert.equal(result.users_checked, 0);
    assert.equal(result.new_findings, 0);
  });

  // ──────────────────────────────────────────────────────────────
  // I-H3 — Enzoic batch pairs by username (not by position)
  // ──────────────────────────────────────────────────────────────
  // The previous positional-pairing path was a silent cross-user
  // breach vector. Three adversarial scenarios pinned here:
  //   - Reversed order → each user gets THEIR exposures (no swap)
  //   - Skipped username → other users still pair correctly
  //   - No username field → refuse to insert (better miss than mis-
  //     attribute)

  it('I-H3: reversed Enzoic response → each user gets their own exposures (no cross-contamination)', async () => {
    fakeMonitors.push(
      {
        id: 'm-a',
        user_id: 'user-a',
        monitor_kind: 'email',
        watched_value: 'a@example.com',
        active: true,
      },
      {
        id: 'm-b',
        user_id: 'user-b',
        monitor_kind: 'email',
        watched_value: 'b@example.com',
        active: true,
      },
      {
        id: 'm-c',
        user_id: 'user-c',
        monitor_kind: 'email',
        watched_value: 'c@example.com',
        active: true,
      },
    );
    const httpFetch = async (url: RequestInfo | URL): Promise<Response> => {
      if (String(url).includes('usernames=')) {
        // REVERSED order — c, b, a — to prove that positional
        // pairing would have swapped attribution. Each entry's
        // exposure id is unique to its user, so a mis-attribution
        // would surface as a finding with the wrong (user_id,
        // breach_id) combo.
        return jsonResponse([
          { username: 'c@example.com', count: 1, exposures: ['exp-for-c'] },
          { username: 'b@example.com', count: 1, exposures: ['exp-for-b'] },
          { username: 'a@example.com', count: 1, exposures: ['exp-for-a'] },
        ]);
      }
      // Detail responses keyed off id.
      const u = String(url);
      const exposureId =
        u.includes('exp-for-a') ? 'exp-for-a'
        : u.includes('exp-for-b') ? 'exp-for-b'
        : 'exp-for-c';
      return jsonResponse({
        id: exposureId,
        title: `Exposure ${exposureId}`,
        date: '2024-01-15',
        source: 'sample.example',
        dataClasses: ['Passwords'],
        entries: 1,
        description: 'test',
      });
    };
    const result = await worker.scanAllUsersEnzoicOnce({ httpFetch });
    assert.equal(result.users_checked, 3);
    assert.equal(result.new_findings, 3);

    // Verify each user got THEIR exposure — not the one positional
    // pairing would have assigned (which would have given user-a
    // the 'exp-for-c' breach, etc).
    const findingForA = fakeFindings.find((f) => f.user_id === 'user-a');
    const findingForB = fakeFindings.find((f) => f.user_id === 'user-b');
    const findingForC = fakeFindings.find((f) => f.user_id === 'user-c');
    assert.ok(findingForA);
    assert.ok(findingForB);
    assert.ok(findingForC);
    const breachA = fakeBreaches.find((b) => b.id === findingForA!.breach_id);
    const breachB = fakeBreaches.find((b) => b.id === findingForB!.breach_id);
    const breachC = fakeBreaches.find((b) => b.id === findingForC!.breach_id);
    assert.equal(breachA!.source_breach_id, 'exp-for-a');
    assert.equal(breachB!.source_breach_id, 'exp-for-b');
    assert.equal(breachC!.source_breach_id, 'exp-for-c');
  });

  it('I-H3: Enzoic skips one username in a 3-user batch → other 2 users still pair correctly', async () => {
    fakeMonitors.push(
      {
        id: 'm-a',
        user_id: 'user-a',
        monitor_kind: 'email',
        watched_value: 'a@example.com',
        active: true,
      },
      {
        id: 'm-b',
        user_id: 'user-b',
        monitor_kind: 'email',
        watched_value: 'b@example.com',
        active: true,
      },
      {
        id: 'm-c',
        user_id: 'user-c',
        monitor_kind: 'email',
        watched_value: 'c@example.com',
        active: true,
      },
    );
    const httpFetch = async (url: RequestInfo | URL): Promise<Response> => {
      if (String(url).includes('usernames=')) {
        // Enzoic SKIPS user-b from the response. Positional pairing
        // would have mis-attributed user-c's exposure to user-b.
        // Username pairing correctly attributes each.
        return jsonResponse([
          { username: 'a@example.com', count: 1, exposures: ['exp-for-a'] },
          { username: 'c@example.com', count: 1, exposures: ['exp-for-c'] },
        ]);
      }
      const u = String(url);
      const exposureId = u.includes('exp-for-a') ? 'exp-for-a' : 'exp-for-c';
      return jsonResponse({
        id: exposureId,
        title: `Exposure ${exposureId}`,
        date: '2024-01-15',
        source: 'sample.example',
        dataClasses: ['Passwords'],
        entries: 1,
        description: 'test',
      });
    };
    const result = await worker.scanAllUsersEnzoicOnce({ httpFetch });
    assert.equal(result.new_findings, 2);

    // user-a + user-c get their findings; user-b gets NONE (Enzoic
    // didn't return data for them).
    assert.ok(fakeFindings.some((f) => f.user_id === 'user-a'));
    assert.ok(fakeFindings.some((f) => f.user_id === 'user-c'));
    assert.ok(!fakeFindings.some((f) => f.user_id === 'user-b'));

    // Each finding maps to the correct exposure.
    const findingA = fakeFindings.find((f) => f.user_id === 'user-a');
    const findingC = fakeFindings.find((f) => f.user_id === 'user-c');
    const breachA = fakeBreaches.find((b) => b.id === findingA!.breach_id);
    const breachC = fakeBreaches.find((b) => b.id === findingC!.breach_id);
    assert.equal(breachA!.source_breach_id, 'exp-for-a');
    assert.equal(breachC!.source_breach_id, 'exp-for-c');
  });

  it('I-H3: Enzoic returns entries with NO username field → no findings inserted (safer than guessing)', async () => {
    fakeMonitors.push(
      {
        id: 'm-a',
        user_id: 'user-a',
        monitor_kind: 'email',
        watched_value: 'a@example.com',
        active: true,
      },
      {
        id: 'm-b',
        user_id: 'user-b',
        monitor_kind: 'email',
        watched_value: 'b@example.com',
        active: true,
      },
    );
    const httpFetch = async (url: RequestInfo | URL): Promise<Response> => {
      if (String(url).includes('usernames=')) {
        // Schema-drift: no username field at all.
        return jsonResponse([
          { count: 1, exposures: ['exp-a'] },
          { count: 1, exposures: ['exp-b'] },
        ]);
      }
      throw new Error('detail call should not happen — schema-drift refused insert');
    };
    const result = await worker.scanAllUsersEnzoicOnce({ httpFetch });
    assert.equal(result.new_findings, 0);
    assert.equal(fakeFindings.length, 0);
  });

  // ──────────────────────────────────────────────────────────────
  // I-M2 — per-day user cap respected
  // ──────────────────────────────────────────────────────────────

  it('I-M2: ENZOIC_DAILY_USER_CAP=2 with 5 users → only 2 are scanned in one pass', async () => {
    (config as { ENZOIC_DAILY_USER_CAP?: number }).ENZOIC_DAILY_USER_CAP = 2;
    try {
      for (let i = 0; i < 5; i++) {
        fakeMonitors.push({
          id: `m-${i}`,
          user_id: `user-${i}`,
          monitor_kind: 'email',
          watched_value: `u${i}@example.com`,
          active: true,
        });
      }
      const sampledUsernames: string[] = [];
      const httpFetch = async (url: RequestInfo | URL): Promise<Response> => {
        const u = String(url);
        if (u.includes('usernames=')) {
          // Capture which usernames were sent in the batch URL.
          const matches = u.match(/usernames=([^&]+)/g) ?? [];
          for (const m of matches) {
            sampledUsernames.push(decodeURIComponent(m.replace('usernames=', '')));
          }
          // Empty exposures so no findings are created — we only
          // care about WHICH users get sampled.
          return jsonResponse(
            sampledUsernames.slice(-matches.length).map((un) => ({
              username: un,
              count: 0,
              exposures: [],
            })),
          );
        }
        return new Response('not found', { status: 404 });
      };
      const result = await worker.scanAllUsersEnzoicOnce({ httpFetch });
      // users_checked counts the unique users that made it past the
      // cap — must be exactly the cap value.
      assert.equal(result.users_checked, 2);
      // The set of sampled usernames is some 2-of-5 subset.
      const uniqueSampled = new Set(sampledUsernames);
      assert.equal(uniqueSampled.size, 2);
    } finally {
      (config as { ENZOIC_DAILY_USER_CAP?: number }).ENZOIC_DAILY_USER_CAP = undefined;
    }
  });

  it('I-M2: no cap set → all users scanned', async () => {
    (config as { ENZOIC_DAILY_USER_CAP?: number }).ENZOIC_DAILY_USER_CAP = undefined;
    for (let i = 0; i < 4; i++) {
      fakeMonitors.push({
        id: `m-${i}`,
        user_id: `user-${i}`,
        monitor_kind: 'email',
        watched_value: `u${i}@example.com`,
        active: true,
      });
    }
    const httpFetch = async (url: RequestInfo | URL): Promise<Response> => {
      if (String(url).includes('usernames=')) {
        const u = String(url);
        const matches = u.match(/usernames=([^&]+)/g) ?? [];
        return jsonResponse(
          matches.map((m) => ({
            username: decodeURIComponent(m.replace('usernames=', '')),
            count: 0,
            exposures: [],
          })),
        );
      }
      return new Response('not found', { status: 404 });
    };
    const result = await worker.scanAllUsersEnzoicOnce({ httpFetch });
    assert.equal(result.users_checked, 4);
  });
});

// ────────────────────────────────────────────────────────────────
// 10+11+12 — scanAllUsersHibpOnce, isolation, idempotency
// ────────────────────────────────────────────────────────────────

describe('scanAllUsersHibpOnce', () => {
  it('iterates over every user with an active email monitor', async () => {
    fakeMonitors.push(
      {
        id: 'm-a',
        user_id: 'user-a',
        monitor_kind: 'email',
        watched_value: 'multi-a@example.com',
        active: true,
      },
      {
        id: 'm-b',
        user_id: 'user-b',
        monitor_kind: 'email',
        watched_value: 'multi-b@example.com',
        active: true,
      },
    );
    const httpFetch = async (url: RequestInfo | URL): Promise<Response> => {
      // Return a single breach for whichever email is queried.
      const u = String(url);
      if (u.includes('multi-a')) return jsonResponse([hibpBreach({ Name: 'LinkedIn' })]);
      if (u.includes('multi-b')) return jsonResponse([hibpBreach({ Name: 'Adobe' })]);
      return new Response('Not Found', { status: 404 });
    };
    const result = await worker.scanAllUsersHibpOnce({ httpFetch });
    assert.equal(result.users_checked, 2);
    assert.equal(result.new_findings, 2);
  });

  it('cross-user isolation — A\'s breach finding never appears under B', async () => {
    fakeMonitors.push(
      {
        id: 'm-a',
        user_id: 'user-a',
        monitor_kind: 'email',
        watched_value: 'iso-a@example.com',
        active: true,
      },
      {
        id: 'm-b',
        user_id: 'user-b',
        monitor_kind: 'email',
        watched_value: 'iso-b@example.com',
        active: true,
      },
    );
    // A's email shows up in a breach; B's is clean.
    const httpFetch = async (url: RequestInfo | URL): Promise<Response> => {
      const u = String(url);
      if (u.includes('iso-a')) return jsonResponse([hibpBreach({ Name: 'LinkedIn' })]);
      return new Response('Not Found', { status: 404 });
    };
    await worker.scanAllUsersHibpOnce({ httpFetch });
    assert.equal(fakeFindings.length, 1);
    assert.equal(fakeFindings[0]!.user_id, 'user-a');
    assert.equal(fakeFindings[0]!.monitor_id, 'm-a');
    // No B finding regardless of severity.
    assert.ok(!fakeFindings.some((f) => f.user_id === 'user-b'));
  });

  it('re-running is idempotent — 0 new findings on the second pass', async () => {
    fakeMonitors.push({
      id: 'm-a',
      user_id: 'user-a',
      monitor_kind: 'email',
      watched_value: 'idem@example.com',
      active: true,
    });
    const httpFetch = async (): Promise<Response> =>
      jsonResponse([hibpBreach({ Name: 'LinkedIn' })]);
    const first = await worker.scanAllUsersHibpOnce({ httpFetch });
    assert.equal(first.new_findings, 1);
    const second = await worker.scanAllUsersHibpOnce({ httpFetch });
    assert.equal(second.new_findings, 0);
    assert.equal(fakeFindings.length, 1);
  });
});
