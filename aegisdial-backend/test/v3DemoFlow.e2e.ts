// Live Shield v3 — end-to-end demo-path driver.
//
// Walks the full v3 flow against a LIVE server + LIVE embedded postgres
// (booted via `npm run dev:full`). This is a real cross-service check —
// not a unit test with fakeQuery. The goal is to catch issues the unit
// suite can't see, including:
//
//   - Migration 048 CHECK-constraint allowing 'shield_takeover' /
//     'shield_post_dismiss' / 'block_retry' kinds at INSERT time
//   - Migration 049 b3_armed_post_dismiss_watches table FK behavior
//   - Idempotency of POST /v1/push/critical-takeover (Phase-5 fix #2)
//   - Dismiss route's takeover-required guard (Phase-5 HIGH fix #8)
//   - Contribution toggle-off retracts mentions (Phase-5 fix #4)
//   - The 60s push-suppression window in v3PushDispatcher
//   - A2: /v1/blocks/retry-attempt rate limit + block_retry push enqueue
//   - B4 trigger_path: takeover with claim-quote injection into the push
//
// What's deliberately NOT in this driver:
//   - matched_text redaction — driving a sentinel-firing transcript
//     chunk requires the seeded B3 patterns + the gate-passing
//     scammer-context window, which is non-trivial fixture work.
//     The redactor unit tests at test/v3SentinelMatchedTextRedaction
//     .test.ts pin the contract. The route → emitChunk → sentinel
//     wire-up itself is HTTP-driveable now (POST /transcript with
//     speaker='self'); add a step here when scammer-context fixture
//     plumbing lands.
//   - R8 family-alert cooldown — needs a family_plan + family_members
//     fixture this driver does not currently set up. Covered by
//     test/v3R8GuardianCooldown.test.ts.
//   - B5 safety-contact lifecycle — same family-fixture requirement.
//     Covered by test/v3Phase4FamilyJoin.test.ts.
//
// Run with: `tsx test/v3DemoFlow.e2e.ts` against a server on PORT=3001
// with all V3_*_ENABLED=true. Exits 0 on pass, non-zero on first fail.

import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001';
const SECRET = process.env.API_SHARED_SECRET ?? 'devsecret123';
const DEV_USER = '00000000-0000-0000-0000-000000000000';
const PG_URL =
  process.env.DATABASE_URL ?? 'postgres://aegis:aegis@localhost:54329/aegisdial';

const pool = new Pool({ connectionString: PG_URL });

// Redis client for adversarial-pass HIGH-1 fix: clear A2 rate-limit
// keys before Step 5 so the driver is re-runnable against a persistent
// Redis (Upstash, durable local). Driver assumes a real Redis backend
// — when REDIS_URL is `memory://...` the server's cache is per-process
// and the driver can't reach it; in that case server restart between
// runs is the cleanup mechanism. We DEL anyway so the redis-backed
// path is robust.
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const REDIS_AVAILABLE = !REDIS_URL.startsWith('memory://');
const redis = REDIS_AVAILABLE
  ? new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
  : null;

function bearer() {
  return { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
}

async function http(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: bearer(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, json };
}

// Tiny assert helper that prints a context line on fail so we know
// WHICH step blew up, not just "expected 200, got 409".
let failed = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`, detail ? `  ${JSON.stringify(detail)}` : '');
  }
}

async function createCallSession(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO call_sessions
        (id, user_id, peer_e164, direction, consent_given,
         risk_score, risk_level)
     VALUES ($1, $2, '+14155550100', 'inbound', TRUE, 92, 'critical')`,
    [id, DEV_USER],
  );
  return id;
}

async function cleanupCallSession(id: string): Promise<void> {
  // Cascade kills guardian_alerts via subject_user_id? Actually no — guardian_alerts
  // doesn't FK call_sessions. Clean those separately so the test is rerunnable.
  await pool.query(`DELETE FROM guardian_alerts WHERE subject_user_id = $1`, [DEV_USER]);
  await pool.query(`DELETE FROM b3_armed_post_dismiss_watches WHERE session_id = $1`, [id]);
  await pool.query(`DELETE FROM b3_dismiss_events WHERE session_id = $1`, [id]);
  await pool.query(`DELETE FROM call_sessions WHERE id = $1`, [id]);
}

