import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Recovery Shield — R-P1 migration sanity test.
//
// Asserts the six migration files exist, parse-by-shape (the columns,
// CHECK vocabularies, and indexes from RECOVERY_SHIELD_ENGINEERING.md
// are present verbatim), and are idempotent (every CREATE statement
// uses IF NOT EXISTS so a re-run is a no-op).
//
// We deliberately DON'T apply these to a live database here. The full
// migrator (src/scripts/migrate.ts) is exercised in the integration
// suite. This test is the cheap-and-fast regression guard: if anyone
// edits a Recovery Shield migration and drops a column or CHECK
// vocabulary value, this fails before it reaches the live DB.

const REPO_ROOT = join(import.meta.dirname, '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'db/migrations');

const RECOVERY_MIGRATIONS = [
  '062_recovery_plus_purchases.sql',
  '063_wire_trace_cases.sql',
  '064_crypto_trace_cases.sql',
  '065_legal_documents.sql',
  '066_specialists.sql',
  '067_specialist_referrals.sql',
];

function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

describe('Recovery Shield R-P1 migrations', () => {
  describe('file existence', () => {
    for (const file of RECOVERY_MIGRATIONS) {
      it(`${file} exists`, () => {
        assert.ok(
          existsSync(join(MIGRATIONS_DIR, file)),
          `expected migration file ${file} to exist`,
        );
      });
    }
  });

  describe('idempotency — every CREATE uses IF NOT EXISTS', () => {
    for (const file of RECOVERY_MIGRATIONS) {
      it(`${file} only uses CREATE TABLE / INDEX IF NOT EXISTS`, () => {
        const sql = readMigration(file);
        // Strip line + block comments before scanning (the doc
        // header inevitably mentions CREATE in prose).
        const sqlNoComments = sql
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n');

        // Every CREATE TABLE statement must have IF NOT EXISTS.
        const creates = Array.from(
          sqlNoComments.matchAll(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi),
        );
        assert.equal(
          creates.length,
          0,
          `${file}: found CREATE TABLE without IF NOT EXISTS — re-run would error`,
        );

        // Every CREATE INDEX (including UNIQUE) must have IF NOT EXISTS.
        const indexes = Array.from(
          sqlNoComments.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi),
        );
        assert.equal(
          indexes.length,
          0,
          `${file}: found CREATE INDEX without IF NOT EXISTS — re-run would error`,
        );
      });
    }
  });

  describe('migration 062 — recovery_plus_purchases', () => {
    const sql = readMigration('062_recovery_plus_purchases.sql');

    it('declares the recovery_plus_purchases table', () => {
      assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+recovery_plus_purchases/i);
    });

    it('apple_transaction_id is UNIQUE (replay protection)', () => {
      assert.match(sql, /apple_transaction_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
    });

    it('user_id FK cascades on delete', () => {
      assert.match(sql, /user_id[^,]*REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+CASCADE/i);
    });

    it('recovery_session_id is nullable and NOT cascade-deleted', () => {
      // Match the column definition and verify it does NOT use ON DELETE CASCADE.
      const match = sql.match(/recovery_session_id\s+UUID\s+REFERENCES\s+recovery_sessions\(id\)[^,\n]*/i);
      assert.ok(match, 'recovery_session_id FK must reference recovery_sessions');
      assert.doesNotMatch(match![0], /ON\s+DELETE\s+CASCADE/i);
      assert.doesNotMatch(match![0], /NOT\s+NULL/i);
    });

    it('refunded_at column exists for entitlement-revocation', () => {
      assert.match(sql, /refunded_at\s+TIMESTAMPTZ/i);
    });

    it('idx_recovery_plus_user index is present', () => {
      assert.match(sql, /idx_recovery_plus_user[\s\S]*user_id,\s*purchased_at\s+DESC/i);
    });
  });

  describe('migration 063 — wire_trace_cases', () => {
    const sql = readMigration('063_wire_trace_cases.sql');

    it('declares the wire_trace_cases table', () => {
      assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+wire_trace_cases/i);
    });

    it('state CHECK constraint lists all 7 states verbatim', () => {
      const states = [
        'intake',
        'letter_drafted',
        'user_sent',
        'bank_acknowledged',
        'recalled',
        'denied',
        'closed',
      ];
      for (const s of states) {
        assert.match(sql, new RegExp(`'${s}'`), `wire_trace_cases.state missing '${s}'`);
      }
    });

    it('wire_amount_cents is BIGINT (commercial-wire safety)', () => {
      assert.match(sql, /wire_amount_cents\s+BIGINT\s+NOT\s+NULL/i);
    });

    it('both user_id and recovery_session_id cascade', () => {
      assert.match(sql, /user_id[^,]*REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+CASCADE/i);
      assert.match(
        sql,
        /recovery_session_id[^,]*REFERENCES\s+recovery_sessions\(id\)\s+ON\s+DELETE\s+CASCADE/i,
      );
    });

    it('both indexes present', () => {
      assert.match(sql, /idx_wire_trace_user/i);
      assert.match(sql, /idx_wire_trace_session/i);
    });
  });

  describe('migration 064 — crypto_trace_cases', () => {
    const sql = readMigration('064_crypto_trace_cases.sql');

    it('declares the crypto_trace_cases table', () => {
      assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+crypto_trace_cases/i);
    });

    it('chain CHECK lists all 9 v1 chains verbatim', () => {
      const chains = [
        'ethereum',
        'bitcoin',
        'tron',
        'polygon',
        'bsc',
        'solana',
        'arbitrum',
        'optimism',
        'base',
      ];
      for (const c of chains) {
        assert.match(sql, new RegExp(`'${c}'`), `crypto_trace_cases.chain missing '${c}'`);
      }
    });

    it('state CHECK lists all 9 states verbatim', () => {
      const states = [
        'intake',
        'tracing',
        'exchange_identified',
        'petition_drafted',
        'user_sent',
        'exchange_acked',
        'frozen',
        'denied',
        'closed',
      ];
      for (const s of states) {
        assert.match(sql, new RegExp(`'${s}'`), `crypto_trace_cases.state missing '${s}'`);
      }
    });

    it('amount_native is TEXT (decimal string, no float loss)', () => {
      assert.match(sql, /amount_native\s+TEXT\s+NOT\s+NULL/i);
    });

    it('amount_usd_cents_at_send is BIGINT', () => {
      assert.match(sql, /amount_usd_cents_at_send\s+BIGINT\s+NOT\s+NULL/i);
    });

    it('trace_report_jsonb is JSONB', () => {
      assert.match(sql, /trace_report_jsonb\s+JSONB/i);
    });
  });

  describe('migration 065 — legal_documents', () => {
    const sql = readMigration('065_legal_documents.sql');

    it('declares the legal_documents table', () => {
      assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+legal_documents/i);
    });

    it('doc_kind CHECK lists all 10 doc kinds verbatim', () => {
      const kinds = [
        'ic3_complaint',
        'ftc_complaint',
        'cfpb_complaint',
        'state_ag_complaint',
        'affidavit',
        'demand_letter',
        'credit_freeze_request',
        'police_report_draft',
        'exchange_petition',
        'insurance_claim',
      ];
      for (const k of kinds) {
        assert.match(sql, new RegExp(`'${k}'`), `legal_documents.doc_kind missing '${k}'`);
      }
    });

    it('user_acknowledged_disclaimer_at column exists (not-your-attorney enforcement)', () => {
      assert.match(sql, /user_acknowledged_disclaimer_at\s+TIMESTAMPTZ/i);
    });

    it('body_markdown is NOT NULL (envelope-encrypted body always present)', () => {
      assert.match(sql, /body_markdown\s+TEXT\s+NOT\s+NULL/i);
    });
  });

  describe('migration 066 — specialists', () => {
    const sql = readMigration('066_specialists.sql');

    it('declares the specialists table', () => {
      assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+specialists/i);
    });

    it('category CHECK lists all 5 categories verbatim', () => {
      const cats = [
        'asset_recovery_attorney',
        'blockchain_forensics',
        'identity_restoration',
        'cyber_insurance_consult',
        'tax_professional_loss_writeoff',
      ];
      for (const c of cats) {
        assert.match(sql, new RegExp(`'${c}'`), `specialists.category missing '${c}'`);
      }
    });

    it('status CHECK lists all 4 status values verbatim', () => {
      for (const s of ['pending', 'active', 'suspended', 'retired']) {
        assert.match(sql, new RegExp(`'${s}'`), `specialists.status missing '${s}'`);
      }
    });

    it('default status is pending (vetting gate)', () => {
      assert.match(sql, /status[\s\S]*DEFAULT\s+'pending'/i);
    });

    it('vetted_by uses ON DELETE SET NULL (admin delete does NOT cascade-kill specialists)', () => {
      assert.match(
        sql,
        /vetted_by[^,]*REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i,
      );
    });

    it('jurisdictions and capabilities are TEXT[]', () => {
      assert.match(sql, /jurisdictions\s+TEXT\[\]\s+NOT\s+NULL/i);
      assert.match(sql, /capabilities\s+TEXT\[\]\s+NOT\s+NULL/i);
    });

    it('commission_pct is NUMERIC(4,2)', () => {
      assert.match(sql, /commission_pct\s+NUMERIC\(4,\s*2\)/i);
    });

    it('partial idx_specialists_active filters on status = active', () => {
      assert.match(sql, /idx_specialists_active[\s\S]*WHERE\s+status\s*=\s*'active'/i);
    });
  });

  describe('migration 067 — specialist_referrals', () => {
    const sql = readMigration('067_specialist_referrals.sql');

    it('declares the specialist_referrals table', () => {
      assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+specialist_referrals/i);
    });

    it('engagement_status CHECK lists all 7 values verbatim', () => {
      const vals = [
        'referred',
        'specialist_contacted_user',
        'user_engaged',
        'case_active',
        'case_closed_won',
        'case_closed_lost',
        'user_declined',
      ];
      for (const v of vals) {
        assert.match(sql, new RegExp(`'${v}'`), `specialist_referrals.engagement_status missing '${v}'`);
      }
    });

    it('specialist_id FK is NOT cascade-deleted (fee-ledger preservation)', () => {
      const match = sql.match(/specialist_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+specialists\(id\)[^,\n]*/i);
      assert.ok(match, 'specialist_id FK must reference specialists');
      assert.doesNotMatch(match![0], /ON\s+DELETE\s+CASCADE/i);
    });

    it('user_id and recovery_session_id both cascade (right-to-be-forgotten)', () => {
      assert.match(sql, /user_id[^,]*REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+CASCADE/i);
      assert.match(
        sql,
        /recovery_session_id[^,]*REFERENCES\s+recovery_sessions\(id\)\s+ON\s+DELETE\s+CASCADE/i,
      );
    });

    it('all three indexes present', () => {
      assert.match(sql, /idx_referrals_user/i);
      assert.match(sql, /idx_referrals_specialist/i);
      assert.match(sql, /idx_referrals_session/i);
    });

    it('fee_owed_cents is BIGINT (large wire-recall commissions)', () => {
      assert.match(sql, /fee_owed_cents\s+BIGINT/i);
    });
  });

  describe('all migrations have COMMENT ON TABLE for documentation hygiene', () => {
    for (const file of RECOVERY_MIGRATIONS) {
      it(`${file} declares a COMMENT ON TABLE`, () => {
        const sql = readMigration(file);
        assert.match(sql, /COMMENT\s+ON\s+TABLE/i, `${file} missing COMMENT ON TABLE`);
      });
    }
  });
});
