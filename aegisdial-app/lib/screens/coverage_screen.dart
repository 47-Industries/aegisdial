import 'dart:convert';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import '../services/api_service.dart';
import '../services/extension_bridge_service.dart';

class CoverageScreen extends StatefulWidget {
  const CoverageScreen({super.key});

  @override
  State<CoverageScreen> createState() => _CoverageScreenState();
}

class _ScanResult {
  final int score;
  final String level;
  final String finding;
  final Color color;
  final List<String> categories;
  const _ScanResult({
    required this.score,
    required this.level,
    required this.finding,
    required this.color,
    this.categories = const [],
  });
}

class _CaughtMessage {
  final String sender;
  final String preview;
  final int score;
  final String type;
  final String timeAgo;
  bool deleted = false;
  _CaughtMessage({
    required this.sender,
    required this.preview,
    required this.score,
    required this.type,
    required this.timeAgo,
  });
}

class _HistoryEntry {
  final String textPreview;
  final int score;
  final String level;
  final String finding;
  final List<String> categories;
  final DateTime ts;
  _HistoryEntry({
    required this.textPreview,
    required this.score,
    required this.level,
    required this.finding,
    required this.categories,
    required this.ts,
  });

  Map<String, dynamic> toJson() => {
        'p': textPreview,
        's': score,
        'l': level,
        'f': finding,
        'c': categories,
        't': ts.millisecondsSinceEpoch,
      };

  factory _HistoryEntry.fromJson(Map<String, dynamic> j) => _HistoryEntry(
        textPreview: j['p'] as String,
        score: j['s'] as int,
        level: j['l'] as String,
        finding: j['f'] as String,
        categories: (j['c'] as List<dynamic>).map((e) => e.toString()).toList(),
        ts: DateTime.fromMillisecondsSinceEpoch(j['t'] as int),
      );

  Color get color => score >= 70
      ? AegisColors.danger
      : score >= 40
          ? AegisColors.warning
          : AegisColors.success;
}

class _CoverageScreenState extends State<CoverageScreen> {
  static const _kHistoryKey = 'sms_scan_history_v1';
  static const _kMaxHistory = 20;
  static const _kEnableGuideDismissed = 'sms_enable_guide_dismissed_v1';

  final _pasteCtrl = TextEditingController();
  bool _scanning = false;
  bool _enableGuideDismissed = true;
  _ScanResult? _result;
  List<_HistoryEntry> _history = [];

  final List<_CaughtMessage> _caught = [
    _CaughtMessage(
      sender: '+1 (800) 555-0199',
      preview:
          'URGENT: Your package could not be delivered. Pay \$2.99 redelivery fee at: bit.ly/usps-pay',
      score: 96,
      type: 'Package redelivery scam',
      timeAgo: '14 min ago',
    ),
    _CaughtMessage(
      sender: 'FakeBank-Alert',
      preview:
          'Your Wells Fargo account has been locked. Verify now or access will be terminated: bit.ly/wf-verify',
      score: 99,
      type: 'Bank phishing',
      timeAgo: '1h ago',
    ),
    _CaughtMessage(
      sender: '+1 (347) 555-0162',
      preview:
          'Congratulations! You\'ve been selected for a \$1,000 Amazon gift card. Claim before it expires tonight.',
      score: 88,
      type: 'Gift card scam',
      timeAgo: '3h ago',
    ),
  ];

  @override
  void initState() {
    super.initState();
    _loadHistory();
    _loadGuideState();
  }

  Future<void> _loadGuideState() async {
    final p = await SharedPreferences.getInstance();
    final dismissed = p.getBool(_kEnableGuideDismissed) ?? false;
    // Auto-hide the guide if the extension is already enabled in iOS Settings
    final enabled = await extensionBridge.isSMSFilterEnabled();
    if (!mounted) return;
    setState(() => _enableGuideDismissed = dismissed || enabled);
  }

