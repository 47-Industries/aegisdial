import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { requireAppUser } from '../lib/auth.js';

// Verified-bank directory. The Recovery Concierge "call your bank"
// step can pre-fill the user's bank's real fraud number instead of
// just saying "look at the back of your card." Data comes from the
// 583-row spoof_targets catalog we already seed — banks specifically.
//
// Only returns entries categorized as bank / credit_union / credit_card /
// fintech (anything a user might have money sitting in).

const SEARCH_SCHEMA = z.object({
  q: z.string().min(2).max(80),
});

const FINANCIAL_CATEGORIES = [
  'bank',
  'credit_union',
  'credit_card',
  'brokerage',
  'fintech',
  'p2p_payments',
];

export async function banksRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/banks/search',
    { preHandler: [requireAppUser] },
    async (req, reply) => {
      const parsed = SEARCH_SCHEMA.safeParse(req.query ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

      const rows = await query<{
        name: string;
        category: string;
        verified_numbers: string[];
      }>(
        // spoof_message intentionally NOT selected. That field is
        // written in verdict-engine voice ("HANG UP — scammers spoof
        // this line") and would be confusing in the recovery context
        // where the user is actively trying to call their bank's fraud
        // desk.
        `SELECT name, category, verified_numbers
           FROM spoof_targets
          WHERE category = ANY($1::text[])
            AND name ILIKE '%' || $2 || '%'
          ORDER BY name ASC
          LIMIT 10`,
        [FINANCIAL_CATEGORIES, parsed.data.q],
      );
      return reply.send({
        banks: rows.rows.map((r) => ({
          name: r.name,
          category: r.category,
          fraud_phones: r.verified_numbers,
          notes: null,
        })),
      });
    },
  );

  // List the full financial catalog, grouped by category. Used by
  // the Settings → Banks screen where the user picks which bank(s)
  // they hold money at, and we save that preference.
  app.get(
    '/v1/banks/catalog',
    { preHandler: [requireAppUser] },
    async (_req, reply) => {
      const rows = await query<{
        name: string;
        category: string;
        verified_numbers: string[];
      }>(
        `SELECT name, category, verified_numbers
           FROM spoof_targets
          WHERE category = ANY($1::text[])
          ORDER BY category, name`,
        [FINANCIAL_CATEGORIES],
      );
      const byCategory: Record<string, Array<{ name: string; fraud_phones: string[] }>> = {};
      for (const r of rows.rows) {
        (byCategory[r.category] ??= []).push({ name: r.name, fraud_phones: r.verified_numbers });
      }
      return reply.send({ by_category: byCategory });
    },
  );
}
