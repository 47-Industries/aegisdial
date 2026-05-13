import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Identity Shield I-P5 — digest scheduler tests.
//
// Stubs:
//   - db.pool.query — pattern-matches SQL emitted by
//     identityShieldDigest.ts against in-memory tables for
//     user_settings / identity_monitors / identity_breach_findings /
//     active_threats.
//   - pushSender — recording stub injected through opts.pushSender;
//     captures payloads so the test asserts the wire shape.
//   - Redis dedup — uses the InMemoryCache backing cache.ts when
//     REDIS_URL='memory://...' (no extra stub needed; the worker
//     calls cacheSetNX directly, which the in-memory shim implements).
//
// Coverage matrix (12 cases from the I-P5 brief):
//   1.  composeDigestForUser daily w/ new findings → DigestPayload
//   2.  composeDigestForUser weekly w/ zero monitors AND zero findings → null
//   3.  composeDigestForUser opted-out → null
//   4.  composeDigestForUser scoped to user's geo_tag
//   5.  sendDigestForUser opted-out → skipped 'optout'
//   6.  sendDigestForUser cadence mismatch → skipped silently
//   7.  sendDigestForUser empty weekly → skipped 'empty'
//   8.  sendDigestForUser happy path → push fires with right payload
//   9.  sendDigestForUser idempotency: second call within 23h → 'recent_push'
//  10.  runDigestPassOnce iterates all eligible users, per-outcome tally
//  11.  runDigestPassOnce with 100 + 30 optout + 20 weekly-on-daily-day → counts
//  12.  Push failure (pushSender throws on user_5) → users 6..N still attempted

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-identity-digest';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://identity-digest';

const db = await import('../src/lib/db.ts');
const cache = await import('../src/lib/cache.ts');
const worker = await import('../src/workers/identityShieldDigest.ts');

// ────────────────────────────────────────────────────────────────
// In-memory model
// ────────────────────────────────────────────────────────────────

interface FakeUserSetting {
  user_id: string;
  identity_digest_cadence: 'daily' | 'weekly' | 'off';
}
interface FakeMonitor {
  user_id: string;
  active: boolean;
}
interface FakeFinding {
  user_id: string;
  surfaced_at: Date;
}
interface FakeThreat {
  severity: string;
  first_seen_at: Date;
  expires_at: Date | null;
  geo_tag: string | null;
}

let fakeSettings: FakeUserSetting[] = [];
let fakeMonitors: FakeMonitor[] = [];
let fakeFindings: FakeFinding[] = [];
let fakeThreats: FakeThreat[] = [];

