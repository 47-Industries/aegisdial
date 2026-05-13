import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Email Shield — suspicious-sent audit detector tests.
//
// Stub strategy:
//   - In-memory EmailProvider with a `getSentMessages` method that
//     returns whatever IncomingMessage list the test loaded.
//   - A second variant WITHOUT getSentMessages exercises the
//     graceful-empty path for legacy providers.
//   - No DB, no Fastify, no network. Pure unit tests.
//
// Coverage:
//   1. Empty sent folder → zero findings, scanned_count=0
//   2. Benign reply (no payment language) → no finding
//   3. Wire-request → category=wire_request, confidence>='medium'
//   4. Invoice/account-change → category=invoice_account_change
//   5. Gift-card → category=gift_card_purchase
//   6. Multiple suspicious → multiple findings
//   7. to_domain is eTLD+1 (no local-part leak)
//   8. subject_excerpt is digit-redacted
//   9. window_days excludes older messages
//  10. limit caps the scan
//  11. Provider without getSentMessages → empty result, no throw
//  12. Recipient-freshness boosts confidence to 'high'
//  13. urgent-payment alone → confidence='low'
//  14. Subject excerpt capped at 80 chars
//  15. Malformed recipient (no @) → finding skipped

import type {
  EmailProvider,
  IncomingMessage,
  LinkedAccountCredentials,
} from '../src/services/email/types.ts';
import {
  runSuspiciousSentAudit,
  type SuspiciousSentCategory,
} from '../src/services/email/suspiciousSentAudit.ts';

// ---------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function makeSentMessage(partial: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    external_message_id: 'm-default',
    received_at: new Date(NOW - 1 * DAY),
    from: { display: '', address: 'owner@victimco.com' },
    reply_to: null,
    to: [{ display: '', address: 'vendor@acmecorp.com' }],
    cc: [],
    subject: 'hello',
    body_text: 'just a normal note',
    body_html: '',
    headers: {},
    attachments: [],
    auth_results: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    ...partial,
  };
}

function makeProvider(
  messages: IncomingMessage[],
  opts: { trackCalls?: { value: { window_days: number; limit: number } | null } } = {},
): EmailProvider {
  return {
    name: 'gmail',
    linkAccount: () => { throw new Error('unused'); },
    fetchSince: () => { throw new Error('unused'); },
    fetchAttachmentBytes: () => { throw new Error('unused'); },
    getInboxRules: () => Promise.resolve([]),
    getOAuthGrants: () => Promise.resolve([]),
    getRecentLogins: () => Promise.resolve([]),
    revoke: () => Promise.resolve(),
    // The detector checks for this method's PRESENCE at runtime.
    getSentMessages: async (
      _creds: LinkedAccountCredentials,
      requestOpts: { window_days: number; limit: number },
    ): Promise<IncomingMessage[]> => {
      if (opts.trackCalls) {
        opts.trackCalls.value = requestOpts;
      }
      return messages;
    },
  } as EmailProvider & {
    getSentMessages: (
      c: LinkedAccountCredentials,
      o: { window_days: number; limit: number },
    ) => Promise<IncomingMessage[]>;
  };
}

function makeLegacyProvider(): EmailProvider {
  // No `getSentMessages` field at all — exercises the
  // hasGetSentMessages runtime check.
  return {
    name: 'imap',
    linkAccount: () => { throw new Error('unused'); },
    fetchSince: () => { throw new Error('unused'); },
    fetchAttachmentBytes: () => { throw new Error('unused'); },
    getInboxRules: () => Promise.resolve([]),
    getOAuthGrants: () => Promise.resolve([]),
    getRecentLogins: () => Promise.resolve([]),
    revoke: () => Promise.resolve(),
  };
}

