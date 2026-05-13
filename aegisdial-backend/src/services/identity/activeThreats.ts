import { query } from '../../lib/db.js';
import { emitMetric, captureError } from '../../lib/observability.js';
import { normalizeE164 } from '../../lib/phone.js';
import type {
  ThreatKind,
  ThreatSeverity,
  ThreatInput,
  ActiveThreatHit,
} from './types.js';

// Identity Shield — active-threats service library.
//
// This file is the typed surface in front of the active_threats table
// (migration 071). Every Live / SMS / Email scorer hits lookupThreat()
// on every scan; ingest workers (Enzoic, HIBP, Telegram listener,
// darknet crawler) hit recordThreat / ingestThreatBatch. The table is
// global (no per-user filter); the threat catalog describes external
// bad-actor artifacts, NOT user PII.
//
// HOT PATH:
//   lookupThreat() — single SELECT against the partial index
//   idx_threats_by_value WHERE expires_at IS NULL OR expires_at > NOW().
//   Sub-ms target. Live/SMS/Email scorers run this per inbound
//   call/text/email; latency budget is shared with the rest of the
//   scoring pipeline.
//
// CALLER-TRUST POSTURE (security invariant — read before touching):
//   recordThreat() and ingestThreatBatch() MUST NOT be reachable from
//   user-input request paths. The only callers are worker code we
//   control: aegisdial_recovery observer, telegram listener, darknet
//   crawler, enzoic/HIBP ingest. A malicious caller passing a popular
//   phone number with confirmed_scammer severity would poison the
//   global table. The per-worker validation (e.g., the
//   recoveryCaseObserver requirement of ≥2 distinct attesting cases
//   for confirmed_scammer promotion) is the defense; that logic lives
//   in the worker, not here. Adding a new caller? Verify it cannot be
//   driven by an end-user request.
//
// PRIVACY POSTURE:
//   threat_value carries plaintext artifacts (phone, email, host).
//   These are ATTACKER identifiers, not user PII — there is no
//   per-user cross-reference. Recording a user's own email as a
//   threat would be a categorical misuse (the catalog is about
//   external bad actors). Callers that derive an artifact from a
//   user-supplied claim (e.g., a recovery case) MUST attribute via
//   the per-user provenance string, not by storing user-keyed data
//   here.
//
// SEVERITY-UPGRADE-ONLY SEMANTICS:
//   ON CONFLICT (threat_kind, threat_value, provenance) collapses
//   re-observations from the same source. The UPDATE clause refreshes
//   last_seen_at and lifts severity if (and only if) the new
//   observation outranks the existing one. A 'caution' re-report
//   coming in after a 'confirmed_scammer' from the SAME source keeps
//   the higher severity. Different-source rows live as siblings; the
//   scorer's max-severity selection (I-P2 hot path) picks the
//   strongest across all matching rows.

// ---- Severity rank vocabulary --------------------------------------
//
// Identical ordering to the migration's CHECK literal. Kept inline
// here so the SQL CASE expression and the JS code can't drift.

const SEVERITY_RANK: Record<ThreatSeverity, number> = {
  informational: 1,
  caution: 2,
  warning: 3,
  confirmed_scammer: 4,
};

// Severity → default TTL. The migration header documents the same
// table; we materialize it here because the service layer is the
// place operator tuning happens during ramp-up.
//
// confirmed_scammer = no expiry (NULL); a victim-attested scam phone
// is still a scam phone two years later.
// warning           = 365d
// caution           = 90d
// informational     = 30d
const SEVERITY_TTL_DAYS: Record<ThreatSeverity, number | null> = {
  informational: 30,
  caution: 90,
  warning: 365,
  confirmed_scammer: null,
};

// ---- Normalization -------------------------------------------------
//
// Per-kind canonicalization. Lookup and record MUST go through the
// same function so a record-side 'Foo@Bar.COM' matches a lookup-side
// 'foo@bar.com'. Returns null on malformed input (caller decides
// whether to skip vs throw).

