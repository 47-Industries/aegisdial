import 'dart:math';
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/hyperspace_stars.dart';

class LiveShieldActiveScreen extends StatefulWidget {
  const LiveShieldActiveScreen({super.key});

  @override
  State<LiveShieldActiveScreen> createState() => _LiveShieldActiveScreenState();
}

class _LiveShieldActiveScreenState extends State<LiveShieldActiveScreen>
    with TickerProviderStateMixin {
  late final AnimationController _pulse;
  late final AnimationController _wave;

  // Mock transcript stream — what real on-device STT would surface.
  final List<_Line> _lines = const [
    _Line('caller', 'Hello, this is Officer Martinez with the IRS.'),
    _Line('caller', 'There is a warrant for your arrest for tax evasion.'),
    _Line('aegis',
        '⚠ Authority impersonation detected. IRS does NOT call about warrants.'),
    _Line('caller',
        'You need to pay \$4,200 in gift cards to avoid prosecution today.'),
    _Line('aegis',
        '⚠ Gift card payment request — 99% scam confidence. Recommend hang up.'),
  ];

  int _shown = 0;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat(reverse: true);
    _wave = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1100),
    )..repeat();
    _scheduleLines();
  }

  void _scheduleLines() async {
    for (int i = 0; i < _lines.length; i++) {
      await Future.delayed(Duration(milliseconds: 1200 + i * 900));
      if (!mounted) return;
      setState(() => _shown = i + 1);
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    _wave.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AegisColors.background,
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.close_rounded, size: 24),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: Text(
          'LIVE SHIELD',
          style: tt.labelMedium?.copyWith(
            color: AegisColors.turquoise,
            letterSpacing: 2.5,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          const Positioned.fill(
            child: HyperspaceStars(starCount: 60, speed: 0.12),
          ),
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    Colors.black.withValues(alpha: 0.3),
                    Colors.black.withValues(alpha: 0.92),
                  ],
                ),
              ),
            ),
          ),
          SafeArea(
            child: Column(
              children: [
                const SizedBox(height: 8),
                _CallHeader(),
                const SizedBox(height: 16),
                Expanded(
                  child: AnimatedBuilder(
                    animation: _pulse,
                    builder: (context, _) {
                      return Center(
                        child: SizedBox(
                          width: 240,
                          height: 240,
                          child: CustomPaint(
                            painter: _PulseRingsPainter(_pulse.value),
                            child: Center(
                              child: Container(
                                width: 110,
                                height: 110,
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  gradient: LinearGradient(
                                    begin: Alignment.topLeft,
                                    end: Alignment.bottomRight,
                                    colors: [
                                      AegisColors.turquoise.withValues(
                                          alpha: 0.4 + _pulse.value * 0.4),
                                      AegisColors.blue,
                                    ],
                                  ),
                                  boxShadow: [
                                    BoxShadow(
                                      color: AegisColors.turquoise
                                          .withValues(alpha: 0.5),
                                      blurRadius: 30,
                                      spreadRadius: 4,
                                    ),
                                  ],
                                ),
                                child: const Icon(
                                  Icons.shield_moon,
                                  color: Colors.black,
                                  size: 50,
                                ),
                              ),
                            ),
                          ),
                        ),
                      );
                    },
                  ),
                ),
                _Waveform(controller: _wave),
                const SizedBox(height: 16),
                Container(
                  margin: const EdgeInsets.symmetric(horizontal: 20),
                  padding: const EdgeInsets.all(16),
                  constraints: const BoxConstraints(maxHeight: 200),
                  decoration: BoxDecoration(
                    color: AegisColors.surface.withValues(alpha: 0.85),
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: AegisColors.border, width: 0.6),
                  ),
                  child: ListView.builder(
                    reverse: true,
                    itemCount: _shown,
                    itemBuilder: (context, idx) {
                      final realIdx = _shown - 1 - idx;
                      final line = _lines[realIdx];
                      final isAegis = line.who == 'aegis';
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              isAegis ? '◆' : '·',
                              style: TextStyle(
                                color: isAegis
                                    ? AegisColors.danger
                                    : AegisColors.textTertiary,
                                fontSize: 14,
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                line.text,
                                style: TextStyle(
                                  color: isAegis
                                      ? AegisColors.danger
                                      : AegisColors.textSecondary,
                                  fontSize: 13.5,
                                  fontWeight: isAegis
                                      ? FontWeight.w600
                                      : FontWeight.w400,
                                  height: 1.45,
                                ),
                              ),
                            ),
                          ],
                        ),
                      );
                    },
                  ),
                ),
                const SizedBox(height: 20),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: Row(
                    children: [
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: () {},
                          icon: const Icon(Icons.pause_rounded),
                          label: const Text('Pause shield'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: ElevatedButton.icon(
                          onPressed: () {},
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AegisColors.danger,
                            foregroundColor: Colors.white,
                          ),
                          icon: const Icon(Icons.call_end_rounded),
                          label: const Text('END CALL'),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 28),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Line {
  final String who;
  final String text;
  const _Line(this.who, this.text);
}

class _CallHeader extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 16),
        decoration: BoxDecoration(
          color: AegisColors.surface.withValues(alpha: 0.7),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AegisColors.border, width: 0.6),
        ),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: AegisColors.danger.withValues(alpha: 0.15),
                border: Border.all(color: AegisColors.danger, width: 1),
              ),
              child: const Icon(
                Icons.warning_amber_rounded,
                color: AegisColors.danger,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '+1 (888) 555-0144',
                    style: tt.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'VoIP · Originating Florida · 0:42',
                    style: tt.bodySmall?.copyWith(
                      color: AegisColors.textTertiary,
                    ),
                  ),
                ],
              ),
            ),
            Container(
              padding:
                  const EdgeInsets.symmetric(vertical: 6, horizontal: 10),
              decoration: BoxDecoration(
                color: AegisColors.danger.withValues(alpha: 0.18),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Text(
                'SCAM',
                style: TextStyle(
                  color: AegisColors.danger,
                  fontSize: 11,
                  letterSpacing: 1.4,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Waveform extends StatelessWidget {
  final AnimationController controller;
  const _Waveform({required this.controller});

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        return SizedBox(
          height: 30,
          child: CustomPaint(
            painter: _WaveformPainter(controller.value),
            size: const Size.fromHeight(30),
          ),
        );
      },
    );
  }
}

class _WaveformPainter extends CustomPainter {
  final double t;
  _WaveformPainter(this.t);

  @override
  void paint(Canvas canvas, Size size) {
    const bars = 48;
    final barW = size.width / (bars * 2);
    final paint = Paint()
      ..color = AegisColors.turquoise
      ..strokeCap = StrokeCap.round
      ..strokeWidth = barW;
    final rng = Random(7);
    for (int i = 0; i < bars; i++) {
      final base = rng.nextDouble();
      final h = ((sin(t * 2 * pi + i * 0.4) + 1) / 2) * 0.6 + base * 0.4;
      final x = (i * 2 + 1) * barW;
      final hh = h * size.height;
      canvas.drawLine(
        Offset(x, size.height / 2 - hh / 2),
        Offset(x, size.height / 2 + hh / 2),
        paint..color = AegisColors.turquoise.withValues(alpha: 0.5 + h * 0.5),
      );
    }
  }

  @override
  bool shouldRepaint(covariant _WaveformPainter old) => old.t != t;
}

class _PulseRingsPainter extends CustomPainter {
  final double t;
  _PulseRingsPainter(this.t);

  @override
  void paint(Canvas canvas, Size size) {
    final c = Offset(size.width / 2, size.height / 2);
    for (int i = 0; i < 3; i++) {
      final phase = ((t + i / 3) % 1.0);
      final r = 55 + phase * 65;
      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.4
        ..color = AegisColors.turquoise.withValues(alpha: (1 - phase) * 0.5);
      canvas.drawCircle(c, r, paint);
    }
  }

  @override
  bool shouldRepaint(covariant _PulseRingsPainter old) => old.t != t;
}
