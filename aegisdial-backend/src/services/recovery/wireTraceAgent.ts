import { query } from '../../lib/db.js';
import { encryptString, readMaybeEncrypted } from '../../lib/crypto.js';
import { emitMetric } from '../../lib/observability.js';
import { callLLM } from '../../lib/llm.js';
import { hasRecoveryPlus } from './recoveryPlusEntitlement.js';
import {
  canonicalizeBank,
  getWireDisputeTemplate,
  type WireDisputeBankKey,
} from '../../data/wireDisputeTemplates.js';
import type { WireTraceCaseRow } from './types.js';

// Recovery Shield — R-P3a: wire-trace agent.
//
// State-machine + LLM-letter-generation service for wire / ACH
// recall cases. One row per case in wire_trace_cases (migration 063).
// Every operation is Recovery-Plus-gated; cross-user reads silently
// return null so the caller can surface 404 without information
// leakage about whether the case_id exists.
//
// STATE MACHINE (enforced here; CHECK in migration 063 only pins
// the vocabulary):
//
//   intake → letter_drafted → user_sent → bank_acknowledged
//                                          → recalled
//                                          → denied
//                                          → closed
//
//   closed is reachable from EVERY non-closed state (user can give
//   up at any point). Otherwise transitions are strictly forward —
//   no skipping (you cannot go intake → recalled without drafting
//   the letter and sending it).
//
// LETTER GENERATION:
//
//   1. Look up the bank-specific scaffold (top-8 US banks + generic
//      fallback) from src/data/wireDisputeTemplates.ts. Scaffold
//      carries the bank's fraud-line contacts + legal-framework
//      reference (Reg E for ACH, UCC 4A for wires, SWIFT MT192/199
//      framing for Wells Fargo international wires).
//
//   2. Send scaffold + case details to the LLM. The model fills in
//      the user's narrative within the scaffold; it does NOT rewrite
//      bank-specific procedural anchors (those come verbatim from
//      the scaffold so they stay accurate).
//
//   3. Defense-in-depth: if the LLM output is missing the legal-
//      disclaimer header, this service prepends it before writing
//      to the DB. The user MUST see "consult your bank's fraud line
//      or a licensed attorney" before sending — adversarial-review
//      item D8 (R-P3) flagged the risk of a victim sending an
//      unmodified template as if it were a finished legal document.
//
//   4. Letter body is envelope-encrypted (v1:<iv>:<tag>:<ct>) via
//      src/lib/crypto.ts before INSERT. dispute_letter_text column
//      is documented as ciphertext in migration 063.
//
// CROSS-USER SAFETY:
//
//   Every SELECT / UPDATE filters WHERE id = $1 AND user_id = $2.
//   A user-mismatched case_id returns no rows; getWireTraceCase
//   surfaces null, the mutation paths throw NotFoundError. There is
//   NO code path that returns a case_id for a different user.

/** Disclaimer prepended to every generated dispute letter. */
export const DISPUTE_LETTER_DISCLAIMER =
  "NOTE: This draft is a starting template. Consult your bank's fraud department or a licensed attorney before sending.";

/** Terminal states — cases here cannot advance further. */
const TERMINAL_STATES = new Set(['recalled', 'denied', 'closed']);

/**
 * Legal forward transitions. closed is reachable from every non-
 * closed state (see canTransition); other transitions are the
 * single linear path documented in the state-machine ASCII above.
 */
const LEGAL_TRANSITIONS: Record<WireTraceCaseRow['state'], ReadonlySet<WireTraceCaseRow['state']>> = {
  intake: new Set(['letter_drafted']),
  letter_drafted: new Set(['user_sent']),
  user_sent: new Set(['bank_acknowledged']),
  bank_acknowledged: new Set(['recalled', 'denied']),
  recalled: new Set(),
  denied: new Set(),
  closed: new Set(),
};

