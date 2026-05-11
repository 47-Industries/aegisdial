-- 048_b3_amex_pattern.sql
--
-- B3 sentinel pattern gap fix from the v3 PR #5 review: Jesiah's
-- card_number_spoken_aloud regex `(?:\d[\s-]?){16}` only matched
-- 16-digit cards. American Express cards are 15 digits, so Mom
-- reading her Amex aloud to a scammer didn't trip the sentinel. ~5%
-- of US cards in circulation are Amex, so the gap is non-trivial.
--
-- This migration adds a sibling pattern with the same context gate
-- but 15-digit matching. Kept separate from the 16-digit pattern so
-- analytics can distinguish which one fired (Amex disclosures are
-- a different victim cohort — high-value cards, often older affluent
-- users — and we want to be able to slice that).

INSERT INTO b3_sentinel_patterns (
  pattern_name,
  regex_source,
  required_scammer_context_regex,
  scammer_context_window_seconds,
  enabled
) VALUES (
  'amex_card_number_spoken_aloud',
  '(?:\d[\s-]?){15}',
  '(card number|credit card|amex|american express|payment method|verify your card|read me the number on)',
  60,
  TRUE
)
ON CONFLICT (pattern_name) DO NOTHING;
