-- SMS Shield — cross-pool indexes for the a1HotNumbersPopulator query
-- and the retention sweep DELETE.
--
-- Migration 054 created two user-leading indexes — fine for the per-user
-- "show my scans" path, but useless for two newer global queries that
-- have NO user_id predicate:
--
--   (1) src/workers/a1HotNumbersPopulator.ts —
--       SELECT DISTINCT sender_e164 FROM sms_scans
--        WHERE verdict IN ('fraud','suspicious')
--          AND sender_e164 IS NOT NULL
--          AND scanned_at > NOW() - INTERVAL '30 days'
--
--   (2) src/workers/retentionSweeper.ts —
--       DELETE FROM sms_scans WHERE scanned_at < NOW() - INTERVAL '30 days'
--
-- Without supporting indexes, both queries seq-scan the whole table
-- every run. The populator runs every few minutes; the retention sweep
-- runs daily. Today's table is tiny (just-launched); under load this
-- becomes a slow-query alert.
--
-- Two indexes, both partial to keep them small:
--
-- A. Flagged-only, sender-not-null, sender_e164 included as a covering
--    column so the populator query can be an index-only scan. This is
--    the hot path for cross-pool scammer-graph signal — runs on every
--    populator tick.
--
-- B. scanned_at-leading, no user predicate, used by the retention
--    DELETE. This is a daily cron, not latency-sensitive, but the
--    seq-scan is wasteful on a table this hot.
--
-- Idempotent + additive. Safe against a production DB.

-- A. Cross-pool hot-numbers populator. Partial because we only care
--    about flagged, sender-bearing rows for the scammer graph.
CREATE INDEX IF NOT EXISTS idx_sms_scans_flagged_sender_time
  ON sms_scans (scanned_at DESC, sender_e164)
  WHERE verdict IN ('suspicious', 'fraud') AND sender_e164 IS NOT NULL;

-- B. Retention sweep DELETE. Lightweight time-only index.
CREATE INDEX IF NOT EXISTS idx_sms_scans_scanned_at
  ON sms_scans (scanned_at);

COMMENT ON INDEX idx_sms_scans_flagged_sender_time IS
  'Covers a1HotNumbersPopulator''s flagged-senders-in-window scan. Partial — flagged + sender-bearing rows only.';

COMMENT ON INDEX idx_sms_scans_scanned_at IS
  'Covers retentionSweeper''s daily DELETE WHERE scanned_at < cutoff.';
