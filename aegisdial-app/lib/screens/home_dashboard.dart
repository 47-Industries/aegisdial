import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import '../widgets/hyperspace_stars.dart';
import '../services/auth_service.dart';
import '../services/api_service.dart';
import 'live_shield_active.dart';
import 'coverage_screen.dart';
import 'breach_screen.dart';
import 'globe_screen.dart';

class _RecentItem {
  final IconData icon;
  final String title;
  final String subtitle;
  final int score;
  final String timeAgo;
  const _RecentItem({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.score,
    required this.timeAgo,
  });
}

class HomeDashboard extends StatefulWidget {
  final VoidCallback? onOpenRecovery;
  const HomeDashboard({super.key, this.onOpenRecovery});

  @override
  State<HomeDashboard> createState() => _HomeDashboardState();
}

class _HomeDashboardState extends State<HomeDashboard> {
  static const _kShieldKey = 'shield_on_v1';

  bool _shieldOn = true;
  int _callsAnalyzed = 0;
  int _scamsBlocked = 0;
  int _breachesFound = 0;
  List<_RecentItem> _recentActivity = [];

  @override
  void initState() {
    super.initState();
    _loadShieldState();
    _loadStats();
    _loadActivity();
  }

  Future<void> _loadShieldState() async {
    final p = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() => _shieldOn = p.getBool(_kShieldKey) ?? true);
  }

  Future<void> _setShield(bool v) async {
    setState(() => _shieldOn = v);
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kShieldKey, v);
  }

  Future<void> _loadStats() async {
    final session = auth.session;
    if (session == null || session.userId == 'guest') return;
    try {
      final res = await api.get('/v1/stats/summary');
      if (!mounted) return;
      setState(() {
        _callsAnalyzed = ((res['shields_this_week'] as num?) ?? 0).toInt();
        _scamsBlocked = ((res['critical_calls_avoided_30d'] as num?) ?? 0).toInt();
        _breachesFound = ((res['breaches_found_30d'] as num?) ?? 0).toInt();
      });
    } catch (_) {}
  }

  Future<void> _loadActivity() async {
    final prefs = await SharedPreferences.getInstance();
    final pairs = <(int, _RecentItem)>[];

    final smsRaw = prefs.getString('sms_scan_history_v1');
    if (smsRaw != null) {
      try {
        final list = jsonDecode(smsRaw) as List<dynamic>;
        for (final e in list) {
          final m = e as Map<String, dynamic>;
          final ts = (m['t'] as num).toInt();
          final score = (m['s'] as num).toInt();
          pairs.add((ts, _RecentItem(
            icon: Icons.sms_failed_outlined,
            title: m['p'] as String? ?? 'SMS message',
            subtitle: m['f'] as String? ?? 'Suspicious message',
            score: score,
            timeAgo: _relativeTime(ts),
          )));
        }
      } catch (_) {}
    }

    final breachRaw = prefs.getString('breach_exposures_v1');
    if (breachRaw != null) {
      try {
        final list = jsonDecode(breachRaw) as List<dynamic>;
        for (final e in list) {
          final m = e as Map<String, dynamic>;
          final dateStr = m['d'] as String?;
          final ts = DateTime.tryParse(dateStr ?? '')?.millisecondsSinceEpoch ?? 0;
          final cp = (m['ic'] as num?)?.toInt() ?? Icons.warning_rounded.codePoint;
          pairs.add((ts, _RecentItem(
            icon: IconData(cp, fontFamily: 'MaterialIcons'),
            title: m['ti'] as String? ?? 'Data breach',
            subtitle: m['so'] as String? ?? 'Dark web exposure',
            score: _severityScore(m['se'] as String?),
            timeAgo: _formatDate(dateStr),
          )));
        }
      } catch (_) {}
    }

    pairs.sort((a, b) => b.$1.compareTo(a.$1));
    final items = pairs.take(3).map((pair) => pair.$2).toList();
    if (!mounted) return;
    setState(() => _recentActivity = items);
  }

  static String _relativeTime(int ms) {
    final diff = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
    if (diff.inMinutes < 1) return 'just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    return '${diff.inDays}d ago';
  }

  static int _severityScore(String? severity) => switch (severity) {
    'critical' => 95,
    'high' => 80,
    'medium' => 55,
    _ => 30,
  };

  static String _formatDate(String? date) {
    if (date == null) return '';
    final dt = DateTime.tryParse(date);
    if (dt == null) return date;
    final diff = DateTime.now().difference(dt);
    if (diff.inDays < 30) return '${diff.inDays}d ago';
    if (diff.inDays < 365) return '${(diff.inDays / 30).round()}mo ago';
    return '${(diff.inDays / 365).round()}yr ago';
  }

  String _greeting() {
    final session = auth.session;
    if (session == null || session.userId == 'guest') return 'Welcome back';
    final name = session.displayName;
    if (name != null && name.trim().isNotEmpty) {
      return 'Hey, ${name.trim().split(' ').first}';
    }
    return 'Welcome back';
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Stack(
      fit: StackFit.expand,
      children: [
        const Positioned.fill(
          child: HyperspaceStars(starCount: 80, speed: 0.18),
        ),
        Positioned.fill(
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [
                  Colors.black.withValues(alpha: 0.4),
                  Colors.black.withValues(alpha: 0.85),
                ],
              ),
            ),
          ),
        ),
        SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'AEGISDIAL',
                        style: tt.labelMedium?.copyWith(
                          color: AegisColors.textTertiary,
                          letterSpacing: 1.6,
                        ),
                      ),
                      const SizedBox(height: 4),
                      ListenableBuilder(
                        listenable: auth,
                        builder: (_, child) => Text(
                          _greeting(),
                          style: tt.headlineMedium?.copyWith(
                            fontWeight: FontWeight.w700,
                            letterSpacing: -0.5,
                          ),
                        ),
                      ),
                    ],
                  ),
                  GestureDetector(
                    onTap: () {
                      showModalBottomSheet(
                        context: context,
                        backgroundColor: AegisColors.surface,
                        shape: const RoundedRectangleBorder(
                          borderRadius:
                              BorderRadius.vertical(top: Radius.circular(20)),
                        ),
                        builder: (_) => Padding(
                          padding: const EdgeInsets.fromLTRB(20, 20, 20, 36),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Notifications',
                                style: Theme.of(context)
                                    .textTheme
                                    .titleLarge
                                    ?.copyWith(fontWeight: FontWeight.w700),
                              ),
                              const SizedBox(height: 20),
                              if (_recentActivity.isEmpty)
                                Container(
                                  padding: const EdgeInsets.all(16),
                                  decoration: BoxDecoration(
                                    color: AegisColors.surfaceElevated,
                                    borderRadius: BorderRadius.circular(12),
                                  ),
                                  child: Row(
                                    children: [
                                      const Icon(Icons.notifications_none_rounded,
                                          color: AegisColors.textTertiary,
                                          size: 20),
                                      const SizedBox(width: 12),
                                      Text(
                                        'No new alerts',
                                        style: Theme.of(context)
                                            .textTheme
                                            .bodyMedium
                                            ?.copyWith(
                                                color: AegisColors.textSecondary),
                                      ),
                                    ],
                                  ),
                                )
                              else
                                ..._recentActivity.map((item) {
                                  final sc = item.score >= 80
                                      ? AegisColors.danger
                                      : item.score >= 50
                                          ? AegisColors.warning
                                          : AegisColors.success;
                                  return Container(
                                    margin: const EdgeInsets.only(bottom: 8),
                                    padding: const EdgeInsets.symmetric(
                                        vertical: 12, horizontal: 14),
                                    decoration: BoxDecoration(
                                      color: AegisColors.surfaceElevated,
                                      borderRadius: BorderRadius.circular(12),
                                    ),
                                    child: Row(
                                      children: [
                                        Icon(item.icon, color: sc, size: 18),
                                        const SizedBox(width: 12),
                                        Expanded(
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              Text(
                                                item.title,
                                                style: Theme.of(context)
                                                    .textTheme
                                                    .bodyMedium
                                                    ?.copyWith(
                                                        fontWeight:
                                                            FontWeight.w600),
                                              ),
                                              Text(
                                                item.subtitle,
                                                style: Theme.of(context)
                                                    .textTheme
                                                    .bodySmall
                                                    ?.copyWith(
                                                        color: AegisColors
                                                            .textSecondary),
                                              ),
                                            ],
                                          ),
                                        ),
                                        Text(
                                          item.timeAgo,
                                          style: Theme.of(context)
                                              .textTheme
                                              .labelSmall
                                              ?.copyWith(
                                                  color:
                                                      AegisColors.textTertiary),
                                        ),
                                      ],
                                    ),
                                  );
                                }),
                            ],
                          ),
                        ),
                      );
                    },
                    child: CircleAvatar(
                      radius: 22,
                      backgroundColor: AegisColors.surface,
                      child: Icon(
                        Icons.notifications_none_rounded,
                        color: AegisColors.textPrimary.withValues(alpha: 0.85),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              _StatusBanner(on: _shieldOn),
              const SizedBox(height: 16),
              GlassCard(
                accent: _shieldOn ? AegisColors.turquoise : AegisColors.danger,
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => const LiveShieldActiveScreen(),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: AegisColors.turquoise.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: const Icon(
                            Icons.shield_moon,
                            color: AegisColors.turquoise,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Live Shield',
                                style: tt.titleMedium?.copyWith(
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                'On-device call AI',
                                style: tt.bodySmall?.copyWith(
                                  color: AegisColors.textTertiary,
                                ),
                              ),
                            ],
                          ),
                        ),
                        Switch(
                          value: _shieldOn,
                          onChanged: _setShield,
                          activeThumbColor: AegisColors.turquoise,
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Container(
                      padding:
                          const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
                      decoration: BoxDecoration(
                        color: AegisColors.surfaceElevated,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Row(
                        children: [
                          Icon(
                            _shieldOn
                                ? Icons.fiber_manual_record
                                : Icons.pause_circle_outline,
                            size: 14,
                            color: _shieldOn
                                ? AegisColors.success
                                : AegisColors.textTertiary,
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              _shieldOn
                                  ? 'Listening — transcripts stay on device'
                                  : 'Shield paused — tap to resume',
                              style: tt.bodySmall?.copyWith(
                                color: AegisColors.textSecondary,
                              ),
                            ),
                          ),
                          const Icon(
                            Icons.chevron_right_rounded,
                            color: AegisColors.textTertiary,
                            size: 18,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              GlassCard(
                accent: AegisColors.blue,
                onTap: () => widget.onOpenRecovery?.call(),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: AegisColors.blue.withValues(alpha: 0.14),
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: const Icon(
                            Icons.healing,
                            color: AegisColors.blueAccent,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Recovery Concierge',
                                style: tt.titleMedium?.copyWith(
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                'Just got scammed? Start here.',
                                style: tt.bodySmall?.copyWith(
                                  color: AegisColors.textTertiary,
                                ),
                              ),
                            ],
                          ),
                        ),
                        const Icon(
                          Icons.arrow_forward_ios_rounded,
                          color: AegisColors.textTertiary,
                          size: 16,
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: GlassCard(
                      padding: const EdgeInsets.symmetric(
                        vertical: 18,
                        horizontal: 14,
                      ),
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute(builder: (_) => const CoverageScreen()),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(
                            Icons.message_outlined,
                            color: AegisColors.turquoise,
                          ),
                          const SizedBox(height: 10),
                          Text(
                            'SMS Filter',
                            style: tt.bodyLarge?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'Paste & scan messages',
                            style: tt.labelSmall?.copyWith(
                              color: AegisColors.textTertiary,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: GlassCard(
                      padding: const EdgeInsets.symmetric(
                        vertical: 18,
                        horizontal: 14,
                      ),
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute(builder: (_) => const BreachScreen()),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(
                            Icons.fingerprint_rounded,
                            color: AegisColors.blueAccent,
                          ),
                          const SizedBox(height: 10),
                          Text(
                            'Breach',
                            style: tt.bodyLarge?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'Dark-web origins',
                            style: tt.labelSmall?.copyWith(
                              color: AegisColors.textTertiary,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              GlassCard(
                accent: AegisColors.blue,
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const GlobeScreen()),
                ),
                child: Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AegisColors.blue.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(Icons.public_rounded, color: AegisColors.blue),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Coverage Map',
                            style: tt.titleMedium?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'Live fraud density by region',
                            style: tt.bodySmall?.copyWith(
                              color: AegisColors.textTertiary,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const Icon(
                      Icons.arrow_forward_ios_rounded,
                      color: AegisColors.textTertiary,
                      size: 16,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),
              Row(
                children: [
                  _StatTile(
                    value: _callsAnalyzed,
                    label: 'Calls\nanalyzed',
                    color: AegisColors.turquoise,
                  ),
                  const SizedBox(width: 10),
                  _StatTile(
                    value: _scamsBlocked,
                    label: 'Scams\nblocked',
                    color: AegisColors.danger,
                  ),
                  const SizedBox(width: 10),
                  _StatTile(
                    value: _breachesFound,
                    label: 'Breaches\nfound',
                    color: AegisColors.warning,
                  ),
                ],
              ),
              const SizedBox(height: 24),
              Text(
                'RECENT ACTIVITY',
                style: tt.labelSmall?.copyWith(
                  color: AegisColors.textTertiary,
                  letterSpacing: 1.6,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 10),
              if (_recentActivity.isEmpty) ...[
                const _ActivityTile(
                  icon: Icons.phone_disabled_rounded,
                  sender: '+1 (347) 555-0192',
                  type: 'Scam call blocked',
                  score: 87,
                  timeAgo: '2 min ago',
                ),
                const SizedBox(height: 8),
                const _ActivityTile(
                  icon: Icons.sms_failed_outlined,
                  sender: '+1 (800) 555-0199',
                  type: 'IRS impersonation — SMS deleted',
                  score: 94,
                  timeAgo: '1h ago',
                ),
                const SizedBox(height: 8),
                const _ActivityTile(
                  icon: Icons.link_off_rounded,
                  sender: 'FakeBank-Alert',
                  type: 'Phishing link intercepted',
                  score: 99,
                  timeAgo: '3h ago',
                ),
              ] else
                for (int i = 0; i < _recentActivity.length; i++) ...[
                  if (i > 0) const SizedBox(height: 8),
                  _ActivityTile(
                    icon: _recentActivity[i].icon,
                    sender: _recentActivity[i].title,
                    type: _recentActivity[i].subtitle,
                    score: _recentActivity[i].score,
                    timeAgo: _recentActivity[i].timeAgo,
                  ),
                ],
            ],
          ),
        ),
      ],
    );
  }
}

class _StatTile extends StatelessWidget {
  final int value;
  final String label;
  final Color color;
  const _StatTile({required this.value, required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 10),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: color.withValues(alpha: 0.25), width: 0.8),
        ),
        child: Column(
          children: [
            Text(
              value == 0 ? '—' : '$value',
              style: tt.headlineSmall?.copyWith(
                fontWeight: FontWeight.w800,
                color: value == 0 ? AegisColors.textTertiary : color,
                height: 1,
              ),
            ),
            const SizedBox(height: 5),
            Text(
              label,
              textAlign: TextAlign.center,
              style: tt.labelSmall?.copyWith(
                color: AegisColors.textTertiary,
                height: 1.3,
                fontSize: 10,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusBanner extends StatelessWidget {
  final bool on;
  const _StatusBanner({required this.on});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final accent = on ? AegisColors.success : AegisColors.danger;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: accent.withValues(alpha: 0.40), width: 0.8),
      ),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              color: accent,
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(color: accent, blurRadius: 8),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Text(
            on ? 'Protection active' : 'Protection paused',
            style: tt.bodyMedium?.copyWith(
              color: AegisColors.textPrimary,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _ActivityTile extends StatelessWidget {
  final IconData icon;
  final String sender;
  final String type;
  final int score;
  final String timeAgo;
  const _ActivityTile({
    required this.icon,
    required this.sender,
    required this.type,
    required this.score,
    required this.timeAgo,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final scoreColor = score >= 80
        ? AegisColors.danger
        : score >= 50
            ? AegisColors.warning
            : AegisColors.success;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: scoreColor.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: scoreColor, size: 18),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(sender,
                    style: tt.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                const SizedBox(height: 2),
                Text(type,
                    style: tt.bodySmall
                        ?.copyWith(color: AegisColors.textSecondary)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: scoreColor.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(5),
                ),
                child: Text(
                  '$score%',
                  style: TextStyle(
                      color: scoreColor,
                      fontSize: 11,
                      fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(height: 3),
              Text(timeAgo,
                  style: tt.labelSmall
                      ?.copyWith(color: AegisColors.textTertiary)),
            ],
          ),
        ],
      ),
    );
  }
}
