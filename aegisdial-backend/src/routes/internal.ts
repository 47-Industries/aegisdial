// Internal founder dashboard routes. All gated behind HTTP basic auth
// against INTERNAL_DASHBOARD_PASSWORD (see src/lib/internalAuth.ts).
//
// Three endpoints:
//
//   GET  /internal/dashboard  — serves the single-page HTML dashboard
//   GET  /internal/kpis       — JSON: the six precomputed KPIs
//   POST /internal/ask        — JSON in: { question }, JSON out: { sql, rows, columns }
//
// The /ask path is the one that calls Claude Haiku. Every query it
// returns is validated by sqlSafe.validateReadOnlyQuery() and then
// executed inside a `BEGIN READ ONLY` transaction with an 8-second
// statement_timeout. Even a successful regex bypass cannot mutate
// state — Postgres enforces the read-only mode.

import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { requireInternalPassword } from '../lib/internalAuth.js';
import { getKpis, forceRefresh } from '../lib/kpis.js';
import { validateReadOnlyQuery } from '../lib/sqlSafe.js';
import { questionToSql } from '../services/nlSql.js';
import { pool } from '../lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Project root is two levels up from src/routes/. The dashboard HTML
// lives in /public/internal/dashboard.html.
const DASHBOARD_HTML_PATH = join(__dirname, '..', '..', 'public', 'internal', 'dashboard.html');

// Cache the HTML in memory — it's small and we don't want a disk read
// per hit. Reload on the first request after server start so changes
// are picked up by a restart.
let cachedHtml: string | null = null;
async function loadDashboardHtml(): Promise<string> {
  if (cachedHtml) return cachedHtml;
  cachedHtml = await readFile(DASHBOARD_HTML_PATH, 'utf8');
  return cachedHtml;
}

interface AskBody {
  question?: string;
  refresh?: boolean; // unused for /ask, present for forward-compat
}

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  // Apply the auth gate on every route registered in this plugin.
  app.addHook('preHandler', requireInternalPassword);

  // ── /internal/dashboard ─────────────────────────────────────────
  app.get('/internal/dashboard', async (_req, reply) => {
    const html = await loadDashboardHtml();
    reply.type('text/html; charset=utf-8').send(html);
  });

  // ── /internal/kpis ──────────────────────────────────────────────
  app.get('/internal/kpis', async (req, reply) => {
    try {
      // Optional ?force=1 — re-run all MV refreshes regardless of cooldown.
      const q = req.query as { force?: string } | undefined;
      if (q?.force === '1') await forceRefresh();
      const kpis = await getKpis();
      reply.send(kpis);
    } catch (err) {
      req.log.error({ err }, 'kpis_fetch_failed');
      reply.code(500).send({ error: 'kpis_fetch_failed' });
    }
  });

  // ── /internal/ask ───────────────────────────────────────────────
  app.post('/internal/ask', async (req, reply) => {
    const body = req.body as AskBody;
    const question = (body?.question ?? '').trim();
    if (!question) {
      return reply.code(400).send({ error: 'missing_question' });
    }

    // Step 1: Claude → SQL.
    let sql: string;
    let modelTokens: { input: number; output: number };
    try {
      const result = await questionToSql(question);
      sql = result.sql;
      modelTokens = result.modelTokens;
    } catch (err) {
      req.log.error({ err }, 'nl_sql_failed');
      const msg = err instanceof Error ? err.message : 'nl_sql_failed';
      return reply.code(502).send({ error: 'nl_sql_failed', detail: msg });
    }

    // Step 2: validate the generated SQL.
    const verdict = validateReadOnlyQuery(sql);
    if (!verdict.ok) {
      req.log.warn({ sql, reason: verdict.reason }, 'sql_rejected');
      return reply.code(400).send({
        error: 'sql_rejected',
        reason: verdict.reason,
        sql, // surface what Claude tried — useful for prompt iteration
      });
    }

    // Step 3: execute under a strict read-only transaction.
    let rows: unknown[] = [];
    let columns: string[] = [];
    let durationMs = 0;
    const t0 = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      // 8s ceiling — anything that takes longer is almost certainly
      // a runaway aggregate the operator can re-ask differently.
      await client.query("SET LOCAL statement_timeout = '8s'");
      const result = await client.query(sql);
      rows = result.rows;
      columns = result.fields.map((f) => f.name);
      durationMs = Date.now() - t0;
      await client.query('ROLLBACK'); // there's nothing to commit — read-only
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch { /* swallow secondary error */ }
      req.log.error({ err, sql }, 'sql_execute_failed');
      const msg = err instanceof Error ? err.message : 'sql_execute_failed';
      return reply.code(400).send({ error: 'sql_execute_failed', detail: msg, sql });
    } finally {
      client.release();
    }

    reply.send({
      sql,
      columns,
      rows,
      duration_ms: durationMs,
      model_tokens: modelTokens,
    });
  });
}
