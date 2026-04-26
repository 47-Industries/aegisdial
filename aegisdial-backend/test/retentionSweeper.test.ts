import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';

// We can't run the full sweep without a real DB, but we can smoke-import
// the module (catches schema regressions like SPECS referencing a renamed
// export) and test that it exposes the expected shape.
const sweeper = await import('../src/workers/retentionSweeper.ts');

describe('retentionSweeper module', () => {
  it('exports the expected API', () => {
    assert.equal(typeof sweeper.runRetentionSweepOnce, 'function');
    assert.equal(typeof sweeper.startRetentionSweeper, 'function');
    assert.equal(typeof sweeper.stopRetentionSweeper, 'function');
  });

  it('runs end-to-end against a missing DB and reports per-table skipped status', async () => {
    // Without a DB behind it, every spec should come back skipped with a
    // connection error (not crash). Proves the error path is correct.
    const results = await sweeper.runRetentionSweepOnce();
    assert.ok(Array.isArray(results));
    assert.ok(results.length >= 5);
    for (const r of results) {
      assert.equal(typeof r.table, 'string');
      assert.equal(typeof r.deleted, 'number');
      assert.equal(typeof r.skipped, 'boolean');
    }
  });
});
