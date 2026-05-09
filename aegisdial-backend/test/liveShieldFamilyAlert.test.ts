import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';

// Dynamic import — deferred until AFTER env setup.
const { buildAlertPayload } = await import('../src/services/liveShieldFamilyAlert.ts');
type PrivacyLevel = Awaited<ReturnType<typeof import('../src/services/liveShieldFamilyAlert.ts')['getFamilyAlertPrivacyLevel']>>;

// liveShieldFamilyAlert — payload-shaping tests. The privacy guarantee
// of v2 is that Mom controls what her family sees; if buildAlertPayload
// leaks fields outside the chosen level, the guarantee breaks. These
// tests pin the contract.

const SAMPLE_INPUT = {
  session_id: 's-123',
  subject_user_id: 'u-456',
  risk_score: 87,
  scam_type: 'irs_impersonation',
  matched_red_flags: [
    'IRS / tax warrant threat',
    'Asked to pay with gift cards',
    'Asked you to share your screen',
    'Authority impersonation pattern',
    'Time pressure / urgency',
    'Sixth flag that should not appear',
  ],
};

describe('buildAlertPayload', () => {
  describe('minimal level (most private)', () => {
    const result = buildAlertPayload(SAMPLE_INPUT, 'minimal');

    it('shows risk score and scam type only in body', () => {
      assert.match(result.body, /87\/100/);
      assert.match(result.body, /Irs Impersonation/);
    });

    it('does NOT include matched red flags in body', () => {
      assert.equal(result.body.includes('gift cards'), false);
      assert.equal(result.body.includes('warrant'), false);
    });

    it('payload contains risk_score and scam_type but NO matched_red_flags', () => {
      assert.equal(result.payload.risk_score, 87);
      assert.equal(result.payload.scam_type, 'irs_impersonation');
      assert.equal('matched_red_flags' in result.payload, false);
    });

    it('payload privacy_level is minimal', () => {
      assert.equal(result.payload.privacy_level, 'minimal');
    });

    it('payload does NOT include transcript_view_available', () => {
      assert.equal('transcript_view_available' in result.payload, false);
    });
  });

  describe('default level (middle ground)', () => {
    const result = buildAlertPayload(SAMPLE_INPUT, 'default');

    it('body includes top 3 red flags', () => {
      assert.match(result.body, /IRS \/ tax warrant threat/);
      assert.match(result.body, /gift cards/i);
    });

    it('body does NOT include the 4th, 5th, or 6th flag', () => {
      assert.equal(result.body.includes('Authority impersonation'), false);
      assert.equal(result.body.includes('Time pressure'), false);
      assert.equal(result.body.includes('Sixth flag'), false);
    });

    it('payload includes top 5 red flags but NOT the 6th', () => {
      assert.equal(Array.isArray(result.payload.matched_red_flags), true);
      const flags = result.payload.matched_red_flags as string[];
      assert.equal(flags.length, 5);
      assert.equal(flags.includes('Sixth flag that should not appear'), false);
    });

    it('payload does NOT include transcript_view_available', () => {
      assert.equal('transcript_view_available' in result.payload, false);
    });

    it('payload privacy_level is default', () => {
      assert.equal(result.payload.privacy_level, 'default');
    });
  });

  describe('open level (maximum context)', () => {
    const result = buildAlertPayload(SAMPLE_INPUT, 'open');

    it('payload includes transcript_view_available flag', () => {
      assert.equal(result.payload.transcript_view_available, true);
    });

    it('payload includes top 5 red flags', () => {
      const flags = result.payload.matched_red_flags as string[];
      assert.equal(flags.length, 5);
    });

    it('body invites family to tap for live view', () => {
      assert.match(result.body, /Tap to view/i);
    });

    it('payload does NOT contain the raw transcript text directly', () => {
      // We never put the raw transcript in the push payload — it's a
      // size + lockscreen-leak risk. The iOS app fetches the transcript
      // from the API with its own auth.
      const json = JSON.stringify(result.payload);
      assert.equal(json.includes('transcript_text'), false);
      assert.equal(json.includes('text_ct'), false);
    });

    it('payload privacy_level is open', () => {
      assert.equal(result.payload.privacy_level, 'open');
    });
  });

  describe('cross-level invariants', () => {
    const levels: PrivacyLevel[] = ['minimal', 'default', 'open'];

    it('title is identical across all levels (lockscreen-safe, name-free)', () => {
      const titles = levels.map((l) => buildAlertPayload(SAMPLE_INPUT, l).title);
      assert.equal(new Set(titles).size, 1);
      // No PII in the title — the iOS push handler injects "Mom" client-side
      assert.equal(titles[0]!.includes('subject_user'), false);
    });

    it('every level includes session_id and subject_user_id (so iOS can deep link)', () => {
      for (const level of levels) {
        const r = buildAlertPayload(SAMPLE_INPUT, level);
        assert.equal(r.payload.session_id, 's-123');
        assert.equal(r.payload.subject_user_id, 'u-456');
      }
    });

    it('every level kind is "live_shield_critical"', () => {
      for (const level of levels) {
        const r = buildAlertPayload(SAMPLE_INPUT, level);
        assert.equal(r.payload.kind, 'live_shield_critical');
      }
    });

    it('handles empty matched_red_flags gracefully', () => {
      const empty = { ...SAMPLE_INPUT, matched_red_flags: [] };
      for (const level of levels) {
        const r = buildAlertPayload(empty, level);
        assert.ok(r.body.length > 0);
      }
    });
  });
});
