-- 054_pricing_update.sql
--
-- Pricing tier update per the founder's spec, effective 2026-05-12.
-- Single source of truth for `plan_prices` (the SQL mirror of
-- src/lib/plans.ts the founder dashboard uses to compute MRR in pure
-- SQL).
--
-- Changes:
--   Pro Yearly        29900¢ → 39900¢/yr  (3325¢/mo equivalent)
--   Recovery Session   9900¢ → 14900¢ one-time (single-month equiv)
--   + Recovery Concierge Monthly   9900¢/mo  (NEW)
--   + Recovery Concierge Yearly   89900¢/yr  (7492¢/mo equiv)
--
-- Family+ stays in the table at 6999¢/mo so existing subscribers still
-- contribute to MRR — it's just no longer offered to new buyers
-- (see src/lib/plans.ts `deprecated: true` on that SKU).
--
-- monthly_price_cents normalises annual SKUs to their monthly
-- equivalent so SUM(monthly_price_cents) over active subs == MRR cents.
-- Rounding is integer-truncation; ~$1/yr drift is acceptable.

INSERT INTO plan_prices (product_id, monthly_price_cents) VALUES
  ('com.aegiadial.ios.pro.monthly',              4999),
  ('com.aegiadial.ios.pro.yearly',               3325),  -- 39900 / 12
  ('com.aegiadial.ios.pro.family_plus.monthly',  6999),  -- deprecated but still resolves
  ('com.aegiadial.ios.recovery.session',        14900),  -- one-time, count once
  ('com.aegiadial.ios.recovery.monthly',         9900),
  ('com.aegiadial.ios.recovery.yearly',          7492)   -- 89900 / 12
ON CONFLICT (product_id) DO UPDATE
  SET monthly_price_cents = EXCLUDED.monthly_price_cents;
