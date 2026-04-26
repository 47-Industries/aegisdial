import { query } from './db.js';
import { linesForProductId } from './plans.js';

// After a subscription verifies / renews, make sure the paying user's
// family_plans row reflects the line counts they paid for. The plan is
// auto-created if it doesn't exist yet (so their first invite works without
// a second round-trip). If the plan does exist, we only ever INCREASE line
// counts here — downgrades happen explicitly via a separate flow so we
// don't kick existing members mid-month.

export async function syncFamilyPlanSeatsToSubscription(
  userId: string,
  productId: string,
): Promise<void> {
  const { included, addon } = linesForProductId(productId);

  await query(
    `INSERT INTO family_plans (owner_user_id, included_lines, addon_lines)
     VALUES ($1, $2, $3)
     ON CONFLICT (owner_user_id) DO UPDATE SET
       included_lines = GREATEST(family_plans.included_lines, EXCLUDED.included_lines),
       addon_lines    = GREATEST(family_plans.addon_lines,    EXCLUDED.addon_lines),
       updated_at     = NOW()`,
    [userId, included, addon],
  );

  await query(
    `INSERT INTO family_members (family_plan_id, user_id, role)
     SELECT id, owner_user_id, 'owner' FROM family_plans WHERE owner_user_id = $1
     ON CONFLICT (family_plan_id, user_id) DO NOTHING`,
    [userId],
  );
}
