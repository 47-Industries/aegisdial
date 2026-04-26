import path from 'node:path';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../.pgdata');
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');
const PG_PORT = 54329;
const PG_USER = 'aegis';
const PG_PASS = 'aegis';
const PG_DB = 'aegisdial';

process.env.DATABASE_URL = `postgres://${PG_USER}:${PG_PASS}@localhost:${PG_PORT}/${PG_DB}`;
process.env.REDIS_URL = process.env.REDIS_URL ?? 'memory://local';
process.env.API_SHARED_SECRET = process.env.API_SHARED_SECRET ?? 'devsecret123';
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

async function runMigrations(): Promise<void> {
  const { pool } = await import('../lib/db.js');
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const applied = await client.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    const appliedSet = new Set(applied.rows.map((r) => r.version));
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (appliedSet.has(version)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`→ migrating ${version}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

async function runSeed(): Promise<void> {
  const { pool } = await import('../lib/db.js');
  const { HIGH_SPOOF_TARGETS } = await import('../services/highSpoofTargets.js');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Dev user (the zero-UUID) — auth.ts falls back to this when the
    // dev shared secret is presented. FK-dependent tables (call_sessions,
    // recovery_sessions, etc.) need it to exist.
    await client.query(
      `INSERT INTO users (id, auth_method, email)
       VALUES ('00000000-0000-0000-0000-000000000000', 'apple', 'dev@aegisdial.local')
       ON CONFLICT (id) DO NOTHING`,
    );
    for (const t of HIGH_SPOOF_TARGETS) {
      await client.query(
        `INSERT INTO spoof_targets (name, category, verified_numbers, spoof_message)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [t.name, t.category, t.verified_numbers, t.spoof_message],
      );
      for (const num of t.verified_numbers) {
        await client.query(
          `INSERT INTO numbers (e164, business_match, stir_shaken_attestation, line_type)
           VALUES ($1, $2, 'A', 'toll_free')
           ON CONFLICT (e164) DO UPDATE SET business_match = EXCLUDED.business_match`,
          [
            num,
            JSON.stringify({
              name: t.name,
              category: t.category,
              verified: true,
              source: 'high_spoof_targets_registry',
            }),
          ],
        );
      }
    }
    await client.query('COMMIT');
    console.log(`✓ seeded ${HIGH_SPOOF_TARGETS.length} spoof targets`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: PG_USER,
    password: PG_PASS,
    port: PG_PORT,
    persistent: true,
  });

  // initdb fatally errors on an existing cluster. Only call initialise()
  // when PG_VERSION is absent. Without this guard, embedded-postgres bails
  // with "Postgres init script exited with code 1" on every subsequent run.
  const { stat } = await import('node:fs/promises');
  const hasCluster = await stat(path.join(DATA_DIR, 'PG_VERSION')).then(() => true).catch(() => false);
  if (!hasCluster) {
    try {
      await pg.initialise();
    } catch (err) {
      const msg = (err as Error).message;
      if (!/already|exists|PG_VERSION/i.test(msg)) throw err;
    }
  }

  await pg.start();

  try {
    await pg.createDatabase(PG_DB);
  } catch (err) {
    const msg = (err as Error).message;
    if (!/already exists/i.test(msg)) throw err;
  }

  console.log(`✓ embedded postgres up on port ${PG_PORT}`);

  await runMigrations();
  await runSeed();

  console.log('→ starting server...');
  await import('../server.js');

  const stop = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, stopping postgres...`);
    try {
      await pg.stop();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
