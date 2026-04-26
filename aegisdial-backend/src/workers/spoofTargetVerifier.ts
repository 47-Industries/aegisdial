import { query } from '../lib/db.js';
import { extractPhoneNumbers } from '../crawlers/phone.js';
import { HIGH_SPOOF_TARGETS, type SpoofTargetEntry } from '../services/highSpoofTargets.js';

// Daily verifier for HIGH_SPOOF_TARGETS. For each entry that has
// `contact_urls`, fetch the page, extract US phone numbers from the HTML,
// and diff against the entry's `verified_numbers`. Record the result in
// `spoof_target_verifications` for history. Alert loudly (console.error)
// when a known number is missing from the institution's own page — that's
// the single most dangerous drift: means the registry is stale and we
// might mark a scammer-spoofed call as "trusted."
//
// Designed to run once daily. ~100 institutions × ~1 URL each = ~100 HTTP
// requests, serialized with polite delays. Typical run time: 3-5 minutes.
//
// Many banks (BoA, Wells, Citi, Amex, Truist, Ally, Schwab, and a long
// tail of Akamai/Cloudflare-protected sites) return 403/503 to plain
// `fetch()` no matter how realistic the headers look. For those we fall
// back to a real Chromium browser via Playwright. Playwright is loaded
// lazily so the verifier still runs on machines where the browser binary
// wasn't installed (`require('playwright')` throwing is treated as
// "fallback unavailable" rather than a hard error).

const FETCH_TIMEOUT_MS = 20_000;
const POLITE_DELAY_MS = 1000;
const PLAYWRIGHT_DELAY_MS = 2500;
const PLAYWRIGHT_NAV_TIMEOUT_MS = 35_000;
const PLAYWRIGHT_RENDER_WAIT_MS = 2500;
// Desktop Chrome UA on macOS — most widely accepted across anti-bot vendors.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': BROWSER_UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

export interface VerificationRow {
  target_name: string;
  target_category: string;
  contact_url: string;
  http_status: number | null;
  numbers_on_page: string[];
  numbers_expected: string[];
  numbers_verified: string[];
  numbers_drift_missing: string[];
  numbers_drift_new: string[];
  status: 'verified' | 'drift' | 'fetch_failed' | 'no_numbers_on_page';
  error_message: string | null;
  /** Which code path produced the numbers. 'fetch' = plain fetch(),
   * 'playwright' = headless Chromium fallback, 'none' = fetch failed
   * and Playwright wasn't available or also failed. */
  fetch_method: 'fetch' | 'playwright' | 'none';
}

export interface VerificationReport {
  started_at: Date;
  finished_at: Date;
  duration_ms: number;
  targets_checked: number;
  targets_skipped_no_url: number;
  rows: VerificationRow[];
  drift_count: number;
  failed_count: number;
  fetch_verified_count: number;
  playwright_verified_count: number;
}

