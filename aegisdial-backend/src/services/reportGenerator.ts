import type { ScamType } from '../lib/recoverySteps.js';

// Pre-filled report generator for the Recovery Concierge.
//
// Kyle's positioning: "fix the step that makes victims retype their whole
// story into a federal form." Neither reportfraud.ftc.gov nor ic3.gov
// accept URL pre-fill (we confirmed by inspecting their forms — both use
// stateful multi-page flows with CSRF). So the best we can do is:
//  1. Ship the canonical landing URL the user opens.
//  2. Build a ready-to-paste narrative they drop into the free-text field.
//  3. Build a structured checklist so they can tab through the remaining
//     dropdowns/text boxes without going back to the app.
//
// The narrative template is intentionally plain prose — not Markdown —
// so pasting into a textarea preserves readable line breaks.

export interface EvidenceItem {
  /** One of: note | amount | photo | phone | wallet | account | transaction */
  kind: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface ReportContext {
  scamNumber: string | null;
  scamType: string;
  amountLostUSD: number | null;
  description: string | null;
  evidenceSummary: EvidenceItem[];
  sessionStartedAt: Date;
  userDisplayName: string | null;
  userEmail: string | null;
}

export interface GeneratedReport {
  agency: 'ftc' | 'ic3';
  /** URL to open — pre-filled form if supported, landing page otherwise. */
  url: string;
  /** Formatted text block the user copy-pastes into the form. */
  narrative: string;
  /** Human-checklist the user should bring into the form. */
  fields: { label: string; value: string }[];
}

// ---------------------------------------------------------------------------
// Scam-type openers. One line each, describing HOW the scam presents — the
// caller's cover story. These are the first sentence of the narrative after
// "The caller ...". Keep each opener to a single clause so it flows with
// "The caller <opener>."
//
// Covers every value in the ScamType union plus the legacy aliases.
// ---------------------------------------------------------------------------

const SCAM_OPENERS: Record<ScamType, string> = {
  // Impersonation
  bank_impersonation:
    "claimed to be from my bank's fraud department and said my account had been compromised",
  bank_employee_impersonation:
    "claimed to be a specific employee at my bank and asked me to move money to a 'safe account'",
  irs_impersonation:
    "claimed to be an IRS agent and threatened arrest or asset seizure if I did not pay back taxes immediately",
  irs_refund_bait:
    "claimed to be from the IRS offering a refund that required me to verify bank or identity details",
  ssa_impersonation:
    "claimed my Social Security Number had been suspended due to suspicious activity and demanded verification",
  law_enforcement_impersonation:
    "claimed to be a police officer or sheriff's deputy and said I had missed a court date or warrant",
  fbi_dea_impersonation:
    "claimed to be an FBI or DEA agent investigating me and demanded payment to avoid arrest",
  uscis_ice_impersonation:
    "claimed to be from USCIS or ICE and threatened deportation unless I paid an immigration bond by phone",
  digital_arrest:
    "placed me under a fake 'digital arrest' over video call, claiming I was a suspect and had to stay on the line",
  medicare_impersonation:
    "claimed to be from Medicare and asked for my Medicare number or banking information",
  medicare_advantage_switch:
    "pressured me to switch Medicare Advantage plans and asked for my Medicare ID to 'enroll' me",
  utility_shutoff:
    "claimed to be from my utility company and threatened immediate service shutoff unless I paid by gift card or wire",
  // Tech / credential theft
  tech_support:
    "claimed to be from Microsoft, Apple, or another tech-support desk and said my computer was infected, then asked me to install remote-access software",
  fake_refund_scam:
    "claimed to be refunding an erroneous charge from Geek Squad, Norton, or a similar company and asked me to log in so they could 'reverse' the refund",
  apple_icloud_locked:
    "claimed my Apple ID / iCloud account had been locked or compromised and asked for my credentials or a verification code",
  google_account_takeover:
    "claimed to be from Google security and asked me to confirm a sign-in prompt or share a verification code",
  sim_swap_port_out:
    "social-engineered my mobile carrier to port my number to a SIM they controlled",
  banking_app_push_bombing:
    "flooded my phone with login-approval prompts and then called claiming to be bank fraud trying to 'help' me stop them",
  quishing_qr_phishing:
    "directed me to scan a QR code that led to a phishing site designed to capture my credentials or card details",
  clickfix_malware:
    "walked me through a fake error dialog that instructed me to paste a command into Run or Terminal, installing malware",
  coinbase_support_spoof:
    "claimed to be Coinbase support calling about unauthorized activity and walked me through moving crypto to a 'safe' wallet",
  // Emotional
  grandchild_emergency:
    "pretended to be my grandchild or a lawyer for my grandchild claiming they had been arrested and needed bail money",
  ai_voice_clone_family:
    "used what sounded like a family member's voice — likely an AI clone — claiming to be in an emergency and needing money immediately",
  virtual_kidnapping:
    "claimed to have kidnapped a family member and demanded a ransom while keeping me on the line",
  sextortion:
    "claimed to have compromising images or video of me and demanded payment in crypto or gift cards to prevent release",
  romance_scam:
    "built a romantic relationship with me online over weeks or months before eventually asking for money",
  pig_butchering:
    "established a long-term investment relationship online that turned out to be fraudulent",
  parent_teacher_spoof:
    "claimed to be a teacher, school official, or counselor reporting an emergency involving my child",
  // Financial
  zelle_venmo_support_scam:
    "claimed to be from Zelle, Venmo, or Cash App support and walked me through 'reversing' a fake charge that moved money out of my account",
  bitcoin_atm_scam:
    "directed me to deposit cash into a Bitcoin ATM kiosk and scan a QR code controlled by them",
  gift_card_scam:
    "instructed me to buy gift cards (Apple, Google Play, Amazon, Target, or Walmart) and read the codes over the phone",
  investment_scam:
    "offered an investment opportunity with guaranteed returns and pressured me to send funds quickly",
  crypto_scam:
    "convinced me to send cryptocurrency to a wallet under a false pretext of investment, support, or verification",
  brokerage_401k_phishing:
    "claimed to be from my brokerage or 401(k) administrator and asked me to log in or confirm credentials",
  debt_collection_phantom:
    "demanded payment on a debt I did not owe and threatened lawsuit or arrest if I did not pay immediately",
  car_warranty_expiration:
    "claimed my auto warranty was expiring and pressured me to purchase an extended service contract",
  home_warranty_scam:
    "claimed my home warranty was expiring and pressured me to pay to renew or upgrade coverage",
  subscription_trap:
    "enrolled me in a recurring subscription I did not knowingly consent to and made cancellation nearly impossible",
  advance_fee_inheritance:
    "claimed I was the beneficiary of an inheritance or unclaimed funds that required an upfront fee to release",
  lottery_sweepstakes:
    "informed me I had won a lottery or sweepstakes and demanded payment of taxes or fees before I could collect",
  // Services / property
  employment_scam:
    "offered me a job and either sent a fake check I was asked to deposit and partially return, or asked for personal/banking info up front",
  rental_scam:
    "advertised a rental property I could not see in person and demanded a deposit or first month's rent before any verification",
  timeshare_resale:
    "claimed to have a buyer for my timeshare and requested upfront fees to close the sale",
  solar_panel_scam:
    "pitched free or heavily-discounted solar panels during a door-to-door or high-pressure phone sale and pushed me to sign without review",
  moving_company_hostage:
    "quoted a low moving price, then demanded far more money to release my belongings after loading",
  home_repair_storm_chaser:
    "offered storm-damage roofing or repair work, demanded a large upfront deposit, and either disappeared or inflated the insurance claim",
  funeral_cremation_scam:
    "contacted me using details from a recent obituary and demanded payment for fake funeral or cremation expenses",
  pet_scam:
    "advertised a pet for sale online, collected deposit and 'shipping insurance' fees, and never delivered the animal",
  // Health / benefits / education
  student_loan_forgiveness:
    "claimed to be a student-loan forgiveness processor and collected fees or credentials to 'enroll' me in a federal program",
  veterans_benefits_buyout:
    "offered to buy out my VA pension or benefits in exchange for a lump-sum payment on predatory terms",
  affordable_care_act_scam:
    "claimed to be an ACA navigator and asked for personal information or payment to 'enroll' me in coverage",
  tax_prep_identity_theft:
    "filed or attempted to file a tax return in my name using stolen identity information",
  // Civic / seasonal
  charity_scam:
    "solicited a donation for a fake charity, often tied to a recent disaster or emotional cause",
  political_donation_scam_pac:
    "solicited a political donation under the guise of a well-known campaign or PAC that turned out to be a scam committee",
  census_survey_scam:
    "claimed to be from the US Census Bureau and asked for Social Security or banking information the real Census never collects by phone",
  fema_disaster_relief_fraud:
    "claimed to help me receive FEMA disaster relief in exchange for a fee or personal information",
  // Text / smishing
  package_redelivery:
    "sent a text claiming a package could not be delivered and linked to a phishing site asking for card details to 'pay redelivery'",
  unpaid_toll:
    "sent a text claiming I owed an unpaid toll and linked to a fake EZPass/SunPass/FasTrak site",
  // Re-victimization
  recovery_scam_secondary:
    "claimed to be a recovery specialist, lawyer, or federal agent who could get my stolen money back for a fee",
  unknown_triage:
    "contacted me with an unsolicited request I wasn't sure was legitimate",
  generic:
    "used high-pressure tactics and a false pretext to try to get money or personal information from me",
  // Legacy aliases
  romance:
    "built a romantic relationship with me online over weeks or months before eventually asking for money",
  investment:
    "offered an investment opportunity with guaranteed returns and pressured me to send funds quickly",
};

// ---------------------------------------------------------------------------
// FTC's "What type of problem are you reporting?" picker does not expose a
// URL query param, but their online taxonomy uses a defined set of top-level
// categories. We map each of our ScamType values onto the closest FTC label
// so the user can tab straight to it in the dropdown.
// ---------------------------------------------------------------------------

const FTC_CATEGORY: Record<ScamType, string> = {
  bank_impersonation: 'Impersonator — business',
  bank_employee_impersonation: 'Impersonator — business',
  irs_impersonation: 'Impersonator — government (IRS)',
  irs_refund_bait: 'Impersonator — government (IRS)',
  ssa_impersonation: 'Impersonator — government (SSA)',
  law_enforcement_impersonation: 'Impersonator — government (law enforcement)',
  fbi_dea_impersonation: 'Impersonator — government (FBI/DEA)',
  uscis_ice_impersonation: 'Impersonator — government (immigration)',
  digital_arrest: 'Impersonator — government (law enforcement)',
  medicare_impersonation: 'Impersonator — government (Medicare)',
  medicare_advantage_switch: 'Health care — insurance',
  utility_shutoff: 'Impersonator — business (utility)',
  tech_support: 'Tech support scam',
  fake_refund_scam: 'Tech support scam (refund)',
  apple_icloud_locked: 'Online account takeover',
  google_account_takeover: 'Online account takeover',
  sim_swap_port_out: 'Phone / mobile — SIM swap',
  banking_app_push_bombing: 'Online account takeover (banking)',
  quishing_qr_phishing: 'Phishing — QR code',
  clickfix_malware: 'Malware / computer',
  coinbase_support_spoof: 'Impersonator — business (crypto exchange)',
  grandchild_emergency: 'Family / friend emergency',
  ai_voice_clone_family: 'Family / friend emergency (voice clone)',
  virtual_kidnapping: 'Family / friend emergency (ransom)',
  sextortion: 'Extortion — sextortion',
  romance_scam: 'Romance scam',
  pig_butchering: 'Investment — crypto / pig butchering',
  parent_teacher_spoof: 'Impersonator — school / teacher',
  zelle_venmo_support_scam: 'Mobile payment app scam',
  bitcoin_atm_scam: 'Crypto — Bitcoin ATM',
  gift_card_scam: 'Gift card scam',
  investment_scam: 'Investment — other',
  crypto_scam: 'Investment — crypto',
  brokerage_401k_phishing: 'Investment — brokerage account',
  debt_collection_phantom: 'Debt collection — phantom debt',
  car_warranty_expiration: 'Auto warranty scam',
  home_warranty_scam: 'Home warranty scam',
  subscription_trap: 'Subscription trap',
  advance_fee_inheritance: 'Advance-fee — inheritance',
  lottery_sweepstakes: 'Prizes, sweepstakes, and lotteries',
  employment_scam: 'Job / employment scam',
  rental_scam: 'Rental housing scam',
  timeshare_resale: 'Timeshare resale',
  solar_panel_scam: 'Home repair / solar',
  moving_company_hostage: 'Moving company fraud',
  home_repair_storm_chaser: 'Home repair — storm chaser',
  funeral_cremation_scam: 'Funeral / cremation',
  pet_scam: 'Online shopping — pet scam',
  student_loan_forgiveness: 'Debt relief — student loan',
  veterans_benefits_buyout: 'Pension / benefits buyout',
  affordable_care_act_scam: 'Health care — ACA enrollment',
  tax_prep_identity_theft: 'Tax preparer fraud / identity theft',
  charity_scam: 'Charity scam',
  political_donation_scam_pac: 'Political donation scam',
  census_survey_scam: 'Impersonator — government (Census)',
  fema_disaster_relief_fraud: 'Impersonator — government (FEMA)',
  package_redelivery: 'Phishing — package redelivery',
  unpaid_toll: 'Phishing — unpaid toll',
  recovery_scam_secondary: 'Recovery / refund scam',
  unknown_triage: 'Unknown / under triage',
  generic: 'Other scam',
  romance: 'Romance scam',
  investment: 'Investment — other',
};

// FFKC threshold — FBI's Financial Fraud Kill Chain applies to domestic
// wires of $50,000 or more reported within 72 hours.
const FFKC_MIN_USD = 50000;
const FFKC_ELIGIBLE_TYPES: ReadonlySet<string> = new Set([
  'pig_butchering',
  'investment_scam',
  'crypto_scam',
  'investment', // legacy alias
]);

function isFfkcEligible(ctx: ReportContext): boolean {
  if (ctx.amountLostUSD == null) return false;
  if (ctx.amountLostUSD < FFKC_MIN_USD) return false;
  return FFKC_ELIGIBLE_TYPES.has(ctx.scamType);
}

function openerFor(scamType: string): string {
  const known = SCAM_OPENERS[scamType as ScamType];
  if (known) return known;
  return SCAM_OPENERS.generic;
}

function ftcCategoryFor(scamType: string): string {
  const known = FTC_CATEGORY[scamType as ScamType];
  if (known) return known;
  return FTC_CATEGORY.generic;
}

function humanScamType(scamType: string): string {
  return scamType.replace(/_/g, ' ');
}

// Format a Date as "April 18, 2026" in UTC — we intentionally use UTC so
// backend-generated narratives don't drift based on where the server runs
// (Fly can hop regions and give us CET/PST/UTC unpredictably).
function formatReadableDate(d: Date): string {
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const month = MONTHS[d.getUTCMonth()]!;
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  return `${month} ${day}, ${year}`;
}

function formatAmount(usd: number): string {
  // Never scientific, always 2 decimals when there's a fractional part.
  if (Number.isInteger(usd)) return usd.toLocaleString('en-US');
  return usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Clean a free-text description for inclusion in the narrative. Collapses
// runs of whitespace, strips control characters, trims, and caps at a
// reasonable length so a malicious/garbled payload can't blow out the form.
function cleanDescription(raw: string | null): string | null {
  if (!raw) return null;
  const normalized = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return null;
  const MAX = 1500;
  return normalized.length > MAX ? `${normalized.slice(0, MAX - 1)}…` : normalized;
}

// Render an evidence item as a short bullet line for the narrative.
function renderEvidenceLine(item: EvidenceItem): string {
  const payload = item.payload ?? {};
  // Prefer well-known keys, but fall back to a compact JSON rendering.
  switch (item.kind) {
    case 'amount': {
      const cents =
        typeof payload.amount_cents === 'number'
          ? payload.amount_cents
          : typeof payload.cents === 'number'
            ? payload.cents
            : null;
      const usd =
        typeof payload.amount_usd === 'number'
          ? payload.amount_usd
          : cents != null
            ? cents / 100
            : null;
      if (usd != null) return `Amount lost: $${formatAmount(usd)}`;
      break;
    }
    case 'phone': {
      const num = payload.e164 ?? payload.phone ?? payload.number;
      if (typeof num === 'string') return `Phone number: ${num}`;
      break;
    }
    case 'wallet': {
      const addr = payload.address ?? payload.wallet ?? payload.wallet_address;
      const chain = typeof payload.chain === 'string' ? ` (${payload.chain})` : '';
      if (typeof addr === 'string') return `Wallet address${chain}: ${addr}`;
      break;
    }
    case 'account': {
      const last4 = payload.last4 ?? payload.account_last4;
      const bank = typeof payload.bank === 'string' ? payload.bank : null;
      const label =
        last4 && bank
          ? `${bank} account ending in ${last4}`
          : last4
            ? `account ending in ${last4}`
            : bank
              ? `${bank} account`
              : null;
      if (label) return `Bank account: ${label}`;
      break;
    }
    case 'transaction': {
      const hash = payload.hash ?? payload.tx_hash ?? payload.transaction_id;
      const amt = typeof payload.amount_usd === 'number' ? ` ($${formatAmount(payload.amount_usd)})` : '';
      if (typeof hash === 'string') return `Transaction${amt}: ${hash}`;
      break;
    }
    case 'note': {
      const text = payload.text ?? payload.note ?? payload.body;
      if (typeof text === 'string' && text.trim()) {
        const snippet = text.trim().slice(0, 280);
        return `Note: ${snippet}`;
      }
      break;
    }
    case 'photo': {
      const caption = payload.caption ?? payload.description;
      if (typeof caption === 'string' && caption.trim()) return `Photo: ${caption.trim()}`;
      return `Photo evidence captured (stored on-device)`;
    }
  }
  // Fallback: render the payload keys + values compactly.
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      pairs.push(`${k}: ${String(v)}`);
    }
  }
  const rendered = pairs.length > 0 ? pairs.join(', ') : '(details on file)';
  return `${item.kind}: ${rendered}`;
}

