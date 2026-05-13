import { query } from '../../lib/db.js';
import { emitMetric } from '../../lib/observability.js';
import { hasRecoveryPlus } from './recoveryPlusEntitlement.js';
import type { SpecialistRow, SpecialistReferralRow } from './types.js';

// Recovery Shield — R-P4: specialist marketplace + referral tracking.
//
// Two surfaces wired into the Pro+Plus route layer at R-P5:
//   1. MARKETPLACE READS: listSpecialistsFor / getSpecialist. NOT
//      Plus-gated — iOS surfaces a "preview" of the marketplace before
//      the user buys Recovery Plus (helps convert). Reads return only
//      status='active' specialists; pending / suspended / retired rows
//      are never visible to end users.
//   2. REFERRAL LIFECYCLE: createReferral / list*ForUser /
//      list*ForSpecialist / advanceReferralStatus / reportSpecialistFee /
//      markFeePaid. createReferral is Plus-gated. Other operations are
//      caller-scoped by `is_admin_actor` (admin-driven dashboard vs.
//      specialist-webhook with transition restrictions).
//
// STATE MACHINE (per migration 067 CHECK + the lifecycle doc):
//
//   referred → specialist_contacted_user → user_engaged → case_active
//                                                          → case_closed_won
//                                                          → case_closed_lost
//                                                          → user_declined
//
//   Specialist-driven transitions (is_admin_actor=false) advance the
//   case strictly forward through the linear path. Specialists CANNOT
//   transition to `user_declined` — that's a user-initiated signal
//   surfaced only via admin (e.g., support marks the row after the
//   user replies in-app or via email "no thanks, found someone else").
//
//   Admins can move to ANY status from ANY non-terminal status. The
//   six terminal states (case_closed_won/lost + user_declined) are
//   terminal for everyone, including admins — re-opening a closed
//   case means creating a NEW referral row.
//
// FEE-FRAUD POSTURE (adversarial-review item E from R-P7):
//
//   A malicious specialist self-reporting a $999 referral fee is the
//   primary fraud surface here. Mitigations:
//     1. reportSpecialistFee REQUIRES is_admin_actor=true. The
//        specialist-side webhook NEVER reaches this surface; admin
//        reviews the specialist's invoice + flips the field by hand
//        at v1. UnauthorizedFeeReportError otherwise.
//     2. fee_owed_cents is BIGINT (large recoveries produce five-
//        figure commissions) — but the admin UI at R-P6 surfaces a
//        Big-Red-Button confirm for values > $5k.
//     3. markFeePaid is admin-only by virtue of being unreachable
//        from any specialist webhook (no specialist route surfaces
//        it). Idempotent — running twice leaves the first
//        fee_paid_at timestamp intact.
//
// CROSS-USER LEAKAGE GUARD:
//
//   listReferralsForUser scopes WHERE user_id = $1; users only see
//   their own referrals. advanceReferralStatus does NOT user-scope
//   because admins / specialist webhooks legitimately operate
//   across users — the auth surface at the route layer (R-P5)
//   gates the caller's authority, not this service. createReferral
//   verifies the recovery_session belongs to the requesting user
//   BEFORE inserting (RecoverySessionNotFoundError) — prevents user
//   A from referring user B's session to a specialist.
//
// IDEMPOTENCY (dedupe):
//
//   createReferral with the same (user, specialist, session) and an
//   open status returns the existing referral_id. A previously closed
//   referral (case_closed_won / case_closed_lost / user_declined) is
//   IGNORED for dedupe purposes — the user might re-engage the same
//   specialist on a follow-up matter, and that's a legitimate new
//   referral.

/** Default page size for listSpecialistsFor. */
const DEFAULT_LIST_LIMIT = 20;
/** Hard cap on listSpecialistsFor — anything above this is clamped. */
const MAX_LIST_LIMIT = 50;

/**
 * Statuses considered "open" for dedupe. A referral in any of these
 * states blocks a duplicate insert for the same (user, specialist,
 * session) tuple — createReferral returns the existing row's id.
 */
const OPEN_REFERRAL_STATUSES: ReadonlyArray<SpecialistReferralRow['engagement_status']> = [
  'referred',
  'specialist_contacted_user',
  'user_engaged',
  'case_active',
];

/**
 * Linear forward path the specialist webhook is allowed to advance
 * through. Specialist webhooks CANNOT reach user_declined (admin-only)
 * and CANNOT go backward.
 */
const SPECIALIST_FORWARD_TRANSITIONS: Record<
  SpecialistReferralRow['engagement_status'],
  ReadonlySet<SpecialistReferralRow['engagement_status']>