  Future<void> _dismissGuide() async {
    setState(() => _enableGuideDismissed = true);
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kEnableGuideDismissed, true);
  }

  @override
  void dispose() {
    _pasteCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadHistory() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(_kHistoryKey);
    if (raw == null) return;
    try {
      final list = jsonDecode(raw) as List<dynamic>;
      if (mounted) {
        setState(() {
          _history = list
              .map((e) => _HistoryEntry.fromJson(e as Map<String, dynamic>))
              .toList();
        });
      }
    } catch (_) {}

    // After local hydrate, pull server-side history. The backend
    // persists every /v1/sms/score result to sms_scans, so a user who
    // pasted from another device sees their history here too. Best-
    // effort: 401/403/5xx and ApiException all fall through to the
    // local-only view above.
    await _resyncFromBackend();
  }

  Future<void> _resyncFromBackend() async {
    try {
      final res = await api.get('/v1/sms/scans?limit=50');
      final scans = (res['scans'] as List<dynamic>?) ?? [];
      if (scans.isEmpty || !mounted) return;
      final remote = <_HistoryEntry>[];
      for (final s in scans) {
        final m = s as Map<String, dynamic>;
        final score = ((m['fraud_score'] as num?) ?? 0).round();
        final verdict = (m['verdict'] as String?) ?? 'safe';
        final excerpt = (m['body_excerpt'] as String?) ?? '';
        final reasons = (m['reasons'] as List<dynamic>?)
                ?.take(2)
                .map((e) => e.toString())
                .join(' · ') ??
            '';
        final cats = (m['triggered_categories'] as List<dynamic>?)
                ?.map((e) => e.toString())
                .toList() ??
            const [];
        final ts = DateTime.tryParse((m['scanned_at'] as String?) ?? '') ??
            DateTime.now();
        remote.add(_HistoryEntry(
          textPreview: excerpt,
          score: score,
          level: _verdictToLevel(verdict),
          finding: reasons.isNotEmpty
              ? reasons
              : verdict == 'safe'
                  ? 'No obvious scam patterns detected.'
                  : 'Suspicious content — do not click links or reply.',
          categories: cats,
          ts: ts,
        ));
      }
      if (!mounted) return;
      setState(() {
        // Backend is the source of truth for Pro users — replace
        // local history wholesale so the UI doesn't disagree with
        // /v1/sms/scans.
        _history = remote;
      });
      _saveHistory();
    } on ApiException {
      // 401 / 403 / 5xx — keep local-only view
    } catch (_) {
      // Network / parse failure — keep local-only view
    }
  }

  Future<void> _saveHistory() async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_kHistoryKey, jsonEncode(_history.map((e) => e.toJson()).toList()));
  }

  Future<void> _analyze() async {
    final text = _pasteCtrl.text.trim();
    if (text.isEmpty) return;
    setState(() {
      _scanning = true;
      _result = null;
    });

    _ScanResult result;
    try {
      // Prefer the v3 endpoint `/v1/sms/score` which persists the scan
      // to `sms_scans` and returns the richer `explainable_reasons` /
      // `url_findings` payload. Falls back to the legacy
      // `/v1/sms-classify` route on 404 so users on rolling-deploy
      // backends mid-cutover still get a verdict.
      Map<String, dynamic> res;
      bool isV3;
      try {
        res = await api.post('/v1/sms/score', {'message_body': text});
        isV3 = true;
      } on ApiException catch (e) {
        if (e.statusCode == 404 || e.statusCode == 501) {
          res = await api.post('/v1/sms-classify', {'text': text});
          isV3 = false;
        } else {
          rethrow;
        }
      }

      // v3 uses `fraud_score`/`verdict`/`explainable_reasons`. Legacy
      // uses `risk_score`/`risk_level`/`reason`. Normalize into the
      // single _ScanResult shape the UI already renders.
      final score = isV3
          ? ((res['fraud_score'] as num?) ?? 0).round()
          : ((res['risk_score'] as num?) ?? 0).round();
      final level = isV3
          ? _verdictToLevel((res['verdict'] as String?) ?? 'safe')
          : (res['risk_level'] as String?) ?? 'LOW';
      // v3 returns `explainable_reasons: string[]` — concatenate the
      // first few into the same `reason` slot the legacy UI uses.
      final reason = isV3
          ? ((res['explainable_reasons'] as List<dynamic>?)
                  ?.take(2)
                  .map((e) => e.toString())
                  .join(' · ') ??
              '')
          : (res['reason'] as String?) ?? '';
      final cats = (res['triggered_categories'] as List<dynamic>?)
              ?.map((e) => e.toString())
              .toList() ??
          [];
      result = _ScanResult(
        score: score,
        level: level,
        finding: reason.isNotEmpty
            ? reason
            : score < 30
                ? 'No obvious scam patterns detected. Stay cautious with unexpected messages.'
                : 'Suspicious content detected — do not click links or reply.',
        color: score >= 70
            ? AegisColors.danger
            : score >= 40
                ? AegisColors.warning
                : AegisColors.success,
        categories: cats,
      );
    } catch (_) {
      result = _score(text);
    }

    if (!mounted) return;
    final entry = _HistoryEntry(
      textPreview: text.length > 80 ? '${text.substring(0, 80)}…' : text,
      score: result.score,
      level: result.level,
      finding: result.finding,
      categories: result.categories,
      ts: DateTime.now(),
    );
    setState(() {
      _scanning = false;
      _result = result;
      _history.insert(0, entry);
      if (_history.length > _kMaxHistory) _history.removeLast();
    });
    _saveHistory();
  }

  _ScanResult _score(String text) {
    final l = text.toLowerCase();
    int score = 12;
    String finding =
        'No obvious scam patterns detected. Stay cautious with unexpected messages.';

    if (l.contains('irs') ||
        l.contains('social security') ||
        l.contains('arrest') ||
        l.contains('warrant') ||
        l.contains('federal') ||
        l.contains('deportation')) {
      score = 97;
      finding =
          'Government impersonation detected — IRS / SSA never contact you this way.';
    } else if (l.contains('gift card') ||
        l.contains('amazon card') ||
        l.contains('google play') ||
        l.contains('itunes') ||
        l.contains('apple card')) {
      score = 95;
      finding =
          'Gift card payment request — no legitimate entity ever asks for gift cards.';
    } else if (l.contains('won') ||
        l.contains('winner') ||
        l.contains('lottery') ||
        l.contains('prize') ||
        l.contains('selected')) {
      score = 92;
      finding =
          'Prize / lottery scam — you can\'t win something you didn\'t enter.';
    } else if (l.contains('crypto') ||
        l.contains('bitcoin') ||
        l.contains('invest') ||
        l.contains('guaranteed return')) {
      score = 89;
      finding =
          'Investment scam language — "guaranteed returns" don\'t exist in any market.';
    } else {
      if (l.contains('bit.ly') ||
          l.contains('tinyurl') ||
          l.contains('ow.ly') ||
          l.contains('cutt.ly')) {
        score = (score + 45).clamp(0, 99);
        finding =
            'Shortened URL detected — commonly used to hide phishing destinations.';
      }
      if (l.contains('verify') ||
          l.contains('suspended') ||
          l.contains('locked') ||
          l.contains('unusual activity') ||
          l.contains('confirm your')) {
        score = (score + 25).clamp(0, 99);
        finding =
            'Account-threat urgency language — classic manipulation tactic.';
      }
      if (l.contains('package') ||
          l.contains('delivery') ||
          l.contains('redelivery') ||
          l.contains('usps') ||
          l.contains('fedex')) {
        score = (score + 35).clamp(0, 99);
        finding =
            'Package redelivery scam pattern — link likely leads to a fake payment page.';
      }
    }

    final s = score.clamp(0, 99);
    if (s >= 70) {
      return _ScanResult(
          score: s,
          level: 'HIGH RISK',
          finding: finding,
          color: AegisColors.danger);
    } else if (s >= 40) {
      return _ScanResult(
          score: s,
          level: 'MEDIUM RISK',
          finding: finding,
          color: AegisColors.warning);
    }
    return _ScanResult(
        score: s,
        level: 'LOW RISK',
        finding: finding,
        color: AegisColors.success);
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(title: const Text('SMS Filter')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
        children: [
          if (!_enableGuideDismissed) ...[
            _EnableGuideCard(onDismiss: _dismissGuide),
            const SizedBox(height: 14),
          ],
          GlassCard(
            accent: AegisColors.turquoise,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AegisColors.turquoise.withValues(alpha: 0.14),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.content_paste_search_rounded,
                        color: AegisColors.turquoise,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'Paste & Scan',
                        style:
                            tt.titleLarge?.copyWith(fontWeight: FontWeight.w700),
                      ),
                    ),
                    TextButton(
                      onPressed: () async {
                        final data = await Clipboard.getData('text/plain');
                        if (data?.text != null) {
                          setState(() => _pasteCtrl.text = data!.text!);
                        }
                      },
                      child: const Text('Paste'),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  'Copy a suspicious text or link and paste it here to check for scam material or malware.',
                  style: tt.bodySmall?.copyWith(
                    color: AegisColors.textSecondary,
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _pasteCtrl,
                  minLines: 3,
                  maxLines: 6,
                  style: tt.bodyMedium,
                  decoration: InputDecoration(
                    hintText: 'Paste a suspicious message or URL here…',
                    hintStyle: tt.bodySmall
                        ?.copyWith(color: AegisColors.textTertiary),
                    filled: true,
                    fillColor: AegisColors.surfaceElevated,
                    contentPadding: const EdgeInsets.all(14),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide.none,
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton.icon(
                    onPressed: _scanning ? null : _analyze,
                    style: ElevatedButton.styleFrom(
                      minimumSize: const Size.fromHeight(48),
                    ),
                    icon: _scanning
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                                color: Colors.black, strokeWidth: 2),
                          )
                        : const Icon(Icons.search_rounded),
                    label: Text(_scanning ? 'Analyzing…' : 'Analyze'),
                  ),
                ),
                if (_result != null) ...[
                  const SizedBox(height: 14),
                  _ScanResultCard(result: _result!),
                ],
              ],
            ),
          ),
          if (_history.isNotEmpty) ...[
            const SizedBox(height: 24),
            Row(
              children: [
                Expanded(
                  child: Text(
                    'SCAN HISTORY',
                    style: tt.labelSmall?.copyWith(
                      color: AegisColors.textTertiary,
                      letterSpacing: 1.6,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                TextButton(
                  onPressed: () async {
                    setState(() => _history.clear());
                    final p = await SharedPreferences.getInstance();
                    await p.remove(_kHistoryKey);
                  },
                  child: Text(
                    'Clear',
                    style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            ..._history.map((e) => _HistoryTile(entry: e)),
          ],
          const SizedBox(height: 24),
          Row(
            children: [
              Text(
                'EXAMPLES OF WHAT WE CATCH',
                style: tt.labelSmall?.copyWith(
                  color: AegisColors.textTertiary,
                  letterSpacing: 1.6,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(
                  color: AegisColors.warning.withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(3),
                  border: Border.all(
                    color: AegisColors.warning.withValues(alpha: 0.5),
                    width: 0.8,
                  ),
                ),
                child: Text(
                  'SAMPLE',
                  style: tt.labelSmall?.copyWith(
                    color: AegisColors.warning,
                    letterSpacing: 1.4,
                    fontWeight: FontWeight.w800,
                    fontSize: 9,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            'iOS does not allow third-party apps to scan your inbox automatically. Paste any text message above to scan it. Below: examples of what AegisDial flags.',
            style: tt.bodySmall?.copyWith(color: AegisColors.textTertiary),
          ),
          const SizedBox(height: 10),
          ..._caught.map((m) => _CaughtMessageTile(message: m)),
        ],
      ),
    );
  }

  // Map the v3 SMS Shield verdict literal ('safe'|'suspicious'|'fraud')
  // back into the legacy 'LOW'|'MEDIUM'|'HIGH' string the existing
  // _ScanResultCard renders. Centralised so the verdict→level mapping
  // can be rebuilt in one place when the UI is itself upgraded.
  String _verdictToLevel(String verdict) {
    switch (verdict) {
      case 'fraud':
        return 'HIGH';
      case 'suspicious':
        return 'MEDIUM';
      case 'safe':
      default:
        return 'LOW';
    }
  }
}

class _ScanResultCard extends StatelessWidget {
  final _ScanResult result;
  const _ScanResultCard({required this.result});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: result.color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: result.color.withValues(alpha: 0.5), width: 1),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: result.color.withValues(alpha: 0.2),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  result.level,
                  style: TextStyle(
                    color: result.color,
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.8,
                  ),
                ),
              ),
              const Spacer(),
              _RiskGauge(score: result.score, color: result.color),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            result.finding,
            style: tt.bodySmall?.copyWith(
              color: AegisColors.textSecondary,
              height: 1.45,
            ),
          ),
          if (result.categories.isNotEmpty) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: result.categories.map((c) {
                return Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: result.color.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    c.replaceAll('_', ' ').toUpperCase(),
                    style: TextStyle(
                      color: result.color,
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.6,
                    ),
                  ),
                );
              }).toList(),
            ),
          ],
        ],
      ),
    );
  }
}

