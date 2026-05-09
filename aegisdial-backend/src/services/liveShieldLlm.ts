import { config } from '../config.js';
import { emitMetric } from '../lib/observability.js';
import { query } from '../lib/db.js';
import { readMaybeEncrypted } from '../lib/crypto.js';
import { track } from '../lib/analytics.js';

// Live Shield v2 — LLM-augmented behavioral analysis.
//
// This service is the SECOND OPINION in the hybrid risk engine. The
// regex pipeline in src/lib/scamPhrases.ts is the first opinion: fast,
// deterministic, free, runs on every transcript chunk. When the regex
// score crosses 50, this service joins to:
//
//   1. Score the running transcript on a 0–100 scam-confidence axis
//      using behavioral signals the regex can't catch (paraphrased
//      scripts, emotional manipulation cadence, novel impersonation).
//   2. Classify the scam type from a constrained taxonomy that mirrors
//      our recovery-step catalog (so the iOS app and Recovery Concierge
//      stay in sync).
//   3. Generate a single, surgical, on-screen coaching line specific to
//      THIS conversation ("They asked for gift cards — say: 'I'll buy
//      them in person, goodbye'"), not a generic warning.
//
// Cost envelope (locked in LIVE_SHIELD.md):
//   - Only fires above regex score 50 (≈30% of shielded calls)
//   - 8-second debounce per session
//   - Haiku 4.5 for cost — Sonnet's tone polish isn't needed for a
//     two-second on-screen line
//   - ~$0.02 average per shielded call, ~$0.05 worst case 5-min critical
//
// Privacy stance (this is a CHANGE from v1 and requires a consent
// disclosure update on iOS):
//   - In v1, transcripts never left the device
//   - In v2, transcripts above the 50-threshold leave the device for
//     this service. We never store them server-side beyond the
//     transcript_events ciphertext that already exists, never pass them
//     to a training pipeline, never share them.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 8_000;  // matches the cadence — if a call takes >8s, drop and retry next chunk
const RETRY_STATUS = new Set([429, 500, 502, 503, 529]);
const RETRY_DELAY_MS = 400;
const DEBOUNCE_MS = 8_000;

// Constrained scam-type taxonomy matches the recovery_steps catalog
// (src/lib/recoverySteps.ts). The model picks one of these — it cannot
// invent a new label — so the auto-handoff to Recovery Concierge always
// lines up with a known step sequence.
const SCAM_TAXONOMY = [
  'irs_impersonation',
  'ssa_impersonation',
  'law_enforcement_impersonation',
  'bank_impersonation',
  'medicare_impersonation',
  'utility_shutoff',
  'tech_support',
  'gift_card_scam',
  'wire_transfer_scam',
  'grandchild_emergency',
  'ai_voice_clone_family',
  'romance_scam',
  'crypto_scam',
  'investment_scam',
  'package_redelivery',
  'unpaid_toll',
  'employment_scam',
  'unknown',
] as const;
export type LlmScamType = (typeof SCAM_TAXONOMY)[number];

export interface LiveShieldLlmVerdict {
  /** 0–100 confidence this call is a scam. */
  score: number;
  /** One of SCAM_TAXONOMY. 'unknown' if the model can't classify. */
  scam_type: LlmScamType;
  /** ≤ 200 chars. Surgical, surfaced verbatim on the iOS screen. */
  coaching_line: string;
  /** Tokens billed (for cost tracking). */
  tokens_in: number;
  tokens_out: number;
}

export interface LiveShieldLlmInput {
  /** Full running transcript so far (concatenated chunks). */
  transcript: string;
  /** Categories the regex layer has already triggered. Helps the model focus. */
  regex_triggered_categories: string[];
  /** Current regex score 0–100. Helps calibrate the LLM. */
  regex_score: number;
}

