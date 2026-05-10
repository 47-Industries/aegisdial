import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v3 — Phase 4 (B5) family-join route tests.
//
// Covers:
//   - 404 when session_id is unknown
//   - 403 when family member is not on the same family plan as protected user
//   - 403 when family member tries to act on their own session (Mom can't be her own safety contact)
//   - happy path: /initiate-join logs event + responds 201
//   - the persisted row references the correct protected_user_id

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v3-phase4-b5';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v3-phase4-b5';
process.env.ALLOW_DEV_BEARER = 'true';
process.env.ENZOIC_MOCK = 'true';
process.env.V3_B5_ENABLED = 'true';

const Fastify = (await import('fastify')).default;
const db = await import('../src/lib/db.ts');
const { familyJoinRoutes } = await import('../src/routes/familyJoin.ts');

const SHARED_SECRET = process.env.API_SHARED_SECRET!;
const FAMILY_MEMBER_ID = '00000000-0000-0000-0000-000000000000'; // dev-bearer maps here
const PROTECTED_USER_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const FAMILY_PLAN_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

interface SafetyEventRow {
  id: string;
  session_id: string;
  family_member_user_id: string;
  protected_user_id: string;
  event_type: string;
}

const dbState = {
  sessions: new Map<string, { id: string; user_id: string }>(),
  family_members: [] as Array<{ family_plan_id: string; user_id: string }>,
  safety_events: [] as SafetyEventRow[],
  uuid_counter: 0,
};

function makeUuid(): string {
  dbState.uuid_counter += 1;
  return `${dbState.uuid_counter.toString(16).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
}

function resetDb(): void {
  dbState.sessions.clear();
  dbState.family_members.length = 0;
  dbState.safety_events.length = 0;
  dbState.uuid_counter = 0;
}

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  const t = text.trim();

  // Session ownership lookup.
  if (/SELECT user_id FROM call_sessions/i.test(t)) {
    const id = params[0] as string;
    const row = dbState.sessions.get(id);
    return { rows: row ? [{ user_id: row.user_id }] : [], rowCount: row ? 1 : 0 };
  }

  // Shared family plan check.
  if (/FROM family_members fm1[\s\S]+JOIN family_members fm2/i.test(t)) {
    const [u1, u2] = params as [string, string];
    const u1Plans = new Set(
      dbState.family_members.filter((m) => m.user_id === u1).map((m) => m.family_plan_id),
    );
    const shared = dbState.family_members.find(
      (m) => m.user_id === u2 && u1Plans.has(m.family_plan_id),
    );
    return { rows: shared ? [{ family_plan_id: shared.family_plan_id }] : [], rowCount: shared ? 1 : 0 };
  }

  // Insert safety event. event_type is a SQL literal in the route
  // (not a parameter), so we extract it from the SQL text.
  if (/^INSERT INTO b5_safety_contact_events/i.test(t)) {
    const [session_id, family_member_user_id, protected_user_id] = params as [
      string, string, string,
    ];
    const literalMatch = t.match(/'([a-z_]+)'\s*\)/i);
    const event_type = literalMatch ? literalMatch[1]! : 'unknown';
    dbState.safety_events.push({
      id: makeUuid(),
      session_id,
      family_member_user_id,
      protected_user_id,
      event_type,
    });
    return { rows: [], rowCount: 1 };
  }

  // transcript_system_events insert (from emitSystemEvent).
  if (/^INSERT INTO transcript_system_events/i.test(t)) {
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`unhandled query: ${t.slice(0, 100)}`);
};

interface FastifyAppLike {
  inject: (opts: unknown) => Promise<{ statusCode: number; body: string }>;
  ready: () => Promise<unknown>;
}

let app: FastifyAppLike;

before(async () => {
  type Patchable = { pool: { query: typeof fakeQuery } };
  (db as unknown as Patchable).pool.query = fakeQuery as unknown as typeof fakeQuery;

  const fastifyApp = Fastify({ logger: false });
  await fastifyApp.register(familyJoinRoutes);
  await fastifyApp.ready();
  app = fastifyApp as unknown as FastifyAppLike;
});

beforeEach(() => {
  resetDb();
  // Default: a session owned by PROTECTED_USER_ID and a family plan
  // shared by FAMILY_MEMBER_ID and PROTECTED_USER_ID. Tests override
  // these as needed.
  dbState.sessions.set(SESSION_ID, { id: SESSION_ID, user_id: PROTECTED_USER_ID });
  dbState.family_members.push({ family_plan_id: FAMILY_PLAN_ID, user_id: FAMILY_MEMBER_ID });
  dbState.family_members.push({ family_plan_id: FAMILY_PLAN_ID, user_id: PROTECTED_USER_ID });
});

const authHeaders = { authorization: `Bearer ${SHARED_SECRET}` };

describe('B5 — POST /v1/family/initiate-join', () => {
  it('returns 404 when session_id is unknown', async () => {
    dbState.sessions.clear();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/family/initiate-join',
      headers: authHeaders,
      payload: { session_id: SESSION_ID },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 403 when family member and protected user are not on the same plan', async () => {
    dbState.family_members.length = 0; // remove the sharing
    const res = await app.inject({
      method: 'POST',
      url: '/v1/family/initiate-join',
      headers: authHeaders,
      payload: { session_id: SESSION_ID },
    });
    assert.equal(res.statusCode, 403);
  });

  it('returns 403 when the requester is the same person as the protected user', async () => {
    // Make Mom the session owner AND the requester.
    dbState.sessions.set(SESSION_ID, { id: SESSION_ID, user_id: FAMILY_MEMBER_ID });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/family/initiate-join',
      headers: authHeaders,
      payload: { session_id: SESSION_ID },
    });
    assert.equal(res.statusCode, 403);
  });

  it('happy path — logs event + returns 201 with protected_user_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/family/initiate-join',
      headers: authHeaders,
      payload: { session_id: SESSION_ID },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.session_id, SESSION_ID);
    assert.equal(body.protected_user_id, PROTECTED_USER_ID);

    // Persisted row points at the right protected user.
    assert.equal(dbState.safety_events.length, 1);
    assert.equal(dbState.safety_events[0]!.event_type, 'initiating');
    assert.equal(dbState.safety_events[0]!.protected_user_id, PROTECTED_USER_ID);
    assert.equal(dbState.safety_events[0]!.family_member_user_id, FAMILY_MEMBER_ID);
  });
});

describe('B5 — POST /v1/family/join-completed', () => {
  it('happy path — records joined event after authorization', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/family/join-completed',
      headers: authHeaders,
      payload: { session_id: SESSION_ID },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(dbState.safety_events[0]!.event_type, 'joined');
  });
});

describe('B5 — POST /v1/family/safety-contact-left', () => {
  it('happy path — records left event with optional duration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/family/safety-contact-left',
      headers: authHeaders,
      payload: { session_id: SESSION_ID, duration_seconds: 47 },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(dbState.safety_events[0]!.event_type, 'left');
  });
});
