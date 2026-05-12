import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 2 — family-alert copy enrichment tests.
//
// Pins three contracts:
//   1. buildAlertPayload accepts an optional v4 context and enriches
//      the body/payload of default + open levels with playbook blurb +
//      stage urgency cue.
//   2. Minimal level NEVER receives v4 enrichment — privacy guarantee
//      outranks pitch value, even when the flag is on.
//   3. When the flag is OFF, even a v4 context payload is dropped
//      (defense-in-depth — gates compose).

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-copy';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-copy-test';
process.env.V4_PLAYBOOK_FAMILY_ALERT_COPY_ENABLED = 'true';

const alert = await import('../src/services/liveShieldFamilyAlert.ts');
const playbooks = await import('../src/data/playbooks.ts');

const SESSION = '00000000-0000-0000-0000-000000008888';
const USER = '00000000-0000-0000-0000-00000000cccc';

const baseInput = {
  session_id: SESSION,
  subject_user_id: USER,
  risk_score: 82,
  scam_type: 'irs_impersonation',
  matched_red_flags: ['claims to be from the irs', 'demands gift card payment'],
};

describe('v4 family-alert copy — buildAlertPayload enrichment', () => {
  it('enriches default body with playbook blurb + stage urgency when v4 ctx + flag on', () => {
    const out = alert.buildAlertPayload(baseInput, 'default', {
      playbook_id: 'irs_impersonation',
      stage: 'ask',
    });
    const pb = playbooks.PLAYBOOKS_BY_ID.get('irs_impersonation')!;
    assert.ok(
      out.body.includes(pb.family_alert_blurb),
      'default body must contain the playbook blurb',
    );
    assert.ok(
      out.body.includes('asking for money RIGHT NOW'),
      'default body must contain the ask-stage urgency cue',
    );
    assert.equal(out.payload.v4_playbook_id, 'irs_impersonation');
    assert.equal(out.payload.v4_stage, 'ask');
  });

  it('enriches open body identically, plus keeps the tap-to-view affordance', () => {
    const out = alert.buildAlertPayload(baseInput, 'open', {
      playbook_id: 'bank_impersonation',
      stage: 'fear',
    });
    const pb = playbooks.PLAYBOOKS_BY_ID.get('bank_impersonation')!;
    assert.ok(out.body.includes(pb.family_alert_blurb));
    assert.ok(out.body.includes('applying pressure right now'));
    assert.ok(out.body.includes('Tap to view live.'));
    assert.equal(out.payload.v4_playbook_id, 'bank_impersonation');
  });

  it('minimal body REMAINS minimal even with v4 ctx — privacy outranks enrichment', () => {
    const out = alert.buildAlertPayload(baseInput, 'minimal', {
      playbook_id: 'irs_impersonation',
      stage: 'ask',
    });
    assert.equal(
      out.body,
      'Risk score 82/100. Pattern: Irs Impersonation.',
      'minimal body must equal the legacy minimal format',
    );
    assert.equal(out.payload.v4_playbook_id, undefined);
    assert.equal(out.payload.v4_stage, undefined);
  });

  it('legacy callers (no v4 ctx) get unenriched body', () => {
    const out = alert.buildAlertPayload(baseInput, 'default');
    // Body should match the pre-v4 format — no playbook blurb, no
    // stage urgency cue.
    assert.ok(!out.body.includes('She may be on'));
    assert.ok(!out.body.includes('RIGHT NOW'));
    assert.equal(out.payload.v4_playbook_id, undefined);
  });

  it('null v4 ctx is equivalent to missing v4 ctx', () => {
    const a = alert.buildAlertPayload(baseInput, 'default');
    const b = alert.buildAlertPayload(baseInput, 'default', null);
    assert.equal(a.body, b.body);
  });
});

describe('v4 family-alert copy — per-stage urgency cue', () => {
  // Pin the five stage-specific cues. If any are tuned, this test
  // explicitly captures the change.
  const cues: Array<{ stage: 'rapport' | 'authority' | 'fear' | 'ask' | 'close'; needle: string }> = [
    { stage: 'rapport', needle: 'early in the call' },
    { stage: 'authority', needle: 'establishing fake authority' },
    { stage: 'fear', needle: 'applying pressure right now' },
    { stage: 'ask', needle: 'asking for money RIGHT NOW' },
    { stage: 'close', needle: 'may be ending' },
  ];

  for (const { stage, needle } of cues) {
    it(`stage=${stage} cue contains the right urgency phrasing`, () => {
      const out = alert.buildAlertPayload(baseInput, 'default', {
        playbook_id: 'irs_impersonation',
        stage,
      });
      assert.ok(
        out.body.toLowerCase().includes(needle.toLowerCase()),
        `body should contain "${needle}" — got: ${out.body}`,
      );
    });
  }
});

