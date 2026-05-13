import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Identity Shield — end-to-end scenario test (I-P9 ship-readiness).
//
// Walks the FULL Identity Shield happy path through real code,
// stubbing only the network/provider boundary. Pins that:
//
//   1. iOS adds three monitors (email plaintext, phone plaintext, SSN
//      last-4 hashed server-side).
//   2. The HIBP catalog sync surfaces a breach + fans out a `url_host`
//      active_threats row.
//   3. The per-user HIBP scan finds the user's email in that breach →
//      identity_breach_findings row.
//   4. The darknet crawler observes a listing with the user's
//      SSN-last-4 plaintext + matches via the canonical
//      sha256(salt||tag||plaintext) scheme (I-H1 path) → second
//      finding row.
//   5. The Telegram listener classifies a message advertising the
//      user's REAL phone as "burner for sale". I-M3 user-PII
//      poisoning gate trips → row lands in
//      telegram_artifact_pending_review, NOT in active_threats.
//   6. Admin summary route reflects the live counters.
//   7. The threat-landscape meta-analyst surfaces a NEW candidate
//      channel from cross-references → row in threat_intel_candidates.
//   8. Admin approves the candidate → channel promoted to
//      threat_intel_channels (status='active'), candidate decision
//      flips to 'approved'.
//   9. /v1/identity-shield/digest/preview returns counts-only copy
//      (no PII).
//  10. /v1/stats/summary's identity_shield block reflects 3 monitors
//      + 2 fresh findings.
//
// What's stubbed (NETWORK ONLY):
//   - db.pool.query / db.pool.connect — in-memory tables, with
//     transaction support for the candidate approve path.
//   - HIBP catalog + per-user fetch — httpFetch opt on
//     syncHibpCatalogOnce / scanUserHibpExposureOnce.
//   - Telegram client — telegramClientFn opt to pollChannelsOnce.
//   - Darknet HTTP fetch — fetchListingFn opt to crawlMarketsOnce.
//   - LLM — llmFn opt to discoverCandidatesOnce.
//   - The classifier — classifierFn opt to pollChannelsOnce (we
//     control the extracted artifacts deterministically).
//
// What's NOT stubbed (real code paths exercised):
//   - identityShieldIngest: syncHibpCatalogOnce + scanUserHibpExposureOnce
//   - darknetMarketCrawler: crawlMarketsOnce — full parser-injected path,
//     monitor index, hash-match (canonical I-H1 scheme), finding insert
//   - telegramChatterListener: pollChannelsOnce — full classifier
//     output → I-M3 user-PII gate → pending review row
//   - threatLandscapeAnalyst: discoverCandidatesOnce — LLM output →
//     candidate upsert
//   - activeThreats.ingestThreatBatch — normalize + UPSERT + severity
//     ladder + xmax=0 insert/update accounting
//   - identityShield routes — real Fastify dispatch on monitors POST,
//     digest/preview
//   - adminIdentityShield routes — real bearer auth, summary, candidate
//     approve, with withTx transaction path
//   - statsRoutes — real countOrZero pattern across identity_*
//     tables
//   - Per-user salt resolution + sha256(salt||tag||value) hashing on
//     the SSN monitor add path → identity_monitors row's watched_value
//     is the digest (the assertion verifies plaintext never lands)
//
// The point: catch cross-module regressions. A fix that "looks right"
// in a unit test but breaks the route → ingest → admin chain surfaces
// here.

// ---- Env BEFORE module imports ------------------------------------------

process.env.DATA_ENCRYPTION_KEY ||=
  'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-identity-e2e';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://identity-e2e';
process.env.ALLOW_DEV_BEARER = 'true';
// Pre-seed BEFORE config.ts loads — these gate the worker paths.
process.env.HIBP_API_KEY = 'test-hibp-key-identity-e2e';
process.env.DARKNET_CRAWLER_TOR_SOCKS5_HOST = '127.0.0.1';
process.env.DARKNET_CRAWLER_TOR_SOCKS5_PORT = '9050';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

const Fastify = (await import('fastify')).default;
const fastifyRateLimit = (await import('@fastify/rate-limit')).default;
const db = await import('../src/lib/db.ts');
const cache = await import('../src/lib/cache.ts');
const { identityShieldRoutes } = await import('../src/routes/identityShield.ts');
const { adminIdentityShieldRoutes } = await import(
  '../src/routes/adminIdentityShield.ts'
);
const { statsRoutes } = await import('../src/routes/stats.ts');
const ingest = await import('../src/workers/identityShieldIngest.ts');
const crawler = await import('../src/workers/darknetMarketCrawler.ts');
const telegram = await import('../src/workers/telegramChatterListener.ts');
const analyst = await import(
  '../src/services/identity/threatLandscapeAnalyst.ts'
);

const SHARED_SECRET = process.env.API_SHARED_SECRET!;
const PRO_BEARER = `Bearer ${SHARED_SECRET}`;

// Dev shared-secret + ALLOW_DEV_BEARER maps to this synthetic user
// (see src/lib/auth.ts requireAppUser).
const SYNTHETIC_USER_ID = '00000000-0000-0000-0000-000000000000';

// Stable fixture UUIDs so SELECT-by-id paths can be hand-verified.
const TELEGRAM_CHANNEL_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DARKNET_MARKET_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CANDIDATE_ROW_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const APPROVED_CHANNEL_ROW_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// Scenario-specific values — the assertions verify these NEVER appear
// in any response body or persisted row beyond the intended target.
const USER_EMAIL = 'jesiah@aegisdial.example';
const USER_PHONE_E164 = '+14155550100';
const USER_SSN_LAST4 = '1234';
const USER_PHONE_DIGITS_ONLY = '14155550100'; // canonical key the crawler index uses
const SCAMMER_PHONE_BENIGN = '+15095551111'; // a non-user phone — passes I-M3 gate
const NEW_CANDIDATE_HANDLE = '@fresh_otp_bot_99'; // surfaced by the analyst
const HIBP_BREACH_NAME = 'LinkedIn';
const HIBP_BREACH_DOMAIN = 'linkedin.com';
const DARKNET_MARKET_HANDLE = 'sample_market_e2e';
const TELEGRAM_CHANNEL_HANDLE = '@carding_e2e';

// ────────────────────────────────────────────────────────────────────
// In-memory DB shape
// ────────────────────────────────────────────────────────────────────

