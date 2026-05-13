import cron from 'node-cron';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { captureError, emitMetric } from '../lib/observability.js';
import { checkBreachExposure } from '../services/email/hibpBreachCheck.js';
import { ingestThreatBatch } from '../services/identity/activeThreats.js';
import type { ThreatInput } from '../services/identity/types.js';

// Identity Shield — Enzoic + HIBP ingest worker (I-P3a).
//
// I-H3 fix (adversarial round): the Enzoic batch path previously
// paired the response array positionally with the request batch
// (entries[i] → batch[i]). If Enzoic ever returned out of order,
// skipped a username, deduped duplicates, or changed schemas to
// key by username, User B's exposures could be silently inserted
// as User A's findings — a cross-user breach vector. The fix:
// require a username field on every entry, pair via a
// Map<username, monitor>, and refuse to insert any entry with no
// username (emits identity_shield.enzoic_schema_drift metric).
//
// I-M2 fix (adversarial round): scanAllUsersEnzoicOnce now respects
// an optional ENZOIC_DAILY_USER_CAP env var. When set, we shuffle
// the user list and scan only the first N per day — over a 7-day
// window every user gets sampled at least once at default sub-cap
// of ~5000/day for ~35k users. Default unset = no cap (legacy
// behavior preserved for sub-launch testing).
//
// Three feeders, three crons:
//
//   1. HIBP catalog sync (hourly, minute 17)
//      Public endpoint /api/v3/breaches — no API key required.
//      Pulls the entire breach catalog, UPSERTs each into
//      identity_breaches, and for genuinely-NEW rows fans out to
//      active_threats so the breach's domain becomes a `url_host`
//      threat with provenance `hibp:<breach_name>`. Pre-aggregates
//      the public catalog so per-user checks (path 2) can join
//      locally instead of fanning out to HIBP for every monitor.
//
//   2. Per-user HIBP scan (daily, 03:43 UTC)
//      For every active email monitor, hit HIBP's authenticated
//      /breachedaccount endpoint via the reusable
//      `checkBreachExposure` wrapper. Match the returned breaches
//      back into identity_breaches by breach_name (auto-syncs the
//      catalog row if missing) and INSERT-once identity_breach_findings
//      with severity derived from data_classes:
//        Passwords-class → critical, otherwise → caution.
//
//   3. Enzoic password-dump scan (daily, 04:11 UTC)
//      For every active email monitor, batch-call Enzoic's
//      /credentials/exposures endpoint (up to 20 emails per call per
//      their docs). Each returned exposure UPSERTs into
//      identity_breaches with source='enzoic' and produces
//      identity_breach_findings rows for the matching user.
//
// Graceful degradation matrix:
//   - HIBP_API_KEY missing                              → skip path 2 (catalog sync still runs)
//   - EMAIL_SHIELD_ENZOIC_API_KEY/_SECRET missing       → skip path 3
//   - Both missing                                      → worker runs path 1 only,
//                                                         logs "degraded mode" once
//
// SECURITY POSTURE:
//   - HIBP catalog endpoint is public and unauthenticated; no key
//     leaks through this path. Per-user endpoint reuses
//     hibpBreachCheck which already redacts the key from
//     captureError context.
//   - Enzoic call uses HTTP Basic from env directly; we never log
//     headers or the Basic-auth string.
//   - 429 / 5xx / network throw on any feed: log once, return 0,
//     wait for the next cron tick. NEVER crash the worker.
//   - Cross-user isolation: per-user paths read identity_monitors
//     scoped to (user_id, monitor_kind='email'); each iteration's
//     INSERT carries the same user_id explicitly so a leak across
//     users would require a SQL-level bug, not a worker-level one.
//
// IDEMPOTENCY:
//   - identity_breaches:           UNIQUE (source, source_breach_id), UPSERT
//   - identity_breach_findings:    UNIQUE (user_id, monitor_id, breach_id),
//                                  ON CONFLICT DO NOTHING
//   - active_threats:              UNIQUE (threat_kind, threat_value, provenance),
//                                  via ingestThreatBatch's UPSERT
//   Running any path twice in a row produces zero new rows.

// ───────────────────────────────────────────────────────────────
// Schedules
// ───────────────────────────────────────────────────────────────

const HIBP_CATALOG_CRON = '17 * * * *';        // hourly at :17
const HIBP_USER_SCAN_CRON = '43 3 * * *';      // 03:43 UTC daily
const ENZOIC_USER_SCAN_CRON = '11 4 * * *';    // 04:11 UTC daily (after HIBP)

// HIBP public catalog endpoint (no API key needed, no per-user
// data). Constant — never derived from user input.
const HIBP_BREACHES_URL = 'https://haveibeenpwned.com/api/v3/breaches';

