// Scam-phrase catalog. These are the kill-phrases social engineers lean
// on — tuned from FTC Sentinel, AARP reports, and aggregated Reddit
// scam-bait threads. Categories matter as much as individual hits
// because the devastating scams always co-occur multiple categories
// (impersonation + payment + isolation + time pressure).
//
// Patterns are matched case-insensitively against the running transcript.
// Each pattern has a severity (1–5) and a weight (0–1). The detector
// emits hits; the scorer combines hits into a risk level.
//
// Keep additions in the same shape. Prefer phrases, not single words,
// to reduce false positives — "gift" alone is nothing, "gift card"
// in a support call is everything.

export type ScamCategory =
  | 'payment_fraud'
  | 'remote_access'
  | 'impersonation_authority'
  | 'impersonation_financial'
  | 'isolation'
  | 'time_pressure'
  | 'sensitive_data'
  | 'emergency_relative'
  | 'crypto_investment'
  | 'smishing_bait';

export interface PhrasePattern {
  id: string;
  category: ScamCategory;
  /** regex source strings; will be compiled with /i flag */
  patterns: string[];
  severity: 1 | 2 | 3 | 4 | 5;
  weight: number;
  /** short plain-language label for the UI ("Asked about gift cards") */
  label: string;
}

export const SCAM_PATTERNS: PhrasePattern[] = [
  // ---- payment_fraud ----
  {
    id: 'gift_cards',
    category: 'payment_fraud',
    patterns: [
      '\\bgift\\s*cards?\\b',
      '\\b(apple|itunes|google\\s*play|amazon|target|walmart|ebay|steam)\\s+(gift|e-?gift)\\s*cards?\\b',
      '\\bprepaid\\s+cards?\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: 'Asked to pay with gift cards',
  },
  {
    id: 'wire_transfer',
    category: 'payment_fraud',
    patterns: [
      '\\bwire\\s+(transfer|money|payment|funds?)\\b',
      '\\bsend\\s+(a\\s+)?wire\\b',
      '\\b(western\\s+union|moneygram|ria)\\b',
    ],
    severity: 5,
    weight: 0.95,
    label: 'Asked to wire money',
  },
  {
    id: 'safe_account',
    category: 'payment_fraud',
    patterns: [
      '\\b(move|transfer|send)\\s+(your|the)?\\s*(money|funds|savings|balance)\\s+to\\s+(a\\s+)?safe\\s+account\\b',
      '\\bsafe\\s+account\\b',
      '\\b(holding|protected|federal|treasury)\\s+account\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: '"Move money to a safe account" — classic bank impersonation',
  },
  {
    id: 'p2p_payment',
    category: 'payment_fraud',
    patterns: [
      '\\b(zelle|venmo|cash\\s*app|paypal)\\b.*\\b(send|transfer|pay)\\b',
      '\\b(send|transfer|pay).*\\b(zelle|venmo|cash\\s*app|paypal)\\b',
    ],
    severity: 4,
    weight: 0.8,
    label: 'Asked to pay via Zelle/Venmo/Cash App',
  },
  {
    id: 'bail_money',
    category: 'payment_fraud',
    patterns: [
      '\\bbail\\s+money\\b',
      '\\b(send|wire|bring)\\s+(me\\s+)?(the\\s+)?(bail|bond)\\s+(money|funds|cash)\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: 'Bail-money payment ask',
  },
  {
    id: 'send_cash_urgent',
    category: 'payment_fraud',
    patterns: [
      '\\b(send|mail|bring)\\s+(me\\s+)?(the\\s+)?cash\\b',
      '\\b(need|send)\\s+\\$?\\d+\\s+(dollars?|in\\s+cash)\\b',
    ],
    severity: 4,
    weight: 0.85,
    label: 'Cash payment ask',
  },
  {
    id: 'crypto_payment',
    category: 'crypto_investment',
    patterns: [
      '\\bbitcoin\\s+atm\\b',
      '\\b(btc|bitcoin|crypto|ethereum|usdt|tether)\\s+(wallet|address|transfer|payment|deposit)\\b',
      '\\b(coinbase|binance)\\s+(wallet|address)\\b',
      '\\bsend\\s+(us\\s+)?(bitcoin|crypto|btc|ethereum)\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: 'Asked to send cryptocurrency',
  },

  // ---- remote_access ----
  {
    id: 'remote_access_tools',
    category: 'remote_access',
    patterns: [
      '\\b(anydesk|team\\s*viewer|teamviewer|logmein|screen\\s*connect|screenconnect|supremo|splashtop)\\b',
      '\\bremote\\s+(access|control|session|connection|assistance|support)\\b',
      '\\b(install|download|open)\\s+(the\\s+)?(app|software|program).*\\b(access|fix|repair|clean)\\b',
      '\\blet\\s+me\\s+(in|connect|access)\\s+your\\s+(computer|phone|device)\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: 'Asked for remote access to your device',
  },
  {
    id: 'screen_share',
    category: 'remote_access',
    patterns: [
      '\\bshare\\s+your\\s+screen\\b',
      '\\b(start|enable|turn\\s+on)\\s+screen\\s+(sharing|share)\\b',
    ],
    severity: 4,
    weight: 0.85,
    label: 'Asked you to share your screen',
  },

  // ---- impersonation_authority ----
  {
    id: 'irs_warrant',
    category: 'impersonation_authority',
    patterns: [
      '\\b(irs|internal\\s+revenue\\s+service)\\b.*\\b(warrant|arrest|lawsuit|court|owe|back\\s+taxes)\\b',
      '\\b(arrest|bench)\\s+warrant\\b.*\\b(taxes?|irs)\\b',
      '\\btax\\s+(fraud|evasion|crime)\\s+(charge|case|investigation)\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: 'IRS / tax warrant threat',
  },
  // Live Shield v2 hero-scam coverage — IRS impersonation. The scripted
  // phrases below are pulled from FTC complaint corpora and AARP's 2025
  // scam-call dataset. Each is a near-certain scam signal on its own;
  // they trip even before authority+payment co-occurrence kicks in.
  {
    id: 'irs_final_notice',
    category: 'impersonation_authority',
    patterns: [
      '\\bfinal\\s+notice\\b.*\\b(irs|internal\\s+revenue|tax)\\b',
      '\\b(irs|internal\\s+revenue)\\b.*\\bfinal\\s+notice\\b',
      '\\bthis\\s+is\\s+(your|a)\\s+final\\s+(notice|warning|attempt)\\b.*\\btax\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: '"Final notice from the IRS" — universal opener',
  },
  {
    id: 'irs_ssn_suspended',
    category: 'impersonation_authority',
    patterns: [
      '\\b(your|the)\\s+(social\\s+security|ssn)\\s+(number\\s+)?(has\\s+been\\s+|is\\s+being\\s+|will\\s+be\\s+)?(suspend|cancel|block|frozen|deactivat)',
      '\\bssn\\s+(suspended|cancelled|blocked)\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: '"Your SSN is suspended" — IRS/SSA impersonation hook',
  },
  {
    id: 'irs_press_one',
    category: 'impersonation_authority',
    patterns: [
      '\\bpress\\s+(1|one)\\b.*\\b(speak|connect|agent|officer|representative|case)\\b',
      '\\b(speak|connect)\\s+(to|with)\\s+(an?\\s+)?(officer|agent|representative)\\b.*\\b(irs|tax|investigation|case)\\b',
    ],
    severity: 4,
    weight: 0.9,
    label: '"Press 1 to speak to an agent" — IRS robocall pattern',
  },
  {
    id: 'irs_outstanding_balance',
    category: 'impersonation_authority',
    patterns: [
      '\\boutstanding\\s+(tax\\s+)?(balance|debt|amount|payment|liabilit)\\b',
      '\\b(unpaid|delinquent)\\s+(tax|federal\\s+tax|tax\\s+balance)\\b',
      '\\byou\\s+(owe|have\\s+(an?\\s+)?(unpaid|outstanding))\\b.*\\b(irs|tax|federal)\\b',
    ],
    severity: 4,
    weight: 0.9,
    label: '"You have an outstanding tax balance" — payment pretext',
  },
  {
    id: 'irs_criminal_division',
    category: 'impersonation_authority',
    patterns: [
      '\\b(irs\\s+)?(criminal|enforcement|legal)\\s+(division|department|investigation)\\b',
      '\\btax\\s+(crime|fraud)\\s+(unit|division)\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: '"IRS criminal division" — false escalation tactic',
  },
  {
    id: 'irs_account_freeze',
    category: 'impersonation_authority',
    patterns: [
      '\\b(your|the)\\s+(bank|checking|savings)\\s+account\\s+(will\\s+be\\s+)?(frozen|seized|blocked|garnish)',
      '\\bgarnish(ed|ment)\\s+(your\\s+)?(wages|paycheck|account)\\b',
    ],
    severity: 4,
    weight: 0.9,
    label: '"We will freeze your bank account" — coercion pattern',
  },
  {
    id: 'law_enforcement_threat',
    category: 'impersonation_authority',
    patterns: [
      '\\b(fbi|police|sheriff|dea|u\\.?s\\.?\\s*marshal|i\\.?c\\.?e\\.?\\s+(agent|officer|enforcement))\\b.*\\b(warrant|arrest|custody|charged?)\\b',
      '\\b(federal|local)\\s+(warrant|subpoena)\\b',
      '\\bfederal\\s+(case|investigation|charge|crime)\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: 'Law enforcement / arrest threat',
  },
  {
    id: 'ssa_suspension',
    category: 'impersonation_authority',
    patterns: [
      '\\b(social\\s+security|ssa|ssn)\\b.*\\b(suspend|suspended|block|blocked|compromised|frozen)\\b',
      '\\byour\\s+(social\\s+security|ssn)\\s+(number\\s+)?(has\\s+been\\s+)?(suspended|compromised|flagged|used)\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: 'Social Security suspension claim',
  },
  {
    id: 'deportation_threat',
    category: 'impersonation_authority',
    patterns: [
      '\\b(deport|deported|deportation)\\b',
      '\\b(immigration|ice)\\s+(status|case|violation)\\b',
    ],
    severity: 5,
    weight: 0.95,
    label: 'Deportation threat',
  },

  // ---- impersonation_financial ----
  {
    id: 'bank_fraud_department',
    category: 'impersonation_financial',
    patterns: [
      '\\b(fraud|security)\\s+(department|team|alert|investigator)\\b',
      '\\bsuspicious\\s+(activity|charges?|transactions?|login)\\s+on\\s+your\\s+account\\b',
      '\\byour\\s+(account|card)\\s+(has\\s+been\\s+)?(compromised|hacked|breached)\\b',
      '\\bunauthorized\\s+(charge|transaction|transfer|access)\\b.*\\b(account|card)\\b',
    ],
    severity: 4,
    weight: 0.85,
    label: '"Your bank\'s fraud department" framing',
  },
  {
    id: 'card_reissue',
    category: 'impersonation_financial',
    patterns: [
      '\\b(deactivate|cancel|replace|reissue)\\s+your\\s+(card|account)\\b',
      '\\bnew\\s+card\\s+(is\\s+being\\s+)?issued\\b',
    ],
    severity: 3,
    weight: 0.6,
    label: 'Card reissue / deactivation pretext',
  },

  // ---- isolation ----
  {
    id: 'dont_hang_up',
    category: 'isolation',
    patterns: [
      "\\b(don'?t|do\\s+not)\\s+hang\\s+up\\b",
      '\\bstay\\s+on\\s+(the\\s+)?(line|phone|call)\\b',
      '\\bkeep\\s+(me|us)\\s+on\\s+(the\\s+)?(line|phone)\\b',
      '\\bif\\s+you\\s+hang\\s+up\\b.*\\b(warrant|arrest|police|charged)\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: '"Don\'t hang up" — isolation tactic',
  },
  {
    id: 'dont_tell',
    category: 'isolation',
    patterns: [
      "\\b(don'?t|do\\s+not)\\s+tell\\s+(anyone|your\\s+(spouse|husband|wife|family|kids|children|bank)|mom|mother|dad|father|sister|brother|grandma|grandpa)\\b",
      '\\bkeep\\s+this\\s+(confidential|between\\s+us|private)\\b',
      "\\bthis\\s+is\\s+(a\\s+)?(confidential|classified|sealed)\\s+(case|matter|investigation)\\b",
    ],
    severity: 5,
    weight: 1.0,
    label: '"Don\'t tell anyone" — isolation tactic',
  },
  {
    id: 'go_alone',
    category: 'isolation',
    patterns: [
      "\\b(don'?t|do\\s+not)\\s+(talk|speak|tell)\\s+(to\\s+)?(anyone|the\\s+(bank|teller|cashier))\\b",
      "\\b(don'?t|do\\s+not)\\s+tell\\s+the\\s+(bank|teller|cashier)\\b",
      '\\bif\\s+(the\\s+)?(bank|teller|cashier)\\s+asks\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: '"Don\'t tell the teller why" — scripted coaching',
  },

  // ---- time_pressure ----
  {
    id: 'immediate_action',
    category: 'time_pressure',
    patterns: [
      '\\b(right\\s+now|immediately|at\\s+once|within\\s+(the\\s+next\\s+)?(hour|minutes?|thirty|60))\\b',
      '\\b(before|by)\\s+(end\\s+of\\s+)?(the\\s+)?(day|business\\s+day|close)\\b',
    ],
    severity: 3,
    weight: 0.55,
    label: 'Urgency / time pressure',
  },
  {
    id: 'limited_window',
    category: 'time_pressure',
    patterns: [
      '\\blast\\s+(chance|opportunity|warning)\\b',
      '\\bfinal\\s+(notice|warning)\\b',
      "\\byou\\s+have\\s+\\d+\\s+(minutes?|hours?)\\s+(to|before)\\b",
    ],
    severity: 4,
    weight: 0.75,
    label: '"Last chance" / countdown pressure',
  },

  // ---- sensitive_data ----
  {
    id: 'otp_code',
    category: 'sensitive_data',
    patterns: [
      '\\b(one[-\\s]*time|verification|authentication|security)\\s+code\\b',
      '\\b(read|give|tell|send)\\s+(me\\s+)?the\\s+(code|otp|pin)\\b',
      '\\b(six|6)[-\\s]*digit\\s+code\\b',
      '\\btext(ed)?\\s+(you|your\\s+phone)\\s+a\\s+code\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: 'Asked for a verification/OTP code',
  },
  {
    id: 'ssn_full',
    category: 'sensitive_data',
    patterns: [
      '\\b(full|entire)\\s+(social|ssn)\\b',
      '\\byour\\s+social\\s+security\\s+number\\b',
      '\\bverify\\s+your\\s+ssn\\b',
    ],
    severity: 5,
    weight: 0.95,
    label: 'Asked for full SSN',
  },
  {
    id: 'password_pin',
    category: 'sensitive_data',
    patterns: [
      '\\b(your|the)\\s+(password|pin|passcode)\\b',
      '\\blogin\\s+(credentials?|details?)\\b',
    ],
    severity: 5,
    weight: 0.9,
    label: 'Asked for password / PIN',
  },
  {
    id: 'seed_phrase',
    category: 'sensitive_data',
    patterns: [
      '\\bseed\\s+phrase\\b',
      '\\brecovery\\s+(phrase|words)\\b',
      '\\b(12|24)[-\\s]*word(s)?\\s+phrase\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: 'Asked for crypto seed phrase',
  },

  // ---- emergency_relative (deepfake voice-clone pretext) ----
  {
    id: 'grandchild_distress',
    category: 'emergency_relative',
    patterns: [
      "\\b(grandma|grandpa|grandmom|granddad|nana|papa)\\b.*\\b(it'?s\\s+me|need\\s+help|in\\s+trouble)\\b",
      "\\b(it'?s\\s+me|this\\s+is)\\b.*\\b(don'?t\\s+(tell|call))\\b",
    ],
    severity: 5,
    weight: 1.0,
    label: 'Grandchild-in-distress pattern',
  },
  {
    id: 'arrested_need_bail',
    category: 'emergency_relative',
    patterns: [
      "\\bi'?(ve|m)\\s+been\\s+(arrested|locked\\s+up|in\\s+jail|detained)\\b",
      '\\bneed\\s+(bail|bond)\\s+money\\b',
      '\\bpost\\s+(my\\s+)?bail\\b',
      '\\bcar\\s+accident\\b.*\\b(hospital|lawyer|money)\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: 'Bail-money / emergency pretext',
  },
  {
    id: 'lawyer_representing',
    category: 'emergency_relative',
    patterns: [
      "\\bi'?m\\s+(the\\s+)?(lawyer|attorney|public\\s+defender)\\s+(for|representing)\\s+your\\b",
      '\\bretainer\\s+(fee|payment)\\b',
    ],
    severity: 4,
    weight: 0.8,
    label: 'Fake lawyer pretext',
  },

  // ---- smishing_bait (SMS-specific; phone calls also see these) ----
  {
    id: 'package_redelivery',
    category: 'smishing_bait',
    patterns: [
      '\\b(usps|ups|fedex|dhl|amazon)\\b.*\\b(redeliver|redelivery|delivery\\s+failed|cannot\\s+be\\s+delivered|package\\s+(held|stuck|pending))\\b',
      '\\bpackage\\s+(is\\s+)?waiting\\s+for\\s+(you|delivery)\\b',
      '\\b(schedule|confirm|reschedule)\\s+(your\\s+)?(redelivery|delivery)\\b',
    ],
    severity: 4,
    weight: 0.9,
    label: 'Package redelivery smishing pattern',
  },
  {
    id: 'unpaid_toll',
    category: 'smishing_bait',
    patterns: [
      '\\b(unpaid|outstanding|overdue)\\s+toll\\b',
      '\\b(e-?zpass|sunpass|fastrak|paybytag|peachpass|ipass|txtag|tolltag|peach\\s+pass)\\b.*\\b(balance|pay|unpaid|overdue)\\b',
      '\\bfinal\\s+notice\\b.*\\btoll\\b',
    ],
    severity: 4,
    weight: 0.95,
    label: 'Unpaid-toll smishing pattern',
  },
  {
    id: 'apple_icloud_locked',
    category: 'smishing_bait',
    patterns: [
      '\\b(apple\\s*id|icloud|apple\\s+account)\\b.*\\b(locked|suspended|disabled|compromised|verify)\\b',
      '\\b(unusual|suspicious)\\s+(sign\\s*in|login|activity)\\b.*\\b(apple|icloud)\\b',
    ],
    severity: 4,
    weight: 0.9,
    label: 'Apple ID / iCloud lockout smishing',
  },
  {
    id: 'bank_account_locked_sms',
    category: 'smishing_bait',
    patterns: [
      '\\b(your\\s+)?(account|card)\\s+(has\\s+been\\s+)?(locked|frozen|suspended|restricted)\\b.*\\b(verify|confirm|unlock|click|tap|link)\\b',
      '\\bunusual\\s+(activity|charges?)\\b.*\\b(verify|confirm|click|tap|link)\\b',
    ],
    severity: 4,
    weight: 0.9,
    label: 'Bank account lock smishing',
  },
  {
    id: 'prize_lottery',
    category: 'smishing_bait',
    patterns: [
      '\\b(congratulations|you[\'\\s]*ve\\s+won|you\\s+have\\s+won)\\b.*\\b(prize|gift\\s+card|sweepstakes|lottery|reward)\\b',
      '\\bclaim\\s+your\\s+(prize|reward|gift)\\b',
    ],
    severity: 3,
    weight: 0.75,
    label: 'Prize / lottery bait',
  },
  {
    id: 'wrong_number_warm',
    category: 'smishing_bait',
    patterns: [
      "\\b(sorry|oops|sorry\\s+to\\s+bother)\\b.*\\b(wrong\\s+number|mistake)\\b",
      '\\b(is\\s+this|am\\s+i\\s+talking\\s+to)\\s+\\b[A-Z][a-z]+\\b\\?',
    ],
    severity: 2,
    weight: 0.5,
    label: 'Pig-butchering "wrong number" opener',
  },
  {
    id: 'click_this_link_urgent',
    category: 'smishing_bait',
    patterns: [
      '\\b(click|tap|visit|follow)\\s+(this|the)\\s+(link|url)\\b.*\\b(immediately|now|urgent|asap)\\b',
    ],
    severity: 3,
    weight: 0.7,
    label: 'Urgent link-click pressure',
  },

  // ---- crypto_investment ----
  {
    id: 'guaranteed_returns',
    category: 'crypto_investment',
    patterns: [
      '\\bguaranteed\\s+(returns?|profit|gains?)\\b',
      '\\b\\d+%\\s+(daily|weekly|monthly)\\s+(returns?|profit|gains?|roi)\\b',
      '\\brisk[-\\s]*free\\s+(investment|return)\\b',
    ],
    severity: 4,
    weight: 0.85,
    label: 'Guaranteed-returns pitch',
  },
  {
    id: 'pig_butchering',
    category: 'crypto_investment',
    patterns: [
      '\\bnew\\s+(trading|investment)\\s+platform\\b',
      '\\b(proprietary|exclusive|private)\\s+(trading|investment)\\s+(platform|strategy|signal)\\b',
    ],
    severity: 3,
    weight: 0.5,
    label: 'Pig-butchering investment pretext',
  },
];

export interface PhraseHit {
  pattern: PhrasePattern;
  matched_text: string;
  /** character offset within the input text */
  offset: number;
}

// Pre-compile for speed — this runs on every transcript chunk.
const COMPILED: { pattern: PhrasePattern; regexes: RegExp[] }[] = SCAM_PATTERNS.map((p) => ({
  pattern: p,
  regexes: p.patterns.map((src) => new RegExp(src, 'i')),
}));

/**
 * Scan a string for phrase hits. Returns every pattern that matched,
 * with the matched text and offset for evidence display. De-duplicates
 * per pattern: one hit per pattern per call to detectPhrases.
 */
export function detectPhrases(text: string): PhraseHit[] {
  if (!text || text.length === 0) return [];
  const hits: PhraseHit[] = [];
  for (const { pattern, regexes } of COMPILED) {
    for (const rx of regexes) {
      const m = rx.exec(text);
      if (m) {
        hits.push({
          pattern,
          matched_text: m[0],
          offset: m.index,
        });
        break; // one hit per pattern
      }
    }
  }
  return hits;
}

/** Quickly get the pattern by id, for rehydration from DB hits. */
export function patternById(id: string): PhrasePattern | undefined {
  return SCAM_PATTERNS.find((p) => p.id === id);
}
