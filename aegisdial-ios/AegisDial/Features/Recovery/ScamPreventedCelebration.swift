import SwiftUI

// Shown when a triage session resolves as scam_confirmed_no_loss —
// the headline PR-win moment. This is the screen victims screenshot
// and send to their family ("AegisDial just saved me from X").
//
// Copy is quietly triumphant, not over-the-top. Most users have just
// been shaken by a close call — they want reassurance, not confetti.

struct ScamPreventedCelebration: View {
  @Environment(\.dismiss) private var dismiss
  let scamTypeDisplayName: String?
  let onClose: () -> Void

  @State private var glow: Bool = false

  var body: some View {
    ZStack {
      background
      VStack(spacing: AegisSpacing.l) {
        Spacer()
        shieldIcon
        Text("You stopped it in time")
          .font(.system(size: 32, weight: .bold, design: .rounded))
          .foregroundStyle(AegisColor.textPrimary)
          .multilineTextAlignment(.center)
        headline
        stats
        Spacer()
        shareButton
        doneButton
      }
      .padding(AegisSpacing.l)
    }
    .preferredColorScheme(.dark)
    .onAppear {
      AegisHaptic.success.play()
      withAnimation(.easeInOut(duration: 2).repeatForever(autoreverses: true)) {
        glow.toggle()
      }
    }
  }

  private var background: some View {
    ZStack {
      AegisColor.background.ignoresSafeArea()
      RadialGradient(
        colors: [AegisColor.verdictTrusted.opacity(glow ? 0.45 : 0.2), .clear],
        center: .top,
        startRadius: 10,
        endRadius: 500
      )
      .blendMode(.screen)
      .ignoresSafeArea()
    }
  }

  private var shieldIcon: some View {
    ZStack {
      Circle()
        .fill(AegisColor.verdictTrusted.opacity(0.15))
        .frame(width: 180, height: 180)
      Circle()
        .fill(AegisColor.verdictTrusted.opacity(0.25))
        .frame(width: 130, height: 130)
      Image(systemName: "checkmark.shield.fill")
        .font(.system(size: 72, weight: .semibold))
        .foregroundStyle(AegisColor.verdictTrusted)
        .shadow(color: AegisColor.verdictTrusted.opacity(0.6), radius: glow ? 32 : 16)
    }
  }

  private var headline: some View {
    VStack(spacing: AegisSpacing.s) {
      if let scamTypeDisplayName {
        Text("You caught a \(scamTypeDisplayName) scam before any money moved.")
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textSecondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        Text("You caught it before any money moved.")
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textSecondary)
          .multilineTextAlignment(.center)
      }
      Text("That's the hardest part, and you did it. Most people freeze for the first 30 seconds — you didn't.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, AegisSpacing.m)
    }
  }

  private var stats: some View {
    HStack(spacing: AegisSpacing.m) {
      statCard(icon: "dollarsign.circle.fill", label: "Lost to this scam", value: "$0")
      statCard(icon: "clock.fill", label: "Response time", value: "Fast enough")
    }
    .padding(.top, AegisSpacing.m)
  }

  private func statCard(icon: String, label: String, value: String) -> some View {
    VStack(spacing: AegisSpacing.xs) {
      Image(systemName: icon)
        .foregroundStyle(AegisColor.verdictTrusted)
      Text(value)
        .font(.system(size: 18, weight: .semibold, design: .rounded))
        .foregroundStyle(AegisColor.textPrimary)
      Text(label)
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
    }
    .frame(maxWidth: .infinity)
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var shareButton: some View {
    // SwiftUI's native ShareLink (iOS 16+) handles iPad popover anchoring
    // automatically — UIActivityViewController presented from a scene
    // window without a source rect crashes on iPad.
    ShareLink(item: shareText) {
      HStack(spacing: AegisSpacing.s) {
        Image(systemName: "square.and.arrow.up")
        Text("Tell your family to watch out")
          .font(AegisType.bodyBold)
      }
      .frame(maxWidth: .infinity, minHeight: 54)
      .foregroundStyle(.black)
      .background(AegisColor.verdictTrusted)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
  }

  private var shareText: String {
    scamTypeDisplayName
      .map { "I just stopped a \($0) scam with AegisDial. If you get an unexpected call asking for money or gift cards, please talk to me first." }
      ?? "I just stopped a phone scam with AegisDial. If you get an unexpected call asking for money or gift cards, please talk to me first."
  }

  private var doneButton: some View {
    Button {
      onClose()
      dismiss()
    } label: {
      Text("Done")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.textPrimary)
        .frame(maxWidth: .infinity, minHeight: 54)
        .overlay(
          RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
            .stroke(AegisColor.hairlineStrong, lineWidth: 1)
        )
    }
  }
}
