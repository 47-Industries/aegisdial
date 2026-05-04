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

class HomeDashboard extends StatefulWidget {
  static final liveShieldKey = GlobalKey();
  static final smsFilterKey = GlobalKey();
  static final breachKey = GlobalKey();

  const HomeDashboard({super.key});

  @override
  State<HomeDashboard> createState() => _HomeDashboardState();
}

class _HomeDashboardState extends State<HomeDashboard> {
  static const _kShieldKey = 'shield_on_v1';

  static const _kPlatformStats = [
    ('2.4M', 'Calls\nscreened', AegisColors.turquoise),
    ('847K', 'Scams\nblocked', AegisColors.success),
    ('12.8K', 'Breaches\ncaught', AegisColors.blueAccent),
  ];

  bool _shieldOn = true;
  String _statsLabel = 'COMMUNITY IMPACT';
  List<(String, String, Color)> _displayStats = _kPlatformStats;

  @override
  void initState() {
    super.initState();
    _loadShieldState();
    _loadStats();
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
      final calls = ((res['shields_this_week'] as num?) ?? 0).toInt();
      final scams = ((res['critical_calls_avoided_30d'] as num?) ?? 0).toInt();
      final breaches = ((res['breaches_found_30d'] as num?) ?? 0).toInt();
      if (calls > 0 || scams > 0 || breaches > 0) {
        setState(() {
          _statsLabel = 'MY STATS';
          _displayStats = [
            (_fmtNum(calls), 'Calls\nscreened', AegisColors.turquoise),
            (_fmtNum(scams), 'Scams\nblocked', AegisColors.success),
            (_fmtNum(breaches), 'Breaches\ncaught', AegisColors.blueAccent),
          ];
        });
      }
    } catch (_) {}
  }

  static String _fmtNum(int n) {
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(0)}K';
    return '$n';
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
          child: RefreshIndicator(
            color: AegisColors.turquoise,
            backgroundColor: AegisColors.surface,
            onRefresh: () => _loadStats(),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
              children: [
                ListenableBuilder(
                  listenable: auth,
                  builder: (context2, child2) => Column(
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
                      Text(
                        _greeting(),
                        style: tt.headlineMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                          letterSpacing: -0.5,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 24),
                _StatusBanner(on: _shieldOn),
                const SizedBox(height: 16),
                GlassCard(
                  key: HomeDashboard.liveShieldKey,
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
                        padding: const EdgeInsets.symmetric(
                            vertical: 10, horizontal: 12),
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
                Row(
                  children: [
                    Expanded(
                      child: GlassCard(
                        key: HomeDashboard.smsFilterKey,
                        padding: const EdgeInsets.symmetric(
                          vertical: 18,
                          horizontal: 14,
                        ),
                        onTap: () => Navigator.of(context).push(
                          MaterialPageRoute(
                              builder: (_) => const CoverageScreen()),
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
                        key: HomeDashboard.breachKey,
                        padding: const EdgeInsets.symmetric(
                          vertical: 18,
                          horizontal: 14,
                        ),
                        onTap: () => Navigator.of(context).push(
                          MaterialPageRoute(
                              builder: (_) => const BreachScreen()),
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
                const SizedBox(height: 20),
                Text(
                  _statsLabel,
                  style: tt.labelSmall?.copyWith(
                    color: AegisColors.textTertiary,
                    letterSpacing: 1.6,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    for (int i = 0; i < _displayStats.length; i++) ...[
                      if (i > 0) const SizedBox(width: 10),
                      _StatTile(
                        displayValue: _displayStats[i].$1,
                        label: _displayStats[i].$2,
                        color: _displayStats[i].$3,
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _StatTile extends StatelessWidget {
  final String displayValue;
  final String label;
  final Color color;
  const _StatTile(
      {required this.displayValue, required this.label, required this.color});

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
              displayValue,
              style: tt.headlineSmall?.copyWith(
                fontWeight: FontWeight.w800,
                color: color,
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
