import SwiftUI

// A 3/4-arc gauge that fills proportional to trust_score. The arc color
// interpolates across red→amber→green so the transition from a "35" to a
// "70" visibly slides through the color spectrum. The score number and
// verdict label sit in the center; label bounces in on appear.

struct TrustScoreGauge: View {
  let score: Int
  let verdict: VerdictResponse.Verdict
  @State private var animatedFill: CGFloat = 0

  var body: some View {
    ZStack {
      // Track
      Circle()
        .trim(from: 0.125, to: 0.875)
        .rotation(.degrees(90))
        .stroke(
          AegisColor.surfaceElevated,
          style: StrokeStyle(lineWidth: 14, lineCap: .round)
        )

      // Fill
      Circle()
        .trim(from: 0.125, to: 0.125 + animatedFill * 0.75)
        .rotation(.degrees(90))
        .stroke(
          AngularGradient(
            colors: [
              AegisColor.verdictSpoofHigh,
              AegisColor.verdictLikelySpoof,
              AegisColor.verdictSuspicious,
              AegisColor.verdictTrusted,
            ],
            center: .center,
            startAngle: .degrees(135),
            endAngle: .degrees(45 + 360)
          ),
          style: StrokeStyle(lineWidth: 14, lineCap: .round)
        )
        .shadow(color: verdict.color.opacity(0.5), radius: 18)

      VStack(spacing: AegisSpacing.xs) {
        Text("\(score)")
          .font(.system(size: 84, weight: .bold, design: .rounded))
          .foregroundStyle(AegisColor.textPrimary)
          .contentTransition(.numericText())
          .animation(AegisMotion.spring, value: score)
        Text(verdict.displayName.uppercased())
          .font(.system(size: 12, weight: .bold, design: .rounded))
          .tracking(2)
          .foregroundStyle(verdict.color)
          .padding(.horizontal, AegisSpacing.m)
          .padding(.vertical, 6)
          .background(verdict.color.opacity(0.16))
          .clipShape(Capsule())
      }
    }
    .frame(width: 240, height: 240)
    .onAppear {
      withAnimation(.easeOut(duration: 1.1)) {
        animatedFill = CGFloat(score) / 100.0
      }
    }
    .onChange(of: score) { _, new in
      withAnimation(.easeOut(duration: 0.6)) {
        animatedFill = CGFloat(new) / 100.0
      }
    }
  }
}
