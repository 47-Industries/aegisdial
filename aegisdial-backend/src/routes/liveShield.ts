import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, withTx } from '../lib/db.js';
import { requireAppUser, requireProTier } from '../lib/auth.js';
import { normalizeE164 } from '../lib/phone.js';
import { detectPhrases, patternById } from '../lib/scamPhrases.js';
import { scoreHits } from '../services/liveShield.js';
import type { PhraseHit } from '../lib/scamPhrases.js';
import { emitGuardianAlert } from '../services/guardianAlerts.js';
import { track } from '../lib/analytics.js';
import { trackCallBlocked } from '../lib/internalEvents.js';
import { emitMetric } from '../lib/observability.js';
import { encryptString, readMaybeEncrypted } from '../lib/crypto.js';
import {
  shouldFireLlm,
  mergeScores,
  runLlmAndCache,
  LLM_TRIGGER_THRESHOLD,
  FAMILY_ALERT_THRESHOLD,
} from '../services/liveShieldLlm.js';
import { fireFamilyAlert } from '../services/liveShieldFamilyAlert.js';
// Live Shield v3 — single hook into v2's transcript hot path. Publishes
// each chunk + level-transitions to v3 subscribers (sentinel matcher,
// post-dismiss watcher, B4 claim extractor). All v3 work runs after
// v2's response is built; failures in v3 subscribers cannot break v2's
// transcript ingestion (see v3SessionEvents.notifyTranscriptChunk).
import {
  notifyTranscriptChunk as v3NotifyTranscriptChunk,
  notifyRiskTransition as v3NotifyRiskTransition,
} from '../services/v3SessionEvents.js';
// Mom-side STT dispatch. The transcript route is the producer that
// feeds momSideStt.emitChunk — without this wire, the B3 sentinel
// matcher's evaluateChunk path is dormant in production and Mom's
// SSN/card/MFA pattern detection never fires.
import { emitChunk as v3EmitMomSideChunk } from '../services/momSideStt.js';
// v3 Gap #2 — family-transcript live stream. Family members watching
// via SSE see each chunk land in real time. Both speakers flow
// through ONLY when subject's privacy_level === 'open' — the
// minimal/default levels never reveal transcript text, matching the
// v2 family-alert contract (see liveShieldFamilyAlert.buildAlertPayload).
import { publish as publishToFamilyStream } from '../services/familyTranscriptStream.js';
import { getFamilyAlertPrivacyLevel } from '../services/liveShieldFamilyAlert.js';

// Per-session cache of the subject's privacy_level. The transcript
// route fires N times per session (~7-30/min × call duration). Looking
// up family_alert_preferences on every chunk would be wasteful — the
// preference can't change mid-call from the user's perspective
// (Settings UI requires app foreground; an active call has the app
// in the call surface). Cache for the session's lifetime, evicted
// at /end. Keyed by session_id, not user_id, because the eviction
// is session-scoped.
const transcriptPrivacyCache = new Map<string, 'minimal' | 'default' | 'open'>();
// B3 sentinel matcher session lifecycle. start/stop are fire-and-forget;
// startForSession is async (loads patterns from DB) and the unsubscribe
// fn is tracked here so /end can call it. No-ops when V3_B3_ENABLED off.
import { startForSession as v3StartSentinelMatcher } from '../services/sentinelMatcher.js';
import { disarmPostDismissWatch as v3DisarmPostDismissWatch } from '../services/postDismissWatcher.js';
import { endSession as v3EndB4Session } from '../services/b4Orchestrator.js';
import { pickFlushCadenceMs } from '../services/adaptiveCadence.js';
const v3SentinelStops = new Map<string, () => void>();
// Tracks sessions whose /end ran BEFORE the async sentinel-start resolved.
// Without this, a fast iOS client (e.g., user hangs up immediately after
// pickup, or the call drops mid-handshake) could call /end between the
// /start response and the v3StartSentinelMatcher Promise resolving — at
// which point the .then(stop => v3SentinelStops.set(id, stop)) would
// stash the stop fn AFTER /end already missed it. The Map entry would
// leak permanently, holding stale session state until process restart.
//
// On /end, if the stop fn isn't in the Map yet, we add the session_id
// here. The .then() resolver checks this Set first and tears down
// synchronously instead of stashing. A 60-second TTL on the marker
// prevents this Set itself from leaking when loadPatterns() rejects
// (the .then never fires). The TTL value is decoupled from the worst-
// case load latency by the M1 fix below: if load takes >60s and the
// marker has evicted, the .then() falls through to a DB read of
// call_sessions.ended_at as source of truth before stashing.
const v3SentinelEndedBeforeStart = new Set<string>();
// Holds the eviction NodeJS.Timeout per session so the happy-path
// .then() can cancel it instead of letting it tick for 60s before
// no-op-deleting an already-deleted Set key. Bounded by concurrent
// in-flight-start count; cleared in both the .then() happy path and
// when the eviction tick itself fires.
const v3SentinelEndedBeforeStartTimers = new Map<string, NodeJS.Timeout>();

