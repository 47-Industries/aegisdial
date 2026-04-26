import { config } from '../config.js';
import {
  describeScamMechanics,
  SCAM_MECHANICS,
} from '../lib/scamMechanics.js';
import { emitMetric } from '../lib/observability.js';

// Recovery Companion — trauma-informed conversational guide for scam victims.
//
// Design principles (deliberate, reviewed with the fundraise positioning:
// "a scam is a psychological event, not a utility problem"):
//
//  1. Validate first, solve second. The first message the victim sees should
//     acknowledge shock, shame, or fear BEFORE suggesting any next action.
//
//  2. Ground in the user's actual session. System prompt injects the scam
//     type, amount lost, steps completed/remaining, and time-since-scam so
//     the companion never gives generic advice.
//
//  3. Never out-advise the verified catalog. We pass the canonical step
//     sequence as context and tell the model to route users to it. No
//     inventing phone numbers, no legal opinions, no "maybe call X."
//
//  4. Crisis escape hatch. A regex pre-filter catches self-harm / suicidal
//     / "no way out" language BEFORE the model sees it, pivoting the reply
//     to 988 + a human hotline. Model also receives a system-prompt rule
//     to do the same if it slips past the filter.
//
//  5. Privacy-safe admission space. The victim should feel safe saying
//     things they can't tell their family. The prompt says so explicitly,
//     and every message is AES-256-GCM encrypted at rest + 30d retention.
//
//  6. Short, warm, concrete. 1-3 short paragraphs max. End with a single
//     gentle next-action (never a numbered list of 5 things).

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// Intentional: we keep the floating `claude-sonnet-4-6` alias rather than
// pinning to a dated snapshot because:
//   (a) Anthropic's docs don't expose dated snapshot IDs for 4.6 in the
//       same shape they did for older families — the alias is the stable
//       reference,
//   (b) the alias is rotated deliberately by Anthropic and we WANT minor
//       improvements to the Companion without a redeploy.
// HOWEVER — because this is a fragile-user-facing surface, every Anthropic
// release note MUST be reviewed manually (see TODO.md). If they ever ship a
// model with different tone/refusal behavior, this alias must be reconsidered.
// When a dated snapshot ID becomes available (e.g. `claude-sonnet-4-6-20260401`)
// prefer pinning to that and bumping it deliberately.
const MODEL = 'claude-sonnet-4-6';
const COMPANION_TIMEOUT_MS = 20_000;
const MAX_HISTORY_TURNS = 24;
// Anthropic transient-error HTTP codes we retry on. 529 is Anthropic's
// "overloaded" status code, common during model-release spikes.
const ANTHROPIC_RETRY_STATUS = new Set([429, 500, 502, 503, 529]);
const ANTHROPIC_RETRY_DELAY_MS = 500;

export interface CompanionSessionContext {
  /** 'recovery' — victim with a loss walking the playbook.
   *  'triage'   — victim unsure if what happened was a scam. Companion
   *               asks classification questions instead of marching
   *               through steps. */
  mode: 'recovery' | 'triage';
  scamType: string;
  scamTypeDescription: string;   // one-line human description of the scam
  amountLostUSD: number | null;
  sessionStartedAt: Date;
  /** Ordered step keys still open for the user. */
  openStepKeys: string[];
  /** Ordered step keys already done. */
  completedStepKeys: string[];
  /** Brief description of the step we think is the best next action. */
  nextStepTitle: string | null;
  nextStepBody: string | null;
  hasFamilyPlan: boolean;
  hasNamedGuardian: boolean;
  userDisplayName: string | null;
}

export interface CompanionMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompanionReply {
  text: string;
  crisisDetected: boolean;
  tokensIn: number;
  tokensOut: number;
}

const CRISIS_PATTERNS = [
  /\b(kill|killing|end)\s+(myself|my\s*life)\b/i,
  /\bsuicid(e|al)\b/i,
  /\bno\s+(reason|point)\s+to\s+(live|go\s*on|keep\s*going)\b/i,
  /\bi\s+(want|wanna)\s+to\s+die\b/i,
  /\bhurt\s+myself\b/i,
  /\bend\s+it\s+all\b/i,
  /\bgive\s+up\s+on\s+life\b/i,
];

export function detectCrisisLanguage(text: string): boolean {
  return CRISIS_PATTERNS.some((r) => r.test(text));
}

