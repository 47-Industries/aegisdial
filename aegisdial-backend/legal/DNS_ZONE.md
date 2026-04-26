# Cloudflare DNS zone for aegisdial.com

After registering aegisdial.com at Cloudflare Registrar (DEPLOY_PLAYBOOK.md step 3), paste these records into **DNS → Records**. Cloudflare defaults are fine (proxy ON for web hosts, OFF for apex+api — see Proxy column).

## Web (hosting the 3 legal pages)

Easiest MVP host: **Cloudflare Pages** — free, deploys on push. One-command setup below.

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `@` | `aegisdial-web.pages.dev` | ✓ on |
| CNAME | `www` | `aegisdial-web.pages.dev` | ✓ on |

Serves https://aegisdial.com/privacy, /terms, /support from the HTML files in this directory.

### One-command Pages deploy

```bash
cd ~/aegisdial-backend/legal
# Install wrangler if you haven't
npm install -g wrangler

# Login (opens Brave)
wrangler login

# Create the project
wrangler pages project create aegisdial-web --production-branch main

# Deploy
wrangler pages deploy . --project-name aegisdial-web
```

## API

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `api` | `aegisdial-api.fly.dev` | OFF (Fly handles TLS) |

Once the CNAME propagates:
```bash
fly certs add api.aegisdial.com --app aegisdial-api
```
Fly auto-provisions a LetsEncrypt cert.

Then in `~/aegisdial-ios/AegisDial/Networking/APIConfig.swift` flip the release baseURL to `https://api.aegisdial.com`.

## Resend (transactional email)

Resend will give you 3–4 TXT records when you add the domain. Drop them in as-is with the values Resend shows:

| Type | Name | Content (example — use Resend's values) |
|---|---|---|
| TXT | `send.aegisdial.com` | `v=spf1 include:amazonses.com ~all` |
| TXT | `resend._domainkey.aegisdial.com` | `p=MIGfMA0GCSqGSIb3DQEBAQ...` (long) |
| MX  | `send.aegisdial.com` | `feedback-smtp.us-east-1.amazonses.com` (priority 10) |
| TXT | `_dmarc.aegisdial.com` | `v=DMARC1; p=none;` |

Then back in Resend dashboard: **Verify domain**. Takes 5–15 min.

## MX for receiving email (optional but recommended)

If you want `support@aegisdial.com` and `privacy@aegisdial.com` to actually receive email, use Cloudflare Email Routing (free):

1. Cloudflare dashboard → Email → Email Routing → Get started.
2. Routes:
   - `support@aegisdial.com` → `aegisdial@outlook.com`
   - `privacy@aegisdial.com` → `aegisdial@outlook.com`
   - `alerts@aegisdial.com` → discard (Resend only sends FROM this)

Cloudflare auto-adds its own MX records.
