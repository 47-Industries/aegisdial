import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 3B — recap endpoint tests.
//
// GET /v1/live-shield/:id/recap returns:
//   - latest: { playbook_id, stage, stage_confidence, classified_at,
//     transition_count } from call_sessions (NULL when classifier never
//     fired on this session)
//   - transitions: ordered list from b4_playbook_stage_events
//
// Pins:
//   - 404 when the session belongs to a different user (no leak of
//     "this session exists but isn't yours")
//   - 200 with empty trail when classifier was off / never fired
//   - 200 with full trail in chronological order

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-recap';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-recap-test';
process.env.ALLOW_DEV_BEARER = 'true';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { liveShieldRoutes } = await import('../src/routes/liveShield.ts');

const DEV_USER_ID = '00000000-0000-0000-0000-000000000000';
const OTHER_USER_ID = '00000000-0000-0000-0000-000000099999';
const SESSION = '00000000-0000-0000-0000-00000000c0c0';
const FOREIGN_SESSION = '00000000-0000-0000-0000-00000000ff00';
const SHARED_SECRET = process.env.API_SHARED_SECRET!;

// --------------------------------------------------------------------
// In-memory DB state
// --------------------------------------------------------------------

interface CallSession {
  id: string;
  user_id: string;
  v4_playbook_id: string | null;
  v4_stage: string | null;
  v4_stage_confidence: number | null;
  v4_classified_at: Date | null;
  v4_transition_count: number;
}
interface TransitionRow {
  session_id: string;
  from_playbook_id: string | null;
  from_stage: string | null;
  to_playbook_id: string;
  to_stage: string;
  confidence: number;
  reasoning: string | null;
  occurred_at: Date;
}

const state: {
  callSessions: CallSession[];
  transitions: TransitionRow[];
} = {
  callSessions: [],
  transitions: [],
};

function resetDb() {
  state.callSessions = [
    {
      id: SESSION,
      user_id: DEV_USER_ID,
      v4_playbook_id: 'bank_impersonation',
      v4_stage: 'ask',
      v4_stage_confidence: 88,
      v4_classified_at: new Date('2026-05-11T10:05:00Z'),
      v4_transition_count: 4,
    },
    {
      // Foreign session — owned by OTHER_USER_ID. Used to assert the
      // 404 path doesn't leak existence to a non-owner.
      id: FOREIGN_SESSION,
      user_id: OTHER_USER_ID,
      v4_playbook_id: 'irs_impersonation',
      v4_stage: 'fear',
      v4_stage_confidence: 90,
      v4_classified_at: new Date('2026-05-11T10:00:00Z'),
      v4_transition_count: 3,
    },
  ];
  state.transitions = [
    {
      session_id: SESSION,
      from_playbook_id: null,
      from_stage: null,
      to_playbook_id: 'bank_impersonation',
      to_stage: 'rapport',
      confidence: 72,
      reasoning: 'Caller opened with courtesy-call phrasing.',
      occurred_at: new Date('2026-05-11T10:00:30Z'),
    },
    {
      session_id: SESSION,
      from_playbook_id: 'bank_impersonation',
      from_stage: 'rapport',
      to_playbook_id: 'bank_impersonation',
      to_stage: 'authority',
      confidence: 81,
      reasoning: 'Identified as Wells Fargo fraud team.',
      occurred_at: new Date('2026-05-11T10:02:00Z'),
    },
    {
      session_id: SESSION,
      from_playbook_id: 'bank_impersonation',
      from_stage: 'authority',
      to_playbook_id: 'bank_impersonation',
      to_stage: 'fear',
      confidence: 85,
      reasoning: 'Invoked urgent transfer threat.',
      occurred_at: new Date('2026-05-11T10:03:30Z'),
    },
    {
      session_id: SESSION,
      from_playbook_id: 'bank_impersonation',
      from_stage: 'fear',
      to_playbook_id: 'bank_impersonation',
      to_stage: 'ask',
      confidence: 88,
      reasoning: 'Demanded wire to "safe" account.',
      occurred_at: new Date('2026-05-11T10:05:00Z'),
    },
  ];
}

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const normalized = text.replace(/\s+/g, ' ').trim();

  // Auth resolver in requireAppUser fetches the user_id from a bearer
  // token — when ALLOW_DEV_BEARER=true the harness uses the test
  // shared secret as a dev bypass with DEV_USER_ID. The auth path also
  // SELECTs the user row at least once; return a benign shape.
  if (/SELECT .* FROM users WHERE id = \$1/i.test(normalized)) {
    return { rows: [{ id: params[0], tier: 'pro' }], rowCount: 1 };
  }

  // Recap route — ownership probe.
  if (
    /SELECT id FROM call_sessions WHERE id = \$1 AND user_id = \$2/i.test(normalized)
  ) {
    const [id, user_id] = params as [string, string];
    const row = state.callSessions.find((s) => s.id === id && s.user_id === user_id);
    return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
  }

  // Recap route — latest committed state on call_sessions.
  if (
    /SELECT v4_playbook_id, v4_stage, v4_stage_confidence, v4_classified_at, v4_transition_count FROM call_sessions WHERE id = \$1/i.test(
      normalized,
    )
  ) {
    const [id] = params as [string];
    const row = state.callSessions.find((s) => s.id === id);
    return {
      rows: row
        ? [
            {
              v4_playbook_id: row.v4_playbook_id,
              v4_stage: row.v4_stage,
              v4_stage_confidence: row.v4_stage_confidence,
              v4_classified_at: row.v4_classified_at,
              v4_transition_count: row.v4_transition_count,
            },
          ]
        : [],
      rowCount: row ? 1 : 0,
    };
  }

  // Recap route — transitions list. Adversarial H1 fix dropped
  // `reasoning` from the SELECT (paraphrased transcript content,
  // not safe to user-egress per migration 020's at-rest encryption
  // invariant).
  if (
    /SELECT from_playbook_id, from_stage, to_playbook_id, to_stage, confidence, occurred_at FROM b4_playbook_stage_events WHERE session_id = \$1 ORDER BY occurred_at ASC/i.test(
      normalized,
    )
  ) {
    const [id] = params as [string];
    const rows = state.transitions
      .filter((t) => t.session_id === id)
      .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
    return { rows, rowCount: rows.length };
  }

  // Anything else — return empty rows. The recap route only fires the
  // three queries above; other routes' queries shouldn't reach here.
  return { rows: [], rowCount: 0 };
};