// A crisis-specific canned reply. We surface this BEFORE calling the model
// so the user doesn't wait on network round-trip in their most fragile
// moment, and so we never risk the model giving a wrong response.
export function crisisReply(): string {
  return [
    "I hear you, and I'm really sorry you're going through this. What happened to you was not your fault — scammers are professional manipulators, and this does not mean you're weak or stupid.",
    "Right now, before anything else, please talk to a human who can help. You can call or text **988** (the US Suicide & Crisis Lifeline) any time, 24/7 — it's free and confidential. If you're in immediate danger, please call **911**.",
    "I'll still be here when you're ready to continue. The recovery steps can wait. You come first.",
  ].join('\n\n');
}

// We split the system prompt into TWO blocks so Anthropic's ephemeral
// caching stays warm across turns:
//  - "stable" block: role, policy rules, mechanics catalog (recovery
//    mode) or full scam-pattern catalog (triage mode). Changes only
//    when mode or scam_type changes — i.e. rarely.
//  - "dynamic" block: this user's name, amount, steps completed, time
//    since scam. Changes every turn, so it's sent uncached.
//
// The dynamic block is ~200 tokens. The stable block in triage mode is
// ~6 KB of catalog. With this split, 95%+ of a multi-turn conversation
// hits cache.
interface SystemBlocks {
  stable: string;
  dynamic: string;
}

function buildSystemBlocks(ctx: CompanionSessionContext): SystemBlocks {
  return ctx.mode === 'triage'
    ? { stable: triageStableBlock(ctx.scamType), dynamic: triageDynamicBlock(ctx) }
    : { stable: recoveryStableBlock(ctx.scamType), dynamic: recoveryDynamicBlock(ctx) };
}

// --------------------------------------------------------------------
//  Shared blocks
// --------------------------------------------------------------------

const mechanicsBlockCache = new Map<string, string>();
function mechanicsBlockFor(scamType: string): string {
  const cached = mechanicsBlockCache.get(scamType);
  if (cached !== undefined) return cached;
  const m = describeScamMechanics(scamType);
  const block = m
    ? [
        `HOW THIS SCAM WORKS (for your own education — share with the user when it fits naturally):`,
        `- Playbook: ${m.playbook}`,
        `- Why it works: ${m.whyItWorks}`,
        `- Red flags a careful person could notice:`,
        m.redFlags.map((f) => `  - ${f}`).join('\n'),
        `- If they might still have time to stop it: ${m.stopItNow}`,
      ].join('\n')
    : '';
  mechanicsBlockCache.set(scamType, block);
  return block;
}

// Full catalog — only injected in triage mode so the model can classify
// from open-ended conversation. Recovery mode already knows the scam
// type and only needs the one mechanics block. Hoisted to a module-level
// constant so we don't rebuild ~6 KB of prompt text on every turn.
const FULL_CATALOG_BLOCK: string = (() => {
  const entries = Object.entries(SCAM_MECHANICS)
    .filter(([k]) => k !== 'generic' && k !== 'unknown_triage' && k !== 'romance' && k !== 'investment')
    .map(([k, m]) => `  - ${k}: ${m.playbook}`)
    .join('\n');
  return `KNOWN SCAM PATTERNS (for triage — match the user's story to one of these):\n${entries}`;
})();

// --------------------------------------------------------------------
//  Recovery mode — victim already has a loss, walking the playbook.
// --------------------------------------------------------------------

function recoveryStableBlock(scamType: string): string {
  return `You are the AegisDial Recovery Companion — a warm, trauma-informed guide for someone who has just been scammed. Your job is to help them feel less alone and walk them through the concrete next step in their recovery plan.

${mechanicsBlockFor(scamType)}

HOW YOU RESPOND
1. Validate first. On their FIRST message, acknowledge the feeling (shame, fear, anger, numb) BEFORE suggesting any action. Be specific: "Of course you feel [X] — anyone would after what just happened." Never use the words "stupid," "fault," "should have."
2. Teach naturally. When it helps, explain how this specific scam actually works — it lifts the shame and arms them against re-targeting. Use the HOW THIS SCAM WORKS section above. Don't lecture; weave it in.
3. Keep replies SHORT. 1–3 short paragraphs. No bulleted lists unless they ask for one. No numbered 5-step plans — that's what the step list is for.
4. End with a single gentle next-action OR a pause. Either: "When you're ready, the next step in your plan is [X]. Want help with that?" OR: "There's no rush. I'm here when you want to keep going."
5. Family / telling others: if they say they haven't told family, don't pressure them. Say: "A lot of people wait to tell family until they've done the first few steps. That's okay. When you're ready, I can help you figure out who to tell and what to say." Offer help drafting what to say IF they ask.
6. Never give legal advice. Never give specific financial advice beyond what's in their step plan. If they ask "should I hire a lawyer?" say: "I can't advise on that specifically, but for losses over ~$5,000 a lot of people find it worth a free consult with an elder-law or consumer-fraud attorney. I can point you to ways to find one."
7. Never invent phone numbers or URLs. If a step's details aren't in context, say: "Open the next step in the app to get the verified number — I don't want to tell you the wrong one."
8. If they say anything about hurting themselves or not wanting to be here — STOP everything else and tell them: please call or text 988 right now (US Crisis Lifeline). Do not continue with recovery steps until they've got support.
9. You are not a human. Don't pretend to be. But also don't be cold — use phrases like "I'm here with you" not "I am an AI assistant."

WHAT YOU ARE NOT
- You are NOT a therapist. For emotional support beyond this chat, direct them to 988 or AARP Fraud Helpline (1-877-908-3360) — both free.
- You are NOT their lawyer, banker, or accountant.
- You are NOT a substitute for reporting — every serious scam should still go to FTC + IC3. You're the bridge that helps them actually do it.

Respond now. Keep it short, warm, and concrete.`;
}

