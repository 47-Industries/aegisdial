import 'api_service.dart';

final callScreener = CallScreenerService._();

class CallScreenerService {
  CallScreenerService._();

  final _api = ApiService.instance;

  /// Provision a Twilio screener number for this user.
  /// Returns the number + carrier setup codes + instructions.
  Future<ScreenerProvisionResult?> provision() async {
    try {
      final data = await _api.post('/v1/call-screener/provision', {});
      return ScreenerProvisionResult.fromJson(data);
    } on ApiException {
      return null;
    } catch (_) {
      return null;
    }
  }

  /// Release the user's screener number.
  Future<bool> release() async {
    try {
      await _api.delete('/v1/call-screener/number', {});
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Get current screener status.
  Future<ScreenerStatus?> getStatus() async {
    try {
      final data = await _api.get('/v1/call-screener/status');
      return ScreenerStatus.fromJson(data);
    } on ApiException catch (e) {
      if (e.statusCode == 501) return null; // feature not enabled
      return null;
    } catch (_) {
      return null;
    }
  }

  /// Get screened call history.
  Future<List<ScreenedCall>> getHistory() async {
    try {
      final data = await _api.get('/v1/call-screener/history');
      final list = data['calls'] as List? ?? [];
      return list.map((c) => ScreenedCall.fromJson(c as Map<String, dynamic>)).toList();
    } catch (_) {
      return [];
    }
  }
}

class ScreenerProvisionResult {
  final String phone;
  final bool provisioned;
  final Map<String, String> setupCodes;
  final List<String> instructions;

  ScreenerProvisionResult({
    required this.phone,
    required this.provisioned,
    required this.setupCodes,
    required this.instructions,
  });

  factory ScreenerProvisionResult.fromJson(Map<String, dynamic> json) {
    final number = json['number'] as Map<String, dynamic>? ?? {};
    final codes = json['setup_codes'] as Map<String, dynamic>? ?? {};
    final instructions = (json['instructions'] as List?)
            ?.map((e) => e.toString())
            .toList() ??
        [];
    return ScreenerProvisionResult(
      phone: number['phone']?.toString() ?? '',
      provisioned: number['provisioned'] == true,
      setupCodes: codes.map((k, v) => MapEntry(k, v.toString())),
      instructions: instructions,
    );
  }
}

class ScreenerStatus {
  final bool active;
  final String? phone;
  final String? since;
  final Map<String, String>? setupCodes;
  final int totalCalls;
  final int blockedCalls;
  final int passedCalls;

  ScreenerStatus({
    required this.active,
    this.phone,
    this.since,
    this.setupCodes,
    required this.totalCalls,
    required this.blockedCalls,
    required this.passedCalls,
  });

  factory ScreenerStatus.fromJson(Map<String, dynamic> json) {
    final number = json['number'] as Map<String, dynamic>?;
    final codes = json['setup_codes'] as Map<String, dynamic>?;
    final stats = json['stats_30d'] as Map<String, dynamic>? ?? {};
    return ScreenerStatus(
      active: json['active'] == true,
      phone: number?['phone']?.toString(),
      since: number?['since']?.toString(),
      setupCodes: codes?.map((k, v) => MapEntry(k, v.toString())),
      totalCalls: (stats['total'] as num?)?.toInt() ?? 0,
      blockedCalls: (stats['blocked'] as num?)?.toInt() ?? 0,
      passedCalls: (stats['passed'] as num?)?.toInt() ?? 0,
    );
  }
}

class ScreenedCall {
  final int id;
  final String fromE164;
  final String? verdict;
  final String? summary;
  final String? callerName;
  final String? callerPurpose;
  final int? riskScore;
  final String? riskLevel;
  final String? scamType;
  final bool forwarded;
  final int? durationSecs;
  final String createdAt;

  ScreenedCall({
    required this.id,
    required this.fromE164,
    this.verdict,
    this.summary,
    this.callerName,
    this.callerPurpose,
    this.riskScore,
    this.riskLevel,
    this.scamType,
    required this.forwarded,
    this.durationSecs,
    required this.createdAt,
  });

  factory ScreenedCall.fromJson(Map<String, dynamic> json) {
    return ScreenedCall(
      id: (json['id'] as num).toInt(),
      fromE164: json['fromE164']?.toString() ?? json['from_e164']?.toString() ?? '',
      verdict: json['verdict']?.toString(),
      summary: json['summary']?.toString(),
      callerName: json['callerName']?.toString() ?? json['caller_name']?.toString(),
      callerPurpose: json['callerPurpose']?.toString() ?? json['caller_purpose']?.toString(),
      riskScore: (json['riskScore'] ?? json['risk_score']) as int?,
      riskLevel: json['riskLevel']?.toString() ?? json['risk_level']?.toString(),
      scamType: json['scamType']?.toString() ?? json['scam_type']?.toString(),
      forwarded: json['forwarded'] == true,
      durationSecs: (json['durationSecs'] ?? json['duration_secs']) as int?,
      createdAt: json['createdAt']?.toString() ?? json['created_at']?.toString() ?? '',
    );
  }
}
