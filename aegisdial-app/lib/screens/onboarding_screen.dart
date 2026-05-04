import 'dart:async';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../theme/app_theme.dart';
import '../services/auth_service.dart';
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

// ── Main screen ───────────────────────────────────────────────────────────────

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen>
    with TickerProviderStateMixin {
  final _pageCtrl = PageController();
  int _page = 0;

  late final AnimationController _glow;

  @override
  void initState() {
    super.initState();
    _glow = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2400),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _pageCtrl.dispose();
    _glow.dispose();
    super.dispose();
  }

  void _next() {
    if (_page < 3) {
      _pageCtrl.nextPage(
        duration: const Duration(milliseconds: 400),
        curve: Curves.easeOutCubic,
      );
    } else {
      _finish();
    }
  }

  Future<void> _finish() async {
    if (auth.session?.userId != 'guest') await markTutorialSeen();
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

  static const _colors = [
    AegisColors.turquoise,
    AegisColors.turquoise,
    AegisColors.blueAccent,
    AegisColors.blueAccent,
  ];

  @override
  Widget build(BuildContext context) {
    final accent = _colors[_page];
    return Scaffold(
      backgroundColor: AegisColors.background,
      body: Stack(
        fit: StackFit.expand,
        children: [
          const Positioned.fill(
            child: HyperspaceStars(starCount: 100, speed: 0.5),
          ),
          // Ambient glow behind preview
          AnimatedBuilder(
            animation: _glow,
            builder: (_, __) => Positioned(
              top: MediaQuery.of(context).size.height * 0.18,
              left: 0,
              right: 0,
              child: Center(
                child: Container(
                  width: 280,
                  height: 280,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: RadialGradient(
                      colors: [
                        accent.withValues(alpha: 0.07 + 0.04 * _glow.value),
                        Colors.transparent,
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
          SafeArea(
            child: Column(
              children: [
                // Top row
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 4, 16, 0),
                  child: Row(
                    children: [
                      // Step counter
                      Padding(
                        padding: const EdgeInsets.only(left: 20),
                        child: Text(
                          '${_page + 1} of 4',
                          style: TextStyle(
                            color: Colors.white.withValues(alpha: 0.35),
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                      const Spacer(),
                      TextButton(
                        onPressed: _finish,
                        child: Text(
                          'Skip',
                          style: TextStyle(
                            color: Colors.white.withValues(alpha: 0.35),
                            fontSize: 14,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                // Pages
                Expanded(
                  child: PageView(
                    controller: _pageCtrl,
                    onPageChanged: (i) => setState(() => _page = i),
                    children: [
                      _LiveShieldSlide(glow: _glow),
                      _SmsFilterSlide(glow: _glow),
                      _BreachSlide(glow: _glow),
                      _RecoverySlide(glow: _glow),
                    ],
                  ),
                ),
                // Bottom
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 8, 24, 36),
                  child: Column(
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: List.generate(4, (i) {
                          final active = i == _page;
                          return AnimatedContainer(
                            duration: const Duration(milliseconds: 300),
                            margin: const EdgeInsets.symmetric(horizontal: 3),
                            width: active ? 22 : 6,
                            height: 6,
                            decoration: BoxDecoration(
                              color: active
                                  ? accent
                                  : Colors.white.withValues(alpha: 0.18),
                              borderRadius: BorderRadius.circular(3),
                            ),
                          );
                        }),
                      ),
                      const SizedBox(height: 20),
                      SizedBox(
                        width: double.infinity,
                        height: 54,
                        child: ElevatedButton(
                          onPressed: _next,
                          style: ElevatedButton.styleFrom(
                            backgroundColor: accent,
                            foregroundColor: Colors.black,
                            elevation: 0,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(14),
                            ),
                          ),
                          child: Text(
                            _page == 3 ? 'Get started' : 'Next',
                            style: const TextStyle(
                              fontWeight: FontWeight.w700,
                              fontSize: 16,
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

// ── Shared layout wrapper ─────────────────────────────────────────────────────

class _SlideShell extends StatelessWidget {
  final String tag;
  final Color tagColor;
  final String title;
  final String caption;
  final Widget preview;

  const _SlideShell({
    required this.tag,
    required this.tagColor,
    required this.title,
    required this.caption,
    required this.preview,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(height: 12),
          // Tag
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: tagColor.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: tagColor.withValues(alpha: 0.3), width: 0.8),
            ),
            child: Text(
              tag,
              style: TextStyle(
                color: tagColor,
                fontSize: 10,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.6,
              ),
            ),
          ),
          const SizedBox(height: 12),
          // Title
          Text(
            title,
            style: tt.headlineSmall?.copyWith(
              fontWeight: FontWeight.w700,
              height: 1.2,
              color: Colors.white,
            ),
          ),
          const SizedBox(height: 20),
          // Preview
          Expanded(child: preview),
          const SizedBox(height: 16),
          // Caption
          Text(
            caption,
            style: tt.bodySmall?.copyWith(
              color: Colors.white.withValues(alpha: 0.5),
              height: 1.5,
            ),
          ),
          const SizedBox(height: 12),
        ],
      ),
    );
  }
}

// ── Slide 1 — Live Shield ─────────────────────────────────────────────────────

class _LiveShieldSlide extends StatefulWidget {
  final AnimationController glow;
  const _LiveShieldSlide({required this.glow});

  @override
  State<_LiveShieldSlide> createState() => _LiveShieldSlideState();
}

class _LiveShieldSlideState extends State<_LiveShieldSlide> {
  double _score = 0;
  Timer? _t;

  @override
  void initState() {
    super.initState();
    Future.delayed(const Duration(milliseconds: 600), _animate);
  }

  void _animate() {
    _t = Timer.periodic(const Duration(milliseconds: 30), (t) {
      if (!mounted) { t.cancel(); return; }
      setState(() => _score = (_score + 0.018).clamp(0, 0.94));
      if (_score >= 0.94) t.cancel();
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  Color get _riskColor {
    if (_score < 0.4) return AegisColors.success;
    if (_score < 0.7) return AegisColors.warning;
    return AegisColors.danger;
  }

  String get _riskLabel {
    if (_score < 0.4) return 'LOW RISK';
    if (_score < 0.7) return 'MEDIUM RISK';
    return 'HIGH RISK';
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return _SlideShell(
      tag: 'LIVE SHIELD',
      tagColor: AegisColors.turquoise,
      title: 'Know before\nyou answer.',
      caption: 'Risk score climbs in real time. One tap ends the call.',
      preview: Center(
        child: Container(
          decoration: BoxDecoration(
            color: AegisColors.surface,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: AegisColors.border, width: 0.8),
            boxShadow: [
              BoxShadow(
                color: _riskColor.withValues(alpha: 0.12),
                blurRadius: 24,
                spreadRadius: 2,
              ),
            ],
          ),
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Caller row
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: AegisColors.danger.withValues(alpha: 0.12),
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(Icons.phone_rounded, color: AegisColors.danger, size: 20),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('833-456-7890',
                            style: tt.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                        Text('Incoming call',
                            style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary)),
                      ],
                    ),
                  ),
                  AnimatedBuilder(
                    animation: widget.glow,
                    builder: (_, __) => Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                      decoration: BoxDecoration(
                        color: _riskColor.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: _riskColor.withValues(alpha: 0.4)),
                      ),
                      child: Text(
                        _riskLabel,
                        style: TextStyle(
                          color: _riskColor,
                          fontSize: 10,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.2,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              // Score bar
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: _score,
                  minHeight: 6,
                  backgroundColor: AegisColors.surfaceElevated,
                  valueColor: AlwaysStoppedAnimation(_riskColor),
                ),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Text('Fraud score',
                      style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary)),
                  const Spacer(),
                  Text('${(_score * 100).toInt()}%',
                      style: tt.labelSmall?.copyWith(
                          color: _riskColor, fontWeight: FontWeight.w700)),
                ],
              ),
              const SizedBox(height: 14),
              // Evidence
              _EvidenceRow(
                icon: Icons.warning_amber_rounded,
                color: AegisColors.danger,
                text: 'Chase impersonation ring — flagged 312×',
              ),
              const SizedBox(height: 6),
              _EvidenceRow(
                icon: Icons.phone_forwarded_rounded,
                color: AegisColors.warning,
                text: 'Spoofed bank toll-free prefix',
              ),
              const SizedBox(height: 16),
              // Hang up button
              SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: null,
                  icon: const Icon(Icons.call_end_rounded, size: 18),
                  label: const Text('Critical hang up'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AegisColors.danger,
                    foregroundColor: Colors.white,
                    disabledBackgroundColor: AegisColors.danger.withValues(alpha: 0.7),
                    disabledForegroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Slide 2 — SMS Filter ──────────────────────────────────────────────────────

class _SmsFilterSlide extends StatefulWidget {
  final AnimationController glow;
  const _SmsFilterSlide({required this.glow});

  @override
  State<_SmsFilterSlide> createState() => _SmsFilterSlideState();
}

class _SmsFilterSlideState extends State<_SmsFilterSlide>
    with SingleTickerProviderStateMixin {
  bool _revealed = false;
  late final AnimationController _reveal;
  late final Animation<double> _fade;

  @override
  void initState() {
    super.initState();
    _reveal = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 500),
    );
    _fade = CurvedAnimation(parent: _reveal, curve: Curves.easeOut);
    Future.delayed(const Duration(milliseconds: 900), () {
      if (!mounted) return;
      setState(() => _revealed = true);
      _reveal.forward();
    });
  }

  @override
  void dispose() {
    _reveal.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return _SlideShell(
      tag: 'SMS FILTER',
      tagColor: AegisColors.turquoise,
      title: 'Verdict in\n2 seconds.',
      caption: 'Paste any message. Evidence — not just a score.',
      preview: Center(
        child: Container(
          decoration: BoxDecoration(
            color: AegisColors.surface,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: AegisColors.border, width: 0.8),
          ),
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // SMS bubble
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AegisColors.surfaceElevated,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  '"Chase Fraud Alert: Did you authorize a Zelle of \$1,000 to JOHN DOE? Reply YES/NO."',
                  style: tt.bodySmall?.copyWith(
                    color: AegisColors.textSecondary,
                    height: 1.45,
                    fontStyle: FontStyle.italic,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              // Verdict
              FadeTransition(
                opacity: _fade,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                      decoration: BoxDecoration(
                        color: AegisColors.danger.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(
                            color: AegisColors.danger.withValues(alpha: 0.4)),
                      ),
                      child: Text(
                        '🚨  KNOWN SCAM TEMPLATE',
                        style: TextStyle(
                          color: AegisColors.danger,
                          fontSize: 11,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.8,
                        ),
                      ),
                    ),
                    const SizedBox(height: 10),
                    _EvidenceRow(
                      icon: Icons.flag_rounded,
                      color: AegisColors.danger,
                      text: 'Sender flagged 312× this week',
                    ),
                    const SizedBox(height: 5),
                    _EvidenceRow(
                      icon: Icons.analytics_outlined,
                      color: AegisColors.warning,
                      text: 'Matches 47 Chase imposter reports',
                    ),
                    const SizedBox(height: 5),
                    _EvidenceRow(
                      icon: Icons.policy_outlined,
                      color: AegisColors.turquoise,
                      text: 'Chase never verifies fraud by SMS',
                    ),
                  ],
                ),
              ),
              if (!_revealed)
                const Center(
                  child: Padding(
                    padding: EdgeInsets.symmetric(vertical: 16),
                    child: SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        color: AegisColors.turquoise,
                        strokeWidth: 2,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Slide 3 — Breach Monitor ──────────────────────────────────────────────────

class _BreachSlide extends StatelessWidget {
  final AnimationController glow;
  const _BreachSlide({required this.glow});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return _SlideShell(
      tag: 'BREACH MONITOR',
      tagColor: AegisColors.blueAccent,
      title: 'See exactly\nwhere you leaked.',
      caption: 'Real breach databases. Source, date, and data type — not just "you were breached."',
      preview: Center(
        child: Container(
          decoration: BoxDecoration(
            color: AegisColors.surface,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: AegisColors.border, width: 0.8),
          ),
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Identity row
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(9),
                    decoration: BoxDecoration(
                      color: AegisColors.blueAccent.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Icon(Icons.alternate_email_rounded,
                        color: AegisColors.blueAccent, size: 18),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('j***@gmail.com',
                            style: tt.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                        Text('2 breaches found',
                            style: tt.labelSmall?.copyWith(color: AegisColors.danger)),
                      ],
                    ),
                  ),
                  const Icon(Icons.check_circle_outline,
                      color: AegisColors.success, size: 16),
                ],
              ),
              const SizedBox(height: 14),
              _BreachCard(
                source: 'LinkedIn',
                date: '2024-06',
                types: ['Email', 'Password hash'],
                color: AegisColors.danger,
              ),
              const SizedBox(height: 8),
              _BreachCard(
                source: 'Ticketmaster',
                date: '2024-05',
                types: ['Email', 'Phone', 'Address'],
                color: AegisColors.warning,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BreachCard extends StatelessWidget {
  final String source;
  final String date;
  final List<String> types;
  final Color color;
  const _BreachCard({
    required this.source,
    required this.date,
    required this.types,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.25), width: 0.8),
      ),
      child: Row(
        children: [
          Icon(Icons.cloud_off_rounded, color: color, size: 16),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(source,
                    style: tt.bodySmall?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                Wrap(
                  spacing: 4,
                  children: types
                      .map((t) => Text(t,
                          style: tt.labelSmall
                              ?.copyWith(color: AegisColors.textTertiary)))
                      .toList(),
                ),
              ],
            ),
          ),
          Text(date,
              style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary)),
        ],
      ),
    );
  }
}

// ── Slide 4 — Recovery Concierge ─────────────────────────────────────────────

class _RecoverySlide extends StatefulWidget {
  final AnimationController glow;
  const _RecoverySlide({required this.glow});

  @override
  State<_RecoverySlide> createState() => _RecoverySlideState();
}

class _RecoverySlideState extends State<_RecoverySlide>
    with SingleTickerProviderStateMixin {
  late final AnimationController _msg;
  late final Animation<double> _fade;

  @override
  void initState() {
    super.initState();
    _msg = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
    );
    _fade = CurvedAnimation(parent: _msg, curve: Curves.easeOut);
    Future.delayed(const Duration(milliseconds: 700), () {
      if (mounted) _msg.forward();
    });
  }

  @override
  void dispose() {
    _msg.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return _SlideShell(
      tag: 'RECOVERY CONCIERGE',
      tagColor: AegisColors.blueAccent,
      title: 'AI guides your\nrecovery. Now.',
      caption: 'Bank call, credit freeze, FTC report — all in one session, 24/7.',
      preview: Center(
        child: Container(
          decoration: BoxDecoration(
            color: AegisColors.surface,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: AegisColors.border, width: 0.8),
          ),
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // AI header
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: AegisColors.blueAccent.withValues(alpha: 0.14),
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(Icons.support_agent_rounded,
                        color: AegisColors.blueAccent, size: 18),
                  ),
                  const SizedBox(width: 10),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('AI Companion',
                          style: tt.bodyMedium?.copyWith(fontWeight: FontWeight.w700)),
                      Row(children: [
                        Container(
                          width: 6, height: 6,
                          margin: const EdgeInsets.only(right: 5),
                          decoration: const BoxDecoration(
                            shape: BoxShape.circle,
                            color: AegisColors.success,
                          ),
                        ),
                        Text('Online · responding now',
                            style: tt.labelSmall?.copyWith(color: AegisColors.success)),
                      ]),
                    ],
                  ),
                ],
              ),
              const SizedBox(height: 14),
              // Chat bubble
              FadeTransition(
                opacity: _fade,
                child: Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AegisColors.blueAccent.withValues(alpha: 0.1),
                    borderRadius: const BorderRadius.only(
                      topLeft: Radius.circular(4),
                      topRight: Radius.circular(14),
                      bottomLeft: Radius.circular(14),
                      bottomRight: Radius.circular(14),
                    ),
                    border: Border.all(
                        color: AegisColors.blueAccent.withValues(alpha: 0.25)),
                  ),
                  child: Text(
                    "I'm here. We'll do three things in the next 15 minutes: call Chase fraud, freeze your credit at all three bureaus, and file your FTC complaint.",
                    style: tt.bodySmall?.copyWith(
                      color: Colors.white.withValues(alpha: 0.85),
                      height: 1.5,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              // Action items
              _ActionItem(
                icon: Icons.phone_in_talk_rounded,
                color: AegisColors.turquoise,
                label: 'Call Chase Fraud · 1-800-935-9935',
              ),
              const SizedBox(height: 6),
              _ActionItem(
                icon: Icons.credit_card_off_rounded,
                color: AegisColors.blueAccent,
                label: 'Freeze credit — Equifax, Experian, TransUnion',
              ),
              const SizedBox(height: 6),
              _ActionItem(
                icon: Icons.gavel_rounded,
                color: AegisColors.warning,
                label: 'File FTC report · pre-filled draft ready',
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ActionItem extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String label;
  const _ActionItem({required this.icon, required this.color, required this.label});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Row(
      children: [
        Icon(icon, color: color, size: 15),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            label,
            style: tt.labelSmall?.copyWith(color: AegisColors.textSecondary),
          ),
        ),
      ],
    );
  }
}

// ── Shared evidence row ───────────────────────────────────────────────────────

class _EvidenceRow extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String text;
  const _EvidenceRow({required this.icon, required this.color, required this.text});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: Icon(icon, color: color, size: 13),
        ),
        const SizedBox(width: 7),
        Expanded(
          child: Text(
            text,
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textSecondary,
              height: 1.4,
            ),
          ),
        ),
      ],
    );
  }
}
