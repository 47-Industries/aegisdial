import 'package:flutter/material.dart';
import '../services/auth_service.dart';
import '../theme/app_theme.dart';
import '../widgets/aegis_logo.dart';
import '../widgets/hyperspace_stars.dart';
import 'welcome_screen.dart';
import 'home_shell.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _route());
  }

  Future<void> _route() async {
    await Future.delayed(const Duration(milliseconds: 900));
    if (!mounted) return;
    final next = auth.isSignedIn
        ? const HomeShell()
        : (auth.hasOnboarded ? const WelcomeScreen() : const WelcomeScreen());
    Navigator.of(context).pushReplacement(
      PageRouteBuilder(
        transitionDuration: const Duration(milliseconds: 600),
        pageBuilder: (context, anim, secondary) => next,
        transitionsBuilder: (context, anim, secondary, child) {
          return FadeTransition(opacity: anim, child: child);
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AegisColors.background,
      body: Stack(
        fit: StackFit.expand,
        children: [
          const Positioned.fill(
            child: HyperspaceStars(starCount: 160, speed: 0.8),
          ),
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(gradient: AegisColors.ambientGlow),
            ),
          ),
          const Center(child: AegisLogo(size: 120)),
        ],
      ),
    );
  }
}
