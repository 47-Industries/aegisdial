// Recovery Shield — bank-specific wire-dispute template scaffolds.
//
// One scaffold per top-8 US bank + a `generic` fallback. Each scaffold
// returns a STRING with placeholders + bank-specific procedural anchors
// (Reg E for ACH/electronic, UCC Article 4A for international wires,
// SWIFT message-format hints for Wells, simple fraud-line phrasing for
// the smaller banks). The wireTraceAgent stitches the user's case
// details + the LLM's narrative into the scaffold; the scaffold is
// NOT a finished letter on its own.
//
// WHY SCAFFOLDS, NOT FINISHED LETTERS:
//
//   - Bank-by-bank fraud-department procedure changes (phone numbers,
//     email addresses, claim-form URLs). Codifying the procedure
//     reference here means a single PR updates the user-facing letter
//     for every wire-trace case in flight.
//
//   - The LLM is responsible for the narrative arc (when the wire was
//     sent, who the user believed they were sending to, why it was a
//     scam, what evidence the user has). We do NOT write that prose
//     here — it's case-specific and the LLM has the right tools.
//
//   - The legal framework reference (Reg E / UCC 4A) is bank-blind to
//     a layman but bank-specific in practice: Chase / BofA dispute
//     intake forms ask victims to invoke Reg E by name, so the
//     scaffold names it. Wells Fargo's intl-wire desk expects SWIFT
//     MT103 references on recall requests > $50k.
//
// PII POLICY:
//
//   - destination_hint is rendered as "ending in ****<last4>" — never
//     full account numbers. The scaffold function only ever sees the
//     last-4 the user volunteered.
//
//   - wire_amount_cents is rendered as USD ($xx,xxx.yy). cents value
//     is bigint to handle commercial wires > $21M (INT cap).
//
//   - No SSN, no user address, no user phone in the scaffold. Those
//     fields surface in the legal-packet docs (R-P3c) where they
//     belong; the wire-dispute letter to the bank should never carry
//     them (bank already has user identity from the account record).
//
// FRAUD-LINE CONTACTS:
//
//   The phone / email values below are the PUBLIC fraud-line contacts
//   each bank advertises on their website as of 2026-Q2. They are NOT
//   maintained on a live feed — when a victim sends the letter, the
//   bank's contact-of-record may have changed. iOS surfaces the
//   contact alongside the letter with a "verify before sending"
//   disclaimer; the runbook directs the operator to refresh these
//   from each bank's public site on a quarterly cadence.

export interface WireDisputeTemplateInput {
  /** BIGINT cents — wires can exceed INTEGER max. Formatted to USD here. */
  wire_amount_cents: bigint;
  wire_sent_at: Date;
  /** Last-4 of destination account, or null if user doesn't have it. */
  destination_hint: string | null;
}

export type WireDisputeTemplateFn = (input: WireDisputeTemplateInput) => string;

/**
 * Canonical key set. wireTraceAgent canonicalizes free-text
 * source_bank values ("Chase Bank" / "JP Morgan Chase" / "chase")
 * to one of these keys at template-lookup time.
 */
export type WireDisputeBankKey =
  | 'chase'
  | 'bofa'
  | 'wells_fargo'
  | 'citi'
  | 'us_bank'
  | 'pnc'
  | 'capital_one'
  | 'td_bank'
  | 'generic';

/**
 * Canonicalize a free-text bank name to one of the supported keys.
 * Falls through to 'generic' on no match. Conservative: only matches
 * on substrings the bank actually uses in branding. A user who typed
 * "Chace" gets the generic template (LLM still produces a usable
 * letter) rather than a wrong-bank Reg E reference.
 */