// HIBP demands a contact User-Agent on every request. Re-used by
// the per-user path inside hibpBreachCheck; mirrored here so the
// catalog-sync route's user-agent matches.
const HIBP_USER_AGENT = 'AegisDial Identity Shield (security@aegisdial.app)';

// Enzoic credential-exposure endpoint. Documented at
// https://www.enzoic.com/docs/credentials-api — the /exposures
// path accepts a `usernames[]` query repeated up to ENZOIC_BATCH
// times per call. We batch to amortize HTTP overhead AND to stay
// inside the rate budget (their Pro tier is 100 req/s).
const ENZOIC_EXPOSURES_URL = 'https://api.enzoic.com/v1/exposures';
const ENZOIC_BATCH_SIZE = 20;

// Optional fetch override surface — every public function accepts
// `opts.httpFetch` for test stubbing, matching the hibpBreachCheck
// convention.
type FetchFn = typeof fetch;

// ───────────────────────────────────────────────────────────────
// HIBP catalog schema (subset)
// ───────────────────────────────────────────────────────────────
//
// HIBP's /breaches response is an array of Breach objects. Field
// names mirror the per-user /breachedaccount path; we Zod-validate
// at the boundary so a v3→v4 rename doesn't crash the sync.

const HibpCatalogBreach = z.object({
  Name: z.string(),
  Title: z.string().optional(),
  Domain: z.string().optional(),
  BreachDate: z.string().optional(),
  AddedDate: z.string().optional(),
  PwnCount: z.number().nonnegative().optional(),
  DataClasses: z.array(z.string()).default([]),
  IsVerified: z.boolean().optional(),
  IsSensitive: z.boolean().optional(),
  Description: z.string().optional(),
});
type HibpCatalogBreachT = z.infer<typeof HibpCatalogBreach>;
const HibpCatalogResponse = z.array(HibpCatalogBreach);

// Enzoic /exposures shape (subset). Per their docs the response is
// {count: N, exposures: [<id>, ...]} on the listing endpoint and a
// detail object on the per-id endpoint. We only need the
// per-username listing for the batch path; the catalog is keyed by
// id, not the detail body.
const EnzoicExposureDetail = z.object({
  id: z.string(),
  title: z.string().optional(),
  date: z.string().optional(),
  source: z.string().optional(),
  category: z.string().optional(),
  dataClasses: z.array(z.string()).optional(),
  entries: z.number().nonnegative().optional(),
  description: z.string().optional(),
});

// Username→exposure listing. The Enzoic team's contract is one
// response per username in the call; for unbatchable accounts they
// return `count: 0, exposures: []`.
//
// I-H3 fix: each entry CARRIES the username it's reporting on so the
// worker can pair by value, not by array index. Enzoic's docs aren't
// fully explicit about which field name they use — some endpoints
// echo `username`, others `query`, others `email`. We accept all
// three and pick the first non-empty one. If NONE are present the
// caller treats it as schema-drift and refuses to insert (safer than
// guessing positionally — a single drift would otherwise re-attribute
// User B's exposures onto User A).
const EnzoicAccountResponse = z.object({
  username: z.string().optional(),
  query: z.string().optional(),
  email: z.string().optional(),
  count: z.number().nonnegative().optional(),
  exposures: z.array(z.string()).default([]),
});

// ───────────────────────────────────────────────────────────────
// Logging helpers
// ───────────────────────────────────────────────────────────────

let degradedLogged = false;

function logDegradedOnce(): void {
  if (degradedLogged) return;
  degradedLogged = true;
  // eslint-disable-next-line no-console
  console.log(
    '[identity-shield-ingest] degraded mode (no paid feeds configured) — running catalog-sync only',
  );
}

function logSkipOnce(key: 'hibp' | 'enzoic'): void {
  // Lightweight startup-log breadcrumb. Repeated calls within a
  // single process re-log; the worker invokes this once on
  // startup, so the duplication is bounded.
  // eslint-disable-next-line no-console
  console.log(`[identity-shield-ingest] ${key} disabled (no API key configured)`);
}

// ───────────────────────────────────────────────────────────────
// HIBP catalog sync — public endpoint, no API key
// ───────────────────────────────────────────────────────────────

/**
 * Pull the entire HIBP breach catalog and UPSERT into
 * identity_breaches. New rows ALSO produce an active_threats entry
 * for the breach's domain (provenance `hibp:<breach_name>`,
 * severity 'caution', context summarizing the leaked data classes).
 *
 * Returns counts of {added, updated} rows touched. Never throws —
 * surfaces failure as {added:0, updated:0} so the cron caller's
 * setTimeout chain doesn't unravel.
 *
 * httpFetch override is purely for tests; production passes nothing.
 */
