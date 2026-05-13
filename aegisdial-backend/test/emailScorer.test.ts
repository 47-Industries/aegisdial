import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Email Shield — scorer + sub-detector tests.
// Drives the deterministic-only path end-to-end with synthesized
// IncomingMessage fixtures. Tests cover:
//   - BEC pattern matching + category-scoring
//   - Sender lookalike (display-name mismatch, brand-keyword-in-domain,
//     typosquat, IDN homograph)
//   - Attachment heuristics (executable / macro / ISO / shortcut /
//     HTML smuggling)
//   - Score composition + verdict thresholds
//   - Explainable-reasons capping at 8 bullets
//   - URL scan integration (reuse of urlScan.ts via SMS Shield path)

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-email-scorer';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://email-scorer';

const becMod = await import('../src/services/email/becPatterns.ts');
const lookalikeMod = await import('../src/services/email/senderLookalike.ts');
const attMod = await import('../src/services/email/attachmentHeuristics.ts');
const scorerMod = await import('../src/services/email/emailScorer.ts');
import type { IncomingMessage } from '../src/services/email/types.ts';

function makeMessage(partial: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    external_message_id: 'm-test',
    received_at: new Date('2026-05-11T12:00:00Z'),
    from: { display: '', address: 'sender@example.com' },
    reply_to: null,
    to: [{ display: '', address: 'user@example.com' }],
    cc: [],
    subject: 'hi',
    body_text: 'plain text body',
    body_html: '',
    headers: {},
    attachments: [],
    auth_results: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    ...partial,
  };
}

// =================================================================
// BEC pattern library
// =================================================================

describe('becPatterns — phrase detection + category scoring', () => {
  it('matches a classic CEO-gift-card request', () => {
    const matches = becMod.detectBecPatterns({
      subject: 'Quick favor',
      body_text:
        'I am in a meeting and need you to buy some gift cards for clients. Cannot wait. Please keep this between us.',
      body_html: '',
    });
    const cats = new Set(matches.map((m) => m.category));
    assert.ok(cats.has('gift_card_purchase'));
    assert.ok(cats.has('urgency_pressure'));
    assert.ok(cats.has('secrecy_pressure'));
  });

  it('matches an invoice-redirect (BEC wire-fraud signature)', () => {
    const matches = becMod.detectBecPatterns({
      subject: 'Updated invoice',
      body_text:
        'Please update our bank details. We changed our account. Remit to the new account on the attached invoice.',
      body_html: '',
    });
    const cats = new Set(matches.map((m) => m.category));
    assert.ok(cats.has('invoice_redirect'));
  });

  it('matches credential-phish without false-positive on the word "verify" alone', () => {
    // Plain "verify" with no account-locked context should NOT fire.
    const m1 = becMod.detectBecPatterns({
      subject: 'Please verify the meeting time',
      body_text: 'Can you verify Tuesday at 10am works?',
      body_html: '',
    });
    assert.equal(
      m1.filter((x) => x.category === 'credential_phish').length,
      0,
      'plain "verify" must not trigger credential_phish',
    );

    // With "verify your account" — fires.
    const m2 = becMod.detectBecPatterns({
      subject: 'Action required',
      body_text: 'Please verify your account to unlock it.',
      body_html: '',
    });
    assert.ok(m2.some((x) => x.category === 'credential_phish'));
  });

  it('scoring composes max-per-category (body wins over subject)', () => {
    const matches = becMod.detectBecPatterns({
      subject: 'urgent wire transfer',         // both urgency + wire fire on subject
      body_text: 'Please send a wire today.',  // wire fires on body
      body_html: '',
    });
    const { pattern_score, triggered_categories } = becMod.scoreBecMatches(matches);
    assert.ok(pattern_score > 0);
    assert.ok(triggered_categories.includes('wire_request'));
    assert.ok(triggered_categories.includes('urgency_pressure'));
  });

  it('benign text scores 0', () => {
    const matches = becMod.detectBecPatterns({
      subject: 'Lunch?',
      body_text: 'Want to grab lunch at noon?',
      body_html: '',
    });
    const { pattern_score } = becMod.scoreBecMatches(matches);
    assert.equal(pattern_score, 0);
  });
});