> = {
  referred: new Set(['specialist_contacted_user']),
  specialist_contacted_user: new Set(['user_engaged']),
  user_engaged: new Set(['case_active']),
  case_active: new Set(['case_closed_won', 'case_closed_lost']),
  case_closed_won: new Set(),
  case_closed_lost: new Set(),
  user_declined: new Set(),
};

/** Terminal states — no further advancement allowed by anyone. */
const TERMINAL_STATUSES = new Set<SpecialistReferralRow['engagement_status']>([
  'case_closed_won',
  'case_closed_lost',
  'user_declined',
]);

export class RecoveryPlusRequiredError extends Error {
  constructor(user_id: string, recovery_session_id: string) {
    super(
      `Recovery Plus entitlement required for user ${user_id} on session ${recovery_session_id}`,
    );
    this.name = 'RecoveryPlusRequiredError';
  }
}

export class SpecialistNotAvailableError extends Error {
  constructor(specialist_id: string) {
    super(`specialist ${specialist_id} is not available (missing or non-active)`);
    this.name = 'SpecialistNotAvailableError';
  }
}

export class RecoverySessionNotFoundError extends Error {
  constructor(recovery_session_id: string) {
    super(`recovery_session ${recovery_session_id} not found for caller`);
    this.name = 'RecoverySessionNotFoundError';
  }
}