// Minimal structural type so we don't have to import playwright types at
// the top level (keeps optional-dep graceful-degrade working).
interface BrowserLike {
  newContext(opts: { userAgent: string; viewport: { width: number; height: number } }): Promise<ContextLike>;
  close(): Promise<void>;
}
interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
interface PageLike {
  goto(url: string, opts: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<{ status(): number } | null>;
  waitForTimeout(ms: number): Promise<void>;
  content(): Promise<string>;
  close(): Promise<void>;
}

interface PlaywrightRuntime {
  browser: BrowserLike;
}

/** Lazy-load Playwright. Returns null if the module isn't installed or
 * Chromium fails to launch — caller should then skip the fallback. */
async function tryLaunchPlaywright(): Promise<PlaywrightRuntime | null> {
  try {
    // Dynamic import so bundlers / typecheck don't require playwright to
    // be present, and so a missing binary doesn't crash the whole worker.
    const mod: any = await import('playwright').catch(() => null);
    if (!mod?.chromium?.launch) {
      console.warn('[spoof-verify] playwright module not available; fallback disabled');
      return null;
    }
    const browser: BrowserLike = await mod.chromium.launch({ headless: true });
    return { browser };
  } catch (err) {
    console.warn(
      `[spoof-verify] playwright launch failed (${(err as Error).message}); fallback disabled`,
    );
    return null;
  }
}

export async function verifyAllSpoofTargets(): Promise<VerificationReport> {
  const start = new Date();
  const report: VerificationReport = {
    started_at: start,
    finished_at: start,
    duration_ms: 0,
    targets_checked: 0,
    targets_skipped_no_url: 0,
    rows: [],
    drift_count: 0,
    failed_count: 0,
    fetch_verified_count: 0,
    playwright_verified_count: 0,
  };

  // Lazily attach Playwright on first use. Many runs may not need it at
  // all (nothing bot-blocked that day), so we skip the browser launch
  // unless a fetch actually fails. Launched at most once per run.
  let pwRuntime: PlaywrightRuntime | null = null;
  let pwAttempted = false;
  const ensurePlaywright = async (): Promise<PlaywrightRuntime | null> => {
    if (pwRuntime) return pwRuntime;
    if (pwAttempted) return null;
    pwAttempted = true;
    pwRuntime = await tryLaunchPlaywright();
    return pwRuntime;
  };

  try {
    for (const target of HIGH_SPOOF_TARGETS) {
      const urls = target.contact_urls ?? [];
      if (urls.length === 0) {
        report.targets_skipped_no_url += 1;
        continue;
      }
      for (const url of urls) {
        report.targets_checked += 1;
        const row = await verifyOneUrl(target, url, ensurePlaywright);
        report.rows.push(row);
        if (row.status === 'drift') report.drift_count += 1;
        if (row.status === 'fetch_failed') report.failed_count += 1;
        if (row.status === 'verified' || row.status === 'drift') {
          if (row.fetch_method === 'playwright') report.playwright_verified_count += 1;
          else if (row.fetch_method === 'fetch') report.fetch_verified_count += 1;
        }
        await persistRow(row);
        // Heavier delay after a Playwright-path request so we don't
        // hammer anti-bot vendors (they track velocity per IP).
        await sleep(row.fetch_method === 'playwright' ? PLAYWRIGHT_DELAY_MS : POLITE_DELAY_MS);
      }
    }
  } finally {
    if (pwRuntime) {
      try {
        await pwRuntime.browser.close();
      } catch (err) {
        console.warn(`[spoof-verify] playwright close failed: ${(err as Error).message}`);
      }
    }
  }

  report.finished_at = new Date();
  report.duration_ms = report.finished_at.getTime() - start.getTime();

  if (report.drift_count > 0 || report.failed_count > 0) {
    console.error(
      `[spoof-verify] COMPLETE: fetch-verified ${report.fetch_verified_count}, ` +
        `playwright-verified ${report.playwright_verified_count}, ` +
        `drift ${report.drift_count}, failed ${report.failed_count} ` +
        `(of ${report.targets_checked} URLs checked)`,
    );
  } else {
    console.log(
      `[spoof-verify] complete: fetch-verified ${report.fetch_verified_count}, ` +
        `playwright-verified ${report.playwright_verified_count}, ` +
        `drift 0, failed 0 (${report.targets_skipped_no_url} skipped, no URL)`,
    );
  }
  return report;
}

/** Result of either a fetch or Playwright attempt. */
interface PageLoadResult {
  ok: boolean;
  httpStatus: number | null;
  html: string | null;
  error: string | null;
}

async function loadViaFetch(url: string): Promise<PageLoadResult> {
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, html: null, error: `http ${res.status}` };
    }
    const html = await res.text();
    return { ok: true, httpStatus: res.status, html, error: null };
  } catch (err) {
    return { ok: false, httpStatus: null, html: null, error: (err as Error).message };
  }
}

