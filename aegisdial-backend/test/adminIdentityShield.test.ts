import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Identity Shield — I-P7 — admin dashboard + intel-source health +
// candidate-queue tests.
//
// Same env-before-import + pool.query monkeypatch pattern that
// adminEmailShield.test.ts and adminRecoveryShield.test.ts use. Each
// route's SQL is matched against an in-memory shape inside a
// regex-prefixed branch; mutations execute against the same in-memory
// store so the approve / reject tests can verify state transitions.
//
// Coverage matrix per route (10 routes; ~30 tests):
//   - 200 happy path
//   - 200 empty-data path
//   - 401 missing bearer
//   - 401 wrong bearer
//   - PII-leak guard (no user_id, no plaintext threat_value unless
//     explicitly opted in)
// Plus mutation-specific:
//   - approve happy path → channel inserted + candidate updated
//   - approve idempotent → 409 on already-decided
//   - approve on handle collision → 409
//   - reject happy path → reason stored in rationale
//   - reject after approve → terminal-state 409 (does NOT undo)

process.env.DATA_ENCRYPTION_KEY ||=
  'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-admin-identity-shield-secret';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://admin-identity-shield-test';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { adminIdentityShieldRoutes } = await import(
  '../src/routes/adminIdentityShield.ts'
);

const SHARED_SECRET = process.env.API_SHARED_SECRET!;

// -----------------------------------------------------------------
// Stable UUIDs for fixtures
// -----------------------------------------------------------------
const CANDIDATE_PENDING_ID = '11111111-1111-1111-1111-111111111111';
const CANDIDATE_PENDING_2_ID = '22222222-2222-2222-2222-222222222222';
const CANDIDATE_APPROVED_ID = '33333333-3333-3333-3333-333333333333';
const CANDIDATE_REJECTED_ID = '44444444-4444-4444-4444-444444444444';
const CANDIDATE_COLLIDE_ID = '55555555-5555-5555-5555-555555555555';
const BRIEFING_LATEST_ID = '66666666-6666-6666-6666-666666666666';
const BRIEFING_OLDER_ID = '77777777-7777-7777-7777-777777777777';
const CHANNEL_EXISTING_ID = '88888888-8888-8888-8888-888888888888';
const NEW_CHANNEL_INSERTED_ID = '99999999-9999-9999-9999-999999999999';

// -----------------------------------------------------------------
// In-memory state
// -----------------------------------------------------------------

interface MonitorRow {
  user_id: string;
  monitor_kind: string;
  active: boolean;
}
interface FindingRow {
  severity: 'informational' | 'caution' | 'critical';
  surfaced_at: Date;
}
interface ActiveThreatRow {
  severity: string;
  threat_kind: string;
  threat_value: string;
  provenance: string;
  last_seen_at: Date;
  expires_at: Date | null;
}
interface MetricRow {
  name: string;
  bucket: Date;
}
interface ChannelRow {
  id: string;
  source_kind: 'telegram' | 'darknet_market';
  source_handle: string;
  display_name: string;
  status: string;
  capability_tags: string[];
  last_message_observed_at: Date | null;
  classified_message_count_7d: number;
}
interface CandidateDbRow {
  id: string;
  source_kind: 'telegram' | 'darknet_market';
  source_handle: string;
  discovered_at: Date;
  rationale: Record<string, unknown>;
  candidate_score: number;
  decision: string | null;
  decided_at: Date | null;
}
interface BriefingRow {
  id: string;
  period_start: Date;
  period_end: Date;
  generated_at: Date;
  body_markdown: string;
  metrics_jsonb: Record<string, unknown>;
}
interface DbState {
  monitors: MonitorRow[];
  findings: FindingRow[];
  active_threats: ActiveThreatRow[];
  metrics: MetricRow[];
  channels: ChannelRow[];
  candidates: CandidateDbRow[];
  briefings: BriefingRow[];
  /** Tracks whether a withTx has rolled back — verified by tests. */
  txAborted: boolean;
  /** Force a unique_violation on the next channel insert (for collision test). */
  forceChannelCollision: boolean;
}

const dbState: DbState = {
  monitors: [],
  findings: [],
  active_threats: [],
  metrics: [],
  channels: [],
  candidates: [],
  briefings: [],
  txAborted: false,
  forceChannelCollision: false,
};

function resetDb(): void {
  dbState.monitors.length = 0;
  dbState.findings.length = 0;
  dbState.active_threats.length = 0;
  dbState.metrics.length = 0;
  dbState.channels.length = 0;
  dbState.candidates.length = 0;
  dbState.briefings.length = 0;
  dbState.txAborted = false;
  dbState.forceChannelCollision = false;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}
