import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().min(5),
  REDIS_URL: z.string().min(5),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  // "From" number / messaging service SID for outbound SMS via Twilio.
  // The guardian-alert escalator worker reads this to send a text
  // fallback when a critical alert has gone unread for 15+ minutes.
  // Absent → escalator no-ops (alerts still land in-DB + push).
  TWILIO_MESSAGING_FROM: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USER_AGENT: z
    .string()
    .default('AegisDial/0.1 (by /u/aegisdial) consumer-fraud-protection'),

  FCC_APP_TOKEN: z.string().optional(),
  SERPER_API_KEY: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  GOOGLE_SAFE_BROWSING_API_KEY: z.string().optional(),

  // Ekata Pro Insight Phone Intelligence v2 — full subscriber +
  // address enrichment for phone lookups. Optional; gated by presence
  // of the API key.
  EKATA_API_KEY: z.string().optional(),

  // Enzoic — breach / dark-web exposure monitoring.
  // When API creds are absent we fall back to a deterministic mock
  // source so the rest of the stack still renders in dev and tests.
  ENZOIC_API_KEY: z.string().optional(),
  ENZOIC_API_SECRET: z.string().optional(),
  ENZOIC_MOCK: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // IPQualityScore — phone fraud / spam-risk cross-check. Optional;
  // provides `fraud_score` we surface as `spam_risk_score`.
  IPQS_API_KEY: z.string().optional(),

  // Observability — Sentry and PostHog. All optional so dev + tests
  // run without any vendor accounts.
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().default('https://us.i.posthog.com'),

  // Resend for transactional email. RESEND_FROM is the sender address
  // that must be verified in your Resend dashboard.
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default('AegisDial <alerts@aegisdial.com>'),

  // APNs (Apple Push). All four must be set for push to fire; absent
  // means the push worker runs but no-ops (alerts still land in-DB).
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_KEY_P8: z.string().optional(),  // PEM contents, not a file path
  APNS_PRODUCTION: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  API_SHARED_SECRET: z.string().min(8),
  // Password gating /internal/* — the founder KPI dashboard. Optional
  // in dev so a fresh checkout boots without secrets; the dashboard
  // routes return 503 if it's unset rather than 200-with-no-password.
  // Must be set in any deploy that exposes the dashboard.
  INTERNAL_DASHBOARD_PASSWORD: z.string().min(8).optional(),
  // 32-byte AES-256 key, base64-encoded. Used for envelope-encrypting PII at
  // rest (monitored_identifiers.display_value, recovery_evidence.payload).
  // In dev we default to a deterministic key so local data stays readable
  // across restarts; prod MUST override via Fly secret.
  DATA_ENCRYPTION_KEY: z
    .string()
    .default('ZGV2LW9ubHkta2V5LWRvLW5vdC11c2UtaW4tcHJvZC1lbnYtMzI='),
  JWT_SECRET: z.string().min(32).default('dev-only-jwt-secret-change-me-immediately-in-production-12345'),
  APPLE_CLIENT_ID: z.string().default('com.aegiadial.ios'),
  APP_ATTEST_BUNDLE_ID: z.string().default('com.aegiadial.ios'),
  APP_ATTEST_ENV: z.enum(['development', 'production']).default('development'),

  // Apple StoreKit verification — all optional until App Store Connect is wired.
  APPLE_BUNDLE_ID: z.string().default('com.aegiadial.ios'),
  APPLE_APP_APPLE_ID: z.coerce.number().int().optional(),
  APPLE_STOREKIT_ENV: z.enum(['sandbox', 'production']).default('sandbox'),

  // Stripe — optional until account is created. Webhook signature verification
  // is skipped (with a loud warning) when the secret is missing.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_MONTHLY_PRICE_ID: z.string().optional(),
  STRIPE_YEARLY_PRICE_ID: z.string().optional(),
  STRIPE_FAMILY_PLUS_MONTHLY_PRICE_ID: z.string().optional(),

  ENABLE_TWILIO_LOOKUP: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  ENABLE_LLM_REFINE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  ENABLE_CRAWLERS: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  // Gate paid-API calls from the crawl pre-warmer (Twilio Lookup V2 +
  // Ekata + IPQS). The worker itself runs whenever ENABLE_CRAWLERS is
  // true, but without this additional flag it only fires the free
  // FCC/BBB/YouTube crawlers via liveCrawlUnknown — NOT the paid
  // lookupPhone enrichment. Flip to true only after confirming spend
  // caps are in place.
  ENABLE_CRAWL_PREWARM_LOOKUPS: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // Unlocks the "dev bearer" shortcut in src/lib/auth.ts where a
  // request carrying the API_SHARED_SECRET as a Bearer token is
  // authenticated as a synthetic pro user. Previously gated on
  // `NODE_ENV !== 'production'`, which was too permissive — a staging
  // / preview env with prod DB creds + this flag unset was a universal
  // forge key. Now off by default; must be explicitly flipped on in
  // local dev.
  ALLOW_DEV_BEARER: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
