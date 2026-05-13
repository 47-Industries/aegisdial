import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Identity Shield I-P1 — migration regression test.
//
// Verifies that the seven I-P1 migration files (068–074) exist,
// parse as broadly well-formed PostgreSQL, follow the project's
// idempotent-DDL conventions (CREATE TABLE IF NOT EXISTS / CREATE
// INDEX IF NOT EXISTS), and that the CHECK-constraint vocabularies
// match the engineering spec exactly.
//
// This is a regex-over-file-contents test. It DOES NOT apply the
// SQL to a live database — that's the integration runner's job, run
// in CI against a real Postgres. The point of this test is to catch
// the trivial regressions (a typo'd vocabulary token, a CREATE TABLE
// that loses IF NOT EXISTS, a migration file that gets accidentally
// renumbered) without a database dependency.

const REPO_ROOT = join(import.meta.dirname, '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'db/migrations');

interface MigrationExpectation {
  number: number;
  filename: string;
  tableName: string;
  /** CHECK-constraint vocabularies that MUST appear verbatim. */
  vocabulary: Record<string, string[]>;
  /** UNIQUE constraint columns that MUST appear (each as a regex fragment). */
  uniqueConstraints: string[];
  /** Substrings/regex fragments that must appear (additional invariants). */
  mustContain: RegExp[];
}

const EXPECTATIONS: MigrationExpectation[] = [
  {
    number: 68,
    filename: '068_identity_monitors.sql',
    tableName: 'identity_monitors',
    vocabulary: {
      monitor_kind: [
        'email',
        'phone_e164',
        'ssn_last4_hash',
        'dob_hash',
        'name_address_hash',
      ],
    },
    uniqueConstraints: [
      // SSN/DOB dedupe guarantee — adversarial-check requirement
      'user_id,\\s*monitor_kind,\\s*watched_value',
    ],
    mustContain: [
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_monitors_active/i,
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_monitors_by_kind_value/i,
    ],
  },
  {
    number: 69,
    filename: '069_identity_breaches.sql',
    tableName: 'identity_breaches',
    vocabulary: {
      source: ['hibp', 'enzoic', 'aegisdial_internal'],
    },
    uniqueConstraints: ['source,\\s*source_breach_id'],
    mustContain: [
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_breaches_recent/i,
      /pwn_count\s+BIGINT/i,
    ],
  },
  {
    number: 70,
    filename: '070_identity_breach_findings.sql',
    tableName: 'identity_breach_findings',
    vocabulary: {
      severity: ['informational', 'caution', 'critical'],
    },
    uniqueConstraints: ['user_id,\\s*monitor_id,\\s*breach_id'],
    mustContain: [
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_findings_user_new/i,
      /REFERENCES\s+identity_monitors\(id\)\s+ON\s+DELETE\s+CASCADE/i,
      /REFERENCES\s+identity_breaches\(id\)\s+ON\s+DELETE\s+CASCADE/i,
    ],
  },
  {
    number: 71,
    filename: '071_active_threats.sql',
    tableName: 'active_threats',
    vocabulary: {
      threat_kind: [
        'phone_e164',
        'email_address',
        'crypto_wallet',
        'url_host',
        'ip_address',
      ],
      severity: ['informational', 'caution', 'warning', 'confirmed_scammer'],
    },
    uniqueConstraints: ['threat_kind,\\s*threat_value,\\s*provenance'],
    mustContain: [
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_threats_by_value/i,
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_threats_recent/i,
      // Partial-index strategy is load-bearing; pin the predicate
      /WHERE\s+expires_at\s+IS\s+NULL\s+OR\s+expires_at\s*>\s*NOW\(\)/i,
    ],
  },
  {
    number: 72,
    filename: '072_threat_intel_channels.sql',
    tableName: 'threat_intel_channels',
    vocabulary: {
      source_kind: ['telegram', 'darknet_market'],
      status: ['candidate', 'active', 'dormant', 'removed', 'honeypot'],
    },
    uniqueConstraints: ['source_kind,\\s*source_handle'],
    mustContain: [
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_intel_channels_active/i,
      // Observer-only posture must be documented in the file
      /observer/i,
    ],
  },
  {
    number: 73,
    filename: '073_threat_intel_candidates.sql',
    tableName: 'threat_intel_candidates',
    vocabulary: {
      source_kind: ['telegram', 'darknet_market'],
    },
    uniqueConstraints: ['source_kind,\\s*source_handle'],
    mustContain: [
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_candidates_pending/i,
      /candidate_score\s+NUMERIC\(4,\s*3\)/i,
      /rationale\s+JSONB/i,
    ],
  },
  {
    number: 74,
    filename: '074_threat_landscape_briefings.sql',
    tableName: 'threat_landscape_briefings',
    vocabulary: {},
    uniqueConstraints: ['period_start,\\s*period_end'],
    mustContain: [
      /body_markdown\s+TEXT\s+NOT\s+NULL/i,
      /metrics_jsonb\s+JSONB\s+NOT\s+NULL/i,
    ],
  },
];

describe('Identity Shield I-P1 — migrations 068–074', () => {
  for (const exp of EXPECTATIONS) {
    describe(`migration ${exp.number} — ${exp.tableName}`, () => {
      const filePath = join(MIGRATIONS_DIR, exp.filename);

      it('file exists at the expected path', () => {
        assert.ok(
          existsSync(filePath),
          `migration ${exp.number} must live at db/migrations/${exp.filename}`,
        );
      });

      it('uses idempotent DDL (CREATE TABLE IF NOT EXISTS)', () => {
        const sql = readFileSync(filePath, 'utf8');
        const pattern = new RegExp(
          `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${exp.tableName}\\b`,
          'i',
        );
        assert.match(
          sql,
          pattern,
          `migration ${exp.number} must declare CREATE TABLE IF NOT EXISTS ${exp.tableName}`,
        );
      });

      it('every CREATE INDEX is idempotent (IF NOT EXISTS)', () => {
        const sql = readFileSync(filePath, 'utf8');
        // Strip line comments so a "-- CREATE INDEX bar" example
        // inside a doc-block doesn't false-positive.
        const stripped = sql
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n');
        const indexStatements = Array.from(
          stripped.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/gi),
        );
        for (const m of indexStatements) {
          assert.ok(
            m[2],
            `migration ${exp.number} has a CREATE INDEX without IF NOT EXISTS: "${m[0]}"`,
          );
        }
      });

      it('does NOT use CREATE INDEX CONCURRENTLY (migrator wraps in txn)', () => {
        const sql = readFileSync(filePath, 'utf8');
        const stripped = sql
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n');
        assert.doesNotMatch(
          stripped,
          /CREATE\s+INDEX\s+CONCURRENTLY/i,
          `migration ${exp.number} must not use CONCURRENTLY (migrator runs inside BEGIN/COMMIT)`,
        );
      });

      // Vocabulary tokens — each must appear verbatim inside a
      // single-quoted CHECK literal. This is the regression net for
      // a typo'd token slipping past code review.
      for (const [column, tokens] of Object.entries(exp.vocabulary)) {
        for (const token of tokens) {
          it(`CHECK vocabulary for ${column} includes '${token}'`, () => {
            const sql = readFileSync(filePath, 'utf8');
            const pattern = new RegExp(`'${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
            assert.match(
              sql,
              pattern,
              `migration ${exp.number} CHECK on ${column} must include token '${token}'`,
            );
          });
        }
      }

      for (const uq of exp.uniqueConstraints) {
        it(`declares UNIQUE (${uq.replace(/\\s\*/g, ' ').replace(/\\/g, '')})`, () => {
          const sql = readFileSync(filePath, 'utf8');
          const pattern = new RegExp(`UNIQUE\\s*\\(\\s*${uq}\\s*\\)`, 'i');
          assert.match(
            sql,
            pattern,
            `migration ${exp.number} must declare UNIQUE constraint (${uq})`,
          );
        });
      }

      for (const re of exp.mustContain) {
        it(`contains expected pattern ${re.source.slice(0, 60)}...`, () => {
          const sql = readFileSync(filePath, 'utf8');
          assert.match(sql, re);
        });
      }
    });
  }

  // Cross-file invariants.
  it('all seven I-P1 migrations are present and numbered consecutively', () => {
    const expectedNumbers = [68, 69, 70, 71, 72, 73, 74];
    for (const n of expectedNumbers) {
      const exp = EXPECTATIONS.find((e) => e.number === n);
      assert.ok(exp, `expectation missing for migration ${n}`);
      assert.ok(
        existsSync(join(MIGRATIONS_DIR, exp.filename)),
        `migration ${n} file ${exp.filename} must exist`,
      );
    }
  });

  it('idempotent re-run is a no-op (every DDL guarded by IF NOT EXISTS)', () => {
    // Re-reads each migration file and confirms that any CREATE
    // TABLE / CREATE INDEX statement carries the IF NOT EXISTS
    // guard. If a future contributor adds a CREATE INDEX without
    // the guard, applying the migration twice will fail with a
    // "relation already exists" error; this test catches the
    // regression before it lands.
    for (const exp of EXPECTATIONS) {
      const sql = readFileSync(join(MIGRATIONS_DIR, exp.filename), 'utf8');
      const stripped = sql
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
      // Every CREATE TABLE must be guarded.
      const tableMatches = Array.from(stripped.matchAll(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/gi));
      for (const m of tableMatches) {
        assert.ok(
          m[1],
          `migration ${exp.number} (${exp.filename}) has CREATE TABLE without IF NOT EXISTS`,
        );
      }
      // Every CREATE [UNIQUE] INDEX must be guarded.
      const indexMatches = Array.from(stripped.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/gi));
      for (const m of indexMatches) {
        assert.ok(
          m[2],
          `migration ${exp.number} (${exp.filename}) has CREATE INDEX without IF NOT EXISTS`,
        );
      }
    }
  });

  it('071_active_threats partial-index predicate matches the scorer hot-path filter', () => {
    // The scorer service (I-P2) issues:
    //   SELECT ... FROM active_threats
    //   WHERE threat_kind=$1 AND threat_value=$2
    //     AND (expires_at IS NULL OR expires_at > NOW())
    // The partial index idx_threats_by_value carries the same
    // (expires_at IS NULL OR expires_at > NOW()) predicate so the
    // planner can use it directly. If the partial-index predicate
    // drifts, sub-ms lookup performance collapses silently.
    const sql = readFileSync(join(MIGRATIONS_DIR, '071_active_threats.sql'), 'utf8');
    assert.match(
      sql,
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_threats_by_value[\s\S]+?WHERE\s+expires_at\s+IS\s+NULL\s+OR\s+expires_at\s*>\s*NOW\(\)/i,
      'idx_threats_by_value must carry the (expires_at IS NULL OR expires_at > NOW()) predicate',
    );
  });
});
