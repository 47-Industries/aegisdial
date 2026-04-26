import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { classifySms } from '../services/smsClassify.js';
import { sha256 } from '../lib/urlScan.js';

// SMS / iMessage classification endpoint. Apple's ILMessageFilterExtension
// POSTs here when the extension calls `deferQueryRequestToNetwork`. The
// post is unauthenticated — Apple performs the HTTPS request itself and
// does not support custom headers from the extension — so we:
//   1. do NOT require the app JWT on this route
//   2. rely on the /1m rate limit + text hash dedup for abuse control
//   3. never store the plaintext body, only the SHA-256
//
// We accept three possible request shapes so our own iOS app and curl
// tests can share the endpoint:
//   { sender, text }                         — our internal form
//   { sender, message: { text } }            — some Apple SDK revisions
//   { query: { sender, message: { text } } } — older Apple revisions

const FlatShape = z.object({
  sender: z.string().max(120).optional(),
  text: z.string().min(1).max(3200),
});
const NestedShape = z.object({
  sender: z.string().max(120).optional(),
  message: z.object({ text: z.string().min(1).max(3200) }),
});
const AppleShape = z.object({
  query: z.object({
    sender: z.string().max(120).optional(),
    message: z.object({ text: z.string().min(1).max(3200) }),
  }),
});

function extractBody(raw: unknown): { sender?: string; text: string } | null {
  const flat = FlatShape.safeParse(raw);
  if (flat.success) return { sender: flat.data.sender, text: flat.data.text };
  const nested = NestedShape.safeParse(raw);
  if (nested.success)
    return { sender: nested.data.sender, text: nested.data.message.text };
  const apple = AppleShape.safeParse(raw);
  if (apple.success)
    return {
      sender: apple.data.query.sender,
      text: apple.data.query.message.text,
    };
  return null;
}

export async function smsClassifyRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/sms-classify',
    {
      config: {
        // Key on a SHA of the message text, not IP. Apple's SMS filter
        // extension issues the HTTPS request from an Apple edge POP
        // shared across every iOS user in a region, so an IP-keyed
        // limiter would throttle legit traffic globally as soon as one
        // device went heavy. Hashing the text means the same message
        // re-POSTed (filter retry, duplicate network) gets slowed but
        // distinct messages from distinct users sail past. We fall
        // back to IP only when we can't extract text (malformed body).
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
          keyGenerator: (req) => {
            const extracted = extractBody(req.body);
            if (extracted?.text) return `sms:${sha256(extracted.text)}`;
            return `ip:${req.ip}`;
          },
        },
      },
    },
    async (req, reply) => {
      const extracted = extractBody(req.body);
      if (!extracted) return reply.code(400).send({ error: 'invalid_body' });
      const { sender, text } = extracted;
      const userId = req.appUser?.id ?? null; // opportunistic attribution
      const result = await classifySms(text, sender);

      const phraseHitIds = result.phrase_hits.map((h) => h.pattern.id);
      // Persist only non-PII URL metadata — host + verdict + threat types.
      // The full URL (with query params / tokens / emails) stays out of
      // the row. Shared cache key is a host+path SHA in urlScan.ts.
      const urlHitsSanitized = result.url_hits.map((f) => {
        let host: string | null = null;
        try { host = new URL(f.url).hostname.toLowerCase(); } catch { /* ignore */ }
        return {
          host,
          is_malicious: f.is_malicious,
          threat_types: f.threat_types,
          source: f.source,
        };
      });
      try {
        await query(
          `INSERT INTO sms_classifications
             (user_id, sender, text_hash, text_length, action, risk_score, risk_level, phrase_hits, url_hits)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            userId,
            sender ?? null,
            sha256(text),
            text.length,
            result.action,
            result.risk_score,
            result.risk_level,
            phraseHitIds,
            JSON.stringify(urlHitsSanitized),
          ],
        );
      } catch (err) {
        // Log the error code/message only — pg may include bind params
        // (including raw URLs / sender) in the full error object, so
        // stringify only the safe fields.
        const safe = err instanceof Error
          ? { message: err.message, code: (err as { code?: string }).code }
          : { message: String(err) };
        req.log.warn(safe, 'sms_classification_persist_failed');
      }

      return reply.send({
        action: result.action,
        risk_score: result.risk_score,
        risk_level: result.risk_level,
        reason: result.reason,
        triggered_categories: result.triggered_categories,
        phrase_hits: phraseHitIds,
        url_hits: result.url_hits.map((f) => ({
          url: f.url,
          is_malicious: f.is_malicious,
          threat_types: f.threat_types,
          source: f.source,
        })),
      });
    },
  );
}
