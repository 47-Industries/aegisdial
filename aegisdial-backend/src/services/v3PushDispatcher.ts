import { config } from '../config.js';
import { query } from '../lib/db.js';
import { emitMetric, captureError } from '../lib/observability.js';

// Live Shield v3 — Phase 5 push enqueue helpers.
//
// v3 introduces three new outbound push categories that the existing
// pushDispatcher worker (src/workers/pushDispatcher.ts) needs to deliver:
//
//   shield_takeover  — B3 + B4 critical-takeover delivery to subject user.
//                       Targets the subject's OWN device (not a guardian's).
//                       Interruption level: 'critical' if Apple entitlement
//                       granted, falls back to 'time-sensitive' otherwise.
//   shield_post_dismiss — already plumbed in Phase 2; this file just
//                          confirms the dispatcher routes it correctly.
//   block_retry      — A2: previously-blocked number tried again.
//                       Low-urgency push to the subject user.
//                       Interruption level: 'passive' (informational).
//
// All three reuse the v2 guardian_alerts table as the outbound queue.
// guardian_user_id stores the recipient — for self-targeted pushes
// (shield_takeover, block_retry) this equals subject_user_id. The
// column name is a v2-era artifact; semantically it's "recipient".
//
// Idempotency: each enqueue function is responsible for its own
// at-most-once semantics. Takeover dispatch uses the existing per-
// session caps (b3_takeover_fired_at, b4_takeover_dispatched). Block-
// retry uses the existing rate-limit logic in routes/blocks.ts.
// This file just translates "fire X" into the queue row.

// ---------------------------------------------------------------------------
// shield_takeover — B3 + B4 takeover delivery
// ---------------------------------------------------------------------------

export interface CriticalTakeoverPushInput {
  session_id: string;
  /** Recipient — the user whose phone should fire the takeover. */
  user_id: string;
  /** Distinguishes B3 vs B4 vs v4 paths for the iOS UI router. */
  trigger_path:
    | 'live_shield_critical'
    | 'sentinel_keyword'
    | 'b4_finding'
    | 'v4_stage_classifier';
  /** Risk score at time of fire — surfaced in the takeover body. */
  risk_score: number;
  /**
   * Optional context for the polymorphic CriticalInterruptView:
   *   B3 sentinel        → { pattern_name, matched_text }
   *   B4 finding         → { claim_type, raw_quote, reasoning, finding_id,
   *                          source_url?, source_snippet? }
   *   B3 critical        → {}
   *   v4 stage classifier → { playbook_id, playbook_display_name, stage,
   *                           confidence }
   */
  context?: Record<string, unknown>;
}

/**
 * Enqueue a critical-takeover push. Fire-and-forget; the dispatcher
 * worker picks it up within ~30 seconds (the cron tick).
 *
 * No-op when V3_B3_ENABLED is OFF. (Even B4 takeovers are gated on B3
 * because they reuse B3's iOS CriticalInterruptView — disabling B3
 * disables the visual surface.)
 */
