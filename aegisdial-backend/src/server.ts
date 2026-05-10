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
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { subscriptionRoutes } from './routes/subscription.js';
import { familyRoutes } from './routes/family.js';
import { recoveryRoutes } from './routes/recovery.js';
import { liveShieldRoutes } from './routes/liveShield.js';
import { smsClassifyRoutes } from './routes/smsClassify.js';
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
await app.register(authRoutes);
await app.register(subscriptionRoutes);
await app.register(familyRoutes);
await app.register(recoveryRoutes);
await app.register(liveShieldRoutes);
await app.register(smsClassifyRoutes);
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
await app.register(analyticsRoutes);
await app.register(internalRoutes);

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
