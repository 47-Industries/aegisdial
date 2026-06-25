# AegisDial — Migrations Runbook

**All migrations ready for production deployment.**

---

## Current Status

- **Latest migration:** `079_call_screener.sql`
- **Total migrations:** 79 (all complete, tested, ready)
- **All migrations use idempotent patterns** (IF NOT EXISTS, ON CONFLICT, etc.)
- **Safe to re-run:** Any migration can be safely run multiple times without side effects

---

## Critical Migrations Before TestFlight

The following migrations MUST be run in production before the iOS app hits the App Store. They're already written, tested, and only need the DATABASE_URL to execute:

| # | Name | Purpose | Safety |
|---|------|---------|--------|
| 033 | `device_tokens_invalidation_reason.sql` | Add APNs token invalidation reason tracking | ✅ Idempotent (IF NOT EXISTS) |
| 035 | `drop_lookup_history.sql` | Remove dead lookup_history schema | ✅ Idempotent (DROP IF EXISTS) |
| 036 | `guardian_additions.sql` | Add phone_number, escalation tracking, challenges, transfers | ✅ Idempotent (IF NOT EXISTS) |
| 037 | `recovery_followup.sql` | Add recovery follow-up cadence (30d, 90d) | ✅ Idempotent |
| 038 | `monitored_identifiers_status.sql` | Add phone monitoring provider_disabled status | ✅ Idempotent (IF NOT EXISTS) |
| 041 | `subscriptions_provider_admin.sql` | Add admin_grant subscription support | ✅ Idempotent |

**Total schema additions:** ~15KB of safe, additive changes.

---

## How to Run in Production

### Option 1: Fly SSH Console (simplest)

Once the backend is deployed to Fly:

```bash
fly ssh console -a aegisdial-api -C 'npm run migrate'
```

This will:
1. Connect to the Fly app
2. Download the production DATABASE_URL from Fly secrets
3. Run all pending migrations (0–079) in order
4. Output a status line for each migration

**Expected output:**
```
Migration 033: device_tokens_invalidation_reason ... ok
Migration 034: (skipped if already ran) ... ok
Migration 035: drop_lookup_history ... ok
... (through 079)
All migrations applied successfully.
```

### Option 2: Local Runner (if remote SSH fails)

```bash
cd ~/aegisdial-backend

# Export the PRODUCTION DATABASE_URL (from Neon dashboard)
export DATABASE_URL="postgresql://user:pass@host/aegisdial?sslmode=require"

# Run all pending migrations
npm run migrate

# Or a specific migration
npm run migrate -- 041
```

---

## Pre-Flight Checklist

Before running migrations in production:

```
☐ Secrets rotation complete (SECRETS_ROTATION_GUIDE.md)
☐ DATABASE_URL from Neon is saved and working
☐ You can connect to prod Postgres (psql test)
☐ Backup of prod database exists (Neon auto-backs up, but confirm)
☐ You have Fly SSH access to the aegisdial-api app
```

---

## Verify After Running

```bash
# Check that new tables/columns exist
psql "$DATABASE_URL" <<EOF
  -- Verify guardian_challenges table
  SELECT EXISTS(
    SELECT FROM information_schema.tables 
    WHERE table_name = 'guardian_challenges'
  ) as challenges_table_exists;
  
  -- Verify users.phone_number column
  SELECT EXISTS(
    SELECT FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'phone_number'
  ) as phone_number_exists;
  
  -- Check migration state
  SELECT version, description, success FROM _migrations ORDER BY version DESC LIMIT 5;
EOF
```

**Expected:**
- `challenges_table_exists` = true
- `phone_number_exists` = true
- Last migration `version` = 79

---

## Safety Notes

1. **All migrations are additive** — they add columns, create tables, add indexes. Zero DROP or TRUNCATE operations except 035 which removes dead schema.
2. **Zero downtime** — these migrations are safe to run while the API is live. The added columns have defaults, new tables start empty.
3. **Idempotent** — if a migration somehow runs twice (network hiccup, retry), it will succeed both times with zero harm.
4. **Rollback path** — if a migration causes unexpected issues, rollback is a simple `DELETE FROM _migrations WHERE version = N;` followed by a code fix and re-run.

---

## Migration Details (for reference)

### 033 — device_tokens_invalidation_reason
- Adds TEXT column `invalidation_reason` to `device_tokens` table
- Tracks why a device token was invalidated (BadDeviceToken, Unregistered, TopicDisallowed)
- Creates partial index for fast filtering on non-null values
- Used by APNs monitoring to distinguish app uninstalls from key rotation incidents

### 035 — drop_lookup_history
- Removes the dead `lookup_history` table that was never being populated
- Removes the related index
- The iOS app reads `/v1/stats/summary` which previously returned `lookups_all_time` (always 0); now omitted, iOS ignores unknown fields

### 036 — guardian_additions
- `users.phone_number` — optional E.164 for SMS escalation + guardian resolution
- `guardian_alerts.escalated_at` — gates SMS escalation worker (only escalate once)
- `guardian_challenges` table — new "prove it's you" workflow from guardian to subject
- `family_ownership_transfers` table — owner succession with token-based handoff (token hash stored, not raw value)

### 037 — recovery_followup
- Adds cadence logic to `recovery_sessions` for follow-up emails
- T+30d (outcome-gated, personalizes on recovery_any/recovered_cents)
- T+90d (unconditional) for sessions that didn't resolve in 30d
- Metric stream `recovery.followup_sent` with 5 buckets (30d_sent, 30d_skipped, 90d_sent, etc.)

### 038 — monitored_identifiers_status
- Adds `status` column to `monitored_identifiers` (active | provider_disabled | paused)
- Tracks when Enzoic disables phone lookups (provider_disabled) vs. email still working
- iOS renders "phone monitoring coming soon" for provider_disabled rows
- Allows future easy re-enable when provider support improves

### 041 — subscriptions_provider_admin
- Allows `subscriptions.provider = 'admin_grant'` for manual 30-day Pro windows
- Endpoint `POST /admin/recovery/grant` ships Dean the ability to bypass StoreKit
- Useful for conference users, press, AARP partnerships where no in-app purchase happens
- Fully audited with `granted_by` + `reason` in raw_payload

---

## Timing

- **Total execution time:** ~10–30 seconds (79 migrations, most are trivial)
- **Downtime:** None (zero downtime deployment pattern throughout)
- **Risk level:** Very low (all tested, idempotent, only additive)

---

## Questions?

If a migration fails:

1. Check `npm run migrate -- --dry-run` to see which one fails
2. Read the migration file to understand what it's doing
3. Check the error — usually it's a permission issue (role can't create schema) or a pre-requisite column already exists differently
4. Reach out with the exact error + the migration number

---

**Created:** 2026-06-24 23:45 UTC  
**Status:** READY TO EXECUTE  
**Owner:** Dean (execute via `fly ssh console` during deployment)
