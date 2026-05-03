import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import '../services/api_service.dart';

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

class _CoverageScreenState extends State<CoverageScreen> {
  bool _autoDelete = true;
  bool _scanLinks = true;
  bool _scanAttachments = true;

  final _pasteCtrl = TextEditingController();
  bool _scanning = false;
  _ScanResult? _result;

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
  void dispose() {
    _pasteCtrl.dispose();
    super.dispose();
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
      final res = await api.post('/v1/sms-classify', {'text': text});
      final score = ((res['risk_score'] as num?) ?? 0).round();
      final level = (res['risk_level'] as String?) ?? 'LOW';
      final reason = (res['reason'] as String?) ?? '';
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
    setState(() {
      _scanning = false;
      _result = result;
    });
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
          const SizedBox(height: 20),
          Text(
            'SCANNER SETTINGS',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.6,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          _Toggle(
            icon: Icons.delete_sweep_outlined,
            title: 'Auto-delete confirmed scams',
            subtitle: 'High-confidence matches removed without review.',
            value: _autoDelete,
            onChanged: (v) => setState(() => _autoDelete = v),
          ),
          _Toggle(
            icon: Icons.preview_rounded,
            title: 'Review before deleting',
            subtitle: 'Flagged messages queue here so you confirm each one.',
            value: !_autoDelete,
            onChanged: (v) => setState(() => _autoDelete = !v),
          ),
          _Toggle(
            icon: Icons.link_off_rounded,
            title: 'Inspect links',
            subtitle: 'Cross-check URLs against Google Safe Browsing.',
            value: _scanLinks,
            onChanged: (v) => setState(() => _scanLinks = v),
          ),
          _Toggle(
            icon: Icons.attachment_outlined,
            title: 'Inspect attachments',
            subtitle: 'Scan images and files for known scam payloads.',
            value: _scanAttachments,
            onChanged: (v) => setState(() => _scanAttachments = v),
          ),
          const SizedBox(height: 24),
          Text(
            'CAUGHT MESSAGES',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.6,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            _autoDelete
                ? 'Auto-deleted scam messages — tap to review.'
                : 'Review each flagged message before deleting.',
            style: tt.bodySmall?.copyWith(color: AegisColors.textTertiary),
          ),
          const SizedBox(height: 10),
          ..._caught.map(
            (m) => _CaughtMessageTile(
              message: m,
              autoDelete: _autoDelete,
              onDelete: () => setState(() => m.deleted = true),
              onKeep: () => setState(() => _caught.remove(m)),
            ),
          ),
        ],
      ),
    );
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
              Text(
                '${result.score}%',
                style: tt.headlineSmall?.copyWith(
                  color: result.color,
                  fontWeight: FontWeight.w800,
                ),
              ),
              Text(
                ' fraud score',
                style: tt.bodySmall?.copyWith(color: AegisColors.textTertiary),
              ),
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
  final bool autoDelete;
  final VoidCallback onDelete;
  final VoidCallback onKeep;
  const _CaughtMessageTile({
    required this.message,
    required this.autoDelete,
    required this.onDelete,
    required this.onKeep,
  });

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
          if (!autoDelete && !message.deleted) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: onKeep,
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size.fromHeight(36),
                      side: const BorderSide(
                          color: AegisColors.textTertiary, width: 0.6),
                      padding: EdgeInsets.zero,
                    ),
                    child: const Text(
                      'Keep',
                      style: TextStyle(
                          color: AegisColors.textSecondary, fontSize: 13),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: ElevatedButton(
                    onPressed: onDelete,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AegisColors.danger,
                      foregroundColor: Colors.white,
                      minimumSize: const Size.fromHeight(36),
                      padding: EdgeInsets.zero,
                    ),
                    child: const Text('Delete', style: TextStyle(fontSize: 13)),
                  ),
                ),
              ],
            ),
          ],
          if (message.deleted) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                const Icon(Icons.check_circle_outline,
                    size: 14, color: AegisColors.success),
                const SizedBox(width: 6),
                Text(
                  'Deleted',
                  style: tt.labelSmall?.copyWith(color: AegisColors.success),
                ),
              ],
            ),
          ],
          if (autoDelete && !message.deleted) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                const Icon(Icons.delete_sweep_outlined,
                    size: 14, color: AegisColors.textTertiary),
                const SizedBox(width: 6),
                Text(
                  'Auto-deleted',
                  style:
                      tt.labelSmall?.copyWith(color: AegisColors.textTertiary),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _Toggle extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;
  const _Toggle({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: AegisColors.turquoise.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: AegisColors.turquoise, size: 18),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: tt.bodyLarge?.copyWith(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: tt.bodySmall?.copyWith(
                      color: AegisColors.textTertiary, height: 1.35),
                ),
              ],
            ),
          ),
          Switch(
            value: value,
            onChanged: onChanged,
            activeThumbColor: AegisColors.turquoise,
          ),
        ],
      ),
    );
  }
}
