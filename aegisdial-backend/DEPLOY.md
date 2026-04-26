# Deployment — AegisDial Backend

Tech stack: Fly.io (Docker runtime) + Neon (Postgres) + Upstash (Redis). All three have free tiers that cover AegisDial's first few thousand users.

Total cost at that scale: **$0/mo** (Fly's free machine-hours + Neon's free tier + Upstash's free tier). Once you outgrow the free tier, expect ~$5–25/mo for the backend.

You have to do the account setup — paste the outputs back to me and I'll run the Fly deploys.

## 1. Create the Postgres database (Neon — ~2 min)

1. Go to https://console.neon.tech → **Sign up** (use GitHub or Google).
2. Click **Create a project**:
   - Name: `aegisdial`
   - Postgres version: **16** (or latest)
   - Region: pick whichever is closest to your Fly region (`us-west-2` for sjc, `us-east-1` for iad)
3. Once created, Neon shows a connection string:
   ```
   postgresql://<user>:<password>@<host>.neon.tech/<db>?sslmode=require
   ```
   **Copy the full connection string** — paste it back to me.
4. In the Neon dashboard → **Settings → Branching**, enable the default branch as the production branch (it already is).
5. Run the migrations against the new database. I'll do this once you paste the connection string:
   ```bash
   DATABASE_URL='<neon-url>' npm run migrate
   DATABASE_URL='<neon-url>' npm run seed
   ```

## 2. Create the Redis cache (Upstash — ~2 min)

1. Go to https://console.upstash.com/ → **Sign up**.
2. Click **Create Database**:
   - Name: `aegisdial-cache`
   - Type: **Regional** (free tier)
   - Region: closest to your Fly region
   - TLS: **Enabled**
3. On the database page, copy the **Redis connection string** (starts with `rediss://default:...`).
   **Paste it back to me.**

## 3. Create the Fly app (~3 min, requires login)

1. Add flyctl to your shell:
   ```bash
   export FLYCTL_INSTALL="$HOME/.fly"
   export PATH="$FLYCTL_INSTALL/bin:$PATH"
   ```
   Add those two lines to `~/.bashrc` so they persist.
2. Authenticate:
   ```bash
   fly auth login
   ```
   This opens a browser — sign up if you don't have a Fly account yet. Free tier works for initial testing; Fly requires a credit card on file for anti-abuse but you won't be charged while you're below the thresholds.
3. I'll run the rest (`fly launch --no-deploy`, `fly secrets set ...`, `fly deploy`) once you're logged in. Just say "logged in" and paste the connection strings.

## 4. Secrets I'll set on the app

```bash
fly secrets set \
  DATABASE_URL='<neon url>' \
  REDIS_URL='<upstash url>' \
  API_SHARED_SECRET='<random 48 chars>' \
  JWT_SECRET='<random 48 chars>' \
  YOUTUBE_API_KEY='AIzaSyA15QdRMLS2IIlKc2VdH8Nbz5dW6Mz8RqY'
# Optional — set these when App Store Connect / Stripe are wired:
# APPLE_APP_APPLE_ID='<numeric App Apple ID>'
# STRIPE_SECRET_KEY='sk_live_...'
# STRIPE_WEBHOOK_SECRET='whsec_...'
# STRIPE_MONTHLY_PRICE_ID='price_...'
# STRIPE_YEARLY_PRICE_ID='price_...'
```

## 5. Deploy

```bash
fly deploy
```

Once the deploy finishes, the app is reachable at `https://aegisdial-api.fly.dev`. In the iOS app, update `AegisDial/Networking/APIConfig.swift`:

```swift
static let baseURL = URL(string: "https://aegisdial-api.fly.dev")!
```

## 6. (Optional) Custom domain

If you own `aegisdial.com`:
```bash
fly certs add api.aegisdial.com
# Follow the DNS instructions Fly prints — usually 1x A record + 1x AAAA.
```
Then update `APIConfig.baseURL` to `https://api.aegisdial.com`.
