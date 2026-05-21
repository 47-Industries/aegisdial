import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyRawBody from 'fastify-raw-body';
import { config } from './config.js';
import { initObservability, captureError, emitMetric } from './lib/observability.js';
import { shutdownAnalytics } from './lib/analytics.js';

// Init Sentry before anything that could throw.
initObservability();
import { verdictRoutes } from './routes/verdict.js';
import { reportRoutes } from './routes/report.js';
import { healthRoutes } from './routes/health.js';
import { publicWebRoutes } from './routes/publicWeb.js';
import { adminRoutes } from './routes/admin.js';
import { adminEmailShieldRoutes } from './routes/adminEmailShield.js';
import { authRoutes } from './routes/auth.js';
import { subscriptionRoutes } from './routes/subscription.js';
import { familyRoutes } from './routes/family.js';
import { recoveryRoutes } from './routes/recovery.js';
import { liveShieldRoutes } from './routes/liveShield.js';
import { smsClassifyRoutes } from './routes/smsClassify.js';
import { smsShieldRoutes } from './routes/smsShield.js';
import { emailShieldRoutes } from './routes/emailShield.js';
import { familyContactsRoutes } from './routes/familyContacts.js';
import { breachRoutes } from './routes/breach.js';
import { guardianRoutes } from './routes/guardian.js';
import { deviceRoutes } from './routes/device.js';
import { supportRoutes } from './routes/support.js';
import { statsRoutes } from './routes/stats.js';
import { heatmapRoutes } from './routes/heatmap.js';
import { banksRoutes } from './routes/banks.js';
import { analyticsRoutes } from './routes/analytics.js';
import { internalRoutes } from './routes/internal.js';
import { familyAlertPreferencesRoutes } from './routes/familyAlertPreferences.js';
// Live Shield v3 — A1 lookup + A2 user-block routes. Each register()
// is a no-op when its respective V3_*_ENABLED flag is OFF.
import { lookupRoutes } from './routes/lookup.js';
import { blocksRoutes } from './routes/blocks.js';
// Live Shield v3 — B3 critical-takeover routes + sentinel matcher
// fire-handler registration. Same V3_B3_ENABLED gate.
import {
  criticalTakeoverRoutes,
  registerCriticalTakeoverHandlers,
} from './routes/criticalTakeover.js';
import { startPostDismissWatcher, stopPostDismissWatcher } from './services/postDismissWatcher.js';
// Live Shield v3 — B4 routes + orchestrator. Same V3_B4_ENABLED gate.
import { findingsRoutes } from './routes/findings.js';
import { startB4Orchestrator, stopB4Orchestrator } from './services/b4Orchestrator.js';
// Live Shield v3 — B5 family-join routes. V3_B5_ENABLED gate.
import { familyJoinRoutes } from './routes/familyJoin.js';
// Live Shield v4 — Phase 1 — playbook subscriber + seed bootstrap.
// Subscribes to caller-side transcript chunks via v3SessionEvents
// and drives the stage classifier per session. Both no-op when
// V4_PLAYBOOK_AWARE_ENABLED is OFF.
import {
  startV4PlaybookSubscriber,
  stopV4PlaybookSubscriber,
} from './services/playbookSubscriber.js';
import { seedV4Playbooks } from './scripts/seedV4Playbooks.js';
// Live Shield v3 — family-transcript SSE stream (Gap #2 audit fix).
// Always registered (no flag gate): the route's content depends on
// what the producers (transcript route, emitSystemEvent) emit, which
// are themselves flag-gated upstream.
import { familyTranscriptStreamRoutes } from './routes/familyTranscriptStream.js';
import { startPushDispatcher, stopPushDispatcher } from './workers/pushDispatcher.js';
import { optionalAppUser } from './lib/auth.js';
import { shutdownDb } from './lib/db.js';
import { shutdownCache } from './lib/cache.js';
import { startScheduler, stopScheduler } from './workers/scheduler.js';
import { startBreachRescanner, stopBreachRescanner } from './workers/breachRescanner.js';
import { startRecoveryFollowup, stopRecoveryFollowup } from './workers/recoveryFollowupWorker.js';
import { startRetentionSweeper, stopRetentionSweeper } from './workers/retentionSweeper.js';
import { startBulkCrimeReporter, stopBulkCrimeReporter } from './workers/bulkCrimeReporter.js';
import { startCrawlPrewarmer, stopCrawlPrewarmer } from './workers/crawlPrewarmer.js';
// Live Shield v3 — A1 hot-numbers cache populator. Returns null when
// V3_A1_ENABLED is OFF; cron task does not register at all in that case.
import { startA1HotNumbersPopulator } from './workers/a1HotNumbersPopulator.js';
// Recovery Shield (R-P5 user routes, R-P6 admin routes). Routes are
// always registered; per-route auth + flag gates inside each handler
// govern behavior, matching the v3 lookup/blocks idiom.
import { recoveryShieldRoutes } from './routes/recoveryShield.js';
import { adminRecoveryShieldRoutes } from './routes/adminRecoveryShield.js';
// Identity Shield (I-P3 user routes, I-P7 admin routes + I-P3a/b/c +
// I-P5 + I-P6 workers). Same registration idiom — workers idle
// gracefully when their respective env vars (HIBP, Enzoic, Tor,
// Telegram fleet) are absent.
import { identityShieldRoutes } from './routes/identityShield.js';
import { adminIdentityShieldRoutes } from './routes/adminIdentityShield.js';
import {
  startIdentityShieldIngest,
  stopIdentityShieldIngest,
} from './workers/identityShieldIngest.js';
import {
  startTelegramListener,
  stopTelegramListener,
} from './workers/telegramChatterListener.js';
import {
  startDarknetCrawler,
  stopDarknetCrawler,
} from './workers/darknetMarketCrawler.js';
import {
  startIdentityShieldDigest,
  stopIdentityShieldDigest,
} from './workers/identityShieldDigest.js';
import {
  startThreatLandscapeAnalyst,
  stopThreatLandscapeAnalyst,
} from './workers/threatLandscapeAnalystWorker.js';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      config.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
  disableRequestLogging: false,
  trustProxy: true,
});