// Per-test toggle: when set, the matching SQL pattern throws instead
// of returning rows. Used to simulate transient DB failures inside the
// worker without re-writing the router.
let throwOnPattern: RegExp | null = null;

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (throwOnPattern !== null && throwOnPattern.test(trimmed)) {
    throw new Error('simulated DB failure');
  }

  // ── user_settings cadence lookup ──────────────────────────────
  if (/^SELECT identity_digest_cadence FROM user_settings WHERE user_id = \$1/i.test(trimmed)) {
    const [user_id] = params as [string];
    const row = fakeSettings.find((s) => s.user_id === user_id);
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [{ identity_digest_cadence: row.identity_digest_cadence }],
      rowCount: 1,
    };
  }

  // ── cohort SELECTs (cron fan-out) ─────────────────────────────
  if (/^SELECT user_id FROM user_settings WHERE identity_digest_cadence = 'daily'/i.test(trimmed)) {
    const rows = fakeSettings
      .filter((s) => s.identity_digest_cadence === 'daily')
      .map((s) => ({ user_id: s.user_id }));
    return { rows, rowCount: rows.length };
  }
  if (/^SELECT user_id FROM user_settings WHERE identity_digest_cadence = 'weekly'/i.test(trimmed)) {
    const rows = fakeSettings
      .filter((s) => s.identity_digest_cadence === 'weekly')
      .map((s) => ({ user_id: s.user_id }));
    return { rows, rowCount: rows.length };
  }

  // ── monitors_active ───────────────────────────────────────────
  if (/^SELECT COUNT\(\*\)::TEXT AS count FROM identity_monitors WHERE user_id = \$1 AND active = TRUE/i.test(trimmed)) {
    const [user_id] = params as [string];
    const count = fakeMonitors.filter((m) => m.user_id === user_id && m.active).length;
    return { rows: [{ count: String(count) }], rowCount: 1 };
  }

  // ── new_findings_7d ───────────────────────────────────────────
  if (/^SELECT COUNT\(\*\)::TEXT AS count FROM identity_breach_findings WHERE user_id = \$1 AND surfaced_at > NOW\(\) - INTERVAL '7 days'/i.test(trimmed)) {
    const [user_id] = params as [string];
    const sevenAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const count = fakeFindings.filter(
      (f) => f.user_id === user_id && f.surfaced_at.getTime() > sevenAgo,
    ).length;
    return { rows: [{ count: String(count) }], rowCount: 1 };
  }

  // ── 24h scams blocked (daily body) ────────────────────────────
  if (/^SELECT COUNT\(\*\)::TEXT AS count FROM active_threats WHERE first_seen_at > NOW\(\) - INTERVAL '24 hours'/i.test(trimmed)) {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    // Geo param is optional; when present it's params[0]
    const geoFilter = params.length > 0 ? (params[0] as string) : null;
    const count = fakeThreats.filter(
      (t) =>
        t.first_seen_at.getTime() > dayAgo &&
        (t.severity === 'warning' || t.severity === 'confirmed_scammer') &&
        (t.expires_at === null || t.expires_at.getTime() > Date.now()) &&
        (geoFilter === null || t.geo_tag === geoFilter),
    ).length;
    return { rows: [{ count: String(count) }], rowCount: 1 };
  }

  // ── 7d active_threats near user (weekly body) ─────────────────
  if (/^SELECT COUNT\(\*\)::TEXT AS count FROM active_threats WHERE first_seen_at > NOW\(\) - INTERVAL '7 days'/i.test(trimmed)) {
    const sevenAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const geoFilter = params.length > 0 ? (params[0] as string) : null;
    const count = fakeThreats.filter(
      (t) =>
        t.first_seen_at.getTime() > sevenAgo &&
        (t.expires_at === null || t.expires_at.getTime() > Date.now()) &&
        (geoFilter === null || t.geo_tag === geoFilter),
    ).length;
    return { rows: [{ count: String(count) }], rowCount: 1 };
  }

  // metric_counters writes hit emitMetric → ignore.
  if (/^INSERT INTO metric_counters/i.test(trimmed)) {
    return { rows: [], rowCount: 0 };
  }

  throw new Error(`unstubbed SQL pattern: ${trimmed.slice(0, 200)}`);
};

// ────────────────────────────────────────────────────────────────
// pushSender stub
// ────────────────────────────────────────────────────────────────

interface PushRecord {
  userId: string;
  title: string;
  body: string;
  threadId?: string;
  data?: Record<string, unknown>;
  interruptionLevel?: string;
  priority?: number;
}

let pushRecords: PushRecord[] = [];
// When set to a user_id, pushSender throws for that user only.
let pushThrowsForUserId: string | null = null;

const recordingPushSender = async (
  payload: Parameters<typeof import('../src/lib/apns.ts').sendToUser>[0],
): Promise<number> => {
  if (pushThrowsForUserId !== null && payload.userId === pushThrowsForUserId) {
    throw new Error('apns simulated failure');
  }
  pushRecords.push({
    userId: payload.userId,
    title: payload.title,
    body: payload.body,
    threadId: payload.threadId,
    data: payload.data,
    interruptionLevel: payload.interruptionLevel,
    priority: payload.priority,
  });
  return 1;
};

// ────────────────────────────────────────────────────────────────
// Reset
// ────────────────────────────────────────────────────────────────

beforeEach(async () => {
  fakeSettings = [];
  fakeMonitors = [];
  fakeFindings = [];
  fakeThreats = [];
  pushRecords = [];
  pushThrowsForUserId = null;
  throwOnPattern = null;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
  // Reset the in-memory Redis between tests so the dedup gate doesn't
  // carry across cases.
  await cache.redis.quit();
});

// ================================================================
// Case 1 — composeDigestForUser daily with new findings
// ================================================================

