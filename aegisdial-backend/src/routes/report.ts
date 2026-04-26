import type { FastifyInstance } from 'fastify';
import {
  ReportRequestSchema,
  FeedbackRequestSchema,
} from '../types.js';
import { recordReport, recordFeedback } from '../services/verdict.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { normalizeE164 } from '../lib/phone.js';
import { cacheInvalidate, verdictCacheKey } from '../lib/cache.js';

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/report', { preHandler: [requireAppUser, requireProTier] }, async (req, reply) => {
    const parsed = ReportRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const e164 = normalizeE164(parsed.data.number);
    if (!e164) {
      return reply.code(400).send({ error: 'invalid_phone_number' });
    }
    await recordReport({
      e164,
      category: parsed.data.category,
      note: parsed.data.note,
      device_id: parsed.data.device_id,
    });
    await cacheInvalidate(verdictCacheKey(e164));
    return reply.code(202).send({ status: 'accepted' });
  });

  app.post('/v1/feedback', { preHandler: [requireAppUser, requireProTier] }, async (req, reply) => {
    const parsed = FeedbackRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const e164 = normalizeE164(parsed.data.number);
    if (!e164) {
      return reply.code(400).send({ error: 'invalid_phone_number' });
    }
    await recordFeedback({
      e164,
      user_verdict: parsed.data.user_verdict,
      device_id: parsed.data.device_id,
    });
    return reply.code(202).send({ status: 'accepted' });
  });
}
