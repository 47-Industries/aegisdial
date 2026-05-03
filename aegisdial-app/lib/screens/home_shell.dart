import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import 'home_dashboard.dart';
import 'recovery_chatbot_screen.dart';
import 'family_screen.dart';
import 'settings_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  static const _items = <_NavItem>[
    _NavItem(Icons.shield_moon_outlined, Icons.shield_moon, 'Shield'),
    _NavItem(Icons.healing_outlined, Icons.healing, 'Recovery'),
    _NavItem(Icons.family_restroom_outlined, Icons.family_restroom, 'Family'),
    _NavItem(Icons.settings_outlined, Icons.settings, 'Settings'),
  ];

  void _select(int i) => setState(() => _index = i);

  @override
  Widget build(BuildContext context) {
    final tabs = <Widget>[
      HomeDashboard(onOpenRecovery: () => _select(1)),
      const RecoveryChatbotScreen(),
      const FamilyScreen(),
      const SettingsScreen(),
    ];
    return Scaffold(
      backgroundColor: AegisColors.background,
      body: IndexedStack(index: _index, children: tabs),
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          color: AegisColors.surface,
          border: Border(top: BorderSide(color: AegisColors.border, width: 0.6)),
        ),
        child: SafeArea(
          top: false,
          child: SizedBox(
            height: 64,
            child: Row(
              children: List.generate(_items.length, (i) {
                final selected = i == _index;
                return Expanded(
                  child: InkWell(
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
                            fontWeight:
                                selected ? FontWeight.w600 : FontWeight.w400,
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
    );
  }
}

class _NavItem {
  final IconData inactive;
  final IconData active;
  final String label;
  const _NavItem(this.inactive, this.active, this.label);
}
