import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme/app_theme.dart';
import '../widgets/hyperspace_stars.dart';
import '../services/live_shield_service.dart';
import '../widgets/live_shield_consent_v2_sheet.dart';

class LiveShieldActiveScreen extends StatefulWidget {
  const LiveShieldActiveScreen({super.key});

  @override
  State<LiveShieldActiveScreen> createState() => _LiveShieldActiveScreenState();
}

enum _DemoPhase { idle, ringing, transcribing, verdict, done }

class _DemoScenario {
  final String name;
  final String number;
  final List<String> lines;
  final List<int> scores;
  const _DemoScenario({
    required this.name,
    required this.number,
    required this.lines,
    required this.scores,
  });
}

const _kScenarios = [
  _DemoScenario(
    name: 'IRS Impersonation',
    number: '+1 (877) 234-5678',
    lines: [
      'Hello, this is Agent Williams from the Internal Revenue Service.',
      'Your Social Security number has been suspended due to suspicious activity.',
      'A federal arrest warrant has been issued in your name.',
      'To avoid immediate arrest, press 1 or stay on the line.',
      'You owe \$4,280 in back taxes. Payment must be made via gift cards today.',
    ],
    scores: [12, 31, 58, 77, 94],
  ),
  _DemoScenario(
    name: 'Bank Fraud Alert',
    number: '+1 (800) 935-9935',
    lines: [
      'This is the Wells Fargo fraud prevention team.',
      'We detected a \$2,400 unauthorized charge in Miami on your account.',
      'To protect your funds, we need to move your balance to a secure holding account.',
      'Please confirm your full debit card number and the CVV on the back.',
      'This hold is temporary — funds return within 24 hours once verified.',
    ],
    scores: [8, 28, 52, 79, 96],
  ),
  _DemoScenario(
    name: 'Tech Support',
    number: '+1 (888) 277-4537',
    lines: [
      'Hi, this is Apple Support calling about your Apple ID.',
      'We detected three unauthorized sign-ins from Russia and China.',
      'Your account will be permanently locked in 30 minutes unless we act now.',
      'I need you to install AnyDesk so our security team can remove the threat.',
      'Please also provide your Apple ID password so we can reset your 2FA today.',
    ],
    scores: [10, 24, 49, 73, 97],
  ),
];

class _DemoCall {
  final List<String> lines;
  final int score;
  final String scenarioName;
  _DemoCall(this.lines, this.score, this.scenarioName);
}

