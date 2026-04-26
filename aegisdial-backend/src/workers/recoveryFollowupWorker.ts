import cron from 'node-cron';
import { query } from '../lib/db.js';
import { sendEmail } from '../lib/email.js';
import { captureError, emitMetric } from '../lib/observability.js';
import { decryptInt } from '../lib/crypto.js';

// Recovery follow-up cadence. Five touchpoints after a session starts:
//   - T+24h: "Have you completed these 4 steps?" nudge
//   - T+3d:  check-in on credit freezes + bank calls
//   - T+7d:  outcome ask + emotional check-in (only if no outcome row)
//   - T+30d: outcome check-in (only if an outcome row DOES exist) —
//            references recovered_any / recovered_cents from that row
//   - T+90d: long-tail check-in — fires regardless of outcome state, so
//            we can warn about scammer re-targeting (FBI IC3: 41%
//            re-target rate in 6 months) and surface 988 / AARP
//            fraud helpline one last time
//
// Each email fires once per session. Columns on recovery_sessions
// (followup_{24h,3d,7d,30d,90d}_sent_at) gate the selection so we never
// double-send. 30d/90d columns arrive in migration 037.
//
// Cron: every 30 minutes. Misses are fine — a stuck clock just delays
// by 30 minutes, not catastrophic.

const CRON_EXPR = '*/30 * * * *';

export interface FollowupHandle {
  task: cron.ScheduledTask;
}

type Bucket = '24h' | '3d' | '7d' | '30d' | '90d';
type SentColumn =
  | 'followup_24h_sent_at'
  | 'followup_3d_sent_at'
  | 'followup_7d_sent_at'
  | 'followup_30d_sent_at'
  | 'followup_90d_sent_at';

interface Row {
  id: string;
  user_id: string;
  email: string | null;
  display_name: string | null;
  scam_type: string | null;
  // Only populated for the 30d bucket (JOINed from recovery_outcomes).
  recovered_any: boolean | null;
  recovered_cents: number | null;
  recovered_cents_ct: string | null;
}

async function sendFor(
  bucket: Bucket,
  interval: string,
  column: SentColumn,
): Promise<{ processed: number; sent: number }> {
  // Per-bucket outcome gating:
  //   - 7d  : skip if outcome row exists (don't re-ask "how'd it go?"
  //           if the user already answered)
  //   - 30d : skip UNLESS outcome row exists (this email IS the
  //           follow-up TO the outcome; no outcome = nothing to anchor)
  //   - 24h / 3d / 90d : no outcome gating
  //
  // `column` is interpolated (Postgres doesn't parameterize identifiers)
  // but the TypeScript union constrains it to the five allowed names.
  // `interval` is parameterized via $1::INTERVAL.
  let outcomeJoin = '';
  let outcomeWhere = '';
  if (bucket === '7d') {
    outcomeWhere = `AND NOT EXISTS (SELECT 1 FROM recovery_outcomes ro WHERE ro.session_id = rs.id)`;
  } else if (bucket === '30d') {
    // LEFT JOIN → INNER JOIN effect via the WHERE clause. We do a LEFT
    // JOIN so the amount/recovered columns are selectable; the EXISTS
    // check forces the row to have an outcome. (A plain INNER JOIN
    // would work too, but this keeps the SQL structure parallel to the
    // other buckets.)
    outcomeJoin = `LEFT JOIN recovery_outcomes ro ON ro.session_id = rs.id`;
    outcomeWhere = `AND ro.session_id IS NOT NULL`;
  }
  // 90d: intentionally no outcome gating. Per spec we would also check
  // `users.email_preferences` here, but no such column exists on the
  // users table in any migration as of this change — the spec says
  // "if no such column exists, don't block; assume opted in", so we
  // just send. If a future migration adds that column, extend the
  // WHERE clause with an opt-out check.
  const selectExtra =
    bucket === '30d'
      ? ', ro.recovered_any, ro.recovered_cents, ro.recovered_cents_ct'
      : ', NULL::BOOLEAN AS recovered_any, NULL::INT AS recovered_cents, NULL::TEXT AS recovered_cents_ct';

  const rows = await query<Row>(
    `SELECT rs.id, rs.user_id, u.email, u.display_name, rs.scam_type
            ${selectExtra}
       FROM recovery_sessions rs
       JOIN users u ON u.id = rs.user_id
       ${outcomeJoin}
      WHERE rs.${column} IS NULL
        AND rs.started_at < NOW() - $1::INTERVAL
        AND rs.status IN ('active','completed')
        AND u.email IS NOT NULL
        ${outcomeWhere}
      ORDER BY rs.started_at ASC
      LIMIT 200`,
    [interval],
  );

  let sent = 0;
  for (const r of rows.rows) {
    try {
      // Build the template payload. 30d is the only bucket that
      // actually uses the outcome fields — every other bucket passes
      // just the common set. We decrypt recovered_cents via the same
      // `decryptInt` / ct-fallback pattern used in routes/recovery.ts
      // and workers/bulkCrimeReporter.ts so encrypted and legacy
      // plaintext rows both work.
      const data: Record<string, unknown> = {
        display_name: r.display_name,
        bucket,
        scam_type: r.scam_type ?? 'generic',
      };
      if (bucket === '30d') {
        const recoveredCents =
          decryptInt(r.recovered_cents_ct ?? null) ?? r.recovered_cents ?? null;
        data.recovered_any = r.recovered_any;
        data.recovered_cents = recoveredCents;
      }
      await sendEmail({
        userId: r.user_id,
        to: r.email!,
        template: 'recovery_followup',
        data,
      });
      await query(
        `UPDATE recovery_sessions SET ${column} = NOW() WHERE id = $1`,
        [r.id],
      );
      sent++;
    } catch (err) {
      captureError(err, {
        component: 'recoveryFollowupWorker',
        bucket,
        session_id: r.id,
      });
    }
  }
  return { processed: rows.rows.length, sent };
}

