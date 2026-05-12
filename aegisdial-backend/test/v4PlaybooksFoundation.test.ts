import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 0 — playbook foundation contract tests.
//
// Pins the playbook library shape so future edits to playbooks.ts
// don't silently regress required structure (e.g. a stage missing
// expected_phrases, demographic_priors not summing to 1.0).
//
// The classifier itself (services/stageClassifier.ts) gets its own
// test file — this one covers the SEED data.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-foundation';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-foundation-test';

const playbooks = await import('../src/data/playbooks.ts');

describe('Playbook library — structural integrity', () => {
  it('has at least 12 playbooks seeded (LIVE_SHIELD_V4.md target)', () => {
    assert.ok(
      playbooks.PLAYBOOKS.length >= 12,
      `expected ≥12 playbooks, got ${playbooks.PLAYBOOKS.length}`,
    );
  });

  it('every playbook id is unique', () => {
    const ids = playbooks.PLAYBOOKS.map((p) => p.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, 'duplicate playbook ids found');
  });

  it('PLAYBOOKS_BY_ID is consistent with PLAYBOOKS', () => {
    assert.equal(playbooks.PLAYBOOKS_BY_ID.size, playbooks.PLAYBOOKS.length);
    for (const p of playbooks.PLAYBOOKS) {
      assert.strictEqual(playbooks.PLAYBOOKS_BY_ID.get(p.id), p);
    }
  });

  it('every playbook has all 5 canonical stages in order', () => {
    const expected = ['rapport', 'authority', 'fear', 'ask', 'close'];
    for (const p of playbooks.PLAYBOOKS) {
      const got = p.stages.map((s) => s.id);
      assert.deepEqual(
        got,
        expected,
        `${p.id} stages mismatch: got ${JSON.stringify(got)}`,
      );
    }
  });

  it('every stage has at least one expected_phrase', () => {
    for (const p of playbooks.PLAYBOOKS) {
      for (const s of p.stages) {
        assert.ok(
          s.expected_phrases.length > 0,
          `${p.id}.${s.id} has no expected_phrases — the classifier needs grounding`,
        );
      }
    }
  });

  it('every stage has a valid duration window [min, max]', () => {
    for (const p of playbooks.PLAYBOOKS) {
      for (const s of p.stages) {
        const [min, max] = s.typical_duration_seconds;
        assert.ok(min >= 0, `${p.id}.${s.id} min duration negative`);
        assert.ok(max > min, `${p.id}.${s.id} max <= min`);
        assert.ok(
          max <= 3600,
          `${p.id}.${s.id} max duration over 1hr — suspect copy paste`,
        );
      }
    }
  });

  it('every playbook has at least 2 counter scripts', () => {
    for (const p of playbooks.PLAYBOOKS) {
      assert.ok(
        p.counter_scripts.length >= 2,
        `${p.id} has only ${p.counter_scripts.length} counter scripts — need at least 2 for variety`,
      );
    }
  });

  it('demographic priors sum to 1.0 (±0.01)', () => {
    for (const p of playbooks.PLAYBOOKS) {
      const { elderly, working_adult, young } = p.demographic_priors;
      const sum = elderly + working_adult + young;
      assert.ok(
        Math.abs(sum - 1.0) < 0.01,
        `${p.id} demographic priors sum to ${sum}, expected 1.0`,
      );
    }
  });

  it('demographic priors are in [0, 1] range', () => {
    for (const p of playbooks.PLAYBOOKS) {
      const { elderly, working_adult, young } = p.demographic_priors;
      for (const [k, v] of Object.entries({ elderly, working_adult, young })) {
        assert.ok(v >= 0 && v <= 1, `${p.id}.${k} = ${v} out of [0,1] range`);
      }
    }
  });

  it('recovery_steps_link points to a recovery_catalog.<id> format', () => {
    for (const p of playbooks.PLAYBOOKS) {
      if (p.recovery_steps_link === null) continue;
      assert.match(
        p.recovery_steps_link,
        /^recovery_catalog\.[a-z_]+$/,
        `${p.id} recovery_steps_link format invalid: ${p.recovery_steps_link}`,
      );
    }
  });

  it('expected_phrases are non-empty strings', () => {
    for (const p of playbooks.PLAYBOOKS) {
      for (const s of p.stages) {
        for (const phrase of s.expected_phrases) {
          assert.ok(typeof phrase === 'string', `${p.id}.${s.id} non-string phrase`);
          assert.ok(
            phrase.length > 0,
            `${p.id}.${s.id} has empty phrase`,
          );
          assert.ok(
            phrase.length <= 200,
            `${p.id}.${s.id} phrase exceeds 200 chars (${phrase.length}) — suspect copy`,
          );
        }
      }
    }
  });
});

