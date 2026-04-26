import SwiftUI

// MARK: - Palette
//
// Dark-first palette. Inspired by the way Apple Wallet, Arc, and Linear use
// depth and temperature — near-black backgrounds, saturated semantic accents,
// generous neutral mid-tones. All colors are defined in-code so we don't
// depend on asset catalogs being present.

enum AegisColor {
  // Base / surfaces
  static let background = Color(red: 0.04, green: 0.05, blue: 0.07)
  static let surface = Color(red: 0.08, green: 0.09, blue: 0.12)
  static let surfaceElevated = Color(red: 0.11, green: 0.12, blue: 0.16)
  static let surfaceInverted = Color(red: 0.96, green: 0.97, blue: 0.99)

  // Text
  static let textPrimary = Color(red: 0.98, green: 0.98, blue: 1.00)
  static let textSecondary = Color(red: 0.70, green: 0.72, blue: 0.78)
  static let textTertiary = Color(red: 0.48, green: 0.50, blue: 0.56)

  // Hairlines, dividers
  static let hairline = Color.white.opacity(0.08)
  static let hairlineStrong = Color.white.opacity(0.14)

  // Semantic — verdict states
  static let verdictTrusted = Color(red: 0.22, green: 0.85, blue: 0.55)
  static let verdictSuspicious = Color(red: 1.00, green: 0.72, blue: 0.25)
  static let verdictSpoofHigh = Color(red: 1.00, green: 0.38, blue: 0.40)
  static let verdictUnknown = Color(red: 0.52, green: 0.58, blue: 0.70)
  static let verdictLikelySpoof = Color(red: 1.00, green: 0.52, blue: 0.35)

  // Brand accent — used sparingly
  static let accent = Color(red: 0.42, green: 0.68, blue: 1.00)
  static let accentGlow = Color(red: 0.42, green: 0.68, blue: 1.00).opacity(0.22)
}

// MARK: - Typography
//
// SF Pro Display + variable weight. Keep a short tight scale — 6 roles cover
// the whole app. Don't overuse bold; rely on size + color hierarchy.

enum AegisType {
  static let display = Font.system(size: 64, weight: .bold, design: .rounded)
  static let title = Font.system(size: 34, weight: .bold, design: .rounded)
  static let heading = Font.system(size: 22, weight: .semibold, design: .rounded)
  static let body = Font.system(size: 17, weight: .regular, design: .default)
  static let bodyBold = Font.system(size: 17, weight: .semibold, design: .default)
  static let caption = Font.system(size: 13, weight: .medium, design: .default)
  static let mono = Font.system(size: 17, weight: .medium, design: .monospaced)
}

// MARK: - Spacing

enum AegisSpacing {
  static let xs: CGFloat = 4
  static let s: CGFloat = 8
  static let m: CGFloat = 16
  static let l: CGFloat = 24
  static let xl: CGFloat = 32
  static let xxl: CGFloat = 48
}

// MARK: - Corner radii

enum AegisRadius {
  static let s: CGFloat = 10
  static let m: CGFloat = 16
  static let l: CGFloat = 24
  static let pill: CGFloat = 999
}

// MARK: - Motion
//
// One spring for everything interactive so the app has a consistent feel.
// Two easing curves for non-physical things (fades, reveals).

enum AegisMotion {
  static let spring = Animation.spring(response: 0.42, dampingFraction: 0.78)
  static let snappy = Animation.spring(response: 0.28, dampingFraction: 0.82)
  static let gentle = Animation.easeInOut(duration: 0.45)
  static let swift = Animation.easeOut(duration: 0.18)
}
