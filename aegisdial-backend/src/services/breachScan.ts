import { query, withTx } from '../lib/db.js';
import {
  lookupExposures,
  lookupExposuresWithStatus,
  isEnzoicDisabled,
  hashIdentifier,
  type EnzoicIdentifierKind,
  type EnzoicExposure,
} from '../lib/enzoic.js';
import { config } from '../config.js';

// breachScan — fetch Enzoic exposures for one or more monitored
// identifiers, insert new rows into breach_alerts, and return the
// set of alerts that are newly surfaced (so callers can push-notify).

export interface ScanReport {
  monitored_id: string;
  exposures_found: number;
  new_alerts: number;
  // Present when the provider intentionally short-circuited (e.g. phone
  // lookup against live Enzoic). iOS uses this to render the
  // "phone monitoring coming soon" state instead of empty-state.
  status?: 'active' | 'provider_disabled';
  disabled_reason?: string;
}

export async function scanIdentifier(
  userId: string,
  monitoredId: string,
  kind: EnzoicIdentifierKind,
  identifier: string,
): Promise<ScanReport> {
  // For phone identifiers we have to distinguish "provider returned
  // zero exposures" from "provider doesn't support phone yet." The
  // old path called lookupExposures() which flattened the sentinel
  // into [], so iOS showed a false all-clear. Route phone through
  // the status-aware variant and persist monitored_identifiers.status
  // when the provider is disabled.
  if (kind === 'phone') {
    const result = await lookupExposuresWithStatus(kind, identifier);
    if (isEnzoicDisabled(result)) {
      await query(
        `UPDATE monitored_identifiers
            SET last_scanned_at = NOW(),
                last_scan_exposure_count = 0,
                status = 'provider_disabled'
          WHERE id = $1`,
        [monitoredId],
      );
      return {
        monitored_id: monitoredId,
        exposures_found: 0,
        new_alerts: 0,
        status: 'provider_disabled',
        disabled_reason: result.reason,
      };
    }
    return insertExposures(userId, monitoredId, result);
  }

  const exposures = await lookupExposures(kind, identifier);
  return insertExposures(userId, monitoredId, exposures);
}

/**
 * INVARIANT: callers MUST have already routed any provider-disabled
 * sentinel (see `isEnzoicDisabled`) away from this function. Reaching
 * here means the scan genuinely succeeded, and status below flips to
 * 'active' unconditionally — which is the correct auto-recovery path
 * when a previously disabled provider comes back. If a new kind ever
 * gets its own disabled sentinel, add the branch upstream (alongside
 * the phone-disabled branch), NOT inside this function.
 */
async function insertExposures(
  userId: string,
  monitoredId: string,
  exposures: EnzoicExposure[],
): Promise<ScanReport> {
  let inserted = 0;
  await withTx(async (client) => {
    for (const e of exposures) {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO breach_alerts
            (user_id, monitored_id, source, exposure_id, breach_title,
             breach_date, source_domain, data_types, entries_count,
             severity, description)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (monitored_id, source, exposure_id) DO NOTHING
         RETURNING id`,
        [
          userId,
          monitoredId,
          mockOrEnzoic(e),
          e.id,
          e.title,
          e.date ? new Date(e.date) : null,
          e.source_domain,
          e.data_types,
          e.entries_count,
          e.severity,
          e.description,
        ],
      );
      if (ins.rows[0]) inserted++;
    }
    // A successful scan (even 0 exposures) resets status to 'active'
    // in case a prior run had flipped it to 'provider_disabled' and
    // the provider has since become available.
    await client.query(
      `UPDATE monitored_identifiers
          SET last_scanned_at = NOW(),
              last_scan_exposure_count = $2,
              status = 'active'
        WHERE id = $1`,
      [monitoredId, exposures.length],
    );
  });

  return {
    monitored_id: monitoredId,
    exposures_found: exposures.length,
    new_alerts: inserted,
    status: 'active',
  };
}

function mockOrEnzoic(e: EnzoicExposure): 'enzoic' | 'mock' {
  return e.id.startsWith('mock-') ? 'mock' : 'enzoic';
}

export async function scanAllForUser(userId: string): Promise<ScanReport[]> {
  const rows = await query<{
    id: string;
    kind: 'email' | 'phone';
    display_value: string;
  }>(
    `SELECT id, kind, display_value FROM monitored_identifiers WHERE user_id = $1`,
    [userId],
  );
  const reports: ScanReport[] = [];
  for (const r of rows.rows) {
    // We only stored the hash in the DB; for scanning we need the
    // plaintext identifier. In practice the caller posts the plaintext
    // fresh (add-monitored-identifier flow). For background workers we
    // accept that re-scans use the display_value as a best effort — it
    // is the exact, unmasked input the user provided at add time.
    // TODO: encrypt + persist the plaintext behind a KMS envelope if
    // we want silent background re-scan across restarts.
    reports.push(await scanIdentifier(userId, r.id, r.kind, r.display_value));
  }
  return reports;
}

export function getHashed(value: string): string {
  return hashIdentifier(value);
}

// re-export for routes
export { config as _cfg };
