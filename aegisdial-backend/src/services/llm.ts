import { config } from '../config.js';
import type { EvidenceItem, NumberSignals } from '../types.js';

export interface LLMRefineInput {
  e164: string;
  signals: NumberSignals;
  evidence: EvidenceItem[];
  base_score: number;
  base_verdict: string;
}

export interface LLMRefineOutput {
  adjusted_score: number;
  verdict: string;
  summary: string;
  justification: string;
}

const SYSTEM = `You are AegisDial's verdict refiner. Given a rule-based trust score and raw evidence about a phone number, determine if the score should be adjusted up or down (maximum +/- 15 points) and produce a clear, concise one-line summary for a consumer about to receive a call.

Rules:
- Distinguish genuine scam reports from self-posted numbers (e.g., someone posting their own number to sell a couch).
- If evidence is thin or ambiguous, do NOT adjust.
- The summary must be <= 120 characters, factual, and actionable.
- Output valid JSON only.`;

export async function refineWithLLM(
  input: LLMRefineInput,
): Promise<LLMRefineOutput | null> {
  if (!config.ENABLE_LLM_REFINE || !config.ANTHROPIC_API_KEY) {
    return null;
  }

  const userPrompt = JSON.stringify({
    number: input.e164,
    signals: input.signals,
    base_score: input.base_score,
    base_verdict: input.base_verdict,
    evidence: input.evidence.slice(0, 10),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: [
          {
            type: 'text',
            text: SYSTEM,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: `Refine this verdict. Respond as strict JSON: {"adjusted_score": number 0-100, "verdict": one of trusted/unknown/suspicious/likely_spoof, "summary": string, "justification": string}\n\nInput:\n${userPrompt}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((c) => c.type === 'text')?.text;
    if (!text) return null;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as LLMRefineOutput;
    if (
      typeof parsed.adjusted_score !== 'number' ||
      typeof parsed.summary !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
