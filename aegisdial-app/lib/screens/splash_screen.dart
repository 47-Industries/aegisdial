import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../services/auth_service.dart';
import '../theme/app_theme.dart';
import '../widgets/hyperspace_stars.dart';
import 'welcome_screen.dart';
import 'home_shell.dart';
import 'onboarding_screen.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with TickerProviderStateMixin {
  late final AnimationController _intro;
  late final AnimationController _pulse;

  late final Animation<double> _logoScale;
  late final Animation<double> _logoOpacity;
  late final Animation<double> _ringSweep;
  late final Animation<double> _titleOpacity;
  late final Animation<Offset> _titleSlide;

  @override
  void initState() {
    super.initState();

    _intro = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2200),
    );
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1600),
    )..repeat();

    _logoScale = TweenSequence<double>([
      TweenSequenceItem(
        tween: Tween(begin: 0.4, end: 1.08)
            .chain(CurveTween(curve: Curves.easeOutBack)),
        weight: 60,
      ),
      TweenSequenceItem(
        tween: Tween(begin: 1.08, end: 1.0)
            .chain(CurveTween(curve: Curves.easeOut)),
        weight: 40,
      ),
    ]).animate(_intro);

    _logoOpacity = CurvedAnimation(
      parent: _intro,
      curve: const Interval(0.0, 0.35, curve: Curves.easeOut),
    );

    _ringSweep = CurvedAnimation(
      parent: _intro,
      curve: const Interval(0.25, 0.85, curve: Curves.easeOutCubic),
    );

    _titleOpacity = CurvedAnimation(
      parent: _intro,
      curve: const Interval(0.55, 1.0, curve: Curves.easeOut),
    );
    _titleSlide = Tween<Offset>(
      begin: const Offset(0, 0.4),
      end: Offset.zero,
    ).animate(CurvedAnimation(
      parent: _intro,
      curve: const Interval(0.55, 1.0, curve: Curves.easeOutCubic),
    ));

    _intro.forward();
    WidgetsBinding.instance.addPostFrameCallback((_) => _route());
  }

  @override
  void dispose() {
    _intro.dispose();
    _pulse.dispose();
    super.dispose();
  }

  Future<void> _route() async {
    // Short delay so the hyperspace warp reads as intentional brand
    // motion, not a frozen cold-start. auth.boot() already completed
    // in main() before runApp(), so we're only waiting on visual polish.
    await Future.delayed(const Duration(milliseconds: 900));
    if (!mounted) return;
    Widget next;
    if (auth.isSignedIn) {
      final seen = await tutorialSeen();
      next = seen ? const HomeShell() : const OnboardingScreen();
    } else {
      next = const WelcomeScreen();
    }
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      PageRouteBuilder(
        transitionDuration: const Duration(milliseconds: 700),
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
            child: HyperspaceStars(starCount: 220, speed: 1.4),
          ),
          Positioned.fill(
            child: AnimatedBuilder(
              animation: _intro,
              builder: (_, _) => DecoratedBox(
                decoration: BoxDecoration(
                  gradient: RadialGradient(
                    center: Alignment.center,
                    radius: 0.95,
                    colors: [
                      AegisColors.turquoise
                          .withValues(alpha: 0.28 * _logoOpacity.value),
                      Colors.transparent,
                    ],
                  ),
                ),
              ),
            ),
          ),
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox(
                  width: 240,
                  height: 240,
                  child: AnimatedBuilder(
                    animation: Listenable.merge([_intro, _pulse]),
                    builder: (_, _) {
                      return Stack(
                        alignment: Alignment.center,
                        children: [
                          CustomPaint(
                            size: const Size(240, 240),
                            painter: _SonarPainter(
                              sweep: _ringSweep.value,
                              pulse: _pulse.value,
                            ),
                          ),
                          Opacity(
                            opacity: _logoOpacity.value,
                            child: Transform.scale(
                              scale: _logoScale.value,
                              child: Container(
                                width: 132,
                                height: 132,
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  boxShadow: [
                                    BoxShadow(
                                      color: AegisColors.turquoise
                                          .withValues(alpha: 0.55),
                                      blurRadius: 60,
                                      spreadRadius: 6,
                                    ),
                                  ],
                                ),
                                child: ClipOval(
                                  child: Image.asset(
                                    'assets/icon/icon.png',
                                    fit: BoxFit.cover,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ],
                      );
                    },
                  ),
                ),
                const SizedBox(height: 36),
                AnimatedBuilder(
                  animation: _intro,
                  builder: (_, _) => Opacity(
                    opacity: _titleOpacity.value,
                    child: SlideTransition(
                      position: _titleSlide,
                      child: Column(
                        children: [
                          ShaderMask(
                            shaderCallback: (bounds) => const LinearGradient(
                              colors: [
                                Colors.white,
                                Color(0xFFB8FFD9),
                              ],
                            ).createShader(bounds),
                            child: const Text(
                              'AegisDial',
                              style: TextStyle(
                                fontSize: 38,
                                fontWeight: FontWeight.w700,
                                letterSpacing: 1.2,
                                color: Colors.white,
                              ),
                            ),
                          ),
                          const SizedBox(height: 10),
                          Text(
                            'YOUR CALL SHIELD',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              letterSpacing: 4,
                              color: Colors.white.withValues(alpha: 0.55),
                            ),
                          ),
                        ],
                      ),
                    ),
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

class _SonarPainter extends CustomPainter {
  final double sweep;
  final double pulse;

  _SonarPainter({required this.sweep, required this.pulse});

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final maxRadius = size.width / 2;

    for (var i = 0; i < 3; i++) {
      final phase = (pulse + i / 3) % 1.0;
      final r = maxRadius * (0.35 + phase * 0.65);
      final alpha = (1.0 - phase) * 0.45 * sweep;
      if (alpha <= 0) continue;
      canvas.drawCircle(
        center,
        r,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5
          ..color = AegisColors.turquoise.withValues(alpha: alpha),
      );
    }

    final fixedRadius = maxRadius * (0.55 + 0.45 * sweep);
    canvas.drawCircle(
      center,
      fixedRadius,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = Colors.white.withValues(alpha: 0.08 * sweep),
    );

    final tickPaint = Paint()
      ..color = AegisColors.turquoise.withValues(alpha: 0.7 * sweep)
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round;
    for (var i = 0; i < 12; i++) {
      final angle = (i / 12) * 2 * math.pi;
      final inner = Offset(
        center.dx + math.cos(angle) * (fixedRadius - 6),
        center.dy + math.sin(angle) * (fixedRadius - 6),
      );
      final outer = Offset(
        center.dx + math.cos(angle) * fixedRadius,
        center.dy + math.sin(angle) * fixedRadius,
      );
      canvas.drawLine(inner, outer, tickPaint);
    }
  }

  @override
  bool shouldRepaint(covariant _SonarPainter old) =>
      old.sweep != sweep || old.pulse != pulse;
}