async function loadViaPlaywright(browser: BrowserLike, url: string): Promise<PageLoadResult> {
  let context: ContextLike | null = null;
  let page: PageLike | null = null;
  try {
    context = await browser.newContext({
      userAgent: BROWSER_UA,
      viewport: { width: 1440, height: 900 },
    });
    page = await context.newPage();
    const resp = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: PLAYWRIGHT_NAV_TIMEOUT_MS,
    });
    // Give client-side frameworks a beat to render inline phone numbers.
    await page.waitForTimeout(PLAYWRIGHT_RENDER_WAIT_MS);
    const httpStatus = resp ? resp.status() : null;
    const html = await page.content();
    const ok = httpStatus == null ? true : httpStatus >= 200 && httpStatus < 400;
    return {
      ok,
      httpStatus,
      html,
      error: ok ? null : `http ${httpStatus}`,
    };
  } catch (err) {
    return { ok: false, httpStatus: null, html: null, error: (err as Error).message };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

async function verifyOneUrl(
  target: SpoofTargetEntry,
  url: string,
  ensurePlaywright: () => Promise<PlaywrightRuntime | null>,
): Promise<VerificationRow> {
  const row: VerificationRow = {
    target_name: target.name,
    target_category: target.category,
    contact_url: url,
    http_status: null,
    numbers_on_page: [],
    numbers_expected: [...target.verified_numbers].sort(),
    numbers_verified: [],
    numbers_drift_missing: [],
    numbers_drift_new: [],
    status: 'fetch_failed',
    error_message: null,
    fetch_method: 'none',
  };

  // 1. Try plain fetch first.
  const fetchResult = await loadViaFetch(url);
  row.http_status = fetchResult.httpStatus;
  let html: string | null = null;
  let method: 'fetch' | 'playwright' | 'none' = 'none';

  if (fetchResult.ok && fetchResult.html) {
    html = fetchResult.html;
    method = 'fetch';
  } else {
    row.error_message = fetchResult.error;
  }

  // 2. If fetch failed OR returned a 200 with no phones, try Playwright.
  // We only know the "0 phones from 200" case after extracting once, so
  // handle that after extraction below. For the hard-fail case (non-OK /
  // timeout) we fall back immediately.
  if (method === 'none') {
    const pw = await ensurePlaywright();
    if (pw) {
      const pwResult = await loadViaPlaywright(pw.browser, url);
      if (pwResult.ok && pwResult.html) {
        html = pwResult.html;
        method = 'playwright';
        row.http_status = pwResult.httpStatus ?? row.http_status;
        row.error_message = null;
      } else {
        // Keep the original fetch error, but annotate that Playwright
        // also failed so it's easy to see in the report.
        const pwErr = pwResult.error ?? 'playwright unknown error';
        row.error_message = `${row.error_message ?? 'fetch failed'}; playwright: ${pwErr}`;
      }
    }
  }

  if (!html) {
    // Both paths failed (or Playwright unavailable). Record fetch_failed.
    row.status = 'fetch_failed';
    row.fetch_method = 'none';
    return row;
  }

  // 3. Extract numbers.
  let { found } = extractFromHtml(html);
  // If the fetch path returned a 200 but zero numbers, try Playwright —
  // many React/Next.js sites hide phones behind JS-rendered widgets.
  if (method === 'fetch' && found.size === 0) {
    const pw = await ensurePlaywright();
    if (pw) {
      const pwResult = await loadViaPlaywright(pw.browser, url);
      if (pwResult.ok && pwResult.html) {
        const pwExtract = extractFromHtml(pwResult.html);
        if (pwExtract.found.size > 0) {
          found = pwExtract.found;
          method = 'playwright';
          row.http_status = pwResult.httpStatus ?? row.http_status;
          row.error_message = null;
        }
      }
    }
  }

  row.fetch_method = method;
  row.numbers_on_page = [...found].sort();

  const expected = new Set(target.verified_numbers);
  row.numbers_verified = [...expected].filter((n) => found.has(n)).sort();
  row.numbers_drift_missing = [...expected].filter((n) => !found.has(n)).sort();
  row.numbers_drift_new = [...found].filter((n) => !expected.has(n)).sort();

  if (row.numbers_on_page.length === 0) {
    row.status = 'no_numbers_on_page';
    row.error_message = 'page fetched but no US phone numbers detected';
  } else if (row.numbers_drift_missing.length > 0 || row.numbers_drift_new.length > 0) {
    row.status = 'drift';
  } else {
    row.status = 'verified';
  }
  return row;
}

function extractFromHtml(html: string): { found: Set<string> } {
  // Strip markup noise that confuses the extractor (tel: links are
  // already handled by the phone regex).
  const text = html.replace(/<[^>]+>/g, ' ');
  return { found: new Set(extractPhoneNumbers(text)) };
}

async function persistRow(row: VerificationRow): Promise<void> {
  await query(
    `INSERT INTO spoof_target_verifications (
       target_name, target_category, contact_url, http_status,
       numbers_on_page, numbers_expected, numbers_verified,
       numbers_drift_missing, numbers_drift_new, status, error_message
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      row.target_name,
      row.target_category,
      row.contact_url,
      row.http_status,
      row.numbers_on_page,
      row.numbers_expected,
      row.numbers_verified,
      row.numbers_drift_missing,
      row.numbers_drift_new,
      row.status,
      row.error_message,
    ],
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
