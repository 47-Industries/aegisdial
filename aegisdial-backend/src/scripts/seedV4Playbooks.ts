import { query } from '../lib/db.js';
import { emitMetric } from '../lib/observability.js';
import { PLAYBOOKS } from '../data/playbooks.js';

// Live Shield v4 — Phase 1 — b4_playbooks seed bootstrap.
//
// `src/data/playbooks.ts` is the canonical source of truth for the
// playbook library. `b4_playbooks` is the runtime mirror — admin
// can hot-tune (e.g. disable a misbehaving playbook in prod via a
// direct UPDATE) without redeploying.
//
// This script syncs the canonical → runtime direction at server
// boot. It's an UPSERT keyed by playbook id: existing rows get
// their non-admin fields updated to the canonical version; the
// admin-tuned `enabled` flag is PRESERVED so prod kill-switches
// survive deploys.
//
// Idempotent: re-running this against an already-populated table
// is safe and cheap (one UPSERT per playbook, no row count or
// behavior change beyond writing the canonical stages_json /
// counter_scripts / demographic_priors back into the table).
//
// Failure mode: a DB error here is logged + counted but does NOT
// crash the boot. Worst case: the table has stale playbook
// content from the prior deploy; the classifier still works
// because PLAYBOOKS in code is the source of truth. The b4_playbooks
// table exists for admin tools + future runtime-tuning paths, not
// for the classifier's hot path.

/**
 * UPSERT every playbook in PLAYBOOKS into b4_playbooks. Returns
 * how many rows were inserted-or-updated for telemetry. Designed
 * to be called once at server boot.
 *
 * Preserves the `enabled` column on existing rows — admin's prod
 * disable survives the redeploy that runs this script.
 */
export async function seedV4Playbooks(): Promise<{ synced: number }> {
  let synced = 0;
  for (const p of PLAYBOOKS) {
    try {
      const res = await query(
        `INSERT INTO b4_playbooks
           (id, display_name, description, stages_json, counter_scripts,
            recovery_steps_link, demographic_priors, enabled,
            schema_version, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb,
                 TRUE, 1, NOW())
         ON CONFLICT (id) DO UPDATE
           SET display_name        = EXCLUDED.display_name,
               description         = EXCLUDED.description,
               stages_json         = EXCLUDED.stages_json,
               counter_scripts     = EXCLUDED.counter_scripts,
               recovery_steps_link = EXCLUDED.recovery_steps_link,
               demographic_priors  = EXCLUDED.demographic_priors,
               -- DO NOT touch enabled column — admin prod kill switch
               -- survives the deploy.
               schema_version      = EXCLUDED.schema_version,
               updated_at          = NOW()`,
        [
          p.id,
          p.display_name,
          p.description,
          JSON.stringify(p.stages),
          JSON.stringify(p.counter_scripts),
          p.recovery_steps_link,
          JSON.stringify(p.demographic_priors),
        ],
      );
      if (res.rowCount && res.rowCount > 0) synced++;
    } catch (err) {
      emitMetric('v4.seed.playbook_failed', { playbook_id: p.id });
      // M3 adversarial fix: a fresh deploy may boot the app before
      // migrations land (migrations run via `npm run migrate`,
      // separate from app boot). The classic shape of that race
      // is `relation "b4_playbooks" does not exist` from Postgres.
      // Downgrade that specific case to console.warn — the table
      // will exist on the NEXT boot after the deploy completes,
      // and the classifier reads PLAYBOOKS from code (not DB), so
      // a missing mirror doesn't break runtime. Any OTHER error is
      // a real bug worth the louder console.error.
      const msg = err instanceof Error ? err.message : String(err);
      if (/relation .* does not exist/i.test(msg)) {
        // eslint-disable-next-line no-console
        console.warn('[seedV4Playbooks] skipping — migration 051 not yet run');
        // First failure of this kind aborts the loop — every
        // subsequent playbook would hit the same error.
        return { synced };
      }
      // eslint-disable-next-line no-console
      console.error('[seedV4Playbooks] failed for', p.id, err);
    }
  }
  emitMetric('v4.seed.playbooks_synced', { count: String(synced) });
  return { synced };
}
