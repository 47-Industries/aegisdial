import type { FastifyInstance } from 'fastify';
import { query } from '../lib/db.js';
import { requireAppUser } from '../lib/auth.js';

// Engagement stats. The #1 retention hook for subscription safety
// apps ("you avoided 12 scams this week") — without this users
// forget the app is working. LifeLock's dashboard shows this
// prominently; we do the same.
//
// Cheap queries: every column is already indexed by user_id + time.
// Result size is constant, so rate-limiting isn't required.

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/stats/summary',
    { preHandler: [requireAppUser] },
    async (req, reply) => {
      const user = req.appUser!;

      // Each count is per-query catch-protected so a missing table
      // (rolling deploy where the migration hasn't applied yet) doesn't
      // 500 the home screen. The home screen renders the "scams
      // blocked" header off this endpoint — it must NEVER fail.
      // Adversarial fix H1: this was previously naked Promise.all
      // with a comment claiming graceful degradation; the comment lied.
      // `query()` throws on missing relation and Promise.all propagates.
      const zeroCount = { rows: [{ count: '0' }] };
      const countOrZero = (sql: string) =>
        query<{ count: string }>(sql, [user.id]).catch(() => zeroCount);
      // active_threats has no user_id column (it's a global threat
      // catalog) — these counts are scope-free, so they need their
      // own zero-arg variant of countOrZero to avoid an unused $1.
      // Same catch shape so a missing-table rolling-deploy node still
      // renders the home screen.
      const globalCountOrZero = (sql: string) =>
        query<{ count: string }>(sql, []).catch(() => zeroCount);

      const [
        shieldsThisWeek,
        criticalAvoided30d,
        breachesFound30d,

        smsJunkedAllTime,
        smsScansFlaggedAllTime,
        smsScansFlagged30d,
        emailScansFlaggedAllTime,
        emailScansFlagged30d,
        emailCompromiseReports30d,
        emailTamperAlertsPending,
        identityMonitorsActive,
        identityFindings7d,
        identityActiveThreats30d,
        identityActiveThreatsNew7d,
        criticalAllTime,
      ] = await Promise.all([
        countOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM call_sessions
            WHERE user_id = $1 AND started_at > NOW() - INTERVAL '7 days'`,
        ),
        countOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM call_sessions
            WHERE user_id = $1
              AND started_at > NOW() - INTERVAL '30 days'
              AND risk_level = 'critical'`,
        ),
        countOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM breach_alerts
            WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'`,
        ),
        countOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM sms_classifications
            WHERE user_id = $1 AND action = 'junk'`,
        ),
        // SMS Shield manual-paste verdicts of 'fraud' or 'suspicious'
        // are the same kind of "scam blocked" event as a critical call
        // — the user pasted something risky and the system flagged it.
        // We count them all-time (for the retention-hook total) and
        // also 30-day, so iOS can render the same shape it already
        // renders for calls.
        countOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM sms_scans
            WHERE user_id = $1 AND verdict IN ('fraud', 'suspicious')`,
        ),
        countOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM sms_scans
            WHERE user_id = $1
              AND scanned_at > NOW() - INTERVAL '30 days'
              AND verdict IN ('fraud', 'suspicious')`,
        ),
        // Email Shield mirrors the SMS Shield pattern: fraud +
        // suspicious verdicts roll into the home-screen "scams
        // blocked" hook. countOrZero protects against the
        // migration-not-applied rolling-deploy state — if
        // email_scans doesn't exist yet on this node, count is 0
        // and the home screen still renders.
        countOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM email_scans
            WHERE user_id = $1 AND verdict IN ('fraud', 'suspicious')`,
        ),
        countOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM email_scans
            WHERE user_id = $1
              AND scanned_at > NOW() - INTERVAL '30 days'
              AND verdict IN ('fraud', 'suspicious')`,
        ),
        // Compromise-check reports in the last 30d that surfaced
        // findings worth showing. 'clean' reports don't count
        // toward the engagement hook (no scammer was blocked —
        // there was nothing to block).
        countOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM email_compromise_reports
            WHERE user_id = $1
              AND generated_at > NOW() - INTERVAL '30 days'
              AND overall_verdict IN ('concerns', 'compromised')`,
        ),
        // Pending tamper alerts: "Did you delete this?" prompts the
        // user hasn't tapped yet. Surfaced as a home-screen badge
        // count so iOS doesn't need a second round-trip to know
        // whether to render the dot. Capped naturally by the
        // per-user pending cap of 5 in the detector.
        countOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM email_tamper_alerts
            WHERE user_id = $1 AND status = 'pending'`,
        ),
        // Identity Shield I-P5 dashboard tile. Four counts power the
        // home-screen card: how many identifiers the user is watching,
        // how many fresh breaches surfaced in the last 7d, the size of
        // the live active_threats pool right now, and how many of those
        // are NEW in the last 7d (the "delta" arrow on the card).
        // Wrapped in countOrZero so a missing migration on this node
        // contributes 0 instead of 500ing the home screen — same
        // adversarial-fix discipline as the email_* block above.
        countOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM identity_monitors
            WHERE user_id = $1 AND active = TRUE`,
        ),
        countOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM identity_breach_findings
            WHERE user_id = $1 AND surfaced_at > NOW() - INTERVAL '7 days'`,
        ),
        // active_threats is a global catalog (no user_id). The "near
        // user" count is currently the global non-expired total —
        // I-P6 will geo-scope this. Both queries reuse the partial
        // index idx_threats_recent on (last_seen_at) WHERE expires_at
        // IS NULL OR expires_at > NOW().
        globalCountOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM active_threats
            WHERE last_seen_at > NOW() - INTERVAL '30 days'
              AND (expires_at IS NULL OR expires_at > NOW())`,
        ),
        globalCountOrZero(
          `SELECT COUNT(*)::TEXT AS count FROM active_threats
            WHERE first_seen_at > NOW() - INTERVAL '7 days'
              AND (expires_at IS NULL OR expires_at > NOW())`,
        ),
        query<{ count: string }>(
          `SELECT COUNT(*)::TEXT AS count FROM call_sessions
            WHERE user_id = $1 AND risk_level = 'critical'`,
          [user.id],
        ),
      ]);

      return reply.send({
        shields_this_week: Number(shieldsThisWeek.rows[0]!.count),
        critical_calls_avoided_30d: Number(criticalAvoided30d.rows[0]!.count),
        breaches_found_30d: Number(breachesFound30d.rows[0]!.count),
        sms_scans_flagged_30d: Number(smsScansFlagged30d.rows[0]!.count),
        email_scans_flagged_30d: Number(emailScansFlagged30d.rows[0]!.count),
        email_compromise_alerts_30d: Number(emailCompromiseReports30d.rows[0]!.count),
        email_tamper_alerts_pending: Number(emailTamperAlertsPending.rows[0]!.count),
        // Aggregate "scams blocked" hook. Four sources, all counted:
        //   - critical calls (Live Shield)
        //   - SMS auto-filter junked (Apple ILMessageFilterExtension)
        //   - SMS Shield manual-paste verdicts of fraud OR suspicious
        //   - Email Shield verdicts of fraud OR suspicious
        // Each source is wrapped in countOrZero — if any underlying
        // table is missing during a rolling deploy, that source
        // contributes 0 instead of throwing.
        // The all-time hook sums every kind of "scam blocked" event we
        // record. We use the all-time `criticalAllTime` (not the
        // 30-day rolling `criticalAvoided30d` Jesiah's PR-10 squash
        // wrote) so the field actually matches its name. SMS Shield +
        // Email Shield contribute their all-time fraud/suspicious
        // verdicts. Junked auto-filter SMS rolls in too.
        scams_blocked_all_time:
          Number(smsJunkedAllTime.rows[0]!.count) +
          Number(criticalAllTime.rows[0]!.count) +
          Number(smsScansFlaggedAllTime.rows[0]!.count) +
          Number(emailScansFlaggedAllTime.rows[0]!.count),
        // Identity Shield I-P5 dashboard tile — four counts, no PII.
        // active_threats_near_user_30d is currently the global pool
        // (active_threats has no user_id column); active_threats_delta_7d
        // mirrors the threats/near endpoint's count_delta_7d so the
        // home-screen card and the dedicated Identity Shield screen
        // never disagree on the growth-arrow figure.
        identity_shield: {
          monitors_active: Number(identityMonitorsActive.rows[0]!.count),
          new_findings_7d: Number(identityFindings7d.rows[0]!.count),
          active_threats_near_user_30d: Number(identityActiveThreats30d.rows[0]!.count),
          active_threats_delta_7d: Number(identityActiveThreatsNew7d.rows[0]!.count),
        },
      });
    },
  );
}
