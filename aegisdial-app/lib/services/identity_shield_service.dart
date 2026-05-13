// Identity Shield sync to `/v1/identity-shield/*` on the backend.
//
// Pro-only on every route (the backend enforces requireProTier). Unlike
// Breach Monitor — which has a quick-check free-tier fallback — Identity
// Shield is strictly Pro: free users see a paywall card on the screen
// and never hit these endpoints.
//
// We only expose email + phone monitor kinds in v1. The hashed kinds
// (ssn_last4_hash, dob_hash, name_address_hash) require an extra
// security-aware add flow that ships later — when we add an SSN
// keypad with an obscured TextField + explicit "we never store
// your SSN — only a salted hash" disclosure.

import 'api_service.dart';
import 'auth_service.dart';

class IdentityMonitor {
  final String backendId;
  final String kind; // 'email' | 'phone_e164' | 'ssn_last4_hash' | 'dob_hash' | 'name_address_hash'
  final String valuePreview; // backend-masked
  final DateTime createdAt;

  const IdentityMonitor({
    required this.backendId,
    required this.kind,
    required this.valuePreview,
    required this.createdAt,
  });

  factory IdentityMonitor.fromBackend(Map<String, dynamic> j) => IdentityMonitor(
        backendId: j['id'] as String,
        kind: (j['monitor_kind'] as String?) ?? 'email',
        valuePreview: (j['value_preview'] as String?) ?? '',
        createdAt: DateTime.tryParse((j['created_at'] as String?) ?? '') ??
            DateTime.now(),
      );
}

class IdentityFinding {
  final String backendId;
  final String monitorId;
  final String monitorKind;
  final String valuePreview;
  final String breachName;
  final String? breachDomain;
  final String? breachDate; // yyyy-mm-dd
  final List<String> dataClasses;
  final String severity; // 'info' | 'warning' | 'critical'
  final DateTime surfacedAt;
  final DateTime? acknowledgedAt;
  final DateTime? remediationCompletedAt;

  const IdentityFinding({
    required this.backendId,
    required this.monitorId,
    required this.monitorKind,
    required this.valuePreview,
    required this.breachName,
    this.breachDomain,
    this.breachDate,
    this.dataClasses = const [],
    required this.severity,
    required this.surfacedAt,
    this.acknowledgedAt,
    this.remediationCompletedAt,
  });

  factory IdentityFinding.fromBackend(Map<String, dynamic> j) {
    final monitor = (j['monitor'] as Map<String, dynamic>?) ?? const {};
    final breach = (j['breach'] as Map<String, dynamic>?) ?? const {};
    return IdentityFinding(
      backendId: j['id'] as String,
      monitorId: (monitor['id'] as String?) ?? '',
      monitorKind: (monitor['monitor_kind'] as String?) ?? 'email',
      valuePreview: (monitor['value_preview'] as String?) ?? '',
      breachName: (breach['name'] as String?) ?? 'Unknown breach',
      breachDomain: breach['domain'] as String?,
      breachDate: breach['breach_date'] as String?,
      dataClasses: (breach['data_classes'] as List<dynamic>?)
              ?.map((e) => e.toString())
              .toList() ??
          const [],
      severity: (j['severity'] as String?) ?? 'info',
      surfacedAt:
          DateTime.tryParse((j['surfaced_at'] as String?) ?? '') ??
              DateTime.now(),
      acknowledgedAt: j['acknowledged_at'] == null
          ? null
          : DateTime.tryParse(j['acknowledged_at'] as String),
      remediationCompletedAt: j['remediation_completed_at'] == null
          ? null
          : DateTime.tryParse(j['remediation_completed_at'] as String),
    );
  }

  bool get acknowledged => acknowledgedAt != null;
}

/// Snapshot of the Identity Shield home-screen tile counts. Mirrors
/// the `identity_shield` sub-object in `/v1/stats/summary`.
class IdentityShieldTile {
  final int monitorsActive;
  final int newFindings7d;
  final int activeThreatsNearUser30d;
  final int activeThreatsDelta7d;

  const IdentityShieldTile({
    required this.monitorsActive,
    required this.newFindings7d,
    required this.activeThreatsNearUser30d,
    required this.activeThreatsDelta7d,
  });

  factory IdentityShieldTile.fromStats(Map<String, dynamic> j) {
    final s = (j['identity_shield'] as Map<String, dynamic>?) ?? const {};
    return IdentityShieldTile(
      monitorsActive: ((s['monitors_active'] as num?) ?? 0).toInt(),
      newFindings7d: ((s['new_findings_7d'] as num?) ?? 0).toInt(),
      activeThreatsNearUser30d:
          ((s['active_threats_near_user_30d'] as num?) ?? 0).toInt(),
      activeThreatsDelta7d:
          ((s['active_threats_delta_7d'] as num?) ?? 0).toInt(),
    );
  }

  bool get hasAnySignal =>
      monitorsActive > 0 ||
      newFindings7d > 0 ||
      activeThreatsNearUser30d > 0;
}

