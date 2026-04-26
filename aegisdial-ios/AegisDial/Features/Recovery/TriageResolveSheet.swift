import SwiftUI

// Shown at the top of the Companion chat when the session is in triage
// mode. User picks one of four outcomes:
//
//   1. "Yes, scam — I didn't send anything"  →  scam_confirmed_no_loss
//      → celebration screen, session closes.
//   2. "Yes, scam — I already sent money"    →  converted_to_recovery
//      → picks scam type + amount → backend generates full step list →
//        RecoverySessionView takes over.
//   3. "Turned out to be legit"              →  not_a_scam
//   4. "Still not sure"                      →  unclear (session stays)

struct TriageResolveSheet: View {
  @Environment(\.dismiss) private var dismiss
  let sessionId: String
  let suggestedScamType: ScamType?
  /// Fired after the server confirms resolution.
  /// The RecoverySession returned has mode/resolvedAs updated.
  let onResolved: (RecoverySession, _ celebrate: Bool) -> Void

  @State private var pickedResolution: APIClient.TriageResolution?
  // nil until the user explicitly picks a chip — so we don't silently
  // submit `generic` (which produces the weakest playbook) if they tap
  // Confirm after only selecting "I already sent money."
  @State private var convertedScamType: ScamType?
  @State private var amountText: String = ""
  @State private var isSubmitting = false
  @State private var errorMessage: String?