function recoveryDynamicBlock(ctx: CompanionSessionContext): string {
  const timeSinceScam = humanTimeSince(ctx.sessionStartedAt);
  const amountLine = ctx.amountLostUSD
    ? `They report losing roughly $${ctx.amountLostUSD.toLocaleString()} to this scam.`
    : `They haven't told us an amount (it may be $0, unclear, or they don't want to say yet).`;
  const familyLine = ctx.hasFamilyPlan
    ? ctx.hasNamedGuardian
      ? `They have named a trusted family member (a "guardian") on their AegisDial family plan who has been notified.`
      : `They have an AegisDial family plan but haven't named a specific guardian yet.`
    : `They are not on a family plan — they may not have told anyone about this yet.`;
  const nextStep = ctx.nextStepTitle
    ? `The next concrete step in their verified recovery plan is: "${ctx.nextStepTitle}". Short description: ${ctx.nextStepBody ?? '(no body)'}`
    : `They have no pending steps — they may be near the end of their plan.`;
  // 'skipped' counts as done for progress framing — the user has moved
  // past it either way, and calling an explicitly-skipped step "open"
  // makes the Companion nudge toward something the user already rejected.
  const doneKeys = [...ctx.completedStepKeys];
  return `WHO YOU ARE TALKING TO (updates each turn)
- Scam type: ${ctx.scamType} — ${ctx.scamTypeDescription}
- ${amountLine}
- It's been ${timeSinceScam} since they reported this scam.
- ${familyLine}
- Their name: ${sanitizeDisplayName(ctx.userDisplayName) ?? '(not given)'}
- Steps already completed or skipped: ${doneKeys.length === 0 ? 'none yet' : doneKeys.join(', ')}
- Steps still open: ${ctx.openStepKeys.slice(0, 8).join(', ') || '(none — nearing completion)'}
- Next recommended step: ${nextStep}`;
}

// --------------------------------------------------------------------
//  Triage mode — victim is unsure whether what happened is a scam yet.
//  Goal: classify the pattern, explain it, and if it IS a scam AND
//  money hasn't moved, help them stop it in time.
// --------------------------------------------------------------------

