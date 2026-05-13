// Breach-monitor sync to `/v1/breach/monitor` on the backend.
//
// Pro-only on the backend (requireProTier guard). Free/guest users
// still get the in-app screen — they just keep the one-shot
// `/v1/breach/quick-check` path the screen has always used and the
// local shared-pref store. When a user upgrades to Pro the screen
// transparently switches to persistent monitoring (the next add
// hits this service instead of quick-check, and `list()` starts
// returning their saved identifiers + alerts on cold start).
//
// Backend cap: 10 monitors/user. We never enforce client-side —
// the screen renders the 429 the backend returns as a SnackBar so
// the limit copy stays single-sourced on the server.

import 'api_service.dart';
import 'auth_service.dart';

class BreachExposure {
  final String title;
  final String? sourceDomain;
  final String? date; // ISO yyyy-mm-dd
  final String severity; // 'info' | 'warning' | 'critical'
  final List<String> dataTypes;

  const BreachExposure({
    required this.title,
    this.sourceDomain,
    this.date,
    this.severity = 'warning',
    this.dataTypes = const [],
  });

  /// Decode a row from `/v1/breach/alerts` or the POST-add response.
  factory BreachExposure.fromBackend(Map<String, dynamic> j) => BreachExposure(
        title: (j['breach_title'] as String?) ?? 'Unknown breach',
        sourceDomain: j['source_domain'] as String?,
        date: j['breach_date'] as String?,
        severity: (j['severity'] as String?) ?? 'warning',
        dataTypes: (j['data_types'] as List<dynamic>?)
                ?.map((e) => e.toString())
                .toList() ??
            const [],
      );
}

class BreachMonitor {
  final String backendId;
  final String kind; // 'email' | 'phone'
  final String displayValue;
  final String? status; // 'active' | 'provider_disabled' | null
  final int lastExposureCount;

  const BreachMonitor({
    required this.backendId,
    required this.kind,
    required this.displayValue,
    this.status,
    this.lastExposureCount = 0,
  });

  factory BreachMonitor.fromBackend(Map<String, dynamic> j) => BreachMonitor(
        backendId: j['id'] as String,
        kind: j['kind'] as String,
        displayValue: (j['display_value'] as String?) ?? '',
        status: j['status'] as String?,
        lastExposureCount: (j['last_scan_exposure_count'] as int?) ?? 0,
      );
}

/// What `add()` returns: the new monitor row plus any alerts the
/// backend's first-scan turned up immediately. iOS surfaces both on
/// the same screen without a follow-up round trip.
class BreachAddResult {
  final BreachMonitor monitor;
  final List<BreachExposure> alerts;
  final int newAlerts;

  const BreachAddResult({
    required this.monitor,
    required this.alerts,
    required this.newAlerts,
  });
}

/// Reason an `add()` call failed — surfaced to the UI so it can show
/// the right copy (the cap message vs a generic error vs a duplicate
/// dialog) without the screen having to parse error strings itself.
enum BreachAddError {
  notPro,
  capReached,
  duplicate,
  invalid,
  network,
}

class BreachAddFailure {
  final BreachAddError reason;
  final String? message;
  const BreachAddFailure(this.reason, [this.message]);
}

class BreachMonitorService {
  BreachMonitorService._();
  static final BreachMonitorService instance = BreachMonitorService._();

  /// True only when the user has a real backend account AND a Pro tier
  /// (or is in the grace window). Mirrors FamilyContactsService.canSync
  /// — keep the gate logic identical so a future tier-policy change
  /// touches both screens at once.
  bool get _canSync {
    final s = auth.session;
    if (s == null || s.userId == 'guest') return false;
    return s.tier == 'pro' || s.tier == 'in_grace';
  }

  bool get canSync => _canSync;

