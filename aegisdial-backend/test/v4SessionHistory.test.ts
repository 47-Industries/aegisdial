import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 15 — session-history route tests.
// Pins: auth gate, UUID validation, 404 shape on unknown session,
// chronological order on multiple events, current-state echo from
// call_sessions, ISO timestamps on serialization.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-session-history';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-session-history';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { adminRoutes } = await import('../src/routes/admin.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;
const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const UNKNOWN_ID = '99999999-9999-9999-9999-999999999999';

interface CallSessionRow {
  id: string;
  v4_playbook_id: string | null;
  v4_stage: string | null;
  v4_stage_confidence: number | null;
  v4_classified_at: Date | null;
  v4_transition_count: number;
}

interface StageEventRow {
  occurred_at: Date;
  from_playbook_id: string | null;
  from_stage: string | null;
  to_playbook_id: string;
  to_stage: string;
  confidence: number;
  trigger_event_id: string | null;
  reasoning: string | null;
}

const dbState = {
  sessions: new Map<string, CallSessionRow>(),
  events: [] as Array<{ session_id: string } & StageEventRow>,
};

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  if (/FROM call_sessions/i.test(text)) {
    const row = dbState.sessions.get(params[0] as string);
    return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/FROM b4_playbook_stage_events/i.test(text)) {
    const sid = params[0] as string;
    const rows = dbState.events
      .filter((e) => e.session_id === sid)
      .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
    return { rows, rowCount: rows.length };
  }
  return { rows: [], rowCount: 0 };
};

beforeEach(() => {
  dbState.sessions.clear();
  dbState.events.length = 0;
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(adminRoutes);
  return app;
}

describe('GET /admin/v4/sessions/:id/classifications — auth + UUID validation', () => {
  it('returns 401 without bearer token', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/v4/sessions/${SESSION_ID}/classifications`,
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  it('returns 400 for a non-UUID id (defense-in-depth)', async () => {
    const app = await buildApp();
    try {
      const cases = ['not-a-uuid', '12345', "'; DROP TABLE call_sessions;--", ''];
      for (const bad of cases) {
        const res = await app.inject({
          method: 'GET',
          url: `/admin/v4/sessions/${encodeURIComponent(bad)}/classifications`,
          headers: { authorization: `Bearer ${SHARED_SECRET}` },
        });
        // empty string actually 404s the route (no match), so allow 400 or 404 there.
        assert.ok(
          res.statusCode === 400 || res.statusCode === 404,
          `${bad} → ${res.statusCode}`,
        );
      }
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/v4/sessions/:id/classifications — 404 on unknown session', () => {
  it('returns 404 + session_id echo for an unknown UUID', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/v4/sessions/${UNKNOWN_ID}/classifications`,
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 404);
      const body = res.json() as { error: string; session_id: string };
      assert.equal(body.error, 'session_not_found');
      assert.equal(body.session_id, UNKNOWN_ID);
    } finally {
      await app.close();
    }
  });
});

