import { pool } from '../lib/db.js';
import { HIGH_SPOOF_TARGETS } from '../services/highSpoofTargets.js';

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
    console.log(`seeded ${HIGH_SPOOF_TARGETS.length} spoof targets`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
