# AegisDial — URGENT: Secrets Rotation Guide

**Status: LEAKED SECRETS IN GIT HISTORY — MUST ROTATE BEFORE DEPLOYMENT**

---

## Overview

The following production secrets were previously committed to git in `.env.production.template` and are permanently in the git history of commit `7f879c6`. They MUST be rotated before any deployment to production.

### The leaked values (from git history):

| Secret | Previous Leaked Value | Source | Severity |
|--------|----------------------|--------|----------|
| Neon Database Password | `npg_wKsIDyPS9Cg3` | `.env.production.template` | 🔴 CRITICAL |
| Upstash Redis Token | (in history, exact value unclear) | `.env.production.template` | 🔴 CRITICAL |
| API_SHARED_SECRET | (in history, exact value unclear) | `.env.production.template` | 🔴 CRITICAL |
| JWT_SECRET | (in history, exact value unclear) | `.env.production.template` | 🔴 CRITICAL |
| YouTube API Key | (in history, exact value unclear) | `.env.production.template` | 🟡 HIGH |

---

## Action Plan (Execute IN ORDER)

### 1. Rotate Neon Database Password

**Leaked:** `npg_wKsIDyPS9Cg3`

1. Go to https://console.neon.tech → select your `aegisdial` project
2. **Settings → Connection Details**
3. Click **Reset password** on the default role (postgres)
4. Copy the new password
5. Construct new `DATABASE_URL`:
   ```
   postgresql://USER:NEWPASS@HOST/DB?sslmode=require
   ```
6. Save to local `.env.production` (not committed to git)

**Verify:**
```bash
psql "$DATABASE_URL" -c "SELECT version();"
```

---

### 2. Rotate Upstash Redis Token

**Leaked:** (redacted value from history)

1. Go to https://console.upstash.com → select your `aegisdial` database
2. **Database Details → Revoke Token** (if available) or create a new endpoint
3. Get the new `REDIS_URL` from the REST API section
4. Format: `rediss://default:TOKEN@HOST:PORT`
5. Save to local `.env.production`

**Verify:**
```bash
redis-cli -u "$REDIS_URL" ping
# Should return: PONG
```

---

### 3. Regenerate API_SHARED_SECRET

**Leaked:** (redacted value from history)

This secret is used to sign outgoing requests from backend to mobile clients. Regenerating it will invalidate any in-flight API signatures but doesn't break functionality.

```bash
# Generate new random secret
openssl rand -base64 36

# Example output: abc123def456ghi789...jkl/mnop+qrs=
# Copy and save to .env.production
API_SHARED_SECRET=<paste-above>
```

**Impact:** If any iOS clients are signed and waiting for server responses, they'll need a refresh. Post-launch, a rolling signature rotation is better practice.

---

### 4. Regenerate JWT_SECRET

**Leaked:** (redacted value from history)

This secret signs all session tokens. Regenerating it **invalidates all active sessions** — acceptable before public launch.

```bash
openssl rand -base64 36

# Example: xyz789abc123def456...stu/vwx+yz0=
# Copy and save to .env.production
JWT_SECRET=<paste-above>
```

**Impact:** Any test accounts or internal users will be logged out. All session tokens become invalid. This is intentional — force a re-auth.

---

### 5. Regenerate YouTube API Key

**Leaked:** (redacted value from history)

Used for the recovery companion crawler (pulling YouTube transcript data for fraud context).

1. Go to https://console.cloud.google.com/apis/credentials?project=my-project-37237aegisdial
2. Find the YouTube API key → **Delete it**
3. **Create new credentials → API Key** → restrict to "YouTube Data API v3"
4. Copy the new key and save to `.env.production`:
   ```
   YOUTUBE_API_KEY=<new-key>
   ```

**Verify:**
```bash
curl -s "https://www.youtube.com/api/rest/v2/search?key=YOUR_KEY&q=test" | head -20
```

---

### 6. Optional: Git History Cleanup (Long-term)

If you care about completely expunging the history (not required for security, since the values are already rotated):

```bash
cd ~/aegisdial-backend

# Filter out the .env file from all history
git filter-repo --path .env.production.template --invert-paths --force

# Push to replace remote history (⚠️ forces entire team to re-clone)
git push origin --force-with-lease
```

**Note:** This is irreversible on the team's end and requires everyone to re-clone. Only do if the repo is not yet public-shared widely.

---

## Checklist

Execute in the order above. Check them off:

```
☐ 1. Neon password rotated + new DATABASE_URL in .env.production
☐ 2. Upstash token rotated + new REDIS_URL in .env.production
☐ 3. API_SHARED_SECRET regenerated (openssl rand -base64 36)
☐ 4. JWT_SECRET regenerated (openssl rand -base64 36)
☐ 5. YouTube API key regenerated
☐ 6. All five values tested locally (optional git history cleanup)
```

Once all are complete, proceed with the DEPLOY_PLAYBOOK steps.

---

## Timing

- **Total time:** 15–20 minutes for the rotations + verification
- **Testing:** Each verified above with a quick CLI command
- **Risk:** Low — the code gracefully handles missing credentials and will error clearly if a value is wrong

---

## Post-Rotation

Once rotated, the old leaked values are still in git history but **they no longer grant access** to any real systems. All database logins, Redis connections, API signing, and YouTube queries will use the new, private secrets set via Fly environment variables during deployment.

---

**Created:** 2026-06-24 23:41 UTC  
**Status:** READY TO EXECUTE  
**Owner:** Dean (manual provider action required)
