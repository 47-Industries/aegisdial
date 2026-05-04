import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../theme/app_theme.dart';
import '../widgets/hyperspace_stars.dart';
import 'home_shell.dart';

const _kTutorialSeenKey = 'tutorial_seen_v1';

Future<bool> tutorialSeen() async {
  final p = await SharedPreferences.getInstance();
  return p.getBool(_kTutorialSeenKey) ?? false;
}

Future<void> markTutorialSeen() async {
  final p = await SharedPreferences.getInstance();
  await p.setBool(_kTutorialSeenKey, true);
}

class _Slide {
  final IconData icon;
  final Color color;
  final String title;
  final String body;
  final String tag;
  const _Slide({
    required this.icon,
    required this.color,
    required this.title,
    required this.body,
    required this.tag,
  });
}

const _kSlides = [
  _Slide(
    icon: Icons.shield_rounded,
    color: AegisColors.turquoise,
    tag: 'LIVE SHIELD',
    title: 'Scores calls\nbefore they ring.',
    body: 'AegisDial analyzes every incoming call in real time. If it looks like a scammer, you know before you pick up — one tap to disconnect.',
  ),
  _Slide(
    icon: Icons.sms_failed_outlined,
    color: AegisColors.turquoise,
    tag: 'SMS FILTER',
    title: 'Verdict in\n2 seconds.',
    body: 'Paste any suspicious text. AegisDial cross-references sender flags, language patterns, and known scam templates — and shows you the evidence.',
  ),
  _Slide(
    icon: Icons.fingerprint_rounded,
    color: AegisColors.blueAccent,
    tag: 'BREACH MONITOR',
    title: 'See where your\ndata leaked.',
    body: 'Your email and phone number checked against real breach databases. Know exactly which source exposed you — not just a score.',
  ),
  _Slide(
    icon: Icons.support_agent_rounded,
    color: AegisColors.blueAccent,
    tag: 'RECOVERY CONCIERGE',
    title: 'AI guides your\nfull recovery.',
    body: 'If you\'re ever targeted, our AI Companion walks you through every step — calling your bank, freezing credit at all three bureaus, filing the FTC report. 24/7.',
  ),
];

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen>
    with TickerProviderStateMixin {
  final _controller = PageController();
  int _page = 0;

  late final AnimationController _iconPulse;

  @override
  void initState() {
    super.initState();
    _iconPulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2000),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    _iconPulse.dispose();
    super.dispose();
  }

  void _next() {
    if (_page < _kSlides.length - 1) {
      _controller.nextPage(
        duration: const Duration(milliseconds: 380),
        curve: Curves.easeOutCubic,
      );
    } else {
      _finish();
    }
  }

  Future<void> _finish() async {
    await markTutorialSeen();
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      PageRouteBuilder(
        transitionDuration: const Duration(milliseconds: 500),
        pageBuilder: (_, __, ___) => const HomeShell(),
        transitionsBuilder: (_, anim, __, child) =>
            FadeTransition(opacity: anim, child: child),
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
            child: HyperspaceStars(starCount: 140, speed: 0.6),
          ),
          SafeArea(
            child: Column(
              children: [
                // Skip
                Align(
                  alignment: Alignment.topRight,
                  child: TextButton(
                    onPressed: _finish,
                    child: Text(
                      'Skip',
                      style: TextStyle(
                        color: Colors.white.withValues(alpha: 0.4),
                        fontSize: 14,
                      ),
                    ),
                  ),
                ),
                // Pages
                Expanded(
                  child: PageView.builder(
                    controller: _controller,
                    itemCount: _kSlides.length,
                    onPageChanged: (i) => setState(() => _page = i),
                    itemBuilder: (_, i) => _SlidePage(
                      slide: _kSlides[i],
                      pulse: _iconPulse,
                    ),
                  ),
                ),
                // Dots + button
                Padding(
                  padding: const EdgeInsets.fromLTRB(28, 0, 28, 36),
                  child: Column(
                    children: [
                      // Progress dots
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: List.generate(_kSlides.length, (i) {
                          final active = i == _page;
                          return AnimatedContainer(
                            duration: const Duration(milliseconds: 280),
                            margin: const EdgeInsets.symmetric(horizontal: 4),
                            width: active ? 24 : 6,
                            height: 6,
                            decoration: BoxDecoration(
                              color: active
                                  ? _kSlides[_page].color
                                  : Colors.white.withValues(alpha: 0.2),
                              borderRadius: BorderRadius.circular(3),
                            ),
                          );
                        }),
                      ),
                      const SizedBox(height: 24),
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton(
                          onPressed: _next,
                          style: ElevatedButton.styleFrom(
                            backgroundColor: _kSlides[_page].color,
                            foregroundColor: Colors.black,
                            padding: const EdgeInsets.symmetric(vertical: 16),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(16),
                            ),
                            elevation: 0,
                          ),
                          child: Text(
                            _page == _kSlides.length - 1
                                ? 'Get started'
                                : 'Next',
                            style: const TextStyle(
                              fontWeight: FontWeight.w700,
                              fontSize: 16,
                              letterSpacing: 0.3,
                            ),
                          ),
                        ),
                      ),
                    ],
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

class _SlidePage extends StatelessWidget {
  final _Slide slide;
  final AnimationController pulse;
  const _SlidePage({required this.slide, required this.pulse});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 32),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          // Glowing icon circle
          AnimatedBuilder(
            animation: pulse,
            builder: (_, __) => Container(
              width: 120,
              height: 120,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: slide.color.withValues(alpha: 0.1),
                boxShadow: [
                  BoxShadow(
                    color: slide.color.withValues(
                        alpha: 0.15 + 0.12 * pulse.value),
                    blurRadius: 40 + 20 * pulse.value,
                    spreadRadius: 4,
                  ),
                ],
                border: Border.all(
                  color: slide.color.withValues(alpha: 0.3 + 0.15 * pulse.value),
                  width: 1.2,
                ),
              ),
              child: Icon(slide.icon, color: slide.color, size: 48),
            ),
          ),
          const SizedBox(height: 36),
          // Tag
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
            decoration: BoxDecoration(
              color: slide.color.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(20),
              border: Border.all(
                color: slide.color.withValues(alpha: 0.3),
                width: 0.8,
              ),
            ),
            child: Text(
              slide.tag,
              style: TextStyle(
                color: slide.color,
                fontSize: 11,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.8,
              ),
            ),
          ),
          const SizedBox(height: 20),
          // Title
          Text(
            slide.title,
            style: tt.headlineMedium?.copyWith(
              fontWeight: FontWeight.w700,
              height: 1.15,
              color: Colors.white,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 16),
          // Body
          Text(
            slide.body,
            style: tt.bodyMedium?.copyWith(
              color: Colors.white.withValues(alpha: 0.6),
              height: 1.6,
            ),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}
