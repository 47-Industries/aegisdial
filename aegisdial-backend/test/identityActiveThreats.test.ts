import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Identity Shield I-P2 — active-threats service library.
//
// Stubs:
//   - db.pool.query — selectively matches the SQL emitted by
//     activeThreats.ts (lookupThreat / recordThreat /
//     ingestThreatBatch) and operates against an in-memory table.
//   - emitMetric / captureError land via the standard observability
//     side effects; metric_counters INSERTs are swallowed.
//
// Goals:
//   - lookupThreat returns null on miss and on expired-only rows
//   - lookupThreat returns hit on non-expired rows
//   - lookupThreat respects threat_kind as part of the lookup key
//     (cross-shield isolation)
//   - recordThreat is idempotent on the (kind, value, provenance) UNIQUE
//   - recordThreat upgrades severity (caution → confirmed_scammer)
//     but does NOT downgrade (confirmed_scammer → caution stays high)
//   - recordThreat normalizes phone, email, url_host before insert
//   - recordThreat rejects malformed values silently
//   - ingestThreatBatch returns correct {inserted, updated}
//   - ingestThreatBatch skips malformed rows gracefully

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-identity-threats';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://identity-threats';

const db = await import('../src/lib/db.ts');
const svc = await import('../src/services/identity/activeThreats.ts');

// ----------------------------------------------------------------
// In-memory active_threats table + SQL router
// ----------------------------------------------------------------

type Severity = 'informational' | 'caution' | 'warning' | 'confirmed_scammer';
type Kind = 'phone_e164' | 'email_address' | 'crypto_wallet' | 'url_host' | 'ip_address';

interface FakeRow {
  id: string;
  threat_kind: Kind;
  threat_value: string;
  severity: Severity;
  provenance: string;
  context_text: string | null;
  geo_tag: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  expires_at: Date | null;
}

const SEV_RANK: Record<Severity, number> = {
  informational: 1,
  caution: 2,
  warning: 3,
  confirmed_scammer: 4,
};