export class InvalidStatusTransitionError extends Error {
  constructor(
    from: SpecialistReferralRow['engagement_status'],
    to: SpecialistReferralRow['engagement_status'],
    actor: 'admin' | 'specialist',
  ) {
    super(`illegal referral status transition (${actor}): ${from} → ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

export class ReferralNotFoundError extends Error {
  constructor(referral_id: string) {
    super(`referral not found: ${referral_id}`);
    this.name = 'ReferralNotFoundError';
  }
}

export class UnauthorizedFeeReportError extends Error {
  constructor(referral_id: string) {
    super(
      `unauthorized fee report on referral ${referral_id}: is_admin_actor must be true`,
    );
    this.name = 'UnauthorizedFeeReportError';
  }
}

export interface SpecialistFilter {
  category?: SpecialistRow['category'];
  /** ISO-3166-2 code (e.g., 'US-FL'). Matches if value is in specialists.jurisdictions[]. */
  jurisdiction?: string;
  /** ALL of these capabilities must appear in specialists.capabilities[]. */
  capabilities?: string[];
}

/**
 * Marketplace listing — returns active specialists matching the
 * filter. NOT Recovery-Plus-gated: iOS surfaces a preview of the
 * marketplace before purchase to drive conversion.
 *
 * Filters:
 *  - status = 'active' (always)
 *  - category equals filter.category (if provided)
 *  - filter.jurisdiction ∈ specialists.jurisdictions[] (if provided)
 *  - filter.capabilities ⊆ specialists.capabilities[] (if provided;
 *    specialist must have ALL requested capabilities — superset match)
 *
 * Sort: category, display_name (alphabetical) — stable, deterministic
 * for iOS pagination.
 *
 * Limit: default 20, hard cap 50.
 */
export async function listSpecialistsFor(
  filter: SpecialistFilter,
  opts: { limit?: number } = {},
): Promise<SpecialistRow[]> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);

  // Build the predicate dynamically — every clause AND-joined under
  // the always-on status='active' guard. Param indices track $N
  // positions for the parameterized query.
  const conds: string[] = ["status = 'active'"];
  const args: unknown[] = [];

  if (filter.category) {
    args.push(filter.category);
    conds.push(`category = $${args.length}`);
  }

  if (filter.jurisdiction) {
    args.push(filter.jurisdiction);
    conds.push(`$${args.length} = ANY(jurisdictions)`);
  }

  if (filter.capabilities && filter.capabilities.length > 0) {
    args.push(filter.capabilities);
    // @> is the "contains" operator on TEXT[] — specialist row's
    // capabilities[] must be a superset of the filter's array.
    conds.push(`capabilities @> $${args.length}`);
  }

  args.push(limit);
  const limitPos = args.length;

  const res = await query<SpecialistRow>(
    `SELECT id, display_name, category, jurisdictions, capabilities,
            commission_pct, contact_email, contact_phone, bar_number,
            status, vetted_at, vetted_by, notes, created_at
       FROM specialists
      WHERE ${conds.join(' AND ')}
      ORDER BY category, display_name
      LIMIT $${limitPos}`,
    args,
  );

  return res.rows;
}

/**
 * Read a single specialist. Active-only (suspended / pending / retired
 * rows surface as null — they are not the user's business). NOT
 * Recovery-Plus-gated.
 */
export async function getSpecialist(
  specialist_id: string,
): Promise<SpecialistRow | null> {
  const res = await query<SpecialistRow>(
    `SELECT id, display_name, category, jurisdictions, capabilities,
            commission_pct, contact_email, contact_phone, bar_number,
            status, vetted_at, vetted_by, notes, created_at
       FROM specialists
      WHERE id = $1 AND status = 'active'`,
    [specialist_id],
  );
  if ((res.rowCount ?? 0) === 0) return null;
  return res.rows[0]!;
}

export interface CreateReferralInput {
  user_id: string;
  specialist_id: string;
  recovery_session_id: string;
}

/**
 * Create a referral row. Validation chain (in order):
 *
 *  1. Recovery Plus entitlement (RecoveryPlusRequiredError)
 *  2. Specialist exists AND status='active' (SpecialistNotAvailableError)
 *  3. recovery_session belongs to user (RecoverySessionNotFoundError)
 *  4. Dedupe: if an open referral already exists for
 *     (user, specialist, session), return its id idempotently.
 *     Previously-closed referrals do NOT block a fresh insert.
 *
 * Returns { referral_id }. Emits recovery_shield.referral_created with
 * the specialist's category as a tag (for conversion-by-category
 * admin dashboards).
 */
export async function createReferral(
  input: CreateReferralInput,
): Promise<{ referral_id: string }> {
  // Step 1: entitlement. The cheapest of the gates is actually the
  // session ownership check below, but Recovery Plus is the public-
  // facing contract — surface the most user-actionable error first
  // so iOS can route to the upsell modal.
  const entitled = await hasRecoveryPlus(input.user_id, input.recovery_session_id);
  if (!entitled) {
    throw new RecoveryPlusRequiredError(input.user_id, input.recovery_session_id);
  }

  // Step 2: specialist must be active. The route layer will translate
  // this to a 404 (we don't differentiate "doesn't exist" from "not
  // active" at the API boundary — same user-visible outcome).
  const spec = await query<{ category: SpecialistRow['category'] }>(
    `SELECT category
       FROM specialists
      WHERE id = $1 AND status = 'active'`,
    [input.specialist_id],
  );
  if ((spec.rowCount ?? 0) === 0) {
    throw new SpecialistNotAvailableError(input.specialist_id);
  }
  const category = spec.rows[0]!.category;

  // Step 3: recovery_session must belong to this user. Belt-and-
  // suspenders against a malicious client that knows the session_id
  // for another user (URL guess, log leak, etc.) — the route layer
  // already authZ-gates, but this service NEVER trusts that.
  const sess = await query<{ exists_marker: 1 }>(
    `SELECT 1 AS exists_marker
       FROM recovery_sessions
      WHERE id = $1 AND user_id = $2`,
    [input.recovery_session_id, input.user_id],
  );
  if ((sess.rowCount ?? 0) === 0) {
    throw new RecoverySessionNotFoundError(input.recovery_session_id);
  }

  // Step 4: dedupe against OPEN referrals (not closed ones — a user
  // may legitimately re-engage the same specialist on a follow-up).
  const existing = await query<{ id: string }>(
    `SELECT id
       FROM specialist_referrals
      WHERE user_id = $1
        AND specialist_id = $2
        AND recovery_session_id = $3
        AND engagement_status = ANY($4)
      ORDER BY referred_at DESC
      LIMIT 1`,
    [input.user_id, input.specialist_id, input.recovery_session_id, OPEN_REFERRAL_STATUSES],
  );
  if ((existing.rowCount ?? 0) === 1) {
    void emitMetric('recovery_shield.referral_created', {
      specialist_category: category,
      dedupe: true,
    });
    return { referral_id: existing.rows[0]!.id };
  }

  // Fresh insert. engagement_status defaults to 'referred' per
  // migration 067; we set it explicitly to be defensive against a
  // future migration that changes the default.
  const ins = await query<{ id: string }>(
    `INSERT INTO specialist_referrals (
       user_id, specialist_id, recovery_session_id, engagement_status
     ) VALUES ($1, $2, $3, 'referred')
     RETURNING id`,
    [input.user_id, input.specialist_id, input.recovery_session_id],
  );

  void emitMetric('recovery_shield.referral_created', {
    specialist_category: category,
    dedupe: false,
  });

  return { referral_id: ins.rows[0]!.id };
}

/**
 * List referrals owned by this user. Scoped to user_id — users only
 * see their own rows. Optional recovery_session_id narrows further
 * (the iOS per-session dashboard view).
 */
export async function listReferralsForUser(
  user_id: string,
  opts: { recovery_session_id?: string } = {},
): Promise<SpecialistReferralRow[]> {
  if (opts.recovery_session_id) {
    const res = await query<SpecialistReferralRow>(
      `SELECT id, user_id, specialist_id, recovery_session_id,
              referred_at, specialist_acknowledged_at, engagement_status,
              fee_owed_cents, fee_paid_at, outcome_notes
         FROM specialist_referrals
        WHERE user_id = $1 AND recovery_session_id = $2
        ORDER BY referred_at DESC`,
      [user_id, opts.recovery_session_id],
    );
    return res.rows;
  }

  const res = await query<SpecialistReferralRow>(
    `SELECT id, user_id, specialist_id, recovery_session_id,
            referred_at, specialist_acknowledged_at, engagement_status,
            fee_owed_cents, fee_paid_at, outcome_notes
       FROM specialist_referrals
      WHERE user_id = $1
      ORDER BY referred_at DESC`,
    [user_id],
  );
  return res.rows;
}

/**
 * List referrals for a single specialist. Admin / specialist-portal
 * dashboard view — NOT user-scoped (caller authority enforced at the
 * route layer in R-P5).
 *
 * Optional since: filter referred_at >= since (default unbounded).
 * Optional limit: default 100 — admin dashboards page through, this
 * function never returns the full history in one shot.
 */
export async function listReferralsForSpecialist(
  specialist_id: string,
  opts: { since?: Date; limit?: number } = {},
): Promise<SpecialistReferralRow[]> {
  const limit = opts.limit ?? 100;

  if (opts.since) {
    const res = await query<SpecialistReferralRow>(
      `SELECT id, user_id, specialist_id, recovery_session_id,
              referred_at, specialist_acknowledged_at, engagement_status,
              fee_owed_cents, fee_paid_at, outcome_notes
         FROM specialist_referrals
        WHERE specialist_id = $1 AND referred_at >= $2
        ORDER BY referred_at DESC
        LIMIT $3`,
      [specialist_id, opts.since, limit],
    );
    return res.rows;
  }

  const res = await query<SpecialistReferralRow>(
    `SELECT id, user_id, specialist_id, recovery_session_id,
            referred_at, specialist_acknowledged_at, engagement_status,
            fee_owed_cents, fee_paid_at, outcome_notes
       FROM specialist_referrals
      WHERE specialist_id = $1
      ORDER BY referred_at DESC
      LIMIT $2`,
    [specialist_id, limit],
  );
  return res.rows;
}

export interface AdvanceReferralStatusInput {
  referral_id: string;
  next_status: SpecialistReferralRow['engagement_status'];
  outcome_notes?: string;
  /**
   * true → admin caller; can advance to ANY status from any non-
   * terminal status. false → specialist webhook; restricted to the
   * linear forward path AND blocked from user_declined.
   */
  is_admin_actor: boolean;
}

/**
 * Advance the engagement_status of an existing referral. NOT user-
 * scoped — admin / specialist-webhook callers, not end users. The
 * route layer guards caller authority; this service only validates
 * the transition itself.
 *
 * Transition rules:
 *   - Terminal statuses (case_closed_*, user_declined) are terminal
 *     for everyone (including admins) — re-opening means a NEW
 *     referral row.
 *   - is_admin_actor=true: any non-terminal → any other status.
 *   - is_admin_actor=false: linear forward path only AND
 *     user_declined is admin-only.
 *
 * Sets specialist_acknowledged_at = NOW() the first time the row
 * moves to specialist_contacted_user (the specialist's first ack).
 */
export async function advanceReferralStatus(
  input: AdvanceReferralStatusInput,
): Promise<{ referral_id: string; status: SpecialistReferralRow['engagement_status'] }> {
  // Load the current status so we can validate the transition.
  // No user_id scoping — see CROSS-USER LEAKAGE GUARD note above.
  const cur = await query<{ engagement_status: SpecialistReferralRow['engagement_status'] }>(
    `SELECT engagement_status
       FROM specialist_referrals
      WHERE id = $1`,
    [input.referral_id],
  );
  if ((cur.rowCount ?? 0) === 0) {
    throw new ReferralNotFoundError(input.referral_id);
  }
  const from = cur.rows[0]!.engagement_status;
  const to = input.next_status;
  const actor: 'admin' | 'specialist' = input.is_admin_actor ? 'admin' : 'specialist';

  // Terminal states are terminal for ALL actors. Admin re-opens
  // would be a new referral row, not an in-place state revival.
  if (TERMINAL_STATUSES.has(from)) {
    throw new InvalidStatusTransitionError(from, to, actor);
  }

  if (!input.is_admin_actor) {
    // Specialist webhook path — strict linear forward. user_declined
    // is admin-only (it's a user-initiated signal, not specialist).
    if (to === 'user_declined') {
      throw new InvalidStatusTransitionError(from, to, actor);
    }
    if (!SPECIALIST_FORWARD_TRANSITIONS[from].has(to)) {
      throw new InvalidStatusTransitionError(from, to, actor);
    }
  }
  // Admin path — any transition out of a non-terminal status is fine.

  // Specialist's first ack lands here on the referred →
  // specialist_contacted_user transition. specialist_acknowledged_at
  // is monotone — COALESCE preserves any prior value (defensive
  // against re-runs after a clock-skewed webhook redelivery).
  await query(
    `UPDATE specialist_referrals
        SET engagement_status = $2,
            specialist_acknowledged_at = CASE
              WHEN $2 = 'specialist_contacted_user'
                THEN COALESCE(specialist_acknowledged_at, NOW())
              ELSE specialist_acknowledged_at
            END,
            outcome_notes = COALESCE($3, outcome_notes)
      WHERE id = $1`,
    [input.referral_id, to, input.outcome_notes ?? null],
  );

  void emitMetric('recovery_shield.referral_status_advanced', {
    next_status: to,
    actor,
  });

  return { referral_id: input.referral_id, status: to };
}

export interface ReportSpecialistFeeInput {
  referral_id: string;
  fee_owed_cents: bigint;
  /**
   * MUST be true. Specialists cannot self-report fees — fraud
   * surface. UnauthorizedFeeReportError otherwise.
   */
  is_admin_actor: boolean;
}

/**
 * Update fee_owed_cents on a referral row. ADMIN-ONLY. A specialist
 * can NEVER self-report fees they're owed (primary fee-fraud vector;
 * adversarial-review item E). The admin reviews the specialist's
 * invoice + flips this field by hand at v1.
 *
 * Returns the referral_id + the value set.
 */
export async function reportSpecialistFee(
  input: ReportSpecialistFeeInput,
): Promise<{ referral_id: string; fee_owed_cents: bigint }> {
  if (!input.is_admin_actor) {
    throw new UnauthorizedFeeReportError(input.referral_id);
  }

  // Look up the specialist's category for the metric tag. Also
  // doubles as an existence check — a missing referral throws
  // ReferralNotFoundError before we update.
  const sel = await query<{ category: SpecialistRow['category'] }>(
    `SELECT s.category
       FROM specialist_referrals r
       JOIN specialists s ON s.id = r.specialist_id
      WHERE r.id = $1`,
    [input.referral_id],
  );
  if ((sel.rowCount ?? 0) === 0) {
    throw new ReferralNotFoundError(input.referral_id);
  }
  const category = sel.rows[0]!.category;

  await query(
    `UPDATE specialist_referrals
        SET fee_owed_cents = $2
      WHERE id = $1`,
    [input.referral_id, input.fee_owed_cents],
  );

  void emitMetric('recovery_shield.specialist_fee_reported', {
    category,
  });

  return { referral_id: input.referral_id, fee_owed_cents: input.fee_owed_cents };
}

export interface MarkFeePaidInput {
  referral_id: string;
  /** Optional override; defaults to NOW() at the DB layer. */
  paid_at?: Date;
}

/**
 * Mark a referral fee as paid. Idempotent — the UPDATE filters
 * `WHERE fee_paid_at IS NULL`, so running twice leaves the original
 * timestamp intact (no clock-skew rewriting).
 *
 * Emits recovery_shield.specialist_fee_paid only on the first
 * successful flip; a no-op second call does not emit (rowCount=0).
 */
export async function markFeePaid(input: MarkFeePaidInput): Promise<void> {
  // The paid_at parameter is passed as $2; the COALESCE on NOW() is
  // applied DB-side when paid_at is null. Two-phase write because pg
  // doesn't have a clean way to inline "default if param-null"
  // alongside a WHERE-guarded idempotency check.
  const res = await query(
    `UPDATE specialist_referrals
        SET fee_paid_at = COALESCE($2, NOW())
      WHERE id = $1 AND fee_paid_at IS NULL
      RETURNING id`,
    [input.referral_id, input.paid_at ?? null],
  );
  if ((res.rowCount ?? 0) > 0) {
    void emitMetric('recovery_shield.specialist_fee_paid', {});
  }
}