class _LiveShieldActiveScreenState extends State<LiveShieldActiveScreen>
    with TickerProviderStateMixin {
  late final AnimationController _pulse;
  late final AnimationController _wave;

  _DemoPhase _demoPhase = _DemoPhase.idle;
  int _scenarioIndex = 0;
  final List<String> _transcript = [];
  int _fraudScore = 0;
  Timer? _demoTimer;
  final List<_DemoCall> _callHistory = [];

  // Backend integration state. When `_sessionId` is non-null the demo is
  // also driving a real /v1/live-shield session — the score we render is
  // what the v2 hybrid engine returned (regex + Claude). When null we
  // fall back to scripted scores so the demo still works for non-Pro
  // accounts, offline, or any backend hiccup.
  String? _sessionId;
  String? _coachingLine;
  // v4 — counter-script coaching surface. Populated when the backend's
  // playbook classifier locks on with ≥0.7 confidence AND
  // V4_PLAYBOOK_COACHING_ENABLED is on. iOS renders these as a numbered
  // card below the v2 coaching line.
  List<String> _counterScripts = const [];
  String? _v4PlaybookId;
  int _backendChunkSeq = 0;

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

    // Surface the v2 consent sheet on first run after install. If the
    // user declines, we still run the demo — the backend session just
    // opens as consent_version=1 (regex-only, no coaching line). The
    // decline path is intentional: we never block a user from seeing
    // the demo just because they don't want LLM coaching today.
    await showLiveShieldConsentV2Sheet(context);
    if (!mounted) return;

    final scenario = _kScenarios[_scenarioIndex];
    setState(() {
      _demoPhase = _DemoPhase.ringing;
      _transcript.clear();
      _fraudScore = 0;
      _coachingLine = null;
      _counterScripts = const [];
      _v4PlaybookId = null;
      _sessionId = null;
      _backendChunkSeq = 0;
    });
    HapticFeedback.heavyImpact();

    // Kick off a real backend session in parallel with the "ringing"
    // animation. If this Pro-gated call fails (non-Pro, offline, 5xx)
    // we just won't have a session_id and the demo runs in fallback
    // mode with scripted scores. Never blocks the user-facing flow.
    final startFuture = liveShield.start(peerNumber: scenario.number);

    await Future.delayed(const Duration(milliseconds: 1800));
    if (!mounted) return;
    final startResult = await startFuture;
    if (mounted && startResult != null) {
      _sessionId = startResult.sessionId;
    }
    setState(() => _demoPhase = _DemoPhase.transcribing);

    const delays = [0, 1400, 1600, 1500, 1700];
    for (int i = 0; i < scenario.lines.length; i++) {
      await Future.delayed(Duration(milliseconds: delays[i]));
      if (!mounted) return;
      final line = scenario.lines[i];
      setState(() {
        _transcript.add(line);
        // Optimistic: show scripted score immediately. If backend
        // returns one for this chunk we'll overwrite it below.
        _fraudScore = scenario.scores[i];
      });
      HapticFeedback.selectionClick();

      // Send the chunk to the backend (if we got a session). Backend
      // computes its own score from the same line — if it differs from
      // the scripted score it's because the real v2 engine had a
      // different read, which is exactly what we want to surface.
      final sid = _sessionId;
      if (sid != null) {
        final chunkResult = await liveShield.sendChunk(
          sessionId: sid,
          seq: _backendChunkSeq++,
          text: line,
          speaker: 'caller',
        );
        if (chunkResult != null && mounted) {
          setState(() {
            _fraudScore = chunkResult.riskScore;
            if (chunkResult.coachingLine != null) {
              _coachingLine = chunkResult.coachingLine;
            }
            // v4 counter-scripts only update when the backend returns a
            // non-empty list — once the playbook locks on it tends to
            // stay locked for the rest of the call, so we don't want a
            // momentary null to erase the card mid-demo.
            if (chunkResult.v4CounterScripts.isNotEmpty) {
              _counterScripts = chunkResult.v4CounterScripts;
              _v4PlaybookId = chunkResult.v4PlaybookId;
            }
          });
        }
      }
    }

    await Future.delayed(const Duration(milliseconds: 600));
    if (!mounted) return;
    setState(() => _demoPhase = _DemoPhase.verdict);
    HapticFeedback.heavyImpact();
  }

  void _dismissDemo() {
    if (_demoPhase == _DemoPhase.verdict) {
      // Close the backend session if one was opened. Use `user_hung_up`
      // because tapping "Block" on the verdict card is the closest
      // analogue to disengaging the call — and that's the outcome the
      // backend uses to fire the `call_blocked` analytic.
      final sid = _sessionId;
      if (sid != null) {
        liveShield.end(sessionId: sid, outcome: 'user_hung_up');
      }
      setState(() {
        _callHistory.insert(0, _DemoCall(
          List.from(_transcript), _fraudScore,
          _kScenarios[_scenarioIndex].name,
        ));
        _demoPhase = _DemoPhase.done;
        _transcript.clear();
        _fraudScore = 0;
        _coachingLine = null;
        _counterScripts = const [];
        _v4PlaybookId = null;
        _sessionId = null;
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
                      ? _RingingCard(
                          number: _kScenarios[_scenarioIndex].number,
                          key: const ValueKey('ring'),
                        )
                      : _demoPhase == _DemoPhase.transcribing ||
                              _demoPhase == _DemoPhase.verdict
                          ? _LiveCallCard(
                              key: const ValueKey('live'),
                              number: _kScenarios[_scenarioIndex].number,
                              scenarioName: _kScenarios[_scenarioIndex].name,
                              lines: _transcript,
                              score: _fraudScore,
                              verdict: _demoPhase == _DemoPhase.verdict,
                              coachingLine: _coachingLine,
                              counterScripts: _counterScripts,
                              v4PlaybookId: _v4PlaybookId,
                              onBlock: _dismissDemo,
                              onAnswer: _dismissDemo,
                            )
                          : _IdleCard(
                              key: const ValueKey('idle'),
                              onRunDemo: _runDemo,
                              selectedIndex: _scenarioIndex,
                              onSelectScenario: (i) =>
                                  setState(() => _scenarioIndex = i),
                            ),
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
  final int selectedIndex;
  final ValueChanged<int> onSelectScenario;
  const _IdleCard({
    super.key,
    required this.onRunDemo,
    required this.selectedIndex,
    required this.onSelectScenario,
  });

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
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Listening — no active call',
            style: tt.bodyMedium?.copyWith(
              color: AegisColors.textPrimary,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            'When a call comes in, the live transcript and verdict appear here.',
            style: tt.bodySmall?.copyWith(
              color: AegisColors.textTertiary,
              height: 1.45,
            ),
          ),
          const SizedBox(height: 14),
          Text(
            'DEMO SCENARIO',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.4,
              fontWeight: FontWeight.w600,
              fontSize: 10,
            ),
          ),
          const SizedBox(height: 8),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: List.generate(_kScenarios.length, (i) {
                final selected = i == selectedIndex;
                return Padding(
                  padding: EdgeInsets.only(right: i < _kScenarios.length - 1 ? 8 : 0),
                  child: GestureDetector(
                    onTap: () => onSelectScenario(i),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 7),
                      decoration: BoxDecoration(
                        color: selected
                            ? AegisColors.turquoise.withValues(alpha: 0.15)
                            : AegisColors.surfaceElevated,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(
                          color: selected
                              ? AegisColors.turquoise
                              : AegisColors.border,
                          width: selected ? 1.2 : 0.6,
                        ),
                      ),
                      child: Text(
                        _kScenarios[i].name,
                        style: TextStyle(
                          color: selected
                              ? AegisColors.turquoise
                              : AegisColors.textSecondary,
                          fontSize: 12,
                          fontWeight: selected
                              ? FontWeight.w700
                              : FontWeight.w500,
                        ),
                      ),
                    ),
                  ),
                );
              }),
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
            builder: (_, _) => Icon(
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
                builder: (_, _) => Container(
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
  final String scenarioName;
  final String? coachingLine; // v2 LLM coaching — only set on Pro accounts post-consent-v2
  final List<String> counterScripts; // v4 counter-scripts — playbook-aware, ≥0.7 confidence
  final String? v4PlaybookId; // for the small "playbook detected" tag
  final VoidCallback onBlock;
  final VoidCallback onAnswer;

  const _LiveCallCard({
    super.key,
    required this.number,
    required this.lines,
    required this.score,
    required this.verdict,
    required this.scenarioName,
    this.coachingLine,
    this.counterScripts = const [],
    this.v4PlaybookId,
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
          // v2 coaching banner — only present when the backend's LLM
          // returned a sanitized coaching line for this session. iOS
          // shows it above the transcript so the user has a concrete
          // line to say back ("Tell them you'll call back on the
          // official number...") at the moment they need it.
          if (coachingLine != null && coachingLine!.isNotEmpty)
            Container(
              margin: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
              decoration: BoxDecoration(
                color: AegisColors.turquoise.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: AegisColors.turquoise.withValues(alpha: 0.35),
                  width: 0.8,
                ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.auto_awesome_rounded,
                    size: 14,
                    color: AegisColors.turquoise,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'WHAT TO SAY',
                          style: tt.labelSmall?.copyWith(
                            color: AegisColors.turquoise,
                            letterSpacing: 1.2,
                            fontSize: 9,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          coachingLine!,
                          style: tt.bodySmall?.copyWith(
                            color: AegisColors.textPrimary,
                            height: 1.45,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          // v4 counter-script card — playbook-specific scripts the user
          // can read straight off the screen to disengage. Sourced from
          // the seeded `b4_playbooks.counter_scripts` array, top-N
          // strongest. Surfaces only when v4 classifier has locked on
          // ≥0.7 confidence AND backend's V4_PLAYBOOK_COACHING_ENABLED.
          if (counterScripts.isNotEmpty)
            Container(
              margin: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    AegisColors.blue.withValues(alpha: 0.14),
                    AegisColors.turquoise.withValues(alpha: 0.08),
                  ],
                ),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: AegisColors.blue.withValues(alpha: 0.35),
                  width: 0.8,
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(
                        Icons.menu_book_rounded,
                        size: 14,
                        color: AegisColors.blueAccent,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        'SAY THIS TO MAKE THEM HANG UP',
                        style: tt.labelSmall?.copyWith(
                          color: AegisColors.blueAccent,
                          letterSpacing: 1.2,
                          fontSize: 9,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      if (v4PlaybookId != null) ...[
                        const Spacer(),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 7, vertical: 2),
                          decoration: BoxDecoration(
                            color: AegisColors.blue.withValues(alpha: 0.18),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            _formatPlaybookLabel(v4PlaybookId!),
                            style: tt.labelSmall?.copyWith(
                              color: AegisColors.blueAccent,
                              fontSize: 9,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 0.4,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 8),
                  for (int i = 0; i < counterScripts.length; i++)
                    Padding(
                      padding: EdgeInsets.only(
                          bottom: i == counterScripts.length - 1 ? 0 : 6),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            width: 18,
                            height: 18,
                            margin: const EdgeInsets.only(top: 1, right: 8),
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: AegisColors.blue.withValues(alpha: 0.2),
                              border: Border.all(
                                color: AegisColors.blueAccent
                                    .withValues(alpha: 0.55),
                                width: 0.8,
                              ),
                            ),
                            alignment: Alignment.center,
                            child: Text(
                              '${i + 1}',
                              style: TextStyle(
                                color: AegisColors.blueAccent,
                                fontSize: 10,
                                fontWeight: FontWeight.w800,
                                height: 1,
                              ),
                            ),
                          ),
                          Expanded(
                            child: Text(
                              '"${counterScripts[i]}"',
                              style: tt.bodySmall?.copyWith(
                                color: AegisColors.textPrimary,
                                height: 1.45,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
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
                          '$scenarioName · $score% confidence',
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
                  '${call.scenarioName} · BLOCKED',
                  style: tt.bodySmall?.copyWith(fontWeight: FontWeight.w600),
                ),
                Text(
                  '${call.score}% fraud score · demo',
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

// Convert v4 playbook id like 'irs_impersonation' to a short display
// label for the counter-script card tag — 'IRS' / 'BANK' / etc. If the
// id isn't in the canonical short-labels map we fall back to the full
// title-cased name truncated to 18 chars.
String _formatPlaybookLabel(String playbookId) {
  const shortLabels = <String, String>{
    'irs_impersonation': 'IRS',
    'ssa_impersonation': 'SSA',
    'medicare_impersonation': 'MEDICARE',
    'bank_impersonation': 'BANK',
    'tech_support_scam': 'TECH SUPPORT',
    'grandparent_scam': 'GRANDPARENT',
    'police_warrant_scam': 'POLICE',
    'utility_shutoff_scam': 'UTILITY',
    'romance_scam': 'ROMANCE',
    'sweepstakes_lottery_scam': 'LOTTERY',
    'gift_card_payment_scam': 'GIFT CARD',
    'crypto_investment_scam': 'CRYPTO',
    'charity_disaster_scam': 'CHARITY',
    'job_offer_scam': 'JOB OFFER',
  };
  final hit = shortLabels[playbookId];
  if (hit != null) return hit;
  final cleaned = playbookId.replaceAll('_', ' ').toUpperCase();
  return cleaned.length > 18 ? '${cleaned.substring(0, 17)}…' : cleaned;
}