let fakeTable: FakeRow[] = [];
let nextRowId = 1;

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const trimmed = text.trim().replace(/\s+/g, ' ');

  // ---- lookupThreat -------------------------------------------------
  if (/^SELECT severity, provenance, context_text, geo_tag, last_seen_at FROM active_threats/i.test(trimmed)) {
    const [kind, value] = params as [Kind, string];
    const now = Date.now();
    const matches = fakeTable
      .filter(
        (r) =>
          r.threat_kind === kind &&
          r.threat_value === value &&
          (r.expires_at === null || r.expires_at.getTime() > now),
      )
      .sort((a, b) => {
        const rankDiff = SEV_RANK[b.severity] - SEV_RANK[a.severity];
        if (rankDiff !== 0) return rankDiff;
        return b.last_seen_at.getTime() - a.last_seen_at.getTime();
      });
    if (matches.length === 0) return { rows: [], rowCount: 0 };
    const top = matches[0]!;
    return {
      rows: [
        {
          severity: top.severity,
          provenance: top.provenance,
          context_text: top.context_text,
          geo_tag: top.geo_tag,
          last_seen_at: top.last_seen_at,
        },
      ],
      rowCount: 1,
    };
  }

  // ---- recordThreat single-row INSERT ... ON CONFLICT --------------
  if (
    /^INSERT INTO active_threats \( threat_kind, threat_value, severity, provenance, context_text, geo_tag, expires_at \) VALUES \(/i.test(
      trimmed,
    )
  ) {
    const [
      kind,
      value,
      severity,
      provenance,
      context,
      geo_tag,
      expires_at,
      incoming_rank,
    ] = params as [Kind, string, Severity, string, string | null, string | null, Date | null, number];
    const existing = fakeTable.find(
      (r) => r.threat_kind === kind && r.threat_value === value && r.provenance === provenance,
    );
    if (existing) {
      existing.last_seen_at = new Date();
      const existingRank = SEV_RANK[existing.severity];
      if (incoming_rank > existingRank) {
        existing.severity = severity;
        existing.expires_at = expires_at;
      }
      if (context !== null) existing.context_text = context;
      if (geo_tag !== null) existing.geo_tag = geo_tag;
      return { rows: [], rowCount: 1 };
    }
    fakeTable.push({
      id: `row-${nextRowId++}`,
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
    return { rows: [], rowCount: 1 };
  }

  // ---- ingestThreatBatch multi-row CTE-driven INSERT ----------------
  if (/^WITH input_rows AS \( SELECT/i.test(trimmed) && /INSERT INTO active_threats/i.test(trimmed)) {
    // Each row contributes 8 params in order: kind, value, severity,
    // provenance, context, geo_tag, expires_at, incoming_rank.
    const PARAMS_PER_ROW = 8;
    const rows: Array<{ was_insert: boolean }> = [];
    for (let i = 0; i < params.length; i += PARAMS_PER_ROW) {
      const [kind, value, severity, provenance, context, geo_tag, expires_at, incoming_rank] = params.slice(
        i,
        i + PARAMS_PER_ROW,
      ) as [Kind, string, Severity, string, string | null, string | null, Date | null, number];
      const existing = fakeTable.find(
        (r) => r.threat_kind === kind && r.threat_value === value && r.provenance === provenance,
      );
      if (existing) {
        existing.last_seen_at = new Date();
        const existingRank = SEV_RANK[existing.severity];
        if (incoming_rank > existingRank) {
          existing.severity = severity;
          existing.expires_at = expires_at;
        }
        if (context !== null) existing.context_text = context;
        if (geo_tag !== null) existing.geo_tag = geo_tag;
        rows.push({ was_insert: false });
      } else {
        fakeTable.push({
          id: `row-${nextRowId++}`,
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

  // metric_counters UPSERT — swallow
  if (/^INSERT INTO metric_counters/i.test(trimmed)) {
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`unstubbed SQL: ${trimmed.slice(0, 200)}`);
};

beforeEach(() => {
  fakeTable = [];
  nextRowId = 1;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

// ----------------------------------------------------------------
// lookupThreat
// ----------------------------------------------------------------

describe('activeThreats.lookupThreat', () => {
  it('returns null when no row exists', async () => {
    const hit = await svc.lookupThreat('phone_e164', '+14155550100');
    assert.equal(hit, null);
  });

  it('returns the hit when a non-expired row exists', async () => {
    fakeTable.push({
      id: 'r1',
      threat_kind: 'phone_e164',
      threat_value: '+14155550100',
      severity: 'confirmed_scammer',
      provenance: 'aegisdial_recovery:case-1',
      context_text: 'reported by recovery case',
      geo_tag: 'US',
      first_seen_at: new Date(),
      last_seen_at: new Date(),
      expires_at: null,
    });
    const hit = await svc.lookupThreat('phone_e164', '+14155550100');
    assert.ok(hit);
    assert.equal(hit!.severity, 'confirmed_scammer');
    assert.equal(hit!.provenance, 'aegisdial_recovery:case-1');
    assert.equal(hit!.geo_tag, 'US');
  });

  it('does NOT return rows that have already expired', async () => {
    // Row that expired 1h ago.
    fakeTable.push({
      id: 'r-expired',
      threat_kind: 'phone_e164',
      threat_value: '+14155550100',
      severity: 'caution',
      provenance: 'telegram_channel:c1:m1',
      context_text: null,
      geo_tag: null,
      first_seen_at: new Date(Date.now() - 100 * 86_400_000),
      last_seen_at: new Date(Date.now() - 100 * 86_400_000),
      expires_at: new Date(Date.now() - 3600 * 1000),
    });
    const hit = await svc.lookupThreat('phone_e164', '+14155550100');
    assert.equal(hit, null);
  });

  it('picks the strongest severity across multiple matching rows', async () => {
    fakeTable.push({
      id: 'r-low',
      threat_kind: 'phone_e164',
      threat_value: '+14155550100',
      severity: 'caution',
      provenance: 'telegram_channel:c1:m1',
      context_text: 'low-conf chatter',
      geo_tag: null,
      first_seen_at: new Date(),
      last_seen_at: new Date(),
      expires_at: new Date(Date.now() + 86_400_000),
    });
    fakeTable.push({
      id: 'r-high',
      threat_kind: 'phone_e164',
      threat_value: '+14155550100',
      severity: 'confirmed_scammer',
      provenance: 'aegisdial_recovery:case-2',
      context_text: 'victim-attested',
      geo_tag: null,
      first_seen_at: new Date(),
      last_seen_at: new Date(),
      expires_at: null,
    });
    const hit = await svc.lookupThreat('phone_e164', '+14155550100');
    assert.ok(hit);
    assert.equal(hit!.severity, 'confirmed_scammer');
    assert.equal(hit!.context_text, 'victim-attested');
  });

  it('cross-shield isolation: same value with different threat_kind returns null', async () => {
    // Adversarial check: '+14155550100' is in the table as a phone,
    // but a lookup with kind='email_address' must NOT match.
    fakeTable.push({
      id: 'r-phone',
      threat_kind: 'phone_e164',
      threat_value: '+14155550100',
      severity: 'confirmed_scammer',
      provenance: 'aegisdial_recovery:case-1',
      context_text: null,
      geo_tag: null,
      first_seen_at: new Date(),
      last_seen_at: new Date(),
      expires_at: null,
    });
    const hit = await svc.lookupThreat('email_address', '+14155550100');
    assert.equal(hit, null);
  });

  it('returns null when input fails normalization (cannot probe by garbage)', async () => {
    const hit = await svc.lookupThreat('phone_e164', 'not-a-phone');
    assert.equal(hit, null);
  });
});

// ----------------------------------------------------------------
// recordThreat
// ----------------------------------------------------------------

describe('activeThreats.recordThreat', () => {
  it('inserts a new row idempotently — second call same (kind, value, provenance) no-ops (no dup)', async () => {
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '+14155550100',
      severity: 'caution',
      provenance: 'telegram_channel:c1:m1',
    });
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '+14155550100',
      severity: 'caution',
      provenance: 'telegram_channel:c1:m1',
    });
    assert.equal(fakeTable.length, 1);
    assert.equal(fakeTable[0]!.severity, 'caution');
  });

  it('upgrades severity (caution → confirmed_scammer) on a re-report from the same provenance', async () => {
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '+14155550100',
      severity: 'caution',
      provenance: 'aegisdial_recovery:case-1',
    });
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '+14155550100',
      severity: 'confirmed_scammer',
      provenance: 'aegisdial_recovery:case-1',
    });
    assert.equal(fakeTable.length, 1);
    assert.equal(fakeTable[0]!.severity, 'confirmed_scammer');
    // expires_at flipped to null on the upgrade.
    assert.equal(fakeTable[0]!.expires_at, null);
  });

  it('does NOT downgrade severity (confirmed_scammer → caution stays confirmed_scammer)', async () => {
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '+14155550100',
      severity: 'confirmed_scammer',
      provenance: 'aegisdial_recovery:case-1',
    });
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '+14155550100',
      severity: 'caution',
      provenance: 'aegisdial_recovery:case-1',
    });
    assert.equal(fakeTable.length, 1);
    assert.equal(fakeTable[0]!.severity, 'confirmed_scammer');
    assert.equal(fakeTable[0]!.expires_at, null);
  });

  it('normalizes phone_e164 — strips formatting like "(415) 555-0100"', async () => {
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '(415) 555-0100',
      severity: 'confirmed_scammer',
      provenance: 'aegisdial_recovery:case-x',
    });
    assert.equal(fakeTable.length, 1);
    assert.equal(fakeTable[0]!.threat_value, '+14155550100');
  });

  it('normalizes email_address — lowercase + trim', async () => {
    await svc.recordThreat({
      kind: 'email_address',
      value: '   Foo@BAR.com  ',
      severity: 'warning',
      provenance: 'hibp:LinkedIn',
    });
    assert.equal(fakeTable.length, 1);
    assert.equal(fakeTable[0]!.threat_value, 'foo@bar.com');
  });

  it('normalizes url_host — strip www., lowercase, strip trailing slash', async () => {
    await svc.recordThreat({
      kind: 'url_host',
      value: 'WWW.Scam-Example.COM/',
      severity: 'warning',
      provenance: 'telegram_channel:c1:m99',
    });
    assert.equal(fakeTable.length, 1);
    assert.equal(fakeTable[0]!.threat_value, 'scam-example.com');
  });

  it('rejects malformed phone_e164 (e.g., "abc" or empty)', async () => {
    await svc.recordThreat({
      kind: 'phone_e164',
      value: 'abc',
      severity: 'caution',
      provenance: 'telegram_channel:c1:m2',
    });
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '',
      severity: 'caution',
      provenance: 'telegram_channel:c1:m3',
    });
    assert.equal(fakeTable.length, 0);
  });

  it('rejects empty / missing provenance (malformed worker output)', async () => {
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '+14155550100',
      severity: 'caution',
      provenance: '',
    });
    assert.equal(fakeTable.length, 0);
  });

  it('lookupThreat after recordThreat with raw-formatted phone finds the canonical row', async () => {
    // End-to-end normalization check: record with "(415) 555-0100",
    // then look up with "+14155550100" — both go through the same
    // normalizer so the hit lands.
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '(415) 555-0100',
      severity: 'confirmed_scammer',
      provenance: 'aegisdial_recovery:case-3',
    });
    const hit = await svc.lookupThreat('phone_e164', '+14155550100');
    assert.ok(hit);
    assert.equal(hit!.severity, 'confirmed_scammer');
    // And the reverse: lookup with the raw form also works because
    // lookupThreat normalizes its input.
    const hit2 = await svc.lookupThreat('phone_e164', '(415) 555-0100');
    assert.ok(hit2);
  });

  it('defaults expires_at per severity (caution = 90d, confirmed_scammer = NULL)', async () => {
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '+14155550101',
      severity: 'caution',
      provenance: 'telegram_channel:c1:m10',
    });
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '+14155550102',
      severity: 'confirmed_scammer',
      provenance: 'aegisdial_recovery:case-4',
    });
    const caution = fakeTable.find((r) => r.threat_value === '+14155550101')!;
    const confirmed = fakeTable.find((r) => r.threat_value === '+14155550102')!;
    assert.ok(caution.expires_at);
    const ttlMs = caution.expires_at!.getTime() - Date.now();
    // ~90d ± 1 minute of clock drift / test overhead
    const expectedMs = 90 * 86_400_000;
    assert.ok(Math.abs(ttlMs - expectedMs) < 60_000, `caution TTL was ${ttlMs}ms`);
    assert.equal(confirmed.expires_at, null);
  });

  // ──────────────────────────────────────────────────────────────────
  // I-M5 — confirmed_scammer expiry bypass via explicit expires_at
  // ──────────────────────────────────────────────────────────────────
  //
  // Adversarial-review fix (2026-05-12). Before the fix, a caller could
  // pass `expires_at: new Date(0)` for severity='confirmed_scammer' and
  // instantly retire the row — neutralizing the scorer flag for the
  // highest-severity tier. The new contract (see resolveExpiry):
  //   1. confirmed_scammer IGNORES the explicit override; expires_at = NULL.
  //   2. Lower tiers FLOOR an explicit override at now + 1 day.
  it('I-M5: confirmed_scammer ignores caller-supplied expires_at — always NULL', async () => {
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '+14155550103',
      severity: 'confirmed_scammer',
      provenance: 'aegisdial_recovery:case-poison',
      // Hostile payload — attacker tries to age the row out immediately.
      expires_at: new Date(0),
    });
    assert.equal(fakeTable.length, 1);
    const row = fakeTable[0]!;
    // The hostile expires_at MUST have been replaced with NULL.
    assert.equal(row.expires_at, null, 'confirmed_scammer rows must never carry an explicit expiry');
    assert.equal(row.severity, 'confirmed_scammer');
  });

  it('I-M5: lower-tier explicit expires_at in the past is floored at now + 1 day', async () => {
    const beforeNow = Date.now();
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '+14155550104',
      severity: 'caution',
      provenance: 'telegram_channel:c1:m-poison',
      // Hostile payload — attacker tries to push a caution row out of
      // the partial-index window immediately so lookupThreat() misses it.
      expires_at: new Date(0),
    });
    assert.equal(fakeTable.length, 1);
    const row = fakeTable[0]!;
    assert.ok(row.expires_at, 'expires_at must be set, not null');
    const ttlMs = row.expires_at!.getTime() - beforeNow;
    const floorMs = 24 * 60 * 60 * 1000;
    // Floor must be at least 1 day. Allow generous upper bound — the
    // floor is a minimum, not a ceiling; what matters is the row
    // doesn't pre-expire.
    assert.ok(ttlMs >= floorMs - 1000, `caution TTL was ${ttlMs}ms, expected >= ${floorMs}ms`);
    // And the row must be reachable via lookupThreat (i.e., not pre-expired).
    const hit = await svc.lookupThreat('phone_e164', '+14155550104');
    assert.ok(hit, 'caution row must be reachable, not pre-expired by hostile payload');
  });

  it('I-M5: a future explicit expires_at on a lower tier is preserved (not over-floored)', async () => {
    // The floor is a MINIMUM — a caller passing a reasonable future
    // expiry (e.g., 30 days) must see it persist verbatim.
    const wanted = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '+14155550105',
      severity: 'caution',
      provenance: 'telegram_channel:c1:m-30d',
      expires_at: wanted,
    });
    const row = fakeTable[0]!;
    assert.ok(row.expires_at);
    // Within 1s — the floor branch only fires when the explicit value
    // is < now + 1 day; 30 days out is well past that.
    assert.ok(
      Math.abs(row.expires_at!.getTime() - wanted.getTime()) < 1000,
      `expected ${wanted.toISOString()}, got ${row.expires_at!.toISOString()}`,
    );
  });
});

