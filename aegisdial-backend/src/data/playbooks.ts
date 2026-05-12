// Live Shield v4 — Phase 0 — playbook library.
//
// Each playbook is a scripted scam pattern. The stage classifier
// (src/services/stageClassifier.ts) reads these definitions on every
// transcript chunk and decides which playbook the call most resembles
// + which stage of that playbook the conversation has reached.
//
// Source of truth: this file. Migrations seed b4_playbooks from this
// data via the bootstrap path (see scripts/seedV4Playbooks.ts —
// shipped in Phase 1). Admin can hot-tune the DB rows for ops
// purposes; this file is the canonical version code references.
//
// The 14 initial playbooks are the FBI/FTC top-loss list from
// LIVE_SHIELD_V4.md (12 original buckets, split into 14 once we
// realized IRS / SSA / Medicare scripts diverge enough that one
// playbook can't classify them well). Each was chosen because:
//   - It's high-volume (large mentions corpus to validate against)
//   - It has well-formalized stages (rapport → authority → fear → ask → close)
//   - It has known counter-scripts that actually work
//   - It targets a demographic AegisDial can serve
//
// Stage taxonomy: every playbook uses the same 5-stage schema
// (rapport / authority / fear / ask / close). Some playbooks
// compress stages (gift_card_payment is mostly stages 4-5). Some
// elongate one stage (romance_scam's "rapport" can run weeks).
// The schema is uniform so the classifier prompt + state machine
// can be one piece of code, not per-playbook custom logic.
//
// Expected-phrases lists are PROMPT GROUNDING for the LLM
// classifier, not regex. The classifier reads them, weighs the
// chunk text against them semantically, and emits a (stage,
// confidence) pair. Adding a phrase tightens the classifier on
// that stage; removing one loosens it. There is no per-phrase
// weight — confidence comes from the classifier, not the seed.

export type PlaybookId =
  | 'bank_impersonation'
  | 'irs_impersonation'
  | 'ssa_impersonation'
  | 'medicare_impersonation'
  | 'tech_support_scam'
  | 'grandparent_scam'
  | 'romance_scam'
  | 'gift_card_payment_scam'
  | 'crypto_investment_scam'
  | 'sweepstakes_lottery_scam'
  | 'job_offer_scam'
  | 'charity_disaster_scam'
  | 'utility_shutoff_scam'
  | 'police_warrant_scam';

export type StageId = 'rapport' | 'authority' | 'fear' | 'ask' | 'close';

export interface PlaybookStage {
  /** Stage identifier — one of the canonical 5. */
  id: StageId;
  /**
   * Phrases the classifier looks for to recognize this stage.
   * Verbatim STT-friendly — what scammers actually say, not
   * paraphrase. Used as prompt grounding, not regex.
   */
  expected_phrases: string[];
  /**
   * Typical wall-clock duration window in seconds [min, max].
   * Used by the family-alert preempt copy ("Mom is at fear stage,
   * average time to ask is 90s — call her now"). NOT used as a
   * hard gate by the classifier — a scammer who lingers in fear
   * for 5 minutes still fires the ask transition when the phrase
   * lands.
   */
  typical_duration_seconds: [number, number];
}

export interface Playbook {
  id: PlaybookId;
  display_name: string;
  /**
   * Short human-friendly phrase used in family-alert message bodies.
   * Written for a worried family member reading a push notification —
   * names the scam in plain language ("a bank fraud-department
   * impersonation") and adds urgency cue. Combined with a stage-aware
   * suffix at format time (see liveShieldFamilyAlert.buildAlertPayload).
   * Read-side gated by V4_PLAYBOOK_FAMILY_ALERT_COPY_ENABLED.
   */
  family_alert_blurb: string;
  description: string;
  stages: PlaybookStage[];
  /**
   * Phrases proven to make scammers hang up on this playbook.
   * Surfaced in real time when the classifier locks onto this
   * playbook. Order matters — earliest entries are the strongest.
   */
  counter_scripts: string[];
  /**
   * Reference into the recovery_catalog (see src/lib/recoverySteps.ts).
   * If set, Recovery Concierge preloads with these steps when the
   * call ends in this playbook.
   */
  recovery_steps_link: string | null;
  /**
   * Loose demographic priors — { elderly, working_adult, young }.
   * Sum to 1.0. The classifier uses these to break ties when the
   * caller-side phrases match two playbooks roughly equally.
   * Calibrated against FBI/FTC IC3 demographic breakdowns.
   */
  demographic_priors: {
    elderly: number;
    working_adult: number;
    young: number;
  };
}

