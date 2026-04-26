import SwiftUI

// INITIATE-side sheet for a guardian-triggered safe-word challenge.
// Guardian taps "Challenge" on a family-member row; we ping the
// subject's phone with the challenge prompt they previously agreed on
// together. The subject answers on their device; the backend tells us
// whether the answer matched WITHOUT ever disclosing the word itself —
// so the guardian can't learn the word by probing.
//
// This sheet only handles the INITIATE half (send). The RESPOND half
// (subject types the answer, we show match / no-match) is a separate
// surface owned by a different pass.

struct SafeWordChallengeInitiateSheet: View {
  @Environment(\.dismiss) private var dismiss
  let subjectName: String
  let subjectUserId: String
  let onSuccess: () -> Void

  @State private var inFlight: Bool = false
  @State private var errorMessage: String?
  @State private var didSucceed: Bool = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: AegisSpacing.l) {
          header
          explainer
          if let errorMessage {
            errorBanner(errorMessage)
          }
          if didSucceed {
            successToast
          }
          Spacer(minLength: AegisSpacing.l)
          primaryCTA
          cancelButton
        }
        .padding(AegisSpacing.l)
      }
      .background(AegisColor.background.ignoresSafeArea())
      .toolbar(.hidden, for: .navigationBar)
    }
    // Aging-parent DynamicType: this is a single-decision sheet with
    // one CTA. Clamping at AX3 keeps the CTA on-screen without the user
    // needing to scroll to find it.
    .dynamicTypeSize(...DynamicTypeSize.accessibility3)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "key.radiowaves.forward.fill")
        .font(.system(size: 44, weight: .semibold))
        .foregroundStyle(AegisColor.accent)
      Text("Challenge \(subjectName)")
        .font(AegisType.title)
        .minimumScaleFactor(0.7)
        .foregroundStyle(AegisColor.textPrimary)
    }
  }

  private var explainer: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      Text(
        "We'll ping \(subjectName)'s phone and ask them the safe word you've set up together. You'll see if the answer matches without ever seeing the word itself."
      )
      .font(AegisType.body)
      .foregroundStyle(AegisColor.textPrimary)
      .fixedSize(horizontal: false, vertical: true)

      Text(
        "Use this when a call, text, or voicemail from them feels off — a cloned voice or a fake emergency. If they can answer, it's really them."
      )
      .font(AegisType.caption)
      .foregroundStyle(AegisColor.textSecondary)
      .fixedSize(horizontal: false, vertical: true)
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(AegisColor.verdictSpoofHigh)
      Text(message)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.verdictSpoofHigh.opacity(0.12))
    .overlay(
      RoundedRectangle(cornerRadius: AegisRadius.m)
        .stroke(AegisColor.verdictSpoofHigh.opacity(0.35), lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var successToast: some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: "checkmark.seal.fill")
        .foregroundStyle(AegisColor.verdictTrusted)
      Text("Challenge sent. Watch for their answer.")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.textPrimary)
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.verdictTrusted.opacity(0.15))
    .overlay(
      RoundedRectangle(cornerRadius: AegisRadius.m)
        .stroke(AegisColor.verdictTrusted.opacity(0.4), lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    .transition(.opacity.combined(with: .scale(scale: 0.95)))
  }

  private var primaryCTA: some View {
    Button {
      Task { await send() }
    } label: {
      HStack(spacing: AegisSpacing.s) {
        if inFlight {
          ProgressView().tint(.black).controlSize(.small)
        } else {
          Image(systemName: "paperplane.fill").accessibilityHidden(true)
        }
        Text(didSucceed ? "Sent" : (inFlight ? "Sending…" : "Send challenge"))
          .font(AegisType.bodyBold)
          .minimumScaleFactor(0.7)
          .lineLimit(1)
      }
      .frame(maxWidth: .infinity, minHeight: 54)
      .foregroundStyle(.black)
      .background(didSucceed ? AegisColor.verdictTrusted : AegisColor.accent)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      .opacity((inFlight || didSucceed) ? 0.75 : 1)
    }
    .disabled(inFlight || didSucceed)
  }

  private var cancelButton: some View {
    Button { dismiss() } label: {
      Text(didSucceed ? "Close" : "Cancel")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .frame(maxWidth: .infinity, minHeight: 44)
    }
  }

  private func send() async {
    // Synchronous guard on in-flight. Without it, a double-tap between
    // the tap and the `inFlight = true` assignment below fires two POSTs
    // and the backend would rate-limit the second one into the opaque
    // 403 path, confusing the user.
    guard !inFlight, !didSucceed else { return }
    inFlight = true
    errorMessage = nil
    AegisHaptic.medium.play()
    do {
      _ = try await APIClient.shared.initiateSafeWordChallenge(
        subjectUserId: subjectUserId
      )
      inFlight = false
      withAnimation(AegisMotion.spring) { didSucceed = true }
      AegisHaptic.success.play()
      onSuccess()
      // Short hold so the user sees the confirmation before we yank the
      // sheet away. 1.5s is the Apple HIG sweet spot for non-blocking
      // status toasts.
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      dismiss()
    } catch {
      inFlight = false
      errorMessage = AegisError.from(error).userMessage
      AegisHaptic.error.play()
    }
  }
}
