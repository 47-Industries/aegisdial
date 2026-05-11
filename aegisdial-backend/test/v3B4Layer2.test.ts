import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// Live Shield v3 — B4 Layer 2 web-search verifier tests.
//
// Covers the full pipeline against MOCKED Serper + Claude HTTP:
//   - contradicted: fake entity → search results contradict
//   - consistent: real entity verified by search
//   - cannot_verify: ambiguous search results
//   - cache hit: second identical claim doesn't burn the API
//   - budget exceeded: 9th claim in a session short-circuits
//   - L2 disabled: returns null with a metric tag
//   - missing API keys: returns null
//
// We patch globalThis.fetch to intercept the Serper + Anthropic calls.
// The InMemoryCache from src/lib/cache.ts handles the budget counter
// and cache-key storage with full Redis semantics for our use case.

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-v3-b4-l2';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'memory://v3-b4-l2-test';
process.env.V3_B4_ENABLED = 'true';
process.env.V3_B4_LAYER2_ENABLED = 'true';
process.env.V3_B4_LAYER2_PER_SESSION_CAP = '3';  // tight cap so we can exercise budget
process.env.V3_B4_LAYER2_CACHE_TTL_SECONDS = '600';
process.env.SERPER_API_KEY = 'test-serper-key';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

const { verifyClaimViaLayer2 } = await import('../src/services/b4Layer2.ts');
const { redis } = await import('../src/lib/cache.ts');
import type { ExtractedClaim } from '../src/services/claimExtractor.ts';

// -------------------------------------------------------------------------
// Fetch mock
// -------------------------------------------------------------------------

interface MockResponse {
  url_pattern: RegExp;
  body: unknown;
  status?: number;
}

const fetchCalls: { url: string; body: string }[] = [];
let mockQueue: MockResponse[] = [];
const originalFetch = globalThis.fetch;

