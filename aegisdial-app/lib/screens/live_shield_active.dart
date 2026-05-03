import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme/app_theme.dart';
import '../widgets/hyperspace_stars.dart';

class LiveShieldActiveScreen extends StatefulWidget {
  const LiveShieldActiveScreen({super.key});

  @override
  State<LiveShieldActiveScreen> createState() => _LiveShieldActiveScreenState();
}

// Demo transcript lines (IRS impersonation scam).
const _kDemoLines = [
  'Hello, this is Agent Williams from the Internal Revenue Service.',
  'Your Social Security number has been suspended due to suspicious activity.',
  'A federal arrest warrant has been issued in your name.',
  'To avoid immediate arrest, press 1 or stay on the line.',
  'You owe \$4,280 in back taxes. Payment must be made via gift cards today.',
];

const _kDemoNumber = '+1 (877) 234-5678';

enum _DemoPhase { idle, ringing, transcribing, verdict, done }

class _DemoCall {
  final List<String> lines;
  final int score;
  _DemoCall(this.lines, this.score);
}

class _LiveShieldActiveScreenState extends State<LiveShieldActiveScreen>
    with TickerProviderStateMixin {
  late final AnimationController _pulse;
  late final AnimationController _wave;

  _DemoPhase _demoPhase = _DemoPhase.idle;
  final List<String> _transcript = [];
  int _fraudScore = 0;
  Timer? _demoTimer;
  final List<_DemoCall> _callHistory = [];

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
  }

  @override
  void dispose() {
    _pulse.dispose();
    _wave.dispose();
    _demoTimer?.cancel();
    super.dispose();
  }

  Future<void> _runDemo() async {
    if (_demoPhase != _DemoPhase.idle && _demoPhase != _DemoPhase.done) return;
    setState(() {
      _demoPhase = _DemoPhase.ringing;
      _transcript.clear();
      _fraudScore = 0;
    });
    HapticFeedback.heavyImpact();

    // Ring phase
    await Future.delayed(const Duration(milliseconds: 1800));
    if (!mounted) return;
    setState(() => _demoPhase = _DemoPhase.transcribing);

    // Stream transcript lines with delays
    final delays = [0, 1400, 1600, 1500, 1700];
    for (int i = 0; i < _kDemoLines.length; i++) {
      await Future.delayed(Duration(milliseconds: delays[i]));
      if (!mounted) return;
      setState(() {
        _transcript.add(_kDemoLines[i]);
        // Score ramps: 12 → 31 → 58 → 77 → 94
        _fraudScore = [12, 31, 58, 77, 94][i];
      });
      HapticFeedback.selectionClick();
    }

    await Future.delayed(const Duration(milliseconds: 600));
    if (!mounted) return;
    setState(() => _demoPhase = _DemoPhase.verdict);
    HapticFeedback.heavyImpact();
  }

  void _dismissDemo() {
    if (_demoPhase == _DemoPhase.verdict) {
      setState(() {
        _callHistory.insert(0, _DemoCall(List.from(_transcript), _fraudScore));
        _demoPhase = _DemoPhase.done;
        _transcript.clear();
        _fraudScore = 0;
      });
      Future.delayed(const Duration(milliseconds: 400), () {
        if (mounted) setState(() => _demoPhase = _DemoPhase.idle);
      });
    }
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
            child: ListView(
              padding: const EdgeInsets.only(top: 8, bottom: 28),
              children: [
                _StatusHeader(),
                const SizedBox(height: 16),
                SizedBox(
                  height: 240,
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
                // Active call / demo panel
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 300),
                  child: _demoPhase == _DemoPhase.ringing
                      ? _RingingCard(number: _kDemoNumber, key: const ValueKey('ring'))
                      : _demoPhase == _DemoPhase.transcribing || _demoPhase == _DemoPhase.verdict
                          ? _LiveCallCard(
                              key: const ValueKey('live'),
                              number: _kDemoNumber,
                              lines: _transcript,
                              score: _fraudScore,
                              verdict: _demoPhase == _DemoPhase.verdict,
                              onBlock: _dismissDemo,
                              onAnswer: _dismissDemo,
                            )
                          : _IdleCard(key: const ValueKey('idle'), onRunDemo: _runDemo),
                ),
                const SizedBox(height: 22),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: Text(
                    'CALL HISTORY',
                    style: tt.labelSmall?.copyWith(
                      color: AegisColors.textTertiary,
                      letterSpacing: 1.6,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                if (_callHistory.isEmpty)
                  Container(
                    margin: const EdgeInsets.symmetric(horizontal: 20),
                    padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 16),
                    decoration: BoxDecoration(
                      color: AegisColors.surface.withValues(alpha: 0.55),
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: AegisColors.border, width: 0.6),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.history_rounded,
                            color: AegisColors.textTertiary, size: 20),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            'Run a demo below to see how AegisDial stops a scam call in real time.',
                            style: tt.bodySmall?.copyWith(
                              color: AegisColors.textTertiary,
                              height: 1.4,
                            ),
                          ),
                        ),
                      ],
                    ),
                  )
                else
                  ..._callHistory.map((c) => _CallHistoryTile(call: c)),
                const SizedBox(height: 14),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: Row(
                    children: [
                      const Icon(
                        Icons.lock_outline_rounded,
                        size: 14,
                        color: AegisColors.textTertiary,
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          'Transcripts never leave your phone. Only the verdict (scam / safe) syncs.',
                          style: tt.labelSmall?.copyWith(
                            color: AegisColors.textTertiary,
                            height: 1.4,
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

class _StatusHeader extends StatelessWidget {
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
                color: AegisColors.turquoise.withValues(alpha: 0.15),
                border: Border.all(color: AegisColors.turquoise, width: 1),
              ),
              child: const Icon(
                Icons.graphic_eq_rounded,
                color: AegisColors.turquoise,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        'Shield is active',
                        style: tt.titleMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: AegisColors.warning.withValues(alpha: 0.18),
                          borderRadius: BorderRadius.circular(5),
                        ),
                        child: const Text(
                          'DEMO',
                          style: TextStyle(
                            color: AegisColors.warning,
                            fontSize: 9,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.8,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'Demo mode — tap "Run demo" to see how Live Shield detects a scam call.',
                    style: tt.bodySmall?.copyWith(
                      color: AegisColors.textTertiary,
                      height: 1.35,
                    ),
                  ),
                ],
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

// ── Demo UI widgets ────────────────────────────────────────────────────────────

class _IdleCard extends StatelessWidget {
  final VoidCallback onRunDemo;
  const _IdleCard({super.key, required this.onRunDemo});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 20),
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Column(
        children: [
          Text(
            'Listening — no active call',
            style: tt.bodyMedium?.copyWith(
              color: AegisColors.textPrimary,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'When a call comes in, the live transcript and verdict appear here.',
            textAlign: TextAlign.center,
            style: tt.bodySmall?.copyWith(
              color: AegisColors.textTertiary,
              height: 1.45,
            ),
          ),
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: onRunDemo,
              icon: const Icon(Icons.play_circle_outline_rounded, size: 17),
              label: const Text('Run demo — see a scam call stopped live'),
              style: OutlinedButton.styleFrom(
                foregroundColor: AegisColors.turquoise,
                side: const BorderSide(color: AegisColors.turquoise, width: 0.8),
                padding: const EdgeInsets.symmetric(vertical: 12),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                textStyle: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RingingCard extends StatefulWidget {
  final String number;
  const _RingingCard({super.key, required this.number});

  @override
  State<_RingingCard> createState() => _RingingCardState();
}

class _RingingCardState extends State<_RingingCard>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ring;

  @override
  void initState() {
    super.initState();
    _ring = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 700),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _ring.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 20),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: AegisColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: AegisColors.warning.withValues(alpha: 0.6),
          width: 1.2,
        ),
      ),
      child: Column(
        children: [
          AnimatedBuilder(
            animation: _ring,
            builder: (_, __) => Icon(
              Icons.phone_in_talk_rounded,
              size: 36,
              color: AegisColors.warning
                  .withValues(alpha: 0.5 + _ring.value * 0.5),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            'Incoming call',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.2,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            widget.number,
            style: tt.titleMedium?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              AnimatedBuilder(
                animation: _ring,
                builder: (_, __) => Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: AegisColors.warning
                        .withValues(alpha: 0.4 + _ring.value * 0.6),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Text(
                'Analyzing caller…',
                style: tt.labelSmall?.copyWith(
                  color: AegisColors.warning,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _LiveCallCard extends StatelessWidget {
  final String number;
  final List<String> lines;
  final int score;
  final bool verdict;
  final VoidCallback onBlock;
  final VoidCallback onAnswer;

  const _LiveCallCard({
    super.key,
    required this.number,
    required this.lines,
    required this.score,
    required this.verdict,
    required this.onBlock,
    required this.onAnswer,
  });

  Color get _scoreColor => score >= 70
      ? AegisColors.danger
      : score >= 40
          ? AegisColors.warning
          : AegisColors.success;

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 20),
      decoration: BoxDecoration(
        color: AegisColors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: verdict
              ? AegisColors.danger.withValues(alpha: 0.8)
              : AegisColors.border,
          width: verdict ? 1.5 : 0.6,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
            child: Row(
              children: [
                const Icon(Icons.phone_in_talk_rounded,
                    size: 16, color: AegisColors.turquoise),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    number,
                    style: tt.bodyMedium
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                ),
                // Fraud score badge
                Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: _scoreColor.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(
                    '$score% fraud',
                    style: TextStyle(
                      color: _scoreColor,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
          ),
          // Transcript
          Container(
            margin: const EdgeInsets.symmetric(horizontal: 12),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AegisColors.background.withValues(alpha: 0.6),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'LIVE TRANSCRIPT',
                  style: tt.labelSmall?.copyWith(
                    color: AegisColors.textTertiary,
                    letterSpacing: 1.2,
                    fontSize: 9,
                  ),
                ),
                const SizedBox(height: 6),
                ...lines.map((l) => Padding(
                      padding: const EdgeInsets.only(bottom: 5),
                      child: Text(
                        '"$l"',
                        style: tt.bodySmall?.copyWith(
                          color: AegisColors.textSecondary,
                          height: 1.4,
                          fontStyle: FontStyle.italic,
                        ),
                      ),
                    )),
              ],
            ),
          ),
          const SizedBox(height: 12),
          // Verdict banner
          if (verdict)
            Container(
              margin: const EdgeInsets.symmetric(horizontal: 12),
              padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
              decoration: BoxDecoration(
                color: AegisColors.danger.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: AegisColors.danger.withValues(alpha: 0.5),
                  width: 0.8,
                ),
              ),
              child: Row(
                children: [
                  const Icon(Icons.warning_amber_rounded,
                      color: AegisColors.danger, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'SCAM DETECTED',
                          style: TextStyle(
                            color: AegisColors.danger,
                            fontWeight: FontWeight.w800,
                            fontSize: 13,
                            letterSpacing: 0.8,
                          ),
                        ),
                        Text(
                          'IRS impersonation · $score% confidence',
                          style: tt.labelSmall?.copyWith(
                            color: AegisColors.danger.withValues(alpha: 0.8),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          // Action buttons
          if (verdict) ...[
            const SizedBox(height: 12),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 14),
              child: Row(
                children: [
                  Expanded(
                    child: ElevatedButton.icon(
                      onPressed: onBlock,
                      icon: const Icon(Icons.block_rounded, size: 16),
                      label: const Text('Block call'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AegisColors.danger,
                        foregroundColor: Colors.white,
                        padding:
                            const EdgeInsets.symmetric(vertical: 12),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton(
                      onPressed: onAnswer,
                      style: OutlinedButton.styleFrom(
                        foregroundColor: AegisColors.textSecondary,
                        side: const BorderSide(
                            color: AegisColors.border, width: 0.8),
                        padding:
                            const EdgeInsets.symmetric(vertical: 12),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                      child: const Text('Answer anyway'),
                    ),
                  ),
                ],
              ),
            ),
          ] else
            const SizedBox(height: 14),
        ],
      ),
    );
  }
}

class _CallHistoryTile extends StatelessWidget {
  final _DemoCall call;
  const _CallHistoryTile({required this.call});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.fromLTRB(20, 0, 20, 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: AegisColors.danger.withValues(alpha: 0.3),
          width: 0.6,
        ),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(7),
            decoration: BoxDecoration(
              color: AegisColors.danger.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Icon(Icons.block_rounded,
                color: AegisColors.danger, size: 16),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '$_kDemoNumber · BLOCKED',
                  style: tt.bodySmall?.copyWith(fontWeight: FontWeight.w600),
                ),
                Text(
                  'IRS impersonation · ${call.score}% fraud score',
                  style: tt.labelSmall
                      ?.copyWith(color: AegisColors.textTertiary),
                ),
              ],
            ),
          ),
          Container(
            padding:
                const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: AegisColors.danger.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(
              '${call.score}%',
              style: TextStyle(
                color: AegisColors.danger,
                fontSize: 11,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
