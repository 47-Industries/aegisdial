import 'dart:math';
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/hyperspace_stars.dart';

class GlobeScreen extends StatefulWidget {
  const GlobeScreen({super.key});

  @override
  State<GlobeScreen> createState() => _GlobeScreenState();
}

class _GlobeScreenState extends State<GlobeScreen>
    with TickerProviderStateMixin {
  late final AnimationController _spinCtrl;
  late final AnimationController _zoomCtrl;
  late Animation<double> _zoom;

  final TextEditingController _locationCtrl = TextEditingController();
  String _label = 'New York, NY';
  // Lat/lon for the active pinpoint. NYC default.
  double _pinLat = 40.7128;
  double _pinLon = -74.0060;

  @override
  void initState() {
    super.initState();
    _spinCtrl = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 28),
    )..repeat();
    _zoomCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    );
    _zoom = CurvedAnimation(parent: _zoomCtrl, curve: Curves.easeOutCubic);
  }

  @override
  void dispose() {
    _spinCtrl.dispose();
    _zoomCtrl.dispose();
    _locationCtrl.dispose();
    super.dispose();
  }

  void _pinpoint() {
    final txt = _locationCtrl.text.trim();
    if (txt.isEmpty) return;
    final guess = _fakeGeocode(txt);
    setState(() {
      _label = txt;
      _pinLat = guess.$1;
      _pinLon = guess.$2;
    });
    _zoomCtrl.forward(from: 0);
  }

  // Stand-in geocoder so the demo works offline. Real wiring → backend.
  (double, double) _fakeGeocode(String q) {
    final l = q.toLowerCase();
    const presets = <String, (double, double)>{
      'new york': (40.7128, -74.0060),
      'nyc': (40.7128, -74.0060),
      'los angeles': (34.0522, -118.2437),
      'la': (34.0522, -118.2437),
      'london': (51.5074, -0.1278),
      'tokyo': (35.6762, 139.6503),
      'sydney': (-33.8688, 151.2093),
      'paris': (48.8566, 2.3522),
      'berlin': (52.5200, 13.4050),
      'dubai': (25.2048, 55.2708),
      'são paulo': (-23.5505, -46.6333),
      'sao paulo': (-23.5505, -46.6333),
      'cairo': (30.0444, 31.2357),
      'lagos': (6.5244, 3.3792),
      'mumbai': (19.0760, 72.8777),
    };
    for (final e in presets.entries) {
      if (l.contains(e.key)) return e.value;
    }
    final h = q.codeUnits.fold<int>(0, (a, b) => (a * 31 + b) & 0xFFFFFF);
    return (((h % 18000) / 100) - 90, ((h % 36000) / 100) - 180);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AegisColors.background,
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        title: const Text(
          'Coverage',
          style: TextStyle(fontWeight: FontWeight.w600, letterSpacing: 0.4),
        ),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          const Positioned.fill(
            child: HyperspaceStars(starCount: 140, speed: 0.35),
          ),
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(gradient: AegisColors.ambientGlow),
            ),
          ),
          SafeArea(
            child: Column(
              children: [
                const SizedBox(height: 12),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                  child: Text(
                    'Where should we shield?',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          color: AegisColors.textSecondary,
                        ),
                  ),
                ),
                const SizedBox(height: 8),
                Expanded(
                  child: AnimatedBuilder(
                    animation: Listenable.merge([_spinCtrl, _zoomCtrl]),
                    builder: (context, _) {
                      return CustomPaint(
                        painter: _GlobePainter(
                          spin: _spinCtrl.value * 2 * pi,
                          zoom: 1.0 + _zoom.value * 0.55,
                          pinLat: _pinLat,
                          pinLon: _pinLon,
                          label: _label,
                          highlight: _zoom.value,
                        ),
                        size: Size.infinite,
                      );
                    },
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 4, 24, 28),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _LocationField(
                        controller: _locationCtrl,
                        onSubmit: _pinpoint,
                      ),
                      const SizedBox(height: 14),
                      ElevatedButton.icon(
                        onPressed: _pinpoint,
                        icon: const Icon(Icons.gps_fixed_rounded, size: 20),
                        label: const Text('Lock onto location'),
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

class _LocationField extends StatelessWidget {
  final TextEditingController controller;
  final VoidCallback onSubmit;
  const _LocationField({required this.controller, required this.onSubmit});

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      onSubmitted: (_) => onSubmit(),
      style: const TextStyle(color: AegisColors.textPrimary, fontSize: 16),
      cursorColor: AegisColors.turquoise,
      decoration: InputDecoration(
        hintText: 'City, ZIP, or area (e.g. Tampa)',
        hintStyle: const TextStyle(color: AegisColors.textTertiary),
        prefixIcon: const Icon(Icons.public_rounded, color: AegisColors.turquoise),
        filled: true,
        fillColor: AegisColors.surface.withValues(alpha: 0.6),
        contentPadding: const EdgeInsets.symmetric(vertical: 18, horizontal: 16),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: AegisColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: AegisColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: AegisColors.turquoise, width: 1.4),
        ),
      ),
    );
  }
}

