# AegisDial — Phase 2 Action Plan (Post-Launch)

**Execution Timeline:** 30 days post-TestFlight launch  
**Status:** Ready to execute when Phase 1 is live

---

## Overview

Phase 2 consists of 12 product improvements. Of these:
- **5 are fully unblocked** and ready to code immediately after launch
- **2 are blocked** on third-party API keys (Ekata, IPQualityScore)
- **3 are business/GTM focused** (outside technical scope)
- **2 are iOS-only** (requires concurrent mobile team work)

---

## Unblocked Work (Can Ship Immediately Post-Launch)

### 1. Verdict Cache Single-Flight Lock (Task #102)

**Purpose:** Prevent thundering-herd problem when 1000s of users look up the same popular scam number simultaneously.

**Current state:** 
- Verdict lookups hit the cached result or fire a fresh crawl
- Multiple concurrent requests all trigger fresh crawls (inefficient, expensive)

**Solution:**
- Use Redis SETNX to acquire a "lookup in progress" lock
- First caller acquires lock, fires crawl, stores result, releases lock
- Other concurrent callers wait (or poll) for the lock to release, then read the cached result
- TTL: 30–60 seconds (crawl completes within that window; if not, lock expires and retry)

**Estimated effort:** 2–3 hours  
**Files to modify:**
- `src/services/verdictCache.ts` (new `acquireLookupLock`, `releaseLookupLock` functions)
- `src/routes/lookup.ts` (wrap the crawl call in the lock)
- Add Redis key pattern docs

**Code skeleton:**
```typescript
// Before crawl
const lockKey = `lookup_lock:${e164}`;
const lockAcquired = await redis.set(lockKey, '1', 'EX', 60, 'NX');

if (!lockAcquired) {
  // Another request is already crawling; poll for completion
  let retries = 0;
  while (retries < 12) { // 1.2s total wait
    await sleep(100);
    const cached = await verdictCache.get(e164);
    if (cached) return cached;
    retries++;
  }
  // Fallback: return stale or null
}

// Crawl + store
const result = await crawlAndCache(e164);
```

**Testing:** Load test with 100 concurrent requests for the same number; verify only 1 crawl fires.

---

### 2. Burner/Virtual/Overseas Number Detection (Task #101)

**Purpose:** Flag VoIP and burner numbers (Google Voice, TextNow, Hushed, etc.) with "this number is X minutes/days old" signal from our own call-first-seen database.

**Current state:**
- Verdict shows caller name + risk score
- No VoIP detection; burners appear as regular numbers

**Solution:**
- Maintain a curated list of known VoIP provider prefixes (by region)
- For each lookup, check if the number's prefix matches a known VoIP pattern
- Cross-reference with `call_events.first_seen` to show "this number called you for the first time on June 15, 2026"
- Surface on the iOS verdict card as a new badge: 🔵 "This is a VoIP number, first seen June 15"

**Data source:**
- VoIP patterns by country (US: 503, 510, 628, 650, 669 for Google Voice; 308-312 for TextNow, etc.)
- Public VoIP registries (FCC database, carrier lookups)
- Our own `call_events` table (when was this number first heard?)

**Estimated effort:** 4–5 hours  
**Files to modify:**
- `src/lib/voipDetection.ts` (new, VoIP pattern DB + lookup function)
- `src/services/verdictCache.ts` (add voip_flag + first_seen_at to Verdict response)
- `src/routes/lookup.ts` (populate voip fields)
- `db/migrations/080_verdicts_voip_flag.sql` (add voip_flag column to cached verdicts if needed)

**Code skeleton:**
```typescript
// voipDetection.ts
const VOIP_PATTERNS = {
  'US': {
    'Google Voice': /^(503|510|628|650|669)/,
    'TextNow': /^(308|309|310|311|312)/,
    'Hushed': /^(551|552|553)/,
    // ... more patterns
  },
  'CA': { /* ... */ },
};

export function detectVoip(e164: string): { isVoip: boolean; provider?: string } {
  // Extract country code, look up patterns
  const match = e164.match(/^\+?(\d{1,3})/);
  const country = matchCountryFromCode(match[1]);
  const patterns = VOIP_PATTERNS[country];
  for (const [provider, regex] of Object.entries(patterns)) {
    if (regex.test(e164)) return { isVoip: true, provider };
  }
  return { isVoip: false };
}
```

