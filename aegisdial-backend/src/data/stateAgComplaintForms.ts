// Recovery Shield — R-P3c: 50-state Attorney General complaint form library.
//
// Every US state has its own consumer-protection complaint process,
// own intake email, own procedural quirks. A federal IC3/FTC/CFPB
// complaint is necessary but not sufficient — the state AG is the
// fastest path to real enforcement (subpoena power, the ability to
// move against the scammer's bank/payment processor inside that
// state, and in some states a restitution fund). Five high-volume
// states (FL, CA, TX, NY, GA) get fully localized templates that
// reference the exact intake portal + form number + procedural steps
// the AG's office expects. The other 45 fall through to
// genericStateAgTemplate(), which is still a valid filing draft —
// just less polished. Production-grade localization for the
// remaining states is tracked as R-P3c v2 follow-up.
//
// TEMPLATE OUTPUT CONTRACT:
//   - Returns a markdown body. The legalPacketGenerator prepends the
//     standard "AegisDial is not your attorney" disclaimer header
//     defense-in-depth, so templates here do NOT need to include it.
//   - PII redaction is handled by the generator before any template
//     output reaches the encrypted body_markdown column — these
//     templates can safely assume the case_facts they receive have
//     already been redacted (last-4 only on account numbers, etc.).
//
// PENDING FULL LOCALIZATION (R-P3c v2):
//   AK, AL, AR, AZ, CO, CT, DC, DE, HI, IA, ID, IL, IN, KS, KY, LA,
//   MA, MD, ME, MI, MN, MO, MS, MT, NC, ND, NE, NH, NJ, NM, NV, OH,
//   OK, OR, PA, RI, SC, SD, TN, UT, VA, VT, WA, WI, WV, WY
//   (45 states using genericStateAgTemplate fallback).

export interface CaseFacts {
  scam_type: string;
  amount_lost_cents: bigint;
  scam_actor_descriptor?: string;
  scam_actor_contact?: string;
  incident_date: Date;
  description_summary?: string;
}

/**
 * Currency formatter — $24,900.00 from 2490000 cents. Used by every
 * template so the dollar figure renders consistently across docs.
 */
function fmtUsd(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const dollars = abs / 100n;
  const remainder = abs % 100n;
  const remainderStr = remainder.toString().padStart(2, '0');
  // Thousands separators on the dollar portion.
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${remainderStr}`;
}

function fmtDate(d: Date): string {
  // YYYY-MM-DD. Templates render fine; localized formats can come later.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Generic fallback template. Used for the 45 states without a
 * fully localized template. Still emits a procedurally correct
 * filing draft — the user just has to look up their state AG's
 * intake URL themselves (most state AGs accept email or web form;
 * the template instructs the user to do so).
 */
export function genericStateAgTemplate(stateCode: string, facts: CaseFacts): string {
  const stateLabel = stateCode.startsWith('US-') ? stateCode.slice(3) : stateCode;
  return [
    `# State Attorney General Complaint — ${stateLabel}`,
    '',
    `**Filing party:** Consumer / Victim`,
    `**Jurisdiction:** ${stateLabel}`,
    `**Incident date:** ${fmtDate(facts.incident_date)}`,
    `**Reported loss:** ${fmtUsd(facts.amount_lost_cents)}`,
    `**Scam type:** ${facts.scam_type}`,
    '',
    '## Summary',
    '',
    facts.description_summary ??
      'The undersigned consumer was the victim of a financial fraud incident as described in the facts section below.',
    '',
    '## Subject of complaint',
    '',
    `The party engaged in the fraudulent conduct${
      facts.scam_actor_descriptor ? ` is described as: ${facts.scam_actor_descriptor}` : ''
    }.${
      facts.scam_actor_contact
        ? ` Known contact information for the subject: ${facts.scam_actor_contact}.`
        : ' The subject is currently unknown by full legal identity; contact information used during the incident is documented in the supporting record retained by the consumer.'
    }`,
    '',
    '## Relief requested',
    '',
    '1. Open an investigation under the consumer-protection statutes of this state.',
    '2. Refer the matter to law enforcement if criminal conduct is suspected.',
    '3. Coordinate with the consumer\'s financial institution(s) to attempt recovery.',
    '4. Take such other action as the Attorney General deems appropriate.',
    '',
    '## Filing instructions for the consumer',
    '',
    `Locate the ${stateLabel} Attorney General Consumer Protection complaint portal. Most state AG offices accept complaints via web form or email. Attach this completed draft as the narrative attachment to the official form, and submit copies of supporting records (transaction confirmations, communications with the scammer, bank correspondence) as separately uploaded exhibits.`,
    '',
    'Signed under penalty of perjury,',
    '',
    '_________________________  ',
    '[Consumer signature]  ',
    `Date: ${fmtDate(new Date())}`,
  ].join('\n');
}

