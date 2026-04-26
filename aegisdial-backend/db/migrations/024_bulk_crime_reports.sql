-- Bulk crime reports. Aggregated daily when N≥10 distinct users report
-- the same scammer phone + scam type in a 7-day window. Consolidated
-- rows are the data export for IC3 / FTC / state AG partnerships.
--
-- scam_e164 is stored in plaintext here because the point of the table
-- IS that investigators can see the number. Only the PER-USER session
-- row encrypts scam_e164 (that's where it's linked to a user identity).
-- This aggregate has user counts, not user names.

CREATE TABLE IF NOT EXISTS bulk_crime_reports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scam_e164           TEXT NOT NULL,
  scam_type           TEXT NOT NULL,
  distinct_users      INT NOT NULL,
  total_amount_cents  BIGINT NOT NULL DEFAULT 0,
  first_seen_at       TIMESTAMPTZ NOT NULL,
  last_seen_at        TIMESTAMPTZ NOT NULL,
  session_ids         UUID[] NOT NULL,
  window_end_date     DATE NOT NULL,
  submitted_to_ic3_at TIMESTAMPTZ,
  submitted_to_ftc_at TIMESTAMPTZ,
  submitted_to_ag_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scam_e164, scam_type, window_end_date)
);

CREATE INDEX IF NOT EXISTS idx_bulk_crime_reports_number
  ON bulk_crime_reports (scam_e164);
CREATE INDEX IF NOT EXISTS idx_bulk_crime_reports_pending_ic3
  ON bulk_crime_reports (window_end_date DESC) WHERE submitted_to_ic3_at IS NULL;
