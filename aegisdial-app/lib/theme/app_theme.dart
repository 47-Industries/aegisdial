import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

class AegisColors {
  static const Color background = Color(0xFF000000);
  static const Color surface = Color(0xFF0A0E14);
  static const Color surfaceElevated = Color(0xFF12181F);
  static const Color border = Color(0xFF1F2832);

  static const Color turquoise = Color(0xFF1FE08A);
  static const Color turquoiseDim = Color(0xFF15A864);
  static const Color blue = Color(0xFF0F9E5B);
  static const Color blueAccent = Color(0xFF3FE890);

  static const Color textPrimary = Color(0xFFFFFFFF);
  static const Color textSecondary = Color(0xFFB8C2CC);
  static const Color textTertiary = Color(0xFF6A7480);

  static const Color danger = Color(0xFFFF4D6D);
  static const Color success = Color(0xFF00E5A0);

  static const LinearGradient heroGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [turquoise, blue],
  );

  static const RadialGradient ambientGlow = RadialGradient(
    center: Alignment.center,
    radius: 0.9,
    colors: [Color(0x401FE08A), Color(0x00000000)],
  );
}

class AppTheme {
  static ThemeData dark() {
    final base = ThemeData.dark(useMaterial3: true);
    final textTheme = GoogleFonts.interTextTheme(base.textTheme).apply(
      bodyColor: AegisColors.textPrimary,
      displayColor: AegisColors.textPrimary,
    );

    return base.copyWith(
      scaffoldBackgroundColor: AegisColors.background,
      colorScheme: const ColorScheme.dark(
        surface: AegisColors.surface,
        primary: AegisColors.turquoise,
        secondary: AegisColors.blue,
        error: AegisColors.danger,
        onPrimary: Colors.black,
        onSecondary: Colors.white,
        onSurface: AegisColors.textPrimary,
      ),
      textTheme: textTheme,
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        foregroundColor: AegisColors.textPrimary,
        centerTitle: true,
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AegisColors.turquoise,
          foregroundColor: Colors.black,
          minimumSize: const Size.fromHeight(56),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
          ),
          textStyle: GoogleFonts.inter(
            fontSize: 17,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.2,
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AegisColors.textPrimary,
          minimumSize: const Size.fromHeight(56),
          side: const BorderSide(color: AegisColors.border, width: 1),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
          ),
          textStyle: GoogleFonts.inter(
            fontSize: 17,
            fontWeight: FontWeight.w500,
          ),
        ),
      ),
    );
  }
}
