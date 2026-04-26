import SwiftUI

// First-run explainer for Guardian Mode. Many users find the feature in
// Settings and have no mental model — they need a plain-English pass
// before the Dashboard will feel useful.
//
// Shows once per device (keyed by UserDefaults). A "Never mind" button
// lets the user skip it; the Dashboard is still reachable after skip.

struct GuardianOnboardingView: View {
  @Environment(\.dismiss) private var dismiss
  let onContinue: () -> Void

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: AegisSpacing.l) {
        hero
        explainerCards
        whatYouGetSection
        Spacer(minLength: AegisSpacing.l)
        continueButton
        skipButton
      }
      .padding(AegisSpacing.l)
    }
    .background(AegisColor.background)
    .navigationTitle("Guardian Mode")
    .navigationBarTitleDisplayMode(.inline)
    .preferredColorScheme(.dark)
  }

  private var hero: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "shield.lefthalf.filled.badge.checkmark")
        .font(.system(size: 48, weight: .light))
        .foregroundStyle(AegisColor.accent.gradient)
        .symbolEffect(.pulse, options: .repeating)
      Text("Watch over someone you love")
        .font(.system(size: 24, weight: .semibold, design: .rounded))
        .foregroundStyle(AegisColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      Text("If your parent or spouse gets caught in a scam call, Guardian Mode lets you see the moment it's escalating — so you can reach out before money moves.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var explainerCards: some View {
    VStack(spacing: AegisSpacing.m) {
      explainerCard(
        icon: "person.2.fill",
        title: "1. Add them to your Family plan",
        body: "Invite the person you want to protect. They install AegisDial and accept — we never touch their call audio or contacts without permission."
      )
      explainerCard(
        icon: "bell.badge.fill",
        title: "2. You'll get a ping when it matters",
        body: "A live call hits critical risk, a safe-word fails mid-sentence, a new breach exposure surfaces — you get a notification. No spam: small-talk calls never ping you."
      )
      explainerCard(
        icon: "phone.arrow.up.right.fill",
        title: "3. Call them, not the scammer",
        body: "Every alert has a one-tap button to call the family member on a number we've verified — not any number the scammer provided."
      )
    }
  }

  private func explainerCard(icon: String, title: String, body: String) -> some View {
    HStack(alignment: .top, spacing: AegisSpacing.m) {
      Image(systemName: icon)
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(AegisColor.accent)
        .frame(width: 32)
      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
        Text(body)
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var whatYouGetSection: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("What Guardian sees — and doesn't")
      Label("Sees call risk scores and breach alerts", systemImage: "checkmark.seal.fill")
        .foregroundStyle(AegisColor.textPrimary)
      Label("Sees transcript snippets ONLY when risk is critical", systemImage: "checkmark.seal.fill")
        .foregroundStyle(AegisColor.textPrimary)
      Label("Never sees who called, only what type of scam", systemImage: "lock.shield.fill")
        .foregroundStyle(AegisColor.textSecondary)
      Label("Never sees regular calls, contacts, or messages", systemImage: "lock.shield.fill")
        .foregroundStyle(AegisColor.textSecondary)
    }
    .font(AegisType.caption)
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var continueButton: some View {
    Button {
      AegisHaptic.success.play()
      onContinue()
      dismiss()
    } label: {
      HStack(spacing: AegisSpacing.s) {
        Text("Open Guardian Dashboard").font(AegisType.bodyBold)
        Image(systemName: "arrow.right").font(.system(size: 14, weight: .bold))
      }
      .frame(maxWidth: .infinity, minHeight: 54)
      .foregroundStyle(.black)
      .background(AegisColor.textPrimary)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
  }

  private var skipButton: some View {
    Button {
      dismiss()
    } label: {
      Text("Maybe later")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .frame(maxWidth: .infinity, minHeight: 44)
    }
  }

  private func sectionHeader(_ text: String) -> some View {
    Text(text)
      .font(AegisType.caption)
      .foregroundStyle(AegisColor.textTertiary)
      .textCase(.uppercase)
      .tracking(1.2)
  }
}

// Settings gate: routes the user through the onboarding sheet on the first
// tap, then straight to the dashboard on subsequent taps.
struct GuardianEntryPoint: View {
  @State private var showOnboarding: Bool = !UserDefaults.standard.bool(forKey: Self.seenKey)
  @State private var goToDashboard: Bool = false
  private static let seenKey = "guardian.onboarding.seen"

  var body: some View {
    ZStack {
      if goToDashboard || !showOnboarding {
        GuardianDashboardView()
      } else {
        GuardianOnboardingView {
          UserDefaults.standard.set(true, forKey: Self.seenKey)
          showOnboarding = false
          goToDashboard = true
        }
      }
    }
    .animation(AegisMotion.snappy, value: showOnboarding)
  }
}
