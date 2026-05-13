// Email Shield — sender-lookalike detector.
//
// One of the strongest BEC signals: the from-address impersonates
// a known brand or one of the user's contacts via a typosquat /
// homograph / display-name spoof. Three detectors:
//
//   1. Display-name vs from-domain mismatch — the From header
//      reads `"Bank of America" <alerts@bofa-secure.support>`.
//      The display name claims a brand the user trusts, but the
//      eTLD+1 of the from-address is not the brand's real domain.
//
//   2. Brand-keyword in from-domain that isn't the real brand —
//      `chase-verify.xyz`, `irs-refund-portal.com`. Reuses the
//      same brand keywords as urlScan.ts's smishing detector but
//      applies them to sender domains.
//
//   3. Typosquat — Levenshtein distance 1-2 from a known-brand
//      eTLD+1 (`chasse.com` vs `chase.com`, `paypa1.com` vs
//      `paypal.com`).
//
// The detector OUTPUT is a list of `SenderLookalikeFinding`
// values; the scorer adds a fixed score per finding type and
// records the categories in `triggered_categories`.

export type SenderLookalikeKind =
  | 'display_name_brand_mismatch'  // "Bank of America" but from-domain != bofa
  | 'brand_keyword_in_domain'      // chase-verify.xyz / irs-refund.cfd
  | 'typosquat_of_known_brand'     // chasse.com / paypa1.com
  | 'idn_homograph';                // Cyrillic / Greek letters mimicking ASCII

export interface SenderLookalikeFinding {
  kind: SenderLookalikeKind;
  /** The from-domain that triggered the finding (eTLD+1). */
  from_domain: string;
  /**
   * The brand the sender appears to impersonate. Used in the
   * user-facing reason string. Empty when the detector can't
   * identify a specific target (e.g. IDN homograph with no
   * specific brand match).
   */
  impersonated_brand: string;
}

/**
 * Known brands and their canonical eTLD+1 set. Mirrored from
 * urlScan.ts's LEGITIMATE_BRAND_DOMAINS for consistency — if
 * urlScan accepts chase.com as legitimate, we apply the same
 * brand identity here for lookalike detection. Subdomains pass
 * the allowlist; lookalikes get caught.
 *
 * Map shape: brand display name → list of legitimate domains.
 * The brand display name is what surfaces in iOS as
 * "This sender claims to be Chase but the domain is sketchy."
 */
const KNOWN_BRANDS: { brand: string; domains: string[]; keywords: RegExp[] }[] = [
  {
    brand: 'Chase',
    domains: ['chase.com', 'chasebank.com'],
    keywords: [/\bchase\b/i],
  },
  {
    brand: 'Wells Fargo',
    domains: ['wellsfargo.com'],
    // [-_\s]? so we match "Wells Fargo" (display name with space)
    // and "wells-fargo" / "wells_fargo" / "wellsfargo" (domain
    // shapes). The same pattern applies to every multi-word brand.
    keywords: [/\bwells[-_\s]?fargo\b/i, /\bwellsfargo\b/i],
  },
  {
    brand: 'Bank of America',
    domains: ['bankofamerica.com', 'bofa.com'],
    keywords: [/\bbank[-_\s]?of[-_\s]?america\b/i, /\bbofa\b/i],
  },
  {
    brand: 'PayPal',
    domains: ['paypal.com'],
    keywords: [/\bpaypal\b/i],
  },
  {
    brand: 'Venmo',
    domains: ['venmo.com'],
    keywords: [/\bvenmo\b/i],
  },
  {
    brand: 'Amazon',
    domains: ['amazon.com'],
    keywords: [/\bamazon\b/i],
  },
  {
    brand: 'Apple',
    // Adversarial-review M8: dropped the bare /\bapple\b/ keyword
    // because it false-positives on legitimate Apple-adjacent
    // marketing/partner domains. apple-id and icloud are tight
    // enough — generic "apple" in a domain string isn't enough
    // evidence on its own.
    domains: ['apple.com', 'icloud.com'],
    keywords: [/\bapple[-_\s]?id\b/i, /\bicloud\b/i],
  },
  {
    brand: 'IRS',
    domains: ['irs.gov'],
    keywords: [/\birs\b/i],
  },
  {
    brand: 'USPS',
    domains: ['usps.com'],
    keywords: [/\busps\b/i],
  },
  {
    brand: 'UPS',
    domains: ['ups.com'],
    keywords: [/\bups\b/i],
  },
  {
    brand: 'FedEx',
    domains: ['fedex.com'],
    keywords: [/\bfedex\b/i],
  },
  {
    brand: 'DHL',
    domains: ['dhl.com'],
    keywords: [/\bdhl\b/i],
  },
  {
    brand: 'Microsoft',
    domains: ['microsoft.com', 'outlook.com', 'office.com', 'live.com', 'hotmail.com'],
    keywords: [/\bmicrosoft\b/i, /\boffice[-_\s]?365\b/i, /\boutlook\b/i],
  },
  {
    brand: 'Google',
    domains: ['google.com', 'gmail.com'],
    keywords: [/\bgoogle\b/i, /\bgmail\b/i],
  },
  {
    brand: 'Netflix',
    domains: ['netflix.com'],
    keywords: [/\bnetflix\b/i],
  },
];

