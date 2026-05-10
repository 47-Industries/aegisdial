import { config } from '../config.js';
import { emitMetric } from '../lib/observability.js';

// Live Shield v3 — Mom-side STT routing (Phase 0 scaffold, full impl in Phase 2).
//
// v2 transcribes scammer-side audio only. v3 needs Mom-side audio
// transcribed for two new features:
//
//   B3 sentinel matcher — fires the visual takeover when Mom's own
//                         speech matches a high-risk pattern (about
//                         to read SSN, card number, MFA code).
//   B4 claim extractor  — uses Mom's responses to ground the
//                         scammer-claim verification (e.g. confirms
//                         which "case number" the scammer cited).
//
// Architecture: same Whisper-streaming pipeline v2 already uses for
// scammer-side. The only difference is which audio source the iOS
// app routes through STT — Mom's mic vs. caller. iOS reports both
// streams labeled, server consumes both.
//
// Cost concern (R3 in the risk register): doubling Whisper minutes
// per session ≈ 5% of $49.99 revenue at 200 min/mo. Manageable but
// real. The V3_B3_MOM_SIDE_STT_ENABLED flag is a runtime kill-switch
// if production cost spikes.
//
// Phase 0 status (this file):
//   - Public interface is FINAL. Subscribers (sentinelMatcher,
//     claimExtractor) can be wired against this surface today.
//   - The actual STT path (consume audio chunk → Whisper → emit text
//     chunk to subscribers) is wired in Phase 2 alongside the
//     sentinel matcher. For now, this file exposes the consumer
//     interface and a no-op subscribe() so feature work in B3/B4
//     compiles against it without blocking on Phase 2.

export interface MomSideTranscriptChunk {
  session_id: string;
  user_id: string;
  text: string;
  // Confidence from Whisper. Below ~0.6 we tend to discard chunks
  // because false-positive sentinel matches on misheard audio are
  // worse than missing a positive.
  confidence: number;
  // Audio offset within the call (seconds since session start).
  offset_seconds: number;
  emitted_at: Date;
}

export type MomSideSubscriber = (chunk: MomSideTranscriptChunk) => void | Promise<void>;

// In-memory subscriber registry, keyed by session_id. v2's scammer-side
// pipeline uses an EventEmitter pattern; we mirror that for consistency.
// One process owns the in-memory state — for multi-process scaling we
// rely on the same session-affinity routing v2 uses (sessions are
// pinned to a single backend process for the duration of the call).
const subscribers = new Map<string, Set<MomSideSubscriber>>();

/**
 * Subscribe to Mom-side transcript chunks for a session.
 *
 * Returns an unsubscribe function. Call it on session-end to prevent
 * leaks. The B3 sentinelMatcher and the B4 claimExtractor both
 * subscribe; both should unsubscribe in their own session-end handlers.
 *
 * Phase 0 NOTE: subscribe() works (in-memory dispatch is wired) but
 * no chunks are being emitted yet. Phase 2 wires the iOS audio →
 * Whisper → emitChunk() path. Until then, all subscribers will see
 * zero events — which is fine for getting the integration shape right.
 */
export function subscribe(session_id: string, fn: MomSideSubscriber): () => void {
  let set = subscribers.get(session_id);
  if (!set) {
    set = new Set();
    subscribers.set(session_id, set);
  }
  set.add(fn);

  return () => {
    const cur = subscribers.get(session_id);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) {
      subscribers.delete(session_id);
    }
  };
}

/**
 * Internal — called by the Whisper-streaming worker (Phase 2) once
 * each chunk is transcribed. Fans out to all session subscribers.
 *
 * Errors in subscribers are logged + counted but do not propagate;
 * one feature's bug can't break another's transcript intake.
 */
export async function emitChunk(chunk: MomSideTranscriptChunk): Promise<void> {
  if (!config.V3_B3_MOM_SIDE_STT_ENABLED) {
    // Kill-switch is active — drop the chunk without dispatching.
    // The caller (Phase 2 worker) checks this too, but we double-check
    // here so a stale upstream can't sneak chunks past the gate.
    return;
  }

  const set = subscribers.get(chunk.session_id);
  if (!set || set.size === 0) {
    return;
  }

  emitMetric('v3.mom_side_stt.chunk_dispatched', {
    subscriber_count: set.size,
  });

  for (const fn of set) {
    try {
      await fn(chunk);
    } catch (err) {
      emitMetric('v3.mom_side_stt.subscriber_failed', {});
      // eslint-disable-next-line no-console
      console.error('[momSideStt] subscriber threw on chunk', {
        session_id: chunk.session_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Test-only — clear all subscribers. Used by the unit-test setup to
 * ensure no cross-test leakage. NOT exported to production callers.
 */
export function _resetForTests(): void {
  subscribers.clear();
}
