// Live Shield client — calls into the v2 backend's
// /v1/live-shield/{start,:id/transcript,:id/end} endpoints.
//
// The screen that wraps this (live_shield_active.dart) is currently a
// scripted demo: hardcoded scenarios + hardcoded scores. This service
// gives it real backend integration. When the caller is Pro and the
// network is healthy, we surface the actual risk_score, risk_level,
// coaching_line, and triggered_categories that the v2 hybrid engine
// computes. When anything fails (non-Pro / 401 / offline / 5xx) the
// caller falls back to its scripted scores — the demo never breaks.
//
// consent_version is hardcoded to 2 here because we render the v2
// consent disclosure copy before the demo starts. Until that screen
// ships, the LLM path is dormant on the backend even if a v2 client
// asks for it (the LLM service has its own gate). Safe to ship now.

import 'api_service.dart';

class LiveShieldStartResult {
  final String sessionId;
  final DateTime startedAt;
  LiveShieldStartResult(this.sessionId, this.startedAt);
}

class LiveShieldChunkResult {
  final int riskScore;            // 0-100
  final String riskLevel;         // 'low' | 'medium' | 'high' | 'critical'
  final List<String> triggeredCategories;
  final String? coachingLine;     // v2 LLM coaching, null on regex-only path
  final String? llmScamType;      // 'irs_impersonation' | 'tech_support' | ...
  final List<String> newWarnings;
  final bool familyVerifySuggested;

  LiveShieldChunkResult({
    required this.riskScore,
    required this.riskLevel,
    required this.triggeredCategories,
    this.coachingLine,
    this.llmScamType,
    required this.newWarnings,
    required this.familyVerifySuggested,
  });

  factory LiveShieldChunkResult.fromJson(Map<String, dynamic> j) {
    return LiveShieldChunkResult(
      riskScore: (j['risk_score'] as num?)?.toInt() ?? 0,
      riskLevel: (j['risk_level'] as String?) ?? 'low',
      triggeredCategories:
          ((j['triggered_categories'] as List?) ?? const []).cast<String>(),
      coachingLine: j['coaching_line'] as String?,
      llmScamType: j['llm_scam_type'] as String?,
      newWarnings:
          ((j['new_warnings'] as List?) ?? const []).cast<String>(),
      familyVerifySuggested: (j['family_verify_suggested'] as bool?) ?? false,
    );
  }
}

class LiveShieldService {
  LiveShieldService._();
  static final LiveShieldService instance = LiveShieldService._();

  /// Open a real backend session. Returns null if auth/non-Pro/network
  /// fails — the caller should fall back to local demo mode.
  Future<LiveShieldStartResult?> start({String? peerNumber}) async {
    try {
      final res = await api.post('/v1/live-shield/start', {
        'peer_number': peerNumber,
        'direction': 'inbound',
        'consent_given': true,
        // v2 consent — unlocks Claude coaching path on backend. The
        // disclosure copy must be presented before this point.
        'consent_version': 2,
      });
      final sessionId = res['session_id'] as String?;
      final startedAtStr = res['started_at'] as String?;
      if (sessionId == null) return null;
      return LiveShieldStartResult(
        sessionId,
        startedAtStr != null
            ? DateTime.parse(startedAtStr)
            : DateTime.now(),
      );
    } catch (_) {
      return null;
    }
  }

  /// Send one transcript chunk. Returns null on any failure so the
  /// caller can keep using its scripted score.
  Future<LiveShieldChunkResult?> sendChunk({
    required String sessionId,
    required int seq,
    required String text,
    String speaker = 'caller',
  }) async {
    try {
      final res = await api.post(
        '/v1/live-shield/$sessionId/transcript',
        {
          'seq': seq,
          'speaker': speaker,
          'text': text,
        },
      );
      return LiveShieldChunkResult.fromJson(res);
    } catch (_) {
      return null;
    }
  }

  /// Close the session. Best-effort — we don't surface errors because
  /// there's nothing the user can do about a failed end, and the
  /// backend's session-retention sweep will close it after timeout.
  Future<void> end({
    required String sessionId,
    String outcome = 'user_hung_up',
  }) async {
    try {
      await api.post('/v1/live-shield/$sessionId/end', {
        'outcome': outcome,
      });
    } catch (_) {
      // swallow — see comment above
    }
  }
}

final liveShield = LiveShieldService.instance;