class _GlobePainter extends CustomPainter {
  final double spin;
  final double zoom;
  final double pinLat;
  final double pinLon;
  final String label;
  final double highlight;

  _GlobePainter({
    required this.spin,
    required this.zoom,
    required this.pinLat,
    required this.pinLon,
    required this.label,
    required this.highlight,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final cx = size.width / 2;
    final cy = size.height / 2;
    final radius = (min(size.width, size.height) / 2 - 28) * zoom;

    // Outer glow
    final glow = Paint()
      ..shader = RadialGradient(
        colors: [
          AegisColors.turquoise.withValues(alpha: 0.18),
          AegisColors.blue.withValues(alpha: 0.0),
        ],
      ).createShader(Rect.fromCircle(center: Offset(cx, cy), radius: radius * 1.4))
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 24);
    canvas.drawCircle(Offset(cx, cy), radius * 1.05, glow);

    // Sphere base — radial dark gradient mimicking lit sphere
    final base = Paint()
      ..shader = RadialGradient(
        center: const Alignment(-0.35, -0.45),
        colors: [
          const Color(0xFF12222E),
          const Color(0xFF050A10),
          Colors.black,
        ],
        stops: const [0.0, 0.6, 1.0],
      ).createShader(Rect.fromCircle(center: Offset(cx, cy), radius: radius));
    canvas.drawCircle(Offset(cx, cy), radius, base);

    // Atmosphere rim
    final atmo = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..shader = RadialGradient(
        colors: [
          AegisColors.turquoise.withValues(alpha: 0.0),
          AegisColors.turquoise.withValues(alpha: 0.55),
        ],
        stops: const [0.85, 1.0],
      ).createShader(Rect.fromCircle(center: Offset(cx, cy), radius: radius * 1.04))
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 6);
    canvas.drawCircle(Offset(cx, cy), radius * 1.01, atmo);

    // Latitude lines
    final latPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 0.8
      ..color = AegisColors.turquoise.withValues(alpha: 0.18);
    for (int i = 1; i < 8; i++) {
      final t = i / 8.0;
      final r = radius * sin(t * pi);
      final y = cy + radius * cos(t * pi) * -1;
      canvas.drawOval(
        Rect.fromCenter(center: Offset(cx, y), width: r * 2, height: r * 0.4),
        latPaint,
      );
    }

    // Longitude lines (rotate with spin)
    final lonPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 0.8
      ..color = AegisColors.blueAccent.withValues(alpha: 0.22);
    for (int i = 0; i < 12; i++) {
      final phase = (i / 12.0) * 2 * pi + spin;
      final wHalf = radius * cos(phase).abs();
      final width = max(2.0, wHalf * 2);
      canvas.drawOval(
        Rect.fromCenter(center: Offset(cx, cy), width: width, height: radius * 2),
        lonPaint,
      );
    }