export async function runFollowupOnce(): Promise<{
  bucket_24h: { processed: number; sent: number };
  bucket_3d:  { processed: number; sent: number };
  bucket_7d:  { processed: number; sent: number };
  bucket_30d: { processed: number; sent: number };
  bucket_90d: { processed: number; sent: number };
}> {
  // Buckets read disjoint rows (different `followup_*_sent_at` columns),
  // so running them in parallel cuts wall-clock by ~5x with no write
  // conflicts. 30d and 90d join extra tables but the predicate filters
  // to a tiny set of rows (sessions older than 30 / 90 days), so the
  // extra query cost is negligible.
  const [b24, b3d, b7d, b30d, b90d] = await Promise.all([
    sendFor('24h', '24 hours', 'followup_24h_sent_at'),
    sendFor('3d',  '3 days',   'followup_3d_sent_at'),
    sendFor('7d',  '7 days',   'followup_7d_sent_at'),
    sendFor('30d', '30 days',  'followup_30d_sent_at'),
    sendFor('90d', '90 days',  'followup_90d_sent_at'),
  ]);
  if (b24.sent + b3d.sent + b7d.sent + b30d.sent + b90d.sent > 0) {
    void emitMetric('recovery.followup_sent', { bucket: '24h' }, b24.sent);
    void emitMetric('recovery.followup_sent', { bucket: '3d'  }, b3d.sent);
    void emitMetric('recovery.followup_sent', { bucket: '7d'  }, b7d.sent);
    void emitMetric('recovery.followup_sent', { bucket: '30d' }, b30d.sent);
    void emitMetric('recovery.followup_sent', { bucket: '90d' }, b90d.sent);
  }
  return {
    bucket_24h: b24,
    bucket_3d: b3d,
    bucket_7d: b7d,
    bucket_30d: b30d,
    bucket_90d: b90d,
  };
}

export function startRecoveryFollowup(): FollowupHandle {
  const task = cron.schedule(
    CRON_EXPR,
    () => { void runFollowupOnce(); },
    { timezone: 'UTC' },
  );
  return { task };
}

export function stopRecoveryFollowup(handle: FollowupHandle): void {
  handle.task.stop();
}
