// Identity Shield — service-layer types.
//
// The seven I-P1 migrations (068–074) define the storage shape. This
// file mirrors them as TypeScript so every downstream consumer
// (active-threats service, ingest workers, route layer, admin
// dashboards) talks to the same vocabulary.
//
// Same boundary discipline as src/services/email/types.ts: union
// types for CHECK-constraint vocabularies (ThreatKind, ThreatSeverity,
// MonitorKind, …), row interfaces with explicit nullability, and
// privacy-posture comments next to the columns that hold or could
// hold sensitive material.
//
// PRIVACY INVARIANT — read once, then enforce in code:
//   identity_monitors.watched_value is plaintext for monitor_kind in
//   {email, phone_e164} and hash-only for {ssn_last4_hash, dob_hash,
//   name_address_hash}. The /v1/identity-shield/monitors POST route
//   is responsible for hashing-and-discarding plaintext SSN/DOB BEFORE
//   it reaches the INSERT. The service layer NEVER receives plaintext
//   SSN/DOB; if it does, that's a route-layer bug, not a service-layer
//   one. The IdentityMonitorRow interface intentionally carries
//   watched_value as a single string regardless of kind — the
//   discriminator (monitor_kind) tells the consumer how to interpret
//   it. Adversarial review (I-P8) verifies the boundary holds.

// ───────────────────────────────────────────────────────────────
// CHECK-constraint vocabularies — keep in lockstep with migrations.
// ───────────────────────────────────────────────────────────────

/**
 * identity_monitors.monitor_kind discriminator.
 *
 * email          — plaintext email address (lowercased canonical form)
 * phone_e164     — plaintext E.164-normalized phone number
 * ssn_last4_hash — sha256(ssn_last4 || per_user_salt). SSN-last-4 NEVER
 *                  persists as plaintext at any tier; hashing happens
 *                  inside the POST route, plaintext discarded before
 *                  INSERT.
 * dob_hash       — sha256('YYYY-MM-DD' || per_user_salt). Same discipline.
 * name_address_hash — sha256('first|last|street|zip' || salt). Composite
 *                     PII for darknet-listing matches.
 */
export type MonitorKind =
  | 'email'
  | 'phone_e164'
  | 'ssn_last4_hash'
  | 'dob_hash'
  | 'name_address_hash';

/**
 * identity_breaches.source discriminator. Catalogue ingest provenance.
 *
 * hibp                — Have I Been Pwned API delta
 * enzoic              — Enzoic credential-exposure API
 * aegisdial_internal  — recovery-case observation that surfaces a
 *                       breach we hadn't catalogued yet (rare; small
 *                       regional dumps)
 */
export type BreachSource = 'hibp' | 'enzoic' | 'aegisdial_internal';

/**
 * identity_breach_findings.severity 3-tier scale.
 *
 * informational  — breach exposure only (email in dump, no credential)
 * caution        — credential-pair match or sensitive-class exposure
 *                  (DOB, address). Recommended: password rotation, 2FA.
 * critical       — SSN exposure, ATO-grade combo, or active scammer-
 *                  target listing. Push notification fires.
 *
 * NOTE: distinct from ThreatSeverity (4-tier). Findings are
 * historical (a breach happened in the past); threats are live (a
 * scammer is operating now).
 */
export type FindingSeverity = 'informational' | 'caution' | 'critical';

/**
 * active_threats.threat_kind discriminator.
 *
 * phone_e164     — caller / SMS-sender phone, E.164 normalized
 * email_address  — sender email, lowercased
 * crypto_wallet  — on-chain address (canonical form per chain)
 * url_host       — eTLD+1 of a URL surfaced in a scam message
 * ip_address     — inbound IPv4/IPv6 (rarely useful; reserved)
 */
export type ThreatKind =
  | 'phone_e164'
  | 'email_address'
  | 'crypto_wallet'
  | 'url_host'
  | 'ip_address';

/**
 * active_threats.severity 4-tier scale. ONE MORE tier than
 * FindingSeverity — the 'warning' middle captures pattern-confirmed
 * intel that lacks a specific victim attestation.
 *
 * informational      — passive intel (in a breach dump)
 * caution            — mentioned in scammer chatter ≥1×
 * warning            — confirmed scam pattern, no specific attestation
 * confirmed_scammer  — at least one recovery case attests fraud attempt
 */
export type ThreatSeverity =
  | 'informational'
  | 'caution'
  | 'warning'
  | 'confirmed_scammer';

/**
 * threat_intel_channels.source_kind discriminator. Also used by
 * threat_intel_candidates (same vocabulary).
 */
export type IntelSourceKind = 'telegram' | 'darknet_market';