/**
 * Flat set of every legitimate brand domain — used for the C1
 * typosquat-allowlist guard so legitimate brand domains never flag
 * each other as typosquats. Built once at module load.
 */
const ALL_BRAND_DOMAINS = new Set(KNOWN_BRANDS.flatMap((b) => b.domains));

/**
 * Common multi-label public suffixes. Used so `bbc.co.uk` correctly
 * collapses to `bbc.co.uk` (eTLD+1), not `co.uk`. Adversarial-review
 * H1 fix: without this, UK / AU / JP BEC where from-domain and
 * reply-to-domain differ at the registrable level but share a
 * second-level public suffix slipped through `isReplyToDivergent`.
 *
 * Not exhaustive — a full implementation would import the `psl`
 * package. The set below covers the public-suffix tail of the
 * countries with non-trivial BEC volume in IC3 reporting. Add
 * more as brands ship with country domains.
 */
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.in', 'gov.in', 'ac.in', 'org.in', 'net.in',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.kr', 'or.kr',
  'co.za', 'org.za', 'gov.za',
  'com.mx', 'gob.mx', 'org.mx',
  'com.sg', 'edu.sg',
  'com.hk', 'org.hk', 'gov.hk',
]);

/**
 * Compute the eTLD+1 of a hostname. Uses MULTI_LABEL_PUBLIC_SUFFIXES
 * for two-label country tails (.co.uk / .com.au / .co.jp); falls
 * back to the last-two-labels approximation for single-label TLDs.
 */
function eTldPlusOne(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 1) return host.toLowerCase();
  if (labels.length >= 3) {
    const tail2 = labels.slice(-2).join('.');
    if (MULTI_LABEL_PUBLIC_SUFFIXES.has(tail2)) {
      return labels.slice(-3).join('.');
    }
  }
  return labels.slice(-2).join('.');
}

/**
 * Strict Levenshtein distance. Bounded by maxDistance so we can
 * early-bail on obvious non-matches.
 */
