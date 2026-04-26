import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { optionalAppUser } from '../lib/auth.js';
import { track, type AnalyticsEvent } from '../lib/analytics.js';

// Client-initiated analytics. iOS fires funnel events through here so we
// can see where users drop off in onboarding + permission gates. Events
// are allow-listed against `AnalyticsEvent` — unknown names return 400
// so a stale client can't poison our event taxonomy.
//
// Auth is OPTIONAL: onboarding events fire before signup completes. We
// attach user_id if the request has one, otherwise the event is
// attributed to an anonymous install.

const ALLOWED_CLIENT_EVENTS: ReadonlySet<AnalyticsEvent> = new Set<AnalyticsEvent>([
  'onboarding_started',
  'onboarding_tour_page_viewed',
  'onboarding_tour_skipped',
  'onboarding_tour_completed',
  'auth_apple_tapped',
  'auth_apple_age_submitted',
  'auth_email_tapped',
  'auth_email_submitted',
  'permission_prompted',
  'permission_granted',
  'permission_denied',
  'live_shield_cta_tapped',
  'recovery_cta_tapped',
  'demo_call_started',
  'protect_parent_flow_started',
  'protect_parent_invite_sent',
  'protect_parent_safeword_saved',
  'protect_parent_flow_completed',
  'api_error_silenced',
]);

const EVENT_SCHEMA = z.object({
  name: z.string().min(1).max(80),
  properties: z.record(z.string(), z.unknown()).optional(),
  // Stable anonymous ID the client keeps in Keychain. Lets us stitch
  // pre-signup events to the eventual user_id once they auth.
  anonymous_id: z.string().min(8).max(120).optional(),
});

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/analytics/event',
    {
      preHandler: [optionalAppUser],
      // Modest rate limit — a client shouldn't fire more than ~30/min
      // under normal use. Anything higher is instrumentation gone wrong
      // or abuse.
      config: {
        rateLimit: {
          max: 120,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const parsed = EVENT_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const name = parsed.data.name as AnalyticsEvent;
      if (!ALLOWED_CLIENT_EVENTS.has(name)) {
        return reply.code(400).send({ error: 'unknown_event', name: parsed.data.name });
      }

      // track() is fire-and-forget but we still await so the caller gets
      // a deterministic 200 after the local analytics_events row is
      // written (PostHog dispatch is buffered inside).
      await track(name, {
        userId: req.appUser?.id ?? null,
        anonymousId: parsed.data.anonymous_id ?? null,
        properties: parsed.data.properties ?? {},
      });
      return reply.send({ ok: true });
    },
  );
}
