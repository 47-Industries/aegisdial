import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/coach_mark.dart';
import '../services/auth_service.dart';
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
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeStartTour());
  }

  @override
  void dispose() {
    _coach.dispose();
    super.dispose();
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
      HomeDashboard(onOpenRecovery: () => _select(1)),
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