// Shared narrative builder. Both FTC and IC3 use the same prose; the only
// difference is the FFKC paragraph, which only appears when eligible.
function buildNarrative(ctx: ReportContext, opts: { includeFfkc: boolean }): string {
  const readableDate = formatReadableDate(ctx.sessionStartedAt);
  const phoneFragment = ctx.scamNumber ? ctx.scamNumber : 'an unknown number';
  const opener = openerFor(ctx.scamType);

  const paragraphs: string[] = [];
  paragraphs.push(
    `On ${readableDate}, I received a phone call from ${phoneFragment}. The caller ${opener}.`,
  );

  const cleanedDesc = cleanDescription(ctx.description);
  if (cleanedDesc) {
    paragraphs.push(cleanedDesc);
  }

  // Amount + evidence paragraph. Only include the amount sentence when we
  // actually have a number — an empty "$" line looks unprofessional in a
  // federal filing and confuses the FTC's intake reviewers.
  const moneyLines: string[] = [];
  if (ctx.amountLostUSD != null && ctx.amountLostUSD > 0) {
    moneyLines.push(`I lost approximately $${formatAmount(ctx.amountLostUSD)} to this scam.`);
  }
  if (ctx.evidenceSummary.length > 0) {
    const bullets = ctx.evidenceSummary.map((e) => `  - ${renderEvidenceLine(e)}`).join('\n');
    moneyLines.push(`I have documented the following details:\n${bullets}`);
  }
  if (moneyLines.length > 0) paragraphs.push(moneyLines.join(' '));

  if (opts.includeFfkc && isFfkcEligible(ctx)) {
    paragraphs.push(
      'This is a request for FBI Financial Fraud Kill Chain (FFKC) action — ' +
        'the transfer exceeded $50,000 and is within the 72-hour recall window.',
    );
  }

  if (ctx.scamNumber) {
    paragraphs.push(
      `The scammer's phone number was ${ctx.scamNumber}. I have no prior relationship with this party ` +
        `and did not initiate contact.`,
    );
  } else {
    paragraphs.push(
      `I have no prior relationship with this party and did not initiate contact.`,
    );
  }

  const contactBits: string[] = [];
  if (ctx.userDisplayName) contactBits.push(ctx.userDisplayName);
  if (ctx.userEmail) contactBits.push(ctx.userEmail);
  if (contactBits.length > 0) {
    paragraphs.push(`Contact: ${contactBits.join(' · ')}`);
  }

  return paragraphs.join('\n\n');
}

