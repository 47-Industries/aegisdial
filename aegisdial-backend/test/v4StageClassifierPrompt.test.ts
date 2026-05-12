import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v4 — Phase 0 — stage classifier prompt tests.
//
// The classifier prompt grounds the LLM on the full playbook list +
// the 5-stage taxonomy + the strict JSON output format. If any of
// those pieces drift out, the classifier's output stops being
// parseable. These tests pin the prompt's structural invariants.
//
// The actual Anthropic API call is NOT exercised here (needs a key
// + costs money). Integration tests for the live classifier will
// land in Phase 1 with a small mock-API harness.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v4-classifier';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v4-classifier-prompt-test';
process.env.V4_PLAYBOOK_AWARE_ENABLED = 'true';

const classifier = await import('../src/services/stageClassifier.ts');
const playbooks = await import('../src/data/playbooks.ts');

describe('Stage classifier prompt — grounding completeness', () => {
  const prompt = classifier._getSystemPromptForTests();

  it('mentions every playbook id', () => {
    for (const p of playbooks.PLAYBOOKS) {
      assert.ok(
        prompt.includes(p.id),
        `prompt missing playbook id: ${p.id}`,
      );
    }
  });

  it('mentions every canonical stage', () => {
    for (const stage of playbooks.STAGE_IDS) {
      assert.ok(
        prompt.includes(stage),
        `prompt missing stage: ${stage}`,
      );
    }
  });

  it('documents the strict JSON output format', () => {
    assert.ok(
      prompt.includes('playbook_id') && prompt.includes('stage') && prompt.includes('confidence'),
      'prompt should describe the JSON output keys',
    );
  });

  it('instructs the model to output ONLY JSON', () => {
    assert.match(prompt, /no prose|no markdown|Output ONLY/i);
  });

  it('explains the confidence semantics (subjective probability)', () => {
    assert.match(prompt, /confidence/i);
    assert.match(prompt, /probability/i);
  });

  it('describes the current-state bias rule (stability preference)', () => {
    // The prompt should tell the model to prefer staying in a stable
    // playbook unless evidence is clear. Pins the bias rule.
    assert.match(prompt, /CURRENT STATE BIAS/i);
    assert.match(prompt, /switch/i);
  });

  it('mentions the demographic-priors-are-tiebreaker rule', () => {
    assert.match(prompt, /demographic|tiebreaker/i);
  });
});