    // Continents — simplified silhouettes drawn as hex blobs that rotate
    _drawContinents(canvas, Offset(cx, cy), radius, spin);

    // Pinpoint
    final pinPos = _project(pinLat, pinLon, spin, Offset(cx, cy), radius);
    if (pinPos != null) {
      final pulse = (sin(spin * 4) + 1) / 2;
      final ringR = 6 + pulse * 6 + highlight * 8;
      final pinFill = Paint()
        ..color = AegisColors.turquoise.withValues(alpha: 0.95);
      canvas.drawCircle(pinPos, 4 + highlight * 2, pinFill);
      final ring = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.4
        ..color = AegisColors.turquoise.withValues(alpha: 0.6 - pulse * 0.4);
      canvas.drawCircle(pinPos, ringR, ring);

      // Label tag
      final tp = TextPainter(
        text: TextSpan(
          text: label.toUpperCase(),
          style: const TextStyle(
            color: AegisColors.textPrimary,
            fontSize: 11,
            fontWeight: FontWeight.w600,
            letterSpacing: 1.4,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      final tagRect = Rect.fromCenter(
        center: pinPos.translate(0, -28),
        width: tp.width + 18,
        height: tp.height + 10,
      );
      final tagBg = Paint()
        ..color = AegisColors.surface.withValues(alpha: 0.85);
      canvas.drawRRect(
        RRect.fromRectAndRadius(tagRect, const Radius.circular(6)),
        tagBg,
      );
      final tagBorder = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0.8
        ..color = AegisColors.turquoise.withValues(alpha: 0.5);
      canvas.drawRRect(
        RRect.fromRectAndRadius(tagRect, const Radius.circular(6)),
        tagBorder,
      );
      tp.paint(
        canvas,
        Offset(tagRect.left + 9, tagRect.top + 5),
      );
    }
  }

  Offset? _project(
    double lat,
    double lon,
    double rot,
    Offset center,
    double radius,
  ) {
    final latR = lat * pi / 180;
    final lonR = lon * pi / 180 + rot;
    final x = cos(latR) * sin(lonR);
    final y = -sin(latR);
    final z = cos(latR) * cos(lonR);
    if (z < 0) return null; // hidden side of globe
    return Offset(center.dx + x * radius, center.dy + y * radius);
  }

  void _drawContinents(Canvas canvas, Offset c, double r, double rot) {
    // Coarse landmass dots: lat, lon. Looks like a holographic earth — not photoreal.
    const points = <(double, double)>[
      // North America
      (45, -100), (50, -110), (55, -100), (40, -95), (35, -85), (30, -85),
      (60, -130), (40, -75), (50, -90), (35, -110),
      // South America
      (-10, -60), (-20, -55), (-30, -65), (-5, -75), (-15, -45), (-35, -70),
      // Europe
      (50, 10), (55, 25), (45, 5), (60, 15), (48, 20),
      // Africa
      (10, 20), (0, 25), (-15, 25), (-25, 30), (15, 0), (5, 10),
      // Asia
      (35, 100), (40, 80), (50, 90), (30, 75), (25, 110), (45, 120),
      (55, 60), (35, 50), (20, 80), (60, 100),
      // Australia
      (-25, 135), (-30, 145), (-20, 130),
    ];
    final paint = Paint()
      ..color = AegisColors.turquoise.withValues(alpha: 0.55);
    final glowPaint = Paint()
      ..color = AegisColors.turquoise.withValues(alpha: 0.18)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3);
    for (final p in points) {
      final pos = _project(p.$1, p.$2, rot, c, r);
      if (pos == null) continue;
      canvas.drawCircle(pos, 2.4, glowPaint);
      canvas.drawCircle(pos, 1.4, paint);
    }
  }

  @override
  bool shouldRepaint(covariant _GlobePainter old) {
    return old.spin != spin ||
        old.zoom != zoom ||
        old.pinLat != pinLat ||
        old.pinLon != pinLon ||
        old.highlight != highlight;
  }
}
