import type { FastifyInstance } from 'fastify';
import { query } from '../lib/db.js';
import { redis } from '../lib/cache.js';

// Captured once at module-load time. `bootedAt` is the process start, not
// the deploy time per se — close enough for "is the deploy current?"
// checks since Railway re-creates the process on every push.
const BOOTED_AT = new Date().toISOString();

// Resolved from Railway's auto-injected env var (RAILWAY_GIT_COMMIT_SHA),
// or any of the standard CI variables, or the literal string 'unknown'
// when running locally without a build pipeline. We want this endpoint
// to NEVER 500, even on a workstation, so the resolution is best-effort.
const GIT_SHA =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT_SHA ||
  process.env.SOURCE_VERSION ||
  process.env.HEROKU_SLUG_COMMIT ||
  'unknown';

const PKG_VERSION =
  process.env.npm_package_version ||
  process.env.PACKAGE_VERSION ||
  'unknown';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    return reply.send({ status: 'ok', ts: new Date().toISOString() });
  });

  app.get('/health/ready', async (_req, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {};
    try {
      await query('SELECT 1');
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'fail';
    }
    try {
      await redis.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'fail';
    }
    const allOk = Object.values(checks).every((v) => v === 'ok');
    return reply.code(allOk ? 200 : 503).send({ status: allOk ? 'ok' : 'fail', checks });
  });

  // `/version` — answer "is the deploy current?" in one curl. Returns the
  // git SHA Railway built from, the npm package version, and the process
  // boot time. No auth (this is intentionally public so we can check from
  // anywhere). Cheap and side-effect-free.
  //
  //   $ curl -s https://aegisdial-api-production.up.railway.app/version
  //   {"sha":"b330c00...","short":"b330c00","version":"0.1.0","bootedAt":"...","node":"v20.x.x"}
  //
  // The `short` form (first 7 chars of the SHA) is a separate field so we
  // don't have to manipulate strings client-side; useful when comparing
  // against `git log --oneline` output.
  app.get('/version', async (_req, reply) => {
    return reply.send({
      sha: GIT_SHA,
      short: GIT_SHA === 'unknown' ? 'unknown' : GIT_SHA.slice(0, 7),
      version: PKG_VERSION,
      bootedAt: BOOTED_AT,
      node: process.version,
    });
  });
}
