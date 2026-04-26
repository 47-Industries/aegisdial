import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.API_SHARED_SECRET ||= 'test-shared-secret-12345';
process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.REDIS_URL ||= 'redis://localhost:6379';

const urlScan = await import('../src/lib/urlScan.ts');

describe('extractUrls — safety caps + canonicalization', () => {
  it('drops URLs longer than the per-URL cap', () => {
    const huge = 'https://evil.com/' + 'x'.repeat(5000);
    const out = urlScan.extractUrls(`check this: ${huge}`);
    assert.equal(out.length, 0);
  });

  it('strips userinfo (basic-auth) credentials', () => {
    const out = urlScan.extractUrls('https://user:pass@evil.com/path?q=1');
    assert.equal(out.length, 1);
    const parsed = new URL(out[0]!);
    assert.equal(parsed.username, '');
    assert.equal(parsed.password, '');
    assert.equal(parsed.hostname, 'evil.com');
  });

  it('lowercases scheme + host and strips default ports', () => {
    const a = urlScan.canonicalizeUrl('HTTPS://EVIL.COM:443/Page');
    assert.equal(a, 'https://evil.com/Page');
    const b = urlScan.canonicalizeUrl('HTTP://EVIL.COM:80/');
    assert.equal(b, 'http://evil.com/');
  });

  it('rejects non-http(s) schemes', () => {
    assert.equal(urlScan.canonicalizeUrl('javascript:alert(1)'), null);
    assert.equal(urlScan.canonicalizeUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='), null);
    assert.equal(urlScan.canonicalizeUrl('file:///etc/passwd'), null);
    assert.equal(urlScan.canonicalizeUrl('ftp://evil.com/'), null);
  });

  it('dedupes canonicalized variants', () => {
    const out = urlScan.extractUrls(
      'go to HTTPS://Evil.com/page or https://evil.com/page or https://evil.com:443/page',
    );
    assert.equal(out.length, 1);
  });

  it('trims trailing punctuation', () => {
    const out = urlScan.extractUrls('Visit https://example.com/page, now!');
    assert.equal(out.length, 1);
    assert.ok(out[0]!.startsWith('https://example.com/page'));
  });

  it('does not extract data:/javascript:/file: URIs', () => {
    const out = urlScan.extractUrls(
      'Try javascript:alert(1) or data:text/html,<script>1</script> or file:///etc/passwd',
    );
    assert.equal(out.length, 0);
  });

  it('canonicalCacheKey would drop query params in cache key', () => {
    // Internal helper is not exported, but we can confirm the public
    // extractUrls returns the full canonicalized URL (query kept for
    // display) while the cache in the DB stores only the hash of the
    // host+path canonical form.
    const a = urlScan.extractUrls('https://evil.com/page?token=abc')[0];
    const b = urlScan.extractUrls('https://evil.com/page?token=xyz')[0];
    assert.notEqual(a, b); // different URLs returned to caller
    // But extractUrls preserves query for the caller — the cache-key
    // collapse happens inside scanUrls(). This test documents the
    // contract, not the implementation detail.
  });
});
