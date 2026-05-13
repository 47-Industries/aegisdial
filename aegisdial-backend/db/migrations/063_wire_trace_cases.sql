-- Recovery Shield — P3a: wire / ACH trace case state machine.
--
-- One row per wire-recall case. Recovery Plus users start one of
-- these when they need help recalling a wire or ACH transfer they
-- sent to a scammer. Most US banks will recall within 72h if the
-- victim pushes correctly — but most victims don't know what to
-- push, what language to use, or which fraud-line to call. The
-- wireTraceAgent (P3a) walks the user through it.
--
-- WHY A FIRST-CLASS TABLE (not just a JSON blob on recovery_sessions):
--   - State machine has 7 distinct states with strict transition
--     rules (intake → letter_drafted → user_sent → ...). CHECK
--     constraint on state pins the vocabulary.
--   - Bank-specific knowledge (Chase Reg-E, Wells Fargo SWIFT, BofA
--     email-form) is codified in src/data/wireDisputeTemplates.ts;
--     each case stores which template was generated.
--   - Generated dispute letter is envelope-encrypted ciphertext —
--     contains the user's wire details (amount, destination
--     account hint, send time, bank-relationship narrative).
--   - Bank response captures the recall ack / denial language, also
--     envelope-encrypted (may include account details, balances,
--     internal bank reference numbers — all PII).
--
-- STATE MACHINE:
--   intake             — case opened, user supplying details
--   letter_drafted     — LLM generated the bank-specific dispute
--   user_sent          — user mailed/emailed the letter to bank
--   bank_acknowledged  — bank confirmed receipt, processing recall
--   recalled           — terminal: funds returned
--   denied             — terminal: bank refused recall
--   closed             — terminal: user gave up / unrecoverable
--
-- PRIVACY POSTURE:
--   - destination_account_hint: last-4 if user knows it. Envelope-
--     encrypted because last-4 + bank + amount + timing is enough
--     for a determined adversary to correlate to a specific account.
--   - dispute_letter_text: full letter body, envelope-encrypted.
--     Contains the user's claim narrative — same sensitivity tier
--     as a recovery_evidence row.
--   - bank_response_text: bank's response language, envelope-
--     encrypted. May include internal bank case numbers, sometimes
--     other-party identifying details.
--
-- RETENTION: 365 days from created_at, swept by retentionSweeper.
-- Longer than recovery_sessions default (90d) because wire-recall
-- cases sometimes drag in legal proceedings; the legal_documents
-- packet references this case_id and we don't want a stale FK.
--
-- FK CASCADES: both user and recovery_session cascade. If the user
-- deletes their account or the parent session is purged, the wire
-- case goes with it. Privacy beats audit retention here — the user
-- has the right to be forgotten and the bank already has its own
-- copy of any letter they received.
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS wire_trace_cases (
  id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recovery_session_id       UUID         NOT NULL REFERENCES recovery_sessions(id) ON DELETE CASCADE,
  -- Sending bank as the user identified it. Free-text because the
  -- universe of US/CA/UK banks is large and we don't want to gate a
  -- case on an enum miss. wireDisputeTemplates.ts canonicalizes
  -- ("Chase Bank" / "JP Morgan Chase" / "chase" → 'chase') at
  -- template-lookup time, not at INSERT.
  source_bank               TEXT         NOT NULL,
  -- Last-4 (or last-6 for some intl wires) of the destination
  -- account if the user has it. ENVELOPE-ENCRYPTED — last-4 + bank
  -- + amount + timing correlates to one account. See src/lib/crypto.ts
  -- for the v1:<iv>:<tag>:<ct> format; writer is in wireTraceAgent.ts.
  destination_account_hint  TEXT,
  -- BIGINT cents — wires can legitimately exceed INTEGER max
  -- (~$21M cap at INTEGER cents). Some commercial-bank wires that
  -- got mis-sent to a scammer hit $1M+.
  wire_amount_cents         BIGINT       NOT NULL,
  wire_sent_at              TIMESTAMPTZ  NOT NULL,
  -- State machine. Transition rules enforced in wireTraceAgent.ts;
  -- CHECK only pins the vocabulary so a writer-side bug can't
  -- introduce an unknown state.
  state                     TEXT         NOT NULL CHECK (state IN
    ('intake','letter_drafted','user_sent','bank_acknowledged','recalled','denied','closed')),
  -- Generated dispute letter, envelope-encrypted. Contains the
  -- user's narrative + bank-specific Reg-E / SWIFT language.
  dispute_letter_text       TEXT,
  -- Bank's response captured verbatim, envelope-encrypted. May
  -- contain internal bank case numbers and other-party hints.
  bank_response_text        TEXT,
  -- Updated on every state transition. Drives the "stale case"
  -- admin dashboard ("cases in user_sent for >7 days — nudge the
  -- user").
  state_changed_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Hot path: "show me my wire-trace cases" for the iOS dashboard.
CREATE INDEX IF NOT EXISTS idx_wire_trace_user
  ON wire_trace_cases (user_id, created_at DESC);

-- Recovery session drill-down: "show all sub-cases under this
-- session" for the recovery-session detail screen.
CREATE INDEX IF NOT EXISTS idx_wire_trace_session
  ON wire_trace_cases (recovery_session_id);

COMMENT ON TABLE wire_trace_cases IS
  'Recovery Shield — wire/ACH recall case state machine. Multi-turn LLM agent (wireTraceAgent.ts) walks the user through bank-specific dispute language. dispute_letter_text / bank_response_text are envelope-encrypted PII.';

COMMENT ON COLUMN wire_trace_cases.destination_account_hint IS
  'Last-4 (or last-6 for intl) of the destination account. Envelope-encrypted because last-4 + bank + amount + timing correlates to one account.';

COMMENT ON COLUMN wire_trace_cases.dispute_letter_text IS
  'Generated bank-specific dispute letter. Envelope-encrypted (v1:<iv>:<tag>:<ct>). Contains the user''s narrative — same sensitivity tier as a recovery_evidence row.';

COMMENT ON COLUMN wire_trace_cases.bank_response_text IS
  'Bank''s response verbatim. Envelope-encrypted. May include internal bank case numbers + other-party identifying details.';

COMMENT ON COLUMN wire_trace_cases.state IS
  'State machine: intake → letter_drafted → user_sent → bank_acknowledged → (recalled|denied|closed). Transition rules enforced in wireTraceAgent.ts; CHECK only pins the vocabulary.';
