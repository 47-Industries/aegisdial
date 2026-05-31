import 'dart:convert';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import '../services/api_service.dart';

class NumberCheckScreen extends StatefulWidget {
  const NumberCheckScreen({super.key});

  @override
  State<NumberCheckScreen> createState() => _NumberCheckScreenState();
}

class _NumberCheckScreenState extends State<NumberCheckScreen> {
  static const _kHistoryKey = 'number_check_history_v1';
  static const _kMaxHistory = 10;

  final _ctrl = TextEditingController();
  bool _loading = false;
  String? _error;
  _VerdictResult? _result;
  List<_LookupEntry> _history = [];

  @override
  void initState() {
    super.initState();
    _loadHistory();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _loadHistory() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(_kHistoryKey);
    if (raw == null || !mounted) return;
    try {
      final list = jsonDecode(raw) as List<dynamic>;
      setState(() {
        _history = list
            .map((e) => _LookupEntry.fromJson(e as Map<String, dynamic>))
            .toList();
      });
    } catch (_) {}
  }

  Future<void> _saveHistory() async {
    final p = await SharedPreferences.getInstance();
    await p.setString(
        _kHistoryKey, jsonEncode(_history.map((e) => e.toJson()).toList()));
  }

  Future<void> _lookup() async {
    final raw = _ctrl.text.replaceAll(RegExp(r'[^\d+]'), '');
    if (raw.length < 10) {
      setState(() => _error = 'Enter at least 10 digits.');
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
      _result = null;
    });