class _CaughtMessageTile extends StatelessWidget {
  final _CaughtMessage message;
  const _CaughtMessageTile({required this.message});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final scoreColor = message.score >= 80
        ? AegisColors.danger
        : message.score >= 50
            ? AegisColors.warning
            : AegisColors.success;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  message.sender,
                  style: tt.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: scoreColor.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  '${message.score}%',
                  style: TextStyle(
                    color: scoreColor,
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Text(
                message.timeAgo,
                style:
                    tt.labelSmall?.copyWith(color: AegisColors.textTertiary),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            message.type,
            style: tt.labelSmall?.copyWith(
              color: scoreColor,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            message.preview,
            style: tt.bodySmall?.copyWith(
              color: AegisColors.textTertiary,
              height: 1.4,
            ),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              const Icon(Icons.info_outline_rounded,
                  size: 14, color: AegisColors.textTertiary),
              const SizedBox(width: 6),
              Text(
                'Example',
                style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _HistoryTile extends StatelessWidget {
  final _HistoryEntry entry;
  const _HistoryTile({required this.entry});

  String _timeLabel() {
    final diff = DateTime.now().difference(entry.ts);
    if (diff.inMinutes < 1) return 'just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    return '${diff.inDays}d ago';
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final c = entry.color;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(vertical: 11, horizontal: 14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: c.withValues(alpha: 0.25), width: 0.8),
      ),
      child: Row(
        children: [
          Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              color: c.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            alignment: Alignment.center,
            child: Text(
              '${entry.score}',
              style: TextStyle(
                color: c,
                fontSize: 16,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: c.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(5),
                      ),
                      child: Text(
                        entry.level,
                        style: TextStyle(color: c, fontSize: 9, fontWeight: FontWeight.w700, letterSpacing: 0.6),
                      ),
                    ),
                    const Spacer(),
                    Text(_timeLabel(), style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary, fontSize: 10)),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  entry.textPreview,
                  style: tt.bodySmall?.copyWith(color: AegisColors.textSecondary, height: 1.35),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _RiskGauge extends StatelessWidget {
  final int score;
  final Color color;
  const _RiskGauge({required this.score, required this.color});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 68,
      height: 68,
      child: CustomPaint(
        painter: _RiskGaugePainter(progress: score / 100.0, color: color),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '$score',
                style: TextStyle(
                  color: color,
                  fontSize: 20,
                  fontWeight: FontWeight.w800,
                  height: 1,
                ),
              ),
              Text(
                '%',
                style: TextStyle(
                  color: color.withValues(alpha: 0.65),
                  fontSize: 10,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _RiskGaugePainter extends CustomPainter {
  final double progress;
  final Color color;
  _RiskGaugePainter({required this.progress, required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = size.width / 2 - 5;
    const start = -math.pi / 2;

    canvas.drawCircle(
      center,
      radius,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 5.5
        ..color = color.withValues(alpha: 0.15),
    );

    if (progress > 0) {
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: radius),
        start,
        2 * math.pi * progress,
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 5.5
          ..strokeCap = StrokeCap.round
          ..color = color,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _RiskGaugePainter old) =>
      old.progress != progress || old.color != color;
}

class _EnableGuideCard extends StatelessWidget {
  final VoidCallback onDismiss;
  const _EnableGuideCard({required this.onDismiss});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return GlassCard(
      accent: AegisColors.success,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AegisColors.success.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Icon(
                  Icons.filter_list_rounded,
                  color: AegisColors.success,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'Enable auto-filtering',
                  style: tt.titleMedium
                      ?.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              GestureDetector(
                onTap: onDismiss,
                child: const Icon(
                  Icons.close_rounded,
                  size: 18,
                  color: AegisColors.textTertiary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            'AegisDial can automatically filter scam texts before they reach your inbox. Enable it in iOS Settings:',
            style: tt.bodySmall?.copyWith(
              color: AegisColors.textSecondary,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 12),
          _StepRow(num: '1', text: 'Open iOS Settings'),
          _StepRow(num: '2', text: 'Tap Apps > Messages'),
          _StepRow(num: '3', text: 'Tap SMS Filter (under Unknown & Spam)'),
          _StepRow(num: '4', text: 'Turn on AegisDial'),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: () =>
                  launchUrl(Uri.parse('app-settings:'), mode: LaunchMode.externalApplication),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size.fromHeight(42),
                side: const BorderSide(
                    color: AegisColors.success, width: 0.8),
              ),
              icon: const Icon(Icons.settings_rounded,
                  color: AegisColors.success, size: 18),
              label: Text(
                'Open Settings',
                style: tt.bodySmall?.copyWith(
                  color: AegisColors.success,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _StepRow extends StatelessWidget {
  final String num;
  final String text;
  const _StepRow({required this.num, required this.text});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Container(
            width: 22,
            height: 22,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: AegisColors.success.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(
              num,
              style: tt.labelSmall?.copyWith(
                color: AegisColors.success,
                fontWeight: FontWeight.w700,
                fontSize: 11,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: tt.bodySmall?.copyWith(
                color: AegisColors.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