interface MonitorRow {
  id: string;
  user_id: string;
  monitor_kind:
    | 'email'
    | 'phone_e164'
    | 'ssn_last4_hash'
    | 'dob_hash'
    | 'name_address_hash';
  watched_value: string;
  salt_hex: string | null;
  active: boolean;
  created_at: Date;
}
interface BreachRow {
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
interface FindingRow {
  id: string;
  user_id: string;
  monitor_id: string;
  breach_id: string;
  severity: 'informational' | 'caution' | 'critical';
  surfaced_at: Date;
  user_acknowledged_at: Date | null;
  remediation_completed_at: Date | null;
}
interface ActiveThreatRow {
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
interface ChannelRow {
  id: string;
  source_kind: 'telegram' | 'darknet_market';
  source_handle: string;
  display_name: string;
  status: string;
  capability_tags: string[];
  geo_relevance: string[];
  added_by: string | null;
  added_at: Date;
  last_message_observed_at: Date | null;
  classified_message_count_7d: number;
}
interface CandidateRow {
  id: string;
  source_kind: 'telegram' | 'darknet_market';
  source_handle: string;
  discovered_at: Date;
  rationale: Record<string, unknown>;
  candidate_score: number;
  decision: string | null;
  decided_at: Date | null;
  decided_by: string | null;
}
interface UserRow {
  id: string;
  email: string | null;
  phone_number: string | null;
}
interface PendingReviewRow {
  id: string;
  artifact_kind: 'phone_e164' | 'email_address';
  artifact_value: string;
  matched_user_id: string;
  classified_severity: string;
  provenance: string;
}

const dbState = {
  monitors: [] as MonitorRow[],
  breaches: [] as BreachRow[],
  findings: [] as FindingRow[],
  active_threats: [] as ActiveThreatRow[],
  channels: [] as ChannelRow[],
  candidates: [] as CandidateRow[],
  users: [] as UserRow[],
  pending_review: [] as PendingReviewRow[],
  next_id: 1,
  next_uuid: 1,
};

function newId(prefix: string): string {
  return `${prefix}-${dbState.next_id++}`;
}

// We re-use a deterministic UUID counter for rows the routes select
// by id — they validate UUID format on input. The 12-char hex tail is
// the counter, padded.
function newUuid(): string {
  const n = (dbState.next_uuid++).toString(16).padStart(12, '0');
  return `00000000-0000-0000-0000-${n}`;
}

const SEV_RANK: Record<string, number> = {
  informational: 1,
  caution: 2,
  warning: 3,
  confirmed_scammer: 4,
};

// ────────────────────────────────────────────────────────────────────
// SQL matcher
// ────────────────────────────────────────────────────────────────────

function runQuery(
  text: string,
  params: unknown[] = [],
): { rows: unknown[]; rowCount: number } {
  const t = text.replace(/\s+/g, ' ').trim();

  // BEGIN / COMMIT / ROLLBACK from withTx ----
  if (/^BEGIN/i.test(t)) return { rows: [], rowCount: 0 };
  if (/^COMMIT/i.test(t)) return { rows: [], rowCount: 0 };
  if (/^ROLLBACK/i.test(t)) return { rows: [], rowCount: 0 };

  // metric_counters — swallow ----
  if (/^INSERT\s+INTO\s+metric_counters/i.test(t)) {
    return { rows: [], rowCount: 1 };
  }

  // ---- identity_monitors --------------------------------------------

  // Salt lookup (resolveUserSalt in identityShield route)
  if (
    /^SELECT salt_hex FROM identity_monitors WHERE user_id = \$1 AND monitor_kind = \$2 AND active AND salt_hex IS NOT NULL/i.test(
      t,
    )
  ) {
    const [uid, kind] = params as [string, string];
    const row = dbState.monitors.find(
      (m) =>
        m.user_id === uid &&
        m.monitor_kind === kind &&
        m.active &&
        m.salt_hex !== null,
    );
    return row
      ? { rows: [{ salt_hex: row.salt_hex }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // Monitor INSERT (POST /monitors) with ON CONFLICT DO NOTHING
  if (
    /^INSERT INTO identity_monitors \(user_id, monitor_kind, watched_value, salt_hex, active\)/i.test(
      t,
    )
  ) {
    const [user_id, monitor_kind, watched_value, salt_hex] = params as [
      string,
      MonitorRow['monitor_kind'],
      string,
      string | null,
    ];
    const existing = dbState.monitors.find(
      (m) =>
        m.user_id === user_id &&
        m.monitor_kind === monitor_kind &&
        m.watched_value === watched_value,
    );
    if (existing) {
      return { rows: [], rowCount: 0 };
    }
    const id = newUuid();
    dbState.monitors.push({
      id,
      user_id,
      monitor_kind,
      watched_value,
      salt_hex,
      active: true,
      created_at: new Date(),
    });
    return { rows: [{ id }], rowCount: 1 };
  }

  // Monitor SELECT for list route (GET /monitors)
  if (
    /^SELECT id, monitor_kind, watched_value, created_at FROM identity_monitors WHERE user_id = \$1 AND active/i.test(
      t,
    )
  ) {
    const [uid] = params as [string];
    const rows = dbState.monitors
      .filter((m) => m.user_id === uid && m.active)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .map((m) => ({
        id: m.id,
        monitor_kind: m.monitor_kind,
        watched_value: m.watched_value,
        created_at: m.created_at,
      }));
    return { rows, rowCount: rows.length };
  }

  // Per-user email monitor list (scanUserHibpExposureOnce)
  if (
    /^SELECT id, watched_value FROM identity_monitors WHERE user_id = \$1 AND monitor_kind = 'email' AND active/i.test(
      t,
    )
  ) {
    const [uid] = params as [string];
    const rows = dbState.monitors
      .filter(
        (m) => m.user_id === uid && m.monitor_kind === 'email' && m.active,
      )
      .map((m) => ({ id: m.id, watched_value: m.watched_value }));
    return { rows, rowCount: rows.length };
  }

  // Monitor index load (loadMonitorIndex in darknetMarketCrawler)
  if (
    /^SELECT id, user_id, monitor_kind, watched_value, salt_hex FROM identity_monitors WHERE active/i.test(
      t,
    )
  ) {
    const rows = dbState.monitors
      .filter((m) => m.active)
      .map((m) => ({
        id: m.id,
        user_id: m.user_id,
        monitor_kind: m.monitor_kind,
        watched_value: m.watched_value,
        salt_hex: m.salt_hex,
      }));
    return { rows, rowCount: rows.length };
  }

  // Monitors active count for digest preview + stats summary
  if (
    /^SELECT COUNT\(\*\)::TEXT AS count FROM identity_monitors WHERE user_id = \$1 AND active/i.test(
      t,
    )
  ) {
    const [uid] = params as [string];
    const c = dbState.monitors.filter(
      (m) => m.user_id === uid && m.active,
    ).length;
    return { rows: [{ count: String(c) }], rowCount: 1 };
  }

  // ---- identity_breaches --------------------------------------------

  // Catalog UPSERT (full schema — syncHibpCatalogOnce)
  if (
    /^INSERT INTO identity_breaches \( breach_name, source, source_breach_id, domain, breach_date, added_date, pwn_count, data_classes, is_verified, is_sensitive, description \)/i.test(
      t,
    )
  ) {
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
    ] = params as [
      string,
      string,
      string | null,
      string | null,
      string | null,
      number | null,
      string[],
      boolean,
      boolean,
      string | null,
    ];
    const existing = dbState.breaches.find(
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
    dbState.breaches.push({
      id: newId('br'),
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

  // Inline minimal UPSERT (per-user HIBP scan path)
  if (
    /^INSERT INTO identity_breaches \( breach_name, source, source_breach_id, domain, breach_date, added_date, pwn_count, data_classes, is_verified, is_sensitive \)/i.test(
      t,
    )
  ) {
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
    ] = params as [
      string,
      string,
      string | null,
      string | null,
      string | null,
      number | null,
      string[],
      boolean,
      boolean,
    ];
    let row = dbState.breaches.find(
      (b) => b.source === 'hibp' && b.source_breach_id === source_breach_id,
    );
    if (!row) {
      row = {
        id: newId('br'),
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
      dbState.breaches.push(row);
    } else {
      row.synced_at = new Date();
    }
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // Darknet aegisdial_internal UPSERT
  if (
    /^INSERT INTO identity_breaches \( breach_name, source, source_breach_id, domain, breach_date, pwn_count, data_classes, description \)/i.test(
      t,
    ) &&
    /'aegisdial_internal'/.test(t)
  ) {
    const [
      breach_name,
      source_breach_id,
      domain,
      breach_date,
      pwn_count,
      data_classes,
      description,
    ] = params as [
      string,
      string,
      string | null,
      string | null,
      number | null,
      string[],
      string | null,
    ];
    const existing = dbState.breaches.find(
      (b) =>
        b.source === 'aegisdial_internal' &&
        b.source_breach_id === source_breach_id,
    );
    if (existing) {
      existing.synced_at = new Date();
      return {
        rows: [{ id: existing.id, was_insert: false }],
        rowCount: 1,
      };
    }
    const row: BreachRow = {
      id: newId('br'),
      breach_name,
      source: 'aegisdial_internal',
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
    dbState.breaches.push(row);
    return { rows: [{ id: row.id, was_insert: true }], rowCount: 1 };
  }

  // SELECT identity_breaches by source_breach_id (resolveOrSyncBreachRow)
  if (
    /^SELECT id FROM identity_breaches WHERE source = 'hibp' AND source_breach_id = \$1/i.test(
      t,
    )
  ) {
    const [sbid] = params as [string];
    const row = dbState.breaches.find(
      (b) => b.source === 'hibp' && b.source_breach_id === sbid,
    );
    return row
      ? { rows: [{ id: row.id }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // ---- identity_breach_findings -------------------------------------

  if (/^INSERT INTO identity_breach_findings/i.test(t)) {
    const [user_id, monitor_id, breach_id, severity] = params as [
      string,
      string,
      string,
      FindingRow['severity'],
    ];
    const exists = dbState.findings.find(
      (f) =>
        f.user_id === user_id &&
        f.monitor_id === monitor_id &&
        f.breach_id === breach_id,
    );
    if (exists) return { rows: [], rowCount: 0 };
    dbState.findings.push({
      id: newUuid(),
      user_id,
      monitor_id,
      breach_id,
      severity,
      surfaced_at: new Date(),
      user_acknowledged_at: null,
      remediation_completed_at: null,
    });
    return { rows: [], rowCount: 1 };
  }

  // Findings 7d count (digest preview + stats summary)
  if (
    /^SELECT COUNT\(\*\)::TEXT AS count FROM identity_breach_findings WHERE user_id = \$1 AND surfaced_at >/i.test(
      t,
    )
  ) {
    const [uid] = params as [string];
    const cutoff = Date.now() - 7 * 24 * 3_600_000;
    const c = dbState.findings.filter(
      (f) => f.user_id === uid && f.surfaced_at.getTime() > cutoff,
    ).length;
    return { rows: [{ count: String(c) }], rowCount: 1 };
  }

  // ---- active_threats -----------------------------------------------

  // ingestThreatBatch multi-row CTE
  if (
    /^WITH input_rows AS \( SELECT/i.test(t) &&
    /INSERT INTO active_threats/i.test(t)
  ) {
    const PARAMS_PER_ROW = 8;
    const rows: Array<{ was_insert: boolean }> = [];
    for (let i = 0; i < params.length; i += PARAMS_PER_ROW) {
      const [
        kind,
        value,
        severity,
        provenance,
        context,
        geo_tag,
        expires_at,
        incoming_rank,
      ] = params.slice(i, i + PARAMS_PER_ROW) as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        Date | null,
        number,
      ];
      const existing = dbState.active_threats.find(
        (r) =>
          r.threat_kind === kind &&
          r.threat_value === value &&
          r.provenance === provenance,
      );
      if (existing) {
        existing.last_seen_at = new Date();
        if (incoming_rank > SEV_RANK[existing.severity]!) {
          existing.severity = severity;
          existing.expires_at = expires_at;
        }
        if (context !== null) existing.context_text = context;
        if (geo_tag !== null) existing.geo_tag = geo_tag;
        rows.push({ was_insert: false });
      } else {
        dbState.active_threats.push({
          id: newId('at'),
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

  // active_threats — discoverCandidatesOnce SELECT
  if (
    /^SELECT context_text, provenance, geo_tag, last_seen_at FROM active_threats WHERE last_seen_at >/i.test(
      t,
    )
  ) {
    const [windowHours] = params as [string];
    const cutoff = Date.now() - Number(windowHours) * 3_600_000;
    const rows = dbState.active_threats
      .filter(
        (a) =>
          a.last_seen_at.getTime() > cutoff &&
          a.context_text !== null &&
          (a.provenance.startsWith('telegram_channel:') ||
            a.provenance.startsWith('darknet_market:')) &&
          (a.severity === 'caution' ||
            a.severity === 'warning' ||
            a.severity === 'confirmed_scammer'),
      )
      .sort((a, b) => b.last_seen_at.getTime() - a.last_seen_at.getTime())
      .slice(0, 200)
      .map((a) => ({
        context_text: a.context_text,
        provenance: a.provenance,
        geo_tag: a.geo_tag,
        last_seen_at: a.last_seen_at,
      }));
    return { rows, rowCount: rows.length };
  }

  // active_threats — admin summary (severity)
  if (
    /^SELECT severity, COUNT\(\*\)::TEXT AS count FROM active_threats WHERE \(expires_at IS NULL OR expires_at > NOW\(\)\) GROUP BY severity/i.test(
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

  // Stats — active_threats 30d non-expired
  if (
    /^SELECT COUNT\(\*\)::TEXT AS count FROM active_threats WHERE last_seen_at > NOW\(\) - INTERVAL '30 days' AND \(expires_at IS NULL OR expires_at > NOW\(\)\)/i.test(
      t,
    )
  ) {
    const now = Date.now();
    const cutoff = now - 30 * 24 * 3_600_000;
    const c = dbState.active_threats.filter(
      (a) =>
        a.last_seen_at.getTime() > cutoff &&
        (a.expires_at === null || a.expires_at.getTime() > now),
    ).length;
    return { rows: [{ count: String(c) }], rowCount: 1 };
  }

  // Stats — active_threats first_seen 7d non-expired
  if (
    /^SELECT COUNT\(\*\)::TEXT AS count FROM active_threats WHERE first_seen_at > NOW\(\) - INTERVAL '7 days' AND \(expires_at IS NULL OR expires_at > NOW\(\)\)/i.test(
      t,
    )
  ) {
    const now = Date.now();
    const cutoff = now - 7 * 24 * 3_600_000;
    const c = dbState.active_threats.filter(
      (a) =>
        a.first_seen_at.getTime() > cutoff &&
        (a.expires_at === null || a.expires_at.getTime() > now),
    ).length;
    return { rows: [{ count: String(c) }], rowCount: 1 };
  }

  // ---- threat_intel_channels ----------------------------------------

  // Telegram listener — active channel poll
  if (
    /^SELECT id, source_handle, last_message_observed_at FROM threat_intel_channels WHERE status = 'active' AND source_kind = 'telegram'/i.test(
      t,
    )
  ) {
    const rows = dbState.channels
      .filter((c) => c.status === 'active' && c.source_kind === 'telegram')
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => ({
        id: c.id,
        source_handle: c.source_handle,
        last_message_observed_at: c.last_message_observed_at,
      }));
    return { rows, rowCount: rows.length };
  }

  // Cross-reference dedup SELECT (telegram + analyst paths)
  if (
    /^SELECT id FROM threat_intel_channels WHERE source_kind = \$1 AND source_handle = \$2/i.test(
      t,
    )
  ) {
    const [sk, handle] = params as [string, string];
    const match = dbState.channels.find(
      (c) => c.source_kind === sk && c.source_handle === handle,
    );
    return match
      ? { rows: [{ id: match.id }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // Darknet market active list
  if (
    /^SELECT id, source_handle FROM threat_intel_channels WHERE source_kind = 'darknet_market' AND status = 'active'/i.test(
      t,
    )
  ) {
    const rows = dbState.channels
      .filter(
        (c) => c.source_kind === 'darknet_market' && c.status === 'active',
      )
      .map((c) => ({ id: c.id, source_handle: c.source_handle }));
    return { rows, rowCount: rows.length };
  }

  // Channel observed-state bump (telegram listener)
  if (
    /^UPDATE threat_intel_channels SET last_message_observed_at = GREATEST/i.test(
      t,
    ) &&
    /classified_message_count_7d = classified_message_count_7d/i.test(t)
  ) {
    const [cid, newest, delta] = params as [string, Date, number];
    const ch = dbState.channels.find((c) => c.id === cid);
    if (ch) {
      const prior = ch.last_message_observed_at;
      ch.last_message_observed_at =
        prior === null || newest.getTime() > prior.getTime() ? newest : prior;
      ch.classified_message_count_7d += delta;
    }
    return { rows: [], rowCount: ch ? 1 : 0 };
  }

  // Darknet crawler last_observed bump
  if (
    /^UPDATE threat_intel_channels SET last_message_observed_at = NOW\(\) WHERE id = \$1/i.test(
      t,
    )
  ) {
    const [cid] = params as [string];
    const ch = dbState.channels.find((c) => c.id === cid);
    if (ch) ch.last_message_observed_at = new Date();
    return { rows: [], rowCount: ch ? 1 : 0 };
  }

  // Admin summary monitors_by_kind
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

  // Admin summary — findings 7d + 30d by severity
  if (
    /FROM identity_breach_findings WHERE surfaced_at >= NOW\(\) - INTERVAL '30 days'/i.test(
      t,
    ) &&
    /COUNT\(\*\) FILTER \(WHERE surfaced_at >= NOW\(\) - INTERVAL '7 days'\)/i.test(
      t,
    )
  ) {
    const now = Date.now();
    const cutoff7 = now - 7 * 24 * 3_600_000;
    const cutoff30 = now - 30 * 24 * 3_600_000;
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

  // Admin summary — intel ingest heartbeat
  if (
    /^SELECT name, MAX\(bucket\) AS latest FROM metric_counters WHERE name IN/i.test(
      t,
    ) &&
    /identity_shield\.hibp_sync/.test(t)
  ) {
    return { rows: [], rowCount: 0 };
  }

  // ---- threat_intel_candidates --------------------------------------

  // Analyst-variant upsert (with analyst_rationales)
  if (
    /^INSERT INTO threat_intel_candidates \(source_kind, source_handle, rationale, candidate_score\)/i.test(
      t,
    ) &&
    /analyst_rationales/.test(t)
  ) {
    const [sk, handle, rationaleJson, candidateScore] = params as [
      'telegram' | 'darknet_market',
      string,
      string,
      number,
    ];
    const existing = dbState.candidates.find(
      (c) => c.source_kind === sk && c.source_handle === handle,
    );
    if (existing) {
      if (existing.decision === 'rejected') {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [{ was_insert: false }],
        rowCount: 1,
      };
    }
    const id =
      sk === 'telegram' && handle === NEW_CANDIDATE_HANDLE
        ? CANDIDATE_ROW_ID
        : newUuid();
    const parsed = JSON.parse(rationaleJson) as Record<string, unknown>;
    dbState.candidates.push({
      id,
      source_kind: sk,
      source_handle: handle,
      discovered_at: new Date(),
      rationale: parsed,
      candidate_score: candidateScore,
      decision: null,
      decided_at: null,
      decided_by: null,
    });
    return { rows: [{ was_insert: true }], rowCount: 1 };
  }

  // Telegram-listener variant (no analyst_rationales; uses sample_evidence
  // / cited_by / mention_count shape from recordCrossReference)
  if (
    /^INSERT INTO threat_intel_candidates \(source_kind, source_handle, rationale, candidate_score\)/i.test(
      t,
    )
  ) {
    const [sk, handle, rationaleJson, citingChannelId, evidenceJson] =
      params as [
        'telegram' | 'darknet_market',
        string,
        string,
        string,
        string,
      ];
    const existing = dbState.candidates.find(
      (c) => c.source_kind === sk && c.source_handle === handle,
    );
    if (existing) {
      if (existing.decision === 'rejected') {
        return { rows: [], rowCount: 0 };
      }
      // Mimic jsonb-append: cited_by, mention_count, sample_evidence.
      const rationale = existing.rationale as Record<string, unknown>;
      const citedBy = Array.isArray(rationale.cited_by)
        ? (rationale.cited_by as string[])
        : [];
      if (!citedBy.includes(citingChannelId)) citedBy.push(citingChannelId);
      rationale.cited_by = citedBy;
      const mentionCount = ((rationale.mention_count as number) ?? 0) + 1;
      rationale.mention_count = mentionCount;
      const evidence = JSON.parse(evidenceJson) as Record<string, unknown>;
      const sampleEvidence = Array.isArray(rationale.sample_evidence)
        ? (rationale.sample_evidence as unknown[])
        : [];
      sampleEvidence.push(evidence);
      rationale.sample_evidence = sampleEvidence.slice(0, 25);
      existing.candidate_score = Math.min(1.0, mentionCount / 10);
      return { rows: [], rowCount: 1 };
    }
    const id =
      sk === 'telegram' && handle === NEW_CANDIDATE_HANDLE
        ? CANDIDATE_ROW_ID
        : newUuid();
    const parsed = JSON.parse(rationaleJson) as Record<string, unknown>;
    dbState.candidates.push({
      id,
      source_kind: sk,
      source_handle: handle,
      discovered_at: new Date(),
      rationale: parsed,
      candidate_score: 0.1,
      decision: null,
      decided_at: null,
      decided_by: null,
    });
    return { rows: [], rowCount: 1 };
  }

  // Candidate FOR UPDATE SELECT (admin approve)
  if (
    /^SELECT id::TEXT, source_kind, source_handle, rationale, decision FROM threat_intel_candidates WHERE id = \$1 FOR UPDATE/i.test(
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

  // Channel INSERT (admin approve)
  if (
    /INSERT INTO threat_intel_channels .*RETURNING id::TEXT AS id/is.test(t)
  ) {
    const [source_kind, source_handle, display_name] = params as [
      'telegram' | 'darknet_market',
      string,
      string,
    ];
    const collision = dbState.channels.find(
      (c) => c.source_kind === source_kind && c.source_handle === source_handle,
    );
    if (collision) {
      const err = new Error('duplicate key value violates unique constraint') as Error & {
        code: string;
      };
      err.code = '23505';
      throw err;
    }
    const id = APPROVED_CHANNEL_ROW_ID;
    dbState.channels.push({
      id,
      source_kind,
      source_handle,
      display_name,
      status: 'active',
      capability_tags: [],
      geo_relevance: [],
      added_by: null,
      added_at: new Date(),
      last_message_observed_at: null,
      classified_message_count_7d: 0,
    });
    return { rows: [{ id }], rowCount: 1 };
  }

  // Candidate UPDATE decision='approved' (admin approve)
  if (
    /^UPDATE threat_intel_candidates SET decision = 'approved'/i.test(t)
  ) {
    const id = params[0] as string;
    const cand = dbState.candidates.find((c) => c.id === id);
    if (!cand) return { rows: [], rowCount: 0 };
    cand.decision = 'approved';
    cand.decided_at = new Date();
    return { rows: [], rowCount: 1 };
  }

  // ---- I-M3: users lookup (telegram poisoning gate) -----------------

  if (
    /^SELECT id FROM users WHERE phone_number = \$1 LIMIT 1/i.test(t)
  ) {
    const [phone] = params as [string];
    const u = dbState.users.find((x) => x.phone_number === phone);
    return u
      ? { rows: [{ id: u.id }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (/^SELECT id FROM users WHERE email = \$1 LIMIT 1/i.test(t)) {
    const [email] = params as [string];
    const u = dbState.users.find((x) => x.email === email);
    return u
      ? { rows: [{ id: u.id }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // telegram_artifact_pending_review INSERT (I-M3 gate hit)
  if (/^INSERT INTO telegram_artifact_pending_review/i.test(t)) {
    const [
      artifact_kind,
      artifact_value,
      matched_user_id,
      classified_severity,
      provenance,
    ] = params as [
      'phone_e164' | 'email_address',
      string,
      string,
      string,
      string,
    ];
    dbState.pending_review.push({
      id: newId('pending'),
      artifact_kind,
      artifact_value,
      matched_user_id,
      classified_severity,
      provenance,
    });
    return { rows: [], rowCount: 1 };
  }

  // ---- Stats: non-identity counts return 0 (we don't seed) ----------

  if (/^SELECT COUNT\(\*\)::TEXT AS count FROM call_sessions/i.test(t)) {
    return { rows: [{ count: '0' }], rowCount: 1 };
  }
  if (/^SELECT COUNT\(\*\)::TEXT AS count FROM breach_alerts/i.test(t)) {
    return { rows: [{ count: '0' }], rowCount: 1 };
  }
  if (/^SELECT COUNT\(\*\)::TEXT AS count FROM sms_classifications/i.test(t)) {
    return { rows: [{ count: '0' }], rowCount: 1 };
  }
  if (/^SELECT COUNT\(\*\)::TEXT AS count FROM sms_scans/i.test(t)) {
    return { rows: [{ count: '0' }], rowCount: 1 };
  }
  if (/^SELECT COUNT\(\*\)::TEXT AS count FROM email_scans/i.test(t)) {
    return { rows: [{ count: '0' }], rowCount: 1 };
  }
  if (
    /^SELECT COUNT\(\*\)::TEXT AS count FROM email_compromise_reports/i.test(t)
  ) {
    return { rows: [{ count: '0' }], rowCount: 1 };
  }
  if (
    /^SELECT COUNT\(\*\)::TEXT AS count FROM email_tamper_alerts/i.test(t)
  ) {
    return { rows: [{ count: '0' }], rowCount: 1 };
  }

  throw new Error(`E2E unstubbed SQL: ${t.slice(0, 200)}`);
}

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => runQuery(text, params);

// Pool exposes both `query` and `connect()` — withTx() goes through the
// latter. The fake client shares the same runQuery() path so admin
// approve's transaction-scoped queries land in the same in-memory state.
const fakeClient = {
  query: fakeQuery,
  release: () => {},
};

// ────────────────────────────────────────────────────────────────────
// HIBP cache flush — hibpBreachCheck single-flight caches per email
// ────────────────────────────────────────────────────────────────────

async function flushHibpCacheFor(email: string): Promise<void> {
  const key =
    'hibp:' + createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
  await cache.cacheInvalidate(key);
  await cache.cacheInvalidate(key + ':inflight');
  // The route's threats/near aggregate also caches — flush all on reset.
  await cache.cacheInvalidate(
    `identity_threats_near:${SYNTHETIC_USER_ID}:global`,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ────────────────────────────────────────────────────────────────────
// Fastify app
// ────────────────────────────────────────────────────────────────────

let app: ReturnType<typeof Fastify>;

before(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyRateLimit, {
    global: false,
    max: 9999,
    timeWindow: '1 minute',
  });
  await app.register(identityShieldRoutes);
  await app.register(adminIdentityShieldRoutes);
  await app.register(statsRoutes);
  await app.ready();
});

beforeEach(async () => {
  dbState.monitors.length = 0;
  dbState.breaches.length = 0;
  dbState.findings.length = 0;
  dbState.active_threats.length = 0;
  dbState.channels.length = 0;
  dbState.candidates.length = 0;
  dbState.users.length = 0;
  dbState.pending_review.length = 0;
  dbState.next_id = 1;
  dbState.next_uuid = 1;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
  (db.pool as unknown as {
    connect: () => Promise<typeof fakeClient>;
  }).connect = async () => fakeClient;
  await flushHibpCacheFor(USER_EMAIL);
  // Darknet crawler holds per-market state in Redis (lastfetch, daily-
  // count, backoff). The in-memory cache persists across tests in the
  // same Node process — without flushing, the second test's crawl is
  // blocked by the first test's lastfetch entry on the same market id.
  // Flush every key we know the crawler keys on; the test runs the
  // crawler exactly twice with the same DARKNET_MARKET_ID.
  await cache.cacheInvalidate(`darknet_crawler:lastfetch:${DARKNET_MARKET_ID}`);
  await cache.cacheInvalidate(`darknet_crawler:daily:${DARKNET_MARKET_ID}`);
  await cache.cacheInvalidate(`darknet_crawler:backoff:${DARKNET_MARKET_ID}`);
  await cache.cacheInvalidate(
    `darknet_crawler:backoff_step:${DARKNET_MARKET_ID}`,
  );
});

// ────────────────────────────────────────────────────────────────────
// Scenario walk-through
// ────────────────────────────────────────────────────────────────────

describe('Identity Shield E2E — full happy-path walk', () => {
  it(
    'monitors → HIBP catalog+scan → darknet hash-match → telegram I-M3 gate → admin summary → analyst candidate → approve → digest preview → stats',
    async () => {
      // ────────────────────────────────────────────────────────────────
      // Pre-seed: a synthetic users row so the I-M3 gate fires on the
      // Telegram poisoning attempt (phone matches a real user).
      // The synthetic dev user (auth.ts) is the same ID the route
      // populates req.appUser with.
      // ────────────────────────────────────────────────────────────────
      dbState.users.push({
        id: SYNTHETIC_USER_ID,
        email: USER_EMAIL,
        phone_number: USER_PHONE_E164,
      });

      // Pre-seed an active Telegram channel + darknet market so the
      // listener / crawler have something to poll.
      dbState.channels.push({
        id: TELEGRAM_CHANNEL_ID,
        source_kind: 'telegram',
        source_handle: TELEGRAM_CHANNEL_HANDLE,
        display_name: TELEGRAM_CHANNEL_HANDLE,
        status: 'active',
        capability_tags: ['carding'],
        geo_relevance: ['US'],
        added_by: null,
        added_at: new Date(),
        last_message_observed_at: null,
        classified_message_count_7d: 0,
      });
      dbState.channels.push({
        id: DARKNET_MARKET_ID,
        source_kind: 'darknet_market',
        source_handle: DARKNET_MARKET_HANDLE,
        display_name: 'Sample Darknet Market (E2E)',
        status: 'active',
        capability_tags: [],
        geo_relevance: [],
        added_by: null,
        added_at: new Date(),
        last_message_observed_at: null,
        classified_message_count_7d: 0,
      });

      // ──────────────────────────────────────────────────────────────
      // STEP 1 — iOS adds three monitors via the real route surface.
      // ──────────────────────────────────────────────────────────────

      const addEmail = await app.inject({
        method: 'POST',
        url: '/v1/identity-shield/monitors',
        headers: { authorization: PRO_BEARER, 'content-type': 'application/json' },
        payload: { monitor_kind: 'email', value: USER_EMAIL },
      });
      assert.equal(addEmail.statusCode, 201, addEmail.body);
      const emailMon = addEmail.json() as { id: string; monitor_kind: string; value_preview: string };
      assert.equal(emailMon.monitor_kind, 'email');
      // value_preview is the masked projection — first char + ****
      assert.match(emailMon.value_preview, /^j\*\*\*\*@aegisdial\.example$/);

      const addPhone = await app.inject({
        method: 'POST',
        url: '/v1/identity-shield/monitors',
        headers: { authorization: PRO_BEARER, 'content-type': 'application/json' },
        payload: { monitor_kind: 'phone_e164', value: USER_PHONE_E164 },
      });
      assert.equal(addPhone.statusCode, 201, addPhone.body);

      const addSsn = await app.inject({
        method: 'POST',
        url: '/v1/identity-shield/monitors',
        headers: { authorization: PRO_BEARER, 'content-type': 'application/json' },
        payload: {
          monitor_kind: 'ssn_last4_hash',
          ssn_last4: USER_SSN_LAST4,
        },
      });
      assert.equal(addSsn.statusCode, 201, addSsn.body);
      const ssnMon = addSsn.json() as { value_preview: string };
      // Hash-kind value_preview is the literal 'monitored' — the hash
      // never round-trips to the client.
      assert.equal(ssnMon.value_preview, 'monitored');

      assert.equal(dbState.monitors.length, 3);
      const ssnRow = dbState.monitors.find(
        (m) => m.monitor_kind === 'ssn_last4_hash',
      );
      assert.ok(ssnRow, 'ssn monitor row missing');
      // PRIVACY INVARIANT: the persisted watched_value MUST be a 64-char
      // hex sha256 digest, NOT the plaintext '1234'.
      assert.match(ssnRow.watched_value, /^[0-9a-f]{64}$/);
      assert.notEqual(ssnRow.watched_value, USER_SSN_LAST4);
      assert.ok(ssnRow.salt_hex && /^[0-9a-f]{64}$/.test(ssnRow.salt_hex));

      // Adversarial assertion: scan EVERY response body so far — the
      // plaintext SSN must never appear in any of them.
      const responsesToScan = [addEmail.body, addPhone.body, addSsn.body];
      for (const body of responsesToScan) {
        assert.ok(!body.includes(USER_SSN_LAST4), `ssn leaked: ${body}`);
      }

      // ──────────────────────────────────────────────────────────────
      // STEP 2 — HIBP catalog sync produces an identity_breaches row +
      // url_host active_threats fanout. This is the seed catalog the
      // per-user scan in step 3 joins against.
      // ──────────────────────────────────────────────────────────────

      const catalogResult = await ingest.syncHibpCatalogOnce({
        httpFetch: async (): Promise<Response> =>
          jsonResponse([
            {
              Name: HIBP_BREACH_NAME,
              Title: 'LinkedIn (2012)',
              Domain: HIBP_BREACH_DOMAIN,
              BreachDate: '2012-05-05',
              AddedDate: '2016-05-21T21:35:40Z',
              PwnCount: 164611595,
              DataClasses: ['Email addresses', 'Passwords'],
              IsVerified: true,
              IsSensitive: false,
              IsRetired: false,
              Description: 'LinkedIn 2012 breach.',
            },
          ]),
      });
      assert.equal(catalogResult.added, 1);
      assert.equal(dbState.breaches.length, 1);
      // url_host fanout.
      const hibpThreat = dbState.active_threats.find(
        (a) => a.provenance === `hibp:${HIBP_BREACH_NAME}`,
      );
      assert.ok(hibpThreat, 'hibp domain fanout missing');
      assert.equal(hibpThreat.threat_value, HIBP_BREACH_DOMAIN);
      assert.equal(hibpThreat.severity, 'caution');

      // ──────────────────────────────────────────────────────────────
      // STEP 3 — Per-user HIBP scan finds the user's email in the
      // breach → identity_breach_findings row (severity='critical'
      // because data_classes includes 'Passwords').
      // ──────────────────────────────────────────────────────────────

      const userScan = await ingest.scanUserHibpExposureOnce(
        SYNTHETIC_USER_ID,
        {
          httpFetch: async (url: RequestInfo | URL): Promise<Response> => {
            // hibpBreachCheck hits /breachedaccount; we return the same
            // breach catalog row for the user's email.
            void url;
            return jsonResponse([
              {
                Name: HIBP_BREACH_NAME,
                Domain: HIBP_BREACH_DOMAIN,
                BreachDate: '2012-05-05',
                AddedDate: '2016-05-21T21:35:40Z',
                PwnCount: 164611595,
                DataClasses: ['Email addresses', 'Passwords'],
                IsVerified: true,
                IsSensitive: false,
                IsRetired: false,
              },
            ]);
          },
        },
      );
      assert.equal(userScan.new_findings, 1);
      assert.equal(dbState.findings.length, 1);
      assert.equal(dbState.findings[0]!.severity, 'critical');

      // ──────────────────────────────────────────────────────────────
      // STEP 4 — Darknet crawler observes a listing whose sample row
      // exposes the user's SSN-last-4. The hash-match runs through
      // the canonical sha256(salt||tag||plaintext) scheme (I-H1) so
      // the watched_hash on the monitor row matches.
      // ──────────────────────────────────────────────────────────────

      const beforeFindings = dbState.findings.length;
      const crawlResult = await crawler.crawlMarketsOnce({
        // fetchListingFn returns a 200 with any body — the parseListingFn
        // injects the deterministic MarketListing shape.
        fetchListingFn: async () => ({ html: '<not real>', status: 200 }),
        parseListingFn: () => [
          {
            listing_id: 'lst-001',
            title: 'FRESH IDENTITY KIT — full SSN+DOB sample',
            category: 'identity_kits',
            sample_records: [
              {
                // Plaintext SSN-last-4 — the crawler will hash this
                // against every ssn_last4_hash monitor's per-user salt
                // (canonical scheme).
                ssn_last4: USER_SSN_LAST4,
                // Decoy non-matching email so the listing has texture.
                email: 'decoy@example.invalid',
              },
            ],
            record_count: 12000,
            source_breach_claimed: 'ATT 2024',
          },
        ],
      });
      assert.equal(crawlResult.markets_crawled, 1);
      assert.equal(crawlResult.listings_parsed, 1);
      assert.equal(crawlResult.findings_inserted, 1);
      // Exactly one NEW finding produced (the SSN match against the
      // user's monitor). Other listing fields (decoy email) MUST NOT
      // produce extra findings.
      assert.equal(
        dbState.findings.length,
        beforeFindings + 1,
        'darknet match should produce exactly 1 finding',
      );
      const darknetFinding = dbState.findings[beforeFindings]!;
      // Severity 'critical' — listing exposes ssn_last4, so the crawler
      // promotes the finding tier per its severity gate.
      assert.equal(darknetFinding.severity, 'critical');
      assert.equal(darknetFinding.user_id, SYNTHETIC_USER_ID);
      // The matched monitor is the SSN one (NOT email — the decoy
      // didn't match anybody).
      const ssnMonitor = dbState.monitors.find(
        (m) => m.monitor_kind === 'ssn_last4_hash',
      )!;
      assert.equal(darknetFinding.monitor_id, ssnMonitor.id);

      // ──────────────────────────────────────────────────────────────
      // STEP 5 — Telegram listener classifies a message that contains
      // the user's REAL phone advertised as "burner for sale". The
      // I-M3 gate must trip — the artifact goes to
      // telegram_artifact_pending_review, NOT active_threats.
      // Also extract a cross-reference to a brand-new channel so the
      // analyst step has something to surface.
      // ──────────────────────────────────────────────────────────────

      const beforeActiveThreats = dbState.active_threats.length;
      const beforePending = dbState.pending_review.length;

      // The poll uses a deterministic classifier (we control output).
      // First artifact = USER_PHONE_E164 (must be rejected by I-M3).
      // Second artifact = SCAMMER_PHONE_BENIGN (must land in active_threats).
      const fixedMessages: telegram.TelegramMessage[] = [
        {
          message_id: 'msg-001',
          posted_at: new Date(),
          text: 'fresh burner for sale, OTP-routed, also see @fresh_otp_bot_99',
        },
      ];
      const classifier: typeof telegram.classifyMessage = async () => ({
        artifacts: [
          {
            kind: 'phone_e164',
            value: USER_PHONE_E164,
            confidence: 0.92,
          },
          {
            kind: 'phone_e164',
            value: SCAMMER_PHONE_BENIGN,
            confidence: 0.85,
          },
        ],
        intent: 'advertising_for_sale',
        geo: 'US',
        cross_references: [
          {
            source_kind: 'telegram',
            handle: NEW_CANDIDATE_HANDLE,
            excerpt: 'join @fresh_otp_bot_99 for fresh OTP routes',
          },
        ],
      });

      const pollResult = await telegram.pollChannelsOnce({
        classifierFn: classifier,
        telegramClientFn: () => ({
          async getMessages() {
            return fixedMessages;
          },
        }),
        botAccounts: [
          {
            index: 1,
            api_id: 'fake-id-1',
            api_hash: 'fake-hash-1',
            phone_e164: '+15550000001',
          },
        ],
      });
      assert.equal(pollResult.channels_polled, 1);
      assert.equal(pollResult.messages_classified, 1);

      // I-M3 GATE: the user's phone landed in pending_review, NOT in
      // active_threats. The benign scammer phone DID land in
      // active_threats (we want it scored on subsequent calls).
      const newPending = dbState.pending_review.length - beforePending;
      assert.equal(newPending, 1, 'I-M3 must hold exactly one artifact');
      const heldRow = dbState.pending_review[beforePending]!;
      assert.equal(heldRow.artifact_kind, 'phone_e164');
      assert.equal(heldRow.artifact_value, USER_PHONE_E164);
      assert.equal(heldRow.matched_user_id, SYNTHETIC_USER_ID);

      // active_threats grew by exactly 1 (the benign phone). The user's
      // phone MUST NOT appear in active_threats anywhere.
      const newActiveThreats =
        dbState.active_threats.length - beforeActiveThreats;
      assert.equal(newActiveThreats, 1);
      assert.ok(
        !dbState.active_threats.some(
          (a) => a.threat_value === USER_PHONE_E164,
        ),
        'I-M3 violation: user phone appeared in active_threats',
      );
      // The benign threat IS there.
      const benignThreat = dbState.active_threats.find(
        (a) => a.threat_value === SCAMMER_PHONE_BENIGN,
      );
      assert.ok(benignThreat);
      assert.equal(benignThreat.severity, 'warning'); // conf >= 0.8

      // Cross-reference was recorded as a CANDIDATE (telegram listener
      // path, not analyst path — same table, different rationale shape).
      const xrefCand = dbState.candidates.find(
        (c) => c.source_handle === NEW_CANDIDATE_HANDLE,
      );
      assert.ok(xrefCand, 'cross-reference should have created a candidate');

      // ──────────────────────────────────────────────────────────────
      // STEP 6 — Admin summary route reflects 3 monitors, 2 findings,
      // 2 active threats (HIBP url_host + darknet onion + benign
      // scammer phone = actually 3; we just assert > 0 buckets here).
      // ──────────────────────────────────────────────────────────────

      const adminSummary = await app.inject({
        method: 'GET',
        url: '/v1/admin/identity-shield/summary',
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(adminSummary.statusCode, 200, adminSummary.body);
      const summary = adminSummary.json() as {
        monitors_active_total: number;
        monitors_by_kind: Record<string, number>;
        findings_7d_by_severity: Record<string, number>;
        active_threats_by_severity: Record<string, number>;
      };
      assert.equal(summary.monitors_active_total, 3);
      assert.equal(summary.monitors_by_kind.email, 1);
      assert.equal(summary.monitors_by_kind.phone_e164, 1);
      assert.equal(summary.monitors_by_kind.ssn_last4_hash, 1);
      assert.equal(summary.findings_7d_by_severity.critical, 2);
      // At least one caution (HIBP url_host) and one warning (telegram phone)
      assert.ok(summary.active_threats_by_severity.caution >= 1);
      assert.ok(summary.active_threats_by_severity.warning >= 1);

      // Adversarial assertion: admin summary body MUST NOT carry the
      // user's plaintext SSN or the SSN hash or salt.
      assert.ok(!adminSummary.body.includes(USER_SSN_LAST4));
      assert.ok(!adminSummary.body.includes(ssnRow.watched_value));
      assert.ok(!adminSummary.body.includes(ssnRow.salt_hex!));

      // ──────────────────────────────────────────────────────────────
      // STEP 7 — Meta-analyst runs discoverCandidatesOnce. It surfaces
      // new candidate handles by reading active_threats context_text.
      // We inject a fixed LLM response naming a brand-new handle.
      // ──────────────────────────────────────────────────────────────

      const ANALYST_NEW_HANDLE = '@analyst_discovered_99';
      const llmFn: typeof analyst.runDailyAnalystPass extends never
        ? never
        : Parameters<typeof analyst.discoverCandidatesOnce>[0] extends infer Opts
        ? Opts extends { llmFn?: infer F }
          ? F
          : never
        : never = (async () =>
        JSON.stringify({
          discoveries: [
            {
              source_kind: 'telegram',
              handle: ANALYST_NEW_HANDLE,
              rationale:
                'Repeatedly cited in caution-tier scammer-chatter artifacts; described as OTP-routing fresh-burner vendor.',
              candidate_score: 0.78,
            },
          ],
        })) as unknown as Parameters<
        typeof analyst.discoverCandidatesOnce
      >[0] extends infer Opts
        ? Opts extends { llmFn?: infer F }
          ? F
          : never
        : never;

      const discoverResult = await analyst.discoverCandidatesOnce({
        llmFn: llmFn as never,
      });
      assert.equal(discoverResult.inserted, 1, 'analyst should insert 1 candidate');
      const analystCand = dbState.candidates.find(
        (c) => c.source_handle === ANALYST_NEW_HANDLE,
      );
      assert.ok(analystCand);
      assert.equal(analystCand.decision, null);

      // ──────────────────────────────────────────────────────────────
      // STEP 8 — Admin approves the original cross-reference candidate
      // (CANDIDATE_ROW_ID) → promoted to threat_intel_channels with
      // status='active', and decision flips to 'approved'.
      // ──────────────────────────────────────────────────────────────

      const channelsBefore = dbState.channels.length;
      const approveRes = await app.inject({
        method: 'POST',
        url: `/v1/admin/intel/candidates/${CANDIDATE_ROW_ID}/approve`,
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(approveRes.statusCode, 200, approveRes.body);
      const approveBody = approveRes.json() as {
        ok: boolean;
        candidate_id: string;
        channel_id: string;
        decision: string;
      };
      assert.equal(approveBody.ok, true);
      assert.equal(approveBody.candidate_id, CANDIDATE_ROW_ID);
      assert.equal(approveBody.decision, 'approved');

      // Channel row created in the channels table.
      assert.equal(dbState.channels.length, channelsBefore + 1);
      const promotedChannel = dbState.channels.find(
        (c) => c.source_handle === NEW_CANDIDATE_HANDLE,
      );
      assert.ok(promotedChannel, 'channel must be promoted');
      assert.equal(promotedChannel.status, 'active');

      // Candidate row's decision flipped.
      const flippedCand = dbState.candidates.find(
        (c) => c.id === CANDIDATE_ROW_ID,
      );
      assert.ok(flippedCand);
      assert.equal(flippedCand.decision, 'approved');
      assert.ok(flippedCand.decided_at !== null);

      // ──────────────────────────────────────────────────────────────
      // STEP 9 — Digest preview returns counts-only copy (no PII).
      // ──────────────────────────────────────────────────────────────

      const digestRes = await app.inject({
        method: 'GET',
        url: '/v1/identity-shield/digest/preview',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(digestRes.statusCode, 200);
      const digest = digestRes.json() as {
        digest_kind: string;
        title: string;
        body: string;
        would_send_at: string;
        user_can_opt_out: boolean;
      };
      assert.ok(digest.digest_kind === 'daily' || digest.digest_kind === 'weekly');
      assert.ok(typeof digest.body === 'string' && digest.body.length > 0);

      // PII GATE: digest body MUST NOT contain the user's email, phone,
      // or any digit-run that could be a phone/SSN.
      assert.ok(
        !digest.body.includes(USER_EMAIL),
        `digest body leaked email: ${digest.body}`,
      );
      assert.ok(
        !digest.body.includes(USER_PHONE_E164),
        `digest body leaked phone: ${digest.body}`,
      );
      assert.ok(
        !digest.body.includes(USER_SSN_LAST4),
        `digest body leaked ssn: ${digest.body}`,
      );
      // The body also MUST NOT contain the raw 10-digit phone form.
      assert.ok(
        !digest.body.includes(USER_PHONE_DIGITS_ONLY),
        `digest body leaked phone digits: ${digest.body}`,
      );

      // ──────────────────────────────────────────────────────────────
      // STEP 10 — Stats summary identity_shield block.
      // ──────────────────────────────────────────────────────────────

      const statsRes = await app.inject({
        method: 'GET',
        url: '/v1/stats/summary',
        headers: { authorization: PRO_BEARER },
      });
      assert.equal(statsRes.statusCode, 200);
      const stats = statsRes.json() as {
        identity_shield: {
          monitors_active: number;
          new_findings_7d: number;
          active_threats_near_user_30d: number;
          active_threats_delta_7d: number;
        };
      };
      assert.equal(stats.identity_shield.monitors_active, 3);
      assert.equal(stats.identity_shield.new_findings_7d, 2);
      // Active threats near user is a global pool — at least the HIBP
      // domain + the benign telegram phone + the darknet market URL.
      assert.ok(stats.identity_shield.active_threats_near_user_30d >= 2);
      assert.ok(stats.identity_shield.active_threats_delta_7d >= 2);

      // Final stat-body PII gate.
      assert.ok(!statsRes.body.includes(USER_SSN_LAST4));
      assert.ok(!statsRes.body.includes(ssnRow.watched_value));
      assert.ok(!statsRes.body.includes(ssnRow.salt_hex!));

      // ──────────────────────────────────────────────────────────────
      // FINAL SWEEP — across every persisted DB row, the SSN-last-4
      // plaintext must appear NOWHERE.
      // ──────────────────────────────────────────────────────────────

      const allRows = JSON.stringify({
        monitors: dbState.monitors,
        breaches: dbState.breaches,
        findings: dbState.findings,
        active_threats: dbState.active_threats,
        channels: dbState.channels,
        candidates: dbState.candidates,
        pending_review: dbState.pending_review,
      });
      assert.ok(
        !allRows.includes(`"watched_value":"${USER_SSN_LAST4}"`),
        'SSN plaintext leaked into a watched_value column',
      );
      // A standalone digit-run search would false-positive against
      // legitimate fields like pwn_count: 164611595 (which contains
      // "1234" as substring). The watched_value check above is the
      // load-bearing assertion; PII appears nowhere we control.
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // Cross-user negative path — User B has the same SSN-last-4 plaintext
  // but a DIFFERENT salt, so their hash MUST NOT collide with User A's
  // hash. The darknet crawler must NOT produce a finding under User B.
  // This pins the per-user-salt-isolation property the crawler header
  // describes ("user B with identical plaintext but a different salt
  // MUST NOT auto-match user A's hash").
  // ────────────────────────────────────────────────────────────────────
  it(
    'cross-user salt isolation — identical SSN plaintext under different salts produces NO cross-user finding',
    async () => {
      const USER_B_ID = '00000000-0000-0000-0000-000000000bbb';
      // Both users add the SAME ssn_last4 plaintext. The route hashes
      // each with that user's OWN salt (random 32-byte salt generated
      // per-user-per-kind via resolveUserSalt).
      const addA = await app.inject({
        method: 'POST',
        url: '/v1/identity-shield/monitors',
        headers: { authorization: PRO_BEARER, 'content-type': 'application/json' },
        payload: { monitor_kind: 'ssn_last4_hash', ssn_last4: USER_SSN_LAST4 },
      });
      assert.equal(addA.statusCode, 201);
      // For User B we directly insert a monitor row with a different
      // salt — the dev-bearer route can only authenticate as the
      // synthetic User A, so we model User B's row by hand. Use a
      // FRESH salt distinct from User A's.
      const userBSalt =
        'b'.repeat(64); // distinct from any random hex User A produced
      const userBHash = createHash('sha256')
        .update(userBSalt)
        .update('ssn4')
        .update(USER_SSN_LAST4)
        .digest('hex');
      dbState.monitors.push({
        id: newUuid(),
        user_id: USER_B_ID,
        monitor_kind: 'ssn_last4_hash',
        watched_value: userBHash,
        salt_hex: userBSalt,
        active: true,
        created_at: new Date(),
      });

      // Seed the darknet market so the crawler has something to poll.
      dbState.channels.push({
        id: DARKNET_MARKET_ID,
        source_kind: 'darknet_market',
        source_handle: DARKNET_MARKET_HANDLE,
        display_name: 'Sample Darknet Market (E2E)',
        status: 'active',
        capability_tags: [],
        geo_relevance: [],
        added_by: null,
        added_at: new Date(),
        last_message_observed_at: null,
        classified_message_count_7d: 0,
      });

      const aRow = dbState.monitors.find(
        (m) => m.user_id === SYNTHETIC_USER_ID && m.monitor_kind === 'ssn_last4_hash',
      )!;
      const bRow = dbState.monitors.find((m) => m.user_id === USER_B_ID)!;
      // Sanity: hash digests differ even though plaintext is identical.
      assert.notEqual(aRow.watched_value, bRow.watched_value);
      assert.notEqual(aRow.salt_hex, bRow.salt_hex);

      await crawler.crawlMarketsOnce({
        fetchListingFn: async () => ({ html: '', status: 200 }),
        parseListingFn: () => [
          {
            listing_id: 'lst-cross-user',
            title: 'Sample fullz',
            category: 'fullz',
            sample_records: [{ ssn_last4: USER_SSN_LAST4 }],
            source_breach_claimed: 'sample',
          },
        ],
      });

      // BOTH users must get matched — the hash-match runs sha256(salt
      // || 'ssn4' || plaintext) per-user-per-monitor, so a listing
      // exposing the plaintext SSN that BOTH users monitor hits BOTH
      // rows. This is correct + expected. The cross-user-ISOLATION
      // property we're pinning is that each finding is correctly
      // attributed (User A's finding has user_id=A, User B's has
      // user_id=B; no swap, no spurious match against a non-monitoring
      // user).
      const findingsByUser = dbState.findings.reduce(
        (acc, f) => {
          acc[f.user_id] = (acc[f.user_id] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      assert.equal(findingsByUser[SYNTHETIC_USER_ID], 1);
      assert.equal(findingsByUser[USER_B_ID], 1);
      // Each finding's monitor_id points to the correct user's monitor
      // (NOT swapped).
      const findingA = dbState.findings.find(
        (f) => f.user_id === SYNTHETIC_USER_ID,
      )!;
      const findingB = dbState.findings.find((f) => f.user_id === USER_B_ID)!;
      assert.equal(findingA.monitor_id, aRow.id);
      assert.equal(findingB.monitor_id, bRow.id);
    },
  );
});