export function canonicalizeBank(rawBankName: string): WireDisputeBankKey {
  const s = rawBankName.trim().toLowerCase();
  if (!s) return 'generic';
  if (s.includes('chase') || s.includes('jp morgan') || s.includes('jpmorgan')) return 'chase';
  if (s.includes('bank of america') || s === 'bofa' || s.includes('b of a')) return 'bofa';
  if (s.includes('wells fargo') || s === 'wells' || s.includes('wellsfargo')) return 'wells_fargo';
  if (s.includes('citi') || s.includes('citibank')) return 'citi';
  if (s.includes('us bank') || s.includes('u.s. bank') || s.includes('usbank')) return 'us_bank';
  if (s.includes('pnc')) return 'pnc';
  if (s.includes('capital one') || s.includes('capitalone')) return 'capital_one';
  if (s.includes('td bank') || s.includes('td trust') || s === 'td') return 'td_bank';
  return 'generic';
}

function formatUsd(cents: bigint): string {
  // bigint-safe USD formatter. cents is unsigned in practice; we
  // never store negative wire amounts. We compose major/minor with
  // string math to avoid any Number(cents) precision loss.
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const major = abs / 100n;
  const minor = abs % 100n;
  const majorStr = major
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const minorStr = minor.toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${majorStr}.${minorStr}`;
}

function formatDate(d: Date): string {
  // YYYY-MM-DD UTC — banks expect unambiguous date formatting on
  // dispute letters; the US M/D/Y vs intl D/M/Y confusion alone has
  // delayed recall requests by days in adversarial-review case logs.
  return d.toISOString().slice(0, 10);
}

function formatHint(hint: string | null): string {
  if (!hint) return 'destination account [last 4 unknown — user did not capture]';
  // Defensive: trim to last 4 visible characters in case the user
  // pasted a full account number into the form despite UI guidance.
  const last4 = hint.replace(/\D/g, '').slice(-4) || hint.slice(-4);
  return `destination account ending in ****${last4}`;
}

const chase: WireDisputeTemplateFn = ({ wire_amount_cents, wire_sent_at, destination_hint }) => `
[SCAFFOLD: CHASE — Reg E / Reg J]

WIRE / ACH RECALL REQUEST — JPMorgan Chase Bank, N.A.

Fraud line: 1-800-432-3117 (24/7 fraud and dispute intake)
Form: chase.com/personal/customer-service/dispute (fraudulent wire intake)
Mail: National Bank By Mail, P.O. Box 6185, Westerville, OH 43086

I am requesting a fraudulent-wire recall under the following legal
framework:
  - For ACH and electronic transfers ≤ $2,000: Regulation E (12 CFR § 1005.6)
    error-resolution rights. I am asserting an unauthorized transfer.
  - For wires processed under Article 4A of the UCC: I am invoking
    Section 4A-211 (cancellation request to the receiving bank) and
    requesting a SWIFT recall message to ${formatHint(destination_hint).replace('destination account ', '')}.

WIRE DETAILS:
  Amount:        ${formatUsd(wire_amount_cents)}
  Sent on:       ${formatDate(wire_sent_at)} (UTC)
  Destination:   ${formatHint(destination_hint)}

[LLM: insert the user's narrative here — when the wire was initiated,
who they believed they were sending to, why it was a scam, what
evidence they have (call recordings, screenshots, scammer phone
number / email), the date they realized the fraud.]

REQUESTED ACTION:
  1. Initiate a SWIFT recall message to the receiving bank.
  2. Place a hold on any further outbound wires from my account
     pending fraud-line review.
  3. Open a Reg E error-resolution claim with a written acknowledgment
     within 10 business days per 12 CFR § 1005.11(c).

I will provide additional documentation (FBI IC3 complaint number,
police report number, supporting screenshots) upon request from your
fraud unit.
`.trim();

const bofa: WireDisputeTemplateFn = ({ wire_amount_cents, wire_sent_at, destination_hint }) => `
[SCAFFOLD: BANK OF AMERICA — Reg E + email intake]

WIRE / ACH RECALL REQUEST — Bank of America, N.A.

Fraud line: 1-800-432-1000 (consumer fraud intake)
Email: fraud@bankofamerica.com (claim-intake mailbox; cc on this letter)
Form: bankofamerica.com/security-center/report-fraud (online intake form)

I am requesting a fraudulent-wire recall under the following legal
framework:
  - Regulation E (12 CFR § 1005.6) for any ACH or electronic transfer
    component of this transaction. I am asserting an unauthorized
    transfer and invoking my error-resolution rights.
  - UCC Article 4A § 4A-211 (cancellation request) and § 4A-204
    (refund of unauthorized payment order) for the wire component.

WIRE DETAILS:
  Amount:        ${formatUsd(wire_amount_cents)}
  Sent on:       ${formatDate(wire_sent_at)} (UTC)
  Destination:   ${formatHint(destination_hint)}

[LLM: insert the user's narrative — circumstances of the wire,
scammer's pretext, why the user now believes it was fraud, evidence
captured.]

REQUESTED ACTION:
  1. Initiate a SWIFT recall and ACH return where applicable.
  2. Place a temporary hold on outbound wires from my account.
  3. Acknowledge this claim in writing within 10 business days per
     12 CFR § 1005.11(c).
  4. Provide a Bank of America claim number for IC3 / police-report
     cross-reference.
`.trim();

const wells_fargo: WireDisputeTemplateFn = ({ wire_amount_cents, wire_sent_at, destination_hint }) => `
[SCAFFOLD: WELLS FARGO — SWIFT MT103 framing]

WIRE RECALL REQUEST — Wells Fargo Bank, N.A.

Fraud line: 1-800-869-3557 (consumer fraud) / 1-800-AT-WELLS for wire desk
Wire investigations: wirefraud@wellsfargo.com (intake-of-record)
Mail: Wells Fargo Wire Investigations, MAC N9305-054, Minneapolis, MN 55479

I am requesting a wire recall under UCC Article 4A § 4A-211
(cancellation by sender) and § 4A-205 (unauthorized payment order).
For any ACH-rail component I additionally invoke Regulation E
(12 CFR § 1005.6).

WIRE DETAILS (please cross-reference your MT103 send record):
  Amount:        ${formatUsd(wire_amount_cents)}
  Value date:    ${formatDate(wire_sent_at)} (UTC)
  Ordering customer: [account holder on file]
  Beneficiary:   ${formatHint(destination_hint)}

I request that Wells Fargo dispatch an MT192 "Request for Cancellation"
SWIFT message to the beneficiary bank, citing the original MT103
reference. If the beneficiary bank has already credited the receiving
account, I request that Wells Fargo dispatch an MT199 free-format
message requesting funds-hold pending fraud investigation.

[LLM: insert the user's narrative — pretext used by the scammer, why
the user now believes the wire was procured by fraud, supporting
evidence.]

REQUESTED ACTION:
  1. MT192 cancellation message to beneficiary bank.
  2. MT199 funds-hold request if MT192 returns "already credited."
  3. Place a hold on further outbound wires pending review.
  4. Provide Wells Fargo case reference number within 5 business days.
`.trim();

const citi: WireDisputeTemplateFn = ({ wire_amount_cents, wire_sent_at, destination_hint }) => `
[SCAFFOLD: CITIBANK — Reg E + intl wire desk]

WIRE / ACH RECALL REQUEST — Citibank, N.A.

Fraud line: 1-800-374-9700 (consumer fraud intake)
Citi Identity Theft Solutions: 1-888-CITIGOLD (escalation)
International wire desk: citi.com/wires (recall request submission)

I am requesting a fraudulent-wire recall under:
  - Regulation E (12 CFR § 1005.6) for the ACH/electronic component.
  - UCC Article 4A § 4A-211 and § 4A-204 for the wire component.

WIRE DETAILS:
  Amount:        ${formatUsd(wire_amount_cents)}
  Sent on:       ${formatDate(wire_sent_at)} (UTC)
  Destination:   ${formatHint(destination_hint)}

[LLM: user's narrative — pretext, evidence, date fraud was realized.]

REQUESTED ACTION:
  1. Dispatch an MT192/MT199 SWIFT recall to the receiving bank for
     international destinations; an ACH return for domestic.
  2. Hold outbound wires from my account pending fraud review.
  3. Open a Reg E claim with 10-business-day acknowledgment per
     12 CFR § 1005.11(c).
  4. Provide a Citi case reference number for downstream cross-reference.
`.trim();

const us_bank: WireDisputeTemplateFn = ({ wire_amount_cents, wire_sent_at, destination_hint }) => `
[SCAFFOLD: U.S. BANK — Reg E + fraud line]

WIRE / ACH RECALL REQUEST — U.S. Bank National Association

Fraud line: 1-800-USBANKS (1-800-872-2657) — fraud and disputes 24/7
Online: usbank.com/customer-service/security/report-fraud
Mail: U.S. Bank Fraud Liaison Center, EP-MN-WS5D, 60 Livingston Ave,
      St. Paul, MN 55107

I am requesting a fraudulent-wire recall under:
  - Regulation E (12 CFR § 1005.6) — ACH/electronic component.
  - UCC Article 4A § 4A-211 — wire cancellation request.

WIRE DETAILS:
  Amount:        ${formatUsd(wire_amount_cents)}
  Sent on:       ${formatDate(wire_sent_at)} (UTC)
  Destination:   ${formatHint(destination_hint)}

[LLM: user's narrative.]

REQUESTED ACTION:
  1. SWIFT recall message (intl) or ACH return (domestic).
  2. Hold on outbound wires pending fraud review.
  3. Written acknowledgment within 10 business days per Reg E.
  4. U.S. Bank case reference number.
`.trim();

const pnc: WireDisputeTemplateFn = ({ wire_amount_cents, wire_sent_at, destination_hint }) => `
[SCAFFOLD: PNC BANK — Reg E + fraud line]

WIRE / ACH RECALL REQUEST — PNC Bank, N.A.

Fraud line: 1-888-762-2265 (consumer fraud and disputes)
Online: pnc.com/security (fraud reporting intake)
Mail: PNC Bank Customer Care, P.O. Box 609, Pittsburgh, PA 15230

I am requesting a fraudulent-wire recall under:
  - Regulation E (12 CFR § 1005.6) for the ACH/electronic component.
  - UCC Article 4A § 4A-211 (cancellation request) for the wire
    component.

WIRE DETAILS:
  Amount:        ${formatUsd(wire_amount_cents)}
  Sent on:       ${formatDate(wire_sent_at)} (UTC)
  Destination:   ${formatHint(destination_hint)}

[LLM: user's narrative.]

REQUESTED ACTION:
  1. Dispatch SWIFT recall / ACH return as applicable.
  2. Hold outbound wires from my account pending fraud review.
  3. Provide written acknowledgment within 10 business days per
     12 CFR § 1005.11(c).
  4. Provide PNC case reference number.
`.trim();

const capital_one: WireDisputeTemplateFn = ({ wire_amount_cents, wire_sent_at, destination_hint }) => `
[SCAFFOLD: CAPITAL ONE — Reg E + fraud line]

WIRE / ACH RECALL REQUEST — Capital One, N.A.

Fraud line: 1-800-227-4825 (consumer fraud / disputes)
Online: capitalone.com/help-center/fraud-disputes
Mail: Capital One Fraud Department, P.O. Box 30285, Salt Lake City, UT 84130

I am requesting a fraudulent-wire recall under:
  - Regulation E (12 CFR § 1005.6) — ACH/electronic transfer rights.
  - UCC Article 4A § 4A-211 — wire cancellation request.

WIRE DETAILS:
  Amount:        ${formatUsd(wire_amount_cents)}
  Sent on:       ${formatDate(wire_sent_at)} (UTC)
  Destination:   ${formatHint(destination_hint)}

[LLM: user's narrative.]

REQUESTED ACTION:
  1. SWIFT recall (intl) or ACH return (domestic).
  2. Hold outbound wires pending fraud review.
  3. Reg E acknowledgment within 10 business days.
  4. Capital One case reference number.
`.trim();

const td_bank: WireDisputeTemplateFn = ({ wire_amount_cents, wire_sent_at, destination_hint }) => `
[SCAFFOLD: TD BANK — Reg E + fraud line]

WIRE / ACH RECALL REQUEST — TD Bank, N.A.

Fraud line: 1-888-751-9000 (24/7 fraud reporting)
Online: td.com/us/en/personal-banking/security/report-fraud
Mail: TD Bank, Attn: Fraud Operations, 6000 Atrium Way, Mt. Laurel, NJ 08054

I am requesting a fraudulent-wire recall under:
  - Regulation E (12 CFR § 1005.6) — ACH/electronic component.
  - UCC Article 4A § 4A-211 — wire cancellation request.

WIRE DETAILS:
  Amount:        ${formatUsd(wire_amount_cents)}
  Sent on:       ${formatDate(wire_sent_at)} (UTC)
  Destination:   ${formatHint(destination_hint)}

[LLM: user's narrative.]

REQUESTED ACTION:
  1. SWIFT recall (intl) or ACH return (domestic).
  2. Hold outbound wires from my account pending fraud review.
  3. Reg E written acknowledgment within 10 business days per
     12 CFR § 1005.11(c).
  4. TD Bank case reference number.
`.trim();

const generic: WireDisputeTemplateFn = ({ wire_amount_cents, wire_sent_at, destination_hint }) => `
[SCAFFOLD: GENERIC US BANK — Reg E + UCC 4A]

WIRE / ACH RECALL REQUEST

To: Fraud Department of [your bank]
    (call the number printed on the back of your debit card or on
    the bank's "report fraud" web page; ask for the wire-investigations
    or fraud-claims team specifically — branch staff cannot issue
    SWIFT recall messages.)

I am requesting a fraudulent-wire recall under the following legal
framework:
  - Regulation E (12 CFR § 1005.6) for the ACH or electronic-transfer
    component, asserting an unauthorized transfer with full error-
    resolution rights under 12 CFR § 1005.11.
  - UCC Article 4A § 4A-211 (sender's cancellation request to the
    receiving bank) and § 4A-204 (refund of unauthorized payment
    order) for the wire-rail component.

WIRE DETAILS:
  Amount:        ${formatUsd(wire_amount_cents)}
  Sent on:       ${formatDate(wire_sent_at)} (UTC)
  Destination:   ${formatHint(destination_hint)}

[LLM: insert the user's narrative — circumstances, scammer's pretext,
evidence, date fraud was realized.]

REQUESTED ACTION:
  1. Dispatch a SWIFT recall message (international) or ACH return
     (domestic) to the receiving bank.
  2. Place a temporary hold on outbound wires from my account
     pending fraud review.
  3. Provide written acknowledgment of this claim within 10 business
     days per 12 CFR § 1005.11(c).
  4. Provide a case reference number for downstream cross-reference
     with FBI IC3 and local police report filings.
`.trim();

export const WIRE_DISPUTE_TEMPLATES: Record<WireDisputeBankKey, WireDisputeTemplateFn> = {
  chase,
  bofa,
  wells_fargo,
  citi,
  us_bank,
  pnc,
  capital_one,
  td_bank,
  generic,
};

/**
 * Resolve the bank-specific scaffold for a given free-text source-bank
 * value. Falls through to the generic template on no match.
 */
export function getWireDisputeTemplate(
  rawBankName: string,
): { key: WireDisputeBankKey; fn: WireDisputeTemplateFn } {
  const key = canonicalizeBank(rawBankName);
  return { key, fn: WIRE_DISPUTE_TEMPLATES[key] };
}
