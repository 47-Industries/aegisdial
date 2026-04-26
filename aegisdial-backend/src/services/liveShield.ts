import { detectPhrases, type PhraseHit, type ScamCategory } from '../lib/scamPhrases.js';

// Live Shield scoring. Converts a set of phrase hits into a 0–100 risk
// score and a discrete risk level. Two key ideas:
//
//   1. Individual hits have severity * weight contribution.
//   2. Category co-occurrence is where the real signal lives —
//      isolation alone is noise, but impersonation + payment + isolation
//      + time pressure is the universal fingerprint of every bank /
//      IRS / "safe account" scam. We bonus co-occurrences hard.
//
// Score never decreases within a session (we don't walk back once we
// caught a kill phrase).

export interface RiskSnapshot {
  risk_score: number;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  triggered_categories: ScamCategory[];
  rationale: string[];
}

const CATEGORY_WEIGHT: Record<ScamCategory, number> = {
  payment_fraud: 1.0,
  remote_access: 1.0,
  impersonation_authority: 0.9,
  impersonation_financial: 0.85,
  isolation: 0.95,
  time_pressure: 0.6,
  sensitive_data: 1.0,
  emergency_relative: 1.0,
  crypto_investment: 0.9,
  smishing_bait: 0.95,
};

// Combos that light up the "this is almost certainly a scam" fingerprint.
// Order within a combo doesn't matter; all categories must be present.
const COMBOS: { categories: ScamCategory[]; bonus: number; name: string }[] = [
  {
    categories: ['impersonation_financial', 'payment_fraud'],
    bonus: 30,
    name: 'Bank impersonation + payment ask',
  },
  {
    categories: ['impersonation_authority', 'payment_fraud'],
    bonus: 35,
    name: 'Authority impersonation + payment',
  },
  {
    categories: ['payment_fraud', 'isolation'],
    bonus: 20,
    name: 'Payment + isolation coaching',
  },
  {
    categories: ['remote_access', 'impersonation_financial'],
    bonus: 30,
    name: 'Remote access + bank pretext',
  },
  {
    categories: ['impersonation_authority', 'time_pressure', 'payment_fraud'],
    bonus: 15,
    name: 'Authority + urgency + payment (universal scam shape)',
  },
  {
    categories: ['emergency_relative', 'payment_fraud'],
    bonus: 25,
    name: 'Grandchild-in-distress + money ask',
  },
  {
    categories: ['emergency_relative', 'isolation'],
    bonus: 20,
    name: 'Emergency + "don\'t tell anyone"',
  },
  {
    categories: ['crypto_investment', 'sensitive_data'],
    bonus: 25,
    name: 'Crypto pitch + credential ask',
  },
];

/**
 * Convert a set of phrase hits (aggregated across the whole session so
 * far) into a risk snapshot. Callers should store hits in the DB and
 * re-score with the full set each time — cheap, correct, explainable.
 */
export function scoreHits(hits: PhraseHit[]): RiskSnapshot {
  if (hits.length === 0) {
    return { risk_score: 0, risk_level: 'low', triggered_categories: [], rationale: [] };
  }

  // One contribution per unique pattern id (dedup across chunks).
  const uniqByPattern = new Map<string, PhraseHit>();
  for (const h of hits) {
    if (!uniqByPattern.has(h.pattern.id)) uniqByPattern.set(h.pattern.id, h);
  }
  const unique = [...uniqByPattern.values()];

  let base = 0;
  const rationale: string[] = [];
  for (const h of unique) {
    const contribution = h.pattern.severity * h.pattern.weight * 6 * CATEGORY_WEIGHT[h.pattern.category];
    base += contribution;
    rationale.push(h.pattern.label);
  }

  const categories = new Set(unique.map((h) => h.pattern.category));
  let combo = 0;
  for (const c of COMBOS) {
    if (c.categories.every((cat) => categories.has(cat))) {
      combo += c.bonus;
      rationale.push(`Pattern: ${c.name}`);
    }
  }

  const total = Math.min(100, Math.round(base + combo));

  const level: RiskSnapshot['risk_level'] =
    total >= 75 ? 'critical' : total >= 50 ? 'high' : total >= 25 ? 'medium' : 'low';

  return {
    risk_score: total,
    risk_level: level,
    triggered_categories: [...categories],
    rationale,
  };
}

/**
 * Convenience: score a plain string. Used by tests and SMS classifier.
 */
export function scoreText(text: string): RiskSnapshot {
  return scoreHits(detectPhrases(text));
}