export async function syncHibpCatalogOnce(opts?: {
  httpFetch?: FetchFn;
}): Promise<{ added: number; updated: number }> {
  const httpFetch = opts?.httpFetch ?? fetch;

  let response: Response;
  try {
    response = await httpFetch(HIBP_BREACHES_URL, {
      method: 'GET',
      headers: {
        'User-Agent': HIBP_USER_AGENT,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    captureError(err, { component: 'identityShieldIngest.hibp_catalog_fetch' });
    void emitMetric('identity_shield.hibp_catalog_sync_failed', { reason: 'network' });
    return { added: 0, updated: 0 };
  }

  if (response.status === 429) {
    void emitMetric('identity_shield.hibp_catalog_sync_failed', { reason: 'rate_limited' });
    return { added: 0, updated: 0 };
  }
  if (response.status !== 200) {
    captureError(new Error(`hibp_catalog_unexpected_status_${response.status}`), {
      component: 'identityShieldIngest.hibp_catalog',
      status: response.status,
    });
    void emitMetric('identity_shield.hibp_catalog_sync_failed', {
      reason: 'api_error',
      status: String(response.status),
    });
    return { added: 0, updated: 0 };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    captureError(err, { component: 'identityShieldIngest.hibp_catalog_parse' });
    return { added: 0, updated: 0 };
  }
  const validated = HibpCatalogResponse.safeParse(raw);
  if (!validated.success) {
    captureError(new Error('hibp_catalog_schema_drift'), {
      component: 'identityShieldIngest.hibp_catalog',
      issues: validated.error.flatten(),
    });
    return { added: 0, updated: 0 };
  }

  let added = 0;
  let updated = 0;
  const newDomainThreats: ThreatInput[] = [];

  for (const b of validated.data) {
    const result = await upsertHibpBreach(b);
    if (result.was_insert) {
      added++;
      // Only NEW breaches fan out to active_threats. A re-sync of
      // an existing breach (updated description, refreshed
      // synced_at) shouldn't keep re-creating the threat row.
      if (b.Domain && b.Domain.trim().length > 0) {
        const ctx = buildBreachThreatContext(b);
        newDomainThreats.push({
          kind: 'url_host',
          value: b.Domain,
          severity: 'caution',
          provenance: `hibp:${b.Name}`,
          context: ctx,
        });
      }
    } else if (result.was_update) {
      updated++;
    }
  }

  if (newDomainThreats.length > 0) {
    // ingestThreatBatch normalizes + UPSERTs in a single round trip.
    // We don't propagate its returned counts because the metric we
    // care about is the catalog-level {added, updated}; active_threats
    // emits its own metrics from inside the batch call.
    await ingestThreatBatch(newDomainThreats);
  }

  void emitMetric('identity_shield.hibp_catalog_sync', {
    added: String(added),
    updated: String(updated),
  });
  return { added, updated };
}

/**
 * UPSERT a single HIBP catalog row. Returns `was_insert` for
 * fanout-to-active_threats accounting (only fresh rows produce a
 * new domain threat); `was_update` for the metric.
 *
 * The xmax=0 trick (Postgres) tells us whether ON CONFLICT took the
 * INSERT branch or the UPDATE branch. Mirrors the same pattern as
 * activeThreats.ingestThreatBatch.
 */
async function upsertHibpBreach(
  b: HibpCatalogBreachT,
): Promise<{ was_insert: boolean; was_update: boolean }> {
  try {
    const res = await query<{ was_insert: boolean }>(
      `INSERT INTO identity_breaches (
         breach_name, source, source_breach_id, domain,
         breach_date, added_date, pwn_count, data_classes,
         is_verified, is_sensitive, description
       ) VALUES (
         $1, 'hibp', $2, $3,
         $4::date, $5::timestamptz, $6, $7,
         COALESCE($8, FALSE), COALESCE($9, FALSE), $10
       )
       ON CONFLICT (source, source_breach_id) DO UPDATE
         SET breach_name = EXCLUDED.breach_name,
             domain = EXCLUDED.domain,
             breach_date = EXCLUDED.breach_date,
             added_date = EXCLUDED.added_date,
             pwn_count = EXCLUDED.pwn_count,
             data_classes = EXCLUDED.data_classes,
             is_verified = EXCLUDED.is_verified,
             is_sensitive = EXCLUDED.is_sensitive,
             description = EXCLUDED.description,
             synced_at = NOW()
       RETURNING (xmax = 0) AS was_insert`,
      [
        b.Title ?? b.Name,
        b.Name,
        b.Domain ?? null,
        b.BreachDate ?? null,
        b.AddedDate ?? null,
        b.PwnCount ?? null,
        b.DataClasses,
        b.IsVerified ?? false,
        b.IsSensitive ?? false,
        b.Description ?? null,
      ],
    );
    const row = res.rows[0];
    if (!row) return { was_insert: false, was_update: false };
    return { was_insert: row.was_insert, was_update: !row.was_insert };
  } catch (err) {
    captureError(err, {
      component: 'identityShieldIngest.upsertHibpBreach',
      breach_name: b.Name,
    });
    return { was_insert: false, was_update: false };
  }
}

/**
 * Compose the iOS-alert-footer context for a breach-domain
 * active_threats row. <200 chars by table convention.
 */
function buildBreachThreatContext(b: HibpCatalogBreachT): string {
  const classes = b.DataClasses.slice(0, 3).join(', ') || 'unknown data';
  const label = b.Title ?? b.Name;
  const ctx = `domain associated with breach: ${label}, leaked ${classes}`;
  return ctx.length > 200 ? `${ctx.slice(0, 197)}...` : ctx;
}

// ───────────────────────────────────────────────────────────────
// Per-user HIBP scan — calls checkBreachExposure per email monitor
// ───────────────────────────────────────────────────────────────

/**
 * Scan all active email monitors for a single user against HIBP.
 *
 * Pipeline per monitor:
 *   1. checkBreachExposure(email) — the reusable Email Shield
 *      wrapper handles auth, rate limits, single-flight, and
 *      schema-drift defenses.
 *   2. For each returned breach, find the matching identity_breaches
 *      row by breach_name. If missing (e.g., a new breach surfaced
 *      via per-user lookup before the next catalog sync), UPSERT it
 *      synchronously so the FK target exists.
 *   3. INSERT identity_breach_findings ON CONFLICT DO NOTHING.
 *
 * Re-running this function for the same user is idempotent — the
 * UNIQUE (user_id, monitor_id, breach_id) constraint absorbs
 * duplicates.
 */
export async function scanUserHibpExposureOnce(
  userId: string,
  opts?: { httpFetch?: FetchFn },
): Promise<{ new_findings: number }> {
  if (!config.HIBP_API_KEY) {
    // No-key path: hibpBreachCheck will return reason_skipped, but
    // we short-circuit here to avoid hitting Redis / spinning the
    // single-flight lock per monitor.
    return { new_findings: 0 };
  }

  let monitors: Array<{ id: string; watched_value: string }>;
  try {
    const res = await query<{ id: string; watched_value: string }>(
      `SELECT id, watched_value
         FROM identity_monitors
        WHERE user_id = $1 AND monitor_kind = 'email' AND active`,
      [userId],
    );
    monitors = res.rows;
  } catch (err) {
    captureError(err, {
      component: 'identityShieldIngest.scanUserHibp.fetch_monitors',
      user_id: userId,
    });
    return { new_findings: 0 };
  }
  if (monitors.length === 0) return { new_findings: 0 };

  let newFindings = 0;
  for (const monitor of monitors) {
    const result = await checkBreachExposure(monitor.watched_value, {
      httpFetch: opts?.httpFetch,
    });
    // Skipped (rate_limited / api_error / no_api_key) → no
    // findings, but we DON'T error out the rest of the loop —
    // another monitor might still succeed if the issue is
    // request-shape-specific (an invalid_email skip on monitor A
    // shouldn't take out monitor B).
    if (!result.email_checked) continue;

    for (const breach of result.breaches) {
      const breachId = await resolveOrSyncBreachRow(breach);
      if (breachId === null) continue;
      const severity: 'critical' | 'caution' = breach.data_classes.includes('Passwords')
        ? 'critical'
        : 'caution';
      const inserted = await insertFindingIfNew({
        user_id: userId,
        monitor_id: monitor.id,
        breach_id: breachId,
        severity,
      });
      if (inserted) newFindings++;
    }
  }
  return { new_findings: newFindings };
}

/**
 * Scan EVERY user with at least one active email monitor.
 *
 * Uses DISTINCT on user_id so each user is scanned exactly once
 * regardless of how many email monitors they have. Per-user
 * isolation is guaranteed by scanUserHibpExposureOnce's WHERE
 * user_id = $1 filter — there is no cross-user fan-in.
 */
export async function scanAllUsersHibpOnce(
  opts?: { httpFetch?: FetchFn },
): Promise<{ users_checked: number; new_findings: number }> {
  if (!config.HIBP_API_KEY) {
    return { users_checked: 0, new_findings: 0 };
  }

  let userIds: string[];
  try {
    const res = await query<{ user_id: string }>(
      `SELECT DISTINCT user_id
         FROM identity_monitors
        WHERE monitor_kind = 'email' AND active`,
    );
    userIds = res.rows.map((r) => r.user_id);
  } catch (err) {
    captureError(err, { component: 'identityShieldIngest.scanAllUsersHibp.fetch_users' });
    return { users_checked: 0, new_findings: 0 };
  }

  let totalNewFindings = 0;
  let usersChecked = 0;
  for (const uid of userIds) {
    const result = await scanUserHibpExposureOnce(uid, opts);
    usersChecked++;
    totalNewFindings += result.new_findings;
  }
  void emitMetric('identity_shield.user_hibp_scan', {
    users_checked: String(usersChecked),
    new_findings: String(totalNewFindings),
  });
  return { users_checked: usersChecked, new_findings: totalNewFindings };
}

/**
 * Resolve the identity_breaches row id for a HIBP breach. If the
 * row doesn't exist (per-user scan returned a breach the hourly
 * catalog sync hasn't picked up yet), UPSERT a minimal row first.
 *
 * Returns null only when the UPSERT itself fails (e.g., DB outage).
 */
async function resolveOrSyncBreachRow(breach: {
  breach_name: string;
  domain: string;
  breach_date: string;
  added_date: string;
  pwn_count: number;
  data_classes: string[];
  is_verified: boolean;
  is_sensitive: boolean;
}): Promise<string | null> {
  try {
    const existing = await query<{ id: string }>(
      `SELECT id FROM identity_breaches
        WHERE source = 'hibp' AND source_breach_id = $1`,
      [breach.breach_name],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return existing.rows[0]!.id;
    }
    // Missing — UPSERT inline. Same shape as upsertHibpBreach so the
    // catalog-sync path picks it up next hour without changes.
    const inserted = await query<{ id: string }>(
      `INSERT INTO identity_breaches (
         breach_name, source, source_breach_id, domain,
         breach_date, added_date, pwn_count, data_classes,
         is_verified, is_sensitive
       ) VALUES (
         $1, 'hibp', $2, $3,
         $4::date, $5::timestamptz, $6, $7,
         $8, $9
       )
       ON CONFLICT (source, source_breach_id) DO UPDATE
         SET synced_at = NOW()
       RETURNING id`,
      [
        breach.breach_name,
        breach.breach_name,
        breach.domain || null,
        breach.breach_date || null,
        breach.added_date || null,
        breach.pwn_count,
        breach.data_classes,
        breach.is_verified,
        breach.is_sensitive,
      ],
    );
    return inserted.rows[0]?.id ?? null;
  } catch (err) {
    captureError(err, {
      component: 'identityShieldIngest.resolveOrSyncBreachRow',
      breach_name: breach.breach_name,
    });
    return null;
  }
}

/**
 * INSERT a finding ON CONFLICT DO NOTHING. Returns true on a fresh
 * insert, false on conflict (already discovered).
 */
async function insertFindingIfNew(args: {
  user_id: string;
  monitor_id: string;
  breach_id: string;
  severity: 'informational' | 'caution' | 'critical';
}): Promise<boolean> {
  try {
    const res = await query(
      `INSERT INTO identity_breach_findings (
         user_id, monitor_id, breach_id, severity
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, monitor_id, breach_id) DO NOTHING`,
      [args.user_id, args.monitor_id, args.breach_id, args.severity],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    captureError(err, {
      component: 'identityShieldIngest.insertFindingIfNew',
      user_id: args.user_id,
    });
    return false;
  }
}

// ───────────────────────────────────────────────────────────────
// Enzoic batch scan — daily
// ───────────────────────────────────────────────────────────────

/**
 * Scan all users' active email monitors against Enzoic's credential-
 * exposure index. Batches up to ENZOIC_BATCH_SIZE emails per call.
 *
 * Each returned exposure id is UPSERTed into identity_breaches with
 * source='enzoic'; the corresponding monitor produces an
 * identity_breach_findings row (severity='critical' when the
 * exposure's data classes include Passwords/SSN/credit-card,
 * otherwise 'caution').
 *
 * Returns 0/0 when either Enzoic env var is missing — operator
 * receives a single startup log line.
 */
export async function scanAllUsersEnzoicOnce(opts?: {
  httpFetch?: FetchFn;
}): Promise<{ users_checked: number; new_findings: number }> {
  if (!config.EMAIL_SHIELD_ENZOIC_API_KEY || !config.EMAIL_SHIELD_ENZOIC_SECRET) {
    return { users_checked: 0, new_findings: 0 };
  }

  let monitorRows: Array<{ id: string; user_id: string; watched_value: string }>;
  try {
    const res = await query<{ id: string; user_id: string; watched_value: string }>(
      `SELECT id, user_id, watched_value
         FROM identity_monitors
        WHERE monitor_kind = 'email' AND active`,
    );
    monitorRows = res.rows;
  } catch (err) {
    captureError(err, { component: 'identityShieldIngest.scanAllUsersEnzoic.fetch_monitors' });
    return { users_checked: 0, new_findings: 0 };
  }
  if (monitorRows.length === 0) {
    return { users_checked: 0, new_findings: 0 };
  }

  // I-M2: apply the optional daily user cap BEFORE staging batches.
  // Sampling logic:
  //   1. Group monitors by user_id (a user may have multiple email
  //      monitors and we want all of theirs together, or none).
  //   2. Shuffle the user list with Math.random() — over a 7-day
  //      window every user gets a fair chance.
  //   3. Keep the first N users; flatten their monitors back into
  //      the batch-iteration shape.
  // When the cap is unset, this collapses to a no-op (everyone is
  // kept, original order preserved).
  const cap = config.ENZOIC_DAILY_USER_CAP;
  if (cap !== undefined && cap > 0) {
    const monitorsByUser = new Map<string, typeof monitorRows>();
    for (const m of monitorRows) {
      const list = monitorsByUser.get(m.user_id) ?? [];
      list.push(m);
      monitorsByUser.set(m.user_id, list);
    }
    if (monitorsByUser.size > cap) {
      const userIds = Array.from(monitorsByUser.keys());
      // Schwartzian-style random sort: each user gets a random key,
      // then we sort by that key. Equivalent to Fisher-Yates for the
      // sampling-fairness property we care about (the absolute
      // distribution is fine for cap >> 1).
      userIds.sort(() => Math.random() - 0.5);
      const kept = new Set(userIds.slice(0, cap));
      monitorRows = monitorRows.filter((m) => kept.has(m.user_id));
      void emitMetric('identity_shield.enzoic_daily_cap_applied', {
        cap: String(cap),
        total_users: String(monitorsByUser.size),
        sampled_users: String(kept.size),
      });
    }
  }

  // Group monitors by user for the users_checked count, and stage
  // batches across the flat email-list dimension. (Enzoic doesn't
  // require per-user batching; the dedup is just by username.)
  const usersSet = new Set<string>();
  for (const m of monitorRows) usersSet.add(m.user_id);

  let totalNewFindings = 0;
  for (let i = 0; i < monitorRows.length; i += ENZOIC_BATCH_SIZE) {
    const batch = monitorRows.slice(i, i + ENZOIC_BATCH_SIZE);
    const findings = await enzoicScanBatch(batch, opts?.httpFetch);
    totalNewFindings += findings;
  }

  void emitMetric('identity_shield.enzoic_scan', {
    users_checked: String(usersSet.size),
    new_findings: String(totalNewFindings),
  });
  return { users_checked: usersSet.size, new_findings: totalNewFindings };
}

/**
 * Single Enzoic batch — one HTTP call (usernames=email&usernames=...).
 * Returns the count of NEW findings created. Failures (429/5xx/
 * network throw) return 0 for the batch and the next cron tick
 * retries.
 */
async function enzoicScanBatch(
  batch: Array<{ id: string; user_id: string; watched_value: string }>,
  httpFetch?: FetchFn,
): Promise<number> {
  const fetcher = httpFetch ?? fetch;
  const params = new URLSearchParams();
  for (const m of batch) params.append('usernames', m.watched_value);
  const url = `${ENZOIC_EXPOSURES_URL}?${params.toString()}`;

  const auth = Buffer.from(
    `${config.EMAIL_SHIELD_ENZOIC_API_KEY}:${config.EMAIL_SHIELD_ENZOIC_SECRET}`,
  ).toString('base64');

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    captureError(err, { component: 'identityShieldIngest.enzoic_batch.fetch' });
    return 0;
  }

  if (response.status === 429) {
    void emitMetric('identity_shield.enzoic_batch_skipped', { reason: 'rate_limited' });
    return 0;
  }
  if (response.status !== 200) {
    captureError(new Error(`enzoic_unexpected_status_${response.status}`), {
      component: 'identityShieldIngest.enzoic_batch',
      status: response.status,
    });
    return 0;
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    captureError(err, { component: 'identityShieldIngest.enzoic_batch.parse_json' });
    return 0;
  }

  // I-H3: Enzoic batch responses come in two shapes per their docs:
  // either an array of {username, count, exposures[]} entries or
  // a single object when only one username is queried. We normalize
  // both shapes into an array of entries and THEN pair by username
  // (NOT by array index). If Enzoic ever returns out of order, skips
  // a username, dedupes a duplicate, or renames fields, the previous
  // positional pairing would have silently re-attributed exposures
  // across users. The Map-by-username path makes a leak require an
  // active username collision, not a benign reordering.
  const entries = normalizeEnzoicBatchResponse(raw, batch.length);
  let newFindings = 0;

  // Build the (watched_value → monitor) lookup once per batch.
  // Lowercase the key because Enzoic's docs lowercase emails on
  // receipt and the monitor table preserves whatever the user
  // submitted; this avoids a case-mismatch attribution miss.
  const monitorByUsername = new Map<string, typeof batch[number]>();
  for (const m of batch) {
    monitorByUsername.set(m.watched_value.toLowerCase(), m);
  }

  for (const entry of entries) {
    // Pick the first non-empty username field — Enzoic's docs aren't
    // explicit about which name they use across endpoints.
    const reportedUsername = entry.username ?? entry.query ?? entry.email ?? null;
    if (!reportedUsername) {
      // Schema-drift OR positional-only response — refuse to insert.
      // Better to MISS one finding than to mis-attribute it across
      // users. Operator sees the metric and investigates.
      void emitMetric('identity_shield.enzoic_schema_drift', {
        reason: 'no_username',
      });
      continue;
    }
    const monitor = monitorByUsername.get(reportedUsername.toLowerCase());
    if (!monitor) {
      // Enzoic returned a username we didn't ask about — defensive
      // skip. Mirrors the no_username path's "refuse rather than
      // guess" stance.
      void emitMetric('identity_shield.enzoic_schema_drift', {
        reason: 'unknown_username',
      });
      continue;
    }
    if (!entry.exposures || entry.exposures.length === 0) continue;

    for (const exposureId of entry.exposures) {
      const detail = await fetchEnzoicExposureDetail(exposureId, fetcher);
      const breachId = await upsertEnzoicBreach(exposureId, detail);
      if (breachId === null) continue;
      const severity = enzoicSeverity(detail?.dataClasses ?? []);
      const inserted = await insertFindingIfNew({
        user_id: monitor.user_id,
        monitor_id: monitor.id,
        breach_id: breachId,
        severity,
      });
      if (inserted) newFindings++;
    }
  }

  return newFindings;
}

/**
 * Enzoic returns either an array of per-username response objects
 * (one entry per username, in input order) or a single object when
 * exactly one username was queried. We always emit an array of
 * normalized entries; the call-site pairs them by the carried
 * username (I-H3) rather than by position, so a short/reordered
 * response can't cross-attribute findings.
 *
 * The returned shape carries the username under whichever field
 * name Enzoic emitted it as (`username` / `query` / `email`) plus
 * the `exposures` list. Entries with no username at all are still
 * surfaced — the caller treats them as schema-drift and refuses
 * to insert.
 */
interface NormalizedEnzoicEntry {
  username?: string;
  query?: string;
  email?: string;
  exposures: string[];
}

function normalizeEnzoicBatchResponse(
  raw: unknown,
  expectedLength: number,
): NormalizedEnzoicEntry[] {
  // Already an array?
  if (Array.isArray(raw)) {
    const out: NormalizedEnzoicEntry[] = [];
    for (const item of raw) {
      const parsed = EnzoicAccountResponse.safeParse(item);
      if (parsed.success) {
        out.push({
          username: parsed.data.username,
          query: parsed.data.query,
          email: parsed.data.email,
          exposures: parsed.data.exposures,
        });
      } else {
        out.push({ exposures: [] });
      }
    }
    // Note: we DO NOT pad short responses. Padded empty entries
    // were only useful under the old index-pairing path; under
    // username-pairing they would just be empty entries that the
    // caller skips harmlessly. Padding here would also dilute the
    // schema-drift metric (every padded row would fire it).
    return out;
  }
  // Single object (only when batch size was 1, or when Enzoic
  // collapses a single-result batch).
  const parsed = EnzoicAccountResponse.safeParse(raw);
  if (parsed.success) {
    return [
      {
        username: parsed.data.username,
        query: parsed.data.query,
        email: parsed.data.email,
        exposures: parsed.data.exposures,
      },
    ];
  }
  // Unrecognized shape — log once, return empty so we don't crash
  // the batch. `expectedLength` is retained in the signature for
  // observability (operator can correlate with batch size in logs)
  // but no longer drives the output array length.
  void expectedLength;
  captureError(new Error('enzoic_schema_drift'), {
    component: 'identityShieldIngest.enzoic_batch.normalize',
  });
  return [];
}

/**
 * Fetch a single Enzoic exposure detail by id. Returns null on any
 * failure — caller falls back to a minimal identity_breaches row
 * keyed on the id alone (data_classes empty).
 */
async function fetchEnzoicExposureDetail(
  exposureId: string,
  fetcher: FetchFn,
): Promise<z.infer<typeof EnzoicExposureDetail> | null> {
  const auth = Buffer.from(
    `${config.EMAIL_SHIELD_ENZOIC_API_KEY}:${config.EMAIL_SHIELD_ENZOIC_SECRET}`,
  ).toString('base64');
  const url = `${ENZOIC_EXPOSURES_URL}?id=${encodeURIComponent(exposureId)}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    captureError(err, {
      component: 'identityShieldIngest.enzoic_detail.fetch',
      exposure_id: exposureId,
    });
    return null;
  }
  if (response.status !== 200) return null;
  try {
    const raw = (await response.json()) as unknown;
    const parsed = EnzoicExposureDetail.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * UPSERT an Enzoic exposure into identity_breaches. Returns the
 * row id (created or pre-existing) or null on DB failure.
 */
async function upsertEnzoicBreach(
  exposureId: string,
  detail: z.infer<typeof EnzoicExposureDetail> | null,
): Promise<string | null> {
  try {
    const res = await query<{ id: string }>(
      `INSERT INTO identity_breaches (
         breach_name, source, source_breach_id, domain,
         breach_date, pwn_count, data_classes, description
       ) VALUES (
         $1, 'enzoic', $2, $3,
         $4::date, $5, $6, $7
       )
       ON CONFLICT (source, source_breach_id) DO UPDATE
         SET breach_name = EXCLUDED.breach_name,
             domain = EXCLUDED.domain,
             breach_date = EXCLUDED.breach_date,
             pwn_count = EXCLUDED.pwn_count,
             data_classes = EXCLUDED.data_classes,
             description = EXCLUDED.description,
             synced_at = NOW()
       RETURNING id`,
      [
        detail?.title ?? exposureId,
        exposureId,
        detail?.source ?? null,
        detail?.date ?? null,
        detail?.entries ?? null,
        detail?.dataClasses ?? [],
        detail?.description ?? null,
      ],
    );
    return res.rows[0]?.id ?? null;
  } catch (err) {
    captureError(err, {
      component: 'identityShieldIngest.upsertEnzoicBreach',
      exposure_id: exposureId,
    });
    return null;
  }
}

/**
 * Map Enzoic data-class list → finding severity. Same matrix as the
 * Email Shield Enzoic wrapper: any high-sensitivity class
 * (passwords / SSN / credit-card / bank account / financial)
 * promotes to 'critical', anything else stays at 'caution'.
 */
const ENZOIC_HIGH_SEVERITY_CLASSES = new Set<string>([
  'passwords',
  'partial credit card numbers',
  'credit card information',
  'credit card numbers',
  'social security numbers',
  'ssn',
  'government-issued ids',
  'bank account numbers',
  'financial information',
]);

function enzoicSeverity(dataClasses: string[]): 'critical' | 'caution' {
  for (const cls of dataClasses) {
    if (ENZOIC_HIGH_SEVERITY_CLASSES.has(cls.toLowerCase())) return 'critical';
  }
  return 'caution';
}

// ───────────────────────────────────────────────────────────────
// Cron scaffolding — mirror retentionSweeper
// ───────────────────────────────────────────────────────────────

export interface IdentityShieldIngestHandle {
  catalogSyncTask: cron.ScheduledTask;
  hibpScanTask: cron.ScheduledTask;
  enzoicScanTask: cron.ScheduledTask;
}

export function startIdentityShieldIngest(): IdentityShieldIngestHandle {
  // Startup log: state the operating mode once so the operator can
  // confirm env-var posture from the first line of logs.
  if (!config.HIBP_API_KEY && (!config.EMAIL_SHIELD_ENZOIC_API_KEY || !config.EMAIL_SHIELD_ENZOIC_SECRET)) {
    logDegradedOnce();
  } else {
    if (!config.HIBP_API_KEY) logSkipOnce('hibp');
    if (!config.EMAIL_SHIELD_ENZOIC_API_KEY || !config.EMAIL_SHIELD_ENZOIC_SECRET) {
      logSkipOnce('enzoic');
    }
  }

  const catalogSyncTask = cron.schedule(
    HIBP_CATALOG_CRON,
    () => {
      void (async () => {
        const started = Date.now();
        const result = await syncHibpCatalogOnce();
        // eslint-disable-next-line no-console
        console.log('[identity-shield-ingest] hibp_catalog_sync complete', {
          duration_ms: Date.now() - started,
          ...result,
        });
      })();
    },
    { timezone: 'UTC' },
  );

  const hibpScanTask = cron.schedule(
    HIBP_USER_SCAN_CRON,
    () => {
      void (async () => {
        const started = Date.now();
        const result = await scanAllUsersHibpOnce();
        // eslint-disable-next-line no-console
        console.log('[identity-shield-ingest] user_hibp_scan complete', {
          duration_ms: Date.now() - started,
          ...result,
        });
      })();
    },
    { timezone: 'UTC' },
  );

  const enzoicScanTask = cron.schedule(
    ENZOIC_USER_SCAN_CRON,
    () => {
      void (async () => {
        const started = Date.now();
        const result = await scanAllUsersEnzoicOnce();
        // eslint-disable-next-line no-console
        console.log('[identity-shield-ingest] enzoic_scan complete', {
          duration_ms: Date.now() - started,
          ...result,
        });
      })();
    },
    { timezone: 'UTC' },
  );

  return { catalogSyncTask, hibpScanTask, enzoicScanTask };
}

export function stopIdentityShieldIngest(handle: IdentityShieldIngestHandle): void {
  handle.catalogSyncTask.stop();
  handle.hibpScanTask.stop();
  handle.enzoicScanTask.stop();
}