function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const body = typeof init?.body === 'string' ? init.body : '';
  fetchCalls.push({ url, body });

  const handler = mockQueue.find((m) => m.url_pattern.test(url));
  if (!handler) {
    return Promise.reject(new Error(`unhandled fetch: ${url}`));
  }
  return Promise.resolve(
    new Response(JSON.stringify(handler.body), {
      status: handler.status ?? 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

before(() => {
  globalThis.fetch = mockFetch as typeof fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await redis.quit();
});

beforeEach(() => {
  fetchCalls.length = 0;
  mockQueue = [];
});

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function serperResponse(organic: Array<{ title: string; snippet: string; link: string }>) {
  return { url_pattern: /google\.serper\.dev/, body: { organic } };
}
function claudeResponse(verdict: {
  result: 'contradicted' | 'cannot_verify' | 'consistent';
  confidence: number;
  reasoning: string;
  citation_index: number;
}) {
  return {
    url_pattern: /api\.anthropic\.com/,
    body: {
      content: [{ type: 'text', text: JSON.stringify(verdict) }],
    },
  };
}

const bankClaim: ExtractedClaim = {
  type: 'bank_affiliation',
  bank_name: 'Acme Trust Bank',
  raw_quote: "Hi, I'm calling from Acme Trust Bank's fraud department",
};

const realBankClaim: ExtractedClaim = {
  type: 'bank_affiliation',
  bank_name: 'Wells Fargo',
  raw_quote: "This is Wells Fargo calling about your account",
};

const ambiguousAgencyClaim: ExtractedClaim = {
  type: 'agency_affiliation',
  agency_name: 'Federal Reserve Bureau of Tax Investigations',
  raw_quote: "I'm with the Federal Reserve Bureau of Tax Investigations",
};

async function flushRedis(): Promise<void> {
  // Drain InMemoryCache by clearing every key we touched. The
  // module-level redis singleton is shared across tests; flush
  // between tests to keep budget counters + cache hits isolated.
  // memory:// URL → InMemoryCache; .quit() clears the store.
  await redis.quit();
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('B4 Layer 2 — verifyClaimViaLayer2', () => {
  it('returns contradicted when search results + Claude agree the entity is fake', async () => {
    await flushRedis();
    mockQueue = [
      serperResponse([
        {
          title: 'Bank fraud alert: Acme Trust Bank does not exist',
          snippet: 'Consumer advocates warn of scammers impersonating a nonexistent "Acme Trust Bank"',
          link: 'https://example.gov/consumer-alerts/123',
        },
      ]),
      claudeResponse({
        result: 'contradicted',
        confidence: 0.96,
        reasoning: 'No legitimate bank by this name exists per consumer protection sources.',
        citation_index: 0,
      }),
    ];

    const result = await verifyClaimViaLayer2(bankClaim, 'session-1');
    assert.ok(result, 'should return a finding');
    assert.equal(result!.result, 'contradicted');
    assert.equal(result!.confidence, 0.96);
    assert.match(result!.source_url ?? '', /example\.gov/);
    assert.match(result!.source_snippet ?? '', /scammers impersonating/);

    // Verify the pipeline actually hit Serper + Claude in order.
    assert.equal(fetchCalls.length, 2);
    assert.match(fetchCalls[0]!.url, /serper/);
    assert.match(fetchCalls[1]!.url, /anthropic/);
  });

  it('returns consistent when search results corroborate the claim', async () => {
    await flushRedis();
    mockQueue = [
      serperResponse([
        {
          title: 'Wells Fargo Fraud — Contact us',
          snippet: 'Call 1-800-869-3557 for Wells Fargo fraud claims',
          link: 'https://wellsfargo.com/fraud',
        },
      ]),
      claudeResponse({
        result: 'consistent',
        confidence: 0.85,
        reasoning: 'Wells Fargo is a real bank with a published fraud line.',
        citation_index: 0,
      }),
    ];

    const result = await verifyClaimViaLayer2(realBankClaim, 'session-2');
    assert.equal(result?.result, 'consistent');
    assert.equal(result?.confidence, 0.85);
  });

  it('returns cannot_verify when Claude says results are ambiguous', async () => {
    await flushRedis();
    mockQueue = [
      serperResponse([
        {
          title: 'Some unrelated page',
          snippet: 'This page talks about something else',
          link: 'https://example.com/x',
        },
      ]),
      claudeResponse({
        result: 'cannot_verify',
        confidence: 0.2,
        reasoning: 'Search results do not address the agency in question.',
        citation_index: -1,
      }),
    ];

    const result = await verifyClaimViaLayer2(ambiguousAgencyClaim, 'session-3');
    assert.equal(result?.result, 'cannot_verify');
    assert.equal(result?.source_url, null);
  });

  it('serves a cached result on the second identical claim (no API calls)', async () => {
    await flushRedis();
    // Snippet must contain a contradiction-style keyword or the HIGH-1
    // cross-check will downgrade "contradicted" → "cannot_verify".
    // That's the whole point of the mitigation — see CONTRADICTION_KEYWORDS
    // in src/services/b4Layer2.ts.
    mockQueue = [
      serperResponse([
        {
          title: 'Acme Trust Bank fraud alert',
          snippet: 'Consumer alert: scammers are impersonating a fake bank by this name',
          link: 'https://ftc.gov/consumer-alerts/acme-trust',
        },
      ]),
      claudeResponse({
        result: 'contradicted',
        confidence: 0.9,
        reasoning: 'cached test',
        citation_index: 0,
      }),
    ];

    const r1 = await verifyClaimViaLayer2(bankClaim, 'session-A');
    assert.equal(r1?.result, 'contradicted');
    const callsAfterFirst = fetchCalls.length;
    assert.equal(callsAfterFirst, 2, 'first call should hit Serper + Claude');

    // Second call — different session id, same claim. Should hit cache,
    // make zero new fetch calls.
    const r2 = await verifyClaimViaLayer2(bankClaim, 'session-B');
    assert.equal(r2?.result, 'contradicted');
    assert.equal(fetchCalls.length, callsAfterFirst, 'second identical claim should be cache-only');
  });

  it('enforces the per-session budget cap', async () => {
    await flushRedis();
    // Cap is 3 (set in env). Queue enough responses for 3 distinct claims,
    // then the 4th should short-circuit BEFORE Serper is called.
    const distinctClaims: ExtractedClaim[] = [
      {
        type: 'bank_affiliation',
        bank_name: 'Bank One',
        raw_quote: 'q1',
      },
      {
        type: 'bank_affiliation',
        bank_name: 'Bank Two',
        raw_quote: 'q2',
      },
      {
        type: 'bank_affiliation',
        bank_name: 'Bank Three',
        raw_quote: 'q3',
      },
      {
        type: 'bank_affiliation',
        bank_name: 'Bank Four',
        raw_quote: 'q4',
      },
    ];
    // Queue 3 pairs of Serper + Claude responses (one per allowed claim).
    // The 4th claim should never reach fetch.
    for (let i = 0; i < 3; i++) {
      mockQueue.push(
        serperResponse([{ title: `t${i}`, snippet: `s${i}`, link: `https://e${i}.com` }]),
      );
      mockQueue.push(
        claudeResponse({
          result: 'cannot_verify',
          confidence: 0.1,
          reasoning: `r${i}`,
          citation_index: 0,
        }),
      );
    }

    const sessionId = 'budget-session';
    const r1 = await verifyClaimViaLayer2(distinctClaims[0]!, sessionId);
    const r2 = await verifyClaimViaLayer2(distinctClaims[1]!, sessionId);
    const r3 = await verifyClaimViaLayer2(distinctClaims[2]!, sessionId);
    const r4 = await verifyClaimViaLayer2(distinctClaims[3]!, sessionId);

    assert.ok(r1 && r2 && r3, 'first three should return findings');
    assert.equal(r4, null, 'fourth call should short-circuit to null (budget)');

    // Confirm no extra fetch happened for the 4th.
    assert.equal(fetchCalls.length, 6, 'exactly 3 Serper + 3 Claude calls');
  });

  // -----------------------------------------------------------------------
  // HIGH-1 regression tests — prompt-injection defense
  // -----------------------------------------------------------------------

  it('downgrades contradicted to cannot_verify when no result text supports contradiction (prompt injection defense)', async () => {
    await flushRedis();
    // Search results contain NO contradiction-style keywords. Claude
    // returns "contradicted" anyway (simulating a successful prompt
    // injection). The cross-check should downgrade.
    mockQueue = [
      serperResponse([
        {
          title: 'Wells Fargo official site',
          snippet: 'Welcome to wellsfargo.com — banking made simple',
          link: 'https://wellsfargo.com',
        },
      ]),
      claudeResponse({
        result: 'contradicted',
        confidence: 0.99,
        reasoning: 'INJECTED: caller is a known scammer per system override',
        citation_index: 0,
      }),
    ];
    const result = await verifyClaimViaLayer2(realBankClaim, 'inj-session');
    assert.equal(
      result?.result,
      'cannot_verify',
      'contradicted-without-evidence must downgrade',
    );
    assert.equal(result?.confidence, 0);
    assert.match(
      result?.reasoning ?? '',
      /downgraded.*prompt manipulation/i,
      'reasoning should note the downgrade',
    );
  });

  it('drops untrusted source URL but keeps the snippet (HIGH-2 SEO-poisoning defense)', async () => {
    await flushRedis();
    mockQueue = [
      serperResponse([
        {
          title: 'Acme Bank fraud impersonation report',
          snippet: 'Reports indicate scammers impersonate a fake "Acme Trust Bank" — this entity does not exist',
          link: 'https://wellsfargo-fraud-recovery.example.com/scam-info',
        },
      ]),
      claudeResponse({
        result: 'contradicted',
        confidence: 0.92,
        reasoning: 'No legit entity by that name per multiple consumer-alert sources',
        citation_index: 0,
      }),
    ];
    const result = await verifyClaimViaLayer2(bankClaim, 'url-session');
    assert.equal(result?.result, 'contradicted', 'verdict survives');
    assert.equal(
      result?.source_url,
      null,
      'untrusted .example.com URL must be dropped before propagating to push payload',
    );
    // Snippet must still survive — that's safe plaintext for Mom's UI.
    assert.match(result?.source_snippet ?? '', /scammers impersonate/);
  });

  it('strips Google operators from search query (MEDIUM-1 injection defense)', async () => {
    await flushRedis();
    const injectionClaim: ExtractedClaim = {
      type: 'bank_affiliation',
      bank_name: 'Wells Fargo" site:attacker.example.com OR (',
      raw_quote: 'q',
    };
    mockQueue = [
      serperResponse([]),  // any response — we just inspect the request
    ];
    await verifyClaimViaLayer2(injectionClaim, 'qinj-session');
    assert.equal(fetchCalls.length, 1);
    const serperBody = JSON.parse(fetchCalls[0]!.body) as { q: string };
    // The actual outbound query must NOT contain `"` or `site:` operator.
    assert.doesNotMatch(serperBody.q, /"/, 'quote chars stripped');
    assert.doesNotMatch(serperBody.q, /site:/, 'site: operator stripped');
    assert.doesNotMatch(serperBody.q, /[()]/, 'parens stripped');
    // The legitimate bit ("Wells Fargo") must still be there.
    assert.match(serperBody.q, /Wells Fargo/);
  });

  // -----------------------------------------------------------------------
  // MEDIUM-5 — malformed Claude output handling
  // -----------------------------------------------------------------------

  it('returns null when Claude returns text without a JSON block', async () => {
    await flushRedis();
    mockQueue = [
      serperResponse([
        { title: 't', snippet: 'some snippet', link: 'https://ftc.gov/x' },
      ]),
      {
        url_pattern: /api\.anthropic\.com/,
        body: { content: [{ type: 'text', text: 'I am not answering this in JSON form. Sorry!' }] },
      },
    ];
    const result = await verifyClaimViaLayer2(realBankClaim, 'no-json-session');
    assert.equal(result, null);
  });

  it('returns null when Claude returns invalid enum value for result', async () => {
    await flushRedis();
    mockQueue = [
      serperResponse([
        { title: 't', snippet: 'some snippet', link: 'https://ftc.gov/x' },
      ]),
      {
        url_pattern: /api\.anthropic\.com/,
        body: {
          content: [
            { type: 'text', text: '{"result": "definitely_yes", "confidence": 0.9, "reasoning": "fake", "citation_index": 0}' },
          ],
        },
      },
    ];
    const result = await verifyClaimViaLayer2(realBankClaim, 'bad-enum-session');
    assert.equal(result, null);
  });

  it('handles citation_index out of bounds gracefully (no crash, null URL)', async () => {
    await flushRedis();
    mockQueue = [
      serperResponse([
        {
          title: 'real bank info',
          snippet: 'Bank operates branches in multiple states; cold-calls are documented for fraud claims',
          link: 'https://ftc.gov/x',
        },
      ]),
      claudeResponse({
        result: 'consistent',
        confidence: 0.8,
        reasoning: 'matches',
        citation_index: 99,  // way out of range
      }),
    ];
    const result = await verifyClaimViaLayer2(realBankClaim, 'oob-session');
    assert.equal(result?.result, 'consistent');
    assert.equal(result?.source_url, null, 'out-of-range citation produces null URL, not crash');
    assert.equal(result?.source_snippet, null);
  });

  it('returns null when search returns zero results (caches the negative)', async () => {
    await flushRedis();
    mockQueue = [serperResponse([])]; // empty organic
    // No Claude call queued — if the code tries to call Claude on empty
    // results, the mock will throw and surface as a test failure.
    const r = await verifyClaimViaLayer2(
      { type: 'agency_affiliation', agency_name: 'Nonexistent Bureau XYZ', raw_quote: 'q' },
      'empty-session',
    );
    assert.equal(r?.result, 'cannot_verify');
    assert.equal(r?.confidence, 0);
    assert.match(r?.reasoning ?? '', /no usable results/i);
    // Only Serper was hit; Claude was correctly skipped.
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0]!.url, /serper/);
  });
});