export async function enqueueCriticalTakeoverPush(
  input: CriticalTakeoverPushInput,
): Promise<{ enqueued: boolean }> {
  if (!config.V3_B3_ENABLED) return { enqueued: false };

  const { title, body } = buildTakeoverCopy(input);

  // CRITICAL bug fix from Phase 5 adversarial review: defense-in-depth
  // 60-second per-user suppression. Even if upstream callers forget
  // their atomic-claim gate, this prevents push-spam to Mom in any
  // 60-second window. The dispatcher will silently no-op if there
  // are no device tokens, so we don't pre-check that here.
  try {
    const recent = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count
         FROM guardian_alerts
        WHERE subject_user_id = $1
          AND kind = 'shield_takeover'
          AND created_at > NOW() - INTERVAL '60 seconds'`,
      [input.user_id],
    );
    if (parseInt(recent.rows[0]?.count ?? '0', 10) > 0) {
      emitMetric('v3.push.takeover_suppressed_by_window', {
        trigger_path: input.trigger_path,
      });
      return { enqueued: false };
    }

    await query(
      `INSERT INTO guardian_alerts
         (guardian_user_id, subject_user_id, kind, severity, title, body, payload)
       VALUES ($1, $2, 'shield_takeover', 'critical', $3, $4, $5::jsonb)`,
      [
        input.user_id,
        input.user_id, // recipient and subject are the same for self-targeted
        title,
        body,
        JSON.stringify({
          session_id: input.session_id,
          trigger_path: input.trigger_path,
          risk_score: input.risk_score,
          context: input.context ?? {},
          // The iOS app reads these hints from data on the push:
          interruption_level_request: 'critical',
          interruption_level_fallback: 'time-sensitive',
          ios_category: 'AEGISDIAL_CRITICAL_TAKEOVER',
          relevance_score: 1.0,
        }),
      ],
    );

    emitMetric('v3.push.takeover_enqueued', { trigger_path: input.trigger_path });
    return { enqueued: true };
  } catch (err) {
    emitMetric('v3.push.takeover_enqueue_failed', { trigger_path: input.trigger_path });
    // M-16: fire-and-forget enqueues swallow errors so the calling
    // feature flow (B3/B4 takeover) doesn't abort. Sentry is then the
    // only signal that a push silently failed — without it, a stuck
    // INSERT (table lock, schema drift, FK violation) is invisible
    // until someone notices "Mom didn't get the takeover." Include
    // full correlation context so on-call can pivot from Sentry → the
    // exact session.
    captureError(err, {
      component: 'v3PushDispatcher.enqueueCriticalTakeoverPush',
      session_id: input.session_id,
      user_id: input.user_id,
      trigger_path: input.trigger_path,
    });
    // eslint-disable-next-line no-console
    console.error('[v3PushDispatcher] takeover enqueue failed', {
      session_id: input.session_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return { enqueued: false };
  }
}

// ---------------------------------------------------------------------------
// block_retry — A2 previously-blocked number tried again
// ---------------------------------------------------------------------------

export interface BlockRetryPushInput {
  user_id: string;
  e164: string;
  attempted_at: Date;
}

/**
 * Enqueue an A2 block-retry push. Caller is responsible for having
 * already verified rate-limit eligibility (see routes/blocks.ts).
 * This function does not re-check the rate limit.
 *
 * No-op when V3_A2_ENABLED is OFF.
 */
export async function enqueueBlockRetryPush(
  input: BlockRetryPushInput,
): Promise<{ enqueued: boolean }> {
  if (!config.V3_A2_ENABLED) return { enqueued: false };

  // The body deliberately does NOT include the full E.164 in the
  // notification body — lock-screen previews on shared/displayed
  // devices shouldn't leak the number. iOS tap reveals the in-app
  // log via the payload reference.
  const title = 'AegisDial';
  const body = 'A scammer you blocked tried again — tap to see who.';

  try {
    await query(
      `INSERT INTO guardian_alerts
         (guardian_user_id, subject_user_id, kind, severity, title, body, payload)
       VALUES ($1, $2, 'block_retry', 'info', $3, $4, $5::jsonb)`,
      [
        input.user_id,
        input.user_id,
        title,
        body,
        JSON.stringify({
          e164: input.e164,
          attempted_at: input.attempted_at.toISOString(),
          interruption_level_request: 'passive',
          ios_category: 'AEGISDIAL_BLOCK_RETRY',
        }),
      ],
    );

    emitMetric('v3.push.block_retry_enqueued', {});
    return { enqueued: true };
  } catch (err) {
    emitMetric('v3.push.block_retry_enqueue_failed', {});
    // M-16: see takeover branch above. e164 is included in payload
    // not just the metric tag because the Sentry breadcrumb is the
    // entire trail we have for diagnosing why a specific block-retry
    // push didn't fire.
    captureError(err, {
      component: 'v3PushDispatcher.enqueueBlockRetryPush',
      user_id: input.user_id,
      e164: input.e164,
    });
    // eslint-disable-next-line no-console
    console.error('[v3PushDispatcher] block_retry enqueue failed', {
      user_id: input.user_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return { enqueued: false };
  }
}

// ---------------------------------------------------------------------------
// Copy builders
// ---------------------------------------------------------------------------

function buildTakeoverCopy(input: CriticalTakeoverPushInput): { title: string; body: string } {
  // Default to neutral copy; B4 path injects a quoted lie if context provides it.
  if (input.trigger_path === 'b4_finding' && input.context) {
    const claimType = input.context.claim_type as string | undefined;
    const rawQuote = input.context.raw_quote as string | undefined;
    if (rawQuote) {
      // Sanitize (strip control chars + newlines) then truncate. The
      // raw_quote is passed through from claimExtractor's verbatim
      // audit, but defense-in-depth: a forged route call could otherwise
      // inject arbitrary content into the push body.
      // eslint-disable-next-line no-control-regex
      const sanitized = rawQuote.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
      const trimmed = sanitized.length > 80 ? sanitized.slice(0, 77) + '…' : sanitized;
      if (trimmed.length >= 3) {
        return {
          title: 'STOP — caller appears to be lying',
          body: `They said: "${trimmed}". Tap to see why this doesn't check out.`,
        };
      }
    }
    return {
      title: 'STOP — caller appears to be lying',
      body: `AegisDial caught a false ${claimType ?? 'claim'} on this call. Tap for details.`,
    };
  }

  if (input.trigger_path === 'sentinel_keyword') {
    return {
      title: 'STOP — do not share that information',
      body: 'AegisDial detected you may be about to share sensitive info. Tap to confirm safety.',
    };
  }

  // v4 Phase 4 — stage-classifier takeover. Stage-specific copy keyed
  // on the context.stage; falls back to a neutral takeover line if
  // the stage isn't one of the two trigger stages (defense-in-depth —
  // the caller's stage gate should never let anything else through).
  if (input.trigger_path === 'v4_stage_classifier' && input.context) {
    const stage = input.context.stage as string | undefined;
    const playbookName = input.context.playbook_display_name as string | undefined;
    // Sanitize the playbook display_name same way we sanitize raw_quote
    // for B4 — defense-in-depth against any future code path that might
    // synthesize an unsafe display string.
    // eslint-disable-next-line no-control-regex
    const safeName = playbookName?.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
    const nameClause = safeName && safeName.length > 0 ? ` — ${safeName}` : '';
    if (stage === 'ask') {
      return {
        title: 'STOP — they\'re asking for money',
        body: `This call matches a known scam pattern${nameClause}. Hang up now.`,
      };
    }
    if (stage === 'close') {
      return {
        title: 'STOP — confirm you didn\'t send money',
        body: `This call matches a known scam pattern${nameClause}. Tap to review.`,
      };
    }
    return {
      title: 'STOP — scam pattern detected',
      body: `AegisDial recognized this script${nameClause}. Tap to view.`,
    };
  }

  // Default — live_shield_critical
  return {
    title: 'STOP — scam confirmed',
    body: 'This call shows strong scam patterns. Tap to view the warning.',
  };
}