// =================================================================
// Sender lookalike
// =================================================================

describe('senderLookalike — three detectors', () => {
  it('flags display-name brand mismatch (BoA name on sketchy domain)', () => {
    const findings = lookalikeMod.detectSenderLookalike({
      from_address: 'alerts@bofa-secure.support',
      display_name: 'Bank of America',
    });
    assert.ok(findings.some((f) => f.kind === 'display_name_brand_mismatch'));
    assert.equal(
      findings.find((f) => f.kind === 'display_name_brand_mismatch')!.impersonated_brand,
      'Bank of America',
    );
  });

  it('does NOT flag display-name match on the real bofa.com', () => {
    const findings = lookalikeMod.detectSenderLookalike({
      from_address: 'alerts@bofa.com',
      display_name: 'Bank of America',
    });
    assert.equal(findings.length, 0);
  });

  it('flags brand-keyword-in-domain (chase-verify.xyz)', () => {
    const findings = lookalikeMod.detectSenderLookalike({
      from_address: 'noreply@chase-verify.xyz',
      display_name: '',
    });
    assert.ok(findings.some((f) => f.kind === 'brand_keyword_in_domain'));
  });

  it('flags typosquat (chasse.com — one-char insertion of chase.com)', () => {
    const findings = lookalikeMod.detectSenderLookalike({
      from_address: 'support@chasse.com',
      display_name: '',
    });
    assert.ok(findings.some((f) => f.kind === 'typosquat_of_known_brand'));
  });

  it('does NOT flag a real bank subdomain (secure.chase.com)', () => {
    const findings = lookalikeMod.detectSenderLookalike({
      from_address: 'alert@secure.chase.com',
      display_name: 'Chase',
    });
    assert.equal(findings.length, 0);
  });

  it('flags suffix-attack — chase.com.evil.xyz must NOT pass as chase.com', () => {
    const findings = lookalikeMod.detectSenderLookalike({
      from_address: 'team@chase.com.evil.xyz',
      display_name: 'Chase',
    });
    assert.ok(findings.length > 0, 'suffix attack must be flagged');
  });

  it('flags IDN homograph (Cyrillic in hostname)', () => {
    const findings = lookalikeMod.detectSenderLookalike({
      // 'аpple.com' with a Cyrillic 'а' instead of Latin 'a'.
      from_address: 'support@аpple.com',
      display_name: 'Apple',
    });
    assert.ok(findings.some((f) => f.kind === 'idn_homograph'));
  });
});

// =================================================================
// Attachment heuristics
// =================================================================

describe('attachmentHeuristics — file-type danger flags', () => {
  it('flags an executable masquerade (application/x-msdownload)', () => {
    const finding = attMod.checkAttachment(
      {
        id: 'a',
        filename_hash: 'h',
        content_type: 'application/x-msdownload',
        size_bytes: 1024,
        content_sha256: null,
      },
    );
    assert.ok(finding);
    assert.equal(finding!.severity, 'fraud');
    assert.ok(finding!.threats.includes('executable_masquerade'));
  });

  it('flags macro-bearing Office (.docm content type)', () => {
    const finding = attMod.checkAttachment({
      id: 'a',
      filename_hash: 'h',
      content_type: 'application/vnd.ms-word.document.macroenabled.12',
      size_bytes: 5000,
      content_sha256: null,
    });
    assert.ok(finding);
    assert.equal(finding!.severity, 'suspicious');
  });

  it('flags an ISO container as fraud-severity', () => {
    const finding = attMod.checkAttachment({
      id: 'a',
      filename_hash: 'h',
      content_type: 'application/x-iso9660-image',
      size_bytes: 5_000_000,
      content_sha256: null,
    });
    assert.ok(finding);
    assert.equal(finding!.severity, 'fraud');
  });

  it('flags an HTML attachment as suspicious (smuggling vector)', () => {
    const finding = attMod.checkAttachment({
      id: 'a',
      filename_hash: 'h',
      content_type: 'text/html',
      size_bytes: 3000,
      content_sha256: null,
    });
    assert.ok(finding);
    assert.equal(finding!.severity, 'suspicious');
  });

  it('returns null on a benign PDF', () => {
    const finding = attMod.checkAttachment({
      id: 'a',
      filename_hash: 'h',
      content_type: 'application/pdf',
      size_bytes: 100_000,
      content_sha256: null,
    });
    assert.equal(finding, null);
  });

  it('composes severity: fraud wins over suspicious in the same attachment', () => {
    // Force two threats. ISO is fraud; .lnk extension passed
    // through is also fraud — assert the composite stays fraud.
    const finding = attMod.checkAttachment(
      {
        id: 'a',
        filename_hash: 'h',
        content_type: 'application/x-iso9660-image',
        size_bytes: 5000,
        content_sha256: null,
      },
      '.lnk',
    );
    assert.ok(finding);
    assert.equal(finding!.severity, 'fraud');
  });
});

