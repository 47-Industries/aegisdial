import { query } from '../lib/db.js';
import { emitMetric } from '../lib/observability.js';

// Live Shield v3 — transcript system_event taxonomy and emit helper.
//
// All five v3 features emit system_event markers into the family
// transcript stream so the watching adult kid sees a timeline of:
//   - When critical fired
//   - When a B3/B4 takeover happened
//   - When a takeover was dismissed
//   - When the family alert went out
//   - When the safety contact joined / left
//
// Centralizing the event taxonomy here means:
//   - One source of truth for event names (no string typos in routes)
//   - One renderer in the iOS family transcript view (switch on type)
//   - One audit trail format for legal/support queries
//
// The events ride on the v2 family transcript infrastructure. v2 already
// streams transcript chunks to family-plan members at the user's chosen
// privacy level (minimal/default/open). v3 just extends the event
// vocabulary; the delivery path is unchanged.
//
// Phase 0 status (this file):
//   - Type vocabulary is FINAL and matches the integration map in
//     LIVE_SHIELD_V3.md. Don't add new types without updating that
//     section first.
//   - emitSystemEvent() persists the event and increments a counter.
//     Wiring to the v2 family-transcript SSE stream is a Phase 1 task
//     (TODO inline below) — for now the event lands in storage and the
//     streaming side-effect is a no-op so the function can be called
//     safely from any feature without blocking on the streaming wire-up.

export type V3SystemEventType =
  // Live Shield critical state transitions
  | 'live_shield_critical_entered'
  // B3 — visual takeover lifecycle
  | 'b3_takeover_fired'
  | 'b3_takeover_dismissed'
  // B4 — fact-checking findings + takeover
  | 'b4_finding_contradicted'
  | 'b4_takeover_fired'
  // Family escalation
  | 'family_alert_dispatched'
  // B5 — safety-contact lifecycle
  | 'safety_contact_initiating'
  | 'safety_contact_joined'
  | 'safety_contact_left';

export interface V3SystemEvent {
  type: V3SystemEventType;
  session_id: string;
  user_id: string;
  // Optional payload bag — each event type has its own expected shape.
  // Documented per-type below; runtime is permissive so the schema can
  // evolve without breaking existing consumers.
  payload?: Record<string, unknown>;
  // ISO8601; defaults to NOW() when emitted.
  occurred_at?: string;
}

/**
 * Persist a system_event onto the call session and (TODO Phase 1) push
 * it onto the family-transcript SSE stream so the watching family
 * member sees it land in real time.
 *
 * Idempotency: callers should ensure the same event isn't emitted
 * twice. We do NOT dedupe at this layer — feature-level idempotency
 * keys (e.g. b3_dismiss_events.session_id, b4_takeover_dispatched PK)
 * already prevent double-fires upstream.
 *
 * Failure mode: a database error here MUST NOT abort the calling
 * feature flow (a B3 takeover firing should still happen even if the
 * audit log write fails). Errors are logged + counted but swallowed.
 */
export async function emitSystemEvent(event: V3SystemEvent): Promise<void> {
  try {
    await query(
      `INSERT INTO transcript_system_events
         (session_id, user_id, event_type, payload, occurred_at)
       VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::timestamptz, NOW()))`,
      [
        event.session_id,
        event.user_id,
        event.type,
        JSON.stringify(event.payload ?? {}),
        event.occurred_at ?? null,
      ],
    );

    // TODO(Phase 1): publish to the v2 family-transcript SSE stream
    // so the watching family member sees this event live. Today this
    // is a no-op; the event is persisted but only visible on
    // post-call recap until the streaming wire-up lands.
    //
    // The wire-up needs to:
    //   1. Look up the family-plan members for `event.user_id`
    //   2. Filter to those with privacy_level allowing system events
    //      (minimal/default/open all currently allow — verify this)
    //   3. Push a `{ type: 'system_event', ...event }` frame into
    //      whatever channel the v2 transcript-streaming code uses
    //      (likely an EventEmitter keyed by user_id; check
    //      src/services/liveShield.ts for the exact mechanism)

    emitMetric('v3.transcript_system_event.emitted', { type: event.type });
  } catch (err) {
    // Do not throw — feature flow must not abort on audit-log failures.
    emitMetric('v3.transcript_system_event.emit_failed', { type: event.type });
    // eslint-disable-next-line no-console
    console.error('[transcriptEvents] failed to persist system event', {
      type: event.type,
      session_id: event.session_id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// Convenience constructors — features call these instead of building
// the V3SystemEvent literal each time. Helps catch type errors at the
// call site (you can't typo the event name) and gives one place to
// document each event's expected payload shape.

export function liveShieldCriticalEntered(
  session_id: string,
  user_id: string,
  payload: { score: number; trigger_path: string },
): V3SystemEvent {
  return { type: 'live_shield_critical_entered', session_id, user_id, payload };
}

export function b3TakeoverFired(
  session_id: string,
  user_id: string,
  payload: { trigger_path: 'live_shield_critical' | 'sentinel_keyword' | 'b4_finding' },
): V3SystemEvent {
  return { type: 'b3_takeover_fired', session_id, user_id, payload };
}

export function b3TakeoverDismissed(
  session_id: string,
  user_id: string,
  payload: { score_at_dismiss: number; seconds_to_dismiss: number },
): V3SystemEvent {
  return { type: 'b3_takeover_dismissed', session_id, user_id, payload };
}

export function b4FindingContradicted(
  session_id: string,
  user_id: string,
  payload: {
    claim_type: string;
    raw_quote: string;
    confidence: number;
    source_layer: 'curated' | 'web_search';
  },
): V3SystemEvent {
  return { type: 'b4_finding_contradicted', session_id, user_id, payload };
}

export function b4TakeoverFired(
  session_id: string,
  user_id: string,
  payload: { claim_type: string; finding_id: string },
): V3SystemEvent {
  return { type: 'b4_takeover_fired', session_id, user_id, payload };
}

export function familyAlertDispatched(
  session_id: string,
  user_id: string,
  payload: { reason: 'live_shield_critical' | 'post_dismiss_escalation' },
): V3SystemEvent {
  return { type: 'family_alert_dispatched', session_id, user_id, payload };
}

export function safetyContactInitiating(
  session_id: string,
  user_id: string,
  payload: { family_member_user_id: string },
): V3SystemEvent {
  return { type: 'safety_contact_initiating', session_id, user_id, payload };
}

export function safetyContactJoined(
  session_id: string,
  user_id: string,
  payload: { family_member_user_id: string },
): V3SystemEvent {
  return { type: 'safety_contact_joined', session_id, user_id, payload };
}

export function safetyContactLeft(
  session_id: string,
  user_id: string,
  payload: { family_member_user_id: string; duration_seconds: number },
): V3SystemEvent {
  return { type: 'safety_contact_left', session_id, user_id, payload };
}