**Testing:** Verify known VoIP numbers (Google Voice test numbers) are flagged; verify regular PSTN numbers are not.

---

### 3. Crawl Pre-Warming Worker (Task #98)

**Purpose:** Hourly scheduled job that pre-warms the verdict cache by crawling the top 100–200 recently-reported scam numbers.

**Current state:**
- Verdicts are cached after first lookup
- Popular numbers have cold-start latency on their first user hit

**Solution:**
- Hourly Fastify Cron job (or Fly background worker if we move off Fastify)
- Query `call_events` for the top 200 distinct e164s from the last 24 hours (high-volume inbound calls)
- Fire crawls for each (may be cached already, that's fine)
- Update Redis cache, update Postgres verdict table
- Log completion time + count

**Estimated effort:** 2–3 hours  
**Files to modify:**
- `src/workers/crawlPreWarmingWorker.ts` (new)
- `src/server.ts` (register cron job on startup)
- `src/lib/observability.ts` (add metric worker.crawl_prewarming.completed)

**Code skeleton:**
```typescript
// crawlPreWarmingWorker.ts
export async function runCrawlPreWarmingWorker() {
  const topNumbers = await db.callEvent.groupBy({
    by: ['caller_e164'],
    where: { created_at: { gte: new Date(Date.now() - 86400000) } },
    orderBy: { _count: { id: 'desc' } },
    take: 200,
  });

  let warmCount = 0;
  for (const { caller_e164 } of topNumbers) {
    const cached = await verdictCache.get(caller_e164);
    if (!cached) {
      await crawlAndCache(caller_e164);
      warmCount++;
    }
  }

  captureMetric('worker.crawl_prewarming.completed', { count: warmCount });
}

// On server startup
setInterval(() => runCrawlPreWarmingWorker(), 3600000); // hourly
```

**Testing:** Run once, verify that the top numbers are crawled and cached; check Postgres verdict table + Redis for updates.

---

### 4. Drop Legacy Plaintext Columns (Task #104)

**Purpose:** Final cleanup after encryption migration is stable in production (migrations 031–032).

**Current state:**
- Encrypted data is now dual-written (plaintext + ciphertext)
- All code paths read from ciphertext (plaintext is ignored)
- Ready to drop plaintext columns for GDPR + security

**Affected columns:**
- `family_contacts.display_name` (plaintext, `display_name_ct` is ciphertext)
- `family_contacts.notes` (plaintext, `notes_ct` is ciphertext)
- `support_tickets.email` (plaintext, `email_ct` is ciphertext)

**Solution:**
- `082_drop_plaintext_columns.sql` migration
- Removes plaintext columns, keeps ciphertext-only versions
- Verify all code paths use `_ct` suffix (already done per 2026-04-19 review)

**Estimated effort:** 1 hour (mostly review to confirm no code still reads plaintext)  
**Files to modify:**
- `db/migrations/082_drop_plaintext_columns.sql` (new)
- Code review: confirm all decryption paths use `_ct` columns

**Migration SQL:**
```sql
-- Verification: ensure no code reads the plaintext columns
-- (already done per review on 2026-04-19, but double-check)

ALTER TABLE family_contacts DROP COLUMN IF EXISTS display_name;
ALTER TABLE family_contacts DROP COLUMN IF EXISTS notes;
ALTER TABLE support_tickets DROP COLUMN IF EXISTS email;

-- Rename the ciphertext columns to remove the _ct suffix (cleaner schema)
-- (or keep _ct suffix for clarity that these are encrypted — your call)
```

**Testing:** Verify that `GET /v1/family/contacts` still returns decrypted names (reading from `display_name_ct`).

---

### 5. Stripe Webhook Handler (Task #103)

**Purpose:** Wire up Stripe subscription webhooks for email-user renewals (web/email subscription path, backup to Apple IAP).

**Current state:**
- Apple IAP is the primary subscription path (iOS)
- Stripe is optional for web users who don't want to use Apple's payment system
- Webhook route `/subscription/stripe/webhook` exists but doesn't handle all events

**Solution:**
- Listen to `customer.subscription.{created,updated,deleted}` events
- On `created`: new subscription, set user tier based on `price_id` in billing_details
- On `updated`: subscription details changed (e.g., plan downgrade, next renewal date), sync tier
- On `deleted`: subscription ended, downgrade to free tier
- All under same `ensureTierPersisted` transaction logic as Apple path

**Estimated effort:** 2–3 hours  
**Files to modify:**
- `src/routes/subscription.ts` (expand webhook handler)
- `src/lib/stripeVerify.ts` (add event parsing if needed)
- Test coverage: `test/stripeWebhooks.test.ts` (new)

**Prerequisites:**
- STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET in .env.production (both optional for Phase 1)
- Stripe account already created with aegisdial products

**Testing:** Use Stripe CLI to fire test webhook events; verify user tier updates in DB.

---

## Blocked Work (Requires External Setup)

### Blocked: Ekata Provider Integration (Task #99)

**Blocker:** Need Ekata API credentials from their sales team.  
**Timeline:** Request credentials → 2–3 business days for approval.  
**Effort if unblocked:** 3–4 hours.

**Work:**
- Add `EKATA_API_KEY` to .env.production
- New `src/lib/ekata.ts` client
- Integrate into `verdictCache.ts`: subscriber name + address enrichment
- Surface on iOS verdict card: "John Smith, 123 Main St, Boston MA"

---

### Blocked: IPQualityScore Provider Integration (Task #100)

**Blocker:** Need IPQualityScore API credentials.  
**Timeline:** Sign up → instant approval → copy key.  
**Effort if unblocked:** 2–3 hours.

**Work:**
- Add `IPQS_API_KEY` to .env.production
- New `src/lib/ipqs.ts` client
- Call `/api/phonenumber/` for spam-risk score
- Cross-check against Caller ID verdict
- Add to verdict response: `spam_risk_score: 75` (0–100 scale)

---

## iOS-Only Work (Requires Mobile Team)

### PhoneNumberCaptureView Onboarding Integration (Task #80)

**Status:** Backend ready (`PATCH /v1/users/me` live as of 2026-04-19)  
**Blockers:** iOS onboarding ownership (concurrent team working on it)  
**Work:** Insert the phone capture sheet after age gate, before paywall

---

## Business/GTM Work (Out of Scope)

- Facebook ad copy
- 90-second product demo video
- Product Hunt launch
- Press outreach (Wirecutter, NYT, AARP)
- Twitter/X account

---

## Recommended Execution Order (Week 1–4 Post-Launch)

**Week 1:** Cache single-flight lock (easy win, high value)  
**Week 2:** VoIP detection (moderate effort, high value)  
**Week 3:** Pre-warming worker (low effort, nice-to-have)  
**Week 4:** Drop plaintext columns + Stripe webhooks (cleanup + backup path)

**Parallel:** Wait for Ekata/IPQS credentials to arrive, implement when ready.

---

## Estimated Total Effort (Unblocked Work)

| Task | Hours | Priority |
|------|-------|----------|
| Cache single-flight lock | 3 | 🟢 High |
| VoIP detection | 5 | 🟢 High |
| Pre-warming worker | 3 | 🟡 Medium |
| Drop plaintext columns | 1 | 🟡 Medium |
| Stripe webhooks | 3 | 🟡 Medium |
| **Total** | **15 hours** | |

**Total unblocked Phase 2:** ~2 weeks of part-time work (or 3–4 days full-time).

---

## Success Criteria (Phase 2 Complete)

```
☐ Cache single-flight lock prevents thundering herd on popular numbers
☐ VoIP burners flagged with "First seen on DATE" metadata
☐ Pre-warming worker runs hourly, warms 100+ numbers from call history
☐ Plaintext columns dropped from DB (ciphertext-only schema)
☐ Stripe webhooks handle subscription lifecycle (create/update/delete)
☐ All 5 features A/B tested with 10% of user base
☐ No increase in error rate or lookup latency
☐ Ekata + IPQS integrated once credentials arrive
```

---

**Created:** 2026-06-24 23:50 UTC  
**Status:** READY FOR PHASE 1 LAUNCH  
**Owner:** Leon (code) + Design team (Ekata/IPQS credentials)