/**
 * Florida — Office of the Attorney General, Consumer Protection
 * Division. Online form at myfloridalegal.com/contact.nsf/contact.
 * Florida also runs a dedicated senior-fraud unit (Seniors vs Crime)
 * which is highly responsive — the template cross-references it.
 */
function flTemplate(facts: CaseFacts): string {
  return [
    '# Florida Attorney General Complaint — Consumer Protection Division',
    '',
    '**Office of the Attorney General**  ',
    'State of Florida  ',
    'Consumer Protection Division  ',
    'PL-01, The Capitol  ',
    'Tallahassee, FL 32399-1050  ',
    'Online intake: https://www.myfloridalegal.com/contact.nsf/contact',
    '',
    `**Filing date:** ${fmtDate(new Date())}  `,
    `**Incident date:** ${fmtDate(facts.incident_date)}  `,
    `**Reported loss:** ${fmtUsd(facts.amount_lost_cents)}  `,
    `**Scam type:** ${facts.scam_type}`,
    '',
    '## Statement of facts',
    '',
    facts.description_summary ??
      'The undersigned was defrauded as described below and submits this complaint pursuant to Florida\'s Deceptive and Unfair Trade Practices Act (Fla. Stat. §§ 501.201–501.213).',
    '',
    `**Subject of complaint:** ${
      facts.scam_actor_descriptor ?? 'Identity withheld pending investigation.'
    }${
      facts.scam_actor_contact
        ? ` Known contact: ${facts.scam_actor_contact}.`
        : ''
    }`,
    '',
    '## Statutory basis',
    '',
    '- Florida Deceptive and Unfair Trade Practices Act (FDUTPA), Fla. Stat. §§ 501.201 et seq.',
    '- Fla. Stat. § 817.034 (Communications Fraud / Florida Communications Fraud Act), if applicable.',
    '- Fla. Stat. § 825.103 (Exploitation of an Elderly Person or Disabled Adult), if the complainant is 60+ or disabled.',
    '',
    '## Relief requested',
    '',
    '1. Open an investigation under FDUTPA.',
    '2. Coordinate with the Florida Department of Financial Services if a regulated financial institution was involved.',
    '3. Refer to Seniors vs. Crime (1-800-203-3099) if the complainant qualifies.',
    '4. Issue subpoenas to identify the subject of the complaint where the subject\'s identity is unknown.',
    '',
    '## Filing checklist for the consumer',
    '',
    '- Submit via the online portal at myfloridalegal.com or mail a printed copy to the Tallahassee address above.',
    '- Attach: transaction confirmations, communications with the scammer, your federal IC3 confirmation number, bank correspondence.',
    '- Retain a copy of your filed complaint for your records and for the asset-recovery attorney if one is engaged.',
    '',
    'Signed under penalty of perjury under the laws of the State of Florida,',
    '',
    '_________________________  ',
    '[Consumer signature]',
  ].join('\n');
}

/**
 * California — Office of the Attorney General, Public Inquiry Unit.
 * Web form at oag.ca.gov/contact/consumer-complaint-against-business
 * -or-company. CA AG references CFPB on financial-fraud intake so
 * we note that here.
 */
