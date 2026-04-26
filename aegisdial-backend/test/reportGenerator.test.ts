import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// IMPORTANT: tests import from src and therefore trigger config.ts, which
// requires DATA_ENCRYPTION_KEY and a handful of other env vars. We set them
// here before any src import happens (node --test loads files top-down).
process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';

const {
  generateFtcReport,
  generateIc3Report,
} = await import('../src/services/reportGenerator.ts');

import type { ReportContext, EvidenceItem } from '../src/services/reportGenerator.ts';

// A stable date the tests assert against. Using UTC noon so formatting
// cannot be affected by whichever timezone `node --test` happens to
// inherit from the shell.
const SESSION_DATE = new Date(Date.UTC(2026, 3, 19, 12, 0, 0)); // April 19, 2026

function baseCtx(overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    scamNumber: null,
    scamType: 'generic',
    amountLostUSD: null,
    description: null,
    evidenceSummary: [],
    sessionStartedAt: SESSION_DATE,
    userDisplayName: null,
    userEmail: null,
    ...overrides,
  };
}

describe('generateFtcReport', () => {
  it('pig_butchering + $50k still omits FFKC from FTC narrative (FFKC is IC3-only)', () => {
    const ctx = baseCtx({
      scamNumber: '+15551234567',
      scamType: 'pig_butchering',
      amountLostUSD: 50000,
      userDisplayName: 'Kyle Rivers',
      userEmail: 'kyle@example.com',
    });
    const report = generateFtcReport(ctx);
    assert.equal(report.agency, 'ftc');
    assert.equal(report.url, 'https://reportfraud.ftc.gov');
    // FTC narrative must NOT mention FFKC — that's an FBI IC3 program.
    assert.ok(
      !/FFKC|Financial Fraud Kill Chain/.test(report.narrative),
      `FTC narrative should not contain FFKC, got: ${report.narrative}`,
    );
    assert.ok(/pig-butchered|long-term investment relationship/i.test(report.narrative));
    assert.ok(report.narrative.includes('$50,000'));
  });

  it('bank_impersonation with phone + evidence surfaces every evidence item in fields', () => {
    const evidence: EvidenceItem[] = [
      {
        kind: 'amount',
        payload: { amount_cents: 1_250_000 },
        createdAt: SESSION_DATE,
      },
      {
        kind: 'account',
        payload: { bank: 'Chase', last4: '4321' },
        createdAt: SESSION_DATE,
      },
      {
        kind: 'transaction',
        payload: { hash: 'WIRE-REF-998877', amount_usd: 12500 },
        createdAt: SESSION_DATE,
      },
      {
        kind: 'note',
        payload: { text: 'Caller told me to stay on the line and not tell the teller.' },
        createdAt: SESSION_DATE,
      },
    ];
    const ctx = baseCtx({
      scamNumber: '+18005551234',
      scamType: 'bank_impersonation',
      amountLostUSD: 12500,
      description: 'Caller spoofed the number on the back of my debit card.',
      evidenceSummary: evidence,
      userDisplayName: 'Test User',
      userEmail: 'test@example.com',
    });
    const report = generateFtcReport(ctx);

    // Every evidence item should appear as its own row in fields.
    const evidenceFields = report.fields.filter((f) => f.label.startsWith('Evidence —'));
    assert.equal(evidenceFields.length, evidence.length);
    for (const item of evidence) {
      assert.ok(
        evidenceFields.some((f) => f.label === `Evidence — ${item.kind}`),
        `missing evidence row for kind=${item.kind}`,
      );
    }

    // Phone number flows into both the narrative and the fields checklist.
    assert.ok(report.narrative.includes('+18005551234'));
    const phoneField = report.fields.find((f) => f.label === 'Scammer phone number');
    assert.ok(phoneField);
    assert.equal(phoneField!.value, '+18005551234');

    // The FTC category field maps bank_impersonation to the FTC's business
    // impersonator bucket — not the raw scam-type slug.
    const typeField = report.fields.find((f) => f.label === 'Type of problem');
    assert.ok(typeField);
    assert.ok(typeField!.value.toLowerCase().includes('impersonator'));

    // Narrative should cite the cleaned description verbatim.
    assert.ok(report.narrative.includes('spoofed the number on the back of my debit card'));
  });

  it('formats the session date as a human-readable month/day/year (never ISO)', () => {
    const ctx = baseCtx({ scamType: 'generic' });
    const report = generateFtcReport(ctx);
    assert.ok(
      report.narrative.startsWith('On April 19, 2026,'),
      `expected narrative to start with readable date, got: ${report.narrative.slice(0, 60)}`,
    );
    // Must not contain an ISO-8601 timestamp anywhere in the narrative.
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(report.narrative), 'narrative contained an ISO timestamp');
    const dateField = report.fields.find((f) => f.label === 'Date of incident');
    assert.ok(dateField);
    assert.equal(dateField!.value, 'April 19, 2026');
  });

  it('empty context (all fields null) does not throw and produces a sane narrative', () => {
    const ctx = baseCtx();
    const report = generateFtcReport(ctx);
    assert.equal(typeof report.narrative, 'string');
    assert.ok(report.narrative.length > 0);
    // With no scam number, the opener should reference "an unknown number".
    assert.ok(report.narrative.includes('an unknown number'));
    // With no amount, there must be no stray dollar sign.
    assert.ok(!/\$\s*(?:0(?:\.00)?|null|undefined)/.test(report.narrative));
    // Contact line must be absent when we have no name/email.
    assert.ok(!report.narrative.includes('Contact:'));
    // Fields still render with sensible placeholders.
    const amountField = report.fields.find((f) => f.label === 'Amount lost (USD)');
    assert.ok(amountField);
    assert.equal(amountField!.value, 'None / unknown');
  });
});

