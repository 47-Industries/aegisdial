-- Age gate. App Store guideline 5.1.1(iii) requires COPPA compliance when
-- we collect any PII from users under 13. AegisDial's content rating is
-- "Infrequent/Mild Mature/Suggestive Themes" (fraud examples) so 12+
-- minimum — but functionally we gate at 13+ to stay well clear of COPPA.
--
-- We store just the birth year (not full DOB) because year is enough to
-- enforce the gate and we don't need the extra PII. NULL means the user
-- predates this column (pre-migration accounts) — those are grandfathered.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS dob_year SMALLINT
  CHECK (dob_year IS NULL OR (dob_year BETWEEN 1900 AND 2100));

COMMENT ON COLUMN users.dob_year IS
  'Year of birth. Checked against MIN_AGE (13) at signup. Nullable for pre-migration accounts.';
