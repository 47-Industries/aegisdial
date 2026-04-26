import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

class AegisLogo extends StatelessWidget {
  final double size;
  final bool glow;
  const AegisLogo({super.key, this.size = 96, this.glow = true});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        boxShadow: glow
            ? [
                BoxShadow(
                  color: AegisColors.turquoise.withValues(alpha: 0.45),
                  blurRadius: size * 0.45,
                  spreadRadius: size * 0.04,
                ),
              ]
            : null,
      ),
      child: ClipOval(
        child: Image.asset(
          'assets/icon/icon.png',
          width: size,
          height: size,
          fit: BoxFit.cover,
        ),
      ),
    );
  }
}
