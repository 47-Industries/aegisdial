// Natural-language → SQL service, powered by Claude Haiku 4.5.
//
// The dashboard's /internal/ask endpoint takes a question like
//   "How many people cancelled this week?"
// and routes it through this service to produce a single read-only
// SELECT that gets executed and rendered.
//
// Claude's role is constrained: given the schema (see
// dashboardSchema.ts) and a strict set of rules, output ONE SQL
// statement and nothing else. Everything that comes back is then
// re-validated by sqlSafe.validateReadOnlyQuery() — Claude's prompt
// adherence is not part of our security model, just a UX layer.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { SCHEMA_DOCS } from './dashboardSchema.js';

const MODEL = 'claude-haiku-4-5-20251001';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (client) return client;
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return client;
}

const SYSTEM_PROMPT = `You translate the founder's natural-language questions into a single PostgreSQL SELECT query against AegisDial's internal analytics database.

OUTPUT RULES — these are not negotiable:
  1. Output ONLY a single SQL query. No explanation, no markdown fences, no prose.
  2. The query MUST start with SELECT or WITH. No INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, EXECUTE, COPY, SET, BEGIN, or any other non-SELECT.
  3. The query MUST NOT reference, select, filter on, or join via any of these PII columns even if the schema seems to have them: email, phone, phone_number, first_name, last_name, full_name, display_name, address, ssn, dob, password, password_hash, encrypted_payload, raw_payload, display_value, scam_e164, e164, apple_user_id, auth_token, jwt.
  4. The query MUST only reference tables and views in the schema below. Do not invent table or column names.
  5. The query MUST NOT contain SQL comments (-- or /* */).
  6. The query MUST NOT contain multiple statements (no semicolons except optionally one trailing).
  7. If the question asks for a list of rows (not a single aggregate), include LIMIT 100 or smaller.
  8. Prefer the precomputed mv_kpi_* materialized views when the question maps to one of them.
  9. If the question would require any of the above rules to be broken, output exactly: SELECT 'unanswerable' AS reason

SCHEMA:
${SCHEMA_DOCS}

Remember: output exactly one SQL query, nothing else.`;

export interface NlSqlResult {
  sql: string;
  modelTokens: { input: number; output: number };
}

/**
 * Translate a natural-language question into a single SELECT query.
 * The returned SQL has not been validated yet — pass it through
 * sqlSafe.validateReadOnlyQuery() before executing.
 */
export async function questionToSql(question: string): Promise<NlSqlResult> {
  const trimmed = question.trim();
  if (trimmed.length === 0) {
    throw new Error('empty_question');
  }
  if (trimmed.length > 800) {
    throw new Error('question_too_long');
  }

  const c = getClient();
  const response = await c.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: [
      // Caching the long system prompt — schema docs are stable and
      // re-used on every dashboard "ask" call. Saves tokens at scale
      // and reduces latency on the second+ hit.
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      { role: 'user', content: trimmed },
    ],
  });

  // Claude returns content as an array of blocks. Concatenate the text
  // blocks (typically there's just one) and strip surrounding code
  // fences if Claude added any despite the rule.
  let sql = '';
  for (const block of response.content) {
    if (block.type === 'text') sql += block.text;
  }
  sql = stripCodeFence(sql).trim();

  const usage = response.usage;
  return {
    sql,
    modelTokens: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
    },
  };
}

function stripCodeFence(s: string): string {
  // Claude is told not to do this, but if it slips: ```sql\n...\n```
  // or ```\n...\n```, peel one layer.
  const fenceMatch = s.match(/^\s*```(?:sql)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenceMatch) return fenceMatch[1]!;
  return s;
}
