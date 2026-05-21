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
      // All variants now require an explicit IRS/tax/federal anchor.
      // Earlier draft ('outstanding (tax )?balance') false-positived on
      // legitimate utility / pharmacy / dentist calls saying "you have
      // an outstanding balance" — those are NOT scams and must not
      // ship the user's transcript to Claude.
      '\\boutstanding\\s+tax\\s+(balance|debt|amount|payment|liabilit)\\b',
      '\\b(unpaid|delinquent)\\s+(tax|federal\\s+tax|tax\\s+balance|tax\\s+debt)\\b',
      '\\byou\\s+(owe|have\\s+(an?\\s+)?(unpaid|outstanding))\\b.*\\b(irs|internal\\s+revenue|federal\\s+tax)\\b',
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

  // ---- 2026-05 expansion: SMS-heavy patterns ----
  // Caught from FTC Sentinel + carrier complaint summaries 2025-2026.
  // Smishing especially is where the volume has shifted; the original
  // 7-pattern set was missing several of the top-10 by US complaint
  // volume (streaming, 2FA harvest, bank-transfer-confirm, etc.).

  // ---- smishing_bait expansions ----
  {
    id: 'streaming_service_billing',
    category: 'smishing_bait',
    patterns: [
      '\\b(netflix|disney\\s*\\+|disney\\s*plus|hulu|max|hbo|paramount|peacock|spotify|apple\\s*tv|youtube\\s*premium)\\b.*\\b(payment|billing|subscription|account|charge)\\b.*\\b(failed|declined|expired|suspend|update|verify|confirm)\\b',
      '\\b(your\\s+)?(netflix|hulu|spotify|disney\\s*\\+?)\\s+(account|membership)\\s+(has\\s+been\\s+)?(suspend|cancel|put\\s+on\\s+hold|placed\\s+on\\s+hold)\\b',
    ],
    severity: 4,
    weight: 0.85,
    label: 'Streaming-service billing-failed smishing',
  },
  {
    id: 'two_factor_otp_harvest',
    category: 'smishing_bait',
    patterns: [
      '\\b(do\\s+not|don[\'\\s]*t)\\s+share\\s+(this|the)\\s+code\\b',
      '\\bif\\s+(this|that)\\s+(was|wasn[\'\\s]*t)\\s+(you|your\\s+request)\\b.*\\b(reply|text|send)\\s+\\b',
      '\\byour\\s+(verification|security|one[-\\s]*time)\\s+(code|pin|password)\\s+is\\s+\\d{4,8}\\b.*\\bdid\\s+not\\s+request\\b',
    ],
    severity: 4,
    weight: 0.85,
    label: '2FA / OTP harvesting bait',
  },
  {
    id: 'bank_transfer_confirm_bait',
    category: 'smishing_bait',
    patterns: [
      '\\b(did\\s+you|are\\s+you)\\s+(authorize|attempting|trying|requesting)\\s+(this|a)\\s+(\\$?\\d+|transfer|payment|zelle|wire|venmo|cash\\s*app)\\b',
      '\\b(zelle|wire|payment|transfer)\\s+(of\\s+)?\\$?\\d+(\\.\\d+)?\\s+(to|for)\\s+\\b.*\\breply\\s+(yes|no|y|n|stop)\\b',
      '\\b(approve|deny|verify)\\s+(this|the)\\s+(transaction|transfer|charge|payment)\\b.*\\breply\\s+\\b',
    ],
    severity: 5,
    weight: 0.95,
    label: 'Bank "Did you authorize this transfer?" bait',
  },
  {
    id: 'crypto_wallet_alert',
    category: 'smishing_bait',
    patterns: [
      '\\b(coinbase|metamask|trust\\s*wallet|kraken|binance|gemini|crypto\\.com)\\b.*\\b(verify|verification|security|alert|locked|suspend|frozen|unauthorized|unusual)\\b',
      '\\b(your\\s+)?wallet\\s+(has\\s+been\\s+)?(compromised|drained|locked|flagged)\\b',
    ],
    severity: 4,
    weight: 0.9,
    label: 'Crypto wallet / exchange smishing',
  },
  {
    id: 'tax_refund_smishing',
    category: 'smishing_bait',
    patterns: [
      '\\b(irs|tax)\\s+(refund|return)\\s+(is\\s+)?(pending|ready|available|approved)\\b',
      '\\bclaim\\s+your\\s+(stimulus|tax\\s+refund|eitc|child\\s+tax\\s+credit)\\b',
      '\\b(stimulus|treasury)\\s+(check|payment|deposit)\\s+(is\\s+)?(pending|ready|waiting)\\b',
    ],
    severity: 4,
    weight: 0.9,
    label: 'Tax refund / stimulus smishing',
  },
  {
    id: 'govt_grant_or_aid',
    category: 'smishing_bait',
    patterns: [
      '\\b(government|federal|fema|cares|hud|usda)\\s+(grant|relief|assistance|aid|stimulus)\\b.*\\b(approved|qualif|eligible|claim|process)\\b',
      '\\byou\\s+(qualify|are\\s+eligible)\\s+for\\s+(a|the)\\s+\\$?\\d+\\s+(grant|relief|assistance)\\b',
    ],
    severity: 3,
    weight: 0.75,
    label: 'Government grant / aid smishing',
  },
  {
    id: 'dmv_license_suspension',
    category: 'smishing_bait',
    patterns: [
      '\\b(dmv|department\\s+of\\s+motor\\s+vehicles?)\\b.*\\b(suspend|expire|revoke|register|fee|fine|penalty)\\b',
      '\\b(driver[\'\\s]*s|drivers)\\s+licen[cs]e\\s+(suspension|will\\s+be\\s+suspended|has\\s+been\\s+suspended)\\b',
      '\\b(vehicle|car)\\s+registration\\s+(expired|suspended|will\\s+be\\s+suspended)\\b',
    ],
    severity: 4,
    weight: 0.85,
    label: 'DMV / driver-license smishing',
  },
  {
    id: 'subscription_auto_renew_bait',
    category: 'smishing_bait',
    patterns: [
      '\\b(your\\s+)?(norton|mcafee|geek\\s*squad|best\\s*buy|kaspersky|webroot|avast|avg)\\b.*\\b(auto[-\\s]*renew|will\\s+(be\\s+)?(charged|charge|debit)|subscription\\s+(renew|charge))\\b',
      '\\byour\\s+(antivirus|security|protection)\\s+(plan|subscription)\\s+(will\\s+)?(auto[-\\s]*renew|expire|charge)\\b.*\\$\\s*\\d+',
    ],
    severity: 4,
    weight: 0.9,
    label: 'Antivirus / Geek Squad auto-renew bait',
  },
  {
    id: 'charity_disaster_smishing',
    category: 'smishing_bait',
    patterns: [
      '\\b(donate|donation|contribut)\\b.*\\b(disaster|hurricane|earthquake|wildfire|flood|tornado|relief\\s+fund)\\b',
      '\\b(red\\s+cross|salvation\\s+army|gofundme|relief\\s+fund)\\b.*\\b(text|reply|send)\\s+(donate|give|\\$\\d+)\\b',
    ],
    severity: 3,
    weight: 0.7,
    label: 'Charity / disaster donation smishing',
  },
  {
    id: 'healthcare_insurance_smishing',
    category: 'smishing_bait',
    patterns: [
      '\\b(medicare|medicaid|aca|obamacare|affordable\\s+care)\\b.*\\b(expir|enroll|verify|update|suspend|new\\s+benefit|new\\s+card)\\b',
      '\\byour\\s+(health\\s+)?insurance\\s+(plan|coverage|policy)\\s+(will\\s+)?(expir|terminat|cancel|lapse)\\b',
    ],
    severity: 3,
    weight: 0.75,
    label: 'Health-insurance / Medicare smishing',
  },
  {
    id: 'student_loan_forgiveness',
    category: 'smishing_bait',
    patterns: [
      '\\b(student\\s+loan)\\b.*\\b(forgiv|discharg|cancel|relief|eligible|qualify)\\b',
      '\\b(public\\s+service\\s+loan\\s+forgiveness|pslf|biden\\s+plan)\\b.*\\b(apply|enroll|claim)\\b',
    ],
    severity: 3,
    weight: 0.7,
    label: 'Student-loan forgiveness smishing',
  },
  {
    id: 'ssn_smishing',
    category: 'smishing_bait',
    patterns: [
      '\\b(social\\s+security|ssn|ss#)\\s+(number\\s+)?(has\\s+been\\s+)?(suspend|frozen|compromise|terminated)\\b',
      '\\bssa\\s+(fraud|investigation|case|claim)\\s+(against|involving)\\s+you\\b',
    ],
    severity: 5,
    weight: 0.95,
    label: 'SSN suspension smishing (SSA never texts)',
  },

  // ---- impersonation_authority expansions ----
  {
    id: 'police_jury_duty',
    category: 'impersonation_authority',
    patterns: [
      '\\bjury\\s+duty\\b.*\\b(missed|failed\\s+to\\s+appear|warrant|fine|contempt)\\b',
      '\\b(failed|failure)\\s+to\\s+appear\\b.*\\b(warrant|arrest|contempt|fine)\\b',
      '\\b(bench|arrest)\\s+warrant\\b.*\\b(post\\s+bond|pay|bitcoin|gift\\s+card)\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: 'Jury-duty / bench-warrant impersonation',
  },
  {
    id: 'fbi_federal_agent',
    category: 'impersonation_authority',
    patterns: [
      '\\b(this\\s+is|i[\'\\s]*m)\\s+(special\\s+)?(agent|officer)\\s+\\w+\\s+(with|from|of)\\s+(the\\s+)?(fbi|dea|cia|nsa|ice|atf|hsi|secret\\s+service)\\b',
      '\\bfederal\\s+(investigation|case|warrant|charges?)\\b.*\\b(against|involving|in)\\s+(your\\s+)?name\\b',
    ],
    severity: 5,
    weight: 1.0,
    label: 'Federal-agent impersonation',
  },
  {
    id: 'court_appearance_threat',
    category: 'impersonation_authority',
    patterns: [
      '\\b(missed|failed\\s+to\\s+make)\\s+(your\\s+)?(court\\s+)?(appearance|date)\\b',
      '\\b(judge|court)\\s+(has\\s+)?(issued|signed)\\s+(a\\s+)?(warrant|order|summons)\\b.*\\b(your\\s+name|you)\\b',
      '\\bcontempt\\s+of\\s+court\\b.*\\b(fine|warrant|arrest)\\b',
    ],
    severity: 5,
    weight: 0.95,
    label: 'Court / contempt-of-court threat',
  },

  // ---- impersonation_financial expansions ----
  {
    id: 'payment_processor_impersonation',
    category: 'impersonation_financial',
    patterns: [
      '\\b(stripe|square|paypal|venmo|cash\\s*app|zelle)\\s+(fraud|security|risk|investigations?)\\s+(team|department|unit)\\b',
      '\\b(stripe|square|paypal|venmo|cash\\s*app|zelle)\\b.*\\b(suspicious\\s+(activity|charge|transaction)|account\\s+(locked|frozen|suspended|on\\s+hold))\\b.*\\bcalled?\\b',
    ],
    severity: 4,
    weight: 0.85,
    label: 'Payment-processor "fraud team" impersonation',
  },

  // ---- time_pressure expansion ----
  {
    id: 'countdown_minutes_explicit',
    category: 'time_pressure',
    patterns: [
      "\\bin\\s+the\\s+next\\s+(30|45|60|fifteen|thirty|forty[-\\s]*five|sixty)\\s+(minutes?|mins?)\\b",
      '\\b(expir|run\\s+out|deactivat|cancel)\\s+(today|tonight|by\\s+midnight|in\\s+\\d+\\s+(minutes?|hours?))\\b',
      "\\byou\\s+have\\s+until\\s+(midnight|noon|the\\s+end\\s+of\\s+(today|the\\s+day))\\b",
    ],
    severity: 4,
    weight: 0.7,
    label: 'Explicit countdown / deadline pressure',
  },

  // ---- remote_access expansion ----
  {
    id: 'mobile_pair_or_sync',
    category: 'remote_access',
    patterns: [
      '\\b(pair|sync|link|connect|mirror)\\s+your\\s+(phone|device|account)\\b.*\\b(with|to)\\s+(my|our|the\\s+technician)\\b',
      '\\b(install|download)\\s+(quick\\s*support|airdroid|vysor|scrcpy|move\\s*to\\s*ios)\\b.*\\b(let\\s+me|so\\s+(i|we)\\s+can)\\s+(see|access|fix)\\b',
    ],
    severity: 5,
    weight: 0.95,
    label: 'Asked to pair / mirror your mobile device',
  },

  // ---- isolation expansion ----
  {
    id: 'dont_tell_family_variant',
    category: 'isolation',
    patterns: [
      "\\b(don[\'\\s]*t|do\\s+not)\\s+tell\\s+(your|my|our)?\\s*(spouse|husband|wife|kids|parents?|family|anyone)\\b",
      '\\b(this\\s+is|keep\\s+this)\\s+(confidential|between\\s+us|private)\\b.*\\b(family|spouse|partner|anyone)\\b',
      "\\bif\\s+anyone\\s+asks\\b.*\\b(say|tell\\s+them)\\b",
    ],
    severity: 4,
    weight: 0.85,
    label: 'Asked you to hide it from family',
  },

  // ---- sensitive_data expansion ----
  {
    id: 'ssn_last_four_request',
    category: 'sensitive_data',
    patterns: [
      "\\b(last|final)\\s+(4|four)\\s+(digits|numbers)\\s+of\\s+(your\\s+)?(ssn|social|social\\s+security)\\b",
      "\\b(verify|confirm)\\s+(your\\s+)?(identity|account)\\s+(by|with|using)\\s+(your\\s+)?(ssn|social\\s+security|date\\s+of\\s+birth|dob|mother[\'\\s]*s\\s+maiden)\\b",
    ],
    severity: 5,
    weight: 0.95,
    label: 'Asked for SSN / DOB / mother\'s maiden name',
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