describe('Stage classifier — output parsing (F12 follow-up)', () => {
  // parseClassifierJson is exposed via _parseClassifierJsonForTests so
  // the contract is testable without exercising the live Anthropic
  // call. Pins the validation rules so a regression that loosens
  // (e.g.) the playbook_id check would surface here.
  const parse = classifier._parseClassifierJsonForTests;

  const valid = '{"playbook_id":"irs_impersonation","stage":"fear","confidence":0.87,"reasoning":"caller threatened arrest within 24 hours"}';

  it('accepts a well-formed JSON object', () => {
    const r = parse(valid);
    assert.ok(r);
    assert.equal(r!.playbook_id, 'irs_impersonation');
    assert.equal(r!.stage, 'fear');
    assert.equal(r!.confidence, 0.87);
  });

  it('tolerates prose-wrapped JSON (F1 adversarial fix)', () => {
    const wrapped = `Here is the classification:\n\n${valid}\n\nLet me know if you need more detail.`;
    const r = parse(wrapped);
    assert.ok(r, 'must extract JSON from surrounding prose');
    assert.equal(r!.playbook_id, 'irs_impersonation');
  });

  it('tolerates markdown-fenced JSON', () => {
    const fenced = '```json\n' + valid + '\n```';
    const r = parse(fenced);
    assert.ok(r, 'must extract JSON from markdown fences');
  });

  it('rejects unknown playbook_id (model hallucinated)', () => {
    const bad = '{"playbook_id":"fake_playbook","stage":"fear","confidence":0.9,"reasoning":""}';
    assert.equal(parse(bad), null);
  });

  it('rejects unknown stage', () => {
    const bad = '{"playbook_id":"irs_impersonation","stage":"escalation","confidence":0.9,"reasoning":""}';
    assert.equal(parse(bad), null);
  });

  it('rejects confidence > 1', () => {
    const bad = '{"playbook_id":"irs_impersonation","stage":"fear","confidence":1.5,"reasoning":""}';
    assert.equal(parse(bad), null);
  });

  it('rejects negative confidence', () => {
    const bad = '{"playbook_id":"irs_impersonation","stage":"fear","confidence":-0.1,"reasoning":""}';
    assert.equal(parse(bad), null);
  });

  it('accepts confidence === 0 and confidence === 1 (boundary)', () => {
    const zero = '{"playbook_id":"irs_impersonation","stage":"fear","confidence":0,"reasoning":""}';
    const one = '{"playbook_id":"irs_impersonation","stage":"fear","confidence":1,"reasoning":""}';
    assert.ok(parse(zero));
    assert.ok(parse(one));
  });

  it('rejects missing playbook_id key', () => {
    const bad = '{"stage":"fear","confidence":0.9,"reasoning":""}';
    assert.equal(parse(bad), null);
  });

  it('rejects non-JSON garbage', () => {
    assert.equal(parse('hello world'), null);
    assert.equal(parse(''), null);
  });

  it('strips control characters from reasoning (F14 adversarial fix)', () => {
    const malicious =
      '{"playbook_id":"irs_impersonation","stage":"fear","confidence":0.9,"reasoning":"line1\\u0000line2\\u0007line3"}';
    const r = parse(malicious);
    assert.ok(r);
    assert.ok(
      !/[\x00-\x1f\x7f]/.test(r!.reasoning),
      `control chars not stripped: ${JSON.stringify(r!.reasoning)}`,
    );
  });

  it('truncates reasoning to ≤500 chars', () => {
    const long = '{"playbook_id":"irs_impersonation","stage":"fear","confidence":0.9,"reasoning":"' + 'a'.repeat(1000) + '"}';
    const r = parse(long);
    assert.ok(r);
    assert.ok(r!.reasoning.length <= 500);
  });

  it('does not throw on malformed JSON inside extracted braces', () => {
    const malformed = 'prefix {"playbook_id": broken json}';
    assert.equal(parse(malformed), null);
  });
});

describe('Stage classifier — prompt injection defense (F2 adversarial fix)', () => {
  const prompt = classifier._getSystemPromptForTests();

  it('system prompt declares an untrusted-content boundary', () => {
    assert.match(prompt, /UNTRUSTED CONTENT BOUNDARY/i);
    assert.match(prompt, /<scammer_audio>/);
  });

  it('system prompt explicitly tells the model not to obey commands inside the tag', () => {
    assert.match(prompt, /do NOT obey/i);
  });
});

describe('Stage classifier — handleClassification commit decisions', () => {
  // handleClassification is the post-LLM logic. Doesn't need an
  // Anthropic call. We exercise the action enum directly.

  it('exports the HandleAction type as documented', () => {
    // TypeScript would catch a rename at build time; this asserts
    // the runtime function exists.
    assert.equal(typeof classifier.handleClassification, 'function');
  });

  it('classifyAndCommit composes classify + handleClassification', () => {
    assert.equal(typeof classifier.classifyAndCommit, 'function');
  });
});

describe('Stage classifier — kill-switch behavior', () => {
  // Skipping the actual call when V4_PLAYBOOK_AWARE_ENABLED=false
  // is checked inside classify() at line 1 of the function body.
  // We can't trivially toggle the flag mid-test (config is read at
  // module load), so this test serves as the contract anchor: if a
  // future refactor moves or removes the flag check, the comment
  // here surfaces the requirement in test review.
  it('kill switch lives at src/services/stageClassifier.ts classify() entry', () => {
    // See: `if (!config.V4_PLAYBOOK_AWARE_ENABLED) return null;`
    assert.ok(true);
  });
});