export const PLAYBOOKS: Playbook[] = [
  // -------------------------------------------------------------------------
  // 1. Bank fraud-department impersonation
  // -------------------------------------------------------------------------
  // The single highest-volume playbook by mentions corpus. B4 already
  // partially formalizes the verifier side; v4 adds stage awareness.
  {
    id: 'bank_impersonation',
    display_name: 'Bank fraud-department impersonation',
    family_alert_blurb:
      'a bank fraud-department impersonation. They typically ask her to move money "to a safe account" 5–8 minutes in.',
    description:
      "Caller claims to be from the victim's bank's fraud team. " +
      "Walks them through 'securing' their account by moving money to " +
      "a 'safe' account (controlled by the scammer).",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          'this is a courtesy call',
          "we're calling because we noticed",
          'just to verify',
          'before we go any further',
          'to keep your account safe',
        ],
        typical_duration_seconds: [30, 90],
      },
      {
        id: 'authority',
        expected_phrases: [
          "this is the fraud department at",
          "wells fargo fraud team",
          "chase fraud prevention",
          "bank of america security",
          "we have a suspicious charge",
          "an unauthorized transaction",
          "your account has been flagged",
        ],
        typical_duration_seconds: [60, 180],
      },
      {
        id: 'fear',
        expected_phrases: [
          "if we don't act now",
          "your money is at risk",
          "they're trying to wire",
          "they've already drained",
          "we have 10 minutes before the transfer clears",
          "if you hang up they'll empty your account",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'ask',
        expected_phrases: [
          'move it to a safe account',
          "transfer it to our verified account",
          'wire it to this routing number',
          "i'll stay on the line while you",
          "use zelle to send",
          "the routing number is",
          "can you read me your card number",
        ],
        typical_duration_seconds: [60, 300],
      },
      {
        id: 'close',
        expected_phrases: [
          "the transfer is complete",
          "you'll see the funds returned in 24 hours",
          "we'll send you a confirmation",
          "don't speak to anyone about this",
          "this is a security matter",
        ],
        typical_duration_seconds: [15, 60],
      },
    ],
    counter_scripts: [
      "I'll hang up and call the bank back at the number on the back of my card.",
      "Your bank will never ask you to move money to keep it safe. Hang up.",
      "What's the case number? I'll call the bank's published number to verify.",
    ],
    recovery_steps_link: 'recovery_catalog.bank_impersonation',
    demographic_priors: { elderly: 0.55, working_adult: 0.4, young: 0.05 },
  },

  // -------------------------------------------------------------------------
  // 2. IRS impersonation
  // -------------------------------------------------------------------------
  // Canonical scripted scam — most data in the FCC corpus. The "back
  // taxes warrant" thread is the classic flow.
  {
    id: 'irs_impersonation',
    display_name: 'IRS impersonation',
    family_alert_blurb:
      'an IRS impersonation scam. They threaten arrest and demand gift cards or wire transfers for "back taxes."',
    description:
      "Caller claims to be from the IRS, alleging back taxes or fraud. " +
      "Demands immediate payment via gift cards, wire, or crypto, " +
      "under threat of arrest or warrant.",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          "this is an official call",
          "this matter is time-sensitive",
          "we're trying to reach you before",
        ],
        typical_duration_seconds: [15, 60],
      },
      {
        id: 'authority',
        expected_phrases: [
          "this is the irs",
          "internal revenue service",
          "criminal investigation division",
          "treasury department",
          "case number",
          "agent badge number",
          "your social security number is on file",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'fear',
        expected_phrases: [
          "a warrant has been issued",
          "you owe back taxes",
          "you'll be arrested within 24 hours",
          "local police are on their way",
          "your bank accounts will be frozen",
          "your social security number will be suspended",
          "tax evasion charges",
        ],
        typical_duration_seconds: [60, 180],
      },
      {
        id: 'ask',
        expected_phrases: [
          "you need to pay this today",
          "we only accept",
          'apple gift cards',
          'google play cards',
          "target gift cards",
          "stay on the line",
          "drive to the nearest store",
          "go to walmart",
          'bitcoin atm',
          'wire transfer to',
        ],
        typical_duration_seconds: [120, 600],
      },
      {
        id: 'close',
        expected_phrases: [
          "read me the numbers on the back",
          "scratch off the back",
          "we'll mail you a receipt",
          "case closed",
          "your social security is reinstated",
        ],
        typical_duration_seconds: [30, 120],
      },
    ],
    counter_scripts: [
      "The IRS never demands payment by gift card, wire, or crypto. Hang up.",
      "I'll call the IRS back at the number on irs.gov.",
      "The IRS communicates by mail first, never by phone for unpaid taxes.",
    ],
    recovery_steps_link: 'recovery_catalog.irs_impersonation',
    demographic_priors: { elderly: 0.6, working_adult: 0.3, young: 0.1 },
  },

  // -------------------------------------------------------------------------
  // 3. Social Security Administration impersonation
  // -------------------------------------------------------------------------
  // SSA-specific variant of authority impersonation. Distinguishes
  // from IRS by the "your social security number is suspended" hook.
  {
    id: 'ssa_impersonation',
    display_name: 'Social Security Administration impersonation',
    family_alert_blurb:
      'a Social Security Administration impersonation. They claim her benefits will be suspended unless she pays now.',
    description:
      "Caller claims to be from the SSA. Threatens to suspend the " +
      "victim's social security number due to alleged identity theft " +
      "or criminal activity tied to their SSN.",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          'this is an automated call',
          "before this call is disconnected",
          "press 1 to speak with",
        ],
        typical_duration_seconds: [15, 60],
      },
      {
        id: 'authority',
        expected_phrases: [
          "social security administration",
          "office of inspector general",
          "your social security number",
          "personal action number",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'fear',
        expected_phrases: [
          "your social has been used in",
          "criminal activity in texas",
          "your benefits will be suspended",
          "drug trafficking",
          "money laundering",
          "you're a person of interest",
        ],
        typical_duration_seconds: [60, 240],
      },
      {
        id: 'ask',
        expected_phrases: [
          "you need to verify your identity",
          "we need you to move your funds",
          "to a federal protection account",
          "buy gift cards",
        ],
        typical_duration_seconds: [120, 600],
      },
      {
        id: 'close',
        expected_phrases: [
          "your social is now safe",
          "we'll restore your benefits",
          'do not discuss this with anyone',
        ],
        typical_duration_seconds: [30, 90],
      },
    ],
    counter_scripts: [
      "The SSA does not suspend social security numbers. Hang up.",
      "I'll call the SSA at the number on ssa.gov.",
      "Real SSA staff never ask you to move money or buy gift cards.",
    ],
    recovery_steps_link: 'recovery_catalog.ssa_impersonation',
    demographic_priors: { elderly: 0.75, working_adult: 0.2, young: 0.05 },
  },

  // -------------------------------------------------------------------------
  // 4. Medicare impersonation
  // -------------------------------------------------------------------------
  // Healthcare-flavored authority impersonation. Asks for Medicare ID
  // numbers to "send you a new card" or "verify your enrollment".
  {
    id: 'medicare_impersonation',
    display_name: 'Medicare impersonation',
    family_alert_blurb:
      'a Medicare impersonation scam. They want her Medicare number to bill phantom procedures.',
    description:
      "Caller claims to be from Medicare or a Medicare-affiliated " +
      "supplemental plan. Solicits Medicare ID, SSN, or banking info " +
      "under pretext of card replacement or coverage verification.",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          "you qualify for additional benefits",
          "we're updating our records",
          "your medicare information",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'authority',
        expected_phrases: [
          'this is medicare',
          'medicare services',
          'centers for medicare and medicaid',
          "your enrollment representative",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'fear',
        expected_phrases: [
          "your coverage is about to lapse",
          "you'll lose your benefits",
          "if you don't verify today",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'ask',
        expected_phrases: [
          'your medicare number',
          "your social security number for verification",
          "your date of birth and address",
          "the routing number for the new card",
        ],
        typical_duration_seconds: [60, 240],
      },
      {
        id: 'close',
        expected_phrases: [
          "your new card will arrive in 7 to 10 days",
          "your benefits are confirmed",
        ],
        typical_duration_seconds: [15, 60],
      },
    ],
    counter_scripts: [
      "Medicare never calls about new cards. Hang up and call 1-800-MEDICARE.",
      "I never share my Medicare or SSN over the phone.",
      "I'll verify on medicare.gov.",
    ],
    recovery_steps_link: 'recovery_catalog.medicare_impersonation',
    demographic_priors: { elderly: 0.85, working_adult: 0.13, young: 0.02 },
  },

  // -------------------------------------------------------------------------
  // 5. Tech-support scam
  // -------------------------------------------------------------------------
  // Targets older Windows users specifically. Often initiated via pop-
  // up that displays a fake number; phone leg starts mid-flow.
  {
    id: 'tech_support_scam',
    display_name: 'Tech-support scam',
    family_alert_blurb:
      'a tech-support scam. They will ask for remote access to her computer or for payment via gift cards.',
    description:
      "Caller claims to be from Microsoft, Apple, or a generic 'tech " +
      "support' team. Pretends to detect a virus or compromise on the " +
      "victim's computer and walks them through installing remote-" +
      "access software, then siphons money.",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          "we're calling from microsoft support",
          "our system detected",
          "your computer is sending error reports",
          "do you have a moment",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'authority',
        expected_phrases: [
          "microsoft windows defender",
          "apple support",
          "geek squad",
          "norton",
          "mcafee subscription",
          "official certified technician",
          "windows license has expired",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'fear',
        expected_phrases: [
          "your computer is infected",
          "hackers have access",
          "your bank credentials are exposed",
          "russian hackers",
          "your identity has been stolen",
        ],
        typical_duration_seconds: [60, 180],
      },
      {
        id: 'ask',
        expected_phrases: [
          "i need you to type in",
          'anydesk',
          'teamviewer',
          'logmein',
          "download this software",
          "go to www dot",
          "we need to refund you",
          "log into your bank",
          "purchase gift cards to reimburse",
        ],
        typical_duration_seconds: [120, 1200],
      },
      {
        id: 'close',
        expected_phrases: [
          "your computer is now clean",
          "your refund has been processed",
          "you'll see the funds in 24 hours",
        ],
        typical_duration_seconds: [30, 120],
      },
    ],
    counter_scripts: [
      "Microsoft never calls you. Hang up.",
      "I will not install any software while we're on the phone.",
      "I'll bring my computer to a local repair shop instead.",
    ],
    recovery_steps_link: 'recovery_catalog.tech_support_scam',
    demographic_priors: { elderly: 0.7, working_adult: 0.25, young: 0.05 },
  },

  // -------------------------------------------------------------------------
  // 6. Grandparent scam
  // -------------------------------------------------------------------------
  // Voice-deepfake adjacent — the scammer claims to be (or pretends to
  // sound like) a grandchild in trouble. Long-cycle risk; v3 is mostly
  // blind to this without playbook context.
  {
    id: 'grandparent_scam',
    display_name: 'Grandparent / family-emergency scam',
    family_alert_blurb:
      'a grandparent / family-emergency scam. Caller claims a family member is in jail or hurt and needs bail or medical money.',
    description:
      "Caller claims to be a grandchild or other young relative in " +
      "an emergency — jail, hospital, car accident — and needs " +
      "immediate money. Often paired with a fake 'lawyer' or 'officer' " +
      "as a second caller to add authority.",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          "grandma it's me",
          "grandpa it's me",
          "don't tell mom and dad",
          "you have to keep this secret",
          "this is so embarrassing",
          "you have to promise",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'authority',
        expected_phrases: [
          "this is officer",
          "i'm her attorney",
          "the public defender",
          "we have your grandson in custody",
          'the arresting officer',
        ],
        typical_duration_seconds: [30, 180],
      },
      {
        id: 'fear',
        expected_phrases: [
          "she's in jail",
          "we need to post bond",
          "a car accident",
          "she's hurt",
          "she'll be transferred",
          "she could lose her job",
          "the other driver is threatening to sue",
        ],
        typical_duration_seconds: [60, 240],
      },
      {
        id: 'ask',
        expected_phrases: [
          "we need bail money",
          "wire the money to",
          "a courier will come pick up cash",
          "purchase gift cards",
          "send it through western union",
          "venmo to this account",
        ],
        typical_duration_seconds: [120, 600],
      },
      {
        id: 'close',
        expected_phrases: [
          "she's being released now",
          "don't tell anyone until she's home",
          "i'll have her call you tomorrow",
        ],
        typical_duration_seconds: [30, 120],
      },
    ],
    counter_scripts: [
      "Ask them the family pet's name. If they hesitate, hang up.",
      "Call your grandchild back on the phone number you have for them.",
      "Real bail bondsmen never accept gift cards.",
    ],
    recovery_steps_link: 'recovery_catalog.grandparent_scam',
    demographic_priors: { elderly: 0.9, working_adult: 0.09, young: 0.01 },
  },

  // -------------------------------------------------------------------------
  // 7. Romance scam
  // -------------------------------------------------------------------------
  // Long-cycle pattern. v4 helps identify the call MOMENT this falls
  // into "ask" but cannot detect the months-long rapport phase
  // single-call. Flagged in LIVE_SHIELD_V4.md as not fully solved.
  {
    id: 'romance_scam',
    display_name: 'Romance scam',
    family_alert_blurb:
      'a romance scam pattern. Long-cycle — they have been cultivating her for weeks before asking for money.',
    description:
      "Long-cycle scam — scammer builds an emotional relationship " +
      "over weeks or months online, then asks for money citing " +
      "emergencies, business opportunities, or travel costs. v4 " +
      "detects calls where the ask stage manifests; it cannot detect " +
      "the rapport phase from a single call.",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          "i've been thinking about you",
          "you're the only one i can trust",
          "i wish i could see you",
          "as soon as we can be together",
        ],
        typical_duration_seconds: [120, 1200],
      },
      {
        id: 'authority',
        // Romance playbook 'authority' stage maps weakly — usually the
        // scammer claims a profession (oil rig worker, military
        // deployed, surgeon abroad) for relatability, not for power.
        expected_phrases: [
          "i'm on assignment in",
          "deployed overseas",
          "working on the rig",
          "stationed in",
          "my flight is delayed at",
        ],
        typical_duration_seconds: [60, 600],
      },
      {
        id: 'fear',
        expected_phrases: [
          "i'm in trouble and i don't know who else to call",
          "i can't access my own money",
          "my account is frozen",
          "if you don't help me i don't know what i'll do",
          "i'm being held",
        ],
        typical_duration_seconds: [120, 600],
      },
      {
        id: 'ask',
        expected_phrases: [
          "i need you to send me",
          "wire transfer to",
          "western union",
          "moneygram",
          "buy itunes gift cards",
          "send me bitcoin",
          "open an account on coinbase",
          "i'll pay you back when",
        ],
        typical_duration_seconds: [60, 600],
      },
      {
        id: 'close',
        expected_phrases: [
          "i love you so much",
          "you saved me",
          "i'll be home soon",
          "we'll be together",
        ],
        typical_duration_seconds: [30, 300],
      },
    ],
    counter_scripts: [
      "If they ask for money and you've never met in person, it's a scam.",
      "Show this conversation to a family member before sending anything.",
      "Real partners do not need you to buy gift cards.",
    ],
    recovery_steps_link: 'recovery_catalog.romance_scam',
    demographic_priors: { elderly: 0.45, working_adult: 0.45, young: 0.1 },
  },

  // -------------------------------------------------------------------------
  // 8. Gift-card payment scam (terminal pattern across many playbooks)
  // -------------------------------------------------------------------------
  // Not a complete playbook by itself — but appears as the CLOSE
  // stage in many other playbooks. Modeling it standalone catches
  // calls that jump straight to the ask without a clear authority
  // pretext (e.g. utility-shutoff variants).
  {
    id: 'gift_card_payment_scam',
    display_name: 'Gift-card payment demand',
    family_alert_blurb:
      'a gift-card payment demand. No real institution asks anyone to pay with Apple, Google Play, or Amazon gift cards — ever.',
    description:
      "Generic gift-card-payment pattern that may be the close stage " +
      "of a longer playbook (IRS, tech support, etc.) OR may stand " +
      "alone with a hand-wave 'overdue bill' pretext. Models the " +
      "payment-method trap regardless of the authority pretext.",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          "this is about an overdue payment",
          "your account has an outstanding balance",
        ],
        typical_duration_seconds: [15, 60],
      },
      {
        id: 'authority',
        // Often vague — the gift-card-payment scam frequently has weak
        // authority claims that the victim doesn't probe.
        expected_phrases: [
          "this is the billing department",
          "we're calling on behalf of",
          'your service provider',
        ],
        typical_duration_seconds: [15, 60],
      },
      {
        id: 'fear',
        expected_phrases: [
          "if you don't pay today",
          "your service will be disconnected",
          "this will go to collections",
          "a warrant will be issued",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'ask',
        expected_phrases: [
          'apple gift cards',
          'google play cards',
          'amazon gift cards',
          'walmart gift cards',
          'target gift cards',
          'steam gift cards',
          'ebay gift cards',
          "go to the nearest cvs",
          'walgreens',
          "stay on the line while you drive",
          "scratch off the back",
          "read me the 16 digits",
        ],
        typical_duration_seconds: [120, 900],
      },
      {
        id: 'close',
        expected_phrases: [
          "your payment is confirmed",
          "your account is settled",
          "we'll mail you a receipt",
        ],
        typical_duration_seconds: [15, 60],
      },
    ],
    counter_scripts: [
      "No legitimate company asks for payment in gift cards. Hang up.",
      "I'll go to my local branch or pay online at the official site.",
      "Read me the website I'd find this debt on.",
    ],
    recovery_steps_link: 'recovery_catalog.gift_card_payment_scam',
    demographic_priors: { elderly: 0.5, working_adult: 0.4, young: 0.1 },
  },

  // -------------------------------------------------------------------------
  // 9. Crypto investment scam
  // -------------------------------------------------------------------------
  // Highest-loss category by FBI 2023. Often delivered initially via
  // text/social ("pig butchering"); call leg is the closing pitch.
  {
    id: 'crypto_investment_scam',
    display_name: 'Crypto / investment scam',
    family_alert_blurb:
      'a crypto / investment scam. They promise high returns and pressure a same-day deposit, then disappear.',
    description:
      "Caller pitches a 'guaranteed high-return' crypto, forex, or " +
      "binary-options investment. Often paired with a fake trading " +
      "platform that shows fake gains until the victim tries to " +
      "withdraw.",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          "i wanted to follow up on our chat",
          "you signed up for our newsletter",
          "your friend referred you",
          "i help people just like you",
        ],
        typical_duration_seconds: [60, 300],
      },
      {
        id: 'authority',
        expected_phrases: [
          'wealth advisor',
          "trading mentor",
          "i've been doing this for 15 years",
          "registered with the sec",
          'fca regulated',
          'returns of 25 percent monthly',
        ],
        typical_duration_seconds: [60, 300],
      },
      {
        id: 'fear',
        expected_phrases: [
          "the window is closing",
          "i can only take 3 more clients",
          "you'll miss this run",
          "your money is losing value sitting in the bank",
        ],
        typical_duration_seconds: [60, 240],
      },
      {
        id: 'ask',
        expected_phrases: [
          "open an account at coinbase",
          'binance',
          'crypto.com',
          "send the bitcoin to this wallet",
          'usdt',
          'tether',
          'metamask',
          "to fund your trading account",
          "wire to this offshore account",
          "minimum buy-in is",
        ],
        typical_duration_seconds: [180, 1200],
      },
      {
        id: 'close',
        expected_phrases: [
          "i see your deposit",
          "you're already up 15 percent",
          "we'll talk again tomorrow",
          "scale up the position",
        ],
        typical_duration_seconds: [30, 180],
      },
    ],
    counter_scripts: [
      "Guaranteed returns do not exist. Hang up.",
      "I'll verify their SEC registration on brokercheck.finra.org.",
      "I never wire to offshore accounts to invest. End of story.",
    ],
    recovery_steps_link: 'recovery_catalog.crypto_investment_scam',
    demographic_priors: { elderly: 0.2, working_adult: 0.55, young: 0.25 },
  },

  // -------------------------------------------------------------------------
  // 10. Sweepstakes / lottery scam
  // -------------------------------------------------------------------------
  // Classic elder-targeting playbook. "You won — pay the tax first."
  {
    id: 'sweepstakes_lottery_scam',
    display_name: 'Sweepstakes / lottery scam',
    family_alert_blurb:
      'a sweepstakes / lottery scam. They demand "fees" or "taxes" before delivering a prize that does not exist.',
    description:
      "Caller informs victim they've won a sweepstakes, lottery, or " +
      "prize they don't remember entering. To 'claim the prize,' " +
      "the victim must pay taxes, customs fees, or processing fees " +
      "up front.",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          "congratulations",
          "i have great news for you",
          "you've won",
        ],
        typical_duration_seconds: [15, 60],
      },
      {
        id: 'authority',
        expected_phrases: [
          'publishers clearing house',
          "the lottery commission",
          "the international sweepstakes",
          "verified winner",
          "your prize patrol",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'fear',
        expected_phrases: [
          "if you don't claim this by",
          "your prize will be redistributed",
          "this is your only chance",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'ask',
        expected_phrases: [
          "you need to pay the processing fee",
          "the customs tax",
          "the irs handling fee",
          "wire 500 dollars to",
          "buy gift cards to cover the tax",
        ],
        typical_duration_seconds: [60, 300],
      },
      {
        id: 'close',
        expected_phrases: [
          "your prize will arrive in 5 to 7 days",
          "we'll send the prize patrol",
          "your check is on the way",
        ],
        typical_duration_seconds: [15, 60],
      },
    ],
    counter_scripts: [
      "Real sweepstakes never ask you to pay to claim. Hang up.",
      "Did I enter this contest? If I didn't enter, I didn't win.",
      "The IRS does not collect taxes on lottery winnings up front by phone.",
    ],
    recovery_steps_link: 'recovery_catalog.sweepstakes_lottery_scam',
    demographic_priors: { elderly: 0.8, working_adult: 0.18, young: 0.02 },
  },

  // -------------------------------------------------------------------------
  // 11. Job-offer / fake-employer scam
  // -------------------------------------------------------------------------
  // Targets job-seekers, immigrants, students. Asks for upfront fees
  // or banking info to "process payroll".
  {
    id: 'job_offer_scam',
    display_name: 'Job-offer scam',
    family_alert_blurb:
      'a fake job-offer scam. They ask for upfront fees, equipment payments, or bank info during a fake hiring process.',
    description:
      "Caller offers a remote or work-from-home job the victim never " +
      "fully applied to. Asks for SSN, banking info, or upfront fees " +
      "for 'training' or 'equipment'.",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          "we saw your resume on linkedin",
          "we have an opening that matches your skills",
          "remote, flexible hours",
          "you can earn 2000 a week",
        ],
        typical_duration_seconds: [60, 240],
      },
      {
        id: 'authority',
        expected_phrases: [
          "your hiring manager",
          "human resources",
          "our recruiting team",
          "fortune 500 company",
        ],
        typical_duration_seconds: [60, 180],
      },
      {
        id: 'fear',
        expected_phrases: [
          "this offer expires today",
          "we have 100 applicants",
          "if you don't accept by end of day",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'ask',
        expected_phrases: [
          "your social security number for payroll",
          "your routing and account number",
          "your driver's license",
          "send us 300 dollars for the equipment",
          "buy training materials from this vendor",
          "we'll send you a check, deposit it, then send us back",
        ],
        typical_duration_seconds: [60, 240],
      },
      {
        id: 'close',
        expected_phrases: [
          "welcome to the team",
          "we'll send your equipment in 3 to 5 days",
          "first day of work is",
        ],
        typical_duration_seconds: [15, 60],
      },
    ],
    counter_scripts: [
      "Legit employers never ask you to pay them. Hang up.",
      "I'll only share my SSN after I've signed an offer letter on company letterhead.",
      "What's the company's full legal name? I'll verify with the state.",
    ],
    recovery_steps_link: 'recovery_catalog.job_offer_scam',
    demographic_priors: { elderly: 0.1, working_adult: 0.6, young: 0.3 },
  },

  // -------------------------------------------------------------------------
  // 12. Charity / disaster-relief scam
  // -------------------------------------------------------------------------
  // Spikes seasonally and after disasters. Predictable timing windows
  // make this one easier to surge-detect than to single-call detect.
  {
    id: 'charity_disaster_scam',
    display_name: 'Charity / disaster-relief scam',
    family_alert_blurb:
      'a charity / disaster-relief scam. They invoke a recent event to pressure an immediate donation to a fake fund.',
    description:
      "Caller solicits donations for a fake charity, often tied to a " +
      "recent disaster (hurricane, wildfire, war). Asks for credit-" +
      "card details or gift-card donations.",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          "i'm calling about the recent",
          "people are suffering",
          "anything you can spare",
          "every dollar helps a family",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'authority',
        expected_phrases: [
          "the red cross",
          'veterans of foreign wars',
          'wounded warriors',
          "fraternal order of police",
          "official disaster relief fund",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'fear',
        expected_phrases: [
          "they have nothing left",
          "they've lost everything",
          "we need to act now",
          "the next 24 hours",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'ask',
        expected_phrases: [
          "your credit card number",
          "a one-time donation of",
          "send a gift card",
          "wire to this account",
          "make the check out to",
        ],
        typical_duration_seconds: [60, 240],
      },
      {
        id: 'close',
        expected_phrases: [
          "god bless you",
          "your donation is tax deductible",
          "we'll send you a receipt",
        ],
        typical_duration_seconds: [15, 60],
      },
    ],
    counter_scripts: [
      "I'll donate through the charity's official website, not over the phone.",
      "Look them up on charitynavigator.org first.",
      "Real charities don't accept gift cards as donations.",
    ],
    recovery_steps_link: 'recovery_catalog.charity_disaster_scam',
    demographic_priors: { elderly: 0.6, working_adult: 0.3, young: 0.1 },
  },

  // -------------------------------------------------------------------------
  // 13. Utility shut-off scam
  // -------------------------------------------------------------------------
  // High-pressure regional variant. "Pay now or your power goes off in
  // 30 minutes." Targets small-business owners and elderly.
  {
    id: 'utility_shutoff_scam',
    display_name: 'Utility shut-off scam',
    family_alert_blurb:
      'a utility shut-off scam. They threaten same-day power, gas, or water cutoff unless she pays right now.',
    description:
      "Caller claims to be from the victim's electric, gas, or water " +
      "company. Threatens immediate shut-off unless an outstanding " +
      "balance is paid right now via gift card or wire.",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          "this is about your account",
          "we've been trying to reach you",
        ],
        typical_duration_seconds: [15, 60],
      },
      {
        id: 'authority',
        expected_phrases: [
          'duke energy',
          'pg&e',
          'consolidated edison',
          'pacific gas',
          'national grid',
          'spectrum energy',
          "the utility company",
        ],
        typical_duration_seconds: [15, 60],
      },
      {
        id: 'fear',
        expected_phrases: [
          "your service will be disconnected in",
          "your power will be cut off",
          "we have a technician on the way",
          "30 minutes",
          "1 hour",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'ask',
        expected_phrases: [
          "you need to pay 245 dollars today",
          "buy a prepaid card",
          "western union to this code",
          "go to a cvs and",
        ],
        typical_duration_seconds: [60, 300],
      },
      {
        id: 'close',
        expected_phrases: [
          "we'll cancel the disconnect order",
          "your account is current",
        ],
        typical_duration_seconds: [15, 60],
      },
    ],
    counter_scripts: [
      "Real utilities never accept gift cards. Hang up.",
      "I'll call my utility's number from the back of my bill.",
      "Utilities give written notice before shutoff, not 30-minute phone calls.",
    ],
    recovery_steps_link: 'recovery_catalog.utility_shutoff_scam',
    demographic_priors: { elderly: 0.55, working_adult: 0.4, young: 0.05 },
  },

  // -------------------------------------------------------------------------
  // 14. Police / legal-warrant scam
  // -------------------------------------------------------------------------
  // Often culturally-targeted at immigrant communities. "Pay the bond
  // now or you'll be deported / arrested / your visa cancelled."
  {
    id: 'police_warrant_scam',
    display_name: 'Police / legal-warrant scam',
    family_alert_blurb:
      'a police / legal-warrant scam. They claim a warrant is out for her arrest unless she pays a fine right away.',
    description:
      "Caller claims to be law enforcement (local police, sheriff, " +
      "FBI, immigration). Alleges a warrant or pending charge and " +
      "demands immediate payment to clear it. Often targets immigrant " +
      "or minority communities with threats of deportation.",
    stages: [
      {
        id: 'rapport',
        expected_phrases: [
          "this is a serious legal matter",
          "we're trying to resolve this before",
        ],
        typical_duration_seconds: [15, 60],
      },
      {
        id: 'authority',
        expected_phrases: [
          "this is officer",
          "this is detective",
          'sheriff department',
          'department of homeland security',
          'ice agent',
          'federal marshal',
          "warrant number",
          "case number",
        ],
        typical_duration_seconds: [30, 120],
      },
      {
        id: 'fear',
        expected_phrases: [
          "a warrant is out for your arrest",
          "you missed a court date",
          "failure to appear",
          "your visa will be cancelled",
          "you'll be deported",
          "we have a unit on the way",
        ],
        typical_duration_seconds: [60, 240],
      },
      {
        id: 'ask',
        expected_phrases: [
          "you need to post bond",
          "buy gift cards to clear this",
          "wire the bond to",
          "western union to this name",
        ],
        typical_duration_seconds: [120, 600],
      },
      {
        id: 'close',
        expected_phrases: [
          "the warrant is cleared",
          "we've cancelled the order",
          "do not discuss this with anyone",
        ],
        typical_duration_seconds: [30, 120],
      },
    ],
    counter_scripts: [
      "Police never accept payment over the phone. Hang up.",
      "I'll go to my local station and verify the warrant in person.",
      "Real arrest warrants are served by officers at your door, not by phone.",
    ],
    recovery_steps_link: 'recovery_catalog.police_warrant_scam',
    demographic_priors: { elderly: 0.4, working_adult: 0.5, young: 0.1 },
  },
];

