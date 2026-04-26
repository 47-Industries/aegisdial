import { z } from 'zod';

export const VerdictEnum = z.enum([
  'trusted',
  'unknown',
  'suspicious',
  'likely_spoof',
  'spoof_risk_high',
]);
export type Verdict = z.infer<typeof VerdictEnum>;

export const LineTypeEnum = z.enum(['mobile', 'voip', 'landline', 'toll_free', 'unknown']);
export type LineType = z.infer<typeof LineTypeEnum>;

export const AttestationEnum = z.enum(['A', 'B', 'C']);
export type Attestation = z.infer<typeof AttestationEnum>;

export const BusinessCategoryEnum = z.enum([
  'bank',
  'credit_union',
  'credit_card',
  'brokerage',
  'fintech',
  'p2p_payments',
  'crypto_exchange',
  'government',
  'shipping',
  'big_tech',
  'utility',
  'telecom',
  'tax_prep',
  'insurance',
  'healthcare',
  'airline',
  'nonprofit',
  'gig_economy',
  'other',
]);
export type BusinessCategory = z.infer<typeof BusinessCategoryEnum>;

export const VerdictRequestSchema = z.object({
  number: z.string().min(4).max(20),
  locale: z.string().optional().default('en-US'),
  country: z.string().length(2).optional().default('US'),
});
export type VerdictRequest = z.infer<typeof VerdictRequestSchema>;

export const ReportRequestSchema = z.object({
  number: z.string().min(4).max(20),
  category: z.enum([
    'spam',
    'scam',
    'robocall',
    'phishing',
    'impersonation',
    'debt_collector_abuse',
    'other',
  ]),
  note: z.string().max(500).optional(),
  device_id: z.string().optional(),
});
export type ReportRequest = z.infer<typeof ReportRequestSchema>;

export const FeedbackRequestSchema = z.object({
  number: z.string().min(4).max(20),
  user_verdict: VerdictEnum,
  device_id: z.string().optional(),
});
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

export interface EvidenceItem {
  source: string;
  url?: string;
  snippet?: string;
  date?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
  weight: number;
  complaint_count?: number;
  category?: string;
}

export interface BusinessMatch {
  name: string;
  category: BusinessCategory;
  verified: boolean;
  source: string;
}

export interface NumberSignals {
  mention_count_30d: number;
  mention_count_all: number;
  negative_sentiment_ratio: number;
  complaint_sources: number;
  first_seen: string | null;
  last_seen: string | null;
  stir_shaken_attestation: Attestation | null;
  carrier: string | null;
  line_type: LineType;
  number_age_days: number | null;
  business_match: BusinessMatch | null;
  spoof_reports_30d: number;
}

export interface VerdictResponse {
  number: string;
  trust_score: number;
  verdict: Verdict;
  summary: string;
  user_message?: string;
  display_color: 'green' | 'yellow' | 'amber' | 'red';
  recommended_action:
    | 'answer'
    | 'answer_with_caution'
    | 'verify_offline'
    | 'decline'
    | 'unknown';
  evidence: EvidenceItem[];
  signals: NumberSignals;
  /** "Who is this?" public-info enrichment from Twilio Lookup V2 /
   *  Ekata / IPQS. Null when no provider is configured or the
   *  number isn't known. */
  public_info?: PublicPhoneInfo | null;
  latency_ms: number;
  freshness_seconds: number | null;
  score_version: number;
  cached: boolean;
}

export interface PublicPhoneInfo {
  owner_name: string | null;
  line_type: 'mobile' | 'landline' | 'voip' | 'toll_free' | 'premium' | 'unknown';
  carrier_name: string | null;
  country_code: string | null;
  city: string | null;
  state_code: string | null;
  is_spoofable: boolean;
  /** Burner / disposable-service detection (Google Voice, TextNow, etc.) */
  is_likely_burner: boolean;
  /** Country code outside +1. */
  is_overseas: boolean;
  /** Human label for the burner service when recognized. */
  burner_service: string | null;
  spam_risk_score: number | null;
  sources: string[];
}
