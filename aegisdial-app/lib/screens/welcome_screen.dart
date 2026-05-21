import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/hyperspace_stars.dart';
import '../widgets/aegis_logo.dart';
import 'auth_screen.dart';
import 'live_shield_active.dart';

class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    return Scaffold(
      backgroundColor: AegisColors.background,
      body: Stack(
        fit: StackFit.expand,
        children: [
          const Positioned.fill(child: HyperspaceStars()),
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(gradient: AegisColors.ambientGlow),
            ),
          ),
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    Colors.black.withValues(alpha: 0.0),
                    Colors.black.withValues(alpha: 0.55),
                  ],
                ),
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: EdgeInsets.fromLTRB(24, media.size.height * 0.10, 24, 28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Center(child: AegisLogo(size: 112)),
                  const SizedBox(height: 28),
                  Text(
                    'AegisDial',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.displaySmall?.copyWith(
                          fontWeight: FontWeight.w700,
                          letterSpacing: -0.5,
                        ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    'Prevent the call. Recover from the scam.',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          color: AegisColors.textSecondary,
                          fontWeight: FontWeight.w400,
                        ),
                  ),
                  const Spacer(),
                  _PillarRow(
                    items: const [
                      _Pillar(
                        icon: Icons.shield_moon_outlined,
                        label: 'Live Shield',
                        sub: 'Scam-call coach',
                      ),
                      _Pillar(
                        icon: Icons.healing_outlined,
                        label: 'Recovery',
                        sub: 'First-15-minutes guide',
                      ),
                      _Pillar(
                        icon: Icons.family_restroom_outlined,
                        label: 'Family',
                        sub: 'Guardian + safe-word',
                      ),
                    ],
                  ),
                  const SizedBox(height: 32),
                  // Pre-auth demo CTA. Lets a skeptical TestFlight user
                  // (or App Store reviewer, or investor) see the
                  // headline feature working in 60 seconds without
                  // committing to sign-up. The Live Shield demo runs
                  // entirely client-side: liveShield.start() returns
                  // null without a bearer, the screen falls back to
                  // scripted scores + the new client-seeded v4
                  // counter-script + tell-tales surfaces. No account
                  // created, no PII collected, no backend session.
                  OutlinedButton.icon(
                    onPressed: () {
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) => const LiveShieldActiveScreen(),
                        ),
                      );
                    },
                    icon: const Icon(
                      Icons.play_circle_outline_rounded,
                      size: 18,
                      color: AegisColors.turquoise,
                    ),
                    label: const Text(
                      'See it work — 60-second demo',
                      style: TextStyle(
                        color: AegisColors.turquoise,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    style: OutlinedButton.styleFrom(
                      side: BorderSide(
                        color: AegisColors.turquoise.withValues(alpha: 0.6),
                        width: 0.8,
                      ),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  ElevatedButton(
                    onPressed: () {
                      Navigator.of(context).push(
                        PageRouteBuilder(
                          transitionDuration: const Duration(milliseconds: 600),
                          pageBuilder: (context, anim, secondary) =>
                              const AuthScreen(initialSignUp: true),
                          transitionsBuilder:
                              (context, anim, secondary, child) {
                            return FadeTransition(opacity: anim, child: child);
                          },
                        ),
                      );
                    },
                    child: const Text('Get Started'),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: () {
                      Navigator.of(context).push(
                        PageRouteBuilder(
                          transitionDuration: const Duration(milliseconds: 600),
                          pageBuilder: (context, anim, secondary) =>
                              const AuthScreen(),
                          transitionsBuilder:
                              (context, anim, secondary, child) {
                            return FadeTransition(opacity: anim, child: child);
                          },
                        ),
                      );
                    },
                    child: const Text('I already have an account'),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Built by 47 Industries',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: AegisColors.textTertiary,
                          letterSpacing: 1.4,
                        ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Pillar {
  final IconData icon;
  final String label;
  final String sub;
  const _Pillar({required this.icon, required this.label, required this.sub});
}

class _PillarRow extends StatelessWidget {
  final List<_Pillar> items;
  const _PillarRow({required this.items});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: items.map((p) {
        return Expanded(
          child: Container(
            margin: const EdgeInsets.symmetric(horizontal: 4),
            padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 8),
            decoration: BoxDecoration(
              color: AegisColors.surface.withValues(alpha: 0.55),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AegisColors.border, width: 0.8),
            ),
            child: Column(
              children: [
                Icon(p.icon, color: AegisColors.turquoise, size: 22),
                const SizedBox(height: 8),
                Text(
                  p.label,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: AegisColors.textPrimary,
                      ),
                ),
                const SizedBox(height: 2),
                Text(
                  p.sub,
                  textAlign: TextAlign.center,
                  maxLines: 2,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        color: AegisColors.textTertiary,
                      ),
                ),
              ],
            ),
          ),
        );
      }).toList(),
    );
  }
}
