import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import '../theme/app_theme.dart';

class HyperspaceStars extends StatefulWidget {
  final int starCount;
  final double speed;

  const HyperspaceStars({
    super.key,
    this.starCount = 240,
    this.speed = 1.0,
  });

  @override
  State<HyperspaceStars> createState() => _HyperspaceStarsState();
}

class _HyperspaceStarsState extends State<HyperspaceStars>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker;
  late List<_Star> _stars;
  Duration _last = Duration.zero;
  final _rng = Random();
  static const double _focalLength = 320.0;
  static const double _depth = 1000.0;

  @override
  void initState() {
    super.initState();
    _stars = List.generate(widget.starCount, (_) => _spawn(initial: true));
    _ticker = Ticker(_onTick)..start();
  }

  _Star _spawn({bool initial = false}) {
    return _Star(
      x: (_rng.nextDouble() - 0.5) * 2000,
      y: (_rng.nextDouble() - 0.5) * 2000,
      z: initial ? _rng.nextDouble() * _depth : _depth,
      hue: _pickHue(),
    );
  }

  Color _pickHue() {
    final r = _rng.nextDouble();
    if (r < 0.65) return AegisColors.textPrimary;
    if (r < 0.85) return AegisColors.blueAccent;
    return AegisColors.turquoise;
  }

  void _onTick(Duration elapsed) {
    final dt = (elapsed - _last).inMicroseconds / 1e6;
    _last = elapsed;
    final v = 280.0 * widget.speed;
    for (final s in _stars) {
      s.prevZ = s.z;
      s.z -= v * dt;
      if (s.z < 1) {
        final fresh = _spawn();
        s.x = fresh.x;
        s.y = fresh.y;
        s.z = _depth;
        s.prevZ = _depth;
        s.hue = fresh.hue;
      }
    }
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      painter: _HyperspacePainter(_stars, _focalLength),
      size: Size.infinite,
    );
  }
}

class _Star {
  double x;
  double y;
  double z;
  double prevZ;
  Color hue;
  _Star({required this.x, required this.y, required this.z, required this.hue})
      : prevZ = z;
}

class _HyperspacePainter extends CustomPainter {
  final List<_Star> stars;
  final double focal;
  _HyperspacePainter(this.stars, this.focal);

  @override
  void paint(Canvas canvas, Size size) {
    final cx = size.width / 2;
    final cy = size.height / 2;

    for (final s in stars) {
      if (s.z <= 0) continue;
      final px = (s.x / s.z) * focal + cx;
      final py = (s.y / s.z) * focal + cy;
      final ppx = (s.x / s.prevZ) * focal + cx;
      final ppy = (s.y / s.prevZ) * focal + cy;

      final depthRatio = (1.0 - (s.z / 1000.0)).clamp(0.0, 1.0);
      final radius = depthRatio * 1.8 + 0.2;
      final opacity = (depthRatio * 1.2).clamp(0.0, 1.0);

      final paint = Paint()
        ..strokeCap = StrokeCap.round
        ..color = s.hue.withValues(alpha: opacity)
        ..strokeWidth = radius;

      canvas.drawLine(Offset(ppx, ppy), Offset(px, py), paint);

      if (depthRatio > 0.85) {
        final glow = Paint()
          ..color = s.hue.withValues(alpha: 0.18 * (depthRatio - 0.85) * 6)
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 4);
        canvas.drawCircle(Offset(px, py), radius * 2.5, glow);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _HyperspacePainter old) => true;
}