/**
 * threat_intel_channels.status lifecycle.
 *
 * candidate  — discovered, awaiting approval (rare in this table —
 *              usually candidates live in threat_intel_candidates first)
 * active     — workers poll this source
 * dormant    — yield collapsed; workers skip; preserved for historical
 *              attribution on past active_threats rows
 * removed    — operator explicitly disabled
 * honeypot   — confirmed sting / monitoring trap; DO NOT visit
 */
export type IntelChannelStatus =
  | 'candidate'
  | 'active'
  | 'dormant'
  | 'removed'
  | 'honeypot';

/**
 * threat_intel_candidates.decision lifecycle.
 *
 * null        — pending review
 * approved    — promoted into threat_intel_channels with status=active
 * rejected    — blocked from re-discovery (history-preserving)
 */
export type IntelCandidateDecision = 'approved' | 'rejected';

// ───────────────────────────────────────────────────────────────
// Row interfaces — one per migration. Field names + nullability
// mirror the SQL exactly.
// ───────────────────────────────────────────────────────────────

/**
 * identity_monitors row.
 *
 * watched_value interpretation depends on monitor_kind:
 *   - email / phone_e164: plaintext canonical form
 *   - ssn_last4_hash / dob_hash / name_address_hash: hex sha256 digest
 * salt_hex is non-null IFF monitor_kind is a hash kind.
 */
export interface IdentityMonitorRow {
  id: string;
  user_id: string;
  monitor_kind: MonitorKind;
  /** Plaintext for email/phone; hex hash for ssn/dob/name-address. */
  watched_value: string;
  /** 32-byte hex salt for hash kinds; null for plaintext kinds. */
  salt_hex: string | null;
  /** Soft-delete flag. DELETE route flips this; sweep deletes 90d later. */
  active: boolean;
  created_at: Date;
}

/**
 * identity_breaches row. Global catalog, NOT per-user.
 */
export interface IdentityBreachRow {
  id: string;
  /** Human-readable, e.g., "LinkedIn (2012)". */
  breach_name: string;
  source: BreachSource;
  /** Provider stable ID for delta re-sync. */
  source_breach_id: string;
  /** eTLD+1 of the breached service. */
  domain: string | null;
  /** When the breach actually occurred, per provider. */
  breach_date: Date | null;
  /** When the provider catalogued the breach. */
  added_date: Date | null;
  /** BIGINT — some dumps exceed 32-bit INT range. */
  pwn_count: number | null;
  /** HIBP-style class names. Empty array if provider omits detail. */
  data_classes: string[];
  is_verified: boolean;
  is_sensitive: boolean;
  description: string | null;
  synced_at: Date;
}

/**
 * identity_breach_findings row. INSERT-once on discovery; the only
 * UPDATE paths are user_acknowledged_at and remediation_completed_at.
 */
export interface IdentityBreachFindingRow {
  id: string;
  user_id: string;
  monitor_id: string;
  breach_id: string;
  severity: FindingSeverity;
  surfaced_at: Date;
  /** null = unread. */
  user_acknowledged_at: Date | null;
  /** null = not yet remediated. Drives the dashboard open-findings counter. */
  remediation_completed_at: Date | null;
}

/**
 * active_threats row — the single most-read table in AegisDial.
 *
 * provenance convention: <source_tag>:<source_specific_id>. Examples:
 *   aegisdial_recovery:<UUID>
 *   telegram_channel:<CID>:<MID>
 *   darknet_market:<MID>:<LID>
 *   enzoic_breach:<BID>
 *   hibp:<NAME>
 *
 * UNIQUE (threat_kind, threat_value, provenance) prevents same-source
 * dupes; multiple DIFFERENT sources INSERTing the same artifact is a
 * strength signal (scorer picks max severity across rows).
 */
export interface ActiveThreatRow {
  id: string;
  threat_kind: ThreatKind;
  /** Pre-normalized: E.164 phone, lowercased email, eTLD+1 host, canonical wallet. */
  threat_value: string;
  severity: ThreatSeverity;
  /** Source attribution. See header convention. */
  provenance: string;
  /** Rendered into iOS alert footer; <200 chars by convention. */
  context_text: string | null;
  /** ISO-3166 alpha-2 or null for global. Soft geo-targeting only. */
  geo_tag: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  /** null = no expiry (confirmed_scammer). See migration header for tier→TTL map. */
  expires_at: Date | null;
}

/**
 * threat_intel_channels row. The curated list of sources the
 * Telegram listener + darknet crawler observe. OBSERVER-ONLY posture
 * is enforced architecturally — no write path from AegisDial code
 * into anything listed here.
 */
