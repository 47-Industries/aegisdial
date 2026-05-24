import { PostHog } from 'posthog-node';
import { config } from '../config.js';
import { query } from './db.js';

// Analytics — dual write to PostHog (when configured) and our own
// analytics_events table. The local table is our insurance policy: if
// PostHog drops data or we churn to a different vendor, SQL funnel
// queries still work.
//
// Events should be past-tense verbs, snake_case. Properties go through
// as-is. No PII in properties — user_id is the only identifier.

export type AnalyticsEvent =
  | 'user_signed_up'
  | 'user_signed_in'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'subscription_started'
  | 'subscription_cancelled'
  | 'shield_started'
  | 'shield_critical'
  | 'shield_ended'
  | 'family_contact_added'
  | 'family_invite_sent'
  | 'family_invite_accepted'
  | 'recovery_started'
  | 'recovery_step_completed'
  // Founder dashboard signals (see src/lib/internalEvents.ts):
  //   recovery_completed — full Recovery Concierge flow finished
  //   call_blocked       — critical scam call ended with hang-up / guardian escalation
  | 'recovery_completed'
  | 'call_blocked'
  | 'triage_started'
  | 'triage_resolved'
  | 'scam_prevented_triage'
  | 'breach_monitor_added'
  | 'breach_new_exposure'
  | 'sms_junk_classified'
  | 'guardian_alert_seen'
  | 'guardian_challenge_started'
  | 'guardian_challenge_responded'
  | 'demo_call_started'
  | 'onboarding_tour_completed'
  | 'user_deleted_account'
  | 'user_exported_data'
  | 'support_ticket_filed'
  // Funnel events (client-initiated, via POST /v1/analytics/event)
  | 'onboarding_started'
  | 'onboarding_tour_page_viewed'
  | 'onboarding_tour_skipped'
  | 'auth_apple_tapped'
  | 'auth_apple_age_submitted'
  | 'auth_email_tapped'
  | 'auth_email_submitted'
  | 'permission_prompted'
  | 'permission_granted'
  | 'permission_denied'
  | 'live_shield_cta_tapped'
  | 'recovery_cta_tapped'
  | 'protect_parent_flow_started'
  | 'protect_parent_invite_sent'
  | 'protect_parent_safeword_saved'
  | 'protect_parent_flow_completed'
  | 'api_error_silenced'
  // Live Shield v2 hybrid-risk-engine signals (see liveShieldLlm.ts):
  //   live_shield_llm_invoked — Claude joined a regex-only session above threshold
  //   family_alert_fired      — critical session pushed to family-plan members
  | 'live_shield_llm_invoked'
  | 'family_alert_fired'
  // Live Shield v3 B3 — escalation fired 30s after a takeover dismiss
  // with continued-critical state. See src/services/postDismissWatcher.ts.
  | 'family_alert_post_dismiss_fired';

let client: PostHog | null = null;
let initialized = false;
let warnedMissing = false;

function getClient(): PostHog | null {
  if (initialized) return client;
  initialized = true;
  if (!config.POSTHOG_API_KEY) {
    if (!warnedMissing) {
      // eslint-disable-next-line no-console
      console.log('[analytics] POSTHOG_API_KEY unset — events only write to Postgres');
      warnedMissing = true;
    }
    return null;
  }
  client = new PostHog(config.POSTHOG_API_KEY, {
    host: config.POSTHOG_HOST,
    flushAt: 20,
    flushInterval: 10_000,
  });
  return client;
}

/**
 * Fire an event. Non-blocking by design — never await this in a hot
 * request path; use `void track(...)`. Errors are swallowed.
 */
export async function track(
  event: AnalyticsEvent,
  opts: {
    userId?: string | null;
    anonymousId?: string | null;
    properties?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const props = opts.properties ?? {};

  // Postgres mirror — always write, even when PostHog is off.
  try {
    await query(
      `INSERT INTO analytics_events (user_id, anonymous_id, event, properties)
       VALUES ($1, $2, $3, $4)`,
      [opts.userId ?? null, opts.anonymousId ?? null, event, JSON.stringify(props)],
    );
  } catch {
    // ignore — metrics failures must never break the caller
  }

  const ph = getClient();
  if (!ph) return;
  try {
    ph.capture({
      distinctId: opts.userId ?? opts.anonymousId ?? 'anonymous',
      event,
      properties: props,
    });
  } catch {
    // ignore
  }
}

export async function shutdownAnalytics(): Promise<void> {
  if (client) await client.shutdown();
}