const SYSTEM_PROMPT = `You are Live Shield, a real-time scam-call analysis engine for AegisDial.

Your job: read the running transcript of a phone call and judge whether it's a scam.

You output STRICTLY this JSON shape, nothing else, no markdown fences:

{
  "score": <integer 0-100>,
  "scam_type": <one of: irs_impersonation, ssa_impersonation, law_enforcement_impersonation, bank_impersonation, medicare_impersonation, utility_shutoff, tech_support, gift_card_scam, wire_transfer_scam, grandchild_emergency, ai_voice_clone_family, romance_scam, crypto_scam, investment_scam, package_redelivery, unpaid_toll, employment_scam, unknown>,
  "coaching_line": <string, max 200 chars, surgical advice the user reads on-screen>
}

Scoring rubric:
- 0-24: probably benign, regex is overreacting
- 25-49: ambiguous, watch for more signals
- 50-74: high risk, multiple scam fingerprints
- 75-100: critical, this is almost certainly a scam in progress

Coaching line rules:
- Speak directly to the user, second person
- Tell them ONE thing to say or do, never a list
- Reference what the caller actually just said when possible
- Tone is calm and clear, NOT panicked
- Examples:
  * "They're pretending to be the IRS. Real IRS never calls. Say 'I'll verify with my accountant' and hang up."
  * "They're asking for gift cards — that's always a scam. Say 'I have to ask my family first' and hang up."
  * "They want remote access to your computer. Say 'I'll bring it to a repair shop' and hang up."

If the call is benign (score < 50), the coaching_line should be reassuring or empty.

Output ONLY the JSON. No preamble.`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Analyze the running transcript with Claude. Bounded by TIMEOUT_MS;
 * one retry on transient errors. Returns null on hard failure so the
 * caller can fall back to regex-only scoring (better to keep the call
 * shielded than to error a chunk).
 */