// --------------------------------------------------------------------
// Test harness
// --------------------------------------------------------------------

interface FastifyAppLike {
  inject: (opts: unknown) => Promise<{ statusCode: number; body: string }>;
  ready: () => Promise<unknown>;
  close: () => Promise<unknown>;
}

let app: FastifyAppLike;

before(async () => {
  (db as unknown as { pool: { query: typeof fakeQuery } }).pool.query =
    fakeQuery as unknown as typeof fakeQuery;
  const fastifyApp = Fastify({ logger: false });
  await fastifyApp.register(liveShieldRoutes);
  await fastifyApp.ready();
  app = fastifyApp as unknown as FastifyAppLike;
});

beforeEach(() => {
  resetDb();
});

const authHeaders = { authorization: `Bearer ${SHARED_SECRET}` };

// --------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------

describe('GET /v1/live-shield/:id/recap', () => {
  it('returns latest + ordered transitions for the owner', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/live-shield/${SESSION}/recap`,
      headers: authHeaders,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      session_id: string;
      latest: { playbook_id: string; stage: string; stage_confidence: number; transition_count: number };
      transitions: Array<{ to_stage: string; from_stage: string | null; confidence: number }>;
    };
    assert.equal(body.session_id, SESSION);
    assert.ok(body.latest);
    assert.equal(body.latest.playbook_id, 'bank_impersonation');
    assert.equal(body.latest.stage, 'ask');
    assert.equal(body.latest.transition_count, 4);
    assert.equal(body.transitions.length, 4);
    // Chronological order — first transition has from_stage=null
    // (initial commit), last has to_stage='ask'.
    assert.equal(body.transitions[0]!.from_stage, null);
    assert.equal(body.transitions[0]!.to_stage, 'rapport');
    assert.equal(body.transitions[3]!.to_stage, 'ask');
    assert.equal(body.transitions[3]!.confidence, 88);
  });

  // Adversarial H1 regression pin — the recap response must NOT
  // surface `reasoning`. That column holds classifier-paraphrased
  // scammer transcript content and the rest of the system treats
  // transcript text as encrypted-at-rest (migration 020). A future
  // "let's enrich the recap" change must not silently re-add it.
  it('does NOT include the reasoning field in any transition (privacy invariant)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/live-shield/${SESSION}/recap`,
      headers: authHeaders,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      transitions: Array<Record<string, unknown>>;
    };
    for (const t of body.transitions) {
      assert.equal(
        'reasoning' in t,
        false,
        'recap must not egress classifier-paraphrased transcript content',
      );
    }
  });

  it('returns 404 on a session owned by another user (no leak)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/live-shield/${FOREIGN_SESSION}/recap`,
      headers: authHeaders,
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body) as { error: string };
    assert.equal(body.error, 'session_not_found');
  });

  it('returns 404 on a completely unknown session id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/live-shield/00000000-0000-0000-0000-aaaaaaaaaaaa/recap`,
      headers: authHeaders,
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns empty transitions when classifier never fired', async () => {
    // Replace session with one that has no v4 columns and no
    // transitions.
    state.callSessions = [
      {
        id: SESSION,
        user_id: DEV_USER_ID,
        v4_playbook_id: null,
        v4_stage: null,
        v4_stage_confidence: null,
        v4_classified_at: null,
        v4_transition_count: 0,
      },
    ];
    state.transitions = [];

    const res = await app.inject({
      method: 'GET',
      url: `/v1/live-shield/${SESSION}/recap`,
      headers: authHeaders,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      latest: { playbook_id: string | null; transition_count: number };
      transitions: unknown[];
    };
    assert.equal(body.latest.playbook_id, null);
    assert.equal(body.latest.transition_count, 0);
    assert.equal(body.transitions.length, 0);
  });
});