/**
 * Normalize a threat value per its kind. Returns null when the value
 * is malformed (caller skips / decrements counts; the table only ever
 * receives well-formed values).
 *
 * Per-kind rules:
 *   phone_e164    — defer to lib/phone.normalizeE164. Returns the
 *                   strict E.164 string with leading '+'. Bare
 *                   ten-digit US numbers infer country='US' through
 *                   libphonenumber.
 *   email_address — trim + lowercase. Reject empty or values without
 *                   exactly one '@'.
 *   url_host      — lowercase, strip a single leading 'www.', strip
 *                   trailing slash. Reject empty.
 *   crypto_wallet — trust the caller (chain-specific normalization is
 *                   the caller's problem; ETH wants checksum case,
 *                   BTC is lowercase). Reject empty / whitespace-only.
 *   ip_address    — trust the caller (v4 or v6). Reject empty /
 *                   whitespace-only.
 */
export function normalizeThreatValue(
  kind: ThreatKind,
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (raw.length === 0) return null;
  switch (kind) {
    case 'phone_e164': {
      // libphonenumber handles +1-415, (415) 555-0100, 4155550100, etc.
      // Reject anything it can't parse to a valid number — that's the
      // "is this E.164-able?" gate the prompt requires.
      const normalized = normalizeE164(raw, 'US');
      if (!normalized) return null;
      // Belt-and-braces: post-normalize must look like +<digits>.
      if (!/^\+\d{6,15}$/.test(normalized)) return null;
      return normalized;
    }
    case 'email_address': {
      const lower = raw.toLowerCase();
      // Cheap shape gate: exactly one '@', non-empty local + domain.
      // We don't do RFC 5322 here — the worker's upstream feed is
      // already known to produce email-shaped strings; this is a
      // defense against accidental garbage.
      const at = lower.indexOf('@');
      if (at <= 0 || at !== lower.lastIndexOf('@') || at === lower.length - 1) {
        return null;
      }
      return lower;
    }
    case 'url_host': {
      let host = raw.toLowerCase();
      while (host.endsWith('/')) host = host.slice(0, -1);
      if (host.startsWith('www.')) host = host.slice(4);
      if (host.length === 0) return null;
      // Reject obviously malformed (spaces, schemes leaking through).
      if (/\s/.test(host) || host.includes('://')) return null;
      return host;
    }
    case 'crypto_wallet':
    case 'ip_address':
      // Trust the caller's canonical form; just guard non-empty.
      return raw;
  }
}

/**
 * Resolve the persisted expires_at for a (severity, optional-explicit-
 * override) tuple. Hard contract — adversarial-review I-M5 fix
 * (2026-05-12):
 *
 *   1. severity = 'confirmed_scammer'  → ALWAYS NULL (never expires).
 *      The caller's `explicit` is IGNORED for this tier. Rationale:
 *      a malicious worker (or a buggy one) passing `expires_at:
 *      new Date(0)` would have instantly aged the row out, neutralizing
 *      the scorer flag for the highest-severity tier. The contract is
 *      now write-once-permanent: confirmed_scammer always means
 *      indefinite. Operator-driven retirement is via the admin
 *      retirement table, not the worker write path.
 *
 *   2. severity < 'confirmed_scammer' with no explicit override
 *      → default per-severity TTL (SEVERITY_TTL_DAYS).
 *
 *   3. severity < 'confirmed_scammer' WITH an explicit override
 *      → floor the override at `now + 1 day`. A caller passing a past
 *      timestamp (accidental or hostile) would otherwise insert a
 *      pre-expired row that fails fast for lookupThreat and bloats
 *      the table without doing useful work. The floor keeps the
 *      shortest-meaningful TTL at 24h.
 *
 * The floor + ceiling are belt-and-braces against worker-side bugs
 * and adversarial-input poisoning of the threat catalog.
 */