describe('composeDigestForUser — daily kind', () => {
  it('returns DigestPayload with daily body when findings + threats present', async () => {
    fakeSettings.push({ user_id: 'u1', identity_digest_cadence: 'daily' });
    fakeMonitors.push({ user_id: 'u1', active: true });
    fakeFindings.push({ user_id: 'u1', surfaced_at: new Date() });
    // Seed 23 high-sev threats first_seen in the last 24h.
    for (let i = 0; i < 23; i++) {
      fakeThreats.push({
        severity: i % 2 === 0 ? 'warning' : 'confirmed_scammer',
        first_seen_at: new Date(Date.now() - 30 * 60 * 1000),
        expires_at: null,
        geo_tag: 'US',
      });
    }
    const payload = await worker.composeDigestForUser({
      user_id: 'u1',
      digest_kind: 'daily',
    });
    assert.ok(payload, 'expected a payload, not null');
    assert.equal(payload!.digest_kind, 'daily');
    assert.equal(payload!.title, "We're watching");
    assert.match(payload!.body, /AegisDial blocked 23 scams/);
    assert.equal((payload!.data as Record<string, unknown>).kind, 'identity_shield_digest');
    assert.equal((payload!.data as Record<string, unknown>).digest_kind, 'daily');
    assert.equal((payload!.data as Record<string, unknown>).scams_blocked_yesterday, 23);
  });
});

// ================================================================
// Case 2 — composeDigestForUser weekly with no findings/threats → null
// ================================================================

describe('composeDigestForUser — weekly with no data', () => {
  it('returns null when monitors_active=0 AND new_findings_7d=0', async () => {
    fakeSettings.push({ user_id: 'u2', identity_digest_cadence: 'weekly' });
    // No monitors. No findings. Some global threats — but those don't
    // rescue an empty weekly per spec (active_threats are NOT in the
    // empty-weekly gate).
    fakeThreats.push({
      severity: 'caution',
      first_seen_at: new Date(),
      expires_at: null,
      geo_tag: 'US',
    });
    const payload = await worker.composeDigestForUser({
      user_id: 'u2',
      digest_kind: 'weekly',
    });
    assert.equal(payload, null);
  });
});

// ================================================================
// Case 3 — composeDigestForUser daily for opted-out user → null
// ================================================================

describe('composeDigestForUser — opted out', () => {
  it('returns null for a user with identity_digest_cadence=off', async () => {
    fakeSettings.push({ user_id: 'u3', identity_digest_cadence: 'off' });
    fakeMonitors.push({ user_id: 'u3', active: true });
    fakeFindings.push({ user_id: 'u3', surfaced_at: new Date() });
    const payload = await worker.composeDigestForUser({
      user_id: 'u3',
      digest_kind: 'daily',
    });
    assert.equal(payload, null);
  });
});

// ================================================================
// Case 4 — composeDigestForUser scoped to user's geo
// ================================================================

describe('composeDigestForUser — geo scoping', () => {
  it('weekly body uses geo-scoped active_threats when geo_tag is set', async () => {
    fakeSettings.push({ user_id: 'u4', identity_digest_cadence: 'weekly' });
    fakeMonitors.push({ user_id: 'u4', active: true });
    fakeFindings.push({ user_id: 'u4', surfaced_at: new Date() });
    // Seed 5 US threats + 50 UK threats in the last 7d.
    for (let i = 0; i < 5; i++) {
      fakeThreats.push({
        severity: 'caution',
        first_seen_at: new Date(),
        expires_at: null,
        geo_tag: 'US',
      });
    }
    for (let i = 0; i < 50; i++) {
      fakeThreats.push({
        severity: 'caution',
        first_seen_at: new Date(),
        expires_at: null,
        geo_tag: 'UK',
      });
    }
    const usPayload = await worker.composeDigestForUser({
      user_id: 'u4',
      digest_kind: 'weekly',
      geo_tag: 'US',
    });
    assert.ok(usPayload, 'expected US payload');
    // Body cites 5 active scammers near (geo=US), not 55.
    assert.match(usPayload!.body, /5 active scammers near you/);
    // notMatch isn't in node:assert/strict — use doesNotMatch.
    assert.doesNotMatch(usPayload!.body, /50/);
    // No geo override → global count = 55.
    const globalPayload = await worker.composeDigestForUser({
      user_id: 'u4',
      digest_kind: 'weekly',
    });
    assert.match(globalPayload!.body, /55 active scammers near you/);
  });
});

