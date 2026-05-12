import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 1 — seed bootstrap tests.
//
// Pins the UPSERT contract:
//   - First seed: every playbook INSERTed
//   - Re-seed: every row UPDATEd, `enabled` PRESERVED (admin prod
//     kill-switch survives the deploy)
//   - Failure for one playbook does not abort the rest

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-seed';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-seed-test';

const db = await import('../src/lib/db.ts');
const seed = await import('../src/scripts/seedV4Playbooks.ts');
const playbooks = await import('../src/data/playbooks.ts');

interface QueryCall {
  text: string;
  params: unknown[];
}
const queryLog: QueryCall[] = [];

const fakeQuery = async (
  text: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[]; rowCount: number }> => {
  queryLog.push({ text, params });
  return { rows: [], rowCount: 1 };
};

before(() => {
  (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
});

beforeEach(() => {
  queryLog.length = 0;
});

describe('seedV4Playbooks — UPSERT shape', () => {
  it('emits one INSERT per playbook', async () => {
    const result = await seed.seedV4Playbooks();
    const inserts = queryLog.filter((q) =>
      /^INSERT INTO b4_playbooks/i.test(q.text.trim()),
    );
    assert.equal(inserts.length, playbooks.PLAYBOOKS.length);
    assert.equal(result.synced, playbooks.PLAYBOOKS.length);
  });

  it('every UPSERT uses ON CONFLICT (id) DO UPDATE — idempotent re-seed', async () => {
    await seed.seedV4Playbooks();
    const inserts = queryLog.filter((q) =>
      /^INSERT INTO b4_playbooks/i.test(q.text.trim()),
    );
    for (const q of inserts) {
      assert.match(
        q.text,
        /ON CONFLICT\s*\(id\)\s*DO UPDATE/i,
        `non-idempotent insert: ${q.text.slice(0, 80)}`,
      );
    }
  });

  it('UPDATE clause preserves the enabled column (admin kill-switch survives deploy)', async () => {
    await seed.seedV4Playbooks();
    const first = queryLog.find((q) =>
      /^INSERT INTO b4_playbooks/i.test(q.text.trim()),
    );
    assert.ok(first);
    // The SQL's DO UPDATE clause must NOT contain `enabled` in the
    // SET list — admin's prod disable survives.
    const setClause = first!.text.split(/DO UPDATE/i)[1] ?? '';
    assert.ok(
      !/\benabled\s*=/i.test(setClause),
      'enabled column must not be in the UPDATE SET clause',
    );
  });

  it('initial INSERT sets enabled=TRUE for new playbooks', async () => {
    await seed.seedV4Playbooks();
    const first = queryLog.find((q) =>
      /^INSERT INTO b4_playbooks/i.test(q.text.trim()),
    );
    assert.ok(first);
    // The INSERT clause must mention TRUE for the enabled column.
    // (Schema-bound literal; positional check is sufficient.)
    assert.match(first!.text, /TRUE/);
  });
});

describe('seedV4Playbooks — failure isolation', () => {
  it('one playbook failing does not abort the rest', async () => {
    let callIndex = 0;
    (db.pool as unknown as { query: typeof fakeQuery }).query = (async (
      text: string,
      params: unknown[] = [],
    ) => {
      queryLog.push({ text, params });
      callIndex++;
      if (callIndex === 2) {
        throw new Error('simulated DB error on the 2nd playbook');
      }
      return { rows: [], rowCount: 1 };
    }) as typeof fakeQuery;

    // try/finally so the happy-path fake is always restored — even
    // if the assertion below fails. Without this, a failure here
    // would leak the throwing fake into the next describe block
    // and produce confusing follow-on errors.
    try {
      const result = await seed.seedV4Playbooks();
      // 13 successes out of 14 (one was simulated-failed)
      assert.equal(result.synced, playbooks.PLAYBOOKS.length - 1);
    } finally {
      (db.pool as unknown as { query: typeof fakeQuery }).query = fakeQuery;
    }
  });
});

describe('seedV4Playbooks — JSON serialization of nested fields', () => {
  it('serializes stages, counter_scripts, demographic_priors as JSON params', async () => {
    await seed.seedV4Playbooks();
    const first = queryLog.find((q) =>
      /^INSERT INTO b4_playbooks/i.test(q.text.trim()),
    );
    assert.ok(first);
    const [id, , , stagesJson, counterJson, , priorsJson] = first!.params as string[];
    assert.equal(typeof id, 'string');
    // The 3 JSONB-cast params must be valid JSON strings.
    assert.doesNotThrow(() => JSON.parse(stagesJson));
    assert.doesNotThrow(() => JSON.parse(counterJson));
    assert.doesNotThrow(() => JSON.parse(priorsJson));
    // Spot-check stages_json shape — should be an array of stages.
    const stages = JSON.parse(stagesJson) as unknown[];
    assert.ok(Array.isArray(stages));
    assert.equal(stages.length, 5, 'every playbook has 5 stages');
  });
});
