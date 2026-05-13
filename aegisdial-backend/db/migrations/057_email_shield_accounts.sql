-- Email Shield — Pillar 1 foundation: linked-account registry.
--
-- One row per (user, email_account). A single user can link multiple
-- inboxes (work Gmail + personal Outlook + family iCloud) and the
-- scoring engine treats each independently.
--
-- THREE PROVIDERS, ONE TABLE:
--   'gmail'      — Google API via OAuth (history-id polling, optional
--                  push subscription via Pub/Sub in a later phase)
--   'microsoft'  — Microsoft Graph via OAuth (delta queries, optional
--                  push subscription via webhook)
--   'imap'       — generic IMAP fallback for iCloud, Proton, Yahoo,
--                  FastMail, custom domains. Polling-only (IDLE where
--                  the server supports it). May use OAuth where
--                  available; otherwise app-password (envelope
--                  encrypted at rest).
--
-- The scoring engine sees a normalized IncomingMessage regardless
-- of backend (see src/services/email/types.ts in phase P2).
--
-- PRIVACY POSTURE:
--   - oauth_token_ct / oauth_refresh_token_ct: envelope-encrypted
--     ciphertext (same crypto.ts helpers used for recovery_*_ct
--     columns). Plaintext NEVER persisted.
--   - app_password_ct: same encryption posture; only populated for
--     IMAP backends without OAuth. App passwords are
--     plaintext-equivalent on the wire, so document loudly in iOS
--     UI that the user is granting equivalent-to-full-access.
--   - Minimum scope: gmail.readonly, not gmail.modify. We classify;
--     we never delete or modify mail. The iOS app can open Gmail/
--     Outlook deep-links if the user wants to act.
--
-- Idempotent + additive.

CREATE TABLE IF NOT EXISTS email_accounts (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                 TEXT         NOT NULL CHECK (provider IN ('gmail', 'microsoft', 'imap')),
  -- Stable provider-side identity. For Gmail this is the Google `sub`;
  -- for Microsoft, the Graph `oid`; for IMAP, the username. Lets us
  -- detect when a user re-links the same inbox vs adds a new one.
  provider_account_id      TEXT         NOT NULL,
  -- Display-only. The user's email address as shown in iOS UI. Useful
  -- when a user has linked multiple inboxes and the list view needs
  -- to render which is which. Never used for matching / lookups.
  display_email            TEXT         NOT NULL,
  -- OAuth state. token_ct is the access token; refresh_token_ct is
  -- the refresh token (nullable — some IMAP backends don't have one).
  --
  -- CHECK on the ciphertext format prefix ('v1:...') is a
  -- defense-in-depth measure against a writer-side regression that
  -- forgets envelope encryption. src/lib/crypto.ts documents the
  -- format as v1:<iv_b64>:<tag_b64>:<ct_b64> and never changes it
  -- without a migration. Comment-only enforcement is the codebase
  -- precedent (see migrations 018, 022, 023); we deliberately break
  -- it here because OAuth tokens are higher-stakes than recovery
  -- session text — a leaked token gives persistent inbox read.
  oauth_token_ct           TEXT
    CHECK (oauth_token_ct IS NULL OR oauth_token_ct LIKE 'v1:%'),
  oauth_refresh_token_ct   TEXT
    CHECK (oauth_refresh_token_ct IS NULL OR oauth_refresh_token_ct LIKE 'v1:%'),
  oauth_expires_at         TIMESTAMPTZ,
  -- IMAP backend fields. Only populated when provider = 'imap'.
  imap_host                TEXT,
  imap_port                INTEGER,
  imap_username            TEXT,
  app_password_ct          TEXT
    CHECK (app_password_ct IS NULL OR app_password_ct LIKE 'v1:%'),
  -- Status. Drives whether the polling worker hits this account.
  --   'active'       — credentials good, polling runs
  --   'auth_failed'  — most recent poll got 401/403; iOS prompted to re-link
  --   'revoked'      — user revoked on provider's side; we surface and stop
  --   'paused'       — user toggled scanning off in iOS settings
  status                   TEXT         NOT NULL CHECK (status IN ('active', 'auth_failed', 'revoked', 'paused')) DEFAULT 'active',
  -- Last successful poll. Used by the worker to decide if a polling
  -- gap is large enough to need a backfill vs incremental fetch.
  last_poll_at             TIMESTAMPTZ,
  -- Provider-specific incremental cursor. For Gmail this is the
  -- historyId; for Graph, the delta token; for IMAP,
  -- UIDVALIDITY:UIDNEXT. Storing TEXT keeps the column provider-
  -- agnostic at the schema layer.
  last_history_cursor      TEXT,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- A single user shouldn't be able to double-link the same inbox.
  -- Composite uniq prevents both accidental duplicates from a
  -- re-link race and intentional double-linking via two OAuth flows.
  UNIQUE (user_id, provider, provider_account_id),
  -- Provider-pairing invariant (adversarial-review M5):
  --   - gmail / microsoft rows MUST have oauth_token_ct populated,
  --     and MUST NOT have imap_host (they don't use IMAP).
  --   - imap rows MUST have imap_host + imap_port AND at least one
  --     credential (oauth where the provider supports it, or
  --     app_password as fallback).
  -- Without this, a writer that confused the column set could land
  -- a half-configured row that polls forever and never succeeds.
  CHECK (
    (provider IN ('gmail', 'microsoft')
       AND oauth_token_ct IS NOT NULL
       AND imap_host IS NULL)
    OR (provider = 'imap'
       AND imap_host IS NOT NULL
       AND imap_port IS NOT NULL
       AND (oauth_token_ct IS NOT NULL OR app_password_ct IS NOT NULL))
  )
);

-- Hot path: polling worker iterates active accounts ordered by
-- last_poll_at to even out load. Partial index keeps the scan small —
-- revoked/paused accounts don't need to be visited.
CREATE INDEX IF NOT EXISTS idx_email_accounts_active_poll
  ON email_accounts (last_poll_at NULLS FIRST)
  WHERE status = 'active';

-- Per-user lookup for /v1/email/accounts list view.
CREATE INDEX IF NOT EXISTS idx_email_accounts_user
  ON email_accounts (user_id, created_at DESC);

COMMENT ON TABLE email_accounts IS
  'Email Shield — linked-inbox registry. One row per (user, provider, provider_account_id). OAuth tokens / app passwords stored as envelope ciphertext only. Provider-agnostic incremental cursor in last_history_cursor.';

COMMENT ON COLUMN email_accounts.oauth_token_ct IS
  'Envelope-encrypted OAuth access token. Plaintext never persisted.';

COMMENT ON COLUMN email_accounts.app_password_ct IS
  'Envelope-encrypted IMAP app password. Only populated for provider=imap when OAuth is unavailable. Documented in iOS UI as full-access.';

COMMENT ON COLUMN email_accounts.last_history_cursor IS
  'Provider-agnostic incremental cursor. Gmail: historyId. MS Graph: delta token. IMAP: UIDVALIDITY:UIDNEXT.';
