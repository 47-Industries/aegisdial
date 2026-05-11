// Settings → Family Alert Privacy
//
// Wires the v2 backend's /v1/family-alert/preferences endpoint. Lets Pro
// users choose how much information a family alert push includes when
// Live Shield fires a critical-risk warning on their call.
//
// Three levels, locked in LIVE_SHIELD.md:
//   minimal — risk score + scam type only
//   default — adds the matched red-flag phrases (≤5)
//   open    — adds a transcript view link family can open
//
// The mom-controls-her-own-privacy stance is one of v2's key marketing
// moves — competitors fan out everything to family by default.

import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../theme/app_theme.dart';

class FamilyAlertPrivacyScreen extends StatefulWidget {
  const FamilyAlertPrivacyScreen({super.key});

  @override
  State<FamilyAlertPrivacyScreen> createState() =>
      _FamilyAlertPrivacyScreenState();
}

class _FamilyAlertPrivacyScreenState extends State<FamilyAlertPrivacyScreen> {
  String? _currentLevel; // null while loading
  String? _savingLevel; // non-null while writing
  String? _error;

  static const _levels = [
    _Level(
      key: 'minimal',
      title: 'Minimal',
      subtitle: 'Risk score and scam type only.',
      bullet:
          'They\'ll know you\'re in a risky call but no transcript details ever leave your phone.',
    ),
    _Level(
      key: 'default',
      title: 'Standard',
      subtitle: 'Score + scam type + the top red-flag phrases (up to 5).',
      bullet:
          'Family sees what the scammer actually said that triggered the alert. Recommended.',
    ),
    _Level(
      key: 'open',
      title: 'Open',
      subtitle: 'Full transcript link they can open.',
      bullet:
          'Maximum context for family — useful if you\'re mid-recovery and want them to see exactly what happened.',
    ),
  ];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final res = await api.get('/v1/family-alert/preferences');
      if (!mounted) return;
      setState(() {
        _currentLevel = (res['privacy_level'] as String?) ?? 'default';
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        // Default to 'default' even on load failure so the UI still works.
        _currentLevel = 'default';
        _error = 'Couldn\'t load your saved choice — showing the default.';
      });
    }
  }

  Future<void> _save(String level) async {
    if (_savingLevel != null || level == _currentLevel) return;
    setState(() {
      _savingLevel = level;
      _error = null;
    });
    try {
      await api.put('/v1/family-alert/preferences', {'privacy_level': level});
      if (!mounted) return;
      setState(() {
        _currentLevel = level;
        _savingLevel = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _savingLevel = null;
        _error = 'Couldn\'t save — check your connection and try again.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(
        title: const Text('Family Alert Privacy'),
        elevation: 0,
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
          children: [
            // Header
            Text(
              'Choose what family sees',
              style: tt.headlineSmall?.copyWith(
                fontWeight: FontWeight.w700,
                letterSpacing: -0.5,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'When AegisDial flags a critical scam on your call, your family-plan '
              'members get an alert. You control how much they see.',
              style: tt.bodyMedium?.copyWith(
                color: AegisColors.textSecondary,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 22),

            if (_error != null)
              Container(
                margin: const EdgeInsets.only(bottom: 16),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: BoxDecoration(
                  color: AegisColors.danger.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                    color: AegisColors.danger.withValues(alpha: 0.3),
                    width: 0.8,
                  ),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.error_outline,
                        size: 16, color: AegisColors.danger),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _error!,
                        style: tt.bodySmall?.copyWith(color: AegisColors.danger),
                      ),
                    ),
                  ],
                ),
              ),

            // Loading skeleton while we fetch
            if (_currentLevel == null)
              const Center(
                child: Padding(
                  padding: EdgeInsets.symmetric(vertical: 32),
                  child: CircularProgressIndicator(
                    color: AegisColors.turquoise,
                    strokeWidth: 2,
                  ),
                ),
              )
            else
              ..._levels.map((l) => _LevelTile(
                    level: l,
                    selected: _currentLevel == l.key,
                    saving: _savingLevel == l.key,
                    onTap: () => _save(l.key),
                  )),

            const SizedBox(height: 24),
            // Privacy footer
            Row(
              children: [
                const Icon(
                  Icons.lock_outline_rounded,
                  size: 14,
                  color: AegisColors.textTertiary,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    'Your choice applies to every future family alert. Change it anytime.',
                    style: tt.labelSmall?.copyWith(
                      color: AegisColors.textTertiary,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Level {
  final String key;
  final String title;
  final String subtitle;
  final String bullet;
  const _Level({
    required this.key,
    required this.title,
    required this.subtitle,
    required this.bullet,
  });
}

class _LevelTile extends StatelessWidget {
  final _Level level;
  final bool selected;
  final bool saving;
  final VoidCallback onTap;

  const _LevelTile({
    required this.level,
    required this.selected,
    required this.saving,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: saving ? null : onTap,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: selected
                  ? AegisColors.turquoise.withValues(alpha: 0.08)
                  : AegisColors.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                color: selected
                    ? AegisColors.turquoise.withValues(alpha: 0.55)
                    : AegisColors.border,
                width: selected ? 1.4 : 0.8,
              ),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Radio indicator
                AnimatedContainer(
                  duration: const Duration(milliseconds: 180),
                  width: 22,
                  height: 22,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: selected
                          ? AegisColors.turquoise
                          : AegisColors.textTertiary,
                      width: 1.5,
                    ),
                  ),
                  child: selected
                      ? Padding(
                          padding: const EdgeInsets.all(3.5),
                          child: Container(
                            decoration: const BoxDecoration(
                              shape: BoxShape.circle,
                              color: AegisColors.turquoise,
                            ),
                          ),
                        )
                      : null,
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(
                            level.title,
                            style: tt.titleMedium?.copyWith(
                              fontWeight: FontWeight.w700,
                              letterSpacing: -0.2,
                            ),
                          ),
                          if (saving) ...[
                            const SizedBox(width: 10),
                            const SizedBox(
                              width: 12,
                              height: 12,
                              child: CircularProgressIndicator(
                                strokeWidth: 1.5,
                                color: AegisColors.turquoise,
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        level.subtitle,
                        style: tt.bodySmall?.copyWith(
                          color: AegisColors.textSecondary,
                          height: 1.45,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        level.bullet,
                        style: tt.bodySmall?.copyWith(
                          color: AegisColors.textTertiary,
                          height: 1.45,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
