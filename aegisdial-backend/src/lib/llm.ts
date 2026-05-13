import { config } from '../config.js';
import { emitMetric } from './observability.js';

// Thin Anthropic Messages-API wrapper. The codebase historically
// inlines `fetch(...)` to api.anthropic.com in each service file
// (claimExtractor / b4Layer2 / stageClassifier / companyQuery /
// recoveryCompanion / textAnalyzer) — Recovery Shield's wire-trace,
// crypto-trace, and legal-packet generators all need an LLM call
// with the SAME shape, so we lift that one shape into a single
// exported helper.
//
// DESIGN DECISIONS:
//
//   - Returns the model's text output verbatim (caller parses JSON
//     itself if it asked for JSON). The inlined services do the same;
//     a generic JSON-parser here would obscure failure modes.
//
//   - Default model: claude-sonnet-4-6 (the same alias
//     recoveryCompanion.ts uses, deliberate per its comment — these
//     are user-facing recovery surfaces, NOT in-call hot path, so
//     latency budget allows Sonnet rather than Haiku).
//
//   - Timeout: 30s default. Bank-dispute letters take longer to
//     generate than a 4-token verdict refinement; default needs to
//     match the slowest legitimate use case in the surface area.
//
//   - Error policy: throws on missing key, http error, or empty
//     response. Callers decide whether to fall back (Recovery Shield
//     calls don't have a non-LLM fallback — they propagate).
//
//   - `opts.llmFn` injection is the test seam — every caller takes
//     `{ llmFn?: typeof callLLM }` so unit tests stub deterministic
//     output without hitting the network.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/** Default model for Recovery Shield generator surfaces. */
export const DEFAULT_LLM_MODEL = 'claude-sonnet-4-6';

/** Default timeout. 30s — bank dispute letters > 1024 tokens. */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

export class LLMUnavailableError extends Error {
  constructor(reason: string) {
    super(`LLM unavailable: ${reason}`);
    this.name = 'LLMUnavailableError';
  }
}

export interface CallLLMInput {
  /** System prompt — cached via ephemeral cache_control. */
  system: string;
  /** User message body. The model returns text in response. */
  user: string;
  /** Override default model. */
  model?: string;
  /** Override default max_tokens. Default 2048. */
  maxTokens?: number;
  /** Override default timeout in ms. */
  timeoutMs?: number;
}

/**
 * Single Anthropic Messages API turn. Returns the model's text
 * output verbatim. Throws LLMUnavailableError on:
 *
 *  - missing ANTHROPIC_API_KEY (mis-deploy guard)
 *  - non-2xx HTTP response (auth failure, rate limit, model error)
 *  - empty text block (model returned tool-use only, or refusal
 *    formatted as empty text — caller can't act on either)
 *
 * Tests inject a stub via the caller's `opts.llmFn` rather than
 * monkey-patching this function; this helper stays pure.
 */
export async function callLLM(input: CallLLMInput): Promise<string> {
  if (!config.ANTHROPIC_API_KEY) {
    throw new LLMUnavailableError('ANTHROPIC_API_KEY not configured');
  }

  const model = input.model ?? DEFAULT_LLM_MODEL;
  const maxTokens = input.maxTokens ?? 2048;
  const timeoutMs = input.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: [
          {
            type: 'text',
            text: input.system,
            // System prompts (bank templates, doc scaffolds) are stable
            // across calls; the user content is what varies per case.
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: input.user }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      void emitMetric('llm.call_failed', { status: res.status });
      throw new LLMUnavailableError(`http ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((c) => c.type === 'text')?.text;
    if (!text) {
      void emitMetric('llm.call_empty', {});
      throw new LLMUnavailableError('empty text content');
    }

    void emitMetric('llm.call_succeeded', { model }, Date.now() - started);
    return text;
  } finally {
    clearTimeout(timer);
  }
}
