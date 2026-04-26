import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

class AegisLogo extends StatelessWidget {
  final double size;
  const AegisLogo({super.key, this.size = 96});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: _ShieldPainter()),
    );
  }
}

class _ShieldPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final path = Path()
      ..moveTo(w * 0.5, 0)
      ..lineTo(w, h * 0.18)
      ..lineTo(w, h * 0.55)
      ..quadraticBezierTo(w, h * 0.92, w * 0.5, h)
      ..quadraticBezierTo(0, h * 0.92, 0, h * 0.55)
      ..lineTo(0, h * 0.18)
      ..close();

    final glow = Paint()
      ..shader = AegisColors.heroGradient.createShader(Offset.zero & size)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 18);
    canvas.drawPath(path, glow);

    final fill = Paint()
      ..shader = const LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [Color(0xFF0F1B26), Color(0xFF050B12)],
      ).createShader(Offset.zero & size);
    canvas.drawPath(path, fill);

    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..shader = AegisColors.heroGradient.createShader(Offset.zero & size);
    canvas.drawPath(path, stroke);

    final innerPath = Path()
      ..moveTo(w * 0.5, h * 0.22)
      ..lineTo(w * 0.78, h * 0.32)
      ..lineTo(w * 0.78, h * 0.58)
      ..quadraticBezierTo(w * 0.78, h * 0.78, w * 0.5, h * 0.85)
      ..quadraticBezierTo(w * 0.22, h * 0.78, w * 0.22, h * 0.58)
      ..lineTo(w * 0.22, h * 0.32)
      ..close();
    final innerStroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = AegisColors.turquoise.withValues(alpha: 0.55);
    canvas.drawPath(innerPath, innerStroke);

    final dotPaint = Paint()..color = AegisColors.turquoise;
    canvas.drawCircle(Offset(w * 0.5, h * 0.55), 3.5, dotPaint);

    final ringPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..color = AegisColors.turquoise.withValues(alpha: 0.4);
    canvas.drawCircle(Offset(w * 0.5, h * 0.55), 9, ringPaint);
    canvas.drawCircle(
      Offset(w * 0.5, h * 0.55),
      14,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = AegisColors.turquoise.withValues(alpha: 0.18),
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