await app.register(helmet, { global: true });
// AegisDial is a native-iOS-only client. There is no browser page that
// ever talks to this API, so CORS preflight should be fully disabled —
// any browser hitting us is either the Stripe checkout redirect (hosted
// on stripe.com) or an attacker trying to pivot a compromised site's
// cookies. `origin: false` makes @fastify/cors reject the preflight
// with no ACAO header, which kills the browser request at the edge.
await app.register(cors, { origin: false });
await app.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute',
});

// Expose rawBody on requests that opt in via `config: { rawBody: true }`.
// Stripe webhook signature verification needs the exact unparsed payload.
await app.register(fastifyRawBody, {
  field: 'rawBody',
  global: false,
  encoding: 'utf8',
  runFirst: true,
});

// Resolve optional app user on every request so /auth/me can access req.appUser.
app.addHook('preHandler', optionalAppUser);

await app.register(healthRoutes);
await app.register(publicWebRoutes);
await app.register(authRoutes);
await app.register(subscriptionRoutes);
await app.register(familyRoutes);
await app.register(recoveryRoutes);
await app.register(liveShieldRoutes);
await app.register(smsClassifyRoutes);
await app.register(smsShieldRoutes);
await app.register(emailShieldRoutes);
await app.register(familyContactsRoutes);
await app.register(breachRoutes);
await app.register(guardianRoutes);
await app.register(deviceRoutes);
await app.register(supportRoutes);
await app.register(statsRoutes);
await app.register(heatmapRoutes);
await app.register(banksRoutes);
await app.register(verdictRoutes);
await app.register(reportRoutes);
await app.register(adminRoutes);
await app.register(adminEmailShieldRoutes);
await app.register(analyticsRoutes);
await app.register(internalRoutes);
await app.register(familyAlertPreferencesRoutes);
await app.register(lookupRoutes);
await app.register(blocksRoutes);
await app.register(criticalTakeoverRoutes);
// Wire the sentinel matcher's fire-handler into the takeover dispatch
// path. Idempotent + no-op when V3_B3_ENABLED is OFF.
registerCriticalTakeoverHandlers();
// Start the B3 post-dismiss watcher. Subscribes to risk-transition
// events from v3SessionEvents and drives per-session timers.
// Rehydrates any in-flight watches from the DB so a process restart
// mid-call doesn't drop the post-dismiss family-alert safety net.
// No-op when V3_B3_ENABLED is OFF.
await startPostDismissWatcher();
await app.register(findingsRoutes);
// Start the B4 orchestrator. Subscribes to scammer-side transcript
// chunks from v3SessionEvents and runs the extract → verify →
// dispatch pipeline. No-op when V3_B4_ENABLED is OFF.
startB4Orchestrator();
// v4 Phase 1: subscribe to caller-side chunks and run the stage
// classifier. No-op when V4_PLAYBOOK_AWARE_ENABLED is OFF, so this
// is safe to call unconditionally.
startV4PlaybookSubscriber();
// v4 Phase 1: sync the playbook library from canonical JS to the
// runtime DB mirror. Fire-and-forget — the classifier reads
// PLAYBOOKS from code, not from the DB, so a seed failure is not
// a boot blocker. The mirror exists for admin tools + future
// runtime tuning paths.
if (config.V4_PLAYBOOK_AWARE_ENABLED) {
  void seedV4Playbooks().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[v4 seed] failed', err);
  });
}
await app.register(familyJoinRoutes);
await app.register(familyTranscriptStreamRoutes);
// Recovery Shield R-P5 (user) + R-P6 (admin). Auth/flag gates live
// inside each handler — registering unconditionally matches the
// emailShield + lookup/blocks idiom.
await app.register(recoveryShieldRoutes);
await app.register(adminRecoveryShieldRoutes);
// Identity Shield I-P3 (user) + I-P7 (admin). Same idiom.
await app.register(identityShieldRoutes);
await app.register(adminIdentityShieldRoutes);