// Build the checklist of structured fields. Both agencies ask for
// substantially the same basic facts; the differences are label wording.
function buildFields(
  ctx: ReportContext,
  agency: 'ftc' | 'ic3',
): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];
  fields.push({ label: 'Date of incident', value: formatReadableDate(ctx.sessionStartedAt) });
  fields.push({
    label: agency === 'ftc' ? 'Type of problem' : 'Crime type',
    value: agency === 'ftc' ? ftcCategoryFor(ctx.scamType) : humanScamType(ctx.scamType),
  });
  fields.push({
    label: 'Scammer phone number',
    value: ctx.scamNumber ?? 'Unknown',
  });
  fields.push({
    label: 'Amount lost (USD)',
    value: ctx.amountLostUSD != null ? `$${formatAmount(ctx.amountLostUSD)}` : 'None / unknown',
  });
  fields.push({
    label: 'Money was actually sent?',
    value: ctx.amountLostUSD != null && ctx.amountLostUSD > 0 ? 'Yes' : 'No',
  });
  fields.push({
    label: 'How was the scam first made?',
    value: 'Phone call',
  });
  fields.push({
    label: 'Your name',
    value: ctx.userDisplayName ?? '(fill in on the form)',
  });
  fields.push({
    label: 'Your email',
    value: ctx.userEmail ?? '(fill in on the form)',
  });

  // Evidence items become their own checklist entries so the user can
  // copy each value into IC3's "financial details" sub-sections. FTC
  // doesn't have dedicated slots for wallets / tx hashes but its intake
  // team reads narratives verbatim.
  for (const item of ctx.evidenceSummary) {
    fields.push({
      label: `Evidence — ${item.kind}`,
      value: renderEvidenceLine(item).replace(/^[^:]+:\s*/, ''),
    });
  }

  if (agency === 'ic3' && isFfkcEligible(ctx)) {
    fields.push({
      label: 'Request FFKC (Financial Fraud Kill Chain)',
      value: 'Yes — wire exceeded $50,000 within 72 hours. Mention FFKC in the narrative.',
    });
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Public generators
// ---------------------------------------------------------------------------

export function generateFtcReport(ctx: ReportContext): GeneratedReport {
  return {
    agency: 'ftc',
    url: 'https://reportfraud.ftc.gov',
    // FTC narrative never mentions FFKC — that's an FBI program, out of
    // scope for the FTC intake narrative.
    narrative: buildNarrative(ctx, { includeFfkc: false }),
    fields: buildFields(ctx, 'ftc'),
  };
}

export function generateIc3Report(ctx: ReportContext): GeneratedReport {
  return {
    agency: 'ic3',
    url: 'https://www.ic3.gov/Home/FileComplaint',
    narrative: buildNarrative(ctx, { includeFfkc: true }),
    fields: buildFields(ctx, 'ic3'),
  };
}
