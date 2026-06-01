import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import '../widgets/hyperspace_stars.dart';
import '../services/auth_service.dart';
import '../services/api_service.dart';
import '../services/device_service.dart';
import '../services/identity_shield_service.dart';
import '../services/extension_bridge_service.dart';
import 'live_shield_active.dart';
import 'coverage_screen.dart';
import 'breach_screen.dart';
import 'number_check_screen.dart';
import 'email_shield_screen.dart';
import 'identity_shield_screen.dart';
import 'call_screener_screen.dart';

class HomeDashboard extends StatefulWidget {
  static final liveShieldKey = GlobalKey();
  static final smsFilterKey = GlobalKey();
  static final breachKey = GlobalKey();
  static final numberCheckKey = GlobalKey();
  static final emailShieldKey = GlobalKey();
  static final identityShieldKey = GlobalKey();

  const HomeDashboard({super.key});

  @override
  State<HomeDashboard> createState() => _HomeDashboardState();
}

class _HomeDashboardState extends State<HomeDashboard> {
  static const _kShieldKey = 'shield_on_v1';
  static const _kChecklistDismissed = 'setup_checklist_dismissed_v1';

  // Neutral placeholder shown until /v1/stats/summary returns. The
  // app has no users yet — fabricating "2.4M calls screened / 847K
  // scams blocked" community-impact numbers on every cold-start was
  // an investor + reviewer screenshot risk and unfair to the eventual
  // users whose first impression would be inflated counts. Tiles
  // now read 0 until real data lands.
  static const _kInitialStats = [
    (0, 'Calls\nscreened', AegisColors.turquoise),
    (0, 'Scams\nblocked', AegisColors.success),
    (0, 'Breaches\ncaught', AegisColors.blueAccent),
  ];

  bool _shieldOn = true;
  bool _checklistDismissed = true;
  bool _pushEnabled = false;
  bool _smsFilterEnabled = false;
  bool _callDirEnabled = false;
  int _monitorCount = 0;
  String _statsLabel = 'MY STATS';
  List<(int, String, Color)> _displayStats = _kInitialStats;
  IdentityShieldTile? _identityTile;

  @override
  void initState() {
    super.initState();
    _loadShieldState();
    _loadStats();
    _loadChecklist();
    _syncExtensionData();
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

  Future<void> _loadChecklist() async {
    final p = await SharedPreferences.getInstance();
    final dismissed = p.getBool(_kChecklistDismissed) ?? false;
    final diag = await deviceService.snapshot();
    final smsEnabled = await extensionBridge.isSMSFilterEnabled();
    final callDirStatus = await extensionBridge.callDirectoryStatus();
    if (!mounted) return;
    setState(() {
      _checklistDismissed = dismissed;
      _pushEnabled = diag.healthy;
      _smsFilterEnabled = smsEnabled;
      _callDirEnabled = callDirStatus == 'enabled';
    });
  }

  Future<void> _dismissChecklist() async {
    setState(() => _checklistDismissed = true);
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kChecklistDismissed, true);
  }

