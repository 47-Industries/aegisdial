import { ApnsClient, Notification, Errors, Priority } from 'apns2';
import { config } from '../config.js';
import { query } from './db.js';
import { captureError, emitMetric } from './observability.js';

// APNs push pipeline. The four APNs_* env vars are all optional —
// without them, send() is a no-op and logs once. That lets the rest of
// the stack run in dev / CI / Fly before you've generated the p8 key.

let client: ApnsClient | null = null;
let warnedMissing = false;

function getClient(): ApnsClient | null {
  if (client) return client;
  if (!config.APNS_KEY_ID || !config.APNS_TEAM_ID || !config.APNS_KEY_P8) {
    if (!warnedMissing) {
      // eslint-disable-next-line no-console
      console.log('[apns] key/team not set — push is disabled (alerts still land in DB)');
      warnedMissing = true;
    }
    return null;
  }
  // Normalize the PEM. Fly secrets (and most env-var editors) lose real
  // newlines — operators commonly paste a .p8 with either literal `\n`
  // escape sequences or quote-wrapped / whitespace-padded contents. apns2
  // then throws "Invalid PEM" on the first push. Convert escaped `\n`
  // back to actual newlines and trim surrounding whitespace before
  // handing the key to the client.
  const signingKey = config.APNS_KEY_P8.replace(/\\n/g, '\n').trim();
  client = new ApnsClient({
    team: config.APNS_TEAM_ID,
    keyId: config.APNS_KEY_ID,
    signingKey,
    defaultTopic: config.APPLE_BUNDLE_ID,
    host: config.APNS_PRODUCTION ? 'api.push.apple.com' : 'api.sandbox.push.apple.com',
    requestTimeout: 10_000,
  });
  client.on('error', (err: unknown) => captureError(err, { component: 'apns' }));
  return client;
}

export interface PushPayload {
  userId: string;
  title: string;
  body: string;
  /** Inbox category — iOS thread_id for grouping (see UNNotificationContent.threadIdentifier) */
  threadId?: string;
  /** Custom data delivered to the app on tap. Keys land at the top
   *  level of userInfo alongside `aps`. */
  data?: Record<string, unknown>;
  /** Optional badge count */
  badge?: number;
  /**
   * iOS interruption level (aps.interruption-level). Controls whether
   * the push breaks through Focus/Silent and how prominently it appears.
   *
   *   'passive'        — silent, appears only in notification list. Used for
   *                      A2 block-retry digest pushes.
   *   'active'         — default. Standard banner + sound.
   *   'time-sensitive' — breaks through Focus modes. Requires the
   *                      app's UNNotificationContent.interruptionLevel
   *                      capability (no special Apple entitlement).
   *   'critical'       — breaks through Silent AND Do Not Disturb. Plays
   *                      sound even when phone is silenced. REQUIRES Apple
   *                      Critical Alerts entitlement (separate developer-
   *                      portal request, not just an Info.plist flag).
   *                      See risk register R1 in LIVE_SHIELD_V3.md.
   *
   * v3 B3+B4 takeovers REQUEST 'critical' but fall back to 'time-sensitive'
   * when the entitlement is unavailable. The fallback is the safety net
   * for the launch path — we ship the worker first, the entitlement
   * upgrade later when Apple grants it.
   */
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive' | 'critical';
  /**
   * APNs priority header. 10 = immediate delivery (interrupt user).
   * 5 = power-conserving delivery (delayed). Set 10 for any takeover
   * push regardless of interruption level.
   */
  priority?: 5 | 10;
  /**
   * iOS 15+ relevance score 0..1. Helps the system rank when many
   * notifications stack; 1.0 means "show this on top, never demote."
   * Pair with time-sensitive/critical for max lock-screen prominence.
   */
  relevanceScore?: number;
}

/**
 * Fan-out to every active device token for `userId`. Returns the
 * count of successful sends. Token invalidation (BadDeviceToken,
 * Unregistered) is handled automatically — dead tokens are marked
 * invalidated_at so the next fan-out skips them.
 */