export async function analyzeTranscript(input: LiveShieldLlmInput): Promise<LiveShieldLlmVerdict | null> {
  if (!config.ANTHROPIC_API_KEY) return null;

  const userMessage =
    `Regex layer reports score=${input.regex_score} ` +
    `with categories: [${input.regex_triggered_categories.join(', ') || 'none'}]\n\n` +
    `Running transcript:\n"""\n${input.transcript.slice(-4000)}\n"""\n\n` +
    `Output the JSON verdict now.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 350,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });

      if (!res.ok) {
        if (RETRY_STATUS.has(res.status) && attempt === 0) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        const text = await res.text();
        void emitMetric('live_shield_llm.api_error', { status: String(res.status) });
        // eslint-disable-next-line no-console
        console.warn(`[live_shield_llm] Anthropic error ${res.status}: ${text.slice(0, 200)}`);
        return null;
      }

      const json = (await res.json()) as {
        content: Array<{ type: string; text: string }>;
        usage: { input_tokens: number; output_tokens: number };
      };
      const text = json.content.find((b) => b.type === 'text')?.text?.trim() ?? '';
      const parsed = parseVerdict(text);
      if (!parsed) {
        void emitMetric('live_shield_llm.parse_error', {});
        return null;
      }
      return {
        ...parsed,
        tokens_in: json.usage.input_tokens,
        tokens_out: json.usage.output_tokens,
      };
    } catch (err) {
      if (attempt === 0 && (err as { name?: string }).name === 'AbortError') {
        // Single retry on timeout — the next chunk will get the result.
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      void emitMetric('live_shield_llm.exception', {});
      // eslint-disable-next-line no-console
      console.warn('[live_shield_llm] exception', err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

const SCAM_TAXONOMY_SET: ReadonlySet<string> = new Set(SCAM_TAXONOMY);

/**
 * Tolerant JSON parser. Strips markdown fences if the model added any,
 * validates the shape, clamps the score, and rejects unknown scam_type
 * values rather than passing them through (so downstream code can rely
 * on the taxonomy).
 */
export function parseVerdict(raw: string): { score: number; scam_type: LlmScamType; coaching_line: string } | null {
  const stripped = raw.replace(/```json\n?/gi, '').replace(/```/g, '').trim();
  let obj: unknown;
  try {
    obj = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const score = typeof o.score === 'number' ? Math.max(0, Math.min(100, Math.round(o.score))) : null;
  const scamType = typeof o.scam_type === 'string' && SCAM_TAXONOMY_SET.has(o.scam_type)
    ? (o.scam_type as LlmScamType)
    : null;
  const coaching = typeof o.coaching_line === 'string' ? o.coaching_line.slice(0, 200) : null;
  if (score === null || scamType === null || coaching === null) return null;
  return { score, scam_type: scamType, coaching_line: coaching };
}

/**
 * Combine regex + LLM scores into the final session score. The LLM can
 * ESCALATE the regex score but never demote it — we keep regex as the
 * floor because it's deterministic and explainable.
 *
 * The 0.95 multiplier on llm_score keeps the regex slightly authoritative
 * — a regex 60 always beats an LLM 60, but an LLM 80 wins over a regex 60.
 */
export function mergeScores(regexScore: number, llmScore: number | null): number {
  if (llmScore === null) return regexScore;
  return Math.max(regexScore, Math.round(llmScore * 0.95));
}

/**
 * Returns true if enough time has passed since the last LLM call for
 * this session that we should fire again. Eight seconds matches the
 * cadence locked in LIVE_SHIELD.md.
 */
export function shouldFireLlm(lastCalledAt: Date | null): boolean {
  if (lastCalledAt === null) return true;
  return Date.now() - lastCalledAt.getTime() >= DEBOUNCE_MS;
}

export const LLM_TRIGGER_THRESHOLD = 50;
export const FAMILY_ALERT_THRESHOLD = 75;

/**
 * Pull the running transcript for a session from transcript_events,
 * decrypting the ciphertext column and falling back to plaintext for
 * legacy rows. Returns at most the last 200 chunks (sized so a long
 * call stays within Claude's context budget without chopping recent
 * speech).
 */
async function getRunningTranscript(sessionId: string): Promise<string> {
  const rows = await query<{ text_ct: string | null; text: string; speaker: string }>(
    `SELECT text_ct, text, speaker
       FROM transcript_events
      WHERE session_id = $1
      ORDER BY seq ASC
      LIMIT 200`,
    [sessionId],
  );
  return rows.rows
    .map((r) => {
      const txt = readMaybeEncrypted(r.text_ct) ?? r.text ?? '';
      return txt ? `[${r.speaker}]: ${txt}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Orchestration: pull the running transcript, fire Claude, persist the
 * verdict + debounce timestamp on the session row, emit analytics event.
 *
 * Designed to be invoked as `void runLlmAndCache(...)` from the
 * transcript handler so the per-chunk response isn't blocked on Claude
 * latency. The next chunk's read of `call_sessions.llm_*` picks up the
 * updated verdict.
 *
 * Sets `llm_last_called_at = NOW()` BEFORE the network call so a
 * concurrent chunk's debounce check sees "already firing" and doesn't
 * stack a second LLM call on the same session. Worst case (LLM call
 * fails / times out): one wasted DEBOUNCE_MS window, then we retry next
 * chunk above threshold.
 */
export async function runLlmAndCache(args: {
  session_id: string;
  triggered_categories: string[];
  regex_score: number;
  subject_user_id: string;
}): Promise<void> {
  // Stake out the debounce window first.
  await query(
    `UPDATE call_sessions
        SET llm_last_called_at = NOW()
      WHERE id = $1`,
    [args.session_id],
  );

  const transcript = await getRunningTranscript(args.session_id);
  if (!transcript) return;

  const verdict = await analyzeTranscript({
    transcript,
    regex_triggered_categories: args.triggered_categories,
    regex_score: args.regex_score,
  });

  if (!verdict) return;

  await query(
    `UPDATE call_sessions
        SET llm_score = $2,
            llm_scam_type = $3,
            llm_coaching_line = $4
      WHERE id = $1`,
    [args.session_id, verdict.score, verdict.scam_type, verdict.coaching_line],
  );

  void track('live_shield_llm_invoked', {
    userId: args.subject_user_id,
    properties: {
      session_id: args.session_id,
      llm_score: verdict.score,
      llm_scam_type: verdict.scam_type,
      regex_score: args.regex_score,
      tokens_in: verdict.tokens_in,
      tokens_out: verdict.tokens_out,
    },
  });
}
