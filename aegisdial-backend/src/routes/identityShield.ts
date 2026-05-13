import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { query } from '../lib/db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { emitMetric, captureError } from '../lib/observability.js';

// Identity Shield — /v1/identity-shield/* routes. iOS-facing surface.
//
// Pro-gated end-to-end (requireProTier after requireAppUser). The
// I-P4 contract from IDENTITY_SHIELD_ENGINEERING.md:
//
//   GET    /v1/identity-shield/monitors                   list user's monitors
//   POST   /v1/identity-shield/monitors                   add a monitor
//   DELETE /v1/identity-shield/monitors/:id               soft-delete via active=false
//   GET    /v1/identity-shield/findings                   filterable breach findings
//   POST   /v1/identity-shield/findings/:id/acknowledge   mark seen
//   POST   /v1/identity-shield/findings/:id/remediate     mark remediation complete
//   GET    /v1/identity-shield/threats/near               aggregate active-threats count
//   GET    /v1/identity-shield/digest/preview             what today's digest would say
//
// PRIVACY INVARIANT (read once, then enforce in code):
//   SSN-last-4, DOB, and name+address ARE NEVER PERSISTED IN PLAINTEXT
//   AT ANY TIER. Plaintext arrives ONLY in the POST /monitors body
//   (HTTPS-encrypted in transit), is hashed inside this route with a
//   per-user salt, and the plaintext is discarded before the INSERT.
//   The persisted column carries sha256(salt || tag || normalized_value)
//   hex. The salt is per (user_id, monitor_kind) — generated lazily on
//   first hash insert and reused for subsequent hash kinds so duplicate
//   detection works via the UNIQUE (user_id, monitor_kind, watched_value)
//   constraint. The salt and the hash NEVER appear in responses.
//
// CROSS-USER SAFETY:
//   Every route's WHERE clause pins user_id = req.appUser.id. Cross-user
//   id attempts return 404 (same shape as other Pro routes — never 403,
//   to avoid leaking the existence of someone else's row).
//
// RATE LIMITS (mirror emailShield.ts pattern):
//   GET    routes: 60/min per user
//   POST   routes: 30/min per user
//   DELETE routes: 30/min per user
//   Keyed by user_id (via userKeyedLimit) so shared-IP users don't
//   share quota.
//
// THE actual server.ts registration is deferred to I-P9 (final
// wiring); this file exports identityShieldRoutes as a
// FastifyPluginAsync ready to plug in.

// ---- Zod schemas ----------------------------------------------------

