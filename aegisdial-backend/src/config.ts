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

  // Email Shield — Gmail OAuth. Required only when Email Shield is
  // launched; until then the GmailProvider throws a clear "not
  // configured" error if any route reaches it. Three values:
  //   - GOOGLE_OAUTH_CLIENT_ID: from Google Cloud Console > APIs &
  //     Services > Credentials > OAuth 2.0 Client IDs (Web app)
  //   - GOOGLE_OAUTH_CLIENT_SECRET: same console
  //   - GOOGLE_OAUTH_REDIRECT_URI: the route that handles the OAuth
  //     callback (e.g., https://api.aegisdial.com/v1/email/oauth/google/callback)
  // Scope is locked to gmail.readonly + email + openid — we classify,
  // we never modify. Documented in iOS permission-prompt copy.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),

  // Email Shield — Microsoft Graph OAuth (Outlook.com + Microsoft
  // 365 + Live.com + Hotmail.com — Microsoft consolidated all four
  // consumer mail endpoints under Graph). Three values:
  //   - MICROSOFT_OAUTH_CLIENT_ID: Azure App registration > Auth >
  //     Web platform, single-tenant 'common' (lets consumer +
  //     Workspace accounts both link)
  //   - MICROSOFT_OAUTH_CLIENT_SECRET: from the same App registration
  //   - MICROSOFT_OAUTH_REDIRECT_URI: must match the registered
  //     redirect URI exactly (e.g.,
  //     https://api.aegisdial.com/v1/email/oauth/microsoft/callback)
  // Scope locked to offline_access + Mail.Read + User.Read; we
  // explicitly do NOT request Mail.ReadWrite, Mail.Send, or any
  // write-bearing scope.
  MICROSOFT_OAUTH_CLIENT_ID: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_OAUTH_REDIRECT_URI: z.string().optional(),

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

  // Have I Been Pwned — breach-exposure check for Email Shield
  // Pillar 3 (/v1/email/compromise-check). Optional — Pro-tier
  // feature degrades gracefully without it (the finding object
  // returns `reason_skipped: 'no_api_key'` and the composite verdict
  // falls back to the four configuration-level detectors). Key is
  // purchased per-month from haveibeenpwned.com/API/Key and ships
  // as a Fly secret. NEVER log this value.
  HIBP_API_KEY: z.string().optional(),

  // Identity Shield I-P3a — Enzoic credential-exposure API
  // (separate channel from the legacy ENZOIC_API_KEY/SECRET that
  // backs src/lib/enzoic.ts's per-call exposure surface). The
  // Identity Shield ingest worker reads these on its daily batch
  // path: /credentials/exposures with HTTP Basic auth using the
  // (KEY:SECRET) pair. Both optional — when either is missing the
  // worker logs "no enzoic creds, skipping" once at startup and
  // continues running its HIBP and catalog-sync paths.
  //
  // Operator note: as of cutover plan we expect the same Enzoic
  // account to back both — populate both pairs for now. Keeping the
  // env-var names distinct lets us issue a separate API key for
  // Identity Shield post-BD-contract without disturbing Email
  // Shield's calibration. NEVER log either value.
  EMAIL_SHIELD_ENZOIC_API_KEY: z.string().optional(),
  EMAIL_SHIELD_ENZOIC_SECRET: z.string().optional(),

  // Identity Shield I-M2 — Enzoic per-day user-scan cap.
  //
  // The daily Enzoic batch worker (scanAllUsersEnzoicOnce) scans
  // every active email monitor by default. At ~100k users with ~1
  // email each, an unbounded daily run can runaway in cost and
  // rate-budget. When set, the worker shuffles the user list and
  // scans only the first N users that day. Over a 7-day window
  // every user gets sampled at least once at default sub-cap of
  // ~5000/day for ~35k users. Default unset = no cap (legacy
  // behavior for sub-launch + test).
  ENZOIC_DAILY_USER_CAP: z.coerce.number().int().positive().optional(),

  // Identity Shield I-P3b — Telegram chatter listener bot fleet.
  //
  // Up to 5 rotating Telegram bot accounts feed the chatter listener
  // worker (src/workers/telegramChatterListener.ts). Each account is a
  // tuple of (api_id, api_hash, phone_e164, session) — api_id +
  // api_hash come from https://my.telegram.org > API Development Tools;
  // phone is the burner SIM the account was registered against; session
  // is a gramjs StringSession blob persisted between worker restarts so
  // we don't trigger MTProto auth-flow on every reboot.
  //
  // SCAFFOLD SEMANTICS: every variable below is .optional(). When NO
  // account triples are populated, the worker logs "Telegram bot fleet
  // empty — listener will be a no-op" once at startup and idles.
  // Partial fleets (e.g., accounts 1 + 2 populated, 3-5 empty) work fine
  // — the worker round-robins across populated accounts.
  //
  // OPS RUNBOOK:
  //   - SIMs are burner-grade, rotated quarterly to dodge account bans.
  //   - api_id/api_hash are per-account (NOT shared across the fleet) so
  //     a Telegram TOS strike against one account doesn't taint the rest.
  //   - SESSION is regenerated by the operator runbook one-time after a
  //     SIM rotation and stored as a Fly secret. NEVER commit a session
  //     blob to git — it's the cryptographic credential.
  //   - Worker marks an account "dead" after 2 consecutive session-
  //     restore failures and fails over to remaining accounts. Operator
  //     alert fires when fleet liveness drops below 2/5.
  TELEGRAM_BOT_ACCOUNT_1_API_ID: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_1_API_HASH: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_1_PHONE: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_1_SESSION: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_2_API_ID: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_2_API_HASH: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_2_PHONE: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_2_SESSION: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_3_API_ID: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_3_API_HASH: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_3_PHONE: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_3_SESSION: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_4_API_ID: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_4_API_HASH: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_4_PHONE: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_4_SESSION: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_5_API_ID: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_5_API_HASH: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_5_PHONE: z.string().optional(),
  TELEGRAM_BOT_ACCOUNT_5_SESSION: z.string().optional(),

  // Identity Shield I-P3c — darknet market crawler Tor proxy.
  //
  // The crawler (src/workers/darknetMarketCrawler.ts) routes every HTTP
  // GET through a SOCKS5 Tor proxy hosted out-of-band on a Hetzner VPS
  // (NOT Fly — Fly's TOS doesn't love Tor exit-adjacent traffic). When
  // either var is unset the worker logs "Darknet crawler disabled — no
  // Tor proxy configured" once at startup and idles forever. That is
  // the dev/CI default so nothing accidentally reaches .onion hosts
  // from a developer laptop.
  //
  // OBSERVER-ONLY POSTURE — load-bearing for legal posture:
  //   The crawler is a READ-ONLY consumer of public market listing
  //   pages. It NEVER posts, NEVER bids, NEVER creates an account,
  //   NEVER pays for vendor-buyer-bonds, NEVER initiates contact with
  //   sellers. Architecturally enforced — the worker's HTTP wrapper
  //   only allows GET, and there is no write path against any market.
  //   See db/migrations/072_threat_intel_channels.sql header for the
  //   broader OBSERVER-ONLY architectural invariant set.
  //
  // OPS RUNBOOK:
  //   - Tor SOCKS5 proxy fleet (3 exit nodes) lives on a separate VPS
  //     provider (Hetzner). Proxy rotation is handled inside the
  //     fleet, not by the worker — the worker sees one stable
  //     host:port endpoint and the fleet load-balances behind it.
  //   - NEVER log either value. They identify our crawler infra; an
  //     attacker who learns the endpoint could DDoS our Tor entry.
  DARKNET_CRAWLER_TOR_SOCKS5_HOST: z.string().optional(),
  DARKNET_CRAWLER_TOR_SOCKS5_PORT: z.coerce.number().int().min(1).max(65535).optional(),

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
  APPLE_CLIENT_ID: z.string().default('com.aegisdial.app'),
  APP_ATTEST_BUNDLE_ID: z.string().default('com.aegisdial.app'),
  APP_ATTEST_ENV: z.enum(['development', 'production']).default('development'),

  // Apple StoreKit verification — all optional until App Store Connect is wired.
  APPLE_BUNDLE_ID: z.string().default('com.aegisdial.app'),
  APPLE_APP_APPLE_ID: z.coerce.number().int().optional(),
  APPLE_STOREKIT_ENV: z.enum(['sandbox', 'production']).default('sandbox'),

  // Stripe — optional until account is created. Webhook signature verification
  // is skipped (with a loud warning) when the secret is missing.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Shared secret for the RevenueCat → backend webhook. Configure in
  // RevenueCat dashboard → Project Settings → Integrations → Webhook,
  // set Authorization header to `Bearer <this-value>`. Without this,
  // /subscription/revenuecat/webhook 503's rather than silently
  // accepting unsigned events as authentic.
  REVENUECAT_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_MONTHLY_PRICE_ID: z.string().optional(),
  STRIPE_YEARLY_PRICE_ID: z.string().optional(),
  STRIPE_FAMILY_PLUS_MONTHLY_PRICE_ID: z.string().optional(),
  // Recovery Concierge subscription tier ($99/mo, $899/yr).
  // Same Pro entitlement as the basic tier; marketed as "Dedicated
  // agent + priority." Backend doesn't gate any code paths on this
  // tier yet — feature differentiation is UI/SLA only for now.
  STRIPE_RECOVERY_MONTHLY_PRICE_ID: z.string().optional(),
  STRIPE_RECOVERY_YEARLY_PRICE_ID: z.string().optional(),

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
  // Emergency kill-switch — when true, every A2 retry-attempt is
  // routed to the daily digest regardless of caps. Flip to fail
  // closed during a Redis outage or a confirmed push-spam event
  // without a deploy. Surfaced via the rate-limit decision
  // (`reason: 'kill_switch'`) so observability dashboards show it.
  V3_A2_RETRY_NOTIFY_KILL_SWITCH: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

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
  // B4 Layer 2 — web-search verifier. Independent of V3_B4_ENABLED so we
  // can keep Layer 1 (curated directory) live in production while testing
  // Layer 2 with smaller cohorts. OFF by default because L2 burns paid
  // API calls (Serper + Claude) per claim.
  V3_B4_LAYER2_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // Per-session cap on L2 verifications. Beyond this, additional claims
  // skip L2 and return cannot_verify. Bursty extraction (e.g. a
  // monologue-heavy scammer) shouldn't burn the entire daily Serper
  // budget on one call.
  V3_B4_LAYER2_PER_SESSION_CAP: z.coerce.number().int().positive().default(8),
  // Cache TTL for L2 verifications keyed by claim signature. One hour
  // is long enough to absorb call-campaign repetition (same scammer
  // claiming "Wells Fargo" across 200 calls) and short enough to
  // pick up curated overrides via the routine refresh path.
  V3_B4_LAYER2_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  // Adaptive transcript-flush cadence — the response from
  // /v1/live-shield/:id/transcript carries a `next_flush_ms` that
  // iOS uses to decide when to send the next chunk. Default cadence
  // by risk level:
  //   low (0–24)      → 8000 ms — same as v2's static cadence
  //   medium (25–49)  → 5000 ms — start tightening when red flags appear
  //   high (50–74)    → 3000 ms — close to takeover; we want responsiveness
  //   critical (≥75)  → 2000 ms — every second of detection latency hurts
  // Also: any session with B4 claim activity tightens to at least medium
  // even when score hasn't crossed thresholds yet (so an impersonation
  // call doesn't get the slow cadence while we're still verifying).
  V3_FLUSH_MS_LOW:      z.coerce.number().int().positive().default(8000),
  V3_FLUSH_MS_MEDIUM:   z.coerce.number().int().positive().default(5000),
  V3_FLUSH_MS_HIGH:     z.coerce.number().int().positive().default(3000),
  V3_FLUSH_MS_CRITICAL: z.coerce.number().int().positive().default(2000),

  // B5 — Family one-tap join via direct dial
  V3_B5_ENABLED: z.string().default('false').transform((v) => v === 'true'),

  // ===================================================================
  // Live Shield v4 — Playbook-Aware Live Shield (Phase 0)
  // ===================================================================
  //
  // v4 makes (playbook_id, stage, stage_confidence) a first-class tuple
  // alongside v2's risk score. Rollout posture: AUGMENTATION, not
  // replacement. v2's months of calibration are preserved.

  // Master kill switch for the playbook-aware classifier. OFF in
  // production until Dean reviews + cohort rollout.
  V4_PLAYBOOK_AWARE_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // Claude model for stage classification. Default Haiku 4.5 — the
  // same model B4 already uses for claim extraction. Smaller models
  // would be faster + cheaper but Haiku's reasoning is needed to
  // distinguish, e.g., bank_impersonation vs. utility_shutoff in the
  // first 30 seconds when authority cues haven't fully landed yet.
  V4_PLAYBOOK_CLASSIFIER_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  // Minimum classifier confidence to commit a (playbook, stage)
  // transition to call_sessions. Below this, we update audit but
  // keep the prior tuple stable to avoid flapping. 0.55 calibrated
  // from early-call ambiguity: chunks that mention "your bank" alone
  // don't yet clear; chunks that add "wire transfer to a safe
  // account" do.
  V4_PLAYBOOK_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.55),
  // Cooldown between classifier calls per session. The classifier is
  // expensive (Claude API call). Even on critical-cadence sessions
  // we don't need to re-classify every 2 seconds — playbook + stage
  // change at multi-second scales, not per-chunk. 8s matches the
  // low-risk transcript-flush cadence floor.
  V4_PLAYBOOK_CLASSIFY_DEBOUNCE_MS: z.coerce.number().int().positive().default(8000),
  // Latency budget for the classifier call. Beyond this, abort and
  // emit `v4.classifier.timeout`. Higher than B4's 3s because stage
  // classification reasons over more context (recent chunks +
  // current state).
  V4_PLAYBOOK_CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Per-session cap on classifier calls. Prevents an adversarial
  // session from burning the entire daily Anthropic budget. At 8s
  // debounce, this allows ~13 minutes of continuous classification.
  V4_PLAYBOOK_CLASSIFIER_PER_SESSION_CAP: z.coerce.number().int().positive().default(100),

  // -------------------------------------------------------------------
  // Live Shield v4 — Phase 2 — downstream consumption flags
  // -------------------------------------------------------------------

  // Per-playbook-stage score boost. When the classifier locks onto a
  // high-danger stage (ask/close) with confidence above the floor, the
  // session's v4_score_boost is incremented and the next risk-merge
  // pass adds it to the merged regex+LLM score. Default OFF — when v4
  // first ships in prod we want the tuple visible to dashboards before
  // we let it move the risk score. Flip when calibration data shows
  // the (stage='ask', confidence>=0.7) boost is reliable.
  V4_PLAYBOOK_SCORE_BOOST_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // Confidence floor for v4 score boost. Above MIN_CONFIDENCE (which
  // gates the COMMIT itself) but below 1.0. Calibrated higher than the
  // commit floor (0.55) because moving the risk score is more
  // consequential than just labeling the session — we want to boost
  // only when the classifier is confident, not merely confident-enough-
  // to-record.
  V4_SCORE_BOOST_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  // Boost when stage transitions into 'ask'. Above the floor but well
  // below the 25-point gap between high-risk levels — the boost is a
  // nudge, not an override. 15 puts a calibrated mid-50s session into
  // the high-70s without our regex/LLM signals having to agree.
  V4_SCORE_BOOST_ASK: z.coerce.number().int().min(0).max(100).default(15),
  // Boost when stage transitions into 'close'. Smaller than 'ask'
  // because by close-stage the v3 detectors have usually already fired;
  // this is a defense-in-depth boost for the rare path where the
  // classifier locks on late.
  V4_SCORE_BOOST_CLOSE: z.coerce.number().int().min(0).max(100).default(10),
  // Enrich family-alert message bodies with playbook context. Reads
  // v4_playbook_id off call_sessions at alert-fire time and adds a
  // playbook-specific blurb to the default/open privacy-level message
  // bodies (minimal-privacy bodies stay minimal regardless). Default
  // OFF — copy needs review before family members start receiving it.
  V4_PLAYBOOK_FAMILY_ALERT_COPY_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // Preload Recovery Concierge with the playbook + stage detected at
  // call end. Lets the recovery flow start with playbook-specific
  // steps instead of generic triage. Default OFF — Recovery Concierge
  // catalog needs the per-playbook checkpoint mapping locked in
  // before this flips. Persistence via v4_playbook_id /
  // v4_stage columns is unconditional; only the read-side is gated.
  V4_PLAYBOOK_RECOVERY_PRELOAD_ENABLED: z.string().default('false').transform((v) => v === 'true'),

  // -------------------------------------------------------------------
  // Live Shield v4 — Phase 3 — actionable coaching + recap surfaces
  // -------------------------------------------------------------------

  // Surface playbook counter-scripts (proven hang-up phrases) on the
  // per-chunk transcript response. iOS displays these inline as
  // "Say this to make them hang up" coaching cards once the
  // classifier has locked onto a playbook with sufficient confidence.
  // Gated separately from V4_PLAYBOOK_AWARE_ENABLED so we can run the
  // classifier in shadow mode and turn user-visible coaching on only
  // when the playbook lock is stable for early-detection sessions.
  V4_PLAYBOOK_COACHING_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // Minimum classifier confidence required to surface counter-scripts.
  // Higher than the commit floor (0.55) but matches the score-boost
  // floor (0.7) — same calibration logic: we want to coach Mom only
  // when we're confident, not just confident-enough-to-label.
  V4_PLAYBOOK_COACHING_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  // Maximum number of counter-scripts to surface per response. Caps
  // iOS payload size + UX clutter — Mom can read 3 short lines on a
  // call, not 6. Playbook seeds order strongest-first, so top-N is
  // the strongest-N. Tunable for A/B tests.
  V4_PLAYBOOK_COACHING_MAX_LINES: z.coerce.number().int().min(1).max(10).default(3),

  // -------------------------------------------------------------------
  // Live Shield v4 — Phase 4 — stage-transition takeover trigger
  // -------------------------------------------------------------------

  // Fire a critical-takeover push the INSTANT the classifier locks
  // onto a high-danger stage (ask/close) with high confidence — don't
  // wait for the risk-score merge to catch up. The classifier already
  // knows the scammer is asking for money; v3's risk-merge takes ~1
  // chunk of latency to reflect that signal in finalScore. This trigger
  // closes that gap.
  //
  // Composes with V3_B3_ENABLED — when B3 is off there is no iOS
  // takeover surface, so this trigger no-ops at the enqueue layer.
  // Default OFF — we want stable calibration of the score-boost path
  // (Phase 2C) before letting the classifier directly drive push.
  V4_STAGE_TAKEOVER_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // Higher than score-boost floor (0.7) and coaching floor (0.7) —
  // takeover interrupts Mom's call, so a false-positive trigger is
  // way more user-disruptive than a wrong score-boost or coaching
  // card. 0.8 calibrated to be one notch above "we'd boost the score"
  // — every fired takeover should pass the boost gate too.
  V4_STAGE_TAKEOVER_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),

  // -------------------------------------------------------------------
  // Live Shield v4 — Phase 5 — B4 claim grounding by playbook
  // -------------------------------------------------------------------

  // Inject the locked-on playbook into B4's claim-extractor prompt
  // as a NON-DESTRUCTIVE bias signal — "for this playbook, pay extra
  // attention to these claim types, but extract any of the six if
  // you see them." Tightens B4's signal on playbook-stereotyped
  // claims (case_number on irs_impersonation; bank_affiliation on
  // bank_impersonation) without dropping any of B4's existing
  // coverage. Default OFF; flip after the calibration period
  // confirms claim-rate metrics don't shift unexpectedly.
  V4_B4_PLAYBOOK_GROUNDING_ENABLED: z.string().default('false').transform((v) => v === 'true'),

  // Phase 6 sibling — inject the playbook into B4's Layer 2 Claude
  // verifier user prompt. Adds prior context ("this call has been
  // classified as a bank-impersonation script") so the verifier
  // weighs search-result evidence with that prior in mind.
  // CRITICAL: the verifier's verdict rules are NOT relaxed — a
  // "contradicted" verdict still requires direct evidence in the
  // search results. The playbook context just helps the verifier
  // focus its attention. Default OFF.
  V4_B4_VERIFIER_GROUNDING_ENABLED: z.string().default('false').transform((v) => v === 'true'),

  // -------------------------------------------------------------------
  // Live Shield v4 — Phase 7 — demographic priors plumbing
  // -------------------------------------------------------------------

  // Plumb the caller's age band (derived from users.dob_year) into the
  // classifier prompt as a tie-breaker. Each playbook seed carries a
  // demographic_priors tuple {elderly, working_adult, young} summing
  // to 1.0; this flag controls whether those numbers + the caller's
  // age band are actually surfaced to the classifier. Default OFF —
  // when on, the classifier uses age band ONLY as a tie-break for
  // ambiguous chunks; it does not let demographic alone decide the
  // playbook (rule pinned in the system prompt itself).
  V4_PLAYBOOK_DEMOGRAPHIC_PRIORS_ENABLED: z.string().default('false').transform((v) => v === 'true'),

  // -------------------------------------------------------------------
  // Live Shield v4 — Phase 8 — B3 sentinel playbook gate-bypass
  // -------------------------------------------------------------------

  // When the v4 classifier has locked on to a playbook that ALREADY
  // implies the scammer-context expected by a B3 sentinel pattern
  // (e.g. irs_impersonation implies "SSN/tax-ID was discussed"),
  // bypass the pattern's required_scammer_context_regex gate and
  // fire on raw pattern match alone. The classifier's playbook lock
  // is the context. Closes a real false-negative gap — without this,
  // the rolling-window context phrase can prune off before Mom
  // discloses, and the takeover never fires.
  // Default OFF — when on, calibration kicks in via the curated
  // SENTINEL_PLAYBOOK_BYPASS map in src/data/sentinelPlaybookBypass.ts.
  V4_PLAYBOOK_B3_GATE_BYPASS_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // Confidence floor for the bypass path. Calibrated HIGHER than the
  // commit threshold (V4_PLAYBOOK_MIN_CONFIDENCE=0.55) AND higher
  // than the score-boost floor (0.7). Bypassing a B3 gate fires the
  // full takeover surface (full-screen iOS interrupt + critical APNs +
  // family alert + audit event) — a false-positive playbook lock at
  // 0.6 should NOT unlock that, even if the pattern matched.
  // 0.75 covers the realistic operational range without exposing the
  // takeover surface to weakly-classified sessions.
  V4_PLAYBOOK_B3_GATE_BYPASS_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),

  // -------------------------------------------------------------------
  // Live Shield v4 — Phase 9 — playbook-derived recovery scam_type
  // -------------------------------------------------------------------

  // When the /end-route auto-handoff creates a recovery_session in
  // triage mode AND v4 has classified the call at sufficient
  // confidence, prefer the v4-mapped scam_type over llmScamType
  // (or 'unknown_triage'). This pre-populates the scam_type field
  // so the triage→recovery conversion seeds playbook-appropriate
  // recovery steps automatically (e.g. IRS-specific step list when
  // v4 detected irs_impersonation), instead of forcing the user to
  // pick during triage resolve.
  // Default OFF — when on, the mapping in src/lib/playbookToScamType.ts
  // drives the substitution.
  V4_PLAYBOOK_RECOVERY_SCAM_TYPE_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // Confidence floor for the v4 scam_type substitution. Calibrated
  // at 0.7 — same as the score-boost floor. A 0.55-confidence v4
  // commit isn't strong enough to override the LLM's scam_type
  // classification, which was calibrated against months of v2 data.
  V4_PLAYBOOK_RECOVERY_SCAM_TYPE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),

  // -------------------------------------------------------------------
  // Live Shield v4 — Phase 10 — stage-timing telemetry
  // -------------------------------------------------------------------

  // Compare each stage transition's actual elapsed time against the
  // playbook seed's typical_duration_seconds and emit a metric tagged
  // by playbook+stage+verdict (in_range / too_fast / too_slow). Pure
  // observability — no behavior change. Default ON because metrics
  // are safe and the data is needed to calibrate the rest of the v4
  // flags before any of them can flip in prod. The flag exists for
  // emergency kill-switch if metric volume becomes a cost concern;
  // upper bound is ~1 metric per classifier commit, bounded by the
  // 8s debounce and the 100/24h per-session cap.
  //
  // CONVENTION NOTE: this is the only V4_PLAYBOOK_*_ENABLED flag that
  // defaults TRUE. The "all v4 features dormant by default" invariant
  // is preserved at the system level — the classifier itself is
  // gated on V4_PLAYBOOK_AWARE_ENABLED (default false), and the
  // subscriber early-returns on it at playbookSubscriber.ts. No
  // timing metrics emit until ops flips the master flag. The
  // default-TRUE here means "when master flag is on, emit by default"
  // — operator doesn't have to flip two switches to start collecting
  // calibration data.
  V4_PLAYBOOK_STAGE_TIMING_TELEMETRY_ENABLED: z.string().default('true').transform((v) => v === 'true'),

  // Live Shield v4 — Phase 12 — B4 × playbook claim-expectation diff
  // telemetry. Emits v4.b4.claim_extracted_vs_playbook{playbook_id,
  // claim_type, expected} on every successful B4 extraction that
  // happens while a v4 playbook lock is active. The aggregated view
  // (GET /admin/v4/claim-coverage) surfaces calibration gaps:
  //   - gap:      playbook expects claim type X, never sees X
  //   - surprise: LLM extracts type Y that playbook doesn't expect
  // Volume bound: ≤6 emits per extraction (one per extracted claim),
  // gated upstream by the 5s B4 cost-gate, the M-12 shouldExtract
  // heuristic, and V4_PLAYBOOK_AWARE_ENABLED master flag.
  //
  // Same default-TRUE convention as V4_PLAYBOOK_STAGE_TIMING_TELEMETRY_ENABLED
  // — see that flag's CONVENTION NOTE. Master gate
  // V4_PLAYBOOK_AWARE_ENABLED (default false) keeps everything
  // dormant in prod until ops flips it.
  V4_B4_CLAIM_COVERAGE_TELEMETRY_ENABLED: z.string().default('true').transform((v) => v === 'true'),

  // -------------------------------------------------------------------
  // Recovery Shield — R-P3b chain-API keys
  //
  // Crypto-trace agent (src/services/recovery/cryptoTraceAgent.ts) pulls
  // on-chain transaction history via Etherscan-compatible explorers
  // (one API key per EVM chain), Blockchair (Bitcoin), TronScan (Tron),
  // and a Solana RPC endpoint (Helius / Solscan / public RPC).
  //
  // ALL OPTIONAL: every key has the same graceful-degradation contract.
  // A missing key → src/lib/chainFetch.ts returns [] for that chain and
  // logs a one-shot warning at boot. Hops still get persisted to
  // trace_report_jsonb (with hops_analyzed=0), so the case row exists
  // and is visible in admin/operator surfaces. Operators flip the keys
  // on per-chain as BD lands the API contracts.
  //
  // SECURITY: never log these values. The chain-fetch helper redacts
  // them out of error messages on its own; everything upstream must
  // not echo the raw config object.
  ETHERSCAN_API_KEY: z.string().optional(),
  ARBSCAN_API_KEY: z.string().optional(),
  OPTIMISM_API_KEY: z.string().optional(),
  BASESCAN_API_KEY: z.string().optional(),
  POLYGONSCAN_API_KEY: z.string().optional(),
  BSCSCAN_API_KEY: z.string().optional(),
  BLOCKCHAIR_API_KEY: z.string().optional(),
  TRONSCAN_API_KEY: z.string().optional(),
  SOLANA_RPC_URL: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Production refuses to boot with dev-only defaults still in place. Each
// of these has a permissive default so local dev works out of the box,
// but shipping any of them to prod is a footgun (universal forge keys,
// known-secret JWTs, "everyone is a pro user" bearer shortcut). Fail
// loudly at boot rather than ship a deceptively-running app.
if (parsed.data.NODE_ENV === 'production') {
  const errors: string[] = [];
  if (parsed.data.JWT_SECRET === 'dev-only-jwt-secret-change-me-immediately-in-production-12345') {
    errors.push('JWT_SECRET is still the dev default — set a real 32+ byte secret');
  }
  if (parsed.data.DATA_ENCRYPTION_KEY === 'ZGV2LW9ubHkta2V5LWRvLW5vdC11c2UtaW4tcHJvZC1lbnYtMzI=') {
    errors.push('DATA_ENCRYPTION_KEY is still the dev default — generate a real AES-256 key');
  }
  if (parsed.data.ALLOW_DEV_BEARER) {
    errors.push('ALLOW_DEV_BEARER must be false in production (universal forge key)');
  }
  if (errors.length > 0) {
    console.error('Refusing to boot in production with dev-only config:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
}

export const config = parsed.data;
export type Config = typeof config;