const scheduler = config.ENABLE_CRAWLERS ? startScheduler() : null;
const breachRescanner = startBreachRescanner();
const retentionSweeper = startRetentionSweeper();
const bulkCrimeReporter = startBulkCrimeReporter();
// Pre-warmer calls liveCrawlUnknown + lookupPhone for 200 stale numbers
// per hour. In tests / dev, ENABLE_CRAWLERS=false should suppress it
// (it would otherwise burn Twilio/Ekata/IPQS budget and fire real
// network traffic). Matches the gating on the main scheduler above.
const crawlPrewarmer = config.ENABLE_CRAWLERS ? startCrawlPrewarmer() : null;
const pushDispatcher = startPushDispatcher();
const recoveryFollowup = startRecoveryFollowup();
// Live Shield v3 — A1 hot-numbers populator. Cron interval governed by
// V3_A1_CACHE_RECOMPUTE_INTERVAL_MINUTES (default 6h). No-op when
// V3_A1_ENABLED is OFF.
const a1HotNumbersPopulator = startA1HotNumbersPopulator();
// Identity Shield I-P3a — HIBP catalog sync + per-user HIBP scan +
// Enzoic plaintext-password scan. Worker logs degraded mode and
// idles when HIBP_API_KEY / Enzoic keys are unset (dev/CI default).
const identityShieldIngest = startIdentityShieldIngest();
// Identity Shield I-P3b — Telegram scammer-services listener. Idles
// when TELEGRAM_BOT_ACCOUNT_N_* triples are unset or threat_intel
// channels table is empty (logged once at startup).
const telegramListener = startTelegramListener();
// Identity Shield I-P3c — Tor-proxied darknet market crawler. Idles
// when DARKNET_CRAWLER_TOR_SOCKS5_HOST/_PORT are unset (expected
// dev/CI default). Self-test runs at boot.
const darknetCrawler = startDarknetCrawler();
// Identity Shield I-P5 — daily/weekly push digest scheduler. Crons
// run unconditionally; sendDigestForUser short-circuits per-user
// when push tokens or cadence are absent.
const identityShieldDigest = startIdentityShieldDigest();
// Identity Shield I-P6 — AI meta-analyst (daily + quarterly). Boots
// idle and works off whatever the ingest/listener/crawler workers
// have produced.
const threatLandscapeAnalyst = startThreatLandscapeAnalyst();

app.setErrorHandler((err, req, reply) => {
  const fastifyErr = err as { statusCode?: number; code?: string; message: string };
  app.log.error({ err }, 'unhandled');
  const status = fastifyErr.statusCode ?? 500;
  // Send 5xx to Sentry with request context. Don't ship 4xx — they
  // are expected ("bad user input") and would drown the signal.
  if (status >= 500) {
    captureError(err, {
      method: req.method,
      url: req.url,
      user_id: req.appUser?.id ?? null,
    });
    void emitMetric('http.5xx', { route: req.routeOptions?.url ?? 'unknown' });
  }
  // Only surface message bodies for 4xx; 5xx may contain internal
  // details (pg error text, stack fragments) that must not leak.
  const safeMessage =
    status < 500 ? fastifyErr.message : 'An internal error occurred.';
  reply.code(status).send({
    error: fastifyErr.code ?? (status >= 500 ? 'internal_error' : 'error'),
    message: safeMessage,
  });
});

// Lightweight per-request metric: one counter per 2xx/4xx/5xx route.
app.addHook('onResponse', (req, reply, done) => {
  const cls =
    reply.statusCode >= 500 ? '5xx' :
    reply.statusCode >= 400 ? '4xx' :
    reply.statusCode >= 200 ? '2xx' : 'other';
  void emitMetric('http.request', {
    route: req.routeOptions?.url ?? 'unknown',
    method: req.method,
    status_class: cls,
  });
  done();
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  try {
    if (scheduler) stopScheduler(scheduler);
    stopBreachRescanner(breachRescanner);
    stopRetentionSweeper(retentionSweeper);
    stopBulkCrimeReporter(bulkCrimeReporter);
    if (crawlPrewarmer) stopCrawlPrewarmer(crawlPrewarmer);
    stopPushDispatcher(pushDispatcher);
    stopRecoveryFollowup(recoveryFollowup);
    if (a1HotNumbersPopulator) {
      a1HotNumbersPopulator.task.stop();
    }
    stopIdentityShieldIngest(identityShieldIngest);
    stopTelegramListener(telegramListener);
    stopDarknetCrawler(darknetCrawler);
    stopIdentityShieldDigest(identityShieldDigest);
    stopThreatLandscapeAnalyst(threatLandscapeAnalyst);
    stopPostDismissWatcher();
    stopB4Orchestrator();
    stopV4PlaybookSubscriber();
    await shutdownAnalytics();
    await app.close();
    await shutdownDb();
    await shutdownCache();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown_error');
    process.exit(1);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'listen_failed');
  process.exit(1);
}
