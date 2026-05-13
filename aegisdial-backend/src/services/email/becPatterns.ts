// Email Shield — BEC (Business Email Compromise) pattern library.
//
// One source of truth for the deterministic-side scoring rules.
// Mirrors the shape of `src/lib/scamPhrases.ts` (SMS Shield) so an
// operator who already understands one library can read this one.
//
// Categories are calibrated against the FBI/IC3 BEC playbook
// taxonomy and the open-source phish-corpus surveys (UC Berkeley,
// Proofpoint). Each phrase carries a category and a per-match
// score contribution; the scorer caps category contributions to
// prevent a single keyword-stuffing email from saturating the
// fraud_score on a thin signal.
//
// Two distinct match planes:
//   1. body_match — patterns that fire on body_text (after
//      whitespace normalization).
//   2. subject_match — patterns that fire on the subject line.
//   The same phrase can appear in both planes; subject hits get a
//   smaller per-match contribution because legitimate alerts use
//   urgency in subjects ("Your statement is ready") and we don't
//   want to false-positive on every transactional email.
//
// FUTURE: when V4_EMAIL_LLM_ENABLED ships, an LLM augmenter can
// score against the SAME category vocabulary so the operator-
// facing dashboards stay coherent across rule-based and LLM
// branches. Today the deterministic path is the trust-first
// default — same posture as SMS Shield.

export type BecCategory =
  | 'wire_request'              // ask the victim to send money via wire transfer
  | 'invoice_redirect'          // change of wire/ACH instructions on a known invoice
  | 'payroll_change'            // ask HR/payroll to redirect a salary deposit
  | 'gift_card_purchase'        // CEO-style "buy iTunes / Amazon cards" ask
  | 'urgency_pressure'          // "now / today / urgent / asap / immediately"
  | 'secrecy_pressure'          // "don't tell anyone / don't loop in / between us"
  | 'authority_impersonation'   // "this is the CEO / CFO / your boss"
  | 'credential_phish'          // "verify your account / reset your password / locked"
  | 'fake_shipping'             // "your package is held / pay tax to release"
  | 'fake_invoice_attachment'   // "see attached invoice / review attached"
  | 'crypto_request'            // "send BTC / USDT to wallet"
  | 'attorney_pretext'          // "my attorney will contact you"
  | 'mobile_only_contact';      // "text me at this number / don't reply by email"

interface BecPattern {
  category: BecCategory;
  /** Regex matched case-insensitively against the haystack. */
  regex: RegExp;
}

/**
 * Patterns to match against the message body. The regex source is
 * intentionally tolerant — punctuation, multiple spaces, and
 * occasional typos shouldn't drop the match.
 */