export interface ThreatIntelChannelRow {
  id: string;
  source_kind: IntelSourceKind;
  /** Telegram: @handle or t.me/+invite_hash. Darknet: <market>.onion. */
  source_handle: string;
  /** Human-readable; may diverge from handle on rename. */
  display_name: string;
  /** carding, bank_logs, dox_for_hire, scampage, otp_bot, refund_method, sextortion_script, … */
  capability_tags: string[];
  /** ISO-3166 alpha-2 codes the channel targets. Empty = global. */
  geo_relevance: string[];
  status: IntelChannelStatus;
  added_at: Date;
  /** Approver's user_id (typically Jesiah). null for AI-discovered untriaged. */
  added_by: string | null;
  /** null until worker has polled at least once. */
  last_message_observed_at: Date | null;
  /** Rolling 7d count of scam-relevant messages; drives dormancy detection. */
  classified_message_count_7d: number;
}

/**
 * threat_intel_candidates row. AI-discovered handles awaiting Jesiah's
 * approval. The meta-analyst flow: discover → INSERT here → admin
 * approve → promote into threat_intel_channels with status=active.
 */
export interface ThreatIntelCandidateRow {
  id: string;
  source_kind: IntelSourceKind;
  source_handle: string;
  discovered_at: Date;
  /** Free-form JSONB. Conventional shape: see ThreatIntelCandidateRationale. */
  rationale: ThreatIntelCandidateRationale;
  /** 0.000–1.000. Higher = more confidence. Drives admin queue ordering. */
  candidate_score: number;
  /** null = pending. 'approved' | 'rejected' once decided. */
  decision: IntelCandidateDecision | null;
  decided_at: Date | null;
  /** Decider's user_id (typically Jesiah). Non-null IFF decision is non-null. */
  decided_by: string | null;
}

/**
 * Conventional shape for threat_intel_candidates.rationale JSONB.
 * The meta-analyst evolves this shape over time without a schema
 * migration — consumers MUST treat extra keys as additive and
 * tolerate missing optional keys.
 */
export interface ThreatIntelCandidateRationale {
  /** Channel IDs (from threat_intel_channels) that cited this handle. */
  cited_by: string[];
  /** Total mention count across cited_by. */
  mention_count: number;
  /** ISO timestamp of the earliest observed mention. */
  first_mentioned_at?: string;
  /** Quoted excerpts so admin can audit the AI's judgment. */
  sample_evidence?: Array<{
    channel_id: string;
    message_id: string;
    excerpt: string;
  }>;
  /** AI-inferred capability tags (same vocabulary as channels.capability_tags). */
  capability_signal?: string[];
  /** AI-inferred geo tags (ISO-3166 alpha-2). */
  geo_signal?: string[];
}

/**
 * threat_landscape_briefings row. Quarterly auto-generated report.
 */
export interface ThreatLandscapeBriefingRow {
  id: string;
  /** Inclusive start of the quarter. */
  period_start: Date;
  /** Inclusive end of the quarter. */
  period_end: Date;
  generated_at: Date;
  /** Multi-page markdown. Not size-capped at the schema layer. */
  body_markdown: string;
  /** Structured metrics. See ThreatLandscapeBriefingMetrics for conventional shape. */
  metrics_jsonb: ThreatLandscapeBriefingMetrics;
}

/**
 * Conventional shape for threat_landscape_briefings.metrics_jsonb.
 * Evolves over time; consumers tolerate extra/missing keys.
 */
export interface ThreatLandscapeBriefingMetrics {
  channels_added?: number;
  channels_removed?: number;
  channels_dormant_flagged?: number;
  active_threats_produced?: number;
  top_capability_tags?: Array<{ tag: string; count: number }>;
  geo_distribution?: Record<string, number>;
  candidate_queue_throughput?: {
    discovered: number;
    approved: number;
    rejected: number;
    pending_at_end: number;
  };
}

// ───────────────────────────────────────────────────────────────
// Service-layer input shapes (used by I-P2 onward, declared here to
// keep the contract in one file).
// ───────────────────────────────────────────────────────────────

/**
 * Input to recordThreat() / ingestThreatBatch(). The service layer
 * computes expires_at from severity if the caller doesn't supply one.
 */
export interface ThreatInput {
  kind: ThreatKind;
  /** Pre-normalized (E.164 / lowercased / eTLD+1 / canonical wallet). */
  value: string;
  severity: ThreatSeverity;
  /** <source_tag>:<source_specific_id>. See ActiveThreatRow.provenance. */
  provenance: string;
  /** Optional iOS alert-footer context (<200 chars). */
  context?: string;
  /** Optional ISO-3166 alpha-2 soft geo-tag. */
  geo_tag?: string;
  /** Optional explicit expiry; service layer derives from severity if omitted. */
  expires_at?: Date;
}

/**
 * Return shape from lookupThreat() — the scorer hot path. Returns
 * null when no active threat matches. When non-null, the scorer
 * surfaces severity + context_text in its verdict and bumps its
 * score per the kind→bump matrix in I-P2.
 */
export interface ActiveThreatHit {
  severity: ThreatSeverity;
  provenance: string;
  context_text: string | null;
  geo_tag: string | null;
  last_seen_at: Date;
}