// Suggestion payload returned to the iOS app when an emergency-relative
// pattern fires. The client uses it to render the "Call them back on
// their saved number" / "Ask for the safe word" panel. If no contact is
// registered, `matched_contact` is null but we still set the suggestion
// flag so the client can prompt the user to add a contact right now.
interface FamilySuggestion {
  matched_contact: {
    id: string;
    display_name: string;
    phone: string;
    relationship: string | null;
    is_guardian: boolean;
    has_safe_word: boolean;
    challenge_prompt: string | null;
    has_challenge: boolean;
  } | null;
  guardian_contacts: Array<{
    id: string;
    display_name: string;
    phone: string;
    relationship: string | null;
  }>;
  instruction: string;
}

async function buildFamilySuggestion(
  userId: string,
  sessionId: string,
): Promise<FamilySuggestion> {
  const peerRes = await query<{ peer_e164: string | null }>(
    `SELECT peer_e164 FROM call_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  const peer = peerRes.rows[0]?.peer_e164 ?? null;

  let matched: FamilySuggestion['matched_contact'] = null;
  if (peer) {
    const m = await query<{
      id: string;
      display_name: string;
      phone_e164: string;
      relationship: string | null;
      is_guardian: boolean;
      has_safe_word: boolean;
      challenge_prompt: string | null;
      has_challenge: boolean;
    }>(
      `SELECT id, display_name, phone_e164, relationship, is_guardian,
              safe_word_hash IS NOT NULL AS has_safe_word,
              challenge_prompt,
              challenge_answer_hash IS NOT NULL AS has_challenge
         FROM family_contacts
        WHERE user_id = $1 AND phone_e164 = $2`,
      [userId, peer],
    );
    if (m.rows[0]) {
      matched = {
        id: m.rows[0].id,
        display_name: m.rows[0].display_name,
        phone: m.rows[0].phone_e164,
        relationship: m.rows[0].relationship,
        is_guardian: m.rows[0].is_guardian,
        has_safe_word: m.rows[0].has_safe_word,
        challenge_prompt: m.rows[0].challenge_prompt,
        has_challenge: m.rows[0].has_challenge,
      };
    }
  }

  const guardians = await query<{
    id: string;
    display_name: string;
    phone_e164: string;
    relationship: string | null;
  }>(
    `SELECT id, display_name, phone_e164, relationship
       FROM family_contacts
      WHERE user_id = $1 AND is_guardian = TRUE
      ORDER BY display_name ASC`,
    [userId],
  );

  return {
    matched_contact: matched,
    guardian_contacts: guardians.rows.map((g) => ({
      id: g.id,
      display_name: g.display_name,
      phone: g.phone_e164,
      relationship: g.relationship,
    })),
    instruction: matched
      ? `Hang up and call ${matched.display_name} back at their saved number — or ask them for your safe word. A real family member will pass this check; a voice-cloning scam won't.`
      : `The caller claims to be family. Hang up and call them back at the number you have saved. If you don't have their number saved, DO NOT send money — call another relative to confirm where they are.`,
  };
}

// Live Shield: in-call protection routes.
//
// Flow:
//   1. Client calls /v1/live-shield/start (returns session_id).
//   2. Client streams on-device transcript chunks to /v1/live-shield/transcript.
//      Each chunk gets scanned; new phrase hits are persisted and the
//      session's running risk snapshot is returned (risk_score, level,
//      new warnings to surface).
//   3. Client calls /v1/live-shield/end on hang-up (or timeout).
//
// The client is responsible for on-device speech recognition. The
// backend never receives audio — only text.

const START_SCHEMA = z.object({
  peer_number: z.string().max(20).optional(),
  direction: z.enum(['inbound', 'outbound', 'unknown']).optional().default('inbound'),
  consent_given: z.boolean(),
  // Live Shield v2: consent_version 1 = original "audio never leaves the
  // phone" disclosure (regex-only, no LLM). consent_version 2 = updated
  // v2 disclosure that explicitly informs the user transcripts may be
  // sent to our AI partner when a call is detected as suspicious.
  // Default to 1 so old iOS clients (pre-v2 build) cannot accidentally
  // opt into the LLM path. The backend refuses to fire Claude on v1
  // sessions — see services/liveShieldLlm.ts claimLlmFiringRights.
  consent_version: z.number().int().min(1).max(2).optional().default(1),
});

const TRANSCRIPT_SCHEMA = z.object({
  seq: z.number().int().nonnegative(),
  speaker: z.enum(['caller', 'self', 'unknown']).optional().default('unknown'),
  text: z.string().min(1).max(4000),
  confidence: z.number().min(0).max(1).optional(),
});

const END_SCHEMA = z.object({
  outcome: z
    .enum(['user_hung_up', 'user_completed', 'user_called_guardian', 'user_abandoned', 'unknown'])
    .optional()
    .default('unknown'),
});