describe('GET /admin/v4/sessions/:id/classifications — happy path', () => {
  it('returns current state + chronological events for a session with classifications', async () => {
    const t0 = new Date('2026-05-11T10:00:00Z');
    const t1 = new Date('2026-05-11T10:00:30Z');
    const t2 = new Date('2026-05-11T10:02:00Z');
    dbState.sessions.set(SESSION_ID, {
      id: SESSION_ID,
      v4_playbook_id: 'bank_impersonation',
      v4_stage: 'ask',
      v4_stage_confidence: 87,
      v4_classified_at: t2,
      v4_transition_count: 2,
    });
    // Two events; insert OUT OF ORDER to verify sorting.
    dbState.events.push({
      session_id: SESSION_ID,
      occurred_at: t2,
      from_playbook_id: 'bank_impersonation',
      from_stage: 'fear',
      to_playbook_id: 'bank_impersonation',
      to_stage: 'ask',
      confidence: 87,
      trigger_event_id: null,
      reasoning: 'asked for account number',
    });
    dbState.events.push({
      session_id: SESSION_ID,
      occurred_at: t0,
      from_playbook_id: null,
      from_stage: null,
      to_playbook_id: 'bank_impersonation',
      to_stage: 'authority',
      confidence: 78,
      trigger_event_id: null,
      reasoning: 'said fraud department',
    });
    // Add an event for a DIFFERENT session — must not leak into this query.
    dbState.events.push({
      session_id: UNKNOWN_ID,
      occurred_at: t1,
      from_playbook_id: null,
      from_stage: null,
      to_playbook_id: 'irs_impersonation',
      to_stage: 'authority',
      confidence: 90,
      trigger_event_id: null,
      reasoning: 'wrong session',
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/v4/sessions/${SESSION_ID}/classifications`,
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        session_id: string;
        session_exists: boolean;
        current: {
          v4_playbook_id: string;
          v4_stage: string;
          v4_stage_confidence: number;
          v4_classified_at: string;
          v4_transition_count: number;
        };
        events: Array<{
          occurred_at: string;
          from_playbook_id: string | null;
          to_playbook_id: string;
          to_stage: string;
          confidence: number;
        }>;
      };
      assert.equal(body.session_id, SESSION_ID);
      assert.equal(body.session_exists, true);
      assert.equal(body.current.v4_playbook_id, 'bank_impersonation');
      assert.equal(body.current.v4_stage, 'ask');
      assert.equal(body.current.v4_stage_confidence, 87);
      assert.equal(body.current.v4_transition_count, 2);
      assert.equal(body.events.length, 2, 'foreign-session event must not leak in');
      // Chronological — earliest first regardless of insertion order.
      assert.equal(body.events[0]!.to_stage, 'authority');
      assert.equal(body.events[1]!.to_stage, 'ask');
      // Initial commit has null from_*.
      assert.equal(body.events[0]!.from_playbook_id, null);
      // Transition has both from_* and to_*.
      assert.equal(body.events[1]!.from_playbook_id, 'bank_impersonation');
      // ISO format on timestamps.
      assert.match(body.events[0]!.occurred_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(body.current.v4_classified_at, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await app.close();
    }
  });

  it('redacts sensitive digit sequences in `reasoning` (HIGH-1 PII fix)', async () => {
    const t0 = new Date('2026-05-11T10:00:00Z');
    dbState.sessions.set(SESSION_ID, {
      id: SESSION_ID,
      v4_playbook_id: 'bank_impersonation',
      v4_stage: 'ask',
      v4_stage_confidence: 90,
      v4_classified_at: t0,
      v4_transition_count: 1,
    });
    dbState.events.push({
      session_id: SESSION_ID,
      occurred_at: t0,
      from_playbook_id: null,
      from_stage: null,
      to_playbook_id: 'bank_impersonation',
      to_stage: 'ask',
      confidence: 90,
      trigger_event_id: null,
      // Scammer-spoken reasoning quoting the victim's last 4 + a
      // case number. Both should be redacted.
      reasoning: 'asked for last four 4119 and case number 22-87654',
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/v4/sessions/${SESSION_ID}/classifications`,
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      const body = res.json() as { events: Array<{ reasoning: string | null }> };
      const r = body.events[0]!.reasoning!;
      assert.doesNotMatch(r, /4119/, 'last-four digits must be redacted');
      assert.doesNotMatch(r, /22-87654/, 'case number digits must be redacted');
    } finally {
      await app.close();
    }
  });

  it('emits confidence_bucket alongside numeric confidence (M-1 unit-alignment fix)', async () => {
    const t0 = new Date('2026-05-11T10:00:00Z');
    dbState.sessions.set(SESSION_ID, {
      id: SESSION_ID,
      v4_playbook_id: 'bank_impersonation',
      v4_stage: 'ask',
      v4_stage_confidence: 87,
      v4_classified_at: t0,
      v4_transition_count: 1,
    });
    dbState.events.push({
      session_id: SESSION_ID,
      occurred_at: t0,
      from_playbook_id: null,
      from_stage: null,
      to_playbook_id: 'bank_impersonation',
      to_stage: 'ask',
      confidence: 87, // 0..100 scale → 0.87 → lt90
      trigger_event_id: null,
      reasoning: null,
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/v4/sessions/${SESSION_ID}/classifications`,
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      const body = res.json() as { events: Array<{ confidence: number; confidence_bucket: string }> };
      assert.equal(body.events[0]!.confidence, 87);
      assert.equal(
        body.events[0]!.confidence_bucket,
        'lt90',
        'must match Phase 13 bucket vocabulary',
      );
    } finally {
      await app.close();
    }
  });

  it('caps reasoning at 500 chars in the response mapper (MEDIUM-2 defense in depth)', async () => {
    const t0 = new Date('2026-05-11T10:00:00Z');
    dbState.sessions.set(SESSION_ID, {
      id: SESSION_ID,
      v4_playbook_id: 'bank_impersonation',
      v4_stage: 'ask',
      v4_stage_confidence: 90,
      v4_classified_at: t0,
      v4_transition_count: 1,
    });
    dbState.events.push({
      session_id: SESSION_ID,
      occurred_at: t0,
      from_playbook_id: null,
      from_stage: null,
      to_playbook_id: 'bank_impersonation',
      to_stage: 'ask',
      confidence: 90,
      trigger_event_id: null,
      reasoning: 'x'.repeat(2000),
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/v4/sessions/${SESSION_ID}/classifications`,
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      const body = res.json() as { events: Array<{ reasoning: string | null }> };
      assert.ok(body.events[0]!.reasoning!.length <= 500, 'response capped at 500');
    } finally {
      await app.close();
    }
  });

  it('normalizes empty-string reasoning to null (LOW-2 cosmetic)', async () => {
    const t0 = new Date('2026-05-11T10:00:00Z');
    dbState.sessions.set(SESSION_ID, {
      id: SESSION_ID,
      v4_playbook_id: 'bank_impersonation',
      v4_stage: 'ask',
      v4_stage_confidence: 90,
      v4_classified_at: t0,
      v4_transition_count: 1,
    });
    dbState.events.push({
      session_id: SESSION_ID,
      occurred_at: t0,
      from_playbook_id: null,
      from_stage: null,
      to_playbook_id: 'bank_impersonation',
      to_stage: 'ask',
      confidence: 90,
      trigger_event_id: null,
      reasoning: '',
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/v4/sessions/${SESSION_ID}/classifications`,
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      const body = res.json() as { events: Array<{ reasoning: string | null }> };
      assert.equal(body.events[0]!.reasoning, null);
    } finally {
      await app.close();
    }
  });

  it('returns empty events + null-ish current for a session that exists but never classified', async () => {
    dbState.sessions.set(SESSION_ID, {
      id: SESSION_ID,
      v4_playbook_id: null,
      v4_stage: null,
      v4_stage_confidence: null,
      v4_classified_at: null,
      v4_transition_count: 0,
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/v4/sessions/${SESSION_ID}/classifications`,
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        session_exists: boolean;
        current: { v4_playbook_id: string | null; v4_transition_count: number };
        events: unknown[];
      };
      assert.equal(body.session_exists, true);
      assert.equal(body.current.v4_playbook_id, null);
      assert.equal(body.current.v4_transition_count, 0);
      assert.equal(body.events.length, 0);
    } finally {
      await app.close();
    }
  });
});
