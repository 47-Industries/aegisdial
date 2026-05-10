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

  // ========================================================================
  // Live Shield v3 — feature flags and tunables
  //
  // All v3 features ship behind individual flags so they can be rolled
  // out (and rolled back) per cohort without an app release. Default
  // OFF in production; flip to ON via Fly secrets after each phase ships.
  // ========================================================================

  // A1 — Pre-call warning + sources panel
  V3_A1_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // Top-N for the iOS Call Directory Extension's on-device cache.
  // Apple's CallKit identification entries are uncapped; we limit by
  // bandwidth + iOS extension memory, not by Apple's rules. Tune up
  // post-launch if hot-numbers coverage is too narrow.
  V3_A1_HOT_NUMBERS_CACHE_SIZE: z.coerce.number().int().positive().default(10000),
  // Cron interval for the populator job. 6h is a reasonable starting
  // point — short enough to keep the cache fresh during active scam
  // campaigns, long enough that nightly Reddit/BBB scrapes get folded in.
  V3_A1_CACHE_RECOMPUTE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(360),

  // A2 — User-blocked numbers OS-enforced
  V3_A2_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // Per-user retry-notification rate limit (block_notify:rate:{user_id} day key).
  // Beyond this, additional retries from blocked numbers roll into a daily
  // digest rather than firing individual pushes.
  V3_A2_RETRY_NOTIFY_RATE_PER_24H: z.coerce.number().int().positive().default(3),
  // Per-(user, e164) hourly coalesce — autodialer pattern protection.
  V3_A2_RETRY_NOTIFY_PER_NUMBER_HOURLY: z.coerce.number().int().positive().default(1),

  // B3 — Visual takeover at moment of compromise
  V3_B3_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // Sticky duration before the "I'm safe" button fades in (seconds).
  // Five seconds is the locked design — long enough to interrupt scammer
  // pressure scripts, short enough to not feel paternalistic.
  V3_B3_STICKY_SECONDS: z.coerce.number().int().nonnegative().default(5),
  // 'I'm safe' long-press duration to confirm dismiss. Three seconds
  // prevents both accidental dismiss and scammer-rushed dismiss.
  V3_B3_DISMISS_LONG_PRESS_SECONDS: z.coerce.number().int().nonnegative().default(3),
  // Continuous-critical state required after dismiss before the post-dismiss
  // family alert auto-fires. The dismiss isn't the end of protection;
  // family backup is the safety net.
  V3_B3_POST_DISMISS_FAMILY_ALERT_SECONDS: z.coerce.number().int().nonnegative().default(30),
  // Mom-side STT (whisper) for the sentinel matcher. Disable as a runtime
  // kill switch if Whisper costs spike. With this off, B3 degrades to
  // Live-Shield-critical-only triggering (no sentinel pattern detection).
  V3_B3_MOM_SIDE_STT_ENABLED: z.string().default('true').transform((v) => v === 'true'),

  // B4 — Real-time fact-checking the caller
  V3_B4_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // Confidence threshold for firing a takeover on a contradicted finding.
  // 0.95 is the locked launch value; tunable down with post-call user
  // feedback once Claude calibration is observed.
  V3_B4_TAKEOVER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.95),
  // Weight of low-confidence contradicted findings into Live Shield's
  // running score. Pushes B3's critical trigger when multiple weak signals
  // stack — an alternative escalation path to the direct B4 takeover.
  V3_B4_SCORE_BOOST_LOW_CONF_WEIGHT: z.coerce.number().min(0).max(1).default(0.15),
  // Same idea for cannot_verify findings. Smaller weight; a verifier
  // shrug shouldn't push toward critical the way an actual contradiction
  // should.
  V3_B4_SCORE_BOOST_CANNOT_VERIFY_WEIGHT: z.coerce.number().min(0).max(1).default(0.05),

  // B5 — Family one-tap join via direct dial
  V3_B5_ENABLED: z.string().default('false').transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