// ================================================================
// Case 5 — sendDigestForUser opt-out → skipped 'optout'
// ================================================================

describe('sendDigestForUser — opt-out', () => {
  it('returns {sent:false, reason_skipped:"optout"} and DOES NOT push', async () => {
    fakeSettings.push({ user_id: 'u5', identity_digest_cadence: 'off' });
    const r = await worker.sendDigestForUser({
      user_id: 'u5',
      digest_kind: 'daily',
      opts: { pushSender: recordingPushSender },
    });
    assert.equal(r.sent, false);
    assert.equal(r.reason_skipped, 'optout');
    assert.equal(pushRecords.length, 0, 'no push should fire for opted-out users');
  });
});

// ================================================================
// Case 6 — sendDigestForUser cadence mismatch → skipped silently
// ================================================================

describe('sendDigestForUser — cadence mismatch', () => {
  it('weekly-cadence user invoked with daily kind is silently skipped', async () => {
    fakeSettings.push({ user_id: 'u6', identity_digest_cadence: 'weekly' });
    fakeMonitors.push({ user_id: 'u6', active: true });
    const r = await worker.sendDigestForUser({
      user_id: 'u6',
      digest_kind: 'daily',
      opts: { pushSender: recordingPushSender },
    });
    assert.equal(r.sent, false);
    assert.equal(r.reason_skipped, 'cadence_mismatch');
    assert.equal(pushRecords.length, 0);
  });
});

// ================================================================
// Case 7 — sendDigestForUser empty weekly → skipped 'empty'
// ================================================================

describe('sendDigestForUser — empty weekly', () => {
  it('returns {sent:false, reason_skipped:"empty"} when compose returns null', async () => {
    fakeSettings.push({ user_id: 'u7', identity_digest_cadence: 'weekly' });
    // No monitors, no findings, no threats → weekly compose returns null.
    const r = await worker.sendDigestForUser({
      user_id: 'u7',
      digest_kind: 'weekly',
      opts: { pushSender: recordingPushSender },
    });
    assert.equal(r.sent, false);
    assert.equal(r.reason_skipped, 'empty');
    assert.equal(pushRecords.length, 0);
  });
});

// ================================================================
// Case 8 — sendDigestForUser happy path
// ================================================================

describe('sendDigestForUser — happy path', () => {
  it('push fires with expected APNs envelope shape', async () => {
    fakeSettings.push({ user_id: 'u8', identity_digest_cadence: 'daily' });
    fakeMonitors.push({ user_id: 'u8', active: true });
    fakeFindings.push({ user_id: 'u8', surfaced_at: new Date() });
    for (let i = 0; i < 7; i++) {
      fakeThreats.push({
        severity: 'confirmed_scammer',
        first_seen_at: new Date(Date.now() - 60 * 60 * 1000),
        expires_at: null,
        geo_tag: null,
      });
    }
    const r = await worker.sendDigestForUser({
      user_id: 'u8',
      digest_kind: 'daily',
      opts: { pushSender: recordingPushSender },
    });
    assert.equal(r.sent, true);
    assert.equal(pushRecords.length, 1);
    const p = pushRecords[0]!;
    assert.equal(p.userId, 'u8');
    assert.equal(p.title, "We're watching");
    assert.match(p.body, /AegisDial blocked 7 scams/);
    assert.equal(p.threadId, 'identity-shield-digest');
    assert.equal(p.interruptionLevel, 'passive');
    assert.equal(p.priority, 5);
    assert.deepEqual(p.data, {
      kind: 'identity_shield_digest',
      digest_kind: 'daily',
      scams_blocked_yesterday: 7,
      new_findings_7d: 1,
    });
  });
});

// ================================================================
// Case 9 — idempotency via Redis dedup gate
// ================================================================