async function cleanupBlocks(): Promise<void> {
  await pool.query(
    `DELETE FROM mentions
       WHERE source = 'aegisdial_user_block'
         AND source_ref IN (SELECT 'block:' || id::TEXT FROM user_blocks WHERE user_id = $1)`,
    [DEV_USER],
  );
  await pool.query(`DELETE FROM block_retry_attempts WHERE user_id = $1`, [DEV_USER]);
  await pool.query(`DELETE FROM user_blocks WHERE user_id = $1`, [DEV_USER]);
}

async function main(): Promise<void> {
  console.log('=== Live Shield v3 — E2E demo-path driver ===\n');

  // -------------------------------------------------------------------------
  // STEP 0 — health
  // -------------------------------------------------------------------------
  console.log('Step 0: server reachable');
  {
    const r = await http('GET', '/health');
    check('GET /health returns 200', r.status === 200, r);
  }

  // -------------------------------------------------------------------------
  // STEP 1 — Phase 5 CRITICAL fix #2: takeover idempotency
  // -------------------------------------------------------------------------
  console.log('\nStep 1: B3 takeover + idempotency');
  await cleanupBlocks();
  const sessionId = await createCallSession();
  try {
    // First fire — wasFirstTakeover should be true.
    const r1 = await http('POST', '/v1/push/critical-takeover', {
      session_id: sessionId,
      trigger_path: 'live_shield_critical',
      risk_score: 92,
    });
    check('first POST → 201', r1.status === 201, r1);
    check(
      'first POST → was_first_takeover = true',
      (r1.json as { was_first_takeover?: boolean }).was_first_takeover === true,
      r1.json,
    );

    // Give the void-fire-and-forget enqueue 200ms to land.
    await new Promise((res) => setTimeout(res, 200));

    // DB check: exactly one shield_takeover row enqueued.
    const enq1 = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM guardian_alerts
        WHERE subject_user_id = $1 AND kind = 'shield_takeover'`,
      [DEV_USER],
    );
    check(
      'guardian_alerts has exactly 1 shield_takeover row',
      enq1.rows[0].c === 1,
      enq1.rows[0],
    );

    // Second fire — wasFirstTakeover false, NO new enqueue.
    const r2 = await http('POST', '/v1/push/critical-takeover', {
      session_id: sessionId,
      trigger_path: 'live_shield_critical',
      risk_score: 95,
    });
    check('second POST → 201', r2.status === 201, r2);
    check(
      'second POST → was_first_takeover = false',
      (r2.json as { was_first_takeover?: boolean }).was_first_takeover === false,
      r2.json,
    );

    await new Promise((res) => setTimeout(res, 200));
    const enq2 = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM guardian_alerts
        WHERE subject_user_id = $1 AND kind = 'shield_takeover'`,
      [DEV_USER],
    );
    check(
      'idempotent: still exactly 1 shield_takeover after second POST',
      enq2.rows[0].c === 1,
      enq2.rows[0],
    );

    // The row should carry interruption_level_request='critical' and
    // ios_category='AEGISDIAL_CRITICAL_TAKEOVER' for iOS to route the
    // critical-priority lock-screen takeover.
    const row = await pool.query(
      `SELECT payload FROM guardian_alerts
        WHERE subject_user_id = $1 AND kind = 'shield_takeover' LIMIT 1`,
      [DEV_USER],
    );
    const payload = row.rows[0]?.payload ?? {};
    check(
      'payload.interruption_level_request = critical',
      payload.interruption_level_request === 'critical',
      payload,
    );
    check(
      'payload.interruption_level_fallback = time-sensitive',
      payload.interruption_level_fallback === 'time-sensitive',
      payload,
    );
    check(
      'payload.ios_category = AEGISDIAL_CRITICAL_TAKEOVER',
      payload.ios_category === 'AEGISDIAL_CRITICAL_TAKEOVER',
      payload,
    );

    // -----------------------------------------------------------------------
    // STEP 2 — Phase 5 HIGH fix #8: dismiss requires takeover_fired_at
    // -----------------------------------------------------------------------
    console.log('\nStep 2: dismiss route hardening');

    // Dismiss on a session WITHOUT a takeover fired → 409.
    const otherSession = await createCallSession();
    try {
      const r = await http('POST', `/v1/sessions/${otherSession}/dismiss`, {
        takeover_kind: 'b3',
        trigger_path: 'live_shield_critical',
        takeover_fired_at: new Date().toISOString(),
        score_at_dismiss: 90,
        scam_type: 'irs',
        matched_red_flags: ['urgency'],
      });
      check('dismiss without takeover → 409', r.status === 409, r);
      check(
        'error = no_active_takeover_to_dismiss',
        (r.json as { error?: string }).error === 'no_active_takeover_to_dismiss',
        r.json,
      );
    } finally {
      await cleanupCallSession(otherSession);
    }

    // Dismiss with control chars in red flags → 400 (sanitization).
    const rBad = await http('POST', `/v1/sessions/${sessionId}/dismiss`, {
      takeover_kind: 'b3',
      trigger_path: 'live_shield_critical',
      takeover_fired_at: new Date().toISOString(),
      score_at_dismiss: 90,
      scam_type: 'irs',
      matched_red_flags: ['hello\x00world'],
    });
    check(
      'dismiss with control-char red_flag → 400 invalid_body',
      rBad.status === 400,
      rBad,
    );

    // Dismiss with bad scam_type (uppercase) → 400.
    const rBad2 = await http('POST', `/v1/sessions/${sessionId}/dismiss`, {
      takeover_kind: 'b3',
      trigger_path: 'live_shield_critical',
      takeover_fired_at: new Date().toISOString(),
      score_at_dismiss: 90,
      scam_type: 'IRS_Agent',  // uppercase rejected
      matched_red_flags: ['urgency'],
    });
    check(
      'dismiss with uppercase scam_type → 400 invalid_body',
      rBad2.status === 400,
      rBad2,
    );

    // Dismiss with future takeover_fired_at (> NOW + 10s) → 400.
    const future = new Date(Date.now() + 60_000).toISOString();
    const rBad3 = await http('POST', `/v1/sessions/${sessionId}/dismiss`, {
      takeover_kind: 'b3',
      trigger_path: 'live_shield_critical',
      takeover_fired_at: future,
      score_at_dismiss: 90,
      scam_type: 'irs',
      matched_red_flags: ['urgency'],
    });
    check(
      'dismiss with future takeover_fired_at → 400 out_of_range',
      rBad3.status === 400,
      rBad3,
    );

    // Valid dismiss → 200/201 and arms post-dismiss watch in DB.
    const rOk = await http('POST', `/v1/sessions/${sessionId}/dismiss`, {
      takeover_kind: 'b3',
      trigger_path: 'live_shield_critical',
      takeover_fired_at: new Date().toISOString(),
      score_at_dismiss: 90,
      scam_type: 'irs',
      matched_red_flags: ['urgency', 'gift_card_request'],
    });
    check('valid dismiss → 2xx', rOk.status >= 200 && rOk.status < 300, rOk);

    // -----------------------------------------------------------------------
    // STEP 3 — Phase 5 CRITICAL fix #3: postDismissWatcher persistence
    // -----------------------------------------------------------------------
    console.log('\nStep 3: post-dismiss watcher persistence (migration 049)');
    // armPostDismissWatch persists via `void query(...)` (fire-and-forget
    // for dismiss-route latency). Give the INSERT a beat to land before
    // we assert on it. This isn't a production correctness gap — the
    // in-memory timer fires regardless; the DB row is only consulted on
    // a process restart.
    await new Promise((res) => setTimeout(res, 250));
    const watch = await pool.query(
      `SELECT session_id, user_id, scam_type, matched_red_flags, current_score
         FROM b3_armed_post_dismiss_watches WHERE session_id = $1`,
      [sessionId],
    );
    check(
      'b3_armed_post_dismiss_watches has 1 row for the session',
      watch.rows.length === 1,
      watch.rows,
    );
    if (watch.rows[0]) {
      check(
        'persisted scam_type = irs',
        watch.rows[0].scam_type === 'irs',
        watch.rows[0],
      );
      check(
        'persisted matched_red_flags = [urgency, gift_card_request]',
        Array.isArray(watch.rows[0].matched_red_flags) &&
          watch.rows[0].matched_red_flags.includes('urgency') &&
          watch.rows[0].matched_red_flags.includes('gift_card_request'),
        watch.rows[0],
      );
    }
  } finally {
    await cleanupCallSession(sessionId);
  }

  // -------------------------------------------------------------------------
  // STEP 4 — Phase 5 CRITICAL fix #4: contribution toggle-off retracts
  // -------------------------------------------------------------------------
  console.log('\nStep 4: contribution toggle retract semantics');
  await cleanupBlocks();

  // Toggle ON first so future-block contribution is enabled.
  await http('POST', '/v1/blocks/contribution-toggle', { enabled: true });

  // Add a block; with contribution=true it should also write to mentions.
  const blockRes = await http('POST', '/v1/blocks', {
    e164: '+14155550199',
    reason_code: 'live_shield_critical',
    source_surface: 'live_shield_post_call',
  });
  check('add block → 2xx', blockRes.status >= 200 && blockRes.status < 300, blockRes);

  // Inspect DB: user_blocks + mentions both populated.
  const ub = await pool.query(
    `SELECT id, contributed_to_graph FROM user_blocks WHERE user_id = $1`,
    [DEV_USER],
  );
  check('user_blocks has 1 row', ub.rows.length === 1, ub.rows);
  check(
    'user_blocks.contributed_to_graph = true',
    ub.rows[0]?.contributed_to_graph === true,
    ub.rows[0],
  );

  const m1 = await pool.query(
    `SELECT COUNT(*)::INT AS c FROM mentions
      WHERE source = 'aegisdial_user_block'
        AND source_ref = 'block:' || $1::TEXT`,
    [ub.rows[0]?.id],
  );
  check(
    'mentions has 1 row for this block before toggle-off',
    m1.rows[0].c === 1,
    m1.rows[0],
  );

  // Toggle OFF — should DELETE the mention AND flip contributed_to_graph.
  const off = await http('POST', '/v1/blocks/contribution-toggle', { enabled: false });
  check('toggle-off → 200', off.status === 200, off);
  check(
    'toggle-off response says mentions_retracted = 1',
    (off.json as { mentions_retracted?: number }).mentions_retracted === 1,
    off.json,
  );

  const m2 = await pool.query(
    `SELECT COUNT(*)::INT AS c FROM mentions
      WHERE source = 'aegisdial_user_block'
        AND source_ref = 'block:' || $1::TEXT`,
    [ub.rows[0]?.id],
  );
  check(
    'mentions row deleted after toggle-off',
    m2.rows[0].c === 0,
    m2.rows[0],
  );

  const ub2 = await pool.query(
    `SELECT contributed_to_graph FROM user_blocks WHERE user_id = $1`,
    [DEV_USER],
  );
  check(
    'user_blocks.contributed_to_graph flipped to false',
    ub2.rows[0]?.contributed_to_graph === false,
    ub2.rows[0],
  );

  await cleanupBlocks();

  // -------------------------------------------------------------------------
  // STEP 5 — A2: /v1/blocks/retry-attempt → block_retry push enqueue
  // -------------------------------------------------------------------------
  console.log('\nStep 5: A2 retry-attempt rate limit + push enqueue');
  await cleanupBlocks();

  // Adversarial-pass MEDIUM-3 fix: Step 4 left contribution toggle OFF.
  // Step 5's `POST /v1/blocks` for the test target would then skip the
  // mentions write — not asserted on here, but a future test added
  // between Step 4 and Step 5 would silently misbehave. Restore the
  // default before continuing.
  await http('POST', '/v1/blocks/contribution-toggle', { enabled: true });

  // Adversarial-pass HIGH-1 fix: clear the Redis rate-limit counters
  // so the first POST is guaranteed to see a clean (user, day) and
  // (user, e164, hour) state. Without this, re-running the driver
  // against a persistent Redis within an hour starts hourlyCount > 1
  // and the "first retry-attempt eligible=true" assertion fails. The
  // helper here is a direct DEL — same as a2RetryRateLimit.ts's
  // _resetRateLimitForTests but operating from the driver process.
  const targetNumber = '+14155550244';
  if (redis) {
    await redis.connect().catch(() => {});
    await redis.del(`v3:a2:rl:day:${DEV_USER}`).catch(() => {});
    await redis.del(`v3:a2:rl:num:${DEV_USER}:${targetNumber}`).catch(() => {});
  }

  // The retry-attempt route guards on the number being already blocked.
  // Add a block first, then report the retry.
  const addBlock = await http('POST', '/v1/blocks', {
    e164: targetNumber,
    reason_code: 'live_shield_critical',
    source_surface: 'live_shield_post_call',
  });
  check('add block (for retry test) → 2xx', addBlock.status >= 200 && addBlock.status < 300, addBlock);

  // Adversarial-pass MEDIUM-4 fix: wrap Step 5's assertions in
  // try/finally so a mid-step failure doesn't leak rate-limit and
  // guardian_alerts state into Step 6. The previous shape relied on
  // the next step's cleanup running, which doesn't fire on assertion
  // exception.
  try {
    // Clean any stale block_retry rows so we start from zero.
    await pool.query(`DELETE FROM guardian_alerts WHERE subject_user_id = $1 AND kind = 'block_retry'`, [DEV_USER]);
    await pool.query(`DELETE FROM block_retry_attempts WHERE user_id = $1`, [DEV_USER]);

    // First retry-attempt → eligible (rate-limit fresh), push should enqueue.
    const ra1 = await http('POST', '/v1/blocks/retry-attempt', {
      e164: targetNumber,
      attempted_at: new Date().toISOString(),
    });
    check('first retry-attempt → 201', ra1.status === 201, ra1);
    check(
      'first retry-attempt → notification_eligible = true',
      (ra1.json as { notification_eligible?: boolean }).notification_eligible === true,
      ra1.json,
    );
    check(
      'first retry-attempt → notification_grouped = false',
      (ra1.json as { notification_grouped?: boolean }).notification_grouped === false,
      ra1.json,
    );

    // Give the void-fire-and-forget enqueue a beat.
    await new Promise((res) => setTimeout(res, 200));

    // Adversarial-pass HIGH-2 fix: COUNT separately so an unexpected
    // duplicate enqueue (e.g. a regressed 60s suppression) is caught
    // by the count, not silently swallowed by a `LIMIT 1` fetch.
    const countAfterFirst = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM guardian_alerts
        WHERE subject_user_id = $1 AND kind = 'block_retry'`,
      [DEV_USER],
    );
    check(
      'guardian_alerts has exactly 1 block_retry row',
      countAfterFirst.rows[0].c === 1,
      countAfterFirst.rows[0],
    );

    const blockRetryRows = await pool.query(
      `SELECT severity, payload FROM guardian_alerts
        WHERE subject_user_id = $1 AND kind = 'block_retry'
        ORDER BY created_at LIMIT 1`,
      [DEV_USER],
    );
    if (blockRetryRows.rows[0]) {
      const row = blockRetryRows.rows[0];
      check(
        'block_retry severity = info',
        row.severity === 'info',
        row,
      );
      const payload = row.payload ?? {};
      check(
        'block_retry payload.interruption_level_request = passive',
        payload.interruption_level_request === 'passive',
        payload,
      );
      check(
        'block_retry payload.ios_category = AEGISDIAL_BLOCK_RETRY',
        payload.ios_category === 'AEGISDIAL_BLOCK_RETRY',
        payload,
      );
      // Reviewer note from Phase 5 review: e164 is in the payload by
      // design (the in-app log resolves the number from this), but
      // deliberately NOT in the notification body. Defense-in-depth:
      // verify the e164 here is the actual value (round-trip integrity),
      // and trust the body-shape unit tests for the no-leak guarantee.
      check(
        'block_retry payload.e164 round-trips correctly',
        payload.e164 === targetNumber,
        payload,
      );
    }

    // Second retry-attempt for the same number within the per-(user, e164)
    // hour window — rate-limited, no new push enqueue. The HTTP returns
    // notification_eligible=false, notification_grouped=true.
    const ra2 = await http('POST', '/v1/blocks/retry-attempt', {
      e164: targetNumber,
      attempted_at: new Date().toISOString(),
    });
    check('second retry-attempt → 201', ra2.status === 201, ra2);
    check(
      'second retry-attempt within hour → notification_eligible = false',
      (ra2.json as { notification_eligible?: boolean }).notification_eligible === false,
      ra2.json,
    );
    check(
      'second retry-attempt → notification_grouped = true',
      (ra2.json as { notification_grouped?: boolean }).notification_grouped === true,
      ra2.json,
    );

    await new Promise((res) => setTimeout(res, 200));
    const blockRetryRows2 = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM guardian_alerts
        WHERE subject_user_id = $1 AND kind = 'block_retry'`,
      [DEV_USER],
    );
    check(
      'rate-limit holds: still exactly 1 block_retry after second attempt',
      blockRetryRows2.rows[0].c === 1,
      blockRetryRows2.rows[0],
    );

    // Reject retry-attempt for a number that was never blocked.
    const ra3 = await http('POST', '/v1/blocks/retry-attempt', {
      e164: '+14155550999',
      attempted_at: new Date().toISOString(),
    });
    check('retry-attempt for un-blocked number → 409', ra3.status === 409, ra3);
  } finally {
    await cleanupBlocks();
    await pool
      .query(`DELETE FROM guardian_alerts WHERE subject_user_id = $1 AND kind = 'block_retry'`, [DEV_USER])
      .catch(() => {});
    if (redis) {
      await redis.del(`v3:a2:rl:day:${DEV_USER}`).catch(() => {});
      await redis.del(`v3:a2:rl:num:${DEV_USER}:${targetNumber}`).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // STEP 6 — B4: trigger_path 'b4_finding' on /v1/push/critical-takeover
  // -------------------------------------------------------------------------
  console.log('\nStep 6: B4 trigger_path → claim-quote takeover');
  const b4SessionId = await createCallSession();
  try {
    await pool.query(
      `DELETE FROM guardian_alerts WHERE subject_user_id = $1 AND kind = 'shield_takeover'`,
      [DEV_USER],
    );

    // Drive the B4 trigger_path. The claim_type + raw_quote should
    // surface in the push payload context, and buildTakeoverCopy
    // should inject the quote into the body (truncated + sanitized).
    const r = await http('POST', '/v1/push/critical-takeover', {
      session_id: b4SessionId,
      trigger_path: 'b4_finding',
      risk_score: 96,
      context: {
        claim_type: 'bank_affiliation',
        raw_quote: "Hi, this is Wells Fargo's fraud department calling",
        finding_id: 'finding-abc-123',
      },
    });
    check('b4_finding POST → 201', r.status === 201, r);

    await new Promise((res) => setTimeout(res, 200));

    // Adversarial-pass HIGH-2 fix: split the duplicate-detection
    // assertion from the column-fetch so `LIMIT 1` can't hide a
    // double-enqueue regression.
    const countB4 = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM guardian_alerts
        WHERE subject_user_id = $1 AND kind = 'shield_takeover'`,
      [DEV_USER],
    );
    check(
      'b4_finding produced exactly 1 shield_takeover row',
      countB4.rows[0].c === 1,
      countB4.rows[0],
    );
    const row = await pool.query(
      `SELECT title, body, payload FROM guardian_alerts
        WHERE subject_user_id = $1 AND kind = 'shield_takeover'
        ORDER BY created_at LIMIT 1`,
      [DEV_USER],
    );
    if (row.rows[0]) {
      const rec = row.rows[0];
      check(
        'b4_finding title leads with STOP',
        typeof rec.title === 'string' && rec.title.startsWith('STOP'),
        rec.title,
      );
      check(
        'b4_finding body contains the raw_quote substring',
        typeof rec.body === 'string' && rec.body.includes("Wells Fargo's fraud department"),
        rec.body,
      );
      const payload = rec.payload ?? {};
      check(
        'b4_finding payload.trigger_path = b4_finding',
        payload.trigger_path === 'b4_finding',
        payload,
      );
      // The context.claim_type + finding_id should round-trip into
      // the payload for the iOS app to dispatch to the polymorphic
      // CriticalInterruptView.
      check(
        'b4_finding payload.context.claim_type round-trips',
        payload.context?.claim_type === 'bank_affiliation',
        payload.context,
      );
      check(
        'b4_finding payload.context.finding_id round-trips',
        payload.context?.finding_id === 'finding-abc-123',
        payload.context,
      );
    }

    // Adversarial-pass MEDIUM-5 fix: drive a hostile-input raw_quote
    // case so the buildTakeoverCopy sanitization is integration-tested
    // end-to-end. A forged route call (or a malicious upstream that
    // bypasses the claimExtractor's verbatim audit) could otherwise
    // inject control chars / newlines / 100+ char payloads into the
    // push body. Unit tests pin the sanitizer; this proves the
    // sanitized output actually rides into guardian_alerts.payload.
    const hostileSessionId = await createCallSession();
    try {
      await pool.query(
        `DELETE FROM guardian_alerts WHERE subject_user_id = $1 AND kind = 'shield_takeover'`,
        [DEV_USER],
      );
      const hostileQuote =
        'line1\x00\x01line2\nINJECTED\x7f' + 'a'.repeat(150);
      const rH = await http('POST', '/v1/push/critical-takeover', {
        session_id: hostileSessionId,
        trigger_path: 'b4_finding',
        risk_score: 96,
        context: {
          claim_type: 'agency_affiliation',
          raw_quote: hostileQuote,
          finding_id: 'finding-hostile-1',
        },
      });
      check('hostile b4_finding POST → 201', rH.status === 201, rH);
      await new Promise((res) => setTimeout(res, 200));
      const hostileRow = await pool.query(
        `SELECT body FROM guardian_alerts
          WHERE subject_user_id = $1 AND kind = 'shield_takeover'
          ORDER BY created_at LIMIT 1`,
        [DEV_USER],
      );
      const hostileBody: string = hostileRow.rows[0]?.body ?? '';
      check(
        'hostile body has no control chars',
        !/[\x00-\x08\x0b-\x1f\x7f]/.test(hostileBody),
        hostileBody.slice(0, 80),
      );
      check(
        'hostile body has no embedded newlines',
        !hostileBody.includes('\n'),
        hostileBody.slice(0, 80),
      );
      check(
        'hostile body was truncated (length <= 200 including framing)',
        hostileBody.length <= 200,
        { length: hostileBody.length },
      );
      check(
        'hostile body still ends with the "…" truncation marker for the over-80 quote',
        hostileBody.includes('…'),
        hostileBody,
      );
    } finally {
      await cleanupCallSession(hostileSessionId);
    }
  } finally {
    await cleanupCallSession(b4SessionId);
    await pool.query(
      `DELETE FROM guardian_alerts WHERE subject_user_id = $1 AND kind = 'shield_takeover'`,
      [DEV_USER],
    );
  }

  // -------------------------------------------------------------------------
  // STEP 7 — Mom-side STT dispatch wire-up (route → momSideStt.emitChunk)
  // -------------------------------------------------------------------------
  //
  // Closes the audit gap from 2026-05-11: the transcript route
  // accepted `speaker: 'self'` chunks but didn't call
  // momSideStt.emitChunk(), so the B3 sentinelMatcher's evaluateChunk
  // path was dormant in production.
  //
  // What we verify here:
  //   - POST /v1/live-shield/start returns a session_id
  //   - POST /v1/live-shield/:id/transcript with speaker='self' is
  //     accepted (200 — would have been 500 under the column-name
  //     bug that earlier adversarial pass caught at services.ts:368)
  //   - POST same route with speaker='caller' also accepted
  //   - The session's risk_score is updated via the existing v2 path
  //     (proves the wire-up didn't regress v2)
  //   - session ends cleanly
  //
  // We do NOT assert a sentinel takeover firing here — that requires
  // sentinel patterns + scammer-context-gate fixture work outside
  // this driver's scope. The route-accepts-and-doesn't-500 check is
  // the actual regression guard for the wire-up.
  console.log('\nStep 7: Mom-side STT dispatch (POST /transcript wire-up)');
  const startRes = await http('POST', '/v1/live-shield/start', {
    consent_given: true,
    consent_version: 2,
    direction: 'inbound',
  });
  check('POST /v1/live-shield/start → 2xx', startRes.status >= 200 && startRes.status < 300, startRes);
  const lsSessionId = (startRes.json as { session_id?: string }).session_id;
  check('start returns session_id', typeof lsSessionId === 'string' && lsSessionId.length > 0, startRes.json);
  if (lsSessionId) {
    try {
      // Mom-side chunk. Branch under audit: emitChunk MUST be called.
      const selfRes = await http('POST', `/v1/live-shield/${lsSessionId}/transcript`, {
        seq: 0,
        speaker: 'self',
        text: 'hello, I am Mom answering the phone',
        confidence: 0.92,
      });
      check(
        'POST /transcript speaker=self → 2xx (no 500 from column-name bug)',
        selfRes.status >= 200 && selfRes.status < 300,
        selfRes,
      );
      check(
        'response includes risk_score (v2 path not regressed)',
        typeof (selfRes.json as { risk_score?: number }).risk_score === 'number',
        selfRes.json,
      );

      // Caller-side chunk. Different code path — fed into the scammer-
      // context buffer via v3SessionEvents, NOT momSideStt.
      const callerRes = await http('POST', `/v1/live-shield/${lsSessionId}/transcript`, {
        seq: 1,
        speaker: 'caller',
        text: 'this is the IRS calling about your account',
        confidence: 0.88,
      });
      check(
        'POST /transcript speaker=caller → 2xx',
        callerRes.status >= 200 && callerRes.status < 300,
        callerRes,
      );

      // Old-client compatibility: confidence omitted should still 200.
      // (Mom-side dispatch will default to 0.0 confidence and gate
      // out of sentinel, but the route accepts the chunk.)
      const noConfRes = await http('POST', `/v1/live-shield/${lsSessionId}/transcript`, {
        seq: 2,
        speaker: 'self',
        text: 'old client chunk without confidence',
      });
      check(
        'POST /transcript without confidence → 2xx',
        noConfRes.status >= 200 && noConfRes.status < 300,
        noConfRes,
      );
    } finally {
      // End the session cleanly so the sentinel matcher's
      // unsubscribers fire (preventing leak across runs of this
      // driver against the same process).
      await http('POST', `/v1/live-shield/${lsSessionId}/end`, { outcome: 'user_completed' });
      await cleanupCallSession(lsSessionId);
    }
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n=== Summary ===');
  if (failed === 0) {
    console.log('✓ All E2E demo-path checks passed.');
  } else {
    console.log(`✗ ${failed} E2E check(s) FAILED.`);
  }
  await pool.end();
  if (redis) await redis.quit().catch(() => {});
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('E2E driver crashed:', err);
  await pool.end().catch(() => {});
  if (redis) await redis.quit().catch(() => {});
  process.exit(2);
});
