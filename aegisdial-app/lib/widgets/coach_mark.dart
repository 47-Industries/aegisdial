import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _kCoachSeenKey = 'coach_tour_seen_v1';

Future<bool> coachTourSeen() async {
  final p = await SharedPreferences.getInstance();
  return p.getBool(_kCoachSeenKey) ?? false;
}

Future<void> markCoachTourSeen() async {
  final p = await SharedPreferences.getInstance();
  await p.setBool(_kCoachSeenKey, true);
}

class CoachStep {
  final GlobalKey targetKey;
  final String title;
  final String body;
  const CoachStep({required this.targetKey, required this.title, required this.body});
}

class CoachMarkController extends ChangeNotifier {
  int _step = -1;
  bool _isGuest = false;
  List<CoachStep> _steps = [];

  bool get active => _step >= 0 && _step < _steps.length;
  int get step => _step;
  CoachStep? get current => active ? _steps[_step] : null;
  bool get isLast => _step == _steps.length - 1;

  void start(List<CoachStep> steps, {bool guest = false}) {
    _steps = steps;
    _isGuest = guest;
    _step = 0;
    notifyListeners();
  }

  void next() {
    if (!active) return;
    if (isLast) {
      end();
    } else {
      _step++;
      notifyListeners();
    }
  }

  Future<void> end() async {
    _step = -1;
    notifyListeners();
    if (!_isGuest) await markCoachTourSeen();
  }
}

// ── Overlay ───────────────────────────────────────────────────────────────────

class CoachMarkOverlay extends StatefulWidget {
  final Widget child;
  final CoachMarkController controller;

  const CoachMarkOverlay({
    super.key,
    required this.child,
    required this.controller,
  });

  @override
  State<CoachMarkOverlay> createState() => _CoachMarkOverlayState();
}

class _CoachMarkOverlayState extends State<CoachMarkOverlay>
    with SingleTickerProviderStateMixin {
  Rect? _targetRect;
  late final AnimationController _anim;
  late final Animation<double> _fade;

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 300),
    );
    _fade = CurvedAnimation(parent: _anim, curve: Curves.easeOut);
    widget.controller.addListener(_onStepChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onStepChanged);
    _anim.dispose();
    super.dispose();
  }

  void _onStepChanged() {
    if (!mounted) return;
    if (widget.controller.active) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _updateRect());
    } else {
      _anim.reverse();
      setState(() => _targetRect = null);
    }
  }

  void _updateRect() {
    if (!mounted) return;
    final step = widget.controller.current;
    if (step == null) return;

    final ctx = step.targetKey.currentContext;
    if (ctx == null) return;

    final box = ctx.findRenderObject() as RenderBox?;
    if (box == null) return;

    final pos = box.localToGlobal(Offset.zero);
    final rect = pos & box.size;
    setState(() => _targetRect = rect);
    _anim.forward(from: 0);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.controller,
      builder: (context2, child2) {
        return Stack(
          children: [
            widget.child,
            if (widget.controller.active && _targetRect != null)
              FadeTransition(
                opacity: _fade,
                child: _CoachMarkLayer(
                  targetRect: _targetRect!,
                  step: widget.controller.current!,
                  isLast: widget.controller.isLast,
                  onNext: widget.controller.next,
                  onSkip: widget.controller.end,
                ),
              ),
          ],
        );
      },
    );
  }
}

class _CoachMarkLayer extends StatelessWidget {
  final Rect targetRect;
  final CoachStep step;
  final bool isLast;
  final VoidCallback onNext;
  final VoidCallback onSkip;

  const _CoachMarkLayer({
    required this.targetRect,
    required this.step,
    required this.isLast,
    required this.onNext,
    required this.onSkip,
  });

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.of(context).size;
    final tt = Theme.of(context).textTheme;
    final inflated = targetRect.inflate(10);

    // Tooltip above or below?
    final showBelow = inflated.center.dy < size.height * 0.55;
    final tooltipTop = showBelow
        ? inflated.bottom + 16
        : inflated.top - 16 - 140;

    return GestureDetector(
      onTap: onNext,
      behavior: HitTestBehavior.opaque,
      child: Stack(
        children: [
          // Spotlight overlay
          CustomPaint(
            size: size,
            painter: _SpotlightPainter(target: inflated, radius: 16),
          ),
          // Tooltip card
          Positioned(
            left: 20,
            right: 20,
            top: tooltipTop.clamp(60.0, size.height - 200),
            child: GestureDetector(
              onTap: () {}, // absorb taps on the card
              behavior: HitTestBehavior.opaque,
              child: Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: const Color(0xFF1C1C1E),
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(
                    color: Colors.white.withValues(alpha: 0.1),
                    width: 0.8,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.5),
                      blurRadius: 32,
                      offset: const Offset(0, 8),
                    ),
                  ],
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      step.title,
                      style: tt.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      step.body,
                      style: tt.bodySmall?.copyWith(
                        color: Colors.white.withValues(alpha: 0.6),
                        height: 1.5,
                      ),
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        TextButton(
                          onPressed: onSkip,
                          style: TextButton.styleFrom(
                            padding: EdgeInsets.zero,
                            minimumSize: Size.zero,
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          ),
                          child: Text(
                            'Skip tour',
                            style: tt.labelSmall?.copyWith(
                              color: Colors.white.withValues(alpha: 0.35),
                            ),
                          ),
                        ),
                        const Spacer(),
                        GestureDetector(
                          onTap: onNext,
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 20, vertical: 10),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: Text(
                              isLast ? 'Got it' : 'Next  →',
                              style: const TextStyle(
                                color: Colors.black,
                                fontWeight: FontWeight.w700,
                                fontSize: 13,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
          // Arrow indicator pointing at target
          Positioned(
            left: inflated.center.dx - 6,
            top: showBelow ? inflated.bottom + 8 : inflated.top - 14,
            child: CustomPaint(
              painter: _ArrowPainter(pointUp: !showBelow),
              size: const Size(12, 8),
            ),
          ),
        ],
      ),
    );
  }
}

class _SpotlightPainter extends CustomPainter {
  final Rect target;
  final double radius;
  const _SpotlightPainter({required this.target, required this.radius});

  @override
  void paint(Canvas canvas, Size size) {
    canvas.saveLayer(Offset.zero & size, Paint());
    canvas.drawRect(
      Offset.zero & size,
      Paint()..color = Colors.black.withValues(alpha: 0.78),
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(target, Radius.circular(radius)),
      Paint()..blendMode = BlendMode.clear,
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _SpotlightPainter old) => old.target != target;
}

class _ArrowPainter extends CustomPainter {
  final bool pointUp;
  const _ArrowPainter({required this.pointUp});

  @override
  void paint(Canvas canvas, Size size) {
    final path = Path();
    if (pointUp) {
      path.moveTo(size.width / 2, 0);
      path.lineTo(size.width, size.height);
      path.lineTo(0, size.height);
    } else {
      path.moveTo(0, 0);
      path.lineTo(size.width, 0);
      path.lineTo(size.width / 2, size.height);
    }
    path.close();
    canvas.drawPath(path, Paint()..color = const Color(0xFF1C1C1E));
  }

  @override
  bool shouldRepaint(covariant _ArrowPainter old) => old.pointUp != pointUp;
}