describe('Playbook library — content quality smoke', () => {
  it('IRS impersonation has a gift-card phrase in ask stage (FBI/FCC top pattern)', () => {
    const irs = playbooks.PLAYBOOKS_BY_ID.get('irs_impersonation');
    assert.ok(irs);
    const askStage = irs.stages.find((s) => s.id === 'ask');
    assert.ok(askStage);
    const hasGiftCard = askStage.expected_phrases.some(
      (p) => p.toLowerCase().includes('gift card'),
    );
    assert.ok(hasGiftCard, 'IRS ask stage should mention gift cards');
  });

  it('Bank impersonation has a "safe account" phrase (canonical script)', () => {
    const bank = playbooks.PLAYBOOKS_BY_ID.get('bank_impersonation');
    assert.ok(bank);
    const askStage = bank.stages.find((s) => s.id === 'ask');
    assert.ok(askStage);
    const hasSafeAccount = askStage.expected_phrases.some(
      (p) => p.toLowerCase().includes('safe account') || p.toLowerCase().includes('verified account'),
    );
    assert.ok(hasSafeAccount, 'bank ask stage should mention safe/verified account');
  });

  it('Tech-support scam mentions a remote-access tool by name', () => {
    const tech = playbooks.PLAYBOOKS_BY_ID.get('tech_support_scam');
    assert.ok(tech);
    const askStage = tech.stages.find((s) => s.id === 'ask');
    assert.ok(askStage);
    const tools = ['anydesk', 'teamviewer', 'logmein'];
    const hasTool = askStage.expected_phrases.some((p) =>
      tools.some((t) => p.toLowerCase().includes(t)),
    );
    assert.ok(hasTool, 'tech-support ask stage should mention a remote-access tool');
  });

  it('Grandparent scam has elderly-skewed demographic prior', () => {
    const grand = playbooks.PLAYBOOKS_BY_ID.get('grandparent_scam');
    assert.ok(grand);
    assert.ok(
      grand.demographic_priors.elderly > 0.7,
      `grandparent_scam should skew elderly: got ${grand.demographic_priors.elderly}`,
    );
  });

  it('Job-offer scam has working-adult/young skewed demographic prior', () => {
    const job = playbooks.PLAYBOOKS_BY_ID.get('job_offer_scam');
    assert.ok(job);
    assert.ok(
      job.demographic_priors.working_adult + job.demographic_priors.young > 0.7,
      'job-offer scam should skew working-adult/young',
    );
  });
});

describe('STAGE_IDS canonical list', () => {
  it('is the 5-stage taxonomy in the documented order', () => {
    assert.deepEqual(
      [...playbooks.STAGE_IDS],
      ['rapport', 'authority', 'fear', 'ask', 'close'],
    );
  });

  it('every playbook stage id is a member of STAGE_IDS', () => {
    const set = new Set<string>(playbooks.STAGE_IDS);
    for (const p of playbooks.PLAYBOOKS) {
      for (const s of p.stages) {
        assert.ok(set.has(s.id), `${p.id}.${s.id} not in canonical STAGE_IDS`);
      }
    }
  });
});
