import { config } from '../config.js';
import { emitMetric } from '../lib/observability.js';

// Live Shield v3 — session-events hub.
//
// v2's transcript ingestion path publishes events into this hub via
// notifyTranscriptChunk(). v3 services (sentinel matcher, post-dismiss
// watcher, B4 claim extractor) subscribe out via subscribeTranscript()
// and subscribeRiskTransition().
//
// Single source of in-process event flow. Decouples v2's hot path
// from v3 wiring — the v2 transcript handler gains exactly ONE call
// (notifyTranscriptChunk + notifyRiskTransition where appropriate);
// subscribers come and go independently.
//
// All subscribers are in-process and synchronous-ish (each fn is
// awaited). For multi-process scaling we rely on the same session-
// affinity routing v2 already uses — sessions are pinned to a single
// backend process for the duration of the call.

export interface TranscriptChunkEvent {
  session_id: string;
  user_id: string;
  /** Best-effort speaker label from iOS — 'caller' or 'self' or 'unknown'. */
  speaker: 'caller' | 'self' | 'unknown';
  /** Plaintext of the chunk. Never persisted to disk by v3 services. */
  text: string;
  /** Optional Whisper/SFSpeechRecognizer confidence 0..1. */
  confidence: number | null;
  /** ISO8601 timestamp when this chunk was uttered. */
  spoken_at: Date;
}

export interface RiskTransitionEvent {
  session_id: string;
  user_id: string;
  previous_level: 'low' | 'medium' | 'high' | 'critical';
  new_level: 'low' | 'medium' | 'high' | 'critical';
  current_score: number;
  occurred_at: Date;
}

type TranscriptSubscriber = (event: TranscriptChunkEvent) => void | Promise<void>;
type RiskSubscriber = (event: RiskTransitionEvent) => void | Promise<void>;

const transcriptSubscribers = new Set<TranscriptSubscriber>();
const riskSubscribers = new Set<RiskSubscriber>();

/**
 * Subscribe to every transcript chunk that lands in v2's ingestion
 * route. Returns an unsubscribe function. Subscribers MUST be
 * non-blocking — long-running work should be deferred to a worker.
 */
export function subscribeTranscript(fn: TranscriptSubscriber): () => void {
  transcriptSubscribers.add(fn);
  return () => {
    transcriptSubscribers.delete(fn);
  };
}

/**
 * Subscribe to risk-level transitions. Fires when the recomputed
 * level differs from the previous level (e.g. high → critical).
 * Stable-state ticks (high → high) do NOT fire to keep subscribers
 * from re-running on every chunk.
 */
export function subscribeRiskTransition(fn: RiskSubscriber): () => void {
  riskSubscribers.add(fn);
  return () => {
    riskSubscribers.delete(fn);
  };
}

/**
 * Called by v2's transcript ingestion route. Fans the chunk out to
 * every transcript subscriber. Errors in a subscriber are logged +
 * counted but do not propagate — one buggy subscriber cannot break
 * v2's transcript path.
 *
 * Gated on V3_A1_ENABLED || V3_B3_ENABLED || V3_B4_ENABLED ||
 * V4_PLAYBOOK_AWARE_ENABLED — when all transcript-consuming features
 * are off, this is a no-op (saves the dispatch loop cost on the
 * hot path). v4 added to the gate so the playbook subscriber can
 * receive caller-side chunks even when v3 features are all
 * disabled in a v4-only cohort rollout.
 */
export async function notifyTranscriptChunk(event: TranscriptChunkEvent): Promise<void> {
  if (
    !config.V3_A1_ENABLED &&
    !config.V3_B3_ENABLED &&
    !config.V3_B4_ENABLED &&
    !config.V4_PLAYBOOK_AWARE_ENABLED
  ) {
    return;
  }
  if (transcriptSubscribers.size === 0) return;

  for (const fn of transcriptSubscribers) {
    try {
      await fn(event);
    } catch (err) {
      emitMetric('v3.session_events.transcript_subscriber_failed', {});
      // eslint-disable-next-line no-console
      console.error('[v3SessionEvents] transcript subscriber threw', {
        session_id: event.session_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Called by v2's risk-scoring path when the level transitions.
 * Idempotency is the caller's responsibility — v2 should only fire
 * this when the level actually changes.
 */
export async function notifyRiskTransition(event: RiskTransitionEvent): Promise<void> {
  if (!config.V3_B3_ENABLED && !config.V3_B4_ENABLED) {
    return;
  }
  if (riskSubscribers.size === 0) return;

  emitMetric('v3.session_events.risk_transition', {
    from: event.previous_level,
    to: event.new_level,
  });

  for (const fn of riskSubscribers) {
    try {
      await fn(event);
    } catch (err) {
      emitMetric('v3.session_events.risk_subscriber_failed', {});
      // eslint-disable-next-line no-console
      console.error('[v3SessionEvents] risk subscriber threw', {
        session_id: event.session_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Test-only — clear all subscribers between tests. */
export function _resetForTests(): void {
  transcriptSubscribers.clear();
  riskSubscribers.clear();
}