function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 60 * 1000);
}
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// -----------------------------------------------------------------
// Shared SQL prefix matcher. Used by both pool.query and the client
// returned by withTx — they share state and behavior.
// -----------------------------------------------------------------
function runQuery(
  text: string,
  params: unknown[] = [],
): { rows: unknown[]; rowCount: number } {
  const t = text.replace(/\s+/g, ' ').trim();

  // ---- monitors_by_kind --------------------------------------------
  if (
    /FROM identity_monitors WHERE active GROUP BY monitor_kind/i.test(t)
  ) {
    const counts: Record<string, number> = {};
    for (const m of dbState.monitors) {
      if (!m.active) continue;
      counts[m.monitor_kind] = (counts[m.monitor_kind] ?? 0) + 1;
    }
    return {
      rows: Object.entries(counts).map(([monitor_kind, count]) => ({
        monitor_kind,
        count: String(count),
      })),
      rowCount: Object.keys(counts).length,
    };
  }

  // ---- findings 7d + 30d by severity --------------------------------
  if (
    /FROM identity_breach_findings WHERE surfaced_at >= NOW\(\) - INTERVAL '30 days'/i.test(
      t,
    ) &&
    /COUNT\(\*\) FILTER \(WHERE surfaced_at >= NOW\(\) - INTERVAL '7 days'\)/i.test(t)
  ) {
    const cutoff7 = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const cutoff30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const per: Record<string, { c7: number; c30: number }> = {};
    for (const f of dbState.findings) {
      if (f.surfaced_at.getTime() < cutoff30) continue;
      const slot = per[f.severity] ?? { c7: 0, c30: 0 };
      slot.c30++;
      if (f.surfaced_at.getTime() >= cutoff7) slot.c7++;
      per[f.severity] = slot;
    }
    return {
      rows: Object.entries(per).map(([severity, v]) => ({
        severity,
        count_7d: String(v.c7),
        count_30d: String(v.c30),
      })),
      rowCount: Object.keys(per).length,
    };
  }

  // ---- active_threats by severity (live snapshot) -------------------
  if (
    /SELECT severity, COUNT\(\*\)::TEXT AS count FROM active_threats WHERE \(expires_at IS NULL OR expires_at > NOW\(\)\) GROUP BY severity/i.test(
      t,
    )
  ) {
    const now = Date.now();
    const counts: Record<string, number> = {};
    for (const a of dbState.active_threats) {
      if (a.expires_at !== null && a.expires_at.getTime() <= now) continue;
      counts[a.severity] = (counts[a.severity] ?? 0) + 1;
    }
    return {
      rows: Object.entries(counts).map(([severity, count]) => ({
        severity,
        count: String(count),
      })),
      rowCount: Object.keys(counts).length,
    };
  }

  // ---- intel heartbeat (metric_counters MAX(bucket) per name) ------
  if (
    /SELECT name, MAX\(bucket\) AS latest FROM metric_counters WHERE name IN/i.test(
      t,
    ) &&
    /identity_shield\.hibp_sync/i.test(t)
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const latestByName = new Map<string, Date>();
    for (const m of dbState.metrics) {
      if (m.bucket.getTime() < cutoff) continue;
      const prev = latestByName.get(m.name);
      if (!prev || m.bucket.getTime() > prev.getTime()) {
        latestByName.set(m.name, m.bucket);
      }
    }
    return {
      rows: Array.from(latestByName.entries()).map(([name, latest]) => ({
        name,
        latest,
      })),
      rowCount: latestByName.size,
    };
  }

  // ---- breaches timeline (daily buckets) ---------------------------
  if (
    /date_trunc\('day', surfaced_at AT TIME ZONE 'UTC'\) AS bucket/i.test(t)
  ) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    type Bucket = { bucket: Date; total: number; informational: number; caution: number; critical: number };
    const buckets = new Map<string, Bucket>();
    for (const f of dbState.findings) {
      if (f.surfaced_at.getTime() < cutoff) continue;
      const d = utcMidnight(f.surfaced_at);
      const k = d.toISOString();
      const slot = buckets.get(k) ?? {
        bucket: d, total: 0, informational: 0, caution: 0, critical: 0,
      };
      slot.total++;
      slot[f.severity]++;
      buckets.set(k, slot);
    }
    const rows = Array.from(buckets.values())
      .sort((a, b) => a.bucket.getTime() - b.bucket.getTime())
      .slice(0, 30)
      .map((b) => ({
        bucket: b.bucket,
        total: String(b.total),
        informational: String(b.informational),
        caution: String(b.caution),
        critical: String(b.critical),
      }));
    return { rows, rowCount: rows.length };
  }

  // ---- active_threats by provenance (group by raw provenance) ------
  if (
    /SELECT provenance, COUNT\(\*\)::TEXT AS count FROM active_threats WHERE \(expires_at IS NULL OR expires_at > NOW\(\)\) GROUP BY provenance/i.test(
      t,
    )
  ) {
    const now = Date.now();
    const counts: Record<string, number> = {};
    for (const a of dbState.active_threats) {
      if (a.expires_at !== null && a.expires_at.getTime() <= now) continue;
      counts[a.provenance] = (counts[a.provenance] ?? 0) + 1;
    }
    return {
      rows: Object.entries(counts).map(([provenance, count]) => ({
        provenance,
        count: String(count),
      })),
      rowCount: Object.keys(counts).length,
    };
  }

  // ---- active_threats sample values (ORDER BY last_seen_at DESC) ---
  if (
    /SELECT severity, provenance, threat_value FROM active_threats WHERE \(expires_at IS NULL OR expires_at > NOW\(\)\) ORDER BY last_seen_at DESC LIMIT 500/i.test(
      t,
    )
  ) {
    const now = Date.now();
    const rows = dbState.active_threats
      .filter((a) => a.expires_at === null || a.expires_at.getTime() > now)
      .sort((a, b) => b.last_seen_at.getTime() - a.last_seen_at.getTime())
      .slice(0, 500)
      .map((a) => ({
        severity: a.severity,
        provenance: a.provenance,
        threat_value: a.threat_value,
      }));
    return { rows, rowCount: rows.length };
  }

  // ---- intel-source health (channels LEFT JOIN derived) ------------
  if (
    /FROM threat_intel_channels c LEFT JOIN/i.test(t) &&
    /WHERE c\.status NOT IN \('removed', 'honeypot'\)/i.test(t)
  ) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // derived: source_id → count
    const derived = new Map<string, { kindPrefix: string; count: number }>();
    for (const a of dbState.active_threats) {
      if (a.last_seen_at.getTime() < cutoff) continue;
      const colon = a.provenance.indexOf(':');
      if (colon === -1) continue;
      const prefix = a.provenance.slice(0, colon);
      if (prefix !== 'telegram_channel' && prefix !== 'darknet_market') continue;
      const after = a.provenance.slice(colon + 1);
      const colon2 = after.indexOf(':');
      const sourceId = colon2 === -1 ? after : after.slice(0, colon2);
      const key = `${prefix}:${sourceId}`;
      const slot = derived.get(key) ?? { kindPrefix: prefix, count: 0 };
      slot.count++;
      derived.set(key, slot);
    }
    const rows = dbState.channels
      .filter((c) => c.status !== 'removed' && c.status !== 'honeypot')
      .sort((a, b) => {
        if (a.status !== b.status) return a.status.localeCompare(b.status);
        if (b.classified_message_count_7d !== a.classified_message_count_7d) {
          return b.classified_message_count_7d - a.classified_message_count_7d;
        }
        return a.source_handle.localeCompare(b.source_handle);
      })
      .slice(0, 200)
      .map((c) => {
        const prefix = c.source_kind === 'telegram' ? 'telegram_channel' : 'darknet_market';
        const slot = derived.get(`${prefix}:${c.id}`);
        return {
          id: c.id,
          source_kind: c.source_kind,
          source_handle: c.source_handle,
          display_name: c.display_name,
          status: c.status,
          last_message_observed_at: c.last_message_observed_at,
          classified_message_count_7d: c.classified_message_count_7d,
          active_threats_produced_7d: String(slot?.count ?? 0),
        };
      });
    return { rows, rowCount: rows.length };
  }

  // ---- candidates list ---------------------------------------------
  if (
    /FROM threat_intel_candidates WHERE decision IS NULL/i.test(t) ||
    /FROM threat_intel_candidates WHERE decision = 'approved'/i.test(t) ||
    /FROM threat_intel_candidates WHERE decision = 'rejected'/i.test(t)
  ) {
    let filter: (c: CandidateDbRow) => boolean;
    if (/decision IS NULL/i.test(t)) filter = (c) => c.decision === null;
    else if (/decision = 'approved'/i.test(t)) filter = (c) => c.decision === 'approved';
    else filter = (c) => c.decision === 'rejected';

    // source_kind filter is the LAST string param when sourceKindClause
    // was appended; limit is always the LAST integer param.
    const limit = typeof params[params.length - 1] === 'number'
      ? (params[params.length - 1] as number)
      : 50;
    const sourceKind = params.length > 1 && typeof params[0] === 'string'
      ? (params[0] as string)
      : null;

    const rows = dbState.candidates
      .filter(filter)
      .filter((c) => !sourceKind || c.source_kind === sourceKind)
      .sort((a, b) => {
        if (b.candidate_score !== a.candidate_score) {
          return b.candidate_score - a.candidate_score;
        }
        return b.discovered_at.getTime() - a.discovered_at.getTime();
      })
      .slice(0, limit)
      .map((c) => ({
        id: c.id,
        source_kind: c.source_kind,
        source_handle: c.source_handle,
        discovered_at: c.discovered_at,
        rationale: c.rationale,
        candidate_score: String(c.candidate_score),
        decision: c.decision,
        decided_at: c.decided_at,
      }));
    return { rows, rowCount: rows.length };
  }

  // ---- candidate SELECT FOR UPDATE (approve / reject) --------------
  if (
    /SELECT id::TEXT, source_kind, source_handle, rationale, decision FROM threat_intel_candidates WHERE id = \$1 FOR UPDATE/i.test(
      t,
    )
  ) {
    const id = params[0] as string;
    const cand = dbState.candidates.find((c) => c.id === id);
    if (!cand) return { rows: [], rowCount: 0 };
    return {
      rows: [
        {
          id: cand.id,
          source_kind: cand.source_kind,
          source_handle: cand.source_handle,
          rationale: cand.rationale,
          decision: cand.decision,
        },
      ],
      rowCount: 1,
    };
  }
  if (
    /SELECT id::TEXT, rationale, decision FROM threat_intel_candidates WHERE id = \$1 FOR UPDATE/i.test(
      t,
    )
  ) {
    const id = params[0] as string;
    const cand = dbState.candidates.find((c) => c.id === id);
    if (!cand) return { rows: [], rowCount: 0 };
    return {
      rows: [
        {
          id: cand.id,
          rationale: cand.rationale,
          decision: cand.decision,
        },
      ],
      rowCount: 1,
    };
  }

  // ---- channel insert (approve path) -------------------------------
  if (
    /INSERT INTO threat_intel_channels.*RETURNING id::TEXT AS id/is.test(t)
  ) {
    const [source_kind, source_handle, display_name] = params as [
      'telegram' | 'darknet_market',
      string,
      string,
    ];
    if (dbState.forceChannelCollision) {
      // Simulate pg unique_violation
      const err = new Error('duplicate key value violates unique constraint') as Error & { code: string };
      err.code = '23505';
      throw err;
    }
    const collision = dbState.channels.find(
      (c) => c.source_kind === source_kind && c.source_handle === source_handle,
    );
    if (collision) {
      const err = new Error('duplicate key value violates unique constraint') as Error & { code: string };
      err.code = '23505';
      throw err;
    }
    const id = NEW_CHANNEL_INSERTED_ID;
    dbState.channels.push({
      id,
      source_kind,
      source_handle,
      display_name,
      status: 'active',
      capability_tags: [],
      last_message_observed_at: null,
      classified_message_count_7d: 0,
    });
    return { rows: [{ id }], rowCount: 1 };
  }

  // ---- candidate UPDATE decision='approved' ------------------------
  if (
    /UPDATE threat_intel_candidates SET decision = 'approved'/i.test(t)
  ) {
    const id = params[0] as string;
    const cand = dbState.candidates.find((c) => c.id === id);
    if (!cand) return { rows: [], rowCount: 0 };
    cand.decision = 'approved';
    cand.decided_at = new Date();
    return { rows: [], rowCount: 1 };
  }

  // ---- candidate UPDATE decision='rejected' ------------------------
  if (
    /UPDATE threat_intel_candidates SET decision = 'rejected'/i.test(t)
  ) {
    const id = params[0] as string;
    const rationale = params[1] as string;
    const cand = dbState.candidates.find((c) => c.id === id);
    if (!cand) return { rows: [], rowCount: 0 };
    cand.decision = 'rejected';
    cand.decided_at = new Date();
    cand.rationale = JSON.parse(rationale);
    return { rows: [], rowCount: 1 };
  }

  // ---- briefings: latest --------------------------------------------
  if (
    /FROM threat_landscape_briefings ORDER BY generated_at DESC LIMIT 1/i.test(t)
  ) {
    const rows = dbState.briefings
      .slice()
      .sort((a, b) => b.generated_at.getTime() - a.generated_at.getTime())
      .slice(0, 1)
      .map((b) => ({
        id: b.id,
        period_start: b.period_start,
        period_end: b.period_end,
        generated_at: b.generated_at,
        body_markdown: b.body_markdown,
        metrics_jsonb: b.metrics_jsonb,
      }));
    return { rows, rowCount: rows.length };
  }

  // ---- briefings: list (with limit) --------------------------------
  if (
    /SELECT id::TEXT, period_start, period_end, generated_at FROM threat_landscape_briefings ORDER BY generated_at DESC LIMIT \$1/i.test(
      t,
    )
  ) {
    const limit = params[0] as number;
    const rows = dbState.briefings
      .slice()
      .sort((a, b) => b.generated_at.getTime() - a.generated_at.getTime())
      .slice(0, limit)
      .map((b) => ({
        id: b.id,
        period_start: b.period_start,
        period_end: b.period_end,
        generated_at: b.generated_at,
      }));
    return { rows, rowCount: rows.length };
  }

  // ---- briefing by id ----------------------------------------------
  if (
    /FROM threat_landscape_briefings WHERE id = \$1 LIMIT 1/i.test(t)
  ) {
    const id = params[0] as string;
    const found = dbState.briefings.find((b) => b.id === id);
    if (!found) return { rows: [], rowCount: 0 };
    return {
      rows: [
        {
          id: found.id,
          period_start: found.period_start,
          period_end: found.period_end,
          generated_at: found.generated_at,
          body_markdown: found.body_markdown,
          metrics_jsonb: found.metrics_jsonb,
        },
      ],
      rowCount: 1,
    };
  }

  // ---- metric_counters INSERT from emitMetric / withAdminAudit -----
  if (/INSERT\s+INTO\s+metric_counters/i.test(t)) {
    return { rows: [], rowCount: 0 };
  }

  // ---- BEGIN / COMMIT / ROLLBACK from withTx -----------------------
  if (/^BEGIN/i.test(t)) return { rows: [], rowCount: 0 };
  if (/^COMMIT/i.test(t)) return { rows: [], rowCount: 0 };
  if (/^ROLLBACK/i.test(t)) {
    dbState.txAborted = true;
    return { rows: [], rowCount: 0 };
  }

  if (process.env.DEBUG_ADMIN_TEST) {
    // eslint-disable-next-line no-console
    console.warn('[unmatched SQL]', t.slice(0, 200));
  }
  return { rows: [], rowCount: 0 };
}

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => runQuery(text, params);

