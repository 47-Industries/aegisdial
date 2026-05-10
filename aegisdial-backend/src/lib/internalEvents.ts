// Helpers for the two new analytics events the founder dashboard
// needs:
//
//   recovery_completed — full Recovery Concierge flow finished. Fires
//     once per session when status flips active → completed.
//
//   call_blocked      — a critical-risk call ended with the user
//     hanging up or escalating to their guardian. Fires once per
//     call_sessions row that meets both conditions. Doesn't fire for
//     low/medium risk or for outcome='user_completed' (where the user
//     stayed on the call — not a clear block).
//
// Both wrap the existing track() helper from src/lib/analytics.ts so
// they end up in analytics_events + PostHog like every other event.

import { track } from './analytics.js';

export interface RecoveryCompletedProps {
  sessionId: string;
  scamType?: string | null;
  amountLostCents?: number | null;
  durationSeconds?: number | null;
}

export function trackRecoveryCompleted(
  userId: string,
  props: RecoveryCompletedProps,
): void {
  // void on the call site — fire and forget. The track() helper
  // already swallows errors so a Postgres outage on analytics_events
  // never breaks the recovery flow itself.
  void track('recovery_completed', {
    userId,
    properties: {
      session_id: props.sessionId,
      scam_type: props.scamType ?? null,
      amount_lost_cents: props.amountLostCents ?? null,
      duration_seconds: props.durationSeconds ?? null,
    },
  });
}

export interface CallBlockedProps {
  sessionId: string;
  riskScore: number;
  durationSeconds: number;
  outcome: 'user_hung_up' | 'user_called_guardian';
  triggeredCategories: string[];
}

export function trackCallBlocked(
  userId: string,
  props: CallBlockedProps,
): void {
  void track('call_blocked', {
    userId,
    properties: {
      session_id: props.sessionId,
      risk_score: props.riskScore,
      duration_seconds: props.durationSeconds,
      outcome: props.outcome,
      triggered_categories: props.triggeredCategories,
    },
  });
}