    try {
      final res = await api.post('/v1/verdict', {'number': raw});
      if (!mounted) return;
      final verdict = _VerdictResult.fromJson(res);
      setState(() {
        _loading = false;
        _result = verdict;
        _history.insert(
          0,
          _LookupEntry(
            number: verdict.number.isNotEmpty ? verdict.number : raw,
            trustScore: verdict.trustScore,
            verdict: verdict.verdict,
            action: verdict.recommendedAction,
            displayColor: verdict.displayColor,
            checkedAt: DateTime.now(),
          ),
        );
        if (_history.length > _kMaxHistory) _history.removeLast();
      });
      _saveHistory();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.statusCode == 403
            ? 'Number check requires a Pro subscription.'
            : e.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Could not reach the server. Check your connection.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(title: const Text('Check a Number')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
        children: [
          GlassCard(
            accent: AegisColors.warning,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AegisColors.warning.withValues(alpha: 0.14),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.phone_callback_rounded,
                        color: AegisColors.warning,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'Number Lookup',
                        style: tt.titleLarge
                            ?.copyWith(fontWeight: FontWeight.w700),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  'Got a call from an unknown number? Enter it below to check for scam reports, spoofing risk, and carrier info.',
                  style: tt.bodySmall?.copyWith(
                    color: AegisColors.textSecondary,
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 14),
                TextField(
                  controller: _ctrl,
                  keyboardType: TextInputType.phone,
                  style: tt.bodyLarge?.copyWith(letterSpacing: 1),
                  decoration: InputDecoration(
                    hintText: '+1 (555) 000-0000',
                    hintStyle: tt.bodyMedium
                        ?.copyWith(color: AegisColors.textTertiary),
                    filled: true,
                    fillColor: AegisColors.surfaceElevated,
                    contentPadding: const EdgeInsets.all(14),
                    prefixIcon: const Icon(Icons.phone_outlined,
                        color: AegisColors.textTertiary),
                    suffixIcon: _ctrl.text.isNotEmpty
                        ? IconButton(
                            icon: const Icon(Icons.clear_rounded,
                                color: AegisColors.textTertiary, size: 18),
                            onPressed: () {
                              _ctrl.clear();
                              setState(() {
                                _result = null;
                                _error = null;
                              });
                            },
                          )
                        : null,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide.none,
                    ),
                  ),
                  onChanged: (_) => setState(() {}),
                  onSubmitted: (_) => _lookup(),
                ),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton.icon(
                    onPressed: _loading ? null : _lookup,
                    style: ElevatedButton.styleFrom(
                      minimumSize: const Size.fromHeight(48),
                      backgroundColor: AegisColors.warning,
                      foregroundColor: Colors.black,
                    ),
                    icon: _loading
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                                color: Colors.black, strokeWidth: 2),
                          )
                        : const Icon(Icons.search_rounded),
                    label: Text(_loading ? 'Checking...' : 'Check this number'),
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AegisColors.danger.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(
                          color: AegisColors.danger.withValues(alpha: 0.4)),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.error_outline_rounded,
                            color: AegisColors.danger, size: 18),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _error!,
                            style: tt.bodySmall
                                ?.copyWith(color: AegisColors.danger),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (_result != null) ...[
            const SizedBox(height: 20),
            _VerdictCard(result: _result!),
          ],
          if (_history.isNotEmpty) ...[
            const SizedBox(height: 24),
            Row(
              children: [
                Text(
                  'RECENT LOOKUPS',
                  style: tt.labelSmall?.copyWith(
                    color: AegisColors.textTertiary,
                    letterSpacing: 1.6,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                GestureDetector(
                  onTap: () async {
                    setState(() => _history.clear());
                    final p = await SharedPreferences.getInstance();
                    await p.remove(_kHistoryKey);
                  },
                  child: Text(
                    'Clear',
                    style: tt.labelSmall?.copyWith(
                      color: AegisColors.textTertiary,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            ..._history.map((e) => _LookupHistoryTile(
                  entry: e,
                  onTap: () {
                    _ctrl.text = e.number;
                    setState(() {});
                    _lookup();
                  },
                )),
          ],
        ],
      ),
    );
  }
}

class _LookupEntry {
  final String number;
  final int trustScore;
  final String verdict;
  final String action;
  final String displayColor;
  final DateTime checkedAt;

  _LookupEntry({
    required this.number,
    required this.trustScore,
    required this.verdict,
    required this.action,
    required this.displayColor,
    required this.checkedAt,
  });

  Map<String, dynamic> toJson() => {
        'n': number,
        'ts': trustScore,
        'v': verdict,
        'a': action,
        'dc': displayColor,
        'at': checkedAt.millisecondsSinceEpoch,
      };

  factory _LookupEntry.fromJson(Map<String, dynamic> j) => _LookupEntry(
        number: j['n'] as String,
        trustScore: (j['ts'] as num).toInt(),
        verdict: j['v'] as String,
        action: j['a'] as String,
        displayColor: (j['dc'] as String?) ?? 'yellow',
        checkedAt:
            DateTime.fromMillisecondsSinceEpoch((j['at'] as num).toInt()),
      );

  Color get color => switch (displayColor) {
        'green' => AegisColors.success,
        'yellow' => AegisColors.warning,
        'amber' => const Color(0xFFFF8C00),
        'red' => AegisColors.danger,
        _ => AegisColors.textTertiary,
      };
}

class _LookupHistoryTile extends StatelessWidget {
  final _LookupEntry entry;
  final VoidCallback onTap;
  const _LookupHistoryTile({required this.entry, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final ago = _timeAgo(entry.checkedAt);
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
            decoration: BoxDecoration(
              color: AegisColors.surface.withValues(alpha: 0.55),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AegisColors.border, width: 0.6),
            ),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(7),
                  decoration: BoxDecoration(
                    color: entry.color.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Icon(
                    entry.trustScore >= 70
                        ? Icons.check_circle_rounded
                        : entry.trustScore >= 40
                            ? Icons.warning_amber_rounded
                            : Icons.block_rounded,
                    color: entry.color,
                    size: 16,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        entry.number,
                        style:
                            tt.bodySmall?.copyWith(fontWeight: FontWeight.w600),
                      ),
                      Text(
                        '${entry.trustScore}% trust · $ago',
                        style: tt.labelSmall
                            ?.copyWith(color: AegisColors.textTertiary),
                      ),
                    ],
                  ),
                ),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: entry.color.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    '${entry.trustScore}%',
                    style: TextStyle(
                      color: entry.color,
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _timeAgo(DateTime dt) {
    final diff = DateTime.now().difference(dt);
    if (diff.inMinutes < 1) return 'just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    if (diff.inDays < 7) return '${diff.inDays}d ago';
    return '${dt.month}/${dt.day}';
  }
}

class _VerdictResult {
  final String number;
  final int trustScore;
  final String verdict;
  final String summary;
  final String? userMessage;
  final String displayColor;
  final String recommendedAction;
  final List<_EvidenceItem> evidence;
  final String? ownerName;
  final String? lineType;
  final String? carrier;
  final bool isSpoofable;
  final bool isBurner;
  final String? burnerService;

  _VerdictResult({
    required this.number,
    required this.trustScore,
    required this.verdict,
    required this.summary,
    this.userMessage,
    required this.displayColor,
    required this.recommendedAction,
    required this.evidence,
    this.ownerName,
    this.lineType,
    this.carrier,
    this.isSpoofable = false,
    this.isBurner = false,
    this.burnerService,
  });

  Color get color => switch (displayColor) {
        'green' => AegisColors.success,
        'yellow' => AegisColors.warning,
        'amber' => const Color(0xFFFF8C00),
        'red' => AegisColors.danger,
        _ => AegisColors.textTertiary,
      };

  String get actionLabel => switch (recommendedAction) {
        'answer' => 'Safe to answer',
        'answer_with_caution' => 'Answer with caution',
        'verify_offline' => 'Verify offline first',
        'decline' => 'Do not answer',
        _ => 'Unknown',
      };

  IconData get actionIcon => switch (recommendedAction) {
        'answer' => Icons.check_circle_rounded,
        'answer_with_caution' => Icons.info_outline_rounded,
        'verify_offline' => Icons.warning_amber_rounded,
        'decline' => Icons.block_rounded,
        _ => Icons.help_outline_rounded,
      };

  factory _VerdictResult.fromJson(Map<String, dynamic> j) {
    final info = j['public_info'] as Map<String, dynamic>?;
    final evidenceList = (j['evidence'] as List<dynamic>?)
            ?.map((e) => _EvidenceItem.fromJson(e as Map<String, dynamic>))
            .toList() ??
        [];
    return _VerdictResult(
      number: (j['number'] as String?) ?? '',
      trustScore: ((j['trust_score'] as num?) ?? 50).toInt(),
      verdict: (j['verdict'] as String?) ?? 'unknown',
      summary: (j['summary'] as String?) ?? '',
      userMessage: j['user_message'] as String?,
      displayColor: (j['display_color'] as String?) ?? 'yellow',
      recommendedAction:
          (j['recommended_action'] as String?) ?? 'unknown',
      evidence: evidenceList,
      ownerName: info?['owner_name'] as String?,
      lineType: info?['line_type'] as String?,
      carrier: info?['carrier_name'] as String?,
      isSpoofable: (info?['is_spoofable'] as bool?) ?? false,
      isBurner: (info?['is_likely_burner'] as bool?) ?? false,
      burnerService: info?['burner_service'] as String?,
    );
  }
}

class _EvidenceItem {
  final String source;
  final String detail;
  _EvidenceItem({required this.source, required this.detail});

  factory _EvidenceItem.fromJson(Map<String, dynamic> j) => _EvidenceItem(
        source: (j['source'] as String?) ?? '',
        detail: (j['detail'] as String?) ?? (j['summary'] as String?) ?? '',
      );
}

class _VerdictCard extends StatelessWidget {
  final _VerdictResult result;
  const _VerdictCard({required this.result});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return GlassCard(
      accent: result.color,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Score + verdict header
          Row(
            children: [
              _TrustGauge(score: result.trustScore, color: result.color),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: result.color.withValues(alpha: 0.18),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        result.verdict.replaceAll('_', ' ').toUpperCase(),
                        style: TextStyle(
                          color: result.color,
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.8,
                        ),
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      result.summary,
                      style: tt.bodySmall?.copyWith(
                        color: AegisColors.textSecondary,
                        height: 1.35,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),

          // Recommended action
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
            decoration: BoxDecoration(
              color: result.color.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(
                  color: result.color.withValues(alpha: 0.3), width: 0.8),
            ),
            child: Row(
              children: [
                Icon(result.actionIcon, color: result.color, size: 18),
                const SizedBox(width: 8),
                Text(
                  result.actionLabel,
                  style: tt.bodySmall?.copyWith(
                    color: result.color,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),

          if (result.userMessage != null) ...[
            const SizedBox(height: 12),
            Text(
              result.userMessage!,
              style: tt.bodySmall?.copyWith(
                color: AegisColors.textSecondary,
                height: 1.4,
              ),
            ),
          ],

          // Public info section
          if (result.ownerName != null ||
              result.lineType != null ||
              result.carrier != null) ...[
            const SizedBox(height: 16),
            Text(
              'CALLER INFO',
              style: tt.labelSmall?.copyWith(
                color: AegisColors.textTertiary,
                letterSpacing: 1.4,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AegisColors.surfaceElevated,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                children: [
                  if (result.ownerName != null)
                    _InfoRow(
                        label: 'Name', value: result.ownerName!),
                  if (result.lineType != null)
                    _InfoRow(
                        label: 'Type',
                        value: result.lineType!.replaceAll('_', ' ')),
                  if (result.carrier != null)
                    _InfoRow(label: 'Carrier', value: result.carrier!),
                  if (result.isBurner)
                    _InfoRow(
                      label: 'Burner',
                      value: result.burnerService ?? 'Disposable service',
                      valueColor: AegisColors.danger,
                    ),
                  if (result.isSpoofable)
                    _InfoRow(
                      label: 'Spoof risk',
                      value: 'Easily spoofable line type',
                      valueColor: AegisColors.warning,
                    ),
                ],
              ),
            ),
          ],

          // Evidence
          if (result.evidence.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text(
              'EVIDENCE',
              style: tt.labelSmall?.copyWith(
                color: AegisColors.textTertiary,
                letterSpacing: 1.4,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            ...result.evidence.map((e) => Container(
                  margin: const EdgeInsets.only(bottom: 6),
                  padding:
                      const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
                  decoration: BoxDecoration(
                    color: AegisColors.surfaceElevated,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        margin: const EdgeInsets.only(top: 2),
                        padding: const EdgeInsets.symmetric(
                            horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color:
                              AegisColors.blueAccent.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          e.source.toUpperCase(),
                          style: tt.labelSmall?.copyWith(
                            color: AegisColors.blueAccent,
                            fontSize: 9,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          e.detail,
                          style: tt.bodySmall?.copyWith(
                            color: AegisColors.textSecondary,
                            height: 1.35,
                          ),
                        ),
                      ),
                    ],
                  ),
                )),
          ],
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  final String label;
  final String value;
  final Color? valueColor;
  const _InfoRow({
    required this.label,
    required this.value,
    this.valueColor,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          SizedBox(
            width: 80,
            child: Text(
              label,
              style: tt.labelSmall?.copyWith(
                color: AegisColors.textTertiary,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: tt.bodySmall?.copyWith(
                color: valueColor ?? AegisColors.textPrimary,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TrustGauge extends StatelessWidget {
  final int score;
  final Color color;
  const _TrustGauge({required this.score, required this.color});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 72,
      height: 72,
      child: CustomPaint(
        painter: _TrustGaugePainter(progress: score / 100.0, color: color),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '$score',
                style: TextStyle(
                  color: color,
                  fontSize: 22,
                  fontWeight: FontWeight.w800,
                  height: 1,
                ),
              ),
              Text(
                'trust',
                style: TextStyle(
                  color: color.withValues(alpha: 0.6),
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

class _TrustGaugePainter extends CustomPainter {
  final double progress;
  final Color color;
  _TrustGaugePainter({required this.progress, required this.color});

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
  bool shouldRepaint(covariant _TrustGaugePainter old) =>
      old.progress != progress || old.color != color;
}