function caTemplate(facts: CaseFacts): string {
  return [
    '# California Attorney General Complaint — Public Inquiry Unit',
    '',
    '**Office of the Attorney General**  ',
    'State of California  ',
    'Public Inquiry Unit  ',
    'P.O. Box 944255  ',
    'Sacramento, CA 94244-2550  ',
    'Online intake: https://oag.ca.gov/contact/consumer-complaint-against-business-or-company',
    '',
    `**Filing date:** ${fmtDate(new Date())}  `,
    `**Incident date:** ${fmtDate(facts.incident_date)}  `,
    `**Reported loss:** ${fmtUsd(facts.amount_lost_cents)}  `,
    `**Scam type:** ${facts.scam_type}`,
    '',
    '## Statement of facts',
    '',
    facts.description_summary ??
      'The undersigned was the victim of a financial fraud as described below, and submits this complaint pursuant to California\'s Unfair Competition Law and Consumers Legal Remedies Act.',
    '',
    `**Subject of complaint:** ${
      facts.scam_actor_descriptor ?? 'Identity withheld pending investigation.'
    }${
      facts.scam_actor_contact
        ? ` Known contact: ${facts.scam_actor_contact}.`
        : ''
    }`,
    '',
    '## Statutory basis',
    '',
    '- California Unfair Competition Law, Cal. Bus. & Prof. Code §§ 17200 et seq.',
    '- Consumers Legal Remedies Act, Cal. Civ. Code §§ 1750 et seq.',
    '- Cal. Penal Code § 484 (theft by false pretense), if applicable.',
    '- Cal. Welf. & Inst. Code § 15610.30 (financial elder abuse), if the complainant is 65+.',
    '',
    '## Relief requested',
    '',
    '1. Open an investigation under the UCL and CLRA.',
    '2. Cross-refer to the Consumer Financial Protection Bureau (CFPB) for any regulated-bank component.',
    '3. Coordinate with the FBI\'s San Francisco / Los Angeles field office on the federal IC3 complaint (referenced below).',
    '4. Issue civil investigative demands to identify the subject of the complaint.',
    '',
    '## Filing checklist for the consumer',
    '',
    '- File online at oag.ca.gov/contact/consumer-complaint-against-business-or-company, or mail to the Sacramento address.',
    '- Attach: federal IC3 confirmation number, FTC ReportFraud confirmation, bank correspondence, all communications with the scammer.',
    '- Note your IC3 confirmation number prominently — California AG triages faster when a federal case is already open.',
    '',
    'I declare under penalty of perjury under the laws of the State of California that the foregoing is true and correct.',
    '',
    '_________________________  ',
    '[Consumer signature]',
  ].join('\n');
}

/**
 * Texas — Office of the Attorney General, Consumer Protection
 * Division. Online intake at texasattorneygeneral.gov/consumer-protection
 * /file-consumer-complaint. Form is called the Consumer Complaint Form.
 */
function txTemplate(facts: CaseFacts): string {
  return [
    '# Texas Attorney General Complaint — Consumer Protection Division',
    '',
    '**Office of the Attorney General**  ',
    'State of Texas  ',
    'Consumer Protection Division  ',
    'P.O. Box 12548  ',
    'Austin, TX 78711-2548  ',
    'Online intake: https://www.texasattorneygeneral.gov/consumer-protection/file-consumer-complaint',
    '',
    `**Filing date:** ${fmtDate(new Date())}  `,
    `**Incident date:** ${fmtDate(facts.incident_date)}  `,
    `**Reported loss:** ${fmtUsd(facts.amount_lost_cents)}  `,
    `**Scam type:** ${facts.scam_type}`,
    '',
    '## Statement of facts',
    '',
    facts.description_summary ??
      'The undersigned consumer was defrauded as described below and submits this Consumer Complaint Form pursuant to the Texas Deceptive Trade Practices Act.',
    '',
    `**Subject of complaint:** ${
      facts.scam_actor_descriptor ?? 'Identity withheld pending investigation.'
    }${
      facts.scam_actor_contact
        ? ` Known contact: ${facts.scam_actor_contact}.`
        : ''
    }`,
    '',
    '## Statutory basis',
    '',
    '- Texas Deceptive Trade Practices–Consumer Protection Act (DTPA), Tex. Bus. & Com. Code §§ 17.41 et seq.',
    '- Tex. Penal Code § 32.32 (false statement to obtain property or credit), if applicable.',
    '- Tex. Penal Code § 32.53 (exploitation of an elderly individual), if the complainant is 65+.',
    '',
    '## Relief requested',
    '',
    '1. Open an investigation under the DTPA.',
    '2. Issue Civil Investigative Demands to identify the subject and any financial institutions involved.',
    '3. Refer to local law enforcement for criminal prosecution where appropriate.',
    '4. Coordinate with the FBI Houston / Dallas / San Antonio field office on the federal IC3 complaint.',
    '',
    '## Filing checklist for the consumer',
    '',
    '- File online via the Texas AG Consumer Complaint Form, or mail to the Austin address above.',
    '- Attach: federal IC3 confirmation, FTC ReportFraud number, all communications with the scammer, bank records.',
    '- The Texas AG will not act as your private attorney — engagement of asset-recovery counsel is recommended for larger losses.',
    '',
    'Signed under penalty of perjury under the laws of the State of Texas,',
    '',
    '_________________________  ',
    '[Consumer signature]',
  ].join('\n');
}

