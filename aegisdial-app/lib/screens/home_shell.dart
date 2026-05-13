import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/coach_mark.dart';
import '../services/auth_service.dart';
import '../services/device_service.dart';
import 'home_dashboard.dart';
import 'recovery_chatbot_screen.dart';
import 'family_screen.dart';
import 'settings_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  static final recoveryTabKey = GlobalKey();

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;
  final _coach = CoachMarkController();

  static const _items = <_NavItem>[
    _NavItem(Icons.shield_moon_outlined, Icons.shield_moon, 'Shield'),
    _NavItem(Icons.healing_outlined, Icons.healing, 'Recovery'),
    _NavItem(Icons.family_restroom_outlined, Icons.family_restroom, 'Family'),
    _NavItem(Icons.settings_outlined, Icons.settings, 'Settings'),
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _maybeStartTour();
      // Once the home dashboard is mounted the user has context for
      // the notifications prompt. Skips for guests (no backend account
      // to associate the APNs token with) and no-ops on Android.
      deviceService.ensureRegistered();
    });
    deviceService.addTapListener(_handleNotificationTap);
  }

  @override
  void dispose() {
    deviceService.removeTapListener(_handleNotificationTap);
    _coach.dispose();
    super.dispose();
  }

  /// Route deep-link from notification payload. The backend's push
  /// composer puts a `kind` field on every alert so iOS knows where to
  /// land the user. Unknown kinds fall through to Shield (index 0).
  void _handleNotificationTap(Map<String, dynamic> payload) {
    if (!mounted) return;
    final kind = payload['kind']?.toString() ?? '';
    final next = switch (kind) {
      'v3_takeover' || 'live_shield' || 'critical_alert' => 0, // Shield
      'recovery_followup' || 'recovery_alert' => 1, // Recovery
      'family_alert' || 'family_join' || 'family_invite' => 2, // Family
      _ => 0,
    };
    setState(() => _index = next);
  }

  Future<void> _maybeStartTour() async {
    final isGuest = auth.session?.userId == 'guest';
    final seen = isGuest ? false : await coachTourSeen();
    if (!mounted || seen) return;
    _coach.start(
      [
        CoachStep(
          targetKey: HomeDashboard.liveShieldKey,
          title: 'Live Shield',
          body: 'Your AI call guard. Tap to start a live session when a suspicious call comes in.',
        ),
        CoachStep(
          targetKey: HomeDashboard.smsFilterKey,
          title: 'SMS Filter',
          body: 'Paste any suspicious text and we\'ll detect scam patterns in seconds.',
        ),
        CoachStep(
          targetKey: HomeDashboard.breachKey,
          title: 'Breach Monitor',
          body: 'Check if your email or phone has appeared in dark-web data leaks.',
        ),
        CoachStep(
          targetKey: HomeDashboard.identityShieldKey,
          title: 'Identity Shield',
          body:
              'Watch for active scammer activity targeting your identity — fresh breaches, dark-web mentions, threat patterns near you.',
        ),
        CoachStep(
          targetKey: HomeShell.recoveryTabKey,
          title: 'Recovery Concierge',
          body: 'Just got scammed? Tap here and we\'ll walk you through every step to stop the damage.',
        ),
      ],
      guest: isGuest,
    );
  }

  void _select(int i) => setState(() => _index = i);

  @override
  Widget build(BuildContext context) {
    final tabs = <Widget>[
      const HomeDashboard(),
      const RecoveryChatbotScreen(),
      const FamilyScreen(),
      const SettingsScreen(),
    ];
    return CoachMarkOverlay(
      controller: _coach,
      child: Scaffold(
        backgroundColor: AegisColors.background,
        body: IndexedStack(index: _index, children: tabs),
        bottomNavigationBar: Container(
          decoration: const BoxDecoration(
            color: AegisColors.surface,
            border:
                Border(top: BorderSide(color: AegisColors.border, width: 0.6)),
          ),
          child: SafeArea(
            top: false,
            child: SizedBox(
              height: 64,
              child: Row(
                children: List.generate(_items.length, (i) {
                  final selected = i == _index;
                  final isRecovery = i == 1;
                  return Expanded(
                    child: InkWell(
                      key: isRecovery ? HomeShell.recoveryTabKey : null,
                      onTap: () => _select(i),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            selected ? _items[i].active : _items[i].inactive,
                            color: selected
                                ? AegisColors.turquoise
                                : AegisColors.textTertiary,
                            size: 22,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            _items[i].label,
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: selected
                                  ? FontWeight.w600
                                  : FontWeight.w400,
                              color: selected
                                  ? AegisColors.textPrimary
                                  : AegisColors.textTertiary,
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _NavItem {
  final IconData inactive;
  final IconData active;
  final String label;
  const _NavItem(this.inactive, this.active, this.label);
}