  /// GET /v1/breach/monitor + GET /v1/breach/alerts.
  /// Returns null when sync is not available (caller falls back to
  /// the local shared-pref list + quick-check flow).
  Future<({List<BreachMonitor> monitors, List<BreachExposure> alerts})?>
      list() async {
    if (!_canSync) return null;
    try {
      final monitorsRes = await api.get('/v1/breach/monitor');
      final monitorRows = (monitorsRes['items'] as List?) ?? [];
      final monitors = monitorRows
          .map((r) => BreachMonitor.fromBackend(r as Map<String, dynamic>))
          .toList();

      // Alerts are listed separately by the backend — the monitor
      // route only returns the per-row last_scan_exposure_count.
      final alertsRes = await api.get('/v1/breach/alerts');
      final alertRows = (alertsRes['alerts'] as List?) ?? [];
      final alerts = alertRows
          .map((r) => BreachExposure.fromBackend(r as Map<String, dynamic>))
          .toList();

      return (monitors: monitors, alerts: alerts);
    } on ApiException {
      // 401/403/5xx — fall back to local so a transient dip doesn't
      // wipe the screen.
      return null;
    } catch (_) {
      return null;
    }
  }

  /// POST /v1/breach/monitor. Returns the persisted monitor + the
  /// first-scan alerts the backend ran inline, or a BreachAddFailure
  /// describing why the add was refused.
  ///
  /// Caller still keeps the row locally on `network` failures so the
  /// UI stays responsive if the backend is flaky.
  Future<({BreachAddResult? ok, BreachAddFailure? err})> add({
    required String kind, // 'email' | 'phone'
    required String value,
  }) async {
    if (!_canSync) {
      return (ok: null, err: const BreachAddFailure(BreachAddError.notPro));
    }
    try {
      final res = await api.post('/v1/breach/monitor', {
        'kind': kind,
        'value': value,
      });
      final monitored = res['monitored'] as Map<String, dynamic>?;
      if (monitored == null) {
        return (
          ok: null,
          err: const BreachAddFailure(BreachAddError.network),
        );
      }
      final monitor = BreachMonitor.fromBackend(monitored);
      final alertRows = (res['alerts'] as List?) ?? [];
      final alerts = alertRows
          .map((r) => BreachExposure.fromBackend(r as Map<String, dynamic>))
          .toList();
      final newAlerts = (res['new_alerts'] as int?) ?? alerts.length;
      return (
        ok: BreachAddResult(
          monitor: monitor,
          alerts: alerts,
          newAlerts: newAlerts,
        ),
        err: null,
      );
    } on ApiException catch (e) {
      // Cap reached: backend returns 429 with `monitor_cap_reached`.
      // Duplicate: 409 `identifier_already_monitored`.
      // 400 `invalid_email` / `invalid_phone` — surface as `invalid`.
      if (e.statusCode == 429) {
        return (
          ok: null,
          err: BreachAddFailure(BreachAddError.capReached, e.message),
        );
      }
      if (e.statusCode == 409) {
        return (
          ok: null,
          err: BreachAddFailure(BreachAddError.duplicate, e.message),
        );
      }
      if (e.statusCode == 400) {
        return (
          ok: null,
          err: BreachAddFailure(BreachAddError.invalid, e.message),
        );
      }
      return (
        ok: null,
        err: BreachAddFailure(BreachAddError.network, e.message),
      );
    } catch (_) {
      return (
        ok: null,
        err: const BreachAddFailure(BreachAddError.network),
      );
    }
  }

  /// DELETE /v1/breach/monitor/:id. Best-effort: true on success or
  /// 404 (already gone), false on transient failure so the caller can
  /// keep the local row pending a retry.
  Future<bool> delete(String backendId) async {
    if (!_canSync) return true;
    try {
      await api.delete('/v1/breach/monitor/$backendId');
      return true;
    } on ApiException catch (e) {
      if (e.statusCode == 404) return true;
      return false;
    } catch (_) {
      return false;
    }
  }
}

final breachMonitorService = BreachMonitorService.instance;