describe('v4 family-alert copy — composeV4Enrichment shared helper', () => {
  // Both fireFamilyAlert and firePostDismissFamilyAlert call through
  // composeV4Enrichment for the v4 body suffix + payload fields. Pinning
  // the helper directly covers both paths in one place — future drift
  // between the two phrasings can't break privacy.

  it('returns null when v4 ctx is missing', () => {
    assert.equal(alert.composeV4Enrichment(null, 'may be on'), null);
    assert.equal(alert.composeV4Enrichment(undefined, 'may be on'), null);
  });

  it('returns null when playbook id is unknown', () => {
    assert.equal(
      alert.composeV4Enrichment(
        // @ts-expect-error — unknown playbook id
        { playbook_id: 'unknown_xyz', stage: 'ask' },
        'may be on',
      ),
      null,
    );
  });

  it('returns null when stage label is unknown (no "undefined" leak)', () => {
    assert.equal(
      alert.composeV4Enrichment(
        // @ts-expect-error — unknown stage label
        { playbook_id: 'irs_impersonation', stage: 'frenzy' },
        'may be on',
      ),
      null,
    );
  });

  it('returns the bodySuffix using the requested verb ("may be on")', () => {
    const out = alert.composeV4Enrichment(
      { playbook_id: 'irs_impersonation', stage: 'ask' },
      'may be on',
    );
    assert.ok(out);
    assert.ok(out!.bodySuffix.includes('She may be on'));
    assert.ok(out!.bodySuffix.includes('asking for money RIGHT NOW'));
  });

  it('returns the bodySuffix using the requested verb ("is on" — post-dismiss)', () => {
    const out = alert.composeV4Enrichment(
      { playbook_id: 'bank_impersonation', stage: 'fear' },
      'is on',
    );
    assert.ok(out);
    assert.ok(out!.bodySuffix.includes('She is on'));
    assert.ok(out!.bodySuffix.includes('applying pressure right now'));
  });

  it('payloadFields ride along with playbook_id and stage when valid', () => {
    const out = alert.composeV4Enrichment(
      { playbook_id: 'irs_impersonation', stage: 'close' },
      'is on',
    );
    assert.ok(out);
    assert.equal(out!.payloadFields.v4_playbook_id, 'irs_impersonation');
    assert.equal(out!.payloadFields.v4_stage, 'close');
  });
});

describe('v4 family-alert copy — unknown playbook id safety', () => {
  it('silently drops enrichment when playbook id is unknown', () => {
    const out = alert.buildAlertPayload(baseInput, 'default', {
      // @ts-expect-error — intentionally testing an unknown id (e.g.
      // stale data after a code rollback). The formatter should not
      // crash and should not emit a half-built body.
      playbook_id: 'unknown_xyz',
      stage: 'ask',
    });
    assert.ok(!out.body.includes('asking for money RIGHT NOW'));
    assert.ok(!out.body.includes('undefined'));
    // payload should not carry v4_playbook_id when the lookup failed.
    assert.equal(out.payload.v4_playbook_id, undefined);
  });

  // Adversarial M1 fix: an unknown stage (e.g., taxonomy change, manual
  // ops UPDATE writing a fresh label) MUST NOT emit "undefined" into
  // the push notification body. STAGE_URGENCY[stage] returning undefined
  // would template-literal-stringify into the body without this guard.
  it('silently drops enrichment when stage is unknown (no "undefined" in body)', () => {
    const out = alert.buildAlertPayload(baseInput, 'default', {
      playbook_id: 'irs_impersonation',
      // @ts-expect-error — intentionally testing an unknown stage label.
      stage: 'frenzy',
    });
    assert.ok(!out.body.includes('undefined'), `body must not include literal "undefined" — got: ${out.body}`);
    // The enrichment should not have appeared at all when the stage cue
    // misses, so the playbook blurb shouldn't be in the body either.
    assert.ok(!out.body.includes('IRS impersonation scam'));
    // Payload should not ship a half-resolved v4 reference.
    assert.equal(out.payload.v4_playbook_id, undefined);
    assert.equal(out.payload.v4_stage, undefined);
  });
});
