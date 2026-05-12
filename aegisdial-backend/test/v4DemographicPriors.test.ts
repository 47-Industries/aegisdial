import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 7 — demographic priors plumbing.
//
// Two surfaces pinned:
//
//   1. dobYearToAgeBand (src/lib/ageBand.ts) — pure helper. Bucket
//      thresholds: elderly >=65, young <30, working_adult otherwise.
//      Pre-migration / corrupt dob_year → null (caller skips priors).
//
//   2. Classifier prompts (src/services/stageClassifier.ts):
//      - System prompt embeds demographic_priors numbers per playbook
//      - System prompt's RULE #1 names USER AGE BAND as the
//        tie-break signal AND explicitly forbids demographics-alone
//        as a deciding factor
//      - User prompt injects USER AGE BAND line when flag is ON and
//        band is supplied; omits the line otherwise

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-demographic';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-demographic-test';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';
process.env.V4_PLAYBOOK_DEMOGRAPHIC_PRIORS_ENABLED = 'true';

const { dobYearToAgeBand } = await import('../src/lib/ageBand.ts');
const classifier = await import('../src/services/stageClassifier.ts');
const { config: appConfig } = await import('../src/config.ts');

describe('dobYearToAgeBand — bucket thresholds', () => {
  // Pin against an explicit reference year so test stability isn't
  // tied to wall-clock. All assertions below assume reference = 2026.
  const REF = new Date('2026-06-15T00:00:00Z');

  it('classifies dob_year=1960 (age 66 in 2026) as elderly', () => {
    assert.equal(dobYearToAgeBand(1960, REF), 'elderly');
  });

  it('classifies dob_year=1961 (age 65 in 2026, exactly at floor) as elderly', () => {
    assert.equal(dobYearToAgeBand(1961, REF), 'elderly');
  });

  it('classifies dob_year=1962 (age 64 in 2026, just under floor) as working_adult', () => {
    assert.equal(dobYearToAgeBand(1962, REF), 'working_adult');
  });

  it('classifies dob_year=1996 (age 30 in 2026) as working_adult', () => {
    assert.equal(dobYearToAgeBand(1996, REF), 'working_adult');
  });

  it('classifies dob_year=1997 (age 29 in 2026, just under 30) as young', () => {
    assert.equal(dobYearToAgeBand(1997, REF), 'young');
  });

  it('classifies dob_year=2005 (age 21 in 2026) as young', () => {
    assert.equal(dobYearToAgeBand(2005, REF), 'young');
  });
});

describe('dobYearToAgeBand — null/invalid fallback', () => {
  const REF = new Date('2026-06-15T00:00:00Z');

  it('returns null for null dob_year (pre-migration account)', () => {
    assert.equal(dobYearToAgeBand(null, REF), null);
    assert.equal(dobYearToAgeBand(undefined, REF), null);
  });

  it('returns null for non-integer dob_year', () => {
    assert.equal(dobYearToAgeBand(1985.5, REF), null);
    assert.equal(dobYearToAgeBand(NaN, REF), null);
  });

  it('returns null for out-of-range dob_year', () => {
    assert.equal(dobYearToAgeBand(1899, REF), null);
    assert.equal(dobYearToAgeBand(2101, REF), null);
  });

  it('returns null for future birth year (corruption)', () => {
    assert.equal(dobYearToAgeBand(2030, REF), null);
  });
});

describe('Classifier system prompt — demographic priors', () => {
  const prompt = classifier._getSystemPromptForTests();

  it('embeds demographic_priors numeric tuples in the playbook block', () => {
    // The system prompt should literally include the priors numbers
    // so the classifier can compare across playbooks. Stronger pin:
    // assert that bank_impersonation's exact priors tuple appears
    // near the bank_impersonation playbook id (not just somewhere
    // else in the prompt where another playbook happens to share the
    // same numbers). The regex requires bank_impersonation: ... followed
    // by its exact (elderly, working_adult, young) tuple within the
    // same playbook block.
    // Width 1500 is enough for any playbook block (5 stages × ~150 chars
    // + description + priors line ≈ 1100 chars max). Generous to avoid
    // brittleness if a future seeds edit adds another stage phrase.
    assert.match(
      prompt,
      /bank_impersonation:[\s\S]{0,1500}elderly=0\.55 working_adult=0\.4 young=0\.05/,
      'system prompt must include bank_impersonation priors INSIDE the bank_impersonation block',
    );
    // Also assert a different playbook with different priors lands
    // its own tuple — verifies the formatter is per-playbook, not a
    // global constant accidentally written 14 times.
    assert.match(
      prompt,
      /tech_support_scam:[\s\S]{0,1500}elderly=0\.7 working_adult=0\.25 young=0\.05/,
      'system prompt must include tech_support_scam priors INSIDE its own block',
    );
  });

  it('names USER AGE BAND in the rules as the tie-break input', () => {
    assert.ok(
      prompt.includes('USER AGE BAND'),
      'system prompt must reference USER AGE BAND as the tie-break signal',
    );
  });

  it('forbids demographics-alone deciding a playbook', () => {
    // Critical privacy + correctness invariant — demographics must
    // NEVER decide a playbook without stage-specific phrasing evidence.
    assert.ok(
      /never let demographics alone decide/i.test(prompt),
      'system prompt must explicitly forbid demographics-alone decisions',
    );
  });
});

describe('Classifier user prompt — age-band injection', () => {
  // Build the user prompt via the test-only export to inspect it
  // directly without a Claude call.
  it('injects USER AGE BAND line when flag is ON and band is supplied', () => {
    const user = classifier._buildUserPromptForTests({
      session_id: 'sess-1',
      user_id: 'user-1',
      chunk_text: 'this is the irs',
      recent_context: '',
      current: { playbook_id: null, stage: null },
      user_age_band: 'elderly',
    });
    assert.ok(user.includes('USER AGE BAND: elderly'), `expected USER AGE BAND line, got: ${user.slice(0, 200)}`);
  });

  it('omits USER AGE BAND line when band is null', () => {
    const user = classifier._buildUserPromptForTests({
      session_id: 'sess-1',
      user_id: 'user-1',
      chunk_text: 'this is the irs',
      recent_context: '',
      current: { playbook_id: null, stage: null },
      user_age_band: null,
    });
    assert.ok(!user.includes('USER AGE BAND'), `expected no age-band line when null, got: ${user.slice(0, 200)}`);
  });

  it('omits USER AGE BAND line when flag is OFF even with band supplied', () => {
    const original = appConfig.V4_PLAYBOOK_DEMOGRAPHIC_PRIORS_ENABLED;
    try {
      (appConfig as { V4_PLAYBOOK_DEMOGRAPHIC_PRIORS_ENABLED: boolean }).V4_PLAYBOOK_DEMOGRAPHIC_PRIORS_ENABLED = false;
      const user = classifier._buildUserPromptForTests({
        session_id: 'sess-1',
        user_id: 'user-1',
        chunk_text: 'this is the irs',
        recent_context: '',
        current: { playbook_id: null, stage: null },
        user_age_band: 'elderly',
      });
      assert.ok(
        !user.includes('USER AGE BAND'),
        'flag OFF must omit age-band line even when band is supplied',
      );
    } finally {
      (appConfig as { V4_PLAYBOOK_DEMOGRAPHIC_PRIORS_ENABLED: boolean }).V4_PLAYBOOK_DEMOGRAPHIC_PRIORS_ENABLED = original;
    }
  });
});