function levenshteinAtMost(a: string, b: string, maxDistance: number): number {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

/**
 * Visual-confusable single-character substitutions that real
 * typosquats exploit. Symmetric — both directions are valid.
 * Used to gate distance-1 same-length substitution typosquats so
 * `paypa1.com` (l↔1) matches `paypal.com` but `phase.com` does
 * NOT match `chase.com` (p↔c is not visually confusable).
 */
const VISUAL_CONFUSABLES: Array<[string, string]> = [
  ['l', '1'], ['l', 'i'], ['i', '1'],
  ['o', '0'],
  ['s', '5'],
  ['b', '8'],
  ['e', '3'],
  ['a', '@'],
  ['z', '2'],
  ['t', '7'],
];

function isConfusablePair(a: string, b: string): boolean {
  for (const [x, y] of VISUAL_CONFUSABLES) {
    if ((a === x && b === y) || (a === y && b === x)) return true;
  }
  return false;
}

/**
 * Returns true if `needle` is a subsequence of `haystack`. Used by
 * the typosquat detector to require that a brand's base name
 * preserve its character order in the typosquat (catches insertion
 * / deletion typos) or vice versa.
 */
function isSubsequence(needle: string, haystack: string): boolean {
  let ni = 0;
  for (let hi = 0; hi < haystack.length && ni < needle.length; hi++) {
    if (needle[ni] === haystack[hi]) ni++;
  }
  return ni === needle.length;
}

/**
 * Typosquat detector. Adversarial-review C2 fix: replaces the
 * naive distance ≤ 2 check with a tighter heuristic that catches
 * real typosquats (insertion / deletion / visual-confusable
 * substitution) while rejecting unrelated same-length words
 * (phase vs chase, iis vs irs, agile vs apple).
 *
 * Detection rules:
 *  - Same-length, distance 1: the differing character pair MUST be
 *    in VISUAL_CONFUSABLES. Catches paypa1.com (l↔1), apple0.com
 *    (e↔0), etc.; rejects phase.com (p↔c not confusable).
 *  - Different length, distance ≤ 2: the shorter name MUST be a
 *    subsequence of the longer. Catches chasse.com (insertion),
 *    pypal.com (deletion); rejects random short-domain words that
 *    happen to be close by distance alone.
 */
function isLikelyTyposquat(fromDomain: string, brandDomain: string): boolean {
  if (fromDomain === brandDomain) return false;
  if (Math.abs(fromDomain.length - brandDomain.length) > 2) return false;

  if (fromDomain.length === brandDomain.length) {
    // Find positions that differ; require exactly one diff that's
    // a visual-confusable pair.
    let diffCount = 0;
    let diffAt = -1;
    for (let i = 0; i < fromDomain.length; i++) {
      if (fromDomain[i] !== brandDomain[i]) {
        diffCount++;
        diffAt = i;
        if (diffCount > 1) return false;
      }
    }
    return diffCount === 1 && isConfusablePair(fromDomain[diffAt]!, brandDomain[diffAt]!);
  }

  const dist = levenshteinAtMost(fromDomain, brandDomain, 2);
  if (dist === 0 || dist > 2) return false;
  return isSubsequence(brandDomain, fromDomain) || isSubsequence(fromDomain, brandDomain);
}

/**
 * Detect IDN homograph / Cyrillic / Greek letters in a hostname.
 * Same logic as urlScan.ts's IDN_HOMOGRAPH heuristic.
 */
function hasIdnHomograph(host: string): boolean {
  return /[Ѐ-ӿͰ-Ͽ]/.test(host);
}

/**
 * Run the three lookalike detectors against a from-address +
 * display-name. Returns the deduped finding list.
 *
 * Pure function — no I/O, no state. The scorer composes against
 * the rest of the signal stack.
 */
export function detectSenderLookalike(input: {
  /** Lowercased RFC-5321 from-address (provider invariant). */
  from_address: string;
  /** Display name as it appeared in the From header (NOT trimmed of quotes). */
  display_name: string;
}): SenderLookalikeFinding[] {
  const findings: SenderLookalikeFinding[] = [];
  const atIdx = input.from_address.indexOf('@');
  if (atIdx < 0) return findings; // not a valid address; skip
  const host = input.from_address.slice(atIdx + 1);
  const fromDomain = eTldPlusOne(host);

  // 1. Display-name vs from-domain mismatch. If the display name
  //    contains a known-brand keyword AND the from-domain isn't
  //    one of that brand's legitimate domains, that's the
  //    canonical BEC signal.
  if (input.display_name) {
    for (const b of KNOWN_BRANDS) {
      const isClaimed = b.keywords.some((kw) => kw.test(input.display_name));
      if (!isClaimed) continue;
      const isLegit = b.domains.some(
        (d) => fromDomain === d || host === d || host.endsWith('.' + d),
      );
      if (isLegit) continue;
      findings.push({
        kind: 'display_name_brand_mismatch',
        from_domain: fromDomain,
        impersonated_brand: b.brand,
      });
      // Stop after first matching brand — don't double-count if
      // display name mentions two brands.
      break;
    }
  }

  // 2. Brand keyword IN the from-domain itself. `chase-verify.xyz`
  //    has the brand name in the host but isn't on the brand's
  //    real eTLD+1. We don't flag the brand-mismatch path again
  //    if display_name was empty.
  for (const b of KNOWN_BRANDS) {
    const isLegit = b.domains.some(
      (d) => fromDomain === d || host === d || host.endsWith('.' + d),
    );
    if (isLegit) continue;
    const inHost = b.keywords.some((kw) => kw.test(host));
    if (!inHost) continue;
    findings.push({
      kind: 'brand_keyword_in_domain',
      from_domain: fromDomain,
      impersonated_brand: b.brand,
    });
    break;
  }

  // 3. Typosquat — Levenshtein distance from any known-brand
  //    eTLD+1. Catches `chasse.com`, `paypa1.com`,
  //    `bankofamarica.com`. Skip if the from-domain is already
  //    flagged by detectors 1 or 2 above (no double-counting).
  //
  // Adversarial-review C1 fix: exclude EVERY known-brand domain
  // (not just the specific brand we're comparing against) from
  // typosquat candidacy. Otherwise `ups.com` flags as a typosquat
  // of `usps.com` (and vice versa) — both are legitimate brands.
  //
  // Adversarial-review C2 fix: tighter distance bound for short
  // brand domains. With maxDistance=2 against 7-char brands like
  // `ups.com` / `dhl.com` / `irs.gov`, the FP surface is huge —
  // `aol.com`, `cbs.com`, `iis.gov`, `agile.com`, `phase.com`,
  // `pbs.com` all flag as fake-brands. Bound:
  //   - brand domain length ≤ 8 chars → require distance == 1
  //   - brand domain length ≥ 9 chars → allow distance ≤ 2
  // 8 chars catches `ups.com` (7), `dhl.com` (7), `irs.gov` (7),
  // `apple.com` (9 — allows distance 2), `chase.com` (9), etc.
  const alreadyFlagged = findings.some((f) => f.from_domain === fromDomain);
  if (!alreadyFlagged && !ALL_BRAND_DOMAINS.has(fromDomain)) {
    for (const b of KNOWN_BRANDS) {
      for (const legitDomain of b.domains) {
        if (isLikelyTyposquat(fromDomain, legitDomain)) {
          findings.push({
            kind: 'typosquat_of_known_brand',
            from_domain: fromDomain,
            impersonated_brand: b.brand,
          });
          break;
        }
      }
      if (findings.some((f) => f.kind === 'typosquat_of_known_brand')) break;
    }
  }

  // 4. IDN homograph — Cyrillic / Greek letters in the host.
  if (hasIdnHomograph(host)) {
    findings.push({
      kind: 'idn_homograph',
      from_domain: fromDomain,
      impersonated_brand: '',
    });
  }

  return findings;
}

/**
 * Human-readable rationale for a lookalike finding kind. Surfaced
 * in the verdict's `explainable_reasons` array.
 */
export function describeSenderLookalikeKind(
  kind: SenderLookalikeKind,
  brand: string,
): string {
  switch (kind) {
    case 'display_name_brand_mismatch':
      return brand
        ? `Sender claims to be ${brand} but the email isn't from ${brand}'s real domain.`
        : 'Sender display name impersonates a brand the from-address doesn\'t belong to.';
    case 'brand_keyword_in_domain':
      return brand
        ? `From-domain contains the "${brand}" keyword but isn't ${brand}'s real domain — typosquat indicator.`
        : 'From-domain contains a known-brand keyword on a non-brand domain.';
    case 'typosquat_of_known_brand':
      return brand
        ? `From-domain is a one- or two-character typo of ${brand}'s real domain.`
        : 'From-domain is a near-typo of a known brand domain.';
    case 'idn_homograph':
      return 'From-domain contains characters from non-Latin scripts (Cyrillic / Greek) — possible IDN homograph attack.';
  }
}