/// Aggregate breakdown of active scammer activity from
/// `/v1/identity-shield/threats/near`. Total + 7d delta plus severity
/// and identifier-kind histograms.
class IdentityThreatsBreakdown {
  final int total;
  final int delta7d;
  final Map<String, int> bySeverity; // informational/caution/warning/confirmed_scammer
  final Map<String, int> byKind; // phone_e164/email_address/crypto_wallet/url_host/ip_address

  const IdentityThreatsBreakdown({
    required this.total,
    required this.delta7d,
    required this.bySeverity,
    required this.byKind,
  });

  factory IdentityThreatsBreakdown.fromBackend(Map<String, dynamic> j) {
    Map<String, int> intMap(dynamic raw) {
      if (raw is Map) {
        return raw.map(
          (k, v) => MapEntry(k.toString(), v is num ? v.toInt() : 0),
        );
      }
      return const {};
    }

    return IdentityThreatsBreakdown(
      total: ((j['total'] as num?) ?? 0).toInt(),
      delta7d: ((j['delta_7d'] as num?) ?? 0).toInt(),
      bySeverity: intMap(j['by_severity']),
      byKind: intMap(j['by_kind']),
    );
  }
}

class IdentityShieldService {
  IdentityShieldService._();
  static final IdentityShieldService instance = IdentityShieldService._();

  bool get _canSync {
    final s = auth.session;
    if (s == null || s.userId == 'guest') return false;
    return s.tier == 'pro' || s.tier == 'in_grace';
  }

  bool get canSync => _canSync;

  /// GET /v1/identity-shield/monitors. Returns null when not Pro / on
  /// transient error so the caller can show the paywall / "couldn't
  /// load" copy without nuking the screen.
  Future<List<IdentityMonitor>?> listMonitors() async {
    if (!_canSync) return null;
    try {
      final res = await api.get('/v1/identity-shield/monitors');
      final rows = (res['monitors'] as List?) ?? [];
      return rows
          .map((r) => IdentityMonitor.fromBackend(r as Map<String, dynamic>))
          .toList();
    } on ApiException {
      return null;
    } catch (_) {
      return null;
    }
  }

  /// POST /v1/identity-shield/monitors. Only email + phone exposed in
  /// v1 — hashed kinds (ssn/dob) need a dedicated guarded UI flow.
  Future<({IdentityMonitor? ok, String? err})> addMonitor({
    required String kind, // 'email' | 'phone_e164'
    required String value,
  }) async {
    if (!_canSync) return (ok: null, err: 'not_pro');
    try {
      final res = await api.post('/v1/identity-shield/monitors', {
        'monitor_kind': kind,
        'value': value,
      });
      final raw = res['monitor'] as Map<String, dynamic>?;
      if (raw == null) return (ok: null, err: 'unknown');
      return (ok: IdentityMonitor.fromBackend(raw), err: null);
    } on ApiException catch (e) {
      // 400 invalid_body, 409 duplicate, 429 cap, 5xx transient.
      // ApiException.message is non-nullable so we cast straight; the
      // status code is appended only when message is empty (defensive).
      final msg = e.message.isNotEmpty ? e.message : 'http_${e.statusCode}';
      return (ok: null, err: msg);
    } catch (_) {
      return (ok: null, err: 'network');
    }
  }

  /// DELETE /v1/identity-shield/monitors/:id. Soft-deletes server-side.
  Future<bool> deleteMonitor(String backendId) async {
    if (!_canSync) return true;
    try {
      await api.delete('/v1/identity-shield/monitors/$backendId');
      return true;
    } on ApiException catch (e) {
      if (e.statusCode == 404) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  /// GET /v1/identity-shield/findings. Default 50 most recent.
  Future<List<IdentityFinding>?> listFindings({
    String severity = 'all',
    String acknowledged = 'all',
    int limit = 50,
  }) async {
    if (!_canSync) return null;
    try {
      final res = await api.get(
        '/v1/identity-shield/findings?severity=$severity'
        '&acknowledged=$acknowledged&limit=$limit',
      );
      final rows = (res['findings'] as List?) ?? [];
      return rows
          .map((r) => IdentityFinding.fromBackend(r as Map<String, dynamic>))
          .toList();
    } on ApiException {
      return null;
    } catch (_) {
      return null;
    }
  }

  /// GET /v1/identity-shield/threats/near. Returns aggregate counts of
  /// active scammer activity bucketed by severity + identifier kind.
  /// Backend caches for 5 min so repeated polls are cheap.
  Future<IdentityThreatsBreakdown?> threatsNear() async {
    if (!_canSync) return null;
    try {
      final res = await api.get('/v1/identity-shield/threats/near');
      return IdentityThreatsBreakdown.fromBackend(res);
    } on ApiException {
      return null;
    } catch (_) {
      return null;
    }
  }

  /// POST /v1/identity-shield/findings/:id/acknowledge. Idempotent.
  Future<bool> acknowledgeFinding(String findingId) async {
    if (!_canSync) return false;
    try {
      await api.post('/v1/identity-shield/findings/$findingId/acknowledge', {});
      return true;
    } catch (_) {
      return false;
    }
  }
}

final identityShieldService = IdentityShieldService.instance;