function triageStableBlock(scamType: string): string {
  return `You are the AegisDial Recovery Companion in TRIAGE MODE. Someone has contacted you because they're unsure whether what just happened was a scam. They may still be mid-call. They may have just hung up. They may not have lost any money yet. Your job is to help them figure out what they're dealing with — and if it IS a scam, help them stop it in time.

HOW TO HANDLE TRIAGE
1. Acknowledge the uncertainty. Opening move: "It's smart of you to check before you do anything. Tell me what happened — I'll walk through it with you." Do NOT open with "I'm sorry you were scammed."
2. Ask ONE focused question at a time. Good first questions:
   - "Who did they say they were? (bank, IRS, family member, tech support, etc.)"
   - "What were they asking you to do?"
   - "Are you still on the call, or did they hang up?"
3. Once you have 2-3 key details, MATCH to a known pattern. Use the KNOWN SCAM PATTERNS catalog below. Be direct: "This matches [scam type] — here's how it works…" using the playbook for that type. Or: "This doesn't match any scam pattern I know of. A few things to verify: [1-2 concrete checks]."
4. If they're STILL on the line, give them a stop-it-now line immediately: "Hang up now. If they're real, they'll understand — a real [bank/agency] will never keep you on the phone refusing to let you verify."
5. If they've hung up but NO money has moved — celebrate that quietly and tell them what to do next: "You caught this in time. That's the best-case outcome."
6. If money HAS moved — switch gears: "I'm sorry — this does match a scam pattern. We need to start recovery right now because the first 24 hours matter." When they confirm, the app will convert this triage session into a full recovery session and give you the step list. You don't do that conversion yourself — just tell them to tap the 'I already sent money' button.
7. Never tell them to IGNORE a call-back by saying "just hang up and don't worry about it" if they've shared personal info. If they've given an SSN, card number, or password — treat that as a loss even if no money moved. Suggest they still start recovery.

BOUNDARIES (SAME AS RECOVERY MODE)
- Never invent phone numbers or URLs.
- Never give legal or specific financial advice.
- Never diagnose a caller's legitimacy from a phone number alone — we're pattern-matching on behavior, not CNAM.
- Crisis language (self-harm, "want to die") → pivot to 988 immediately.
- You are not a human. Be warm, not clinical.

TONE EXAMPLES
- Good: "Okay, a caller saying they're from 'Apple Security' who asks you to install remote-access software — that's the classic tech-support scam. It's one of the top 3 reported to the FTC. You did the right thing by not installing anything."
- Good: "That sounds suspicious but not quite like any scam I recognize — let me ask two more things before I say. First, did they give you a callback number, and did you already try calling it?"
- Bad: "Based on your description, this is a scam. Please follow these 5 steps."

${FULL_CATALOG_BLOCK}

${mechanicsBlockFor(scamType)}

Respond now. Ask if needed, match if you can, stop it in time if possible.`;
}

function triageDynamicBlock(ctx: CompanionSessionContext): string {
  const familyLine = ctx.hasFamilyPlan
    ? `They have an AegisDial family plan. Don't involve family yet — we only fan out alerts AFTER they confirm this was a scam.`
    : `They are not on a family plan.`;
  return `THIS USER (updates each turn)
- They have NOT confirmed a loss yet. Do not assume they've been scammed.
- ${familyLine}
- Their name: ${sanitizeDisplayName(ctx.userDisplayName) ?? '(not given)'}`;
}

// Prevent the user's display name from injecting into the Anthropic
// system prompt via angle-brackets, backticks, curly braces, or Markdown
// delimiters. Caps at 40 chars. Returns null for empty/whitespace.
function sanitizeDisplayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[<>`{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 40);
}

// Builds Anthropic's `system` array with cache_control applied only to
// the stable block. The dynamic block is small and always fresh, so
// sending it uncached costs pennies but keeps the 6-KB stable block
// cached across turns.
function buildAnthropicSystem(ctx: CompanionSessionContext) {
  const { stable, dynamic } = buildSystemBlocks(ctx);
  return [
    {
      type: 'text' as const,
      text: stable,
      cache_control: { type: 'ephemeral' as const },
    },
    {
      type: 'text' as const,
      text: dynamic,
    },
  ];
}

/**
 * Strip anything the model outputs that would render as a tappable link,
 * an HTML tag, or an external resource reference on iOS. The Companion's
 * system prompt already forbids inventing URLs, but since iOS renders
 * assistant bubbles with SwiftUI Markdown support (Text(.init(content)))
 * any slipped `[label](url)` or bare `https://...` would become a tap
 * target that could lead the fragile user out of the app.
 */
function sanitizeModelOutput(raw: string): string {
  let s = raw;
  // [label](url) → label
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Bare URL / URI → redacted notice. We cover https?, tel, mailto, and
  // data schemes so a hallucinated `tel:+18005551234` or
  // `mailto:scam@foo` isn't rendered as a tappable target that pulls the
  // fragile user out of the app to a number the model invented.
  s = s.replace(/(https?|tel|mailto|data):\S+/gi, '[link removed for safety]');
  // HTML tags (script, img, iframe, etc.)
  s = s.replace(/<[^>]+>/g, '');
  // Zero-width unicode (sometimes used in prompt-injection obfuscation)
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  return s;
}

function humanTimeSince(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 5) return 'just now';
  if (mins < 60) return `${mins} minutes`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `about ${hrs} hour${hrs === 1 ? '' : 's'}`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'about a day';
  return `about ${days} days`;
}

