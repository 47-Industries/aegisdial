import { query } from './db.js';
import { config } from '../config.js';

// Single source of truth for "is this user entitled to live lookups right
// now?" — derived from three checks (most favorable wins):
//   1. Is this user's email on the PRO_GRANT_EMAILS allowlist?
//      (founders, full-time team, App Store reviewer, partner comps)
//   2. Does the user have their own active subscription?
//   3. Are they a member of a family plan whose OWNER has one?

export type UserTier = 'pending' | 'pro' | 'expired' | 'cancelled';

const DEV_USER_ID = '00000000-0000-0000-0000-000000000000';

export async function currentTier(userId: string): Promise<UserTier> {
  if (userId === DEV_USER_ID) {
    // Dev shared-secret placeholder — always pro so local curls keep working.
    return 'pro';
  }

  // Short-circuit for allowlisted accounts (founders, team, reviewer).
  // One small DB read here is cheaper than risking a cofounder hitting
  // the paywall mid-demo because their trial timer ran out.
  if (config.PRO_GRANT_EMAILS.length > 0) {
    const emailRes = await query<{ email: string | null }>(
      `SELECT email FROM users WHERE id = $1`,
      [userId],
    );
    const email = emailRes.rows[0]?.email?.toLowerCase() ?? null;
    if (email && config.PRO_GRANT_EMAILS.includes(email)) {
      return 'pro';
    }
  }

  const [ownRes, familyRes] = await Promise.all([
    query<{ status: string; current_period_end: Date }>(
      `SELECT status, current_period_end
         FROM subscriptions
        WHERE user_id = $1
        ORDER BY current_period_end DESC
        LIMIT 1`,
      [userId],
    ),
    query<{ status: string; current_period_end: Date }>(
      `SELECT s.status, s.current_period_end
         FROM family_members fm
         JOIN family_plans fp ON fp.id = fm.family_plan_id
         JOIN subscriptions s ON s.user_id = fp.owner_user_id
        WHERE fm.user_id = $1
          AND fm.role = 'member'
        ORDER BY s.current_period_end DESC
        LIMIT 1`,
      [userId],
    ),
  ]);

  const own = classifyRow(ownRes.rows[0]);
  const inherited = classifyRow(familyRes.rows[0]);
  return mergeTiers(own, inherited);
}

function classifyRow(
  row: { status: string; current_period_end: Date } | undefined,
): UserTier {
  if (!row) return 'pending';
  const now = new Date();
  if (row.status === 'active' && row.current_period_end > now) return 'pro';
  if (row.status === 'in_grace' && row.current_period_end > now) return 'pro';
  if (row.status === 'cancelled') return 'cancelled';
  return 'expired';
}

function mergeTiers(a: UserTier, b: UserTier): UserTier {
  const order: UserTier[] = ['pending', 'cancelled', 'expired', 'pro'];
  return order.indexOf(a) > order.indexOf(b) ? a : b;
}

export async function ensureTierPersisted(userId: string, tier: UserTier): Promise<void> {
  if (userId === DEV_USER_ID) return;
  await query(
    `UPDATE users SET tier = $2 WHERE id = $1 AND tier IS DISTINCT FROM $2`,
    [userId, tier],
  );
}