function resolveExpiry(severity: ThreatSeverity, explicit?: Date): Date | null {
  // confirmed_scammer is permanent — explicit override is IGNORED here
  // (defense against an attacker poisoning the worker payload with
  //  `expires_at: new Date(0)` to neutralize the highest-severity tier).
  if (severity === 'confirmed_scammer') return null;

  const days = SEVERITY_TTL_DAYS[severity];
  // No explicit override → fall back to the per-severity default TTL.
  if (explicit === undefined) {
    if (days === null) return null;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  // Explicit override on a non-confirmed_scammer tier: floor at
  // now + 1 day. A caller asking for "1 hour from now" or "1970-01-01"
  // is either buggy or hostile — either way, store the floor and let
  // the operator surface anomalies via the threat-catalog dashboard
  // instead of letting a single-hour TTL silently churn the table.
  const floor = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return explicit.getTime() < floor.getTime() ? floor : explicit;
}

// ---- Hot path: lookupThreat ----------------------------------------

/**
 * Look up the strongest matching active threat for (kind, value).
 * Returns null when no row exists or all matching rows have expired.
 *
 * This is the scorer hot path — Live / SMS / Email scoring pipelines
 * call this per scan. The query is shaped to ride the partial index
 * idx_threats_by_value (predicate matches WHERE expires_at IS NULL
 * OR expires_at > NOW()); the row count behind the index is small
 * enough to keep latency sub-ms at >10M rows.
 *
 * Cross-shield safety: (threat_kind, threat_value) is the lookup key.
 * A confirmed_scammer phone with the same digits as some other
 * artifact (e.g., an ip_address fragment) cannot bleed across because
 * the SELECT pins threat_kind = $1.
 *
 * TODO(perf): if real-world p99 doesn't hit sub-ms, add a small
 * in-process LRU keyed by (kind, normalized value) with a 30s TTL.
 * The partial index alone should be fast enough; profile first.
 */
export async function lookupThreat(
  kind: ThreatKind,
  value: string,
): Promise<ActiveThreatHit | null> {
  const normalized = normalizeThreatValue(kind, value);
  if (normalized === null) {
    void emitMetric('identity_shield.threat_lookup_miss', { kind, reason: 'malformed_input' });
    return null;
  }
  try {
    const res = await query<{
      severity: ThreatSeverity;
      provenance: string;
      context_text: string | null;
      geo_tag: string | null;
      last_seen_at: Date;
    }>(
      `SELECT severity, provenance, context_text, geo_tag, last_seen_at
         FROM active_threats
        WHERE threat_kind = $1
          AND threat_value = $2
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY
          CASE severity
            WHEN 'confirmed_scammer' THEN 4
            WHEN 'warning' THEN 3
            WHEN 'caution' THEN 2
            WHEN 'informational' THEN 1
            ELSE 0
          END DESC,
          last_seen_at DESC
        LIMIT 1`,
      [kind, normalized],
    );
    if ((res.rowCount ?? 0) === 0) {
      void emitMetric('identity_shield.threat_lookup_miss', { kind });
      return null;
    }
    const row = res.rows[0]!;
    void emitMetric('identity_shield.threat_lookup_hit', {
      kind,
      severity: row.severity,
    });
    return {
      severity: row.severity,
      provenance: row.provenance,
      context_text: row.context_text,
      geo_tag: row.geo_tag,
      last_seen_at: row.last_seen_at,
    };
  } catch (err) {
    captureError(err, { component: 'activeThreats.lookupThreat', kind });
    // Fail-open on infra errors. A missed threat-catalog hit is a
    // soft degradation (the scorer still runs its other signals);
    // throwing here would cascade to every scoring pipeline.
    return null;
  }
}

// ---- Worker entry: recordThreat ------------------------------------

/**
 * Record a single observed threat. Idempotent: a re-observation from
 * the same provenance refreshes last_seen_at and lifts severity only
 * if the new tier outranks the existing one (severity-upgrade-only
 * semantics — a lower-tier re-report does NOT downgrade).
 *
 * SECURITY INVARIANT (repeated from file header for emphasis): this
 * function MUST NOT be reachable from a user-input request path.
 * Workers we control are the only callers. Per-worker validation
 * gates promotion to confirmed_scammer.
 */
export async function recordThreat(input: {
  kind: ThreatKind;
  value: string;
  severity: ThreatSeverity;
  provenance: string;
  context?: string;
  geo_tag?: string;
  expires_at?: Date;
}): Promise<void> {
  const normalized = normalizeThreatValue(input.kind, input.value);
  if (normalized === null) {
    // Malformed values are dropped — emit a metric so operator
    // dashboards surface a misbehaving worker (e.g., a Telegram
    // classifier emitting unparseable phone snippets).
    void emitMetric('identity_shield.threat_record_skipped', {
      kind: input.kind,
      reason: 'malformed_value',
    });
    return;
  }
  if (!input.provenance || input.provenance.trim().length === 0) {
    void emitMetric('identity_shield.threat_record_skipped', {
      kind: input.kind,
      reason: 'missing_provenance',
    });
    return;
  }
  const incomingRank = SEVERITY_RANK[input.severity];
  const expiresAt = resolveExpiry(input.severity, input.expires_at);
  try {
    await query(
      // The CASE in the UPDATE branch implements severity-upgrade-only
      // semantics: if the existing row's severity outranks the
      // incoming, keep the existing; otherwise take the incoming.
      // expires_at follows severity (so a confirmed_scammer upgrade
      // also flips expires_at to NULL).
      `INSERT INTO active_threats (
         threat_kind, threat_value, severity, provenance,
         context_text, geo_tag, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (threat_kind, threat_value, provenance) DO UPDATE
         SET last_seen_at = NOW(),
             severity = CASE
               WHEN $8::INT > (
                 CASE active_threats.severity
                   WHEN 'confirmed_scammer' THEN 4
                   WHEN 'warning' THEN 3
                   WHEN 'caution' THEN 2
                   WHEN 'informational' THEN 1
                   ELSE 0
                 END
               ) THEN EXCLUDED.severity
               ELSE active_threats.severity
             END,
             expires_at = CASE
               WHEN $8::INT > (
                 CASE active_threats.severity
                   WHEN 'confirmed_scammer' THEN 4
                   WHEN 'warning' THEN 3
                   WHEN 'caution' THEN 2
                   WHEN 'informational' THEN 1
                   ELSE 0
                 END
               ) THEN EXCLUDED.expires_at
               ELSE active_threats.expires_at
             END,
             context_text = COALESCE(EXCLUDED.context_text, active_threats.context_text),
             geo_tag = COALESCE(EXCLUDED.geo_tag, active_threats.geo_tag)`,
      [
        input.kind,
        normalized,
        input.severity,
        input.provenance,
        input.context ?? null,
        input.geo_tag ?? null,
        expiresAt,
        incomingRank,
      ],
    );
    void emitMetric('identity_shield.threat_recorded', {
      kind: input.kind,
      severity: input.severity,
    });
  } catch (err) {
    captureError(err, {
      component: 'activeThreats.recordThreat',
      kind: input.kind,
      provenance: input.provenance,
    });
    // Swallow — workers retry, and a single insert failure must not
    // crash a batch.
  }
}

// ---- Worker entry: ingestThreatBatch -------------------------------

/**
 * Batch entry for the ingest workers (Enzoic, HIBP, Telegram listener,
 * darknet crawler). Drives a single multi-row INSERT...SELECT FROM
 * (VALUES ...) with the same ON CONFLICT semantics as recordThreat,
 * so the network cost of an N-row batch is one round trip.
 *
 * Returns counts of {inserted, updated}. Malformed rows (after
 * normalization) are skipped and do NOT contribute to either count.
 *
 * SECURITY INVARIANT (same as recordThreat): worker-only entry.
 */
export async function ingestThreatBatch(
  threats: ThreatInput[],
): Promise<{ inserted: number; updated: number }> {
  if (threats.length === 0) return { inserted: 0, updated: 0 };

  // Normalize + drop malformed rows first so the SQL only ever sees
  // canonicalized values. Carry the original index nowhere — we don't
  // surface skipped rows back to the caller, just decrement counts.
  interface NormalizedRow {
    kind: ThreatKind;
    value: string;
    severity: ThreatSeverity;
    rank: number;
    provenance: string;
    context: string | null;
    geo_tag: string | null;
    expires_at: Date | null;
  }
  const normalized: NormalizedRow[] = [];
  let skipped = 0;
  for (const t of threats) {
    const v = normalizeThreatValue(t.kind, t.value);
    if (v === null) {
      skipped++;
      continue;
    }
    if (!t.provenance || t.provenance.trim().length === 0) {
      skipped++;
      continue;
    }
    normalized.push({
      kind: t.kind,
      value: v,
      severity: t.severity,
      rank: SEVERITY_RANK[t.severity],
      provenance: t.provenance,
      context: t.context ?? null,
      geo_tag: t.geo_tag ?? null,
      expires_at: resolveExpiry(t.severity, t.expires_at),
    });
  }
  if (skipped > 0) {
    void emitMetric('identity_shield.threat_batch_skipped', { count: String(skipped) });
  }
  if (normalized.length === 0) {
    return { inserted: 0, updated: 0 };
  }

  // Build the multi-row VALUES tuple. Each row contributes 8 params.
  // Parameter ordering MUST match the SELECT projection below.
  const valuesSql: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const row of normalized) {
    valuesSql.push(
      `($${p++}::TEXT, $${p++}::TEXT, $${p++}::TEXT, $${p++}::TEXT, $${p++}::TEXT, $${p++}::TEXT, $${p++}::TIMESTAMPTZ, $${p++}::INT)`,
    );
    params.push(
      row.kind,
      row.value,
      row.severity,
      row.provenance,
      row.context,
      row.geo_tag,
      row.expires_at,
      row.rank,
    );
  }

  try {
    // The CTE makes it possible to distinguish inserts from updates:
    // xmax = 0 on a fresh INSERT, non-zero on an UPDATE path (the
    // standard Postgres trick for "did ON CONFLICT update or insert?").
    // We return the existing-row's pre-update severity rank so we can
    // also tell on the JS side whether the update was a true upgrade
    // vs a no-op refresh — counted as "updated" either way per the
    // contract (the row was touched).
    const res = await query<{ was_insert: boolean }>(
      `WITH input_rows AS (
         SELECT
           t.kind          AS threat_kind,
           t.value         AS threat_value,
           t.severity      AS severity,
           t.provenance    AS provenance,
           t.context_text  AS context_text,
           t.geo_tag       AS geo_tag,
           t.expires_at    AS expires_at,
           t.incoming_rank AS incoming_rank
         FROM (VALUES ${valuesSql.join(', ')}) AS t(
           kind, value, severity, provenance, context_text, geo_tag, expires_at, incoming_rank
         )
       )
       INSERT INTO active_threats (
         threat_kind, threat_value, severity, provenance,
         context_text, geo_tag, expires_at
       )
       SELECT
         threat_kind, threat_value, severity, provenance,
         context_text, geo_tag, expires_at
         FROM input_rows
       ON CONFLICT (threat_kind, threat_value, provenance) DO UPDATE
         SET last_seen_at = NOW(),
             severity = CASE
               WHEN (
                 CASE EXCLUDED.severity
                   WHEN 'confirmed_scammer' THEN 4
                   WHEN 'warning' THEN 3
                   WHEN 'caution' THEN 2
                   WHEN 'informational' THEN 1
                   ELSE 0
                 END
               ) > (
                 CASE active_threats.severity
                   WHEN 'confirmed_scammer' THEN 4
                   WHEN 'warning' THEN 3
                   WHEN 'caution' THEN 2
                   WHEN 'informational' THEN 1
                   ELSE 0
                 END
               ) THEN EXCLUDED.severity
               ELSE active_threats.severity
             END,
             expires_at = CASE
               WHEN (
                 CASE EXCLUDED.severity
                   WHEN 'confirmed_scammer' THEN 4
                   WHEN 'warning' THEN 3
                   WHEN 'caution' THEN 2
                   WHEN 'informational' THEN 1
                   ELSE 0
                 END
               ) > (
                 CASE active_threats.severity
                   WHEN 'confirmed_scammer' THEN 4
                   WHEN 'warning' THEN 3
                   WHEN 'caution' THEN 2
                   WHEN 'informational' THEN 1
                   ELSE 0
                 END
               ) THEN EXCLUDED.expires_at
               ELSE active_threats.expires_at
             END,
             context_text = COALESCE(EXCLUDED.context_text, active_threats.context_text),
             geo_tag = COALESCE(EXCLUDED.geo_tag, active_threats.geo_tag)
       RETURNING (xmax = 0) AS was_insert`,
      params,
    );
    let inserted = 0;
    let updated = 0;
    for (const r of res.rows) {
      if (r.was_insert) inserted++;
      else updated++;
    }
    if (inserted > 0) {
      void emitMetric('identity_shield.threat_batch_inserted', { count: String(inserted) });
    }
    if (updated > 0) {
      void emitMetric('identity_shield.threat_batch_updated', { count: String(updated) });
    }
    return { inserted, updated };
  } catch (err) {
    captureError(err, {
      component: 'activeThreats.ingestThreatBatch',
      batch_size: normalized.length,
    });
    return { inserted: 0, updated: 0 };
  }
}