/**
 * Map for O(1) playbook lookup by ID. Built once at module load.
 */
export const PLAYBOOKS_BY_ID: ReadonlyMap<PlaybookId, Playbook> = new Map(
  PLAYBOOKS.map((p) => [p.id, p]),
);

/**
 * The fixed 5-stage taxonomy. Every playbook uses these stages in
 * order; some compress (gift-card-payment is mostly close), some
 * elongate (romance can spend weeks in rapport). The classifier
 * always emits one of these.
 */
export const STAGE_IDS: readonly StageId[] = ['rapport', 'authority', 'fear', 'ask', 'close'];

/**
 * The six B4 claim types the extractor knows how to identify. Kept as
 * a literal-string union here (rather than importing from
 * src/services/claimExtractor.ts) because src/data/* is the lower
 * layer — services depend on data, never the reverse. If a 7th claim
 * type lands in claimExtractor, update this union AND the
 * PLAYBOOK_CLAIM_EXPECTATIONS table below.
 */
export type B4ClaimType =
  | 'bank_affiliation'
  | 'agency_affiliation'
  | 'account_tail'
  | 'case_number'
  | 'employee_identity'
  | 'geographic_location';

/**
 * Live Shield v4 — Phase 5 — playbook → expected B4 claim types map.
 *
 * Each playbook has a characteristic shape of factual claims the
 * scammer tends to make. The bank-impersonation script invariably
 * names a specific bank + cites a fake case number; the tech-support
 * script claims an employee identity (Microsoft / Norton / Geek
 * Squad) without ever naming a bank.
 *
 * B4's claim extractor uses this map as a NON-DESTRUCTIVE prompt
 * bias: "for this playbook, pay extra attention to these claim
 * types — but extract any of the six if you see them." Without
 * this signal, B4 applies the same uniform extraction prompt to
 * every chunk, regardless of what the classifier already knows
 * about the call. With it, B4 ranks the right kinds of claims
 * higher for the lock-on playbook.
 *
 * Calibrated from the expected_phrases in each playbook seed. If
 * the playbook seed adds a new authority-stage phrase pattern that
 * implies a different claim class, update this table to match.
 */