export async function sendToUser(payload: PushPayload): Promise<number> {
  const c = getClient();
  if (!c) return 0;

  const tokens = await query<{ id: string; apns_token: string }>(
    `SELECT id, apns_token FROM device_tokens
      WHERE user_id = $1 AND invalidated_at IS NULL`,
    [payload.userId],
  );
  if (tokens.rows.length === 0) return 0;

  // Pre-build the aps overrides once per payload — same for every token.
  // The original Phase 5 fix tried to do this via a toJSON override on
  // the Notification instance. That was a regression: apns2's Notification
  // class has NO toJSON method (the send path is
  // `JSON.stringify(notif.buildApnsOptions())`), so accessing
  // `notif.toJSON.bind(notif)` evaluated `undefined.bind(notif)` and
  // threw TypeError synchronously inside the `tokens.rows.map` callback.
  // Every shield_takeover and block_retry push silently failed to
  // dispatch — worse than the original default-priority bug.
  //
  // The correct path is the documented `aps` field in NotificationOptions
  // (notification.d.ts:21). `buildApnsOptions` seeds `result.aps` from
  // `this.options.aps ?? {}`, so anything we put here lands on the wire
  // alongside alert/badge/threadId.
  const apsOverrides: Record<string, unknown> = {};
  if (payload.interruptionLevel) {
    apsOverrides['interruption-level'] = payload.interruptionLevel;
  }
  if (typeof payload.relevanceScore === 'number') {
    apsOverrides['relevance-score'] = Math.max(0, Math.min(1, payload.relevanceScore));
  }

  const notifications = tokens.rows.map((t) => {
    // apns2's Notification constructor: `data` merges into the top-level
    // payload (alongside `aps`), `threadId` maps to aps.thread-id, and
    // `aps` is merged into the built aps object verbatim.
    return new Notification(t.apns_token, {
      alert: { title: payload.title, body: payload.body },
      topic: config.APPLE_BUNDLE_ID,
      // For critical/time-sensitive pushes we keep the default sound so
      // the system plays even in Silent (if entitled). Apple requires a
      // sound for critical-alert delivery; omitting it downgrades.
      sound: 'default',
      badge: payload.badge,
      threadId: payload.threadId,
      data: payload.data ?? {},
      // Priority.immediate is the apns2 default — the library's send
      // path only sets the apns-priority header when priority is
      // non-immediate, so passing 10 here is a no-op-but-explicit.
      // Priority.throttled (5) is the only other meaningful value;
      // passive A2 block_retry pushes set payload.priority=undefined
      // which falls back to immediate at the library default. (We
      // intentionally keep priority high regardless of interruption
      // level — interruption level controls UX gating, priority
      // controls delivery latency.)
      priority: payload.priority === 5 ? Priority.throttled : Priority.immediate,
      // The two Phase 5 aps overrides go here; harmless empty object
      // when neither field is set.
      ...(Object.keys(apsOverrides).length > 0 ? { aps: apsOverrides } : {}),
    });
  });

  let delivered = 0;
  let failed = 0;
  try {
    const results = await c.sendMany(notifications);
    for (let i = 0; i < results.length; i++) {
      const r = results[i] as { error?: unknown } | undefined;
      const tokenRow = tokens.rows[i]!;
      if (r?.error) {
        failed++;
        await handleApnsError(tokenRow.id, r.error);
      } else {
        delivered++;
      }
    }
    void emitMetric('apns.sent', {}, delivered);
    if (failed > 0) void emitMetric('apns.failed', {}, failed);
  } catch (err) {
    captureError(err, { component: 'apns.sendToUser', user_id: payload.userId });
    void emitMetric('apns.send_failed', {});
  }
  return delivered;
}

async function handleApnsError(tokenId: string, err: unknown): Promise<void> {
  const reason = (err as { reason?: string; responseData?: { reason?: string } })?.responseData?.reason
    ?? (err as { reason?: string })?.reason
    ?? 'unknown';
  // Apple tells us the token is dead — mark invalidated AND persist
  // WHICH reason Apple gave. BadDeviceToken / Unregistered are expected
  // churn (user uninstalled, reinstalled, or OS rotated the token);
  // TopicDisallowed / DeviceTokenNotForTopic indicate a server-side
  // misconfiguration (wrong bundle id, p8 rotated without deploy,
  // sandbox vs production env mismatch) and should page someone.
  if (
    reason === 'BadDeviceToken' ||
    reason === 'Unregistered' ||
    reason === 'DeviceTokenNotForTopic' ||
    reason === 'TopicDisallowed'
  ) {
    await query(
      `UPDATE device_tokens
          SET invalidated_at = NOW(),
              invalidation_reason = $2
        WHERE id = $1`,
      [tokenId, reason],
    );
    void emitMetric('apns.token_invalidated', { reason });
  } else {
    captureError(err, { component: 'apns.error_handler', reason, tokenId });
  }
}

export { Errors };