describe('sendDigestForUser — idempotency', () => {
  it('second call within 23h is skipped with reason "recent_push"', async () => {
    fakeSettings.push({ user_id: 'u9', identity_digest_cadence: 'daily' });
    fakeMonitors.push({ user_id: 'u9', active: true });
    fakeFindings.push({ user_id: 'u9', surfaced_at: new Date() });
    // First call: sends.
    const first = await worker.sendDigestForUser({
      user_id: 'u9',
      digest_kind: 'daily',
      opts: { pushSender: recordingPushSender },
    });
    assert.equal(first.sent, true);
    assert.equal(pushRecords.length, 1);
    // Second call (same calendar minute): the dedup gate fires.
    const second = await worker.sendDigestForUser({
      user_id: 'u9',
      digest_kind: 'daily',
      opts: { pushSender: recordingPushSender },
    });
    assert.equal(second.sent, false);
    assert.equal(second.reason_skipped, 'recent_push');
    assert.equal(pushRecords.length, 1, 'pushSender must only fire once across the two calls');
    // Cross-kind isolation: a weekly call for the same user is NOT
    // blocked by the daily slot (different Redis keys).
    fakeSettings[0]!.identity_digest_cadence = 'weekly';
    const third = await worker.sendDigestForUser({
      user_id: 'u9',
      digest_kind: 'weekly',
      opts: { pushSender: recordingPushSender },
    });
    // Compose-side: monitors=1, findings=1 → weekly is non-empty.
    assert.equal(third.sent, true);
    assert.equal(pushRecords.length, 2);
  });
});

// ================================================================
// Case 10 — runDigestPassOnce per-outcome tally
// ================================================================

describe('runDigestPassOnce — per-outcome tally', () => {
  it('counts daily pushed, weekly pushed, optout, empty independently', async () => {
    // 2 daily users with non-empty digests, 1 daily user opted-out
    // is not possible (cadence=off lives in a different cohort). The
    // realistic optout-during-pass case is a user with cadence=off
    // that's NOT in either cohort. Instead, exercise:
    //   - 2 daily users with non-empty → 2 daily pushed
    //   - 3 weekly users, 1 non-empty, 2 empty → 1 weekly pushed + 2 empty
    fakeSettings.push({ user_id: 'd1', identity_digest_cadence: 'daily' });
    fakeSettings.push({ user_id: 'd2', identity_digest_cadence: 'daily' });
    fakeMonitors.push({ user_id: 'd1', active: true });
    fakeFindings.push({ user_id: 'd1', surfaced_at: new Date() });
    fakeMonitors.push({ user_id: 'd2', active: true });
    fakeFindings.push({ user_id: 'd2', surfaced_at: new Date() });
    fakeSettings.push({ user_id: 'w1', identity_digest_cadence: 'weekly' });
    fakeSettings.push({ user_id: 'w2', identity_digest_cadence: 'weekly' });
    fakeSettings.push({ user_id: 'w3', identity_digest_cadence: 'weekly' });
    fakeMonitors.push({ user_id: 'w1', active: true });
    fakeFindings.push({ user_id: 'w1', surfaced_at: new Date() });
    // w2 + w3 have nothing → empty weekly.
    const r = await worker.runDigestPassOnce({ pushSender: recordingPushSender });
    assert.equal(r.daily_users_pushed, 2);
    assert.equal(r.weekly_users_pushed, 1);
    assert.equal(r.skipped_empty, 2);
    assert.equal(r.skipped_optout, 0);
    assert.equal(r.push_errors, 0);
    // 3 actual pushes (2 daily + 1 weekly).
    assert.equal(pushRecords.length, 3);
  });
});

// ================================================================
// Case 11 — 100 users + 30 optout + 20 weekly-on-daily-day
// ================================================================

describe('runDigestPassOnce — large cohort with mixed cadences', () => {
  it('100 daily / 20 weekly / 30 optout → 100 daily pushed, 30 not in cohort', async () => {
    // 100 daily users (each with one finding → non-empty).
    for (let i = 0; i < 100; i++) {
      const id = `daily_${i}`;
      fakeSettings.push({ user_id: id, identity_digest_cadence: 'daily' });
      fakeMonitors.push({ user_id: id, active: true });
      fakeFindings.push({ user_id: id, surfaced_at: new Date() });
    }
    // 20 weekly users (each non-empty so weekly cohort pushes too).
    for (let i = 0; i < 20; i++) {
      const id = `weekly_${i}`;
      fakeSettings.push({ user_id: id, identity_digest_cadence: 'weekly' });
      fakeMonitors.push({ user_id: id, active: true });
      fakeFindings.push({ user_id: id, surfaced_at: new Date() });
    }
    // 30 opted-out users.
    for (let i = 0; i < 30; i++) {
      fakeSettings.push({ user_id: `off_${i}`, identity_digest_cadence: 'off' });
    }
    const r = await worker.runDigestPassOnce({ pushSender: recordingPushSender });
    assert.equal(r.daily_users_pushed, 100);
    assert.equal(r.weekly_users_pushed, 20);
    // optout users are not in either cohort SELECT → not iterated.
    assert.equal(r.skipped_optout, 0);
    assert.equal(r.skipped_empty, 0);
    assert.equal(r.push_errors, 0);
    assert.equal(pushRecords.length, 120);
  });
});

