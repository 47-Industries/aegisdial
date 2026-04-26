import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

async function run(): Promise<void> {
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
      if (appliedSet.has(version)) {
        console.log(`✓ already applied: ${version}`);
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`→ applying ${version}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (version) VALUES ($1)`,
          [version],
        );
        await client.query('COMMIT');
        console.log(`✓ applied ${version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`✗ failed ${version}`, err);
        throw err;
      }
    }
    console.log('migrations complete');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
