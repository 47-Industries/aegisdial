import 'package:shared_preferences/shared_preferences.dart';

class TrialService {
  static const _startKey = 'trial_start_ms';
  static const _countKey = 'daily_msg_count';
  static const _dateKey = 'daily_msg_date';

  static const int trialDays = 7;
  static const int dailyLimit = 10;

  static Future<void> ensureStarted() async {
    final p = await SharedPreferences.getInstance();
    if (!p.containsKey(_startKey)) {
      await p.setInt(_startKey, DateTime.now().millisecondsSinceEpoch);
    }
  }

  static Future<bool> isTrialActive() async {
    final p = await SharedPreferences.getInstance();
    final start = p.getInt(_startKey);
    if (start == null) return true;
    final elapsed = DateTime.now().difference(
      DateTime.fromMillisecondsSinceEpoch(start),
    );
    return elapsed.inDays < trialDays;
  }

  static Future<int> daysRemaining() async {
    final p = await SharedPreferences.getInstance();
    final start = p.getInt(_startKey);
    if (start == null) return trialDays;
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