const BODY_PATTERNS: BecPattern[] = [
  // Wire request — the single highest-leverage BEC signal.
  { category: 'wire_request', regex: /\bwire\s+(?:transfer|funds|payment|amount|the)\b/i },
  { category: 'wire_request', regex: /\bsend\s+(?:a\s+)?wire\b/i },
  { category: 'wire_request', regex: /\bsame[-\s]day\s+wire\b/i },
  { category: 'wire_request', regex: /\bsame[-\s]day\s+payment\b/i },
  { category: 'wire_request', regex: /\bwire\s+(?:instructions|details)\b/i },
  { category: 'wire_request', regex: /\b(?:swift|iban|routing)\s+(?:code|number)\b/i },
  { category: 'wire_request', regex: /\bbeneficiary\s+(?:bank|account)\b/i },

  // Invoice redirect — change of payee details on an existing invoice.
  { category: 'invoice_redirect', regex: /\bnew\s+(?:bank|wire|ach)\s+(?:account|details|instructions)\b/i },
  { category: 'invoice_redirect', regex: /\bplease\s+update\s+(?:our|the)\s+(?:bank|wire|payment)\b/i },
  { category: 'invoice_redirect', regex: /\bchanged?\s+(?:our|my)\s+(?:bank|account|wire)\b/i },
  { category: 'invoice_redirect', regex: /\bremit\s+to\s+(?:the\s+new|this\s+new)\s+(?:account|address)\b/i },

  // Payroll change — HR-targeted variant.
  { category: 'payroll_change', regex: /\bchange\s+(?:my\s+)?direct\s+deposit\b/i },
  { category: 'payroll_change', regex: /\bupdate\s+(?:my\s+)?(?:payroll|salary)\s+(?:account|deposit|details)\b/i },
  { category: 'payroll_change', regex: /\bredirect\s+(?:my\s+)?paycheck\b/i },

  // Gift card purchase — the classic CEO impersonation ask.
  { category: 'gift_card_purchase', regex: /\b(?:itunes|amazon|google\s*play|steam|target|walmart)\s+gift\s+cards?\b/i },
  { category: 'gift_card_purchase', regex: /\bbuy\s+(?:some\s+)?gift\s+cards?\b/i },
  { category: 'gift_card_purchase', regex: /\bgift\s+cards?\s+(?:for|to)\s+(?:client|customer|employee)\b/i },
  { category: 'gift_card_purchase', regex: /\bscratch\s+(?:off\s+)?the\s+back\b/i },

  // Urgency / pressure — the connective tissue of every BEC.
  { category: 'urgency_pressure', regex: /\b(?:urgent|asap|immediately|right\s+now|today\s+only)\b/i },
  { category: 'urgency_pressure', regex: /\bcannot\s+wait\b/i },
  { category: 'urgency_pressure', regex: /\bbefore\s+(?:end\s+of|cob|noon)\b/i },
  { category: 'urgency_pressure', regex: /\bwithin\s+the\s+next\s+(?:hour|30\s+minutes|15\s+minutes)\b/i },
  { category: 'urgency_pressure', regex: /\btime[-\s]sensitive\b/i },

  // Secrecy pressure — second-strongest BEC signal after wire request.
  { category: 'secrecy_pressure', regex: /\b(?:don'?t|do\s+not)\s+(?:tell|inform|cc|loop|copy)\b/i },
  { category: 'secrecy_pressure', regex: /\bkeep\s+(?:this|it)\s+(?:between\s+us|confidential|quiet)\b/i },
  { category: 'secrecy_pressure', regex: /\bin\s+a\s+meeting\b.*\bno\s+phone\b/i },
  { category: 'secrecy_pressure', regex: /\bcan'?t\s+talk\s+(?:by\s+)?(?:phone|right\s+now)\b/i },

  // Authority impersonation — claiming to be the boss.
  { category: 'authority_impersonation', regex: /\bi\s+am\s+(?:the\s+)?(?:ceo|cfo|coo|president|founder)\b/i },
  { category: 'authority_impersonation', regex: /\bon\s+behalf\s+of\s+(?:the\s+)?(?:ceo|cfo)\b/i },
  { category: 'authority_impersonation', regex: /\bsent\s+from\s+my\s+(?:iphone|mobile|cell)\b.*\bplease\s+(?:excuse|forgive)\b/i },

  // Credential phish — covered partly by URL scanning, but the
  // body language is its own signal.
  { category: 'credential_phish', regex: /\b(?:verify|confirm)\s+your\s+(?:account|identity|email|password)\b/i },
  { category: 'credential_phish', regex: /\baccount\s+(?:has\s+been\s+)?(?:suspended|locked|disabled|compromised)\b/i },
  { category: 'credential_phish', regex: /\bunusual\s+(?:sign[-\s]?in|activity|login)\b/i },
  { category: 'credential_phish', regex: /\b(?:click|tap)\s+(?:here|the\s+link)\s+(?:to\s+)?(?:verify|confirm|reset)\b/i },

  // Fake shipping — UPS/FedEx/USPS-style tax-on-package scams.
  { category: 'fake_shipping', regex: /\bpackage\s+(?:is\s+)?(?:held|on\s+hold|undeliverable)\b/i },
  { category: 'fake_shipping', regex: /\bpay\s+(?:the\s+)?(?:customs|import|delivery)\s+(?:fee|tax)\b/i },
  { category: 'fake_shipping', regex: /\b(?:redeliver|reschedule)\s+your\s+package\b/i },

  // Fake invoice attachment — "see attached" with no real context.
  { category: 'fake_invoice_attachment', regex: /\bsee\s+attached\s+invoice\b/i },
  { category: 'fake_invoice_attachment', regex: /\breview\s+the\s+attached\s+(?:invoice|statement|document)\b/i },
  { category: 'fake_invoice_attachment', regex: /\bpaid\s+invoice\s+attached\b/i },

  // Crypto request.
  { category: 'crypto_request', regex: /\b(?:bitcoin|btc|ethereum|eth|usdt|tether|wallet)\b.*\b(?:address|send\s+to)\b/i },
  { category: 'crypto_request', regex: /\bsend\s+(?:btc|eth|crypto|coins)\b/i },

  // Attorney pretext — "my attorney will reach out to discuss settlement".
  { category: 'attorney_pretext', regex: /\bmy\s+(?:lawyer|attorney|legal\s+counsel)\s+will\s+(?:contact|reach)\b/i },

  // Mobile-only contact — diverts the conversation to SMS where
  // the user can't see headers / domain.
  { category: 'mobile_only_contact', regex: /\btext\s+me\s+(?:at|on)\s+\+?\d[\d\s().-]{7,}\b/i },
  { category: 'mobile_only_contact', regex: /\b(?:please|kindly)\s+(?:reply|respond)\s+(?:via|by)\s+(?:text|sms|whatsapp|signal)\b/i },
];

/**
 * Patterns to match against the subject line. Subject hits carry
 * less weight than body hits — legitimate transactional emails
 * routinely use urgency words in subjects.
 */
const SUBJECT_PATTERNS: BecPattern[] = [
  { category: 'urgency_pressure', regex: /\b(?:urgent|asap|now|today)\b/i },
  { category: 'wire_request', regex: /\bwire\s+(?:transfer|payment|request)\b/i },
  { category: 'credential_phish', regex: /\b(?:account|password)\s+(?:locked|suspended|verification)\b/i },
  { category: 'fake_shipping', regex: /\b(?:package|delivery)\s+(?:on\s+hold|attention)\b/i },
  { category: 'fake_invoice_attachment', regex: /\binvoice\s+(?:attached|enclosed|due)\b/i },
];

export interface BecMatch {
  category: BecCategory;
  /** Where the match fired: 'body' or 'subject'. */
  plane: 'body' | 'subject';
  /**
   * The matched text fragment (lowercased, normalized). Useful for
   * operator dashboards; the user-facing rationale uses the
   * category description, NOT this fragment, because the fragment
   * may quote real digits / names from the email body.
   */
  matched_text: string;
}

/**
 * Normalize whitespace + lowercase so patterns can ignore
 * multi-space, tab-laden, or HTML-extracted text variations.
 * Preserves punctuation — patterns rely on it.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Match a haystack against a pattern set, returning at most one
 * match per (category, regex) so a single repeated phrase doesn't
 * inflate the score linearly.
 */
function matchPatterns(
  haystack: string,
  patterns: BecPattern[],
  plane: 'body' | 'subject',
): BecMatch[] {
  const matches: BecMatch[] = [];
  const seenRegex = new Set<RegExp>();
  const normalized = normalize(haystack);
  for (const p of patterns) {
    if (seenRegex.has(p.regex)) continue;
    const m = normalized.match(p.regex);
    if (m) {
      seenRegex.add(p.regex);
      matches.push({
        category: p.category,
        plane,
        matched_text: m[0]!.toLowerCase().slice(0, 80),
      });
    }
  }
  return matches;
}

/**
 * Run the full BEC pattern library against an email's subject
 * and body. Returns the deduped match list — at most one per
 * (category, regex) per plane.
 *
 * Pure function — no I/O, no state. Tests drive it directly with
 * synthesized text. The scorer (emailScorer.ts) consumes the
 * result + composes against URL findings, auth verdicts, and
 * sender lookalike signals.
 */
export function detectBecPatterns(input: {
  subject: string;
  body_text: string;
  body_html: string;
}): BecMatch[] {
  // Use plain-text body when available. HTML body is parsed for
  // URLs by the scorer (via urlScan.ts) but for phrase matching we
  // prefer the plain-text view — HTML tags would clutter the
  // regex matches.
  const bodyHaystack = input.body_text || stripHtml(input.body_html);
  return [
    ...matchPatterns(input.subject, SUBJECT_PATTERNS, 'subject'),
    ...matchPatterns(bodyHaystack, BODY_PATTERNS, 'body'),
  ];
}

/**
 * Strip HTML tags from a string. The scorer's URL extraction
 * runs on raw HTML separately (via urlScan.extractUrls). This
 * helper only feeds the BEC phrase matcher when there's no
 * plain-text body — newer marketing-style emails are HTML-only.
 *
 * NOT a security boundary — this is for pattern matching, not
 * rendering. Doesn't decode entities (the regex tolerates
 * &nbsp; / &amp; via the \s+ normalizer).
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * Per-category score contributions. Body-plane hits weigh more
 * than subject-plane hits. A category that matched in both
 * planes only contributes once (the higher value).
 */
const CATEGORY_SCORE: Record<BecCategory, { body: number; subject: number }> = {
  wire_request:           { body: 25, subject: 10 },
  invoice_redirect:       { body: 30, subject: 12 },
  payroll_change:         { body: 25, subject: 10 },
  gift_card_purchase:     { body: 30, subject: 12 },
  urgency_pressure:       { body: 10, subject: 4 }, // weak alone; combinator with another category
  secrecy_pressure:       { body: 20, subject: 8 },
  authority_impersonation:{ body: 15, subject: 6 },
  credential_phish:       { body: 20, subject: 8 },
  fake_shipping:          { body: 20, subject: 10 },
  fake_invoice_attachment:{ body: 15, subject: 8 },
  crypto_request:         { body: 25, subject: 10 },
  attorney_pretext:       { body: 15, subject: 5 },
  mobile_only_contact:    { body: 20, subject: 6 },
};

/**
 * Compose a pattern-score from the matches. The total contribution
 * per category is the MAX of its planes (body wins over subject if
 * both fired) — no double-counting. The result is uncapped here;
 * the final scorer composes against URL / attachment / auth /
 * lookalike signals and caps at 100.
 */
export function scoreBecMatches(matches: BecMatch[]): {
  pattern_score: number;
  triggered_categories: BecCategory[];
} {
  const perCategory = new Map<BecCategory, number>();
  for (const m of matches) {
    const tier = CATEGORY_SCORE[m.category];
    const contribution = tier[m.plane];
    const prior = perCategory.get(m.category) ?? 0;
    if (contribution > prior) perCategory.set(m.category, contribution);
  }
  let pattern_score = 0;
  for (const v of perCategory.values()) pattern_score += v;
  return {
    pattern_score: Math.min(100, pattern_score),
    triggered_categories: [...perCategory.keys()].sort(),
  };
}

/**
 * Human-readable rationale string for a category. Used to populate
 * the user-facing `explainable_reasons` array on the verdict
 * response. Returns a generic phrase, NOT the matched_text, so we
 * don't echo back potentially-PII fragments.
 */
export function describeBecCategory(category: BecCategory): string {
  switch (category) {
    case 'wire_request': return 'Asks the recipient to send a wire transfer.';
    case 'invoice_redirect': return 'Requests a change to existing wire / ACH instructions.';
    case 'payroll_change': return 'Asks to redirect a salary deposit.';
    case 'gift_card_purchase': return 'Asks the recipient to purchase gift cards (a common CEO-impersonation scam).';
    case 'urgency_pressure': return 'Pressures the recipient with a tight or impossible deadline.';
    case 'secrecy_pressure': return 'Tells the recipient not to discuss the request with anyone else.';
    case 'authority_impersonation': return 'Claims to be a senior executive or authority figure.';
    case 'credential_phish': return 'Asks the recipient to verify or reset account credentials.';
    case 'fake_shipping': return 'Claims a package is held and asks for a fee — a classic shipping scam.';
    case 'fake_invoice_attachment': return 'References an attached invoice or document the recipient did not expect.';
    case 'crypto_request': return 'Asks the recipient to send cryptocurrency.';
    case 'attorney_pretext': return 'References an unnamed attorney or legal contact (a pretext common in scam escalation).';
    case 'mobile_only_contact': return 'Diverts the conversation to text / WhatsApp where headers are not visible.';
  }
}