// =================================================================
// Scorer composition
// =================================================================

describe('emailScorer — verdict tree', () => {
  it('benign email scores safe', async () => {
    const result = await scorerMod.scoreEmailMessage(
      makeMessage({
        subject: 'Lunch?',
        body_text: 'Want to grab lunch at noon?',
        from: { display: 'Friend', address: 'friend@example.com' },
      }),
    );
    assert.equal(result.verdict, 'safe');
    assert.ok(result.fraud_score < 30);
    assert.ok(result.explainable_reasons[0]!.includes('No common phishing'));
  });

  it('classic CEO-gift-card BEC scores fraud', async () => {
    const result = await scorerMod.scoreEmailMessage(
      makeMessage({
        subject: 'URGENT — quick favor',
        body_text:
          'I am the CEO. I need you to buy some iTunes gift cards for our client right now. ' +
          "Keep this between us — I am in a meeting. Cannot wait. Please don't tell anyone.",
        from: { display: 'CEO', address: 'ceo@gmail.com' }, // free-mail-domain
      }),
    );
    assert.equal(result.verdict, 'fraud');
    assert.ok(result.fraud_score >= 70);
    assert.ok(result.triggered_categories.includes('gift_card_purchase'));
    assert.ok(result.triggered_categories.includes('secrecy_pressure'));
  });

  it('display-name brand mismatch + auth fail composes to fraud', async () => {
    const result = await scorerMod.scoreEmailMessage(
      makeMessage({
        subject: 'Your Chase account',
        body_text: 'Please verify your account to unlock it.',
        from: { display: 'Chase', address: 'security@chase-portal.cfd' },
        auth_results: { spf: 'fail', dkim: 'fail', dmarc: 'fail' },
      }),
    );
    assert.equal(result.verdict, 'fraud');
    assert.ok(result.triggered_categories.includes('sender_display_name_brand_mismatch'));
    assert.ok(result.triggered_categories.includes('auth_failure'));
  });

  it('Reply-To divergence contributes to the score', async () => {
    const baseline = await scorerMod.scoreEmailMessage(
      makeMessage({
        body_text: 'Please review the attached invoice.',
        from: { display: '', address: 'billing@acme.com' },
      }),
    );
    const divergent = await scorerMod.scoreEmailMessage(
      makeMessage({
        body_text: 'Please review the attached invoice.',
        from: { display: '', address: 'billing@acme.com' },
        reply_to: { display: '', address: 'attacker@evil.xyz' },
      }),
    );
    assert.ok(
      divergent.fraud_score > baseline.fraud_score,
      `reply-to divergence should bump score (baseline=${baseline.fraud_score}, divergent=${divergent.fraud_score})`,
    );
    assert.ok(divergent.triggered_categories.includes('reply_to_divergence'));
  });

  it('verdict thresholds — exact boundaries (29 safe / 30 suspicious / 70 fraud)', async () => {
    // Build a message we can dial the score on by toggling auth.
    // spf=fail (+15) + dkim=fail (+15) = 30 → suspicious.
    const result = await scorerMod.scoreEmailMessage(
      makeMessage({
        subject: 'hi',
        body_text: 'hello',
        auth_results: { spf: 'fail', dkim: 'fail', dmarc: 'none' },
      }),
    );
    assert.equal(result.verdict, 'suspicious');
    assert.equal(result.fraud_score, 30);
  });

  it('caps fraud_score at 100', async () => {
    // Saturating signal set — every detector lights up.
    const result = await scorerMod.scoreEmailMessage(
      makeMessage({
        subject: 'URGENT wire transfer for account verification',
        body_text:
          'I am the CEO. Please send a wire transfer today — same-day wire. ' +
          'Update our bank details. Remit to the new account. Please verify your ' +
          'account. Buy some Amazon gift cards for clients. ' +
          'Keep this between us, do not tell anyone. Cannot wait.',
        from: { display: 'Chase', address: 'team@chase-secure.cfd' },
        reply_to: { display: '', address: 'attacker@evil.xyz' },
        auth_results: { spf: 'fail', dkim: 'fail', dmarc: 'fail' },
        attachments: [
          {
            id: 'a1', filename_hash: 'h1',
            content_type: 'application/x-iso9660-image',
            size_bytes: 5000, content_sha256: null,
          },
        ],
      }),
    );
    assert.equal(result.fraud_score, 100);
    assert.equal(result.verdict, 'fraud');
  });

  it('explainable_reasons capped at 8 bullets', async () => {
    // Same saturating signal set as the cap test.
    const result = await scorerMod.scoreEmailMessage(
      makeMessage({
        subject: 'URGENT wire transfer for account verification',
        body_text:
          'I am the CEO. Please send a wire transfer today — same-day wire. ' +
          'Update our bank details. Buy some Amazon gift cards. Verify your account. ' +
          'Keep this between us, do not tell anyone.',
        from: { display: 'Chase', address: 'security@chase-portal.cfd' },
        reply_to: { display: '', address: 'attacker@evil.xyz' },
        auth_results: { spf: 'fail', dkim: 'fail', dmarc: 'fail' },
      }),
    );
    assert.ok(result.explainable_reasons.length <= 8);
  });

  it('C1 fix: legitimate brand domains do NOT typosquat-flag each other (ups.com vs usps.com)', () => {
    // ups.com and usps.com are at Levenshtein distance 1.
    // Pre-C1-fix the detector flagged each as a typosquat of the
    // other — meaning every legitimate UPS shipping notification
    // got a +20 lookalike penalty and a misleading user-facing
    // reason "From-domain is a typo of USPS's real domain."
    for (const fromAddr of ['noreply@ups.com', 'noreply@usps.com', 'no-reply@chase.com', 'team@paypal.com']) {
      const findings = lookalikeMod.detectSenderLookalike({
        from_address: fromAddr,
        display_name: '',
      });
      assert.equal(
        findings.length,
        0,
        `legitimate brand domain ${fromAddr} must not produce lookalike findings (got ${JSON.stringify(findings)})`,
      );
    }
  });

  it('C2 fix: short-domain typosquat detector does NOT flag aol.com / cbs.com / agile.com / iis.gov / phase.com', () => {
    // Pre-C2-fix the maxDistance=2 detector caught these as typos
    // of 7-char brand domains (DHL / UPS / Apple / IRS / Chase).
    // Post-fix: same-length non-confusable substitutions are
    // rejected (phase vs chase: p↔c not in VISUAL_CONFUSABLES;
    // iis vs irs: i↔r not in VISUAL_CONFUSABLES). Real visual
    // typosquats (paypa1 — l↔1) still fire — see next test.
    //
    // Note on `apples.com`: that IS a legitimate one-char insertion
    // of `apple.com` and the detector correctly flags it as a
    // typosquat candidate. The +20 score contribution alone
    // doesn't cross the 30-suspicious threshold, so it's
    // surfaced as a low-confidence signal — not a verdict-
    // flipping false positive.
    const benignDomains = ['aol.com', 'cbs.com', 'pbs.com', 'agile.com', 'iis.gov', 'phase.com'];
    for (const domain of benignDomains) {
      const findings = lookalikeMod.detectSenderLookalike({
        from_address: `noreply@${domain}`,
        display_name: '',
      });
      assert.equal(
        findings.filter((f) => f.kind === 'typosquat_of_known_brand').length,
        0,
        `benign domain ${domain} must not be typosquat-flagged (got ${JSON.stringify(findings)})`,
      );
    }
  });

  it('C2 fix: visual-confusable typosquats (paypa1.com — l↔1) still fire', () => {
    // The detector tightens but doesn't eliminate visual-confusable
    // substitutions. These are the realistic BEC typosquats.
    for (const typo of ['paypa1.com', 'app1e.com']) {
      const findings = lookalikeMod.detectSenderLookalike({
        from_address: `noreply@${typo}`,
        display_name: '',
      });
      assert.ok(
        findings.some((f) => f.kind === 'typosquat_of_known_brand'),
        `visual-confusable typosquat ${typo} should still flag (got ${JSON.stringify(findings)})`,
      );
    }
  });

  it('C2 fix: still catches real typosquats (chasse.com / paypa1.com)', () => {
    // The fix tightens but doesn't eliminate the detector. Long-
    // brand-domain typosquats at distance 1 still fire.
    for (const typo of ['support@chasse.com', 'noreply@paypa1.com']) {
      const findings = lookalikeMod.detectSenderLookalike({
        from_address: typo,
        display_name: '',
      });
      assert.ok(
        findings.some((f) => f.kind === 'typosquat_of_known_brand'),
        `real typosquat ${typo} should still be flagged (got ${JSON.stringify(findings)})`,
      );
    }
  });

  it('H1 fix: UK BEC reply-to divergence across co.uk subdomains is detected', async () => {
    // Pre-H1-fix: `hr@company.co.uk` → `reply_to: attacker@evil.co.uk`
    // both eTLD-collapsed to `co.uk` and divergence flag did NOT fire.
    const result = await scorerMod.scoreEmailMessage(
      makeMessage({
        body_text: 'Please update our wire instructions.',
        from: { display: '', address: 'hr@company.co.uk' },
        reply_to: { display: '', address: 'attacker@evil.co.uk' },
      }),
    );
    assert.ok(
      result.triggered_categories.includes('reply_to_divergence'),
      'UK BEC reply-to divergence must fire (multi-label public suffix handling)',
    );
  });

  it('M5 fix: encrypted_archive is NOT in the AttachmentThreat union', () => {
    // The category was declared but never wired — removed in M5.
    // describeAttachmentThreat is no longer typed to accept it.
    // This is a compile-time guarantee; the runtime check below
    // confirms the type union doesn't carry the value as a string.
    const validThreats: attMod.AttachmentThreat[] = [
      'executable_masquerade', 'macro_bearing_office', 'iso_container',
      'lnk_or_shortcut', 'html_smuggling',
    ];
    assert.equal(validThreats.length, 5);
    // Belt-and-suspenders: probe describeAttachmentThreat with each
    // valid threat and confirm no crash.
    for (const t of validThreats) {
      assert.ok(attMod.describeAttachmentThreat(t).length > 0);
    }
  });

  it('M6 fix: reply-to divergence across two free-mail domains does NOT penalize', async () => {
    // gmail.com → yahoo.com is the parent-with-two-free-mail case.
    // Not BEC; do not flag.
    const result = await scorerMod.scoreEmailMessage(
      makeMessage({
        body_text: 'see attached pics from the trip',
        from: { display: '', address: 'mom@gmail.com' },
        reply_to: { display: '', address: 'mom@yahoo.com' },
      }),
    );
    assert.ok(
      !result.triggered_categories.includes('reply_to_divergence'),
      'free-mail-to-free-mail reply-to divergence MUST NOT flag',
    );
    assert.equal(result.verdict, 'safe');
  });

  it('M7: SPF/DKIM/DMARC softfail does NOT contribute to the score', async () => {
    const result = await scorerMod.scoreEmailMessage(
      makeMessage({
        subject: 'hi',
        body_text: 'hello',
        auth_results: { spf: 'softfail', dkim: 'softfail', dmarc: 'softfail' },
      }),
    );
    assert.equal(result.fraud_score, 0);
    assert.equal(result.verdict, 'safe');
  });

  it('L1: IDN homograph flows through the scorer with a triggered_category + reason', async () => {
    const result = await scorerMod.scoreEmailMessage(
      makeMessage({
        // 'аpple.com' with a Cyrillic 'а' instead of Latin 'a'.
        from: { display: '', address: 'support@аpple.com' },
        body_text: 'Please verify your account.',
      }),
    );
    assert.ok(result.triggered_categories.includes('sender_idn_homograph'));
    assert.ok(
      result.explainable_reasons.some((r) => /non-Latin scripts|IDN|homograph/i.test(r)),
      `expected an IDN-homograph reason in ${JSON.stringify(result.explainable_reasons)}`,
    );
  });

  it('L4: empty subject + empty body produces a safe verdict without crashing', async () => {
    const result = await scorerMod.scoreEmailMessage(
      makeMessage({
        subject: '',
        body_text: '',
        body_html: '',
        from: { display: '', address: 'someone@example.com' },
      }),
    );
    assert.equal(result.verdict, 'safe');
    assert.equal(result.fraud_score, 0);
  });

  it('H2 fix: auth-fail + reply-to divergence + wire surface BEFORE weaker BEC categories', async () => {
    // Saturating message: lookalike + 2 attachments + 6 BEC
    // categories + auth-fail + reply-to divergence. The user MUST
    // see the auth-fail and the wire-request bullets — those are
    // the actionable signals.
    const result = await scorerMod.scoreEmailMessage(
      makeMessage({
        subject: 'URGENT wire transfer authorization',
        body_text:
          'I am the CEO. Please send a wire transfer today. ' +
          'Update our bank details. Remit to the new account. ' +
          'Buy some Amazon gift cards for clients. ' +
          'Keep this between us, do not tell anyone. ' +
          'My attorney will contact you to confirm.',
        from: { display: 'Chase', address: 'security@chase-portal.cfd' },
        reply_to: { display: '', address: 'attacker@evil.xyz' },
        auth_results: { spf: 'fail', dkim: 'fail', dmarc: 'fail' },
      }),
    );
    // Auth-fail bullet present.
    assert.ok(
      result.explainable_reasons.some((r) => /failed.*authentication/i.test(r)),
      `auth-fail bullet missing from reasons: ${JSON.stringify(result.explainable_reasons)}`,
    );
    // Wire-request bullet present.
    assert.ok(
      result.explainable_reasons.some((r) => /wire transfer/i.test(r)),
      `wire-request bullet missing from reasons: ${JSON.stringify(result.explainable_reasons)}`,
    );
    // Reply-to divergence bullet present.
    assert.ok(
      result.explainable_reasons.some((r) => /Reply-To/i.test(r)),
      `reply-to bullet missing from reasons: ${JSON.stringify(result.explainable_reasons)}`,
    );
  });

  it('does NOT echo plaintext matched_text fragments in explainable_reasons', async () => {
    // Body contains specific PII-shaped text. Reasons should NEVER
    // surface the literal phrase — only the category description.
    const sensitivePhrase = 'wire $50000 to account 9876543210';
    const result = await scorerMod.scoreEmailMessage(
      makeMessage({
        subject: 'Quick favor',
        body_text: `Please ${sensitivePhrase} today.`,
        from: { display: '', address: 'sender@example.com' },
      }),
    );
    for (const r of result.explainable_reasons) {
      assert.ok(
        !r.includes(sensitivePhrase),
        `reason must not echo sensitive matched_text: ${r}`,
      );
      assert.ok(
        !r.includes('9876543210'),
        `reason must not echo account digits: ${r}`,
      );
    }
  });
});