// Pool exposes both `query` and `connect()`. Stub both so withTx() can
// route through the same runQuery() path.
const fakeClient = {
  query: fakeQuery,
  release: () => {},
};
(db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
(db.pool as unknown as { connect: () => Promise<typeof fakeClient> }).connect =
  async () => fakeClient;

const app = Fastify({ logger: false });
await app.register(adminIdentityShieldRoutes);
await app.ready();

const bearer = { authorization: `Bearer ${SHARED_SECRET}` };

// -----------------------------------------------------------------
// PII-leak guard: a recursive walker. Asserts no per-user field keys
// appear anywhere. `threat_value` IS allowed in the
// /active-threats-distribution body ONLY when include_values=true was
// explicitly requested — the gating is enforced via test-by-test
// inspection rather than a global rule.
// -----------------------------------------------------------------
const FORBIDDEN_KEYS = new Set([
  'user_id',
  'apple_transaction_id',
  'apple_receipt_data',
  'contact_email',
  'contact_phone',
  'watched_value',
  'salt_hex',
]);

function assertNoPii(value: unknown, path = '$'): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoPii(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) {
        assert.fail(`PII leak: forbidden key '${k}' at ${path}`);
      }
      assertNoPii(v, `${path}.${k}`);
    }
  }
}

before(() => {
  resetDb();
});
beforeEach(() => {
  resetDb();
});

