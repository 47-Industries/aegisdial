-- Live Shield v3 — B3 takeover hardening + sentinel pattern seed.
--
-- Builds on migration 046. Two additive changes:
--
--   1. New column on call_sessions for B3 post-dismiss family-alert
--      idempotency. v2's existing family_alert_fired_at column is the
--      lock for the FIRST family alert (fired when score crosses
--      critical). The post-dismiss escalation needs its own lock so
--      it can fire even when the first one already did.
--
--   2. Initial seed for b3_sentinel_patterns. These are the regex
--      patterns the Mom-side sentinel matcher evaluates on each
--      transcript chunk. The required_scammer_context_regex column
--      is the 60-second rolling-window gate that prevents firing
--      when Mom is just reading off a tracking number in benign
--      context.
--
-- All seeds are idempotent — INSERT ... ON CONFLICT (pattern_name)
-- DO NOTHING — so this migration is safe to re-run.

-- =========================================================================
-- B3 post-dismiss family-alert idempotency lock
-- =========================================================================

ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS family_alert_post_dismiss_fired_at TIMESTAMPTZ;

-- =========================================================================
-- Initial sentinel pattern seed
-- =========================================================================
--
-- Pattern naming convention: `<intent>__<source>` (double underscore).
-- Pattern severity is implicit — anything here that fires triggers a
-- B3 takeover. Tuning happens via the `enabled` flag, not by adding
-- per-pattern severity weights.
--
-- Each pattern's required_scammer_context_regex is what makes the
-- match meaningful. "9 consecutive digits" alone has too many false
-- positives (Mom dictating an address, reading a tracking number,
-- etc.). Gating on prior scammer-side mention of "social security",
-- "ssn", "tax id", or "verify your identity" filters those out
-- while preserving the intended detection.

INSERT INTO b3_sentinel_patterns
  (pattern_name, regex_source, required_scammer_context_regex, scammer_context_window_seconds, enabled)
VALUES

  -- Mom about to read out her SSN. The 9-consecutive-digits pattern
  -- (with optional spacing) is what we listen for, gated on the
  -- scammer having recently asked for her social.
  (
    'ssn_spoken_aloud',
    '(?:\\d[\\s-]?){9}',
    '(social security|s\\.s\\.n|ssn|tax id|verify your identity|read me your social)',
    60,
    TRUE
  ),

  -- Mom about to read out a credit-card number. 16-digit pattern
  -- gated on prior payment-related context from the scammer.
  (
    'card_number_spoken_aloud',
    '(?:\\d[\\s-]?){16}',
    '(card number|credit card|debit card|payment method|verify your card|read me the number on)',
    60,
    TRUE
  ),

  -- Explicit voluntary disclosure phrases. No scammer-context gate
  -- because saying "my card number is" is unambiguously dangerous
  -- regardless of what the scammer was doing.
  (
    'voluntary_card_phrase',
    '(my card number is|the card number is|here''s my card)',
    NULL,
    0,
    TRUE
  ),

  -- MFA code: any 6-digit run within 20 seconds of the scammer
  -- mentioning "verification code", "security code", or "auth code".
  -- Window deliberately tightened to 20s — anything older and the
  -- digits are likely unrelated.
  (
    'mfa_code_spoken_aloud',
    '\\b\\d{6}\\b',
    '(verification code|security code|auth code|authorization code|the code we sent)',
    20,
    TRUE
  ),

  -- Password disclosure. Strong pattern with no gate.
  (
    'voluntary_password_phrase',
    '(my password is|the password is|my login is|account password)',
    NULL,
    0,
    TRUE
  ),

  -- Routing/account number disclosure. Voluntary phrase + gate.
  (
    'voluntary_routing_account',
    '(my routing number is|my account number is|here''s my routing)',
    NULL,
    0,
    TRUE
  ),

  -- Affirming a payment authorization that the scammer is pressuring.
  -- Gated on payment-related context to avoid firing when "I authorize"
  -- means something benign.
  (
    'affirms_payment_authorization',
    '(yes,? I authorize|yes,? I confirm|yes,? go ahead|i agree to (the )?(charge|payment|transfer))',
    '(payment|charge|transfer|pay this|pay them|wire|bitcoin|gift card|wire transfer)',
    30,
    TRUE
  )

ON CONFLICT (pattern_name) DO NOTHING;