  var body: some View {
    NavigationStack {
      ZStack {
        AegisColor.background.ignoresSafeArea()
        ScrollView {
          VStack(alignment: .leading, spacing: AegisSpacing.l) {
            hero
            options
            if pickedResolution == .convertedToRecovery {
              scamTypeSection
              amountSection
            }
            if let errorMessage { errorBanner(errorMessage) }
            confirmButton
          }
          .padding(AegisSpacing.l)
        }
        .scrollDismissesKeyboard(.interactively)
      }
      .navigationTitle("What happened?")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close") { dismiss() }.tint(AegisColor.textSecondary)
        }
      }
      .onAppear {
        convertedScamType = suggestedScamType
      }
    }
    .preferredColorScheme(.dark)
    .interactiveDismissDisabled(isSubmitting)
  }

  private var hero: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "checkmark.bubble.fill")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(AegisColor.accent.gradient)
      Text("Pick the one that fits")
        .font(.system(size: 20, weight: .semibold, design: .rounded))
        .foregroundStyle(AegisColor.textPrimary)
      Text("Based on what we talked about — how do you want to wrap this up?")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var options: some View {
    VStack(spacing: AegisSpacing.s) {
      optionRow(
        .scamConfirmedNoLoss,
        icon: "checkmark.shield.fill",
        tint: AegisColor.verdictTrusted,
        title: "Yes, it was a scam — and I didn't send anything",
        subtitle: "You stopped it in time. We'll celebrate that."
      )
      optionRow(
        .convertedToRecovery,
        icon: "exclamationmark.triangle.fill",
        tint: AegisColor.verdictSpoofHigh,
        title: "Yes, it was a scam — and I already sent money",
        subtitle: "We'll switch to full Recovery Concierge — step-by-step plan starts right now."
      )
      optionRow(
        .notAScam,
        icon: "phone.badge.checkmark",
        tint: AegisColor.textSecondary,
        title: "Turned out to be legit",
        subtitle: "Great news. We'll close this out."
      )
      optionRow(
        .unclear,
        icon: "questionmark.circle",
        tint: AegisColor.textTertiary,
        title: "Still not sure",
        subtitle: "No problem — the chat stays open so you can come back."
      )
    }
  }

  private func optionRow(
    _ res: APIClient.TriageResolution,
    icon: String,
    tint: Color,
    title: String,
    subtitle: String
  ) -> some View {
    let selected = pickedResolution == res
    return Button {
      AegisHaptic.selection.play()
      withAnimation(AegisMotion.snappy) { pickedResolution = res }
    } label: {
      HStack(alignment: .top, spacing: AegisSpacing.m) {
        Image(systemName: icon)
          .font(.system(size: 22, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 32, height: 32)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(AegisType.bodyBold)
            .foregroundStyle(AegisColor.textPrimary)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
          Text(subtitle)
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textSecondary)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer()
        Image(systemName: selected ? "largecircle.fill.circle" : "circle")
          .foregroundStyle(selected ? AegisColor.accent : AegisColor.textTertiary)
      }
      .padding(AegisSpacing.m)
      .background(selected ? AegisColor.surfaceElevated : AegisColor.surface)
      .overlay(
        RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
          .stroke(selected ? AegisColor.accent : .clear, lineWidth: 2)
      )
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .buttonStyle(.plain)
  }

  private var scamTypeSection: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("What type of scam was it?")
      LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: AegisSpacing.s) {
        ForEach(ScamType.allCases.filter { $0 != .generic }) { type in
          scamTypeChip(type)
        }
      }
    }
  }

  private func scamTypeChip(_ type: ScamType) -> some View {
    let selected = convertedScamType == type
    return Button {
      AegisHaptic.selection.play()
      withAnimation(AegisMotion.snappy) { convertedScamType = type }
    } label: {
      HStack(spacing: AegisSpacing.xs) {
        Image(systemName: type.systemIcon)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(selected ? AegisColor.accent : AegisColor.textSecondary)
        Text(type.displayName)
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textPrimary)
          .multilineTextAlignment(.leading)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(AegisSpacing.s)
      .background(selected ? AegisColor.surfaceElevated : AegisColor.surface)
      .overlay(
        RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous)
          .stroke(selected ? AegisColor.accent : AegisColor.hairline, lineWidth: selected ? 2 : 1)
      )
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous))
    }
    .buttonStyle(.plain)
  }

  private var amountSection: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("How much did you lose? (optional)")
      HStack(spacing: AegisSpacing.s) {
        Text("$").font(AegisType.heading).foregroundStyle(AegisColor.textTertiary)
        TextField("0", text: $amountText)
          .keyboardType(.decimalPad)
          .font(.system(size: 22, weight: .semibold, design: .rounded))
          .foregroundStyle(AegisColor.textPrimary)
      }
      .padding(.horizontal, AegisSpacing.m)
      .frame(height: 56)
      .background(AegisColor.surface)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
  }

  private var canConfirm: Bool {
    guard let pickedResolution else { return false }
    if pickedResolution == .convertedToRecovery {
      return convertedScamType != nil
    }
    return true
  }

  private var confirmButton: some View {
    Button {
      AegisHaptic.medium.play()
      Task { await confirm() }
    } label: {
      HStack {
        if isSubmitting { ProgressView().tint(.black) }
        else { Text(confirmCTA).font(AegisType.bodyBold) }
      }
      .frame(maxWidth: .infinity, minHeight: 54)
      .foregroundStyle(.black)
      .background(canConfirm ? AegisColor.textPrimary : AegisColor.textTertiary)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .disabled(!canConfirm || isSubmitting)
  }

  private var confirmCTA: String {
    switch pickedResolution {
    case .convertedToRecovery: "Start Recovery"
    case .scamConfirmedNoLoss: "Finish"
    case .notAScam: "Close"
    case .unclear: "Keep the chat open"
    case .none: "Pick one"
    }
  }

  private func sectionHeader(_ text: String) -> some View {
    Text(text)
      .font(AegisType.caption)
      .foregroundStyle(AegisColor.textTertiary)
      .textCase(.uppercase)
      .tracking(1.2)
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(AegisColor.verdictSpoofHigh)
      Text(message)
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textPrimary)
      Spacer()
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.verdictSpoofHigh.opacity(0.12))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private func confirm() async {
    guard let resolution = pickedResolution, canConfirm else { return }
    isSubmitting = true
    defer { isSubmitting = false }
    errorMessage = nil
    do {
      let amount: Double? = {
        guard resolution == .convertedToRecovery else { return nil }
        return Double(amountText.trimmingCharacters(in: .whitespaces))
      }()
      let scamType: ScamType? = resolution == .convertedToRecovery ? convertedScamType : nil
      let session = try await APIClient.shared.resolveTriage(
        sessionId: sessionId,
        resolvedAs: resolution,
        scamType: scamType,
        amountLostUSD: amount
      )
      AegisHaptic.success.play()
      let celebrate = resolution == .scamConfirmedNoLoss
      onResolved(session, celebrate)
      dismiss()
    } catch {
      AegisHaptic.error.play()
      errorMessage = error.localizedDescription
    }
  }
}
