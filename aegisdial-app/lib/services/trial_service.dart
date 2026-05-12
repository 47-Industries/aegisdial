import 'package:shared_preferences/shared_preferences.dart';

/// Trial accounting. Two anchors:
///
/// - **Server anchor** (preferred when signed in): `users.created_at`
///   returned by `/auth/me` and pushed in via [setServerStart]. This is
///   the authoritative trial start — uninstall/reinstall can't reset it
///   because the row's still on the server.
///
/// - **Local anchor**: `trial_start_ms` in SharedPreferences. Used for
///   guest sessions (no backend account exists) and as a transient
///   fallback while we're waiting for `/auth/me` to come back during
///   cold boot.
///
/// The daily-message counter (`_countKey` / `_dateKey`) stays local —
/// it's a 24h window enforcement, the calendar date is the natural key,
/// and the backend independently rate-limits via its own per-day cap.
class TrialService {
  static const _startKey = 'trial_start_ms';
  static const _countKey = 'daily_msg_count';
  static const _dateKey = 'daily_msg_date';

  static const int trialDays = 7;
  static const int dailyLimit = 10;

  /// Set by `auth._refreshMe` when `/auth/me` returns `created_at`.
  /// Null = no signed-in account on this device.
  static int? _serverStartMs;

  /// Called by auth_service when /auth/me resolves. The epoch ms passed
  /// in is `users.created_at` from the backend — the authoritative
  /// install-immune trial anchor for a signed-in account.
  static void setServerStart(int? epochMs) {
    _serverStartMs = epochMs;
  }

  /// Pick the trial-start epoch ms: server-anchored if signed in, local
  /// otherwise.
  static Future<int> _trialStartMs() async {
    final server = _serverStartMs;
    if (server != null) return server;
    final p = await SharedPreferences.getInstance();
    return p.getInt(_startKey) ?? DateTime.now().millisecondsSinceEpoch;
  }

  static Future<void> ensureStarted() async {
    final p = await SharedPreferences.getInstance();
    if (!p.containsKey(_startKey)) {
      await p.setInt(_startKey, DateTime.now().millisecondsSinceEpoch);
    }
  }

  static Future<bool> isTrialActive() async {
    final start = await _trialStartMs();
    final elapsed = DateTime.now().difference(
      DateTime.fromMillisecondsSinceEpoch(start),
    );
    return elapsed.inDays < trialDays;
  }

  static Future<int> daysRemaining() async {
    final start = await _trialStartMs();
    final elapsed = DateTime.now().difference(
      DateTime.fromMillisecondsSinceEpoch(start),
    );
    return (trialDays - elapsed.inDays).clamp(0, trialDays);
  }

  static Future<int> _todayCount() async {
    final p = await SharedPreferences.getInstance();
    if (p.getString(_dateKey) != _today()) return 0;
    return p.getInt(_countKey) ?? 0;
  }

  static Future<int> messagesRemainingToday() async {
    final count = await _todayCount();
    return (dailyLimit - count).clamp(0, dailyLimit);
  }

  static Future<bool> canSendMessage() async {
    if (!await isTrialActive()) return false;
    return (await _todayCount()) < dailyLimit;
  }

  static Future<void> recordMessage() async {
    final p = await SharedPreferences.getInstance();
    if (p.getString(_dateKey) != _today()) {
      await p.setString(_dateKey, _today());
      await p.setInt(_countKey, 1);
    } else {
      await p.setInt(_countKey, (p.getInt(_countKey) ?? 0) + 1);
    }
  }

  static String _today() {
    final n = DateTime.now();
    return '${n.year}-${n.month.toString().padLeft(2, '0')}-${n.day.toString().padLeft(2, '0')}';
  }
}
