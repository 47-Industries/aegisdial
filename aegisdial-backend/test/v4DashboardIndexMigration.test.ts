import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Live Shield v4 — Phase 21 — pin the partial-index predicate to the
// live emit sites. The migration 053_v4_dashboard_indexes creates a
// partial index covering exactly the metric names the v4 admin
// dashboards (Phases 11/12/13/14/17) read. If anyone renames one of
// those metrics without updating the index predicate, the index
// silently goes stale — queries for the renamed metric fall back to
// the broader idx_metric_counters_name_bucket and the operator
// notices a latency regression in prod.
//
// This test reads both the migration SQL and the SQL fetcher modules
// to verify they agree on the metric names. Cheap defense, prevents
// the silent-stale-index footgun.

const REPO_ROOT = join(import.meta.dirname, '..');
const MIGRATION_FILE = join(REPO_ROOT, 'db/migrations/053_v4_dashboard_indexes.sql');

// If you add a new v4 dashboard fetcher (src/services/v4*Summary.ts),
// add its metric name to this list AND to the WHERE clause in
// db/migrations/053_v4_dashboard_indexes.sql. The glob-discovery test
// below will fail until both are updated — that's the L-4 safety net.
const EXPECTED_METRIC_NAMES = [
  'v4.stage_timing.evaluated',
  'v4.b4.claim_extracted_vs_playbook',
  'v4.classifier.classified',
  'v3.sentinel_matcher.fired',
];

describe('migration 053 — v4 dashboard partial index', () => {
  it('migration file exists and contains the expected CREATE INDEX statement', () => {
    const sql = readFileSync(MIGRATION_FILE, 'utf8');
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_metric_counters_v4_dashboard/i);
    assert.match(sql, /ON metric_counters \(name, bucket DESC\)/i);
    assert.match(sql, /WHERE name IN \(/i);
  });

  it('partial index predicate lists every expected v4 dashboard metric name', () => {
    const sql = readFileSync(MIGRATION_FILE, 'utf8');
    for (const name of EXPECTED_METRIC_NAMES) {
      assert.match(
        sql,
        new RegExp(`'${name.replace(/\./g, '\\.')}'`),
        `migration 053 must reference '${name}' in the partial-index predicate`,
      );
    }
  });

  it('every src/services/v4*Summary.ts fetcher queries an indexed metric name (L-4 glob defense)', () => {
    // Glob-based discovery — picks up new fetchers automatically.
    // If someone adds v4FooSummary.ts that queries name='v4.foo' and
    // forgets to update both EXPECTED_METRIC_NAMES + migration 053,
    // this test fails with a precise file:metric message.
    const servicesDir = join(REPO_ROOT, 'src/services');
    const fetcherFiles = readdirSync(servicesDir).filter(
      (f) => /^v4.*Summary\.ts$/.test(f) && !f.includes('Scorecard'),
    );
    assert.ok(fetcherFiles.length >= 4, `expected ≥4 v4 summary fetchers, found ${fetcherFiles.length}`);
    for (const file of fetcherFiles) {
      const content = readFileSync(join(servicesDir, file), 'utf8');
      // Find every literal `name = 'X'` clause in the file. If any
      // clause references a metric not in EXPECTED_METRIC_NAMES, the
      // partial index in migration 053 does not cover it.
      const nameClauses = Array.from(content.matchAll(/name\s*=\s*'([^']+)'/g)).map((m) => m[1]!);
      for (const n of nameClauses) {
        assert.ok(
          EXPECTED_METRIC_NAMES.includes(n),
          `fetcher src/services/${file} queries name='${n}' but it is NOT in migration 053's partial-index predicate — add it to both`,
        );
      }
    }
  });

  it('migration uses plain CREATE INDEX (not CONCURRENTLY — migrator wraps in transaction)', () => {
    const sql = readFileSync(MIGRATION_FILE, 'utf8');
    // The migrator (src/scripts/migrate.ts) wraps each file in
    // BEGIN/COMMIT. CONCURRENTLY can't run inside a transaction;
    // the migration would error mid-run. Pin the plain-CREATE
    // choice with a regression test so a future "let's make this
    // concurrent" edit doesn't break apply.
    //
    // Strip BOTH line- and block-comments before checking. L-5
    // adversarial fix: a future contributor using /* */ for the
    // rationale could otherwise false-positive past a real
    // CONCURRENTLY in a comment.
    const sqlWithoutComments = sql
      .replace(/\/\*[\s\S]*?\*\//g, '') // strip block comments first
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    assert.doesNotMatch(sqlWithoutComments, /CREATE INDEX CONCURRENTLY/i);
  });
});