describe('generateIc3Report', () => {
  it('generic scam with no amount produces no amount line in narrative', () => {
    const ctx = baseCtx({ scamType: 'generic' });
    const report = generateIc3Report(ctx);
    assert.equal(report.agency, 'ic3');
    assert.equal(report.url, 'https://www.ic3.gov/Home/FileComplaint');
    // The "I lost approximately $..." sentence should be absent.
    assert.ok(!/I lost approximately \$/.test(report.narrative));
    // And no FFKC paragraph (no amount to evaluate).
    assert.ok(!/FFKC|Financial Fraud Kill Chain/.test(report.narrative));
  });

  it('pig_butchering + $75k triggers FFKC paragraph in IC3 narrative', () => {
    const ctx = baseCtx({
      scamType: 'pig_butchering',
      amountLostUSD: 75000,
      scamNumber: '+15557654321',
    });
    const report = generateIc3Report(ctx);
    assert.ok(/FFKC/.test(report.narrative));
    assert.ok(/Financial Fraud Kill Chain/.test(report.narrative));
    assert.ok(/72-hour recall window/.test(report.narrative));
    // And the FFKC field row appears in the checklist.
    const ffkcField = report.fields.find((f) => f.label.includes('FFKC'));
    assert.ok(ffkcField, 'expected FFKC row in IC3 fields checklist');
  });

  it('investment_scam below $50k does not trigger FFKC (threshold enforced)', () => {
    const ctx = baseCtx({
      scamType: 'investment_scam',
      amountLostUSD: 49000,
    });
    const report = generateIc3Report(ctx);
    assert.ok(!/FFKC/.test(report.narrative));
  });

  it('crypto_scam at exactly $50k triggers FFKC (boundary)', () => {
    const ctx = baseCtx({
      scamType: 'crypto_scam',
      amountLostUSD: 50000,
    });
    const report = generateIc3Report(ctx);
    assert.ok(/FFKC/.test(report.narrative));
  });

  it('romance_scam at $100k does NOT trigger FFKC (wrong scam type)', () => {
    const ctx = baseCtx({
      scamType: 'romance_scam',
      amountLostUSD: 100000,
    });
    const report = generateIc3Report(ctx);
    assert.ok(!/FFKC/.test(report.narrative));
  });
});

describe('scam-type openers', () => {
  it('unknown scam types fall through to the generic opener safely', () => {
    const ctx = baseCtx({ scamType: 'not_a_real_type_xyz' });
    const report = generateFtcReport(ctx);
    assert.ok(report.narrative.length > 0);
    assert.ok(/high-pressure tactics|false pretext/i.test(report.narrative));
  });

  it('tech_support opener mentions remote-access software', () => {
    const ctx = baseCtx({ scamType: 'tech_support' });
    const report = generateFtcReport(ctx);
    assert.ok(/remote-access/i.test(report.narrative));
  });
});