// ================================================================
// Case 12 — push failure does NOT cascade-stop the pass
// ================================================================

describe('runDigestPassOnce — push failure tolerance', () => {
  it('pushSender throwing on one user does NOT skip subsequent users', async () => {
    // 10 daily users, pushSender throws for daily_5 only.
    for (let i = 0; i < 10; i++) {
      const id = `daily_${i}`;
      fakeSettings.push({ user_id: id, identity_digest_cadence: 'daily' });
      fakeMonitors.push({ user_id: id, active: true });
      fakeFindings.push({ user_id: id, surfaced_at: new Date() });
    }
    pushThrowsForUserId = 'daily_5';
    const r = await worker.runDigestPassOnce({ pushSender: recordingPushSender });
    // 9 succeed; daily_5 counts as push_errors.
    assert.equal(r.daily_users_pushed, 9);
    assert.equal(r.push_errors, 1);
    // Pushes recorded for all users EXCEPT daily_5.
    const userIds = pushRecords.map((p) => p.userId).sort();
    assert.deepEqual(
      userIds,
      [
        'daily_0',
        'daily_1',
        'daily_2',
        'daily_3',
        'daily_4',
        'daily_6',
        'daily_7',
        'daily_8',
        'daily_9',
      ],
      'every user except daily_5 must have been attempted',
    );
  });
});

// ================================================================
// Bonus — Cross-user isolation in composition (adversarial)
// ================================================================

describe('composeDigestForUser — cross-user isolation', () => {
  it("user A's monitors + findings do not leak into user B's digest", async () => {
    fakeSettings.push({ user_id: 'A', identity_digest_cadence: 'weekly' });
    fakeSettings.push({ user_id: 'B', identity_digest_cadence: 'weekly' });
    // User A has 7 monitors + 3 findings. User B has none.
    for (let i = 0; i < 7; i++) fakeMonitors.push({ user_id: 'A', active: true });
    for (let i = 0; i < 3; i++) fakeFindings.push({ user_id: 'A', surfaced_at: new Date() });
    const bPayload = await worker.composeDigestForUser({
      user_id: 'B',
      digest_kind: 'weekly',
    });
    // Because B has 0 monitors AND 0 findings, compose returns null.
    // Confirms the SELECT filters by user_id (not a UNION of all
    // users' data).
    assert.equal(bPayload, null);
    const aPayload = await worker.composeDigestForUser({
      user_id: 'A',
      digest_kind: 'weekly',
    });
    assert.ok(aPayload, "user A's digest should compose");
    assert.match(aPayload!.body, /We're watching 7 data points/);
    assert.match(aPayload!.body, /3 new breaches this week/);
  });
});

// ================================================================
// Bonus — opt-out honored even when sendDigestForUser is called directly
// ================================================================

describe('sendDigestForUser — opt-out is the canonical boundary', () => {
  it('opt-out check fires BEFORE any DB composition work', async () => {
    fakeSettings.push({ user_id: 'oo', identity_digest_cadence: 'off' });
    // Mark monitors_active / findings_7d SQL to throw — if the worker
    // honored opt-out properly, those queries are never issued and
    // the throw never propagates. If it doesn't, the test would
    // surface 500-like behavior or alter the recorded outcome.
    throwOnPattern = /SELECT COUNT\(\*\)::TEXT AS count FROM identity_monitors/i;
    const r = await worker.sendDigestForUser({
      user_id: 'oo',
      digest_kind: 'daily',
      opts: { pushSender: recordingPushSender },
    });
    assert.equal(r.sent, false);
    assert.equal(r.reason_skipped, 'optout');
    assert.equal(pushRecords.length, 0);
  });
});