// Five-kind discriminated union — exactly the migration-068 vocabulary.
// Phone uses E.164 regex (matches lib/phone.normalizeE164 output).
// SSN-last-4 is the four-digit suffix only (we never accept the full
// nine digits — full SSN is out of scope for this product surface).
// DOB is ISO date (YYYY-MM-DD).
// Name+address is composite (full name + 5-digit ZIP) — composite-PII
// match for darknet listings.
const MonitorAddSchema = z.discriminatedUnion('monitor_kind', [
  z.object({
    monitor_kind: z.literal('email'),
    value: z.string().email().max(254),
  }),
  z.object({
    monitor_kind: z.literal('phone_e164'),
    value: z.string().regex(/^\+[1-9]\d{6,14}$/),
  }),
  z.object({
    monitor_kind: z.literal('ssn_last4_hash'),
    ssn_last4: z.string().regex(/^\d{4}$/),
  }),
  z.object({
    monitor_kind: z.literal('dob_hash'),
    dob_iso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.object({
    monitor_kind: z.literal('name_address_hash'),
    full_name: z.string().min(1).max(120),
    zip5: z.string().regex(/^\d{5}$/),
  }),
]);

const FindingListQuerySchema = z.object({
  severity: z.enum(['informational', 'caution', 'critical', 'all']).optional(),
  acknowledged: z.enum(['true', 'false', 'all']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const ThreatsNearQuerySchema = z.object({
  // ISO-3166 alpha-2. The geo_tag column on active_threats is the same
  // vocabulary; the dashboard counter mirrors what the user sees.
  geo_tag: z.string().regex(/^[A-Z]{2}$/).optional(),
});

// ---- userKeyedLimit (mirror emailShield.ts) -------------------------
//
// Pin to preHandler so the limiter runs AFTER requireAppUser populates
// req.appUser — otherwise the keyGenerator silently falls through to
// the IP-keyed fallback (adversarial-review H1 fix, documented in
// emailShield.ts).
const userKeyedLimit = {
  hook: 'preHandler' as const,
  keyGenerator: (req: FastifyRequest) =>
    req.appUser?.id ? `user:${req.appUser.id}` : `ip:${req.ip}`,
};

// ---- Hash helpers ---------------------------------------------------
//
// Per-user salt cached at the (user_id, monitor_kind) granularity. The
// migration COMMENT pins this — same SSN added in different years (with
// salt rotated) STILL collides via the UNIQUE on (user_id, kind,
// watched_value) because the salt rotation re-derives the hash row.
// At INSERT time we look up the existing salt for this user × kind;
// if there's no row yet, we generate a fresh 32-byte hex salt.
//
// Tag bytes ('ssn4', 'dob', 'na') are mixed into the hashed payload
// so an attacker who somehow gets a SSN-shaped hash can't replay it
// against the DOB column.

/**
 * Look up an existing salt for (user_id, monitor_kind), or generate
 * a fresh one. Returns the hex-encoded salt (64 chars = 32 bytes).
 *
 * The lookup query restricts to active rows so a salt orphaned by a
 * soft-delete doesn't get reused (would prevent the user from
 * re-adding a monitor under a fresh salt rotation if they wanted).
 */
async function resolveUserSalt(
  userId: string,
  monitorKind: 'ssn_last4_hash' | 'dob_hash' | 'name_address_hash',
): Promise<string> {
  const res = await query<{ salt_hex: string }>(
    `SELECT salt_hex
       FROM identity_monitors
      WHERE user_id = $1 AND monitor_kind = $2 AND active AND salt_hex IS NOT NULL
      LIMIT 1`,
    [userId, monitorKind],
  );
  if ((res.rowCount ?? 0) > 0 && res.rows[0]!.salt_hex) {
    return res.rows[0]!.salt_hex;
  }
  return randomBytes(32).toString('hex');
}

/**
 * Hash a plaintext PII value with the per-user salt + a kind-specific
 * tag. The tag is intentionally short and stable; the user salt is the
 * entropy. Output is hex sha256.
 *
 * Plaintext input MUST NEVER be logged, returned to the client, or
 * persisted. The caller is responsible for discarding it as soon as
 * this function returns.
 */
function hashWithSalt(saltHex: string, tag: 'ssn4' | 'dob' | 'na', plaintext: string): string {
  return createHash('sha256').update(saltHex).update(tag).update(plaintext).digest('hex');
}

/**
 * Canonicalize the composite name+address pair before hashing so
 * "Jane  Doe" and "jane doe " collide. Lowercases, collapses internal
 * whitespace, trims.
 */
function canonicalizeName(fullName: string): string {
  return fullName.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---- value_preview masks --------------------------------------------
//
// What the iOS card shows for the monitor value on a finding row.
// Email: first character + '****' + '@' + domain.
// Phone: '***-***-' + last 4.
// Hashed kinds: literal 'monitored' — the hash NEVER round-trips to
//               the client, and there's no plaintext to reveal.

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return 'monitored';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local[0] ?? ''}****${domain}`;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return 'monitored';
  return `***-***-${digits.slice(-4)}`;
}

function valuePreview(monitorKind: string, watchedValue: string): string {
  switch (monitorKind) {
    case 'email':
      return maskEmail(watchedValue);
    case 'phone_e164':
      return maskPhone(watchedValue);
    case 'ssn_last4_hash':
    case 'dob_hash':
    case 'name_address_hash':
      return 'monitored';
    default:
      return 'monitored';
  }
}

// ---- threats/near cache helpers -------------------------------------
//
// 5-minute cache. The dashboard polls this endpoint frequently (every
// ~30s on a foregrounded app) — without a cache layer the aggregate
// SELECT would hammer the DB. Key includes the geo_tag so two users
// in different regions get distinct entries.

interface ThreatsNearPayload {
  count: number;
  count_delta_7d: number;
  by_severity: Record<string, number>;
  by_kind: Record<string, number>;
}

function threatsNearCacheKey(userId: string, geoTag: string | null): string {
  return `identity_threats_near:${userId}:${geoTag ?? 'global'}`;
}

const THREATS_NEAR_TTL_SEC = 5 * 60;

// ---- Route registration --------------------------------------------

export async function identityShieldRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------
  // GET /v1/identity-shield/monitors — list user's active monitors
  // -------------------------------------------------------------
  //
  // Returns active monitors only (soft-deleted rows are filtered).
  // Hash kinds expose the hash digest's existence but not its content
  // — the response carries monitor_kind + a value_preview literal
  // ('monitored') so the iOS card can render "SSN last 4 — monitored"
  // without ever surfacing the hash or salt.
  app.get(
    '/v1/identity-shield/monitors',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const userId = req.appUser!.id;
      const res = await query<{
        id: string;
        monitor_kind: string;
        watched_value: string;
        created_at: Date;
      }>(
        `SELECT id, monitor_kind, watched_value, created_at
           FROM identity_monitors
          WHERE user_id = $1 AND active
          ORDER BY created_at DESC`,
        [userId],
      );
      return reply.send({
        monitors: res.rows.map((r) => ({
          id: r.id,
          monitor_kind: r.monitor_kind,
          // value_preview is the only client-visible projection of
          // watched_value. Email/phone get masked; hash kinds get the
          // literal 'monitored' — the hash itself is never returned.
          value_preview: valuePreview(r.monitor_kind, r.watched_value),
          created_at: r.created_at.toISOString(),
        })),
      });
    },
  );

  // -------------------------------------------------------------
  // POST /v1/identity-shield/monitors — add a monitor
  // -------------------------------------------------------------
  //
  // The security-critical route. For hash kinds (ssn/dob/name+address),
  // plaintext arrives, is hashed server-side IMMEDIATELY with a per-user
  // salt, and the plaintext is discarded before the INSERT. Plaintext
  // NEVER lands in logs, error contexts, response bodies, or persisted
  // rows.
  //
  // Idempotency: the UNIQUE (user_id, monitor_kind, watched_value)
  // constraint means duplicate adds are ON CONFLICT DO NOTHING and we
  // return the existing monitor_id. iOS can retry safely.
  app.post(
    '/v1/identity-shield/monitors',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsed = MonitorAddSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      const userId = req.appUser!.id;
      const body = parsed.data;

      let watchedValue: string;
      let saltHex: string | null;
      try {
        switch (body.monitor_kind) {
          case 'email':
            // Plaintext — already plaintext in users.email / email_accounts.
            // Lowercase canonicalize so 'Alice@Example.com' collides with
            // 'alice@example.com' on the UNIQUE.
            watchedValue = body.value.toLowerCase().trim();
            saltHex = null;
            break;
          case 'phone_e164':
            // Plaintext — already plaintext in users.phone_number. Zod
            // regex already enforced the E.164 shape.
            watchedValue = body.value;
            saltHex = null;
            break;
          case 'ssn_last4_hash': {
            saltHex = await resolveUserSalt(userId, 'ssn_last4_hash');
            watchedValue = hashWithSalt(saltHex, 'ssn4', body.ssn_last4);
            // Plaintext goes out of scope here. The body reference
            // remains on the request object, but we never log it, never
            // include it in metric tags, never echo it. Zod's parsed
            // object is local to the handler.
            break;
          }
          case 'dob_hash': {
            saltHex = await resolveUserSalt(userId, 'dob_hash');
            watchedValue = hashWithSalt(saltHex, 'dob', body.dob_iso);
            break;
          }
          case 'name_address_hash': {
            saltHex = await resolveUserSalt(userId, 'name_address_hash');
            const composite = `${canonicalizeName(body.full_name)}|${body.zip5}`;
            watchedValue = hashWithSalt(saltHex, 'na', composite);
            break;
          }
        }
      } catch (err) {
        // Hash/salt path errors are infrastructure (e.g., DB unreachable
        // during salt lookup). Capture WITHOUT including the request
        // body — plaintext SSN/DOB MUST NOT enter error context.
        captureError(err, { component: 'identityShield.monitor_add', user_id: userId, monitor_kind: body.monitor_kind });
        return reply.code(500).send({ error: 'monitor_add_failed' });
      }

      // INSERT ... ON CONFLICT DO NOTHING + a follow-up SELECT to fetch
      // the row id idempotently. Single-INSERT-with-RETURNING doesn't
      // RETURN when DO NOTHING short-circuits, so we layer a SELECT.
      try {
        const ins = await query<{ id: string }>(
          `INSERT INTO identity_monitors (user_id, monitor_kind, watched_value, salt_hex, active)
           VALUES ($1, $2, $3, $4, TRUE)
           ON CONFLICT (user_id, monitor_kind, watched_value) DO NOTHING
           RETURNING id`,
          [userId, body.monitor_kind, watchedValue, saltHex],
        );
        let monitorId: string;
        if ((ins.rowCount ?? 0) > 0) {
          monitorId = ins.rows[0]!.id;
        } else {
          // Conflict path — the row already existed. Look it up. We
          // also clear `active = FALSE` if a prior soft-delete is in
          // play; re-adding a monitor is a clear "I want this watched
          // again" signal.
          const sel = await query<{ id: string; active: boolean }>(
            `SELECT id, active
               FROM identity_monitors
              WHERE user_id = $1 AND monitor_kind = $2 AND watched_value = $3
              LIMIT 1`,
            [userId, body.monitor_kind, watchedValue],
          );
          if ((sel.rowCount ?? 0) === 0) {
            // Should not happen — the UNIQUE constraint guarantees the
            // conflict means a row exists. Treat as transient error.
            return reply.code(500).send({ error: 'monitor_add_failed' });
          }
          monitorId = sel.rows[0]!.id;
          if (!sel.rows[0]!.active) {
            await query(
              `UPDATE identity_monitors SET active = TRUE WHERE id = $1`,
              [monitorId],
            );
          }
        }
        void emitMetric('identity_shield.monitor_added', { kind: body.monitor_kind });
        return reply.code(201).send({
          id: monitorId,
          monitor_kind: body.monitor_kind,
          // Echo a value_preview for the just-added monitor so iOS can
          // render the confirmation card without a follow-up GET. NEVER
          // include the hash, the salt, or the plaintext.
          value_preview: valuePreview(body.monitor_kind, watchedValue),
        });
      } catch (err) {
        captureError(err, { component: 'identityShield.monitor_add_insert', user_id: userId, monitor_kind: body.monitor_kind });
        return reply.code(500).send({ error: 'monitor_add_failed' });
      }
    },
  );

  // -------------------------------------------------------------
  // DELETE /v1/identity-shield/monitors/:id — soft-delete
  // -------------------------------------------------------------
  //
  // Sets active=FALSE rather than DROPping the row so retention sweep
  // (90d window) can prove "the user was monitoring this identifier
  // at the time the breach surfaced" for audit. Cross-user attempts
  // return 404 (consistent with other Pro routes).
  app.delete(
    '/v1/identity-shield/monitors/:id',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const userId = req.appUser!.id;
      const { id: idRaw } = req.params as { id: string };
      const parsedId = z.string().uuid().safeParse(idRaw);
      if (!parsedId.success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const res = await query<{ id: string }>(
        `UPDATE identity_monitors
            SET active = FALSE
          WHERE id = $1 AND user_id = $2 AND active
          RETURNING id`,
        [parsedId.data, userId],
      );
      if ((res.rowCount ?? 0) === 0) {
        return reply.code(404).send({ error: 'not_found' });
      }
      void emitMetric('identity_shield.monitor_deleted', {});
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------
  // GET /v1/identity-shield/findings — list breach findings
  // -------------------------------------------------------------
  //
  // Joins identity_breach_findings ⨝ identity_breaches ⨝ identity_monitors
  // to render the user-facing card. Filters: severity (default 'all'),
  // acknowledged (default 'all'), limit (default 50, max 200).
  //
  // value_preview masking: email gets prefix mask, phone gets last-4,
  // hashed kinds get the literal 'monitored'. The hash NEVER appears
  // in the response payload.
  app.get(
    '/v1/identity-shield/findings',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsedQ = FindingListQuerySchema.safeParse(req.query ?? {});
      if (!parsedQ.success) {
        return reply.code(400).send({ error: 'invalid_query', details: parsedQ.error.flatten() });
      }
      const userId = req.appUser!.id;
      const severity = parsedQ.data.severity ?? 'all';
      const acknowledged = parsedQ.data.acknowledged ?? 'all';
      const limit = parsedQ.data.limit ?? 50;

      const params: unknown[] = [userId];
      const conds: string[] = ['f.user_id = $1'];
      if (severity !== 'all') {
        params.push(severity);
        conds.push(`f.severity = $${params.length}`);
      }
      if (acknowledged === 'true') {
        conds.push('f.user_acknowledged_at IS NOT NULL');
      } else if (acknowledged === 'false') {
        conds.push('f.user_acknowledged_at IS NULL');
      }
      params.push(limit);
      const limitIdx = params.length;

      const res = await query<{
        id: string;
        severity: string;
        surfaced_at: Date;
        user_acknowledged_at: Date | null;
        remediation_completed_at: Date | null;
        monitor_id: string;
        monitor_kind: string;
        watched_value: string;
        breach_name: string;
        breach_domain: string | null;
        breach_date: Date | null;
        data_classes: string[] | null;
      }>(
        `SELECT
           f.id, f.severity, f.surfaced_at,
           f.user_acknowledged_at, f.remediation_completed_at,
           m.id AS monitor_id, m.monitor_kind, m.watched_value,
           b.breach_name, b.domain AS breach_domain, b.breach_date, b.data_classes
         FROM identity_breach_findings f
         JOIN identity_monitors m ON m.id = f.monitor_id
         JOIN identity_breaches b ON b.id = f.breach_id
         WHERE ${conds.join(' AND ')}
         ORDER BY f.surfaced_at DESC
         LIMIT $${limitIdx}`,
        params,
      );

      return reply.send({
        findings: res.rows.map((r) => ({
          id: r.id,
          monitor: {
            id: r.monitor_id,
            monitor_kind: r.monitor_kind,
            value_preview: valuePreview(r.monitor_kind, r.watched_value),
          },
          breach: {
            name: r.breach_name,
            domain: r.breach_domain,
            breach_date: r.breach_date ? r.breach_date.toISOString().slice(0, 10) : null,
            data_classes: r.data_classes ?? [],
          },
          severity: r.severity,
          surfaced_at: r.surfaced_at.toISOString(),
          acknowledged_at: r.user_acknowledged_at?.toISOString() ?? null,
          remediation_completed_at: r.remediation_completed_at?.toISOString() ?? null,
        })),
        next_cursor: null,
      });
    },
  );

  // -------------------------------------------------------------
  // POST /v1/identity-shield/findings/:id/acknowledge
  // -------------------------------------------------------------
  //
  // Marks user_acknowledged_at = NOW(). Idempotent — re-tapping the
  // alert doesn't reset the timestamp (we only set it when previously
  // NULL). Cross-user attempts return 404.
  app.post(
    '/v1/identity-shield/findings/:id/acknowledge',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const userId = req.appUser!.id;
      const { id: idRaw } = req.params as { id: string };
      const parsedId = z.string().uuid().safeParse(idRaw);
      if (!parsedId.success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const res = await query<{ id: string; user_acknowledged_at: Date }>(
        `UPDATE identity_breach_findings
            SET user_acknowledged_at = COALESCE(user_acknowledged_at, NOW())
          WHERE id = $1 AND user_id = $2
          RETURNING id, user_acknowledged_at`,
        [parsedId.data, userId],
      );
      if ((res.rowCount ?? 0) === 0) {
        return reply.code(404).send({ error: 'not_found' });
      }
      void emitMetric('identity_shield.finding_acknowledged', {});
      return reply.send({
        id: res.rows[0]!.id,
        acknowledged_at: res.rows[0]!.user_acknowledged_at.toISOString(),
      });
    },
  );

  // -------------------------------------------------------------
  // POST /v1/identity-shield/findings/:id/remediate
  // -------------------------------------------------------------
  //
  // Marks remediation_completed_at = NOW() AND auto-acknowledges
  // (we treat remediation as a stronger signal than acknowledgment;
  // a user who finished the Recovery flow has clearly seen the alert).
  // Cross-user 404 contract.
  app.post(
    '/v1/identity-shield/findings/:id/remediate',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const userId = req.appUser!.id;
      const { id: idRaw } = req.params as { id: string };
      const parsedId = z.string().uuid().safeParse(idRaw);
      if (!parsedId.success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const res = await query<{ id: string; remediation_completed_at: Date }>(
        `UPDATE identity_breach_findings
            SET user_acknowledged_at = COALESCE(user_acknowledged_at, NOW()),
                remediation_completed_at = COALESCE(remediation_completed_at, NOW())
          WHERE id = $1 AND user_id = $2
          RETURNING id, remediation_completed_at`,
        [parsedId.data, userId],
      );
      if ((res.rowCount ?? 0) === 0) {
        return reply.code(404).send({ error: 'not_found' });
      }
      void emitMetric('identity_shield.finding_remediated', {});
      return reply.send({
        id: res.rows[0]!.id,
        remediation_completed_at: res.rows[0]!.remediation_completed_at.toISOString(),
      });
    },
  );

  // -------------------------------------------------------------
  // GET /v1/identity-shield/threats/near — aggregate counter
  // -------------------------------------------------------------
  //
  // Dashboard tile counter. Aggregates non-expired active_threats rows
  // matching the optional geo_tag filter, returns count + 7d delta +
  // by-severity + by-kind breakdowns.
  //
  // 5-minute cache keyed by (user_id, geo_tag) so foreground polling
  // doesn't flood the DB. The aggregate is global (active_threats has
  // no user_id) but the cache key is per-user so user-specific geo
  // overrides don't collide.
  app.get(
    '/v1/identity-shield/threats/near',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const parsedQ = ThreatsNearQuerySchema.safeParse(req.query ?? {});
      if (!parsedQ.success) {
        return reply.code(400).send({ error: 'invalid_query', details: parsedQ.error.flatten() });
      }
      const userId = req.appUser!.id;
      const geoTag = parsedQ.data.geo_tag ?? null;

      const cacheKey = threatsNearCacheKey(userId, geoTag);
      const cached = await cacheGet<ThreatsNearPayload>(cacheKey);
      if (cached) {
        void emitMetric('identity_shield.threats_near_cache_hit', {});
        return reply.send(cached);
      }

      // Three aggregate queries; small enough to be one round-trip
      // each (the partial index on (threat_kind, threat_value) WHERE
      // expires_at IS NULL OR > NOW() does the heavy lifting; the
      // pure-count and group-by queries scan the same partition).
      const params: unknown[] = [];
      let geoCond = '';
      if (geoTag !== null) {
        params.push(geoTag);
        geoCond = ` AND geo_tag = $${params.length}`;
      }

      try {
        const totalRes = await query<{ count: string }>(
          `SELECT COUNT(*)::TEXT AS count
             FROM active_threats
            WHERE (expires_at IS NULL OR expires_at > NOW())${geoCond}`,
          params,
        );
        const sevRes = await query<{ severity: string; count: string }>(
          `SELECT severity, COUNT(*)::TEXT AS count
             FROM active_threats
            WHERE (expires_at IS NULL OR expires_at > NOW())${geoCond}
            GROUP BY severity`,
          params,
        );
        const kindRes = await query<{ threat_kind: string; count: string }>(
          `SELECT threat_kind, COUNT(*)::TEXT AS count
             FROM active_threats
            WHERE (expires_at IS NULL OR expires_at > NOW())${geoCond}
            GROUP BY threat_kind`,
          params,
        );

        // 7d delta = how many of the currently-active rows first_seen
        // in the last 7 days. A simple "growth" indicator for the
        // dashboard counter.
        const deltaRes = await query<{ count: string }>(
          `SELECT COUNT(*)::TEXT AS count
             FROM active_threats
            WHERE (expires_at IS NULL OR expires_at > NOW())
              AND first_seen_at > NOW() - INTERVAL '7 days'${geoCond}`,
          params,
        );

        const by_severity: Record<string, number> = {
          informational: 0,
          caution: 0,
          warning: 0,
          confirmed_scammer: 0,
        };
        for (const r of sevRes.rows) {
          by_severity[r.severity] = parseInt(r.count, 10) || 0;
        }
        const by_kind: Record<string, number> = {
          phone_e164: 0,
          email_address: 0,
          crypto_wallet: 0,
          url_host: 0,
          ip_address: 0,
        };
        for (const r of kindRes.rows) {
          by_kind[r.threat_kind] = parseInt(r.count, 10) || 0;
        }

        const payload: ThreatsNearPayload = {
          count: parseInt(totalRes.rows[0]!.count, 10) || 0,
          count_delta_7d: parseInt(deltaRes.rows[0]!.count, 10) || 0,
          by_severity,
          by_kind,
        };
        await cacheSet(cacheKey, payload, THREATS_NEAR_TTL_SEC);
        void emitMetric('identity_shield.threats_near_cache_miss', {});
        return reply.send(payload);
      } catch (err) {
        captureError(err, { component: 'identityShield.threats_near', user_id: userId });
        return reply.code(500).send({ error: 'threats_near_failed' });
      }
    },
  );

  // -------------------------------------------------------------
  // GET /v1/identity-shield/digest/preview — what today's push would say
  // -------------------------------------------------------------
  //
  // Renders the envelope the I-P5 push-digest scheduler WOULD send
  // today. NO push actually fires here — this endpoint is read-only.
  // iOS uses it for the "Notification preview" toggle in Settings so
  // the user can see what they'd receive before opting in.
  app.get(
    '/v1/identity-shield/digest/preview',
    {
      preHandler: [requireAppUser, requireProTier],
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute', ...userKeyedLimit },
      },
    },
    async (req, reply) => {
      const userId = req.appUser!.id;

      // Pull a rough monitor count + recent-findings count so the
      // preview body has user-specific texture. Best-effort: if either
      // query fails we fall back to a generic template (the digest
      // scheduler in I-P5 has the real composition logic; this is the
      // preview surface).
      let monitorsActive = 0;
      let newFindings7d = 0;
      try {
        const m = await query<{ count: string }>(
          `SELECT COUNT(*)::TEXT AS count FROM identity_monitors WHERE user_id = $1 AND active`,
          [userId],
        );
        monitorsActive = parseInt(m.rows[0]?.count ?? '0', 10) || 0;
        const f = await query<{ count: string }>(
          `SELECT COUNT(*)::TEXT AS count FROM identity_breach_findings
             WHERE user_id = $1 AND surfaced_at > NOW() - INTERVAL '7 days'`,
          [userId],
        );
        newFindings7d = parseInt(f.rows[0]?.count ?? '0', 10) || 0;
      } catch (err) {
        captureError(err, { component: 'identityShield.digest_preview', user_id: userId });
        // Soft-degrade — continue to the template-only path below.
      }

      // Default to daily for engaged users; the actual scheduler
      // (I-P5) will pick daily vs weekly per user_settings. Preview
      // mirrors the live cadence so the toggle copy matches.
      const digest_kind: 'daily' | 'weekly' = newFindings7d > 0 ? 'daily' : 'weekly';

      // 13:00 UTC = mid-morning across NA business hours. The actual
      // scheduler will respect per-user TZ in I-P5; preview pins UTC
      // so the user sees a stable "would_send_at" rather than churn.
      const today = new Date();
      const wouldSendAt = new Date(Date.UTC(
        today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1, 13, 0, 0, 0,
      ));

      const title = digest_kind === 'daily' ? "We're watching" : 'Weekly Shield report';
      // Body copy is intentionally factual + non-alarmist. The
      // newsroom-style "X scams blocked" framing is the brand voice
      // for digests; per IDENTITY_SHIELD_ENGINEERING.md §I-P5.
      const body = digest_kind === 'daily'
        ? `AegisDial is watching ${monitorsActive} data point${monitorsActive === 1 ? '' : 's'} for you. ${newFindings7d} new breach finding${newFindings7d === 1 ? '' : 's'} surfaced this week.`
        : `Weekly summary: ${monitorsActive} identifier${monitorsActive === 1 ? '' : 's'} monitored. ${newFindings7d} finding${newFindings7d === 1 ? '' : 's'} in the last 7 days.`;

      return reply.send({
        digest_kind,
        title,
        body,
        would_send_at: wouldSendAt.toISOString(),
        user_can_opt_out: true,
      });
    },
  );
}
