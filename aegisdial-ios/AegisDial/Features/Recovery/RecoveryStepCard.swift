import SwiftUI

// One card per step in the Recovery flow. Three visual states:
//   pending       — collapsed, number + title, dimmed
//   current       — expanded, big title + body + CTAs, accent-border
//   completed     — collapsed, checkmark + strikethrough-feel, verdictTrusted
//   skipped       — collapsed, muted, with "Skipped" pill
//
// The current card's CTAs are intentionally large. Users are often older
// adults and their dominant hand may be shaking. 54pt minimum height on
// every tappable surface.

struct RecoveryStepCard: View {
  let step: RecoverySession.Step
  let isCurrent: Bool
  let isBusy: Bool
  var onAction: (RecoverySessionView.StepAction) -> Void

  @State private var showingResetConfirm: Bool = false

  var body: some View {
    Group {
      if isCurrent {
        currentCard
      } else {
        switch step.status {
        case .completed: completedCard
        case .skipped: skippedCard
        case .pending, .inProgress: upcomingCard
        }
      }
    }
    // Long-press on a collapsed completed/skipped card lets the user
    // re-open it. Human-error forgiveness: taps are easy to mis-fire,
    // especially for users with tremors — they need a way back.
    .contextMenu {
      if !isCurrent && (step.status == .completed || step.status == .skipped) {
        Button {
          showingResetConfirm = true
        } label: {
          Label("Reset step", systemImage: "arrow.counterclockwise")
        }
      }
    }
    .alert("Reset this step?", isPresented: $showingResetConfirm) {
      Button("Cancel", role: .cancel) {}
      Button("Reset") { onAction(.reset) }
    } message: {
      Text("Your progress won't be lost — the step will just re-open so you can work on it again.")
    }
  }

  // MARK: - Current (expanded)

  private var currentCard: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      HStack(spacing: AegisSpacing.s) {
        stepBadge(.accent)
        Spacer()
        Text("DO THIS NOW")
          .font(.system(size: 11, weight: .bold, design: .rounded))
          .tracking(1.5)
          .foregroundStyle(AegisColor.accent)
      }

      // NOTE: aging-parent DynamicType pass 2026-04-19
      // 26pt has no token (heading=22, title=34); preserve + scale so long
      // recovery-step titles don't truncate at AX3-AX5.
      Text(step.title)
        .font(.system(size: 26, weight: .bold, design: .rounded))
        .minimumScaleFactor(0.7)
        .foregroundStyle(AegisColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)