  /// Push scam data to the App Group shared container so the SMS Filter
  /// and Call Directory extensions have up-to-date data. Best-effort —
  /// the extensions have built-in phrase lists as a fallback.
  Future<void> _syncExtensionData() async {
    // Push any backend-sourced scam phrases the user has accumulated.
    // For now we use the built-in set — the extension already has these
    // compiled in, but this ensures the pipeline works for when the
    // backend starts pushing custom phrases per-user.
    await extensionBridge.reloadCallDirectory();
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
      // Identity Shield tile counts ride on the same stats response,
      // so one round trip powers both the existing 3-up tile row AND
      // the new Identity Shield card. The tile is always parsed (even
      // when all zeros) so the card renders with neutral copy.
      final identityTile = IdentityShieldTile.fromStats(res);
      setState(() {
        _identityTile = identityTile;
        _monitorCount = identityTile.monitorsActive;
        _statsLabel = 'MY STATS';
        _displayStats = [
          (calls, 'Calls\nscreened', AegisColors.turquoise),
          (scams, 'Scams\nblocked', AegisColors.success),
          (breaches, 'Breaches\ncaught', AegisColors.blueAccent),
        ];
      });
    } catch (_) {}
  }

  bool get _isGuest =>
      auth.session == null || auth.session?.userId == 'guest';

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
                if (!_checklistDismissed && !_isGuest) ...[
                  const SizedBox(height: 16),
                  _SetupChecklist(
                    pushEnabled: _pushEnabled,
                    smsFilterEnabled: _smsFilterEnabled,
                    callDirEnabled: _callDirEnabled,
                    monitorCount: _monitorCount,
                    onDismiss: _dismissChecklist,
                    onOpenBreach: () => Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => const BreachScreen()),
                    ),
                  ),
                ],
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
                                  'Real-time AI call protection',
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
                                    ? 'Ready — put call on speaker, tap to activate'
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
                // Call Screener card
                GlassCard(
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => const CallScreenerScreen(),
                    ),
                  ),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: AegisColors.blue.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: const Icon(
                          Icons.phone_forwarded_rounded,
                          color: AegisColors.blueAccent,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Call Screener',
                              style: tt.titleMedium?.copyWith(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              'AI screens calls you miss — blocks scams, forwards the rest',
                              style: tt.bodySmall?.copyWith(
                                color: AegisColors.textTertiary,
                              ),
                            ),
                          ],
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
                const SizedBox(height: 12),
                GlassCard(
                  key: HomeDashboard.numberCheckKey,
                  accent: AegisColors.warning,
                  padding: const EdgeInsets.symmetric(
                    vertical: 16,
                    horizontal: 16,
                  ),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(
                        builder: (_) => const NumberCheckScreen()),
                  ),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: AegisColors.warning.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: const Icon(
                          Icons.phone_callback_rounded,
                          color: AegisColors.warning,
                        ),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Check a Number',
                              style: tt.bodyLarge?.copyWith(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              'Look up any caller for scam signals',
                              style: tt.labelSmall?.copyWith(
                                color: AegisColors.textTertiary,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const Icon(
                        Icons.chevron_right_rounded,
                        color: AegisColors.textTertiary,
                        size: 20,
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                GlassCard(
                  key: HomeDashboard.emailShieldKey,
                  accent: AegisColors.blueAccent,
                  padding: const EdgeInsets.symmetric(
                    vertical: 16,
                    horizontal: 16,
                  ),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(
                        builder: (_) => const EmailShieldScreen()),
                  ),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: AegisColors.blueAccent.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: const Icon(
                          Icons.email_outlined,
                          color: AegisColors.blueAccent,
                        ),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Email Shield',
                              style: tt.bodyLarge?.copyWith(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              'Detect email compromise',
                              style: tt.labelSmall?.copyWith(
                                color: AegisColors.textTertiary,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const Icon(
                        Icons.chevron_right_rounded,
                        color: AegisColors.textTertiary,
                        size: 20,
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                KeyedSubtree(
                  key: HomeDashboard.identityShieldKey,
                  child: _IdentityShieldCard(
                    tile: _identityTile,
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => const IdentityShieldScreen(),
                      ),
                    ),
                  ),
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
                        value: _displayStats[i].$1,
                        label: _displayStats[i].$2,
                        color: _displayStats[i].$3,
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Icon(
                      Icons.lock_outline_rounded,
                      size: 12,
                      color: AegisColors.textTertiary,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      'All analysis stays on your device. We never see your data.',
                      style: tt.labelSmall?.copyWith(
                        color: AegisColors.textTertiary,
                        fontSize: 11,
                      ),
                    ),
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

/// Compact K/M formatter for the dashboard stat tiles. Top-level so
/// _StatTile's count-up animation can format each interpolated frame.
String _formatStat(int n) {
  if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
  if (n >= 1000) return '${(n / 1000).toStringAsFixed(0)}K';
  return '$n';
}

class _StatTile extends StatelessWidget {
  final int value;
  final String label;
  final Color color;
  const _StatTile(
      {required this.value, required this.label, required this.color});

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
            // Count-up: animates 0 → value on first paint, and from the
            // old value → new value when stats reload (community
            // placeholder → the user's real numbers). easeOutCubic
            // decelerates into the final figure so it lands rather than
            // snapping. `key: ValueKey(value)` would restart the tween;
            // we deliberately omit it so a value change animates FROM
            // the current figure instead of from 0.
            TweenAnimationBuilder<double>(
              tween: Tween<double>(begin: 0, end: value.toDouble()),
              duration: const Duration(milliseconds: 900),
              curve: Curves.easeOutCubic,
              builder: (context, v, _) => Text(
                _formatStat(v.round()),
                style: tt.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                  color: color,
                  height: 1,
                ),
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

/// Home-screen card for Identity Shield. Renders even when `tile` is
/// null (pre-load state) — shows neutral "Monitoring" copy so the row
/// doesn't visually pop in after the stats round-trip completes.
class _IdentityShieldCard extends StatelessWidget {
  final IdentityShieldTile? tile;
  final VoidCallback onTap;
  const _IdentityShieldCard({required this.tile, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final t = tile;
    final hasSignal = t?.hasAnySignal ?? false;
    final findings7d = t?.newFindings7d ?? 0;
    // Card body copy: prefer the findings signal (it's the actionable one),
    // then monitor count, then a neutral baseline. Never lie about zero
    // monitors looking like "you're covered" — guide to action instead.
    final body = findings7d > 0
        ? '$findings7d new ${findings7d == 1 ? "exposure" : "exposures"} this week — tap to review.'
        : (t?.monitorsActive ?? 0) > 0
            ? 'Watching ${t!.monitorsActive} identifier${t.monitorsActive == 1 ? "" : "s"} for fresh dark-web leaks.'
            : 'Add an email or phone to monitor for dark-web exposures.';
    final accent = findings7d > 0
        ? AegisColors.danger
        : (hasSignal ? AegisColors.blueAccent : AegisColors.textSecondary);
    return GlassCard(
      accent: accent,
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(Icons.radar_rounded, color: accent),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Identity Shield',
                      style: tt.titleMedium
                          ?.copyWith(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      t == null
                          ? 'Loading…'
                          : '${t.activeThreatsNearUser30d} active threats near you',
                      style: tt.bodySmall
                          ?.copyWith(color: AegisColors.textTertiary),
                    ),
                  ],
                ),
              ),
              if (findings7d > 0)
                Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: AegisColors.danger.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(
                        color: AegisColors.danger.withValues(alpha: 0.4),
                        width: 0.8),
                  ),
                  child: Text(
                    '$findings7d new',
                    style: tt.labelSmall?.copyWith(
                      color: AegisColors.danger,
                      fontWeight: FontWeight.w700,
                      fontSize: 11,
                    ),
                  ),
                )
              else
                const Icon(Icons.chevron_right_rounded,
                    color: AegisColors.textTertiary, size: 20),
            ],
          ),
          const SizedBox(height: 14),
          Container(
            padding:
                const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
            decoration: BoxDecoration(
              color: AegisColors.surfaceElevated,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    body,
                    style: tt.bodySmall
                        ?.copyWith(color: AegisColors.textSecondary),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SetupChecklist extends StatelessWidget {
  final bool pushEnabled;
  final bool smsFilterEnabled;
  final bool callDirEnabled;
  final int monitorCount;
  final VoidCallback onDismiss;
  final VoidCallback onOpenBreach;

  const _SetupChecklist({
    required this.pushEnabled,
    required this.smsFilterEnabled,
    required this.callDirEnabled,
    required this.monitorCount,
    required this.onDismiss,
    required this.onOpenBreach,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final items = <_CheckItem>[
      _CheckItem(
        done: pushEnabled,
        label: 'Enable push notifications',
        detail: 'Get alerted when scams target you',
        onTap: pushEnabled
            ? null
            : () => deviceService.ensureRegistered(),
      ),
      _CheckItem(
        done: smsFilterEnabled,
        label: 'Enable SMS Filter in iOS Settings',
        detail: 'Settings > Apps > Messages > SMS Filter > AegisDial',
        onTap: null,
      ),
      _CheckItem(
        done: callDirEnabled,
        label: 'Enable Caller ID in iOS Settings',
        detail: 'Settings > Phone > Call Blocking & Identification > AegisDial',
        onTap: null,
      ),
      _CheckItem(
        done: monitorCount > 0,
        label: 'Add a breach monitor',
        detail: 'Watch your email on the dark web',
        onTap: monitorCount > 0 ? null : onOpenBreach,
      ),
    ];
    final doneCount = items.where((i) => i.done).length;
    if (doneCount == items.length) {
      // All done — auto-dismiss next paint
      WidgetsBinding.instance.addPostFrameCallback((_) => onDismiss());
      return const SizedBox.shrink();
    }
    return GlassCard(
      accent: AegisColors.turquoise,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'COMPLETE YOUR SETUP',
                  style: tt.labelSmall?.copyWith(
                    color: AegisColors.turquoise,
                    letterSpacing: 1.4,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              Text(
                '$doneCount/${items.length}',
                style: tt.labelSmall?.copyWith(
                  color: AegisColors.textTertiary,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 8),
              GestureDetector(
                onTap: onDismiss,
                child: const Icon(
                  Icons.close_rounded,
                  size: 16,
                  color: AegisColors.textTertiary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(
              value: doneCount / items.length,
              minHeight: 3,
              backgroundColor: AegisColors.border,
              valueColor: const AlwaysStoppedAnimation(AegisColors.turquoise),
            ),
          ),
          const SizedBox(height: 12),
          ...items.map((item) => _CheckRow(item: item)),
        ],
      ),
    );
  }
}

class _CheckItem {
  final bool done;
  final String label;
  final String detail;
  final VoidCallback? onTap;
  const _CheckItem({
    required this.done,
    required this.label,
    required this.detail,
    this.onTap,
  });
}

class _CheckRow extends StatelessWidget {
  final _CheckItem item;
  const _CheckRow({required this.item});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return GestureDetector(
      onTap: item.done ? null : item.onTap,
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              item.done
                  ? Icons.check_circle_rounded
                  : Icons.radio_button_unchecked_rounded,
              size: 20,
              color: item.done
                  ? AegisColors.success
                  : AegisColors.textTertiary,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.label,
                    style: tt.bodySmall?.copyWith(
                      fontWeight: FontWeight.w600,
                      color: item.done
                          ? AegisColors.textTertiary
                          : AegisColors.textPrimary,
                      decoration:
                          item.done ? TextDecoration.lineThrough : null,
                    ),
                  ),
                  Text(
                    item.detail,
                    style: tt.labelSmall?.copyWith(
                      color: AegisColors.textTertiary,
                      fontSize: 11,
                    ),
                  ),
                ],
              ),
            ),
            if (!item.done && item.onTap != null)
              const Icon(
                Icons.chevron_right_rounded,
                size: 16,
                color: AegisColors.textTertiary,
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
