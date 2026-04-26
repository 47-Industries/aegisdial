import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { hashIdentifier, displayMask } from '../lib/enzoic.js';
import { scanIdentifier } from '../services/breachScan.js';
import { emitGuardianAlert } from '../services/guardianAlerts.js';
import { track } from '../lib/analytics.js';
import { sendEmail } from '../lib/email.js';
import { encryptString, readMaybeEncrypted } from '../lib/crypto.js';
import { normalizeE164 } from '../lib/phone.js';

// Pre-attack signal routes.
//   POST /v1/breach/monitor         add an email or phone to monitor
//   GET  /v1/breach/monitor         list monitored identifiers
//   DELETE /v1/breach/monitor/:id   stop monitoring
//   POST /v1/breach/monitor/:id/scan  trigger an immediate scan
//   GET  /v1/breach/alerts          list alerts (newest first)
//   POST /v1/breach/alerts/:id/dismiss
//   POST /v1/breach/alerts/:id/ack

const ADD_SCHEMA = z.object({
  kind: z.enum(['email', 'phone']),
  value: z.string().min(3).max(200),
});

const MAX_MONITORS_PER_USER = 10;

export async function breachRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/breach/monitor',
    {
      preHandler: [requireAppUser, requireProTier],
      // Prevents abuse: each scan hits Enzoic (paid). 30/hr/user is
      // plenty for legitimate onboarding while bounding cost + vendor QPS.
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 hour',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = ADD_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const rawValue = parsed.data.value.trim();
      // Shape validation — more useful than Zod's min(3) for actual email/phone.
      if (parsed.data.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawValue)) {
        return reply.code(400).send({ error: 'invalid_email' });
      }
      if (parsed.data.kind === 'phone' && !/^\+?\d[\d\s\-()]{6,}$/.test(rawValue)) {
        return reply.code(400).send({ error: 'invalid_phone' });
      }

      // Normalize phone identifiers to E.164 BEFORE hashing so
      // "(415) 555-1234", "+14155551234", and "415-555-1234" all collide
      // on the same value_hash and the same Enzoic query. Without this,
      // the same person re-adding the same number in a different format
      // would create a duplicate monitor + duplicate breach alerts.
      // Emails already get lowercased + trimmed inside hashIdentifier.
      let cleaned: string;
      if (parsed.data.kind === 'phone') {
        const e164 = normalizeE164(rawValue);
        if (!e164) return reply.code(400).send({ error: 'invalid_phone' });
        cleaned = e164;
      } else {
        cleaned = rawValue.toLowerCase();
      }

      // Per-user cap. Hard-block adding the 11th monitor until one is removed.
      const countRow = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM monitored_identifiers WHERE user_id = $1`,
        [user.id],
      );
      if (Number(countRow.rows[0]!.count) >= MAX_MONITORS_PER_USER) {
        return reply.code(429).send({
          error: 'monitor_cap_reached',
          limit: MAX_MONITORS_PER_USER,
          message: `You can monitor at most ${MAX_MONITORS_PER_USER} identifiers. Remove one to add another.`,
        });
      }

      const hash = hashIdentifier(cleaned);
      const display = displayMask(parsed.data.kind, cleaned);

      // display_value stores masked PII for UI fallback; display_value_ct is
      // the encrypted full value the rescan worker needs. We write both so the
      // legacy column remains non-null and the UI never sees full PII.
      //
      // ON CONFLICT DO NOTHING + RETURNING so we can detect dup: when the
      // row already exists for (user_id, kind, value_hash), RETURNING is
      // empty. Earlier behavior (DO UPDATE) masked the duplicate as a
      // successful add, which made iOS visually prepend the same row a
      // second time. 409 lets the client focus-scroll to the existing
      // monitor instead.
      const encryptedFull = encryptString(cleaned);
      const ins = await query<{ id: string; created_at: Date }>(
        `INSERT INTO monitored_identifiers (user_id, kind, value_hash, display_value, display_value_ct)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, kind, value_hash) DO NOTHING
         RETURNING id, created_at`,
        [user.id, parsed.data.kind, hash, display, encryptedFull],
      );
      if (ins.rows.length === 0) {
        const existing = await query<{ id: string }>(
          `SELECT id FROM monitored_identifiers
            WHERE user_id = $1 AND kind = $2 AND value_hash = $3`,
          [user.id, parsed.data.kind, hash],
        );
        return reply.code(409).send({
          error: 'identifier_already_monitored',
          existing_id: existing.rows[0]?.id ?? null,
        });
      }
      const id = ins.rows[0]!.id;

      // Run the first scan immediately so the user sees results on the
      // same page they just added the identifier from.
      const report = await scanIdentifier(user.id, id, parsed.data.kind, cleaned);
      const alerts = await query<AlertRow>(
        `SELECT ${ALERT_COLS} FROM breach_alerts WHERE monitored_id = $1 ORDER BY created_at DESC`,
        [id],
      );

      void track('breach_monitor_added', {
        userId: user.id,
        properties: { kind: parsed.data.kind, exposures_found: report.exposures_found },
      });

      // Guardian fan-out if this scan turned up new exposures.
      if (report.new_alerts > 0) {
        void track('breach_new_exposure', {
          userId: user.id,
          properties: { count: report.new_alerts, kind: parsed.data.kind },
        });
        void emitGuardianAlert({
          subjectUserId: user.id,
          kind: 'breach_new',
          severity: 'warning',
          title: `${report.new_alerts} new breach exposure${report.new_alerts > 1 ? 's' : ''} found`,
          body:
            `A monitored identity showed up in a newly-added breach. Scammers may try to ` +
            `use this in the next few weeks — heads up.`,
          payload: {
            monitored_id: id,
            new_alerts: report.new_alerts,
            display_value: display,
          },
        });
        // Also email the user directly.
        const email = await query<{ email: string }>(
          `SELECT email FROM users WHERE id = $1 AND email IS NOT NULL`,
          [user.id],
        );
        if (email.rows[0]?.email) {
          void sendEmail({
            userId: user.id,
            to: email.rows[0].email,
            template: 'breach_digest',
            data: {
              count: report.new_alerts,
              alerts: alerts.rows.slice(0, 5).map((a) => ({
                breach_title: a.breach_title,
                breach_date: a.breach_date?.toISOString() ?? null,
              })),
            },
          });
        }
      }

      return reply.send({
        monitored: {
          id,
          kind: parsed.data.kind,
          display_value: display,
          created_at: ins.rows[0]!.created_at.toISOString(),
          last_scanned_at: new Date().toISOString(),
          last_scan_exposure_count: report.exposures_found,
          // 'provider_disabled' here means the scan short-circuited
          // (phone monitoring against live Enzoic is off). iOS renders
          // a "coming soon" banner on these rows instead of exposures.
          status: report.status ?? 'active',
        },
        alerts: alerts.rows.map(shapeAlert),
        new_alerts: report.new_alerts,
      });
    },
  );

  app.get(
    '/v1/breach/monitor',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const rows = await query<{
        id: string;
        kind: 'email' | 'phone';
        display_value: string;
        created_at: Date;
        last_scanned_at: Date | null;
        last_scan_exposure_count: number;
        status: string | null;
      }>(
        `SELECT id, kind, display_value, created_at, last_scanned_at,
                last_scan_exposure_count, status
           FROM monitored_identifiers WHERE user_id = $1 ORDER BY created_at DESC`,
        [user.id],
      );
      return reply.send({
        items: rows.rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          display_value: displayMask(r.kind, r.display_value),
          created_at: r.created_at.toISOString(),
          last_scanned_at: r.last_scanned_at?.toISOString() ?? null,
          last_scan_exposure_count: r.last_scan_exposure_count,
          // Additive field (migration 038). Default to 'active' so
          // pre-migration rows in older envs still render correctly
          // on iOS without needing to special-case null.
          status: r.status ?? 'active',
        })),
      });
    },
  );

  app.delete(
    '/v1/breach/monitor/:id',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const res = await query(
        `DELETE FROM monitored_identifiers WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (res.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ deleted: true });
    },
  );

  app.post(
    '/v1/breach/monitor/:id/scan',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const rows = await query<{
        kind: 'email' | 'phone';
        display_value: string;
        display_value_ct: string | null;
      }>(
        `SELECT kind, display_value, display_value_ct FROM monitored_identifiers
          WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      const row = rows.rows[0];
      if (!row) return reply.code(404).send({ error: 'not_found' });
      // Prefer the encrypted column; fall back to display_value for rows
      // written before migration 018.
      const plainValue = readMaybeEncrypted(row.display_value_ct) ?? row.display_value;
      const report = await scanIdentifier(user.id, id, row.kind, plainValue);
      return reply.send(report);
    },
  );

  app.get(
    '/v1/breach/alerts',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { dismissed } = (req.query as { dismissed?: string }) ?? {};
      const includeDismissed = dismissed === 'true';
      const rows = await query<AlertRow>(
        `SELECT ${ALERT_COLS}
           FROM breach_alerts
          WHERE user_id = $1
            ${includeDismissed ? '' : 'AND dismissed_at IS NULL'}
          ORDER BY created_at DESC`,
        [user.id],
      );
      return reply.send({ alerts: rows.rows.map(shapeAlert) });
    },
  );

  app.post(
    '/v1/breach/alerts/:id/dismiss',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const res = await query(
        `UPDATE breach_alerts SET dismissed_at = NOW() WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (res.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ dismissed: true });
    },
  );

  app.post(
    '/v1/breach/alerts/:id/ack',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const res = await query(
        `UPDATE breach_alerts SET acknowledged_at = NOW() WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (res.rowCount === 0) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ acknowledged: true });
    },
  );
}

// --- helpers ---

const ALERT_COLS = `
  id, monitored_id, source, exposure_id, breach_title, breach_date,
  source_domain, data_types, entries_count, severity, description,
  created_at, dismissed_at, acknowledged_at
`;

interface AlertRow {
  id: string;
  monitored_id: string;
  source: string;
  exposure_id: string;
  breach_title: string;
  breach_date: Date | null;
  source_domain: string | null;
  data_types: string[];
  entries_count: number | null;
  severity: 'info' | 'warning' | 'critical';
  description: string | null;
  created_at: Date;
  dismissed_at: Date | null;
  acknowledged_at: Date | null;
}

function shapeAlert(row: AlertRow) {
  return {
    id: row.id,
    monitored_id: row.monitored_id,
    source: row.source,
    exposure_id: row.exposure_id,
    breach_title: row.breach_title,
    breach_date: row.breach_date?.toISOString() ?? null,
    source_domain: row.source_domain,
    data_types: row.data_types,
    entries_count: row.entries_count,
    severity: row.severity,
    description: row.description,
    created_at: row.created_at.toISOString(),
    dismissed_at: row.dismissed_at?.toISOString() ?? null,
    acknowledged_at: row.acknowledged_at?.toISOString() ?? null,
  };
}