// ----------------------------------------------------------------
// ingestThreatBatch
// ----------------------------------------------------------------

describe('activeThreats.ingestThreatBatch', () => {
  it('returns {inserted, updated:0} on a fresh batch', async () => {
    const res = await svc.ingestThreatBatch([
      {
        kind: 'phone_e164',
        value: '+14155550100',
        severity: 'caution',
        provenance: 'telegram_channel:c1:m1',
      },
      {
        kind: 'email_address',
        value: 'BAD@scam.test',
        severity: 'warning',
        provenance: 'hibp:LinkedIn',
      },
    ]);
    assert.deepEqual(res, { inserted: 2, updated: 0 });
    assert.equal(fakeTable.length, 2);
    // Normalization applied:
    assert.ok(fakeTable.some((r) => r.threat_value === '+14155550100'));
    assert.ok(fakeTable.some((r) => r.threat_value === 'bad@scam.test'));
  });

  it('returns {inserted:0, updated:N} when all rows already exist', async () => {
    await svc.ingestThreatBatch([
      {
        kind: 'phone_e164',
        value: '+14155550100',
        severity: 'caution',
        provenance: 'telegram_channel:c1:m1',
      },
    ]);
    const res = await svc.ingestThreatBatch([
      {
        kind: 'phone_e164',
        value: '+14155550100',
        severity: 'confirmed_scammer',
        provenance: 'telegram_channel:c1:m1',
      },
    ]);
    assert.deepEqual(res, { inserted: 0, updated: 1 });
    // Severity upgraded.
    assert.equal(fakeTable.length, 1);
    assert.equal(fakeTable[0]!.severity, 'confirmed_scammer');
  });

  it('skips malformed rows gracefully and does not count them', async () => {
    const res = await svc.ingestThreatBatch([
      {
        kind: 'phone_e164',
        value: 'garbage',
        severity: 'caution',
        provenance: 'telegram_channel:c1:m1',
      },
      {
        kind: 'phone_e164',
        value: '+14155550100',
        severity: 'caution',
        provenance: 'telegram_channel:c1:m2',
      },
      {
        kind: 'email_address',
        value: 'not-an-email',
        severity: 'caution',
        provenance: 'telegram_channel:c1:m3',
      },
      {
        kind: 'phone_e164',
        value: '+14155550100',
        severity: 'caution',
        provenance: '',
      },
    ]);
    // Only the single valid phone row survives.
    assert.deepEqual(res, { inserted: 1, updated: 0 });
    assert.equal(fakeTable.length, 1);
  });

  it('returns {0,0} on an empty array without issuing SQL', async () => {
    const res = await svc.ingestThreatBatch([]);
    assert.deepEqual(res, { inserted: 0, updated: 0 });
    assert.equal(fakeTable.length, 0);
  });

  it('mixed insert + update returns correct split', async () => {
    // Pre-seed one row.
    await svc.recordThreat({
      kind: 'phone_e164',
      value: '+14155550100',
      severity: 'caution',
      provenance: 'telegram_channel:c1:m1',
    });
    // Batch with: re-observation of the existing row + 2 fresh.
    const res = await svc.ingestThreatBatch([
      {
        kind: 'phone_e164',
        value: '+14155550100',
        severity: 'warning',
        provenance: 'telegram_channel:c1:m1',
      },
      {
        kind: 'phone_e164',
        value: '+14155550200',
        severity: 'caution',
        provenance: 'telegram_channel:c1:m2',
      },
      {
        kind: 'url_host',
        value: 'scam.example',
        severity: 'warning',
        provenance: 'darknet_market:m1:l1',
      },
    ]);
    assert.deepEqual(res, { inserted: 2, updated: 1 });
    const upgraded = fakeTable.find((r) => r.threat_value === '+14155550100')!;
    assert.equal(upgraded.severity, 'warning');
  });
});