/**
 * New York — Office of the Attorney General, Bureau of Consumer
 * Frauds and Protection. Intake at ag.ny.gov/consumer-frauds/filing
 * -consumer-complaint. NY AG is particularly aggressive on
 * cryptocurrency-related fraud — note that here.
 */
function nyTemplate(facts: CaseFacts): string {
  return [
    '# New York Attorney General Complaint — Bureau of Consumer Frauds and Protection',
    '',
    '**Office of the Attorney General**  ',
    'State of New York  ',
    'Bureau of Consumer Frauds and Protection  ',
    'The Capitol  ',
    'Albany, NY 12224-0341  ',
    'Online intake: https://ag.ny.gov/consumer-frauds/filing-consumer-complaint',
    '',
    `**Filing date:** ${fmtDate(new Date())}  `,
    `**Incident date:** ${fmtDate(facts.incident_date)}  `,
    `**Reported loss:** ${fmtUsd(facts.amount_lost_cents)}  `,
    `**Scam type:** ${facts.scam_type}`,
    '',
    '## Statement of facts',
    '',
    facts.description_summary ??
      'The undersigned consumer was defrauded as described below and submits this complaint pursuant to New York General Business Law §§ 349, 350, and Executive Law § 63(12).',
    '',
    `**Subject of complaint:** ${
      facts.scam_actor_descriptor ?? 'Identity withheld pending investigation.'
    }${
      facts.scam_actor_contact
        ? ` Known contact: ${facts.scam_actor_contact}.`
        : ''
    }`,
    '',
    '## Statutory basis',
    '',
    '- N.Y. Gen. Bus. Law § 349 (deceptive acts and practices).',
    '- N.Y. Gen. Bus. Law § 350 (false advertising).',
    '- N.Y. Exec. Law § 63(12) (persistent fraud or illegality).',
    '- N.Y. Penal Law Article 155 (larceny), if applicable.',
    '- Martin Act, N.Y. Gen. Bus. Law Article 23-A, if securities or cryptocurrency-investment fraud is alleged.',
    '',
    '## Relief requested',
    '',
    '1. Open an investigation under GBL §§ 349/350 and the Martin Act if applicable.',
    '2. Issue subpoenas under Executive Law § 63(12) to identify the subject and trace the proceeds.',
    '3. Coordinate with the FBI New York field office on the federal IC3 complaint.',
    '4. Pursue restitution and injunctive relief as available.',
    '',
    '## Filing checklist for the consumer',
    '',
    '- File online at ag.ny.gov/consumer-frauds/filing-consumer-complaint, or mail to the Albany address above.',
    '- Attach: federal IC3 confirmation, FTC ReportFraud number, bank records, all communications with the scammer, any cryptocurrency transaction hashes if applicable.',
    '- If the loss involved cryptocurrency, expressly request review under the Martin Act — the NY AG\'s Investor Protection Bureau handles these aggressively.',
    '',
    'I declare under penalty of perjury under the laws of the State of New York that the foregoing is true and correct.',
    '',
    '_________________________  ',
    '[Consumer signature]',
  ].join('\n');
}

