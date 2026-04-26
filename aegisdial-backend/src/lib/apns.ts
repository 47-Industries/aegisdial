import { ApnsClient, Notification, Errors } from 'apns2';
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

  const notifications = tokens.rows.map((t) => {
    // apns2's Notification constructor: `data` merges into the top-level
    // payload (alongside `aps`), `threadId` maps to aps.thread-id.
    return new Notification(t.apns_token, {
      alert: { title: payload.title, body: payload.body },
      topic: config.APPLE_BUNDLE_ID,
      sound: 'default',
      badge: payload.badge,
      threadId: payload.threadId,
      data: payload.data ?? {},
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
