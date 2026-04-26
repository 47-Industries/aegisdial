import type { FastifyInstance } from 'fastify';
import { VerdictRequestSchema } from '../types.js';
import { getVerdict, VerdictError } from '../services/verdict.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { normalizeE164 } from '../lib/phone.js';
import { query } from '../lib/db.js';

export async function verdictRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/verdict', { preHandler: [requireAppUser, requireProTier] }, async (req, reply) => {
    const parsed = VerdictRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    try {
      const result = await getVerdict(parsed.data.number, parsed.data.country);
      return reply.send(result);
    } catch (err) {
      if (err instanceof VerdictError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      req.log.error({ err }, 'verdict_error');
      return reply.code(500).send({ error: 'internal_error' });
    }
  });

  app.get('/v1/verdict/:number', { preHandler: [requireAppUser, requireProTier] }, async (req, reply) => {
    const { number } = req.params as { number: string };
    const e164 = normalizeE164(number);
    if (!e164) {
      return reply.code(400).send({ error: 'invalid_phone_number' });
    }
    const result = await query<{
      e164: string;
      trust_score: number | null;
      verdict: string | null;
      summary: string | null;
      score_computed_at: Date | null;
    }>(
      `SELECT e164, trust_score, verdict, summary, score_computed_at
       FROM numbers WHERE e164 = $1`,
      [e164],
    );
    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.send(result.rows[0]);
  });
}