/**
 * Georgia — Office of the Attorney General, Consumer Protection
 * Division. Intake at consumer.ga.gov/file-complaint-online.
 */
function gaTemplate(facts: CaseFacts): string {
  return [
    '# Georgia Attorney General Complaint — Consumer Protection Division',
    '',
    '**Office of the Attorney General**  ',
    'State of Georgia  ',
    'Consumer Protection Division  ',
    '2 Martin Luther King Jr. Drive, SE  ',
    'Suite 356  ',
    'Atlanta, GA 30334  ',
    'Online intake: https://consumer.georgia.gov/consumer-complaints/file-consumer-complaint',
    '',
    `**Filing date:** ${fmtDate(new Date())}  `,
    `**Incident date:** ${fmtDate(facts.incident_date)}  `,
    `**Reported loss:** ${fmtUsd(facts.amount_lost_cents)}  `,
    `**Scam type:** ${facts.scam_type}`,
    '',
    '## Statement of facts',
    '',
    facts.description_summary ??
      'The undersigned consumer was the victim of a financial fraud as described below and submits this complaint under the Georgia Fair Business Practices Act.',
    '',
    `**Subject of complaint:** ${
      facts.scam_actor_descriptor ?? 'Identity withheld pending investigation.'
    }${
      facts.scam_actor_contact
        ? ` Known contact: ${facts.scam_actor_contact}.`
        : ''
    }`,
    '',
    '## Statutory basis',
    '',
    '- Georgia Fair Business Practices Act, O.C.G.A. §§ 10-1-390 et seq.',
    '- O.C.G.A. § 16-8-3 (theft by deception), if applicable.',
    '- O.C.G.A. § 30-5-8 (abuse, neglect, or exploitation of a disabled adult or elder person), if applicable.',
    '',
    '## Relief requested',
    '',
    '1. Open an investigation under the Fair Business Practices Act.',
    '2. Coordinate with the Georgia Department of Banking and Finance if a regulated institution was involved.',
    '3. Refer to local law enforcement for criminal investigation.',
    '4. Issue investigative demands to identify the subject of the complaint.',
    '',
    '## Filing checklist for the consumer',
    '',
    '- File online at consumer.georgia.gov, or mail a printed complaint to the Atlanta address above.',
    '- Attach: federal IC3 confirmation, FTC ReportFraud number, bank correspondence, communications with the scammer.',
    '- Retain a copy for your records.',
    '',
    'Signed under penalty of perjury under the laws of the State of Georgia,',
    '',
    '_________________________  ',
    '[Consumer signature]',
  ].join('\n');
}

/**
 * STATE_AG_TEMPLATES — keyed on ISO-3166-2 code. Five fully localized,
 * 45 fall through to genericStateAgTemplate via templateForState.
 *
 * Adding a new full template: implement a `<state>Template(facts)`
 * function above, then add an entry here keyed on its ISO-3166-2 code.
 * Remove the state from the PENDING list at the top of this file.
 */
export const STATE_AG_TEMPLATES: Record<string, (facts: CaseFacts) => string> = {
  'US-FL': flTemplate,
  'US-CA': caTemplate,
  'US-TX': txTemplate,
  'US-NY': nyTemplate,
  'US-GA': gaTemplate,
};

/**
 * Resolve the template for a given state — fully localized if
 * available, otherwise the generic fallback. Always returns a
 * functional draft. Returns undefined ONLY if stateCode is empty
 * or null (caller is responsible for checking that input was
 * actually provided).
 */
export function templateForState(stateCode: string, facts: CaseFacts): string {
  const tpl = STATE_AG_TEMPLATES[stateCode];
  if (tpl) return tpl(facts);
  return genericStateAgTemplate(stateCode, facts);
}

/**
 * Sentinel — true iff stateCode has a fully localized template (not
 * the generic fallback). The legalPacketGenerator emits a metric
 * tagged with this so the admin dashboard can see when we're
 * shipping generic-fallback complaints vs full-state ones.
 */
export function hasFullStateTemplate(stateCode: string): boolean {
  return Object.prototype.hasOwnProperty.call(STATE_AG_TEMPLATES, stateCode);
}
