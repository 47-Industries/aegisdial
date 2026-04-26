const SCAM_KEYWORDS: Array<{ pattern: RegExp; weight: number; category: string }> = [
  { pattern: /\b(scam|scammer|scamming|scammed)\b/i, weight: 3, category: 'scam' },
  { pattern: /\b(fraud|fraudulent|defrauded)\b/i, weight: 3, category: 'scam' },
  { pattern: /\b(phish(ing)?|spoof(ed|ing)?|impersonat(e|ing|or))\b/i, weight: 3, category: 'phishing' },
  { pattern: /\b(robo(call|caller)|robot call)\b/i, weight: 2, category: 'robocall' },
  { pattern: /\b(spam|spammer|unwanted)\b/i, weight: 1, category: 'spam' },
  { pattern: /\b(fake|bogus|bs|lie[ds]?|lying)\b/i, weight: 1, category: 'spam' },
  { pattern: /\b(irs|ssa|social security|medicare|treasury)\b/i, weight: 2, category: 'impersonation' },
  { pattern: /claim(ed|ing)?\s+to\s+be/i, weight: 2, category: 'impersonation' },
  { pattern: /\b(arrest|warrant|jail|prison|lawsuit|sued?)\b/i, weight: 2, category: 'scam' },
  { pattern: /\b(gift card|bitcoin|crypto|western union|zelle|wire transfer)\b/i, weight: 3, category: 'scam' },
  { pattern: /\b(urgent|immediate|act now|right away)\b/i, weight: 1, category: 'scam' },
  { pattern: /\b(debt collect|collect(ion|or))\b/i, weight: 1, category: 'debt_collector_abuse' },
  { pattern: /\b(stole|stolen|identity theft|ssn)\b/i, weight: 2, category: 'scam' },
  { pattern: /do[\s-]?not[\s-]?answer/i, weight: 3, category: 'scam' },
  { pattern: /\b(block(ed)? (it|them|this number)|blocked)\b/i, weight: 1, category: 'spam' },
];

const POSITIVE_KEYWORDS: RegExp[] = [
  /\b(my (own )?number|this is my number)\b/i,
  /\b(my business|call me at)\b/i,
  /\b(sold|for sale|selling)\b/i,
];

export interface SentimentResult {
  sentiment: 'positive' | 'neutral' | 'negative';
  scam_category: string | null;
  severity: number;
  weight: number;
}

export function classifyMention(snippet: string): SentimentResult {
  if (!snippet) return { sentiment: 'neutral', scam_category: null, severity: 1, weight: 0.3 };

  const lowered = snippet.toLowerCase();

  let negScore = 0;
  const categories = new Map<string, number>();
  for (const rule of SCAM_KEYWORDS) {
    if (rule.pattern.test(snippet)) {
      negScore += rule.weight;
      categories.set(rule.category, (categories.get(rule.category) ?? 0) + rule.weight);
    }
  }

  let posScore = 0;
  for (const pattern of POSITIVE_KEYWORDS) {
    if (pattern.test(snippet)) posScore += 1;
  }

  if (negScore === 0 && posScore > 0) {
    return { sentiment: 'positive', scam_category: null, severity: 1, weight: 0.2 };
  }

  if (negScore >= 3) {
    const topCategory = [...categories.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'scam';
    return {
      sentiment: 'negative',
      scam_category: topCategory,
      severity: Math.min(5, Math.ceil(negScore / 2)),
      weight: Math.min(1, 0.5 + negScore * 0.1),
    };
  }

  if (negScore >= 1) {
    const topCategory = [...categories.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'spam';
    return {
      sentiment: 'negative',
      scam_category: topCategory,
      severity: 2,
      weight: 0.4,
    };
  }

  return {
    sentiment: lowered.length > 20 ? 'neutral' : 'neutral',
    scam_category: null,
    severity: 1,
    weight: 0.3,
  };
}