export async function liveShieldRoutes(app: FastifyInstance): Promise<void> {
  // Start a shielded call session. Consent must be explicit — we never
  // analyze audio without it (two-party-consent safety).
  app.post(
    '/v1/live-shield/start',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const parsed = START_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      if (!parsed.data.consent_given) {
        return reply.code(400).send({
          error: 'consent_required',
          message:
            'Live call analysis requires explicit user consent. Present the disclosure before starting.',
        });
      }
      const peer = parsed.data.peer_number ? normalizeE164(parsed.data.peer_number) : null;

      const row = await query<{ id: string; started_at: Date }>(
        `INSERT INTO call_sessions (user_id, peer_e164, direction, consent_given, consent_version)
         VALUES ($1, $2, $3, TRUE, $4)
         RETURNING id, started_at`,
        [user.id, peer, parsed.data.direction, parsed.data.consent_version],
      );
      const { id, started_at } = row.rows[0]!;
      void track('shield_started', {
        userId: user.id,
        properties: { direction: parsed.data.direction, has_peer: !!peer },
      });
      // Live Shield v3 — kick off B3 sentinel matcher for this session.
      // Fire-and-forget; the matcher loads its pattern set asynchronously.
      // No-op if V3_B3_ENABLED is OFF.
      //
      // Race handling: if /end runs before this Promise resolves, the
      // `v3SentinelEndedBeforeStart` Set will have our id, and we tear
      // down the stop fn immediately instead of stashing. The .catch
      // ensures a loadPatterns rejection doesn't become an unhandled
      // promise rejection.
      //
      // M1 fallback: the 60s eviction on the Set was originally the
      // only safety net. If `loadPatterns()` blocks longer than 60s
      // (Neon control-plane hiccup, pool starvation, no pg
      // statement_timeout), the marker is gone by the time .then()
      // resolves and the original HIGH #6 leak resurrects. As a defense
      // we ALSO check the DB before stashing: if the session is
      // already ended_at IS NOT NULL, tear down via stop() instead of
      // storing it. DB is source of truth.
      void v3StartSentinelMatcher(id, user.id)
        .then(async (stop) => {
          // Fast path: marker still alive — /end ran recently.
          if (v3SentinelEndedBeforeStart.has(id)) {
            v3SentinelEndedBeforeStart.delete(id);
            const t = v3SentinelEndedBeforeStartTimers.get(id);
            if (t) {
              clearTimeout(t);
              v3SentinelEndedBeforeStartTimers.delete(id);
            }
            try { stop(); } catch { /* swallow */ }
            return;
          }
          // Slow path: marker may have evicted (loadPatterns > 60s)
          // OR /start happened with the call still active. Either way
          // we go to the DB as source of truth.
          //
          // Observability: this path runs on every active /start
          // (most common path — call is still ongoing when the
          // sentinel matcher finishes loading) so the metric is high-
          // volume. Tag with `marker_present=false` since we already
          // bailed out of the fast path. Filter on this in dashboards
          // to spot pool-pressure regressions.
          emitMetric('v3.sentinel.start_slow_path', {});
          try {
            const r = await query<{ ended_at: Date | null }>(
              `SELECT ended_at FROM call_sessions WHERE id = $1`,
              [id],
            );
            if (r.rows.length === 0 || r.rows[0]!.ended_at) {
              try { stop(); } catch { /* swallow */ }
              return;
            }
          } catch (err) {
            // DB error checking end-state — fall through and stash.
            // Better to leak one stop fn until process restart than
            // tear down a still-active sentinel and miss a takeover.
            // eslint-disable-next-line no-console
            console.warn('[liveShield] sentinel .then DB recheck failed', {
              session_id: id,
              err: err instanceof Error ? err.message : String(err),
            });
          }
          // POST-AWAIT RE-CHECK (MEDIUM-1 from fifth-pass review):
          // /end can run during the SELECT roundtrip. Even if /end's
          // UPDATE was concurrent and committed, the snapshot taken
          // server-side at the SELECT's statement-start could predate
          // the UPDATE → we'd see ended_at=NULL and fall through to
          // stash. Meanwhile /end already saw the empty Map, added to
          // the Set, scheduled the 60s eviction (which only cleans Set
          // + Timers, NOT v3SentinelStops). Re-checking the Set after
          // the await closes that window — the Set is the authoritative
          // signal that /end actually ran.
          if (v3SentinelEndedBeforeStart.has(id)) {
            v3SentinelEndedBeforeStart.delete(id);
            const t = v3SentinelEndedBeforeStartTimers.get(id);
            if (t) {
              clearTimeout(t);
              v3SentinelEndedBeforeStartTimers.delete(id);
            }
            emitMetric('v3.sentinel.start_lost_to_end_post_await', {});
            try { stop(); } catch { /* swallow */ }
            return;
          }
          v3SentinelStops.set(id, stop);
        })
        .catch((err) => {
          v3SentinelEndedBeforeStart.delete(id);
          const t = v3SentinelEndedBeforeStartTimers.get(id);
          if (t) {
            clearTimeout(t);
            v3SentinelEndedBeforeStartTimers.delete(id);
          }
          // eslint-disable-next-line no-console
          console.warn('[liveShield] v3StartSentinelMatcher failed', {
            session_id: id,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      return reply.send({
        session_id: id,
        started_at: started_at.toISOString(),
        risk_score: 0,
        risk_level: 'low',
        triggered_categories: [],
      });
    },
  );

  // Submit a transcript chunk. Server scans for phrase hits, persists
  // both the event and any new hits, re-scores the session with all
  // hits seen so far, and returns the fresh snapshot + any newly-fired
  // warnings the client should display.
  app.post(
    '/v1/live-shield/:id/transcript',
    {
      preHandler: [requireAppUser, requireProTier],
      // Per-user limiter. Adaptive cadence (adaptiveCadence.ts) means
      // chunks/min depends on risk_level:
      //   low    → 8s  → ~7 chunks/min  (~17× margin)
      //   medium → 5s  → ~12 chunks/min (~10× margin)
      //   high   → 3s  → ~20 chunks/min (~6× margin)
      //   crit   → 2s  → ~30 chunks/min (~4× margin)
      // 120/min still leaves headroom at every level; critical
      // sessions typically end in seconds (takeover fires) so the
      // 4× margin at that level isn't a real DoS concern.
      config: {
        rateLimit: {
          max: 120,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.appUser?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const parsed = TRANSCRIPT_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      const owned = await query<{
        id: string;
        ended_at: Date | null;
        risk_level: string;
        started_at: Date;
      }>(
        `SELECT id, ended_at, risk_level, started_at FROM call_sessions WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (owned.rows.length === 0) return reply.code(404).send({ error: 'session_not_found' });
      if (owned.rows[0]!.ended_at) return reply.code(409).send({ error: 'session_ended' });
      // Capture pre-update level so v3's risk-transition hook can fire
      // only on actual transitions (not stable-state ticks).
      const v3PriorRiskLevel = owned.rows[0]!.risk_level as 'low' | 'medium' | 'high' | 'critical';
      // Migration 007 column is named `started_at`, not `created_at`.
      // Used for offset_seconds in the mom-side STT dispatch below.
      const sessionStartedAt = owned.rows[0]!.started_at;

      // Detect phrases against plaintext BEFORE encryption. The plaintext
      // never touches disk — only the ciphertext lands in transcript_events.
      const newHits = detectPhrases(parsed.data.text);
      const encryptedText = encryptString(parsed.data.text);

      const snapshot = await withTx(async (client) => {
        // Upsert transcript event. Client retries with the same seq keep
        // the same row — use DO UPDATE so RETURNING always yields the id.
        // `text` is set to empty string (column is nullable post-migration
        // 020 but still present for backward compat with legacy readers);
        // the real payload is in text_ct.
        const evt = await client.query<{ id: string }>(
          `INSERT INTO transcript_events (session_id, seq, speaker, text, text_ct, confidence)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (session_id, seq) DO UPDATE
             SET text = EXCLUDED.text,
                 text_ct = EXCLUDED.text_ct,
                 confidence = EXCLUDED.confidence
           RETURNING id`,
          [id, parsed.data.seq, parsed.data.speaker, '', encryptedText, parsed.data.confidence ?? null],
        );
        const eventId = evt.rows[0]!.id;

        // Single multi-row INSERT for all new phrase hits in this chunk.
        // ON CONFLICT (session_id, pattern_id) DO NOTHING skips duplicates
        // we've already persisted in a prior chunk. RETURNING pattern_id
        // gives us exactly the set that was newly inserted. Replaces N
        // serial round-trips with 1 (critical on a Live Shield path that
        // fires ~7 chunks/min × up to 5 hits = 35 saved RTTs/call).
        let newlyPersistedIds: string[] = [];
        if (newHits.length > 0) {
          const values: string[] = [];
          const params: unknown[] = [];
          let p = 0;
          for (const hit of newHits) {
            values.push(
              `($${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p})`,
            );
            params.push(
              id,
              eventId,
              hit.pattern.id,
              hit.pattern.category,
              hit.pattern.severity,
              hit.pattern.weight,
              '',
              encryptString(hit.matched_text),
            );
          }
          const ins = await client.query<{ pattern_id: string }>(
            `INSERT INTO scam_phrase_hits
               (session_id, transcript_event_id, pattern_id, category, severity, weight, matched_text, matched_text_ct)
             VALUES ${values.join(', ')}
             ON CONFLICT (session_id, pattern_id) DO NOTHING
             RETURNING pattern_id`,
            params,
          );
          newlyPersistedIds = ins.rows.map((r) => r.pattern_id);
        }

        // Rebuild full hit set and re-score. Score calculation only needs
        // pattern metadata — the matched_text string isn't used for
        // scoring, so we don't need to decrypt the ciphertext here.
        const allHits = await client.query<{ pattern_id: string }>(
          `SELECT pattern_id FROM scam_phrase_hits WHERE session_id = $1`,
          [id],
        );

        const rehydrated: PhraseHit[] = [];
        for (const row of allHits.rows) {
          const p = patternById(row.pattern_id);
          if (p) rehydrated.push({ pattern: p, matched_text: '', offset: 0 });
        }
        const score = scoreHits(rehydrated);

        await client.query(
          `UPDATE call_sessions
              SET risk_score = $2,
                  risk_level = $3,
                  triggered_categories = $4,
                  updated_at = NOW()
            WHERE id = $1`,
          [id, score.risk_score, score.risk_level, score.triggered_categories],
        );

        return { score, newHitIds: newlyPersistedIds };
      });

      const newWarnings = snapshot.newHitIds
        .map((pid) => {
          const p = patternById(pid);
          return p ? { pattern_id: p.id, label: p.label, severity: p.severity, category: p.category } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      // Deepfake / emergency-relative defense: if the session has ever
      // triggered emergency_relative OR the caller claimed to be
      // family, attach the family-verify guidance + any registered
      // contact matching the peer number.
      const emergency =
        snapshot.score.triggered_categories.includes('emergency_relative');
      let familySuggest: FamilySuggestion | null = null;
      if (emergency) {
        familySuggest = await buildFamilySuggestion(user.id, id);
      }

      // Live Shield v2 — hybrid risk engine.
      //
      // Read the LLM cache that may have been populated by an earlier
      // chunk's async LLM call. Merge regex + LLM scores (LLM can
      // escalate, never demote — see services/liveShieldLlm.ts).
      const llmRow = await query<{
        llm_score: number | null;
        llm_scam_type: string | null;
        llm_coaching_line: string | null;
        llm_last_called_at: Date | null;
        b4_findings_count: number;
        b4_score_boost: number;
      }>(
        `SELECT llm_score, llm_scam_type, llm_coaching_line, llm_last_called_at,
                b4_findings_count, b4_score_boost
           FROM call_sessions WHERE id = $1`,
        [id],
      );
      const llmScore = llmRow.rows[0]?.llm_score ?? null;
      const llmCoachingLine = llmRow.rows[0]?.llm_coaching_line ?? null;
      const llmScamType = llmRow.rows[0]?.llm_scam_type ?? null;
      const llmLastCalledAt = llmRow.rows[0]?.llm_last_called_at ?? null;
      const b4FindingsCount = llmRow.rows[0]?.b4_findings_count ?? 0;
      const b4ScoreBoost = llmRow.rows[0]?.b4_score_boost ?? 0;

      // v3 Gap #3 — additive B4 sub-threshold boost. Stacks weak
      // signals (cannot_verify + sub-threshold contradicted) onto
      // the merged regex+LLM score. Cap at 100 because risk_score
      // is bounded; without the cap, a session with several boost
      // accumulations could push the merged value above 100 and
      // break downstream consumers that key off level thresholds.
      // The boost itself is already capped at 100 in the DB CHECK
      // constraint, but additive saturation here is defense-in-depth.
      //
      // ONE-CHUNK LAG: the boost read here is the snapshot AT-CHUNK-
      // START. Any B4 findings derived from THIS chunk's transcript
      // can only surface in the NEXT chunk's merge — the orchestrator
      // subscribes to v3NotifyTranscriptChunk (fired below), then
      // runs extract → verify → applyB4ScoreBoost asynchronously,
      // which won't have committed by the time this route returns.
      // Same lag pattern as the LLM cache (mergeScores) — accept it
      // rather than blocking the hot path on B4's Claude/Serper
      // latency. Adaptive cadence keeps the lag at 2-8s depending
      // on risk level, which is fast enough for the critical-
      // transition UX.
      const finalScore = Math.min(
        100,
        mergeScores(snapshot.score.risk_score, llmScore) + b4ScoreBoost,
      );
      const finalLevel: 'low' | 'medium' | 'high' | 'critical' =
        finalScore >= 75 ? 'critical' :
        finalScore >= 50 ? 'high' :
        finalScore >= 25 ? 'medium' : 'low';

      // If the merged score differs from the regex-only snapshot we just
      // wrote inside the tx, persist the merged value so subsequent
      // reads (auto-populate, dashboard, this same route on next chunk)
      // see the truth.
      if (finalScore !== snapshot.score.risk_score) {
        await query(
          `UPDATE call_sessions
              SET risk_score = $2, risk_level = $3, updated_at = NOW()
            WHERE id = $1`,
          [id, finalScore, finalLevel],
        );
      }

      // Fire Claude async if regex crossed the trigger threshold AND we're
      // outside the 8-second debounce window. Fire-and-forget — the next
      // chunk reads the updated cache. This is the key cost-control: the
      // LLM only runs on suspicious calls (≈30% of shielded sessions).
      if (
        snapshot.score.risk_score >= LLM_TRIGGER_THRESHOLD &&
        shouldFireLlm(llmLastCalledAt)
      ) {
        void runLlmAndCache({
          session_id: id,
          triggered_categories: snapshot.score.triggered_categories,
          regex_score: snapshot.score.risk_score,
          subject_user_id: user.id,
        });
      }

      // Family alert fan-out at merged score ≥ 75. Idempotent per-session
      // (fireFamilyAlert checks family_alert_fired_at atomically and
      // refuses to fire twice). Privacy level (minimal/default/open) is
      // looked up inside the helper from family_alert_preferences.
      //
      // Defense-in-depth: require regex_score ≥ FAMILY_ALERT_FLOOR (65)
      // in addition to the merged-score threshold. This means the LLM
      // can ESCALATE a strong regex signal into a family alert but
      // cannot SINGLE-HANDEDLY cause one. Without this floor, a
      // prompt-injected LLM could conjure a critical score from a
      // borderline regex and fire family unnecessarily.
      const FAMILY_ALERT_REGEX_FLOOR = 65;
      if (
        finalScore >= FAMILY_ALERT_THRESHOLD &&
        snapshot.score.risk_score >= FAMILY_ALERT_REGEX_FLOOR
      ) {
        void fireFamilyAlert({
          session_id: id,
          subject_user_id: user.id,
          risk_score: finalScore,
          scam_type: llmScamType ?? snapshot.score.triggered_categories[0] ?? 'unknown',
          matched_red_flags: snapshot.score.rationale.slice(0, 5),
        });
      }

      // Track shield_critical only when new patterns landed AND merged
      // score is critical. Same trigger semantics as v1 but using the
      // merged score so an LLM-escalated call still emits the event.
      if (snapshot.newHitIds.length > 0 && finalLevel === 'critical') {
        void track('shield_critical', {
          userId: user.id,
          properties: {
            risk_score: finalScore,
            categories: snapshot.score.triggered_categories,
            llm_invoked: llmScore !== null,
          },
        });
      }

      // Family-emergency safe-word flow stays as a SECOND alert channel
      // (different kind, different UX). Independent of the family-plan
      // critical alert above — emergency-relative + non-critical can
      // still fire here.
      if (snapshot.newHitIds.length > 0 && emergency) {
        void emitGuardianAlert({
          subjectUserId: user.id,
          kind: 'shield_family_emergency',
          severity: 'warning',
          title: 'Caller is claiming a family emergency',
          body:
            'Someone is claiming to be family and asking for money. We\'ve asked them to ' +
            'verify with a safe word. A real family member will pass this check.',
          payload: { session_id: id },
        });
      }

      // Live Shield v3 — publish to v3 subscribers. Fire-and-forget;
      // sentinel matcher, post-dismiss watcher, and B4 claim extractor
      // each subscribe out from v3SessionEvents.
      //
      // Errors in v3 subscribers are caught inside the hub itself and
      // do NOT bubble back to the v2 hot path. The void/no-await pattern
      // here is a defense-in-depth against any subscriber that ignores
      // the don't-throw rule.
      void v3NotifyTranscriptChunk({
        session_id: id,
        user_id: user.id,
        speaker: parsed.data.speaker,
        text: parsed.data.text,
        confidence: parsed.data.confidence ?? null,
        spoken_at: new Date(),
      });

      // v3 Gap #2 — fan the chunk out to family-plan members
      // subscribed via SSE. HIGH-1 adversarial fix: gate on Mom's
      // privacy_level preference. Only `open` permits live transcript
      // text to flow to family viewers — matches the v2 family-alert
      // contract where minimal/default never reveal transcript content.
      // System events (B3/B4 takeover markers, family-alert dispatch)
      // flow independently through emitSystemEvent → publishToFamilyStream
      // and are always visible regardless of privacy_level, because
      // those are meta-events about Mom's safety, not transcript words.
      //
      // Cache hit on every chunk after the first per session — saves
      // ~7-30 DB roundtrips/min. Evicted at /end.
      try {
        let level = transcriptPrivacyCache.get(id);
        if (!level) {
          level = await getFamilyAlertPrivacyLevel(user.id);
          transcriptPrivacyCache.set(id, level);
        }
        if (level === 'open') {
          publishToFamilyStream({
            type: 'transcript',
            subject_user_id: user.id,
            session_id: id,
            speaker: parsed.data.speaker,
            text: parsed.data.text,
            spoken_at: new Date().toISOString(),
          });
        }
      } catch {
        /* swallow — never break the v2 transcript hot path on a
           family-stream publish error. Fail-closed by default
           because getFamilyAlertPrivacyLevel's own catch returns
           'minimal' (no publish). */
      }

      // Mom-side STT dispatch — feed the B3 sentinelMatcher's
      // evaluateChunk path. Only `self`-speaker chunks (Mom's voice
      // as labeled by iOS's on-device speaker diarization) flow here;
      // caller-side flows through v3SessionEvents to the
      // sentinelMatcher's scammer-context buffer instead. The
      // V3_B3_MOM_SIDE_STT_ENABLED kill-switch is checked inside
      // emitChunk; gating duplicated here would just slow the hot
      // path.
      //
      // Confidence default of `0.0` (NOT 0.8 — see below): the
      // sentinelMatcher gates at `< 0.6` to filter out misheard
      // audio that would false-positive the digit-pattern sentinels
      // (ssn_spoken_aloud, card_number_spoken_aloud,
      // mfa_code_spoken_aloud). The whole point of the gate is "we
      // don't fire takeovers on uncertain transcription." A `?? 0.8`
      // default would invert that — clients that don't send
      // confidence (older iOS builds, transient SFSpeechRecognizer
      // states) would PASS the gate as if they were high-confidence,
      // exactly the case the gate is meant to exclude. With `?? 0.0`,
      // old clients are gracefully degraded (no B3 firing) without
      // errors; new iOS builds that ship `confidence` in every
      // chunk get the full sentinel benefit. INTENTIONAL asymmetry
      // with `v3NotifyTranscriptChunk` above (which passes `null` —
      // the scammer-context-buffer path doesn't use confidence at
      // all, only mom-side evaluateChunk does).
      //
      // Fire-and-forget: emitChunk dispatches to subscribers (regex
      // eval is fast; takeover enqueue is itself fire-and-forget),
      // so the transcript route doesn't block on B3 work.
      if (parsed.data.speaker === 'self') {
        const offsetSeconds = Math.max(
          0,
          Math.floor((Date.now() - sessionStartedAt.getTime()) / 1000),
        );
        void v3EmitMomSideChunk({
          session_id: id,
          user_id: user.id,
          text: parsed.data.text,
          confidence: parsed.data.confidence ?? 0.0,
          offset_seconds: offsetSeconds,
          emitted_at: new Date(),
        });
      }

      const v3NewLevel = finalLevel as 'low' | 'medium' | 'high' | 'critical';
      if (v3NewLevel !== v3PriorRiskLevel) {
        void v3NotifyRiskTransition({
          session_id: id,
          user_id: user.id,
          previous_level: v3PriorRiskLevel,
          new_level: v3NewLevel,
          current_score: finalScore,
          occurred_at: new Date(),
        });
      }

      // Adaptive transcript-flush cadence (Live Shield v3+).
      // The server tells iOS how soon to send the next chunk based on
      // current risk state. See src/services/adaptiveCadence.ts for
      // the threshold table. Older iOS clients that don't read this
      // field continue to use their compiled-in 8s default — safe to
      // ship server-side without an iOS update.
      const nextFlushMs = pickFlushCadenceMs({
        risk_level: finalLevel,
        has_any_b4_finding: b4FindingsCount > 0,
      });

      return reply.send({
        session_id: id,
        risk_score: finalScore,
        risk_level: finalLevel,
        triggered_categories: snapshot.score.triggered_categories,
        rationale: snapshot.score.rationale,
        // v2 additions: surface the LLM coaching + scam type so iOS can
        // render them inline. Both are null until Claude has spoken on
        // this session for the first time.
        coaching_line: llmCoachingLine,
        llm_scam_type: llmScamType,
        new_warnings: newWarnings,
        family_verify_suggested: emergency,
        family_suggestion: familySuggest,
        // Server-driven flush cadence; iOS reschedules its next
        // /transcript POST after this many ms. See adaptiveCadence.ts.
        next_flush_ms: nextFlushMs,
      });
    },
  );

  // End the session. Locks risk snapshot, records duration + outcome.
  app.post(
    '/v1/live-shield/:id/end',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const parsed = END_SCHEMA.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      // v3 Gap #2 — evict the per-session privacy-level cache. The
      // transcript route populates it lazily; the session is the
      // unit of lifetime.
      transcriptPrivacyCache.delete(id);

      const result = await query<{
        started_at: Date;
        ended_at: Date;
        duration_seconds: number;
        risk_score: number;
        risk_level: string;
        triggered_categories: string[];
      }>(
        `UPDATE call_sessions
            SET ended_at = NOW(),
                outcome = $3,
                duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INT,
                updated_at = NOW()
          WHERE id = $1 AND user_id = $2 AND ended_at IS NULL
         RETURNING started_at, ended_at, duration_seconds, risk_score, risk_level, triggered_categories`,
        [id, user.id, parsed.data.outcome],
      );
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'session_not_found_or_already_ended' });
      }
      const row = result.rows[0]!;

      // Live Shield v3 — tear down B3 per-session state. Both calls
      // are no-ops when V3_B3_ENABLED is off OR when the session
      // never had v3 state attached.
      const stopSentinel = v3SentinelStops.get(id);
      if (stopSentinel) {
        try { stopSentinel(); } catch { /* swallow */ }
        v3SentinelStops.delete(id);
      } else {
        // Sentinel start may still be in-flight (fast iOS hangup after
        // pickup, or transient call drop). Mark the session as "ended
        // before start" so the .then() resolver in /start tears down
        // immediately instead of leaking into the Map. The 60s TTL is
        // a defensive evict in case loadPatterns rejected (the .then
        // never fires and would otherwise leave this entry stuck).
        // The .then()'s DB-truth recheck (M1) catches any load that
        // exceeds this 60s ceiling, so the value itself isn't safety-
        // critical — it just controls how long this fast-path marker
        // is kept around for a quick microtask-queue tear-down.
        v3SentinelEndedBeforeStart.add(id);
        const tick = setTimeout(() => {
          v3SentinelEndedBeforeStart.delete(id);
          v3SentinelEndedBeforeStartTimers.delete(id);
        }, 60_000);
        tick.unref();
        v3SentinelEndedBeforeStartTimers.set(id, tick);
      }
      v3DisarmPostDismissWatch(id);
      // Drop B4's per-session rolling-text context Map entry so
      // long-running processes don't accumulate unbounded session
      // state. No-op when V3_B4_ENABLED is off or the session never
      // had B4 activity.
      v3EndB4Session(id);

      void track('shield_ended', {
        userId: user.id,
        properties: {
          session_id: id,
          duration_seconds: row.duration_seconds,
          final_risk_score: row.risk_score,
          final_risk_level: row.risk_level,
          triggered_categories: row.triggered_categories,
          outcome: parsed.data.outcome,
        },
      });

      // Founder-dashboard signal — fires only when a critical-risk call
      // ends with the user disengaging (hung up or escalated to their
      // guardian). user_completed / user_abandoned aren't counted because
      // we can't tell from those whether the user fell for the scam.
      if (
        row.risk_level === 'critical' &&
        (parsed.data.outcome === 'user_hung_up' ||
          parsed.data.outcome === 'user_called_guardian')
      ) {
        trackCallBlocked(user.id, {
          sessionId: id,
          riskScore: row.risk_score,
          durationSeconds: row.duration_seconds,
          outcome: parsed.data.outcome,
          triggeredCategories: row.triggered_categories,
        });
      }

      // Live Shield v2 — Auto-handoff to Recovery Concierge.
      //
      // Trigger conditions (locked in LIVE_SHIELD.md):
      //   - risk_level == 'critical' AND outcome in {'user_hung_up',
      //     'user_called_guardian'}, OR
      //   - 'payment_fraud' in triggered_categories AND risk_level == 'critical'
      //
      // The backend pre-creates a triage-mode recovery_sessions row with
      // peer_e164 and llm_scam_type pre-populated. iOS surfaces it as
      // "We saved you from a scam — want help with the next 15 minutes?"
      // The user converts to full recovery via the existing triage/resolve
      // endpoint, or abandons.
      let recoveryHandoffSessionId: string | null = null;
      const eligibleByOutcome =
        row.risk_level === 'critical' &&
        (parsed.data.outcome === 'user_hung_up' || parsed.data.outcome === 'user_called_guardian');
      const eligibleByMoneyMoved =
        row.risk_level === 'critical' && row.triggered_categories.includes('payment_fraud');

      if (eligibleByOutcome || eligibleByMoneyMoved) {
        try {
          const callMeta = await query<{ peer_e164: string | null; llm_scam_type: string | null }>(
            `SELECT peer_e164, llm_scam_type FROM call_sessions WHERE id = $1`,
            [id],
          );
          const peerE164 = callMeta.rows[0]?.peer_e164 ?? null;
          const llmScamType = callMeta.rows[0]?.llm_scam_type ?? null;

          const familyPlan = await query<{ id: string }>(
            `SELECT family_plan_id AS id FROM family_members WHERE user_id = $1`,
            [user.id],
          );
          const familyPlanId = familyPlan.rows[0]?.id ?? null;

          // Insert as 'triage' mode so the user has to confirm before we
          // light up guardian alerts a second time. scam_type defaults
          // to 'unknown_triage' if the LLM never classified — the user
          // picks during triage resolution.
          const recoveryRow = await query<{ id: string }>(
            `INSERT INTO recovery_sessions (
               user_id, family_plan_id, scam_e164, scam_e164_ct, scam_type,
               amount_lost_cents, description, description_ct, mode
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'triage')
             RETURNING id`,
            [
              user.id,
              familyPlanId,
              '',
              peerE164 ? encryptString(peerE164) : null,
              llmScamType ?? 'unknown_triage',
              null,
              '',
              null,
            ],
          );
          recoveryHandoffSessionId = recoveryRow.rows[0]?.id ?? null;

          void track('recovery_started', {
            userId: user.id,
            properties: {
              recovery_session_id: recoveryHandoffSessionId,
              shield_session_id: id,
              source: 'live_shield_auto_handoff',
              scam_type: llmScamType ?? 'unknown_triage',
              trigger: eligibleByMoneyMoved ? 'payment_fraud_critical' : 'critical_with_outcome',
            },
          });
        } catch (err) {
          // Don't block the /end response on a recovery-handoff failure.
          // iOS still has /v1/recovery/auto-populate as a fallback.
          req.log.warn({ err, session_id: id }, 'live_shield_auto_handoff_failed');
        }
      }

      return reply.send({
        session_id: id,
        started_at: row.started_at.toISOString(),
        ended_at: row.ended_at.toISOString(),
        duration_seconds: row.duration_seconds,
        risk_score: row.risk_score,
        risk_level: row.risk_level,
        triggered_categories: row.triggered_categories,
        outcome: parsed.data.outcome,
        // v2: pre-created recovery session id (null when not eligible).
        recovery_handoff_session_id: recoveryHandoffSessionId,
      });
    },
  );

  // Active session (if any) for the current user — for resume-in-progress.
  // REGISTERED BEFORE /:id so Fastify matches /active literally rather than
  // treating "active" as a session id.
  app.get(
    '/v1/live-shield/active',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const row = await query<{ id: string }>(
        `SELECT id FROM call_sessions
          WHERE user_id = $1 AND ended_at IS NULL
          ORDER BY started_at DESC LIMIT 1`,
        [user.id],
      );
      if (row.rows.length === 0) return reply.send({ active: false });
      return reply.send({ active: true, session_id: row.rows[0]!.id });
    },
  );

  // Get current state. Used for the iOS "resume in-flight shield" flow.
  app.get(
    '/v1/live-shield/:id',
    { preHandler: [requireAppUser, requireProTier] },
    async (req, reply) => {
      const user = req.appUser!;
      const { id } = req.params as { id: string };
      const sess = await query<{
        id: string;
        peer_e164: string | null;
        direction: string;
        started_at: Date;
        ended_at: Date | null;
        risk_score: number;
        risk_level: string;
        triggered_categories: string[];
        outcome: string | null;
      }>(
        `SELECT id, peer_e164, direction, started_at, ended_at, risk_score,
                risk_level, triggered_categories, outcome
           FROM call_sessions WHERE id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (sess.rows.length === 0) return reply.code(404).send({ error: 'session_not_found' });
      const hits = await query<{
        pattern_id: string;
        category: string;
        severity: number;
        matched_text: string | null;
        matched_text_ct: string | null;
        created_at: Date;
      }>(
        `SELECT pattern_id, category, severity, matched_text, matched_text_ct, created_at
           FROM scam_phrase_hits WHERE session_id = $1 ORDER BY created_at ASC`,
        [id],
      );
      const row = sess.rows[0]!;
      return reply.send({
        session_id: row.id,
        peer_number: row.peer_e164,
        direction: row.direction,
        started_at: row.started_at.toISOString(),
        ended_at: row.ended_at?.toISOString() ?? null,
        risk_score: row.risk_score,
        risk_level: row.risk_level,
        triggered_categories: row.triggered_categories,
        outcome: row.outcome,
        hits: hits.rows.map((h) => ({
          pattern_id: h.pattern_id,
          label: patternById(h.pattern_id)?.label ?? h.pattern_id,
          category: h.category,
          severity: h.severity,
          matched_text: readMaybeEncrypted(h.matched_text_ct) || h.matched_text || null,
          at: h.created_at.toISOString(),
        })),
      });
    },
  );

}