// =================================================================
// 1. /v1/admin/identity-shield/summary
// =================================================================
describe('GET /v1/admin/identity-shield/summary', () => {
  it('returns aggregate counters across monitors, findings, threats, heartbeat', async () => {
    dbState.monitors.push(
      { user_id: 'u1', monitor_kind: 'email', active: true },
      { user_id: 'u1', monitor_kind: 'phone_e164', active: true },
      { user_id: 'u2', monitor_kind: 'email', active: true },
      { user_id: 'u3', monitor_kind: 'ssn_last4_hash', active: true },
      { user_id: 'u3', monitor_kind: 'email', active: false }, // inactive, excluded
    );
    dbState.findings.push(
      { severity: 'informational', surfaced_at: daysAgo(1) },
      { severity: 'caution', surfaced_at: daysAgo(3) },
      { severity: 'critical', surfaced_at: daysAgo(2) },
      { severity: 'critical', surfaced_at: daysAgo(15) }, // not in 7d, in 30d
      { severity: 'caution', surfaced_at: daysAgo(45) }, // out of window
    );
    dbState.active_threats.push(
      {
        severity: 'confirmed_scammer',
        threat_kind: 'phone_e164',
        threat_value: '+15551234567',
        provenance: 'aegisdial_recovery:abc',
        last_seen_at: daysAgo(1),
        expires_at: null,
      },
      {
        severity: 'caution',
        threat_kind: 'phone_e164',
        threat_value: '+15559876543',
        provenance: 'telegram_channel:c1:m1',
        last_seen_at: daysAgo(1),
        expires_at: new Date(Date.now() + 30 * 86400 * 1000),
      },
      {
        // expired — excluded
        severity: 'informational',
        threat_kind: 'email_address',
        threat_value: 'x@y.com',
        provenance: 'hibp:LinkedIn',
        last_seen_at: daysAgo(60),
        expires_at: daysAgo(1),
      },
    );
    dbState.metrics.push(
      { name: 'identity_shield.hibp_sync', bucket: daysAgo(1) },
      { name: 'identity_shield.hibp_sync', bucket: daysAgo(5) },
      { name: 'identity_shield.telegram_poll', bucket: hoursAgo(2) },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/summary',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      monitors_active_total: number;
      monitors_by_kind: Record<string, number>;
      findings_7d_by_severity: Record<string, number>;
      findings_30d_by_severity: Record<string, number>;
      active_threats_by_severity: Record<string, number>;
      intel_ingest_health: {
        last_hibp_sync_at: string | null;
        last_enzoic_sync_at: string | null;
        last_telegram_poll_at: string | null;
        last_darknet_crawl_at: string | null;
      };
    };
    assert.equal(body.monitors_active_total, 4, 'inactive monitor excluded');
    assert.equal(body.monitors_by_kind.email, 2);
    assert.equal(body.monitors_by_kind.phone_e164, 1);
    assert.equal(body.monitors_by_kind.ssn_last4_hash, 1);
    assert.equal(body.monitors_by_kind.dob_hash, 0);
    assert.equal(body.findings_7d_by_severity.informational, 1);
    assert.equal(body.findings_7d_by_severity.caution, 1);
    assert.equal(body.findings_7d_by_severity.critical, 1);
    assert.equal(body.findings_30d_by_severity.critical, 2);
    assert.equal(body.findings_30d_by_severity.caution, 1, '45d-ago row excluded');
    assert.equal(body.active_threats_by_severity.confirmed_scammer, 1);
    assert.equal(body.active_threats_by_severity.caution, 1);
    assert.equal(body.active_threats_by_severity.informational, 0, 'expired excluded');
    assert.ok(body.intel_ingest_health.last_hibp_sync_at, 'hibp heartbeat present');
    assert.ok(body.intel_ingest_health.last_telegram_poll_at, 'telegram heartbeat present');
    assert.equal(body.intel_ingest_health.last_enzoic_sync_at, null, 'enzoic null when no metric');
    assert.equal(body.intel_ingest_health.last_darknet_crawl_at, null);
    assertNoPii(body);
  });

  it('returns zeros gracefully when no data exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/summary',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      monitors_active_total: number;
      monitors_by_kind: Record<string, number>;
      findings_7d_by_severity: Record<string, number>;
      active_threats_by_severity: Record<string, number>;
      intel_ingest_health: Record<string, string | null>;
    };
    assert.equal(body.monitors_active_total, 0);
    for (const v of Object.values(body.monitors_by_kind)) assert.ok(Number.isFinite(v));
    for (const v of Object.values(body.findings_7d_by_severity)) assert.ok(Number.isFinite(v));
    for (const v of Object.values(body.active_threats_by_severity)) assert.ok(Number.isFinite(v));
    for (const v of Object.values(body.intel_ingest_health)) assert.equal(v, null);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/summary',
    });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { error: string }).error, 'missing_bearer');
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/summary',
      headers: { authorization: 'Bearer wrong-secret' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { error: string }).error, 'invalid_token');
  });
});