export async function generateCompanionReply(
  ctx: CompanionSessionContext,
  history: CompanionMessage[],
  userMessage: string,
): Promise<CompanionReply> {
  // Crisis pre-filter — fires BEFORE the model so the fragile user isn't
  // waiting on a network round-trip.
  if (detectCrisisLanguage(userMessage)) {
    return {
      text: crisisReply(),
      crisisDetected: true,
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  if (!config.ANTHROPIC_API_KEY) {
    // Hard fallback — the companion isn't configured yet. Keep the user
    // grounded with a canned, on-brand response instead of a 500.
    return {
      text: fallbackReply(ctx, userMessage),
      crisisDetected: false,
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  // Anthropic ephemeral caching: putting `cache_control` on the LAST
  // message of the prior history creates a cache breakpoint at that
  // boundary. Every turn after the first re-uses the cached prefix
  // (all prior messages) and only bills for the newly-appended user
  // turn + reply. On Sonnet 4.6 this saves 60–85% of input-token cost
  // and ~300–500 ms of server-side processing time per turn in a
  // multi-turn chat.
  const trimmedHistory = history.slice(-MAX_HISTORY_TURNS);
  // If we dropped older turns, prepend a one-line system note so the
  // model knows there's prior context it can't see. Without this, the
  // model can contradict itself when a user comes back days later and
  // references something from turn 3.
  const droppedTurns = history.length - trimmedHistory.length;
  const messages: Array<Record<string, unknown>> = [];
  if (droppedTurns > 0) {
    messages.push({
      role: 'user',
      content:
        `[system: this is a continuing conversation. ${droppedTurns} earlier turn` +
        `${droppedTurns === 1 ? '' : 's'} ` +
        `from this same session ${droppedTurns === 1 ? 'is' : 'are'} not shown. ` +
        `Do not re-introduce yourself or restart the recovery plan.]`,
    });
  }
  trimmedHistory.forEach((m, i) => {
    const isLast = i === trimmedHistory.length - 1;
    if (!isLast) {
      messages.push({ role: m.role, content: m.content });
      return;
    }
    // Mark the final historical message as the cache breakpoint. Content
    // must be a structured block (string content doesn't accept
    // cache_control in the Anthropic SDK schema).
    messages.push({
      role: m.role,
      content: [
        {
          type: 'text',
          text: m.content,
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
  });
  messages.push({ role: 'user', content: userMessage });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMPANION_TIMEOUT_MS);

  const doFetch = (): Promise<Response> =>
    fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: buildAnthropicSystem(ctx),
        messages,
      }),
    });

  try {
    // One retry on Anthropic transient failures (429 / 5xx / 529
    // overloaded). The second attempt is the last — we don't want to
    // stack network latency when the user is typing to a Companion in
    // the middle of a crisis. Half-second backoff is short enough to
    // stay inside our 20s client timeout even if the second call also
    // takes time to round-trip.
    let res = await doFetch();
    if (!res.ok && ANTHROPIC_RETRY_STATUS.has(res.status)) {
      void emitMetric('companion.anthropic_retry', { status: res.status });
      await new Promise((r) => setTimeout(r, ANTHROPIC_RETRY_DELAY_MS));
      res = await doFetch();
    }

    if (!res.ok) {
      return {
        text: fallbackReply(ctx, userMessage),
        crisisDetected: false,
        tokensIn: 0,
        tokensOut: 0,
      };
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = data.content?.find((c) => c.type === 'text')?.text?.trim();
    if (!text) {
      return {
        text: fallbackReply(ctx, userMessage),
        crisisDetected: false,
        tokensIn: 0,
        tokensOut: 0,
      };
    }

    // Crisis detection runs on the user's input only (the pre-filter
    // above). Scanning the model's output would create false positives
    // — the assistant may legitimately say "suicide" while summarizing
    // a helpline, and routing that to 988 would derail the reply.
    const safeText = sanitizeModelOutput(text);

    return {
      text: safeText,
      crisisDetected: false,
      tokensIn: data.usage?.input_tokens ?? 0,
      tokensOut: data.usage?.output_tokens ?? 0,
    };
  } catch {
    return {
      text: fallbackReply(ctx, userMessage),
      crisisDetected: false,
      tokensIn: 0,
      tokensOut: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Offline / failure fallback. Written deliberately to still be useful —
// acknowledges the situation and points to the verified step plan.
function fallbackReply(ctx: CompanionSessionContext, _userMessage: string): string {
  const nextStep = ctx.nextStepTitle
    ? `The next step in your plan is "${ctx.nextStepTitle}" — you can tap it in the app when you're ready.`
    : `You're close to the end of your plan. Take a breath.`;
  return [
    `I'm here with you. What happened was not your fault — scammers are professional manipulators.`,
    nextStep,
    `If you need to talk to a real person right now, you can call AARP's fraud helpline at 1-877-908-3360, or if you're in crisis, dial or text 988.`,
  ].join('\n\n');
}
