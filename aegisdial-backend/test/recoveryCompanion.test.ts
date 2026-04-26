import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Covers the two safety-critical pure-ish surfaces of the Recovery
// Companion:
//   1. detectCrisisLanguage — regex pre-filter that pivots self-harm
//      input to the 988 canned reply BEFORE the model ever sees it.
//   2. sanitizeModelOutput — strips tel:/mailto:/data: URIs and
//      markdown link syntax from model output so a hallucinated phone
//      number or link can't render as a tappable target in the iOS
//      SwiftUI Text view.
//
// `sanitizeModelOutput` is not exported, so we exercise it through
// `generateCompanionReply` by stubbing global fetch to return a
// payload that contains the offending substrings and asserting the
// final reply has been scrubbed. The fake fetch also proves we never
// hit Anthropic from the test.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://companion-test';
// Force the code path that goes through the Anthropic fetch + sanitize
// pipeline instead of short-circuiting to the canned fallback.
process.env.ANTHROPIC_API_KEY ||= 'sk-ant-test-dummy';

const companion = await import('../src/services/recoveryCompanion.ts');

describe('detectCrisisLanguage', () => {
  // Table-driven coverage of the regexes that must fire on self-harm
  // / suicidal phrasing, plus a benign control. If any of these
  // classifications flip, the 988 escape hatch silently breaks.
  const table: Array<{ input: string; expect: boolean; label: string }> = [
    { input: 'i want to kill myself',      expect: true,  label: 'kill myself' },
    { input: 'thinking about suicide',     expect: true,  label: 'suicide' },
    { input: 'no reason to live',          expect: true,  label: 'no reason to live' },
    { input: 'i might hurt myself',        expect: true,  label: 'hurt myself' },
    { input: 'normal message — just tired', expect: false, label: 'benign control' },
  ];

  for (const row of table) {
    it(`returns ${row.expect} for "${row.label}"`, () => {
      assert.equal(companion.detectCrisisLanguage(row.input), row.expect);
    });
  }
});

describe('sanitizeModelOutput (via generateCompanionReply)', () => {
  // Preserve the real fetch so other tests in the same process (if
  // run-together) aren't affected. `after` restores it.
  const realFetch = globalThis.fetch;

  before(() => {
    // The model output includes:
    //  - a markdown link with a tel: target ([the FBI](tel:+18005551234))
    //  - a markdown link with a mailto: target ([them](mailto:fbi@gov.com))
    // The sanitizer must collapse the markdown to the link label AND
    // then redact the bare URIs. Neither `tel:` nor `mailto:` should
    // appear in the final reply.
    const stubbed = async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text:
                'Call [the FBI](tel:+18005551234) or email ' +
                '[them](mailto:fbi@gov.com) for help.',
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    (globalThis as unknown as { fetch: typeof fetch }).fetch = stubbed as unknown as typeof fetch;
  });

  after(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
  });

  it('strips tel: and mailto: URIs from the model reply', async () => {
    const ctx: import('../src/services/recoveryCompanion.ts').CompanionSessionContext = {
      mode: 'recovery',
      scamType: 'irs_impersonation',
      scamTypeDescription: 'Someone pretending to be from the IRS',
      amountLostUSD: null,
      sessionStartedAt: new Date(),
      openStepKeys: [],
      completedStepKeys: [],
      nextStepTitle: null,
      nextStepBody: null,
      hasFamilyPlan: false,
      hasNamedGuardian: false,
      userDisplayName: null,
    };

    const reply = await companion.generateCompanionReply(ctx, [], 'what do I do next');
    assert.equal(reply.crisisDetected, false);
    // tel: and mailto: are the two URI schemes that turn text into a
    // tappable out-of-app target on iOS. Neither must survive.
    assert.ok(!/tel:/i.test(reply.text), 'tel: URI must be stripped');
    assert.ok(!/mailto:/i.test(reply.text), 'mailto: URI must be stripped');
    // The markdown `[label](target)` wrapper should have been reduced
    // to just the label — "the FBI" + "them" appear as plain text.
    assert.ok(/the FBI/.test(reply.text), 'markdown label should remain');
    assert.ok(/them/.test(reply.text), 'markdown label should remain');
  });
});