const FAKE_CREDS: LinkedAccountCredentials = {
  provider: 'gmail',
  provider_account_id: 'sub-123',
  display_email: 'owner@victimco.com',
  oauth_token: 'tok',
  oauth_refresh_token: 'ref',
  oauth_expires_at: new Date(Date.now() + 3600_000),
  imap_host: null,
  imap_port: null,
  imap_username: null,
  app_password: null,
};

// ---------------------------------------------------------------
// 1. Empty sent folder
// ---------------------------------------------------------------

describe('runSuspiciousSentAudit', () => {
  it('returns zero findings + scanned_count=0 on an empty sent folder', async () => {
    const p = makeProvider([]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 0);
    assert.equal(res.scanned_count, 0);
    assert.equal(res.window_days, 14);
  });

  // ---------------------------------------------------------------
  // 2. Benign reply
  // ---------------------------------------------------------------

  it('does NOT emit a finding for a benign reply with no payment language', async () => {
    const p = makeProvider([
      makeSentMessage({
        external_message_id: 'm-benign',
        subject: 'Re: lunch tomorrow',
        body_text: 'Sounds good — see you at noon.',
      }),
    ]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 0);
    assert.equal(res.scanned_count, 1);
  });

  // ---------------------------------------------------------------
  // 3. Wire request
  // ---------------------------------------------------------------

  it('flags a wire-request message with category=wire_request and confidence>=medium', async () => {
    const p = makeProvider([
      makeSentMessage({
        external_message_id: 'm-wire',
        subject: 'URGENT wire transfer request',
        body_text:
          'Please send a wire to beneficiary bank below. Same-day wire needed. SWIFT code attached.',
        to: [{ display: '', address: 'ap@new-vendor-llc.com' }],
      }),
    ]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 1);
    const f = res.findings[0]!;
    assert.equal(f.category, 'wire_request');
    assert.ok(
      f.confidence === 'medium' || f.confidence === 'high',
      `confidence should be medium or high, got ${f.confidence}`,
    );
    assert.equal(f.message_id, 'm-wire');
  });

  // ---------------------------------------------------------------
  // 4. Invoice / account change
  // ---------------------------------------------------------------

  it('flags account-change body as category=invoice_account_change', async () => {
    const p = makeProvider([
      makeSentMessage({
        external_message_id: 'm-acct',
        subject: 'Updated banking details',
        body_text:
          'Please update our bank details — we have changed our account. Remit to the new account on file.',
      }),
    ]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0]!.category, 'invoice_account_change');
  });

  // ---------------------------------------------------------------
  // 5. Gift cards
  // ---------------------------------------------------------------

  it('flags gift-card body as category=gift_card_purchase', async () => {
    const p = makeProvider([
      makeSentMessage({
        external_message_id: 'm-gc',
        subject: 'Quick favor',
        body_text:
          'I need you to buy some gift cards for clients today. Scratch off the back and send me the codes.',
      }),
    ]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0]!.category, 'gift_card_purchase');
  });

  // ---------------------------------------------------------------
  // 6. Multiple suspicious messages
  // ---------------------------------------------------------------

  it('emits one finding per suspicious message when multiple are present', async () => {
    const p = makeProvider([
      makeSentMessage({
        external_message_id: 'm-wire1',
        subject: 'Wire transfer payment',
        body_text: 'Please wire payment to the new beneficiary account today.',
        to: [{ display: '', address: 'a@one.com' }],
      }),
      makeSentMessage({
        external_message_id: 'm-gc2',
        subject: 'Need help',
        body_text: 'Please buy some amazon gift cards for the team.',
        to: [{ display: '', address: 'b@two.com' }],
      }),
      makeSentMessage({
        external_message_id: 'm-clean',
        subject: 'lunch',
        body_text: 'see you at one',
        to: [{ display: '', address: 'c@three.com' }],
      }),
    ]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 2);
    const ids = res.findings.map((f) => f.message_id).sort();
    assert.deepEqual(ids, ['m-gc2', 'm-wire1']);
    assert.equal(res.scanned_count, 3);
  });

  // ---------------------------------------------------------------
  // 7. to_domain is eTLD+1 — local-part NEVER appears
  // ---------------------------------------------------------------

  it('to_domain is eTLD+1 only, never includes the local-part', async () => {
    const p = makeProvider([
      makeSentMessage({
        external_message_id: 'm-pii',
        subject: 'Wire transfer request',
        body_text: 'Please send a wire to the beneficiary bank below.',
        // Local-part is PII (`cfo`) — must not leak.
        to: [{ display: '', address: 'cfo@accounting.victimco.com' }],
      }),
    ]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 1);
    const f = res.findings[0]!;
    assert.equal(f.to_domain, 'victimco.com');
    assert.ok(!f.to_domain.includes('cfo'), 'local-part must not leak into to_domain');
    assert.ok(!f.to_domain.includes('@'));
    // Also assert that the reason / subject don't contain the local part either.
    assert.ok(!f.reason.includes('cfo'));
    assert.ok(!f.subject_excerpt.includes('cfo'));
  });

  it('handles multi-label public suffix correctly (co.uk → eTLD+1 keeps three labels)', async () => {
    const p = makeProvider([
      makeSentMessage({
        external_message_id: 'm-uk',
        subject: 'Wire transfer',
        body_text: 'Please send a wire to the new beneficiary account.',
        to: [{ display: '', address: 'ap@new-vendor.co.uk' }],
      }),
    ]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0]!.to_domain, 'new-vendor.co.uk');
  });

  // ---------------------------------------------------------------
  // 8. subject_excerpt is digit-redacted
  // ---------------------------------------------------------------

  it('subject_excerpt is digit-redacted via redactSensitiveDigits', async () => {
    const p = makeProvider([
      makeSentMessage({
        external_message_id: 'm-digits',
        // 17 raw digits — should redact, not appear literally.
        subject: 'Wire transfer to account 12345678901234567 today',
        body_text: 'Please send a wire to the new beneficiary account.',
      }),
    ]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 1);
    const f = res.findings[0]!;
    assert.ok(
      !f.subject_excerpt.includes('12345678901234567'),
      `excerpt should not contain literal digit run, got: ${f.subject_excerpt}`,
    );
    assert.match(f.subject_excerpt, /<<\d+ digits>>/);
  });

  it('truncates subject_excerpt at 80 characters', async () => {
    const longSubject =
      'Wire transfer request please send a same-day wire to the beneficiary bank with the swift code attached and remit to new account';
    const p = makeProvider([
      makeSentMessage({
        external_message_id: 'm-long',
        subject: longSubject,
        body_text: 'Please send a wire to the new beneficiary account.',
      }),
    ]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 1);
    assert.ok(
      res.findings[0]!.subject_excerpt.length <= 80,
      `subject_excerpt must be ≤80 chars, got ${res.findings[0]!.subject_excerpt.length}`,
    );
  });

  // ---------------------------------------------------------------
  // 9. window_days excludes older messages
  // ---------------------------------------------------------------

  it('respects window_days — older messages are excluded from scan AND scanned_count', async () => {
    const p = makeProvider([
      // In-window
      makeSentMessage({
        external_message_id: 'm-recent',
        received_at: new Date(NOW - 2 * DAY),
        subject: 'Wire transfer request',
        body_text: 'Please send a wire to the new beneficiary account.',
      }),
      // 20 days old — outside default 14-day window
      makeSentMessage({
        external_message_id: 'm-old',
        received_at: new Date(NOW - 20 * DAY),
        subject: 'Wire transfer request',
        body_text: 'Please send a wire to the new beneficiary account.',
      }),
    ]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0]!.message_id, 'm-recent');
    assert.equal(res.scanned_count, 1, 'out-of-window messages must not count toward scanned_count');
  });

  it('honors a custom window_days option', async () => {
    const p = makeProvider([
      makeSentMessage({
        external_message_id: 'm-3day',
        received_at: new Date(NOW - 3 * DAY),
        subject: 'Wire transfer',
        body_text: 'Please send a wire to the beneficiary bank.',
      }),
    ]);
    // 1-day window — should exclude the 3-day-old message
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS, { window_days: 1 });
    assert.equal(res.findings.length, 0);
    assert.equal(res.scanned_count, 0);
    assert.equal(res.window_days, 1);
  });

  // ---------------------------------------------------------------
  // 10. limit caps the scan
  // ---------------------------------------------------------------

  it('limit option is forwarded to provider AND enforced on returned messages', async () => {
    const tracker: { value: { window_days: number; limit: number } | null } = { value: null };
    const msgs: IncomingMessage[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push(makeSentMessage({
        external_message_id: `m-${i}`,
        subject: 'Wire transfer',
        body_text: 'Please send a wire to the new beneficiary account.',
        to: [{ display: '', address: `c${i}@vendor.com` }],
      }));
    }
    const p = makeProvider(msgs, { trackCalls: tracker });
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS, { limit: 10 });
    assert.equal(tracker.value?.limit, 10, 'limit should pass through to provider');
    assert.equal(res.scanned_count, 10, 'limit caps how many messages we actually evaluate');
  });

  it('clamps absurd limit / window_days to safe bounds', async () => {
    const tracker: { value: { window_days: number; limit: number } | null } = { value: null };
    const p = makeProvider([], { trackCalls: tracker });
    await runSuspiciousSentAudit(p, FAKE_CREDS, {
      window_days: 99999,
      limit: 1e9,
    });
    assert.ok(
      tracker.value!.window_days <= 90,
      'window_days must be clamped to a safe ceiling',
    );
    assert.ok(
      tracker.value!.limit <= 500,
      'limit must be clamped to a safe ceiling',
    );
    assert.ok(tracker.value!.limit >= 1);
    assert.ok(tracker.value!.window_days >= 1);
  });

  it('clamps negative / NaN options to defaults', async () => {
    const tracker: { value: { window_days: number; limit: number } | null } = { value: null };
    const p = makeProvider([], { trackCalls: tracker });
    await runSuspiciousSentAudit(p, FAKE_CREDS, {
      window_days: -5,
      limit: Number.NaN,
    });
    assert.ok(tracker.value!.window_days >= 1);
    assert.ok(tracker.value!.limit >= 1);
  });

  // ---------------------------------------------------------------
  // 11. Provider without getSentMessages — graceful empty
  // ---------------------------------------------------------------

  it('returns empty result without throwing when provider lacks getSentMessages', async () => {
    const legacy = makeLegacyProvider();
    const res = await runSuspiciousSentAudit(legacy, FAKE_CREDS);
    assert.equal(res.findings.length, 0);
    assert.equal(res.scanned_count, 0);
    assert.equal(res.window_days, 14);
  });

  // ---------------------------------------------------------------
  // 12. Recipient freshness boosts confidence
  // ---------------------------------------------------------------

  it("recipient with single message in window → confidence='high' for wire", async () => {
    const p = makeProvider([
      // Lots of unrelated mail to other domains
      makeSentMessage({
        external_message_id: 'm-other1',
        to: [{ display: '', address: 'pal@friend.com' }],
        subject: 'lunch',
        body_text: 'see you at noon',
      }),
      makeSentMessage({
        external_message_id: 'm-other2',
        to: [{ display: '', address: 'colleague@friend.com' }],
        subject: 'meeting',
        body_text: 'tuesday works',
      }),
      // Wire request to a one-shot recipient — fresh.
      makeSentMessage({
        external_message_id: 'm-wire-fresh',
        to: [{ display: '', address: 'ap@brand-new-vendor.com' }],
        subject: 'Wire transfer payment',
        body_text: 'Please send a wire to the new beneficiary bank attached.',
      }),
    ]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0]!.category, 'wire_request');
    assert.equal(res.findings[0]!.confidence, 'high');
    assert.match(res.findings[0]!.reason, /no prior outbound history/);
  });

  it("recipient with prior history → confidence='medium' for wire", async () => {
    // Five prior messages to vendor.com, then a wire-request to the
    // same domain — recipient is NOT fresh.
    const baseMsgs: IncomingMessage[] = [];
    for (let i = 0; i < 5; i++) {
      baseMsgs.push(makeSentMessage({
        external_message_id: `m-prior-${i}`,
        to: [{ display: '', address: `vendor-rep-${i}@known-vendor.com` }],
        subject: 're: project update',
        body_text: 'thanks for the update',
      }));
    }
    baseMsgs.push(makeSentMessage({
      external_message_id: 'm-wire-known',
      to: [{ display: '', address: 'ap@known-vendor.com' }],
      subject: 'Wire transfer',
      body_text: 'Please send a wire to the beneficiary bank.',
    }));
    const p = makeProvider(baseMsgs);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0]!.category, 'wire_request');
    assert.equal(res.findings[0]!.confidence, 'medium');
  });

  // ---------------------------------------------------------------
  // 13. urgent-payment alone → low confidence
  // ---------------------------------------------------------------

  it("urgency language alone with no wire/account/gift hit → category='urgent_payment', confidence='low'", async () => {
    const p = makeProvider([
      makeSentMessage({
        external_message_id: 'm-urg',
        subject: 'time-sensitive',
        body_text:
          'This is urgent — needs to be done today. Cannot wait.',
      }),
    ]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    assert.equal(res.findings.length, 1);
    const f = res.findings[0]!;
    assert.equal(f.category, 'urgent_payment');
    assert.equal(f.confidence, 'low');
  });

  // ---------------------------------------------------------------
  // 14. Malformed recipient → skipped
  // ---------------------------------------------------------------

  it('skips findings when recipient is malformed (no @ or empty)', async () => {
    const p = makeProvider([
      makeSentMessage({
        external_message_id: 'm-bad',
        subject: 'Wire transfer',
        body_text: 'Please send a wire to the new beneficiary account.',
        to: [{ display: '', address: 'not-an-email' }],
      }),
      makeSentMessage({
        external_message_id: 'm-empty',
        subject: 'Wire transfer',
        body_text: 'Please send a wire to the new beneficiary account.',
        to: [],
      }),
    ]);
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    // Both messages were scanned, but neither emits a finding —
    // can't build a non-PII to_domain.
    assert.equal(res.findings.length, 0);
    assert.equal(res.scanned_count, 2);
  });

  // ---------------------------------------------------------------
  // 15. Sanity: category type matches the union
  // ---------------------------------------------------------------

  it('every emitted category is a member of the documented union', async () => {
    const p = makeProvider([
      makeSentMessage({
        external_message_id: 'm-wire',
        to: [{ display: '', address: 'a@x.com' }],
        subject: 'Wire transfer',
        body_text: 'Please send a wire to the beneficiary bank.',
      }),
      makeSentMessage({
        external_message_id: 'm-acct',
        to: [{ display: '', address: 'a@y.com' }],
        subject: 'Updated banking',
        body_text: 'Please update our bank details. We changed our account.',
      }),
      makeSentMessage({
        external_message_id: 'm-gc',
        to: [{ display: '', address: 'a@z.com' }],
        subject: 'favor',
        body_text: 'Please buy some itunes gift cards for clients.',
      }),
    ]);
    const allowed: SuspiciousSentCategory[] = [
      'wire_request',
      'invoice_account_change',
      'gift_card_purchase',
      'credential_reset',
      'urgent_payment',
    ];
    const res = await runSuspiciousSentAudit(p, FAKE_CREDS);
    for (const f of res.findings) {
      assert.ok(allowed.includes(f.category), `unexpected category ${f.category}`);
    }
  });
});