// =================================================================
// 2. /v1/admin/identity-shield/breaches-timeline
// =================================================================
describe('GET /v1/admin/identity-shield/breaches-timeline', () => {
  it('returns per-day buckets with severity sub-counts', async () => {
    dbState.findings.push(
      { severity: 'informational', surfaced_at: daysAgo(2) },
      { severity: 'critical', surfaced_at: daysAgo(2) },
      { severity: 'critical', surfaced_at: daysAgo(2) },
      { severity: 'caution', surfaced_at: daysAgo(5) },
      { severity: 'caution', surfaced_at: daysAgo(45) }, // excluded
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/breaches-timeline',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      days: Array<{
        date: string;
        findings_count: number;
        by_severity: { informational: number; caution: number; critical: number };
      }>;
      window_days: number;
      tz: string;
    };
    assert.equal(body.window_days, 30);
    assert.equal(body.tz, 'UTC');
    assert.equal(body.days.length, 2);
    // ascending
    assert.ok(body.days[0]!.date < body.days[1]!.date);
    const day2 = body.days[1]!;
    assert.equal(day2.findings_count, 3);
    assert.equal(day2.by_severity.critical, 2);
    assert.equal(day2.by_severity.informational, 1);
    assert.match(day2.date, /^\d{4}-\d{2}-\d{2}$/);
    assertNoPii(body);
  });

  it('returns empty days array when no findings in window', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/breaches-timeline',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { days: unknown[]; window_days: number };
    assert.deepEqual(body.days, []);
    assert.equal(body.window_days, 30);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/breaches-timeline',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/breaches-timeline',
      headers: { authorization: 'Bearer nope' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 3. /v1/admin/identity-shield/active-threats-distribution
// =================================================================
describe('GET /v1/admin/identity-shield/active-threats-distribution', () => {
  function seedThreats(): void {
    dbState.active_threats.push(
      {
        severity: 'confirmed_scammer',
        threat_kind: 'phone_e164',
        threat_value: '+15555550001',
        provenance: 'aegisdial_recovery:case-1',
        last_seen_at: hoursAgo(1),
        expires_at: null,
      },
      {
        severity: 'caution',
        threat_kind: 'phone_e164',
        threat_value: '+15555550002',
        provenance: 'telegram_channel:abc:msg1',
        last_seen_at: hoursAgo(2),
        expires_at: new Date(Date.now() + 30 * 86400 * 1000),
      },
      {
        severity: 'caution',
        threat_kind: 'email_address',
        threat_value: 'evil@scam.example',
        provenance: 'telegram_channel:abc:msg2',
        last_seen_at: hoursAgo(3),
        expires_at: new Date(Date.now() + 30 * 86400 * 1000),
      },
      {
        severity: 'warning',
        threat_kind: 'crypto_wallet',
        threat_value: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        provenance: 'darknet_market:xyz:listing-9',
        last_seen_at: hoursAgo(5),
        expires_at: new Date(Date.now() + 30 * 86400 * 1000),
      },
    );
  }

  it('returns severity + provenance distribution, default WITHOUT threat values', async () => {
    seedThreats();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/active-threats-distribution',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      by_severity: Record<string, number>;
      by_provenance: Array<{ provenance_prefix: string; count: number }>;
      include_values: boolean;
      by_severity_samples?: unknown;
      by_provenance_samples?: unknown;
    };
    assert.equal(body.by_severity.confirmed_scammer, 1);
    assert.equal(body.by_severity.caution, 2);
    assert.equal(body.by_severity.warning, 1);
    const prov = new Map(body.by_provenance.map((p) => [p.provenance_prefix, p.count]));
    assert.equal(prov.get('telegram_channel'), 2);
    assert.equal(prov.get('aegisdial_recovery'), 1);
    assert.equal(prov.get('darknet_market'), 1);
    assert.equal(body.include_values, false);
    assert.equal(body.by_severity_samples, undefined, 'samples absent by default');
    assert.equal(body.by_provenance_samples, undefined);

    // PII guard: ensure no threat_value made it into the response.
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('+15555550001'), 'no plaintext phone leak');
    assert.ok(!serialized.includes('evil@scam.example'), 'no plaintext email leak');
    assertNoPii(body);
  });

  it('returns threat values ONLY when include_values=true is explicitly opt-in', async () => {
    seedThreats();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/active-threats-distribution?include_values=true',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      include_values: boolean;
      by_severity_samples: Record<string, string[]>;
      by_provenance_samples: Record<string, string[]>;
    };
    assert.equal(body.include_values, true);
    assert.ok(body.by_severity_samples.confirmed_scammer?.includes('+15555550001'));
    assert.ok(body.by_provenance_samples.telegram_channel?.length! > 0);
    // Cap: never more than 5 per bucket
    for (const arr of Object.values(body.by_severity_samples)) {
      assert.ok(arr.length <= 5);
    }
  });

  it('returns empty distribution when no active threats', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/active-threats-distribution',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      by_severity: Record<string, number>;
      by_provenance: unknown[];
    };
    assert.equal(body.by_severity.confirmed_scammer, 0);
    assert.deepEqual(body.by_provenance, []);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/active-threats-distribution',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/active-threats-distribution',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 4. /v1/admin/identity-shield/intel-source-health
// =================================================================
describe('GET /v1/admin/identity-shield/intel-source-health', () => {
  it('returns per-channel health with derived 7d threat counts', async () => {
    dbState.channels.push(
      {
        id: 'ch-1',
        source_kind: 'telegram',
        source_handle: '@carding_pro',
        display_name: 'CardingPro',
        status: 'active',
        capability_tags: ['carding'],
        last_message_observed_at: hoursAgo(1),
        classified_message_count_7d: 42,
      },
      {
        id: 'ch-2',
        source_kind: 'darknet_market',
        source_handle: 'shadymarket.onion',
        display_name: 'ShadyMarket',
        status: 'dormant',
        capability_tags: [],
        last_message_observed_at: daysAgo(20),
        classified_message_count_7d: 0,
      },
      {
        id: 'ch-3',
        source_kind: 'telegram',
        source_handle: '@removed_chan',
        display_name: 'Removed',
        status: 'removed',
        capability_tags: [],
        last_message_observed_at: null,
        classified_message_count_7d: 0,
      },
    );
    dbState.active_threats.push(
      {
        severity: 'caution',
        threat_kind: 'phone_e164',
        threat_value: '+15555550010',
        provenance: 'telegram_channel:ch-1:msg-1',
        last_seen_at: hoursAgo(2),
        expires_at: new Date(Date.now() + 30 * 86400 * 1000),
      },
      {
        severity: 'caution',
        threat_kind: 'phone_e164',
        threat_value: '+15555550011',
        provenance: 'telegram_channel:ch-1:msg-2',
        last_seen_at: hoursAgo(3),
        expires_at: new Date(Date.now() + 30 * 86400 * 1000),
      },
      // too old to count
      {
        severity: 'caution',
        threat_kind: 'phone_e164',
        threat_value: '+15555550012',
        provenance: 'telegram_channel:ch-1:msg-3',
        last_seen_at: daysAgo(15),
        expires_at: new Date(Date.now() + 30 * 86400 * 1000),
      },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/intel-source-health',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      sources: Array<{
        id: string;
        source_kind: string;
        source_handle: string;
        status: string;
        active_threats_produced_7d: number;
        classified_message_count_7d: number;
      }>;
      window_days: number;
    };
    assert.equal(body.window_days, 7);
    assert.equal(body.sources.length, 2, 'removed channel excluded');
    const ch1 = body.sources.find((s) => s.id === 'ch-1')!;
    assert.equal(ch1.active_threats_produced_7d, 2, '15d-old row excluded');
    assert.equal(ch1.classified_message_count_7d, 42);
    const ch2 = body.sources.find((s) => s.id === 'ch-2')!;
    assert.equal(ch2.active_threats_produced_7d, 0);
    assertNoPii(body);
  });

  it('returns empty sources array when no channels exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/intel-source-health',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { sources: unknown[] };
    assert.deepEqual(body.sources, []);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/intel-source-health',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/identity-shield/intel-source-health',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 5. /v1/admin/intel/candidates
// =================================================================
describe('GET /v1/admin/intel/candidates', () => {
  function seedCandidates(): void {
    dbState.candidates.push(
      {
        id: CANDIDATE_PENDING_ID,
        source_kind: 'telegram',
        source_handle: '@new_carding',
        discovered_at: daysAgo(1),
        rationale: { analyst_rationales: ['Cited in 3 carding artifacts'] },
        candidate_score: 0.85,
        decision: null,
        decided_at: null,
      },
      {
        id: CANDIDATE_PENDING_2_ID,
        source_kind: 'darknet_market',
        source_handle: 'newmarket.onion',
        discovered_at: daysAgo(2),
        rationale: { analyst_rationales: ['Cited in 1 listing'] },
        candidate_score: 0.55,
        decision: null,
        decided_at: null,
      },
      {
        id: CANDIDATE_APPROVED_ID,
        source_kind: 'telegram',
        source_handle: '@approved',
        discovered_at: daysAgo(10),
        rationale: {},
        candidate_score: 0.9,
        decision: 'approved',
        decided_at: daysAgo(9),
      },
      {
        id: CANDIDATE_REJECTED_ID,
        source_kind: 'telegram',
        source_handle: '@rejected',
        discovered_at: daysAgo(11),
        rationale: { reject_reason: 'looks benign' },
        candidate_score: 0.4,
        decision: 'rejected',
        decided_at: daysAgo(10),
      },
    );
  }

  it('lists pending candidates by default, ordered by score desc', async () => {
    seedCandidates();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/candidates',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      candidates: Array<{ id: string; decision: string | null; candidate_score: number }>;
      count: number;
      limit: number;
    };
    assert.equal(body.count, 2);
    assert.equal(body.limit, 50);
    assert.equal(body.candidates[0]!.id, CANDIDATE_PENDING_ID, 'higher score first');
    assert.equal(body.candidates[0]!.candidate_score, 0.85);
    assert.ok(body.candidates.every((c) => c.decision === null));
    assertNoPii(body);
  });

  it('filters by source_kind when provided', async () => {
    seedCandidates();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/candidates?source_kind=darknet_market',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      candidates: Array<{ source_kind: string }>;
    };
    assert.equal(body.candidates.length, 1);
    assert.equal(body.candidates[0]!.source_kind, 'darknet_market');
  });

  it('filters by status=approved', async () => {
    seedCandidates();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/candidates?status=approved',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      candidates: Array<{ id: string; decision: string }>;
    };
    assert.equal(body.candidates.length, 1);
    assert.equal(body.candidates[0]!.decision, 'approved');
  });

  it('returns 400 on invalid status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/candidates?status=nope',
      headers: bearer,
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 on invalid source_kind', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/candidates?source_kind=signal',
      headers: bearer,
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns empty list when nothing pending', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/candidates',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { candidates: unknown[] };
    assert.deepEqual(body.candidates, []);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/candidates',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/candidates',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 6. POST /v1/admin/intel/candidates/:id/approve
// =================================================================
describe('POST /v1/admin/intel/candidates/:id/approve', () => {
  function seedPending(): void {
    dbState.candidates.push({
      id: CANDIDATE_PENDING_ID,
      source_kind: 'telegram',
      source_handle: '@to_approve',
      discovered_at: daysAgo(1),
      rationale: { sample: 'evidence' },
      candidate_score: 0.7,
      decision: null,
      decided_at: null,
    });
  }

  it('approves a pending candidate → inserts channel + updates decision', async () => {
    seedPending();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intel/candidates/${CANDIDATE_PENDING_ID}/approve`,
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      ok: boolean;
      candidate_id: string;
      channel_id: string;
      decision: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.decision, 'approved');
    assert.equal(body.candidate_id, CANDIDATE_PENDING_ID);
    assert.ok(body.channel_id);
    // State asserts
    const cand = dbState.candidates.find((c) => c.id === CANDIDATE_PENDING_ID)!;
    assert.equal(cand.decision, 'approved');
    assert.ok(cand.decided_at);
    const channel = dbState.channels.find((c) => c.source_handle === '@to_approve')!;
    assert.ok(channel);
    assert.equal(channel.status, 'active');
    assert.equal(channel.source_kind, 'telegram');
  });

  it('returns 409 when candidate already approved (idempotency)', async () => {
    dbState.candidates.push({
      id: CANDIDATE_APPROVED_ID,
      source_kind: 'telegram',
      source_handle: '@already_in',
      discovered_at: daysAgo(5),
      rationale: {},
      candidate_score: 0.9,
      decision: 'approved',
      decided_at: daysAgo(4),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intel/candidates/${CANDIDATE_APPROVED_ID}/approve`,
      headers: bearer,
    });
    assert.equal(res.statusCode, 409);
    const body = res.json() as { error: string; decision: string };
    assert.equal(body.error, 'candidate_already_decided');
    assert.equal(body.decision, 'approved');
  });

  it('returns 409 when candidate is already rejected (no override)', async () => {
    dbState.candidates.push({
      id: CANDIDATE_REJECTED_ID,
      source_kind: 'telegram',
      source_handle: '@nope',
      discovered_at: daysAgo(5),
      rationale: { reject_reason: 'pivoted' },
      candidate_score: 0.3,
      decision: 'rejected',
      decided_at: daysAgo(4),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intel/candidates/${CANDIDATE_REJECTED_ID}/approve`,
      headers: bearer,
    });
    assert.equal(res.statusCode, 409);
    assert.equal((res.json() as { decision: string }).decision, 'rejected');
  });

  it('returns 409 when channel-handle collision (UNIQUE violation)', async () => {
    dbState.candidates.push({
      id: CANDIDATE_COLLIDE_ID,
      source_kind: 'telegram',
      source_handle: '@dup',
      discovered_at: daysAgo(1),
      rationale: {},
      candidate_score: 0.6,
      decision: null,
      decided_at: null,
    });
    dbState.channels.push({
      id: CHANNEL_EXISTING_ID,
      source_kind: 'telegram',
      source_handle: '@dup',
      display_name: 'existing dup',
      status: 'active',
      capability_tags: [],
      last_message_observed_at: null,
      classified_message_count_7d: 0,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intel/candidates/${CANDIDATE_COLLIDE_ID}/approve`,
      headers: bearer,
    });
    assert.equal(res.statusCode, 409);
    const body = res.json() as { error: string; source_handle: string };
    assert.equal(body.error, 'channel_handle_already_exists');
    assert.equal(body.source_handle, '@dup');
    // Candidate remains pending — terminal transition aborted.
    const cand = dbState.candidates.find((c) => c.id === CANDIDATE_COLLIDE_ID)!;
    assert.equal(cand.decision, null);
  });

  it('returns 404 when candidate not found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/intel/candidates/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/approve',
      headers: bearer,
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 400 on malformed UUID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/intel/candidates/not-a-uuid/approve',
      headers: bearer,
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intel/candidates/${CANDIDATE_PENDING_ID}/approve`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intel/candidates/${CANDIDATE_PENDING_ID}/approve`,
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 7. POST /v1/admin/intel/candidates/:id/reject
// =================================================================
describe('POST /v1/admin/intel/candidates/:id/reject', () => {
  function seedPending(): void {
    dbState.candidates.push({
      id: CANDIDATE_PENDING_ID,
      source_kind: 'telegram',
      source_handle: '@to_reject',
      discovered_at: daysAgo(1),
      rationale: { analyst_rationales: ['weak signal'] },
      candidate_score: 0.3,
      decision: null,
      decided_at: null,
    });
  }

  it('rejects a pending candidate with optional reason stored in rationale', async () => {
    seedPending();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intel/candidates/${CANDIDATE_PENDING_ID}/reject`,
      headers: bearer,
      payload: { reason: 'not consumer-relevant' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ok: boolean; decision: string; reason: string | null };
    assert.equal(body.decision, 'rejected');
    assert.equal(body.reason, 'not consumer-relevant');
    const cand = dbState.candidates.find((c) => c.id === CANDIDATE_PENDING_ID)!;
    assert.equal(cand.decision, 'rejected');
    assert.equal((cand.rationale as Record<string, unknown>).reject_reason, 'not consumer-relevant');
    assert.ok((cand.rationale as Record<string, unknown>).rejected_at);
    // Original rationale preserved
    assert.ok((cand.rationale as Record<string, unknown>).analyst_rationales);
  });

  it('rejects without a reason (body absent)', async () => {
    seedPending();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intel/candidates/${CANDIDATE_PENDING_ID}/reject`,
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { decision: string; reason: string | null };
    assert.equal(body.decision, 'rejected');
    assert.equal(body.reason, null);
  });

  it('reject AFTER approve does NOT undo channel (terminal state)', async () => {
    seedPending();
    // First approve.
    const r1 = await app.inject({
      method: 'POST',
      url: `/v1/admin/intel/candidates/${CANDIDATE_PENDING_ID}/approve`,
      headers: bearer,
    });
    assert.equal(r1.statusCode, 200);
    const channelCountAfterApprove = dbState.channels.length;
    assert.equal(channelCountAfterApprove, 1, 'channel inserted');

    // Now attempt reject — must 409, must NOT remove the channel.
    const r2 = await app.inject({
      method: 'POST',
      url: `/v1/admin/intel/candidates/${CANDIDATE_PENDING_ID}/reject`,
      headers: bearer,
      payload: { reason: 'changed my mind' },
    });
    assert.equal(r2.statusCode, 409);
    assert.equal((r2.json() as { decision: string }).decision, 'approved');
    assert.equal(dbState.channels.length, 1, 'channel not removed');
    const cand = dbState.candidates.find((c) => c.id === CANDIDATE_PENDING_ID)!;
    assert.equal(cand.decision, 'approved', 'decision unchanged');
  });

  it('returns 400 on non-string reason', async () => {
    seedPending();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intel/candidates/${CANDIDATE_PENDING_ID}/reject`,
      headers: bearer,
      payload: { reason: 12345 },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 404 when candidate not found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/intel/candidates/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/reject',
      headers: bearer,
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intel/candidates/${CANDIDATE_PENDING_ID}/reject`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/intel/candidates/${CANDIDATE_PENDING_ID}/reject`,
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 8. /v1/admin/intel/briefings/latest
// =================================================================
describe('GET /v1/admin/intel/briefings/latest', () => {
  function seedBriefings(): void {
    dbState.briefings.push(
      {
        id: BRIEFING_OLDER_ID,
        period_start: new Date(Date.UTC(2026, 0, 1)),
        period_end: new Date(Date.UTC(2026, 2, 31)),
        generated_at: daysAgo(45),
        // I-M4: avoid 4+ digit runs in the body so the new
        // defense-in-depth redactor doesn't scrub the assertion
        // marker. The dedicated I-M4 tests below verify redaction
        // explicitly.
        body_markdown: '# Q1 Older\n\nOlder briefing.',
        metrics_jsonb: { channels_added: 3 },
      },
      {
        id: BRIEFING_LATEST_ID,
        period_start: new Date(Date.UTC(2026, 3, 1)),
        period_end: new Date(Date.UTC(2026, 5, 30)),
        generated_at: daysAgo(2),
        body_markdown: '# Q2 Latest\n\nLatest briefing.',
        metrics_jsonb: { channels_added: 7 },
      },
    );
  }

  it('returns most-recent briefing body + metrics', async () => {
    seedBriefings();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings/latest',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      id: string;
      period_start: string;
      period_end: string;
      generated_at: string;
      body_markdown: string;
      metrics_jsonb: { channels_added: number };
    };
    assert.equal(body.id, BRIEFING_LATEST_ID);
    assert.match(body.body_markdown, /Q2 Latest/);
    assert.equal(body.metrics_jsonb.channels_added, 7);
    assert.match(body.period_start, /^\d{4}-\d{2}-\d{2}$/);
    assertNoPii(body);
  });

  it('returns 404 when no briefings exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings/latest',
      headers: bearer,
    });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { error: string }).error, 'no_briefing_yet');
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings/latest',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings/latest',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 9. /v1/admin/intel/briefings
// =================================================================
describe('GET /v1/admin/intel/briefings', () => {
  it('returns briefing index without body, ordered most-recent first', async () => {
    dbState.briefings.push(
      {
        id: BRIEFING_OLDER_ID,
        period_start: new Date(Date.UTC(2026, 0, 1)),
        period_end: new Date(Date.UTC(2026, 2, 31)),
        generated_at: daysAgo(45),
        body_markdown: '# Q1',
        metrics_jsonb: {},
      },
      {
        id: BRIEFING_LATEST_ID,
        period_start: new Date(Date.UTC(2026, 3, 1)),
        period_end: new Date(Date.UTC(2026, 5, 30)),
        generated_at: daysAgo(2),
        body_markdown: '# Q2',
        metrics_jsonb: {},
      },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      briefings: Array<{
        id: string;
        period_start: string;
        period_end: string;
        generated_at: string;
      }>;
      count: number;
      limit: number;
    };
    assert.equal(body.count, 2);
    assert.equal(body.limit, 20);
    assert.equal(body.briefings[0]!.id, BRIEFING_LATEST_ID, 'most-recent first');
    // Body markdown intentionally absent from index.
    assert.ok(!('body_markdown' in (body.briefings[0] as Record<string, unknown>)));
    assertNoPii(body);
  });

  it('returns empty briefings array when none exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.json() as { briefings: unknown[] }).briefings, []);
  });

  it('honors limit query param (clamped to 200)', async () => {
    for (let i = 0; i < 5; i++) {
      dbState.briefings.push({
        id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
        period_start: new Date(Date.UTC(2026, i, 1)),
        period_end: new Date(Date.UTC(2026, i, 28)),
        generated_at: daysAgo(i + 1),
        body_markdown: '# x',
        metrics_jsonb: {},
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings?limit=2',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { briefings: unknown[]; limit: number };
    assert.equal(body.limit, 2);
    assert.equal(body.briefings.length, 2);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// 10. /v1/admin/intel/briefings/:id
// =================================================================
describe('GET /v1/admin/intel/briefings/:id', () => {
  it('returns a single briefing by id with body + metrics', async () => {
    dbState.briefings.push({
      id: BRIEFING_LATEST_ID,
      period_start: new Date(Date.UTC(2026, 3, 1)),
      period_end: new Date(Date.UTC(2026, 5, 30)),
      generated_at: daysAgo(1),
      body_markdown: '# Specific briefing',
      metrics_jsonb: { top_capability_tags: [{ tag: 'carding', count: 3 }] },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/intel/briefings/${BRIEFING_LATEST_ID}`,
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      id: string;
      body_markdown: string;
      metrics_jsonb: unknown;
    };
    assert.equal(body.id, BRIEFING_LATEST_ID);
    assert.match(body.body_markdown, /Specific briefing/);
    assertNoPii(body);
  });

  it('returns 404 when briefing not found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings/cccccccc-cccc-cccc-cccc-cccccccccccc',
      headers: bearer,
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 400 on malformed UUID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings/not-a-uuid',
      headers: bearer,
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 401 when bearer is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/intel/briefings/${BRIEFING_LATEST_ID}`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 with a wrong bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/intel/briefings/${BRIEFING_LATEST_ID}`,
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// =================================================================
// I-M4 — Briefing body redaction (defense-in-depth)
// =================================================================
// The LLM is supposed to receive only aggregate stats — no per-user
// PII enters the prompt. But hallucinated digit-runs or email
// patterns could still slip into body_markdown, and we don't want
// an admin browser to surface them. redactBriefingBody() scrubs:
//   - runs of 4+ digits          → '[REDACTED]'
//   - email-shaped tokens         → '[REDACTED-EMAIL]'
// These tests pin the behavior on BOTH briefing routes (latest +
// by-id) since they share the helper.

describe('I-M4: briefing body redaction', () => {
  it('scrubs 4+ digit runs from /briefings/latest body', async () => {
    dbState.briefings.push({
      id: BRIEFING_LATEST_ID,
      period_start: new Date(Date.UTC(2026, 3, 1)),
      period_end: new Date(Date.UTC(2026, 5, 30)),
      generated_at: daysAgo(1),
      body_markdown:
        'Suspicious caller phoned 4155551234 yesterday. Three short numbers: 12 cases, 99 hits, 1 alert.',
      metrics_jsonb: {},
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings/latest',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { body_markdown: string };
    // The 10-digit phone run is scrubbed.
    assert.ok(
      body.body_markdown.includes('[REDACTED]'),
      `expected [REDACTED] in: ${body.body_markdown}`,
    );
    assert.ok(!body.body_markdown.includes('4155551234'));
    // Short numbers (1-3 digits) preserved — they're often legitimate
    // counters in a briefing.
    assert.ok(body.body_markdown.includes('12 cases'));
    assert.ok(body.body_markdown.includes('99 hits'));
    assert.ok(body.body_markdown.includes('1 alert'));
  });

  it('scrubs email-shaped tokens from /briefings/latest body', async () => {
    dbState.briefings.push({
      id: BRIEFING_LATEST_ID,
      period_start: new Date(Date.UTC(2026, 3, 1)),
      period_end: new Date(Date.UTC(2026, 5, 30)),
      generated_at: daysAgo(1),
      body_markdown: 'Common attacker handle: scammer@example.com posted in three channels.',
      metrics_jsonb: {},
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings/latest',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { body_markdown: string };
    assert.ok(body.body_markdown.includes('[REDACTED-EMAIL]'));
    assert.ok(!body.body_markdown.includes('scammer@example.com'));
    assert.ok(body.body_markdown.includes('three channels'));
  });

  it('leaves PII-free briefing body unchanged', async () => {
    const clean = '## Q2 Summary\n\nThree new channels added. Carding remains top tag.';
    dbState.briefings.push({
      id: BRIEFING_LATEST_ID,
      period_start: new Date(Date.UTC(2026, 3, 1)),
      period_end: new Date(Date.UTC(2026, 5, 30)),
      generated_at: daysAgo(1),
      body_markdown: clean,
      metrics_jsonb: {},
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/intel/briefings/latest',
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { body_markdown: string };
    assert.equal(body.body_markdown, clean);
  });

  it('also redacts the /briefings/:id route (shared helper)', async () => {
    dbState.briefings.push({
      id: BRIEFING_LATEST_ID,
      period_start: new Date(Date.UTC(2026, 3, 1)),
      period_end: new Date(Date.UTC(2026, 5, 30)),
      generated_at: daysAgo(1),
      body_markdown:
        'SSN-shaped digit run 123456789 and email victim@test.co — both should scrub.',
      metrics_jsonb: {},
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/intel/briefings/${BRIEFING_LATEST_ID}`,
      headers: bearer,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { body_markdown: string };
    assert.ok(!body.body_markdown.includes('123456789'));
    assert.ok(!body.body_markdown.includes('victim@test.co'));
    assert.ok(body.body_markdown.includes('[REDACTED]'));
    assert.ok(body.body_markdown.includes('[REDACTED-EMAIL]'));
  });
});