      Text(step.body)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)

      ctaStack

      HStack(spacing: AegisSpacing.s) {
        Button {
          onAction(.done)
        } label: {
          HStack {
            if isBusy { ProgressView().tint(.black) }
            else {
              Image(systemName: "checkmark")
              Text("I did this").font(AegisType.bodyBold)
            }
          }
          .frame(maxWidth: .infinity, minHeight: 54)
          .foregroundStyle(.black)
          .background(AegisColor.textPrimary)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        }
        .disabled(isBusy)

        // NOTE: aging-parent DynamicType pass 2026-04-19
        // Skip used to match the primary CTA in weight/height, so older
        // users were mis-tapping it thinking it was the confirm button.
        // De-emphasized to an outlined tertiary-text pill with longer
        // explicit copy ("Not doing this one") so the intent is unmistakable.
        Button {
          onAction(.skip)
        } label: {
          Text("Not doing this one")
            .font(AegisType.body)
            .minimumScaleFactor(0.7)
            .lineLimit(2)
            .multilineTextAlignment(.center)
            .padding(.horizontal, AegisSpacing.m)
            .frame(minHeight: 54)
            .foregroundStyle(AegisColor.textTertiary)
            .background(Color.clear)
            .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.textTertiary.opacity(0.5), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        }
        .disabled(isBusy)
      }
    }
    .padding(AegisSpacing.l)
    .background(AegisColor.surfaceElevated)
    .overlay(
      RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous)
        .stroke(AegisColor.accent.opacity(0.7), lineWidth: 2)
    )
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous))
    .shadow(color: AegisColor.accentGlow, radius: 16)
  }

  @ViewBuilder
  private var ctaStack: some View {
    VStack(spacing: AegisSpacing.s) {
      if let phone = step.phoneToCall {
        Button {
          onAction(.call)
        } label: {
          HStack(spacing: AegisSpacing.s) {
            Image(systemName: "phone.fill")
              .font(.system(size: 18, weight: .bold))
            Text("Call \(formatPhone(phone))")
              .font(AegisType.bodyBold)
          }
          .frame(maxWidth: .infinity, minHeight: 54)
          .foregroundStyle(AegisColor.textPrimary)
          .background(AegisColor.verdictTrusted.opacity(0.2))
          .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.verdictTrusted, lineWidth: 1.5))
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        }
      }
      if let ctaLabel = step.ctaLabel, step.ctaUrl != nil {
        Button {
          onAction(.open)
        } label: {
          HStack(spacing: AegisSpacing.s) {
            Image(systemName: "arrow.up.right.square")
              .font(.system(size: 16, weight: .semibold))
            Text(ctaLabel).font(AegisType.bodyBold)
          }
          .frame(maxWidth: .infinity, minHeight: 54)
          .foregroundStyle(AegisColor.textPrimary)
          .background(AegisColor.accent.opacity(0.18))
          .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.accent.opacity(0.6), lineWidth: 1.5))
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        }
      }
    }
  }

  // MARK: - Completed / skipped / upcoming (collapsed)

  private var completedCard: some View {
    HStack(spacing: AegisSpacing.m) {
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 26))
        .foregroundStyle(AegisColor.verdictTrusted)
      Text(step.title)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .strikethrough(color: AegisColor.textTertiary)
        .lineLimit(1)
      Spacer()
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface.opacity(0.6))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var skippedCard: some View {
    HStack(spacing: AegisSpacing.m) {
      Image(systemName: "arrow.forward.circle.fill")
        .font(.system(size: 22))
        .foregroundStyle(AegisColor.textTertiary)
      Text(step.title)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textTertiary)
        .lineLimit(1)
      Spacer()
      Text("Skipped")
        .font(.system(size: 10, weight: .bold, design: .rounded))
        .tracking(1)
        .foregroundStyle(AegisColor.textTertiary)
        .padding(.horizontal, AegisSpacing.s)
        .padding(.vertical, 3)
        .background(AegisColor.surface)
        .clipShape(Capsule())
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface.opacity(0.6))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var upcomingCard: some View {
    HStack(spacing: AegisSpacing.m) {
      stepBadge(.textTertiary)
      Text(step.title)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textTertiary)
        .lineLimit(1)
      Spacer()
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface.opacity(0.4))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  // MARK: -

  enum BadgeColor { case accent, textTertiary }
  private func stepBadge(_ color: BadgeColor) -> some View {
    let fill: Color = color == .accent ? AegisColor.accent : AegisColor.surface
    let border: Color = color == .accent ? .clear : AegisColor.hairlineStrong
    let text: Color = color == .accent ? .black : AegisColor.textTertiary
    return Text("\(step.ordinal + 1)")
      .font(.system(size: 14, weight: .bold, design: .rounded))
      .foregroundStyle(text)
      .frame(width: 28, height: 28)
      .background(fill)
      .overlay(Circle().stroke(border, lineWidth: 1))
      .clipShape(Circle())
  }

  private func formatPhone(_ raw: String) -> String {
    // Normalize to the US 1-XXX-XXX-XXXX look where possible.
    let digits = raw.filter { $0.isNumber }
    if digits.count == 11 && digits.hasPrefix("1") {
      let a = digits.index(digits.startIndex, offsetBy: 1)
      let b = digits.index(a, offsetBy: 3)
      let c = digits.index(b, offsetBy: 3)
      return "1-\(digits[a..<b])-\(digits[b..<c])-\(digits[c...])"
    }
    if digits.count == 10 {
      let b = digits.index(digits.startIndex, offsetBy: 3)
      let c = digits.index(b, offsetBy: 3)
      return "\(digits[..<b])-\(digits[b..<c])-\(digits[c...])"
    }
    return raw
  }
}
