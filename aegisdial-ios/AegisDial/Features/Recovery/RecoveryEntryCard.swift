import SwiftUI

// Home-screen entry points for Recovery Concierge. Two modes:
//   .idle     — small subdued card: "Been scammed? Start recovery."
//   .active   — tall prominent card with progress ("3 of 10 steps done")
//
// The active mode is the more-important one — if a user has a half-finished
// recovery session, we want to pull them back into it the next time they
// open the app. Default behavior for any phone-safety product: when there's
// an in-flight remediation, make it the most prominent element on Home.

struct RecoveryEntryCard: View {
  enum Mode: Equatable {
    case idle
    case active(RecoverySession)
  }

  let mode: Mode
  let onTap: () -> Void

  var body: some View {
    Button(action: {
      AegisHaptic.light.play()
      onTap()
    }) {
      switch mode {
      case .idle: idleCard
      case .active(let session): activeCard(session)
      }
    }
    .buttonStyle(.plain)
  }

  private var idleCard: some View {
    HStack(spacing: AegisSpacing.m) {
      Image(systemName: "cross.case.fill")
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(AegisColor.textSecondary)
        .frame(width: 40, height: 40)
        .background(AegisColor.surface)
        .clipShape(Circle())
      VStack(alignment: .leading, spacing: 2) {
        Text("Think you've been scammed?")
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
        Text("Start a guided recovery in 15 minutes.")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
      }
      Spacer()
      Image(systemName: "chevron.right")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(AegisColor.textTertiary)
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface.opacity(0.8))
    .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairline, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private func activeCard(_ session: RecoverySession) -> some View {
    let p = session.session.progress
    let done = p.completed + p.skipped
    let fraction: CGFloat = p.total == 0 ? 0 : CGFloat(done) / CGFloat(p.total)
    return VStack(alignment: .leading, spacing: AegisSpacing.s) {
      HStack(spacing: AegisSpacing.s) {
        Image(systemName: "cross.case.fill")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(AegisColor.accent)
        Text("RECOVERY IN PROGRESS")
          .font(.system(size: 11, weight: .bold, design: .rounded))
          .tracking(1.5)
          .foregroundStyle(AegisColor.accent)
        Spacer()
        Image(systemName: "arrow.right")
          .font(.system(size: 14, weight: .bold))
          .foregroundStyle(AegisColor.textPrimary)
      }

      Text(nextStepTitle(session))
        .font(AegisType.heading)
        .foregroundStyle(AegisColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)

      Text("\(done) of \(p.total) steps done")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textSecondary)

      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(AegisColor.surface)
          Capsule().fill(AegisColor.accent).frame(width: geo.size.width * fraction)
        }
      }
      .frame(height: 6)
    }
    .padding(AegisSpacing.l)
    .background(AegisColor.surfaceElevated)
    .overlay(RoundedRectangle(cornerRadius: AegisRadius.l).stroke(AegisColor.accent.opacity(0.6), lineWidth: 1.5))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous))
    .shadow(color: AegisColor.accentGlow, radius: 12)
  }

  private func nextStepTitle(_ session: RecoverySession) -> String {
    session.steps.first { $0.status == .pending || $0.status == .inProgress }?.title
      ?? "Finish your recovery"
  }
}