export const PLAYBOOK_CLAIM_EXPECTATIONS: Record<PlaybookId, readonly B4ClaimType[]> = {
  bank_impersonation: ['bank_affiliation', 'case_number', 'account_tail', 'employee_identity'],
  irs_impersonation: ['agency_affiliation', 'case_number', 'employee_identity'],
  ssa_impersonation: ['agency_affiliation', 'case_number', 'employee_identity'],
  medicare_impersonation: ['agency_affiliation', 'employee_identity'],
  tech_support_scam: ['employee_identity'],
  // grandparent_scam fields a SECOND caller posing as officer/lawyer
  // ("this is officer X" / "i'm her attorney") — agency_affiliation
  // (police/court) + case_number (bail/bond #) are characteristic
  // alongside employee_identity. Calibrated against the playbook's
  // authority-stage seed phrases.
  grandparent_scam: ['employee_identity', 'agency_affiliation', 'case_number'],
  romance_scam: ['employee_identity', 'geographic_location'],
  // gift_card_payment_scam's authority phrases are "billing department"
  // / "your service provider" — weak employee/org claims, not a named
  // government agency. Dropping agency_affiliation prevents biasing
  // the LLM toward extracting agency claims that aren't being made.
  gift_card_payment_scam: ['employee_identity'],
  // crypto_investment_scam scripts include "registered with the SEC"
  // / "FCA regulated" — these are agency_affiliation claims.
  crypto_investment_scam: ['employee_identity', 'agency_affiliation'],
  sweepstakes_lottery_scam: ['agency_affiliation', 'case_number'],
  job_offer_scam: ['employee_identity'],
  charity_disaster_scam: ['agency_affiliation', 'geographic_location'],
  utility_shutoff_scam: ['agency_affiliation', 'account_tail'],
  police_warrant_scam: ['employee_identity', 'case_number', 'geographic_location'],
};