export class RecoveryPlusRequiredError extends Error {
  constructor(user_id: string, recovery_session_id: string) {
    super(
      `Recovery Plus entitlement required for user ${user_id} on session ${recovery_session_id}`,
    );
    this.name = 'RecoveryPlusRequiredError';
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(from: WireTraceCaseRow['state'], to: WireTraceCaseRow['state']) {
    super(`illegal wire-trace state transition: ${from} → ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class NotFoundError extends Error {
  constructor(case_id: string) {
    super(`wire-trace case not found: ${case_id}`);
    this.name = 'NotFoundError';
  }
}

export interface WireTraceIntake {
  user_id: string;
  recovery_session_id: string;
  /** Free-text bank name; canonicalized at template-lookup time. */
  source_bank: string;
  /** Last-4 (or full) of destination account if user has it. Envelope-encrypted before INSERT. */
  destination_account_hint?: string;
  /** BIGINT cents — commercial wires can exceed INTEGER max. */
  wire_amount_cents: bigint;
  wire_sent_at: Date;
}

export interface AdvanceWireTraceInput {
  case_id: string;
  user_id: string;
  next_state:
    | 'letter_drafted'
    | 'user_sent'
    | 'bank_acknowledged'
    | 'recalled'
    | 'denied'
    | 'closed';
  /** Bank's response text; envelope-encrypted on the way to bank_response_text. */
  bank_response_text?: string;
}

export interface GenerateDisputeLetterInput {
  case_id: string;
  user_id: string;
  opts?: { llmFn?: typeof callLLM };
}

/**
 * Whether the state machine allows from → to. closed is always
 * reachable from any non-closed state.
 */
function canTransition(
  from: WireTraceCaseRow['state'],
  to: WireTraceCaseRow['state'],
): boolean {
  if (TERMINAL_STATES.has(from)) return false;
  if (to === 'closed') return true;
  return LEGAL_TRANSITIONS[from].has(to);
}

/**
 * Start a new wire-trace case. Recovery-Plus-gated. Inserts a row
 * with state='intake' and ciphertext destination_account_hint.
 * Emits recovery_shield.wire_trace_started.
 */
export async function startWireTraceCase(
  intake: WireTraceIntake,
): Promise<{ case_id: string; state: 'intake' }> {
  const entitled = await hasRecoveryPlus(intake.user_id, intake.recovery_session_id);
  if (!entitled) {
    throw new RecoveryPlusRequiredError(intake.user_id, intake.recovery_session_id);
  }

  // destination_account_hint is envelope-encrypted per migration 063
  // privacy doc: last-4 + bank + amount + timing correlates to one
  // account. We store ciphertext; the read path decrypts via
  // readMaybeEncrypted() when surfacing to the user's own iOS client.
  const destCt = intake.destination_account_hint
    ? encryptString(intake.destination_account_hint)
    : null;

  // wire_amount_cents is BIGINT in postgres. The pg driver accepts
  // bigint params and serializes them correctly; round-tripped back
  // out as a string via the row type (WireTraceCaseRow.wire_amount_cents).
  const ins = await query<{ id: string }>(
    `INSERT INTO wire_trace_cases (
       user_id, recovery_session_id, source_bank,
       destination_account_hint, wire_amount_cents, wire_sent_at, state
     ) VALUES ($1, $2, $3, $4, $5, $6, 'intake')
     RETURNING id`,
    [
      intake.user_id,
      intake.recovery_session_id,
      intake.source_bank,
      destCt,
      intake.wire_amount_cents,
      intake.wire_sent_at,
    ],
  );

  const caseId = ins.rows[0]!.id;

  void emitMetric('recovery_shield.wire_trace_started', {
    source_bank: canonicalizeBank(intake.source_bank),
  });

  return { case_id: caseId, state: 'intake' };
}

/**
 * Generate the bank-specific dispute letter for an existing case.
 * Recovery-Plus-gated. Looks up the case (user-scoped), picks the
 * bank scaffold, invokes the LLM, prepends the disclaimer if absent
 * (defense-in-depth), envelope-encrypts the letter, writes it to
 * dispute_letter_text, and advances state to 'letter_drafted' if
 * the case is still in 'intake'.
 *
 * Returns the plaintext letter for the caller to surface to iOS.
 * (Plaintext is safe here: the response is over an authenticated
 * TLS connection to the case owner; only the at-rest storage needs
 * encryption.)
 *
 * Throws:
 *   - RecoveryPlusRequiredError if entitlement is gone.
 *   - NotFoundError if the case doesn't exist or belongs to another user.
 */
export async function generateDisputeLetter(
  input: GenerateDisputeLetterInput,
): Promise<{ letter_text: string }> {
  // Step 1: load the case under the user-scoped predicate. A missing
  // row OR a case owned by a different user produce the SAME response
  // (NotFoundError) — no information leakage about case-id existence.
  const sel = await query<WireTraceCaseRow>(
    `SELECT id, user_id, recovery_session_id, source_bank,
            destination_account_hint, wire_amount_cents, wire_sent_at,
            state, dispute_letter_text, bank_response_text,
            state_changed_at, created_at
       FROM wire_trace_cases
      WHERE id = $1 AND user_id = $2`,
    [input.case_id, input.user_id],
  );
  if ((sel.rowCount ?? 0) === 0) {
    throw new NotFoundError(input.case_id);
  }
  const row = sel.rows[0]!;

  // Step 2: Recovery-Plus gate against the case's session (NOT against
  // an arbitrary caller-supplied session id — that would be a confused-
  // deputy vector).
  const entitled = await hasRecoveryPlus(input.user_id, row.recovery_session_id);
  if (!entitled) {
    throw new RecoveryPlusRequiredError(input.user_id, row.recovery_session_id);
  }

  // Step 3: pick the scaffold. Canonicalizer falls through to
  // 'generic' on any unknown bank string.
  const { key, fn } = getWireDisputeTemplate(row.source_bank);

  // wire_amount_cents comes back from pg as string for BIGINT
  // columns (per WireTraceCaseRow typedoc). Parse to bigint for the
  // scaffold; we never want Number() on cents > 2^53.
  const amount = BigInt(row.wire_amount_cents);
  const destHint = row.destination_account_hint
    ? readMaybeEncrypted(row.destination_account_hint)
    : null;

  const scaffold = fn({
    wire_amount_cents: amount,
    wire_sent_at: row.wire_sent_at,
    destination_hint: destHint,
  });

  // Step 4: invoke the LLM. The system prompt enforces the disclaimer
  // header + tells the model to NOT rewrite the bank-specific
  // procedural anchors (those carry verbatim legal references).
  const llmFn = input.opts?.llmFn ?? callLLM;
  const system = buildLetterSystemPrompt();
  const user = buildLetterUserPrompt(scaffold, key);
  const rawLetter = await llmFn({
    system,
    user,
    maxTokens: 2048,
  });

  // Step 5: defense-in-depth disclaimer. If the LLM forgot the
  // header (refusal, truncation, format drift), prepend it. A user
  // who taps "send" must see this disclaimer.
  const letter = ensureDisclaimer(rawLetter);

  // Step 6: envelope-encrypt and write.
  const ct = encryptString(letter);
  await query(
    `UPDATE wire_trace_cases
        SET dispute_letter_text = $3,
            state = CASE WHEN state = 'intake' THEN 'letter_drafted' ELSE state END,
            state_changed_at = CASE WHEN state = 'intake' THEN NOW() ELSE state_changed_at END
      WHERE id = $1 AND user_id = $2`,
    [input.case_id, input.user_id, ct],
  );

  void emitMetric('recovery_shield.wire_trace_letter_generated', {
    source_bank: key,
  });

  return { letter_text: letter };
}

/**
 * Advance the state machine. Recovery-Plus-gated. Rejects illegal
 * transitions. Cross-user case_id surfaces as NotFoundError.
 *
 * `next_state='bank_acknowledged'` with a bank_response_text in the
 * input writes the response (envelope-encrypted) to bank_response_text;
 * other transitions ignore bank_response_text.
 */
export async function advanceWireTraceCase(
  input: AdvanceWireTraceInput,
): Promise<{ case_id: string; state: string }> {
  const sel = await query<Pick<WireTraceCaseRow, 'state' | 'recovery_session_id'>>(
    `SELECT state, recovery_session_id
       FROM wire_trace_cases
      WHERE id = $1 AND user_id = $2`,
    [input.case_id, input.user_id],
  );
  if ((sel.rowCount ?? 0) === 0) {
    throw new NotFoundError(input.case_id);
  }
  const row = sel.rows[0]!;

  const entitled = await hasRecoveryPlus(input.user_id, row.recovery_session_id);
  if (!entitled) {
    throw new RecoveryPlusRequiredError(input.user_id, row.recovery_session_id);
  }

  if (!canTransition(row.state, input.next_state)) {
    throw new InvalidStateTransitionError(row.state, input.next_state);
  }

  const bankResponseCt =
    input.next_state === 'bank_acknowledged' && input.bank_response_text
      ? encryptString(input.bank_response_text)
      : null;

  await query(
    `UPDATE wire_trace_cases
        SET state = $3,
            state_changed_at = NOW(),
            bank_response_text = COALESCE($4, bank_response_text)
      WHERE id = $1 AND user_id = $2`,
    [input.case_id, input.user_id, input.next_state, bankResponseCt],
  );

  void emitMetric('recovery_shield.wire_trace_state_advanced', {
    next_state: input.next_state,
  });

  return { case_id: input.case_id, state: input.next_state };
}

/**
 * Read a single case. User-scoped — cross-user returns null (caller
 * surfaces 404). Decryption of dispute_letter_text / bank_response_text
 * is the caller's responsibility (route layer transforms before
 * responding); we return the raw row so this function stays a pure
 * data accessor.
 */
export async function getWireTraceCase(input: {
  case_id: string;
  user_id: string;
}): Promise<WireTraceCaseRow | null> {
  const sel = await query<WireTraceCaseRow>(
    `SELECT id, user_id, recovery_session_id, source_bank,
            destination_account_hint, wire_amount_cents, wire_sent_at,
            state, dispute_letter_text, bank_response_text,
            state_changed_at, created_at
       FROM wire_trace_cases
      WHERE id = $1 AND user_id = $2`,
    [input.case_id, input.user_id],
  );
  if ((sel.rowCount ?? 0) === 0) return null;
  return sel.rows[0]!;
}

// ---------------------------------------------------------------
// LLM prompt construction
// ---------------------------------------------------------------

function buildLetterSystemPrompt(): string {
  // Spelled-out instruction to preserve the scaffold's procedural
  // anchors verbatim (the legal-framework citations and fraud-line
  // contacts MUST NOT be paraphrased — paraphrased Reg E references
  // are how victims get bounced by bank fraud desks).
  return [
    'You are AegisDial\'s Recovery Shield letter generator. You produce',
    'wire-recall dispute letters for users who sent money to a scammer',
    'and are trying to claw it back.',
    '',
    'STRICT RULES:',
    `1. The very first line of your output MUST be: ${DISPUTE_LETTER_DISCLAIMER}`,
    '2. You will receive a bank-specific scaffold with placeholders.',
    '   - Preserve the bank\'s fraud-line contacts, legal-framework',
    '     citations (Regulation E section numbers, UCC Article 4A',
    '     section numbers, SWIFT MT message types), and case detail',
    '     lines EXACTLY as written. Paraphrasing legal anchors is a',
    '     failure.',
    '   - Fill in the [LLM: ...] placeholders with a coherent narrative',
    '     paragraph in the user\'s voice.',
    '3. The letter is read by a bank fraud-line investigator. Tone:',
    '   factual, polite, dated, organized. NEVER threatening. NEVER',
    '   accusatory toward the bank.',
    '4. Output the finished letter only. No commentary, no markdown',
    '   code fences, no preamble.',
  ].join('\n');
}

function buildLetterUserPrompt(scaffold: string, bankKey: WireDisputeBankKey): string {
  return [
    `Bank canonical key: ${bankKey}`,
    '',
    'Scaffold (preserve all non-placeholder content verbatim):',
    '---',
    scaffold,
    '---',
    '',
    'Produce the finished dispute letter.',
  ].join('\n');
}

/**
 * Defense-in-depth: prepend the disclaimer if the LLM forgot it.
 * Match is whitespace-tolerant on the FIRST occurrence anywhere in
 * the output — a model that put the disclaimer two lines in still
 * satisfies the contract; one that omitted it entirely gets a
 * service-side prepend.
 */
function ensureDisclaimer(letter: string): string {
  if (letter.includes(DISPUTE_LETTER_DISCLAIMER)) {
    return letter;
  }
  return `${DISPUTE_LETTER_DISCLAIMER}\n\n${letter}`;
}
