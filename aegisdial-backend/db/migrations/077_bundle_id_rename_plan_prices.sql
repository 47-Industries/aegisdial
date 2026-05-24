-- 077_bundle_id_rename_plan_prices.sql
--
-- The Xcode bundle ID shipped with a typo (com.aegiadial.ios) from day
-- one, and that typo propagated into the App Store IAP product IDs in
-- migrations 042 + 054. The Flutter app + backend constants have now
-- been renamed to com.aegisdial.app — see commit 794a5f0.
--
-- This migration inserts the new product IDs at the same prices and
-- leaves the old typo'd rows in place so any legacy subscription rows
-- still resolve. Once we've confirmed no active subscriptions point at
-- the old IDs, a future migration can DELETE the old rows.

INSERT INTO plan_prices (product_id, monthly_price_cents) VALUES
  ('com.aegisdial.app.pro.monthly',              4999),
  ('com.aegisdial.app.pro.yearly',               3325),  -- 39900 / 12
  ('com.aegisdial.app.pro.family_plus.monthly',  6999),  -- deprecated but still resolves
  ('com.aegisdial.app.recovery.session',        14900),  -- one-time, count once
  ('com.aegisdial.app.recovery.monthly',         9900),
  ('com.aegisdial.app.recovery.yearly',          7492)   -- 89900 / 12
ON CONFLICT (product_id) DO UPDATE
  SET monthly_price_cents = EXCLUDED.monthly_price_cents;
