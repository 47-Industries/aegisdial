import { emitMetric } from '../lib/observability.js';

// Live Shield v3 — family-transcript live stream.
//
// The v3 spec referenced "the existing v2 family-transcript SSE stream"
// in four places (B5 [See live transcript] button, post-dismiss
// timeline, system_event markers, family-side recap). Reality at audit
// time 2026-05-11: v2 had no SSE stream at all. Family viewers saw
// post-call recap rows but not live events. This module is the
// in-process pub-sub layer the spec assumed existed.
//
// Architecture:
//   - Keyed by subject_user_id (the user being watched — not session_id,
//     because the same family member viewing UI persists across
//     consecutive calls).
//   - Pure in-process EventEmitter pattern (no Redis pub-sub yet). At
//     our scale (≤200 concurrent active calls per pod), this is fine.
//     Multi-pod scaling: sessions are already session-affinity-pinned
//     to one backend pod via v2's routing; family viewers go to the
//     SAME pod via session_id → pod hash. If the family viewer lands
//     on a different pod, they get system_events (DB-replicated) but
//     not the live text. Acceptable degradation; revisit at scale.
//   - Subscribers receive `FamilyStreamFrame` objects of three kinds:
//       1. `transcript` — verbatim chunk text (encrypted at rest;
//          plaintext for the live stream by design — Mom's family
//          IS the trusted viewer for this).
//       2. `system_event` — v3 transcript-event taxonomy
//          (b3_takeover_fired, family_alert_dispatched, etc.).
//       3. `heartbeat` — keepalive every 30s so the SSE client can
//          detect a dead connection.
//   - SSE route is in routes/familyTranscriptStream.ts; this module
//     only does the publish/subscribe primitives.
//
// Failure mode: a subscriber that throws gets logged + counted but
// not removed (the SSE route is responsible for cleanup when the
// HTTP connection drops). One bad subscriber cannot break others.

export type FamilyStreamFrameType = 'transcript' | 'system_event' | 'heartbeat';

export interface TranscriptFrame {
  type: 'transcript';
  /** Subject user (Mom) whose call this is. Frame keying is on this. */
  subject_user_id: string;
  session_id: string;
  /** Best-effort speaker label from iOS — 'caller' or 'self' or 'unknown'. */
  speaker: 'caller' | 'self' | 'unknown';
  text: string;
  /** ISO8601 — when iOS uploaded the chunk. */
  spoken_at: string;
}

export interface SystemEventFrame {
  type: 'system_event';
  subject_user_id: string;
  session_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  /** ISO8601 — when the event occurred. */
  occurred_at: string;
}

export interface HeartbeatFrame {
  type: 'heartbeat';
  subject_user_id: string;
  /** ISO8601 — server time at heartbeat. */
  at: string;
}

export type FamilyStreamFrame = TranscriptFrame | SystemEventFrame | HeartbeatFrame;

export type FamilyStreamSubscriber = (frame: FamilyStreamFrame) => void;

// In-memory subscriber registry, keyed by subject_user_id. One subject
// can have multiple family members watching (e.g. son + daughter both
// have the app open) — the Set holds all of them. Empty Sets are
// pruned on unsubscribe to prevent unbounded growth.
const subscribers = new Map<string, Set<FamilyStreamSubscriber>>();

/**
 * Subscribe a family viewer's connection to a subject's stream.
 * Returns an unsubscribe function — the SSE route MUST call it on
 * connection close (otherwise we leak per-connection closures).
 *
 * Auth (family-plan-member verification) is the caller's job; this
 * function trusts that the subject_user_id is one the subscriber
 * is entitled to watch.
 */
export function subscribe(
  subjectUserId: string,
  fn: FamilyStreamSubscriber,
): () => void {
  let set = subscribers.get(subjectUserId);
  if (!set) {
    set = new Set();
    subscribers.set(subjectUserId, set);
  }
  set.add(fn);
  emitMetric('v3.family_stream.subscriber_added', {
    subscriber_count: set.size,
  });
  return () => {
    const cur = subscribers.get(subjectUserId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) {
      subscribers.delete(subjectUserId);
    }
    emitMetric('v3.family_stream.subscriber_removed', {});
  };
}

/**
 * Publish a frame to all subscribers of the subject. Synchronous-ish
 * — each subscriber's callback is invoked inline. Errors in a
 * subscriber are caught + counted; one buggy subscriber cannot
 * break the others or the producer.
 *
 * The producers are:
 *   - `/v1/live-shield/:id/transcript` route (transcript frames)
 *   - `services/transcriptEvents.emitSystemEvent` (system_event frames)
 *   - The heartbeat timer inside `routes/familyTranscriptStream.ts`
 *     (heartbeat frames, ~30s cadence per active connection)
 */
export function publish(frame: FamilyStreamFrame): void {
  const set = subscribers.get(frame.subject_user_id);
  if (!set || set.size === 0) return;

  emitMetric('v3.family_stream.frame_published', {
    type: frame.type,
    subscriber_count: set.size,
  });

  // L-1 adversarial fix: snapshot before iterating. JS Set iteration
  // includes elements added during iteration, so a subscriber that
  // calls `subscribe(sameSubject, ...)` mid-callback (e.g. a future
  // hook that translates one frame into a derived frame) would land
  // in an infinite loop. Snapshot is cheap (handful of fns per
  // subject) and removes the foot-gun.
  const snapshot = [...set];
  for (const fn of snapshot) {
    try {
      fn(frame);
    } catch (err) {
      emitMetric('v3.family_stream.subscriber_failed', { type: frame.type });
      // eslint-disable-next-line no-console
      console.error('[familyTranscriptStream] subscriber threw on frame', {
        subject_user_id: frame.subject_user_id,
        type: frame.type,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Test-only — return the subscriber count for a subject. Used by
 * the unit tests to assert subscribe/unsubscribe semantics without
 * exposing the internal Map.
 */
export function _subscriberCountForTests(subjectUserId: string): number {
  return subscribers.get(subjectUserId)?.size ?? 0;
}

/** Test-only — clear all subscribers between tests. */
export function _resetForTests(): void {
  subscribers.clear();
}
