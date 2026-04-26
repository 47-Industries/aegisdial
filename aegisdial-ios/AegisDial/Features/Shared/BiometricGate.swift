import SwiftUI
import LocalAuthentication

// View modifier that gates its content behind FaceID / TouchID /
// passcode. Used for sensitive surfaces (recovery history, account
// deletion) — the user has to prove they're the device owner before
// revealing past-scam context that someone borrowing the phone
// shouldn't see.
//
// Falls back to passcode automatically if biometrics are unenrolled.
// If the device has no passcode at all (older iPhones without a
// Lock Screen), we skip the gate — forcing a passcode where none
// exists would just lock the user out.

struct BiometricGate<Content: View>: View {
  let reason: String
  @ViewBuilder let content: () -> Content

  @State private var unlocked: Bool = false
  @State private var attempting: Bool = false
  @State private var errorText: String?

  var body: some View {
    if unlocked {
      content()
    } else {
      lockScreen
        .task { await attemptUnlock() }
    }
  }

  private var lockScreen: some View {
    VStack(spacing: AegisSpacing.l) {
      Image(systemName: "faceid")
        .font(.system(size: 56, weight: .semibold))
        .foregroundStyle(AegisColor.accent)
        .accessibilityHidden(true)
      Text("Verify it's you")
        .font(AegisType.heading)
        .foregroundStyle(AegisColor.textPrimary)
      Text(reason)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, AegisSpacing.l)
      if let errorText {
        Text(errorText)
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.verdictSpoofHigh)
      }
      Button {
        Task { await attemptUnlock() }
      } label: {
        Text(attempting ? "Unlocking..." : "Unlock")
          .font(AegisType.bodyBold)
          .foregroundStyle(.black)
          .frame(maxWidth: .infinity, minHeight: 54)
          .background(AegisColor.accent)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      }
      .disabled(attempting)
      .padding(.horizontal, AegisSpacing.l)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(AegisColor.background)
  }

  private func attemptUnlock() async {
    attempting = true
    defer { attempting = false }

    let context = LAContext()
    var error: NSError?
    let policy: LAPolicy = .deviceOwnerAuthentication // biometrics with passcode fallback

    guard context.canEvaluatePolicy(policy, error: &error) else {
      // Device has no passcode — skip the gate, show content. This is
      // rare post-2018 iPhones but exists.
      unlocked = true
      return
    }

    do {
      let ok = try await context.evaluatePolicy(policy, localizedReason: reason)
      if ok {
        AegisHaptic.success.play()
        unlocked = true
      }
    } catch let laError as LAError {
      switch laError.code {
      case .userCancel, .systemCancel, .appCancel:
        errorText = nil // user bailed; leave them on the lock screen
      case .biometryLockout:
        errorText = "Face ID is locked. Enter your passcode using the Unlock button."
      case .authenticationFailed:
        errorText = "Didn't recognize you. Try again."
      default:
        errorText = laError.localizedDescription
      }
      AegisHaptic.error.play()
    } catch {
      errorText = error.localizedDescription
    }
  }
}

extension View {
  /// Wrap self in a biometric gate. Shown content unlocks after FaceID,
  /// TouchID, or passcode.
  func biometricallyGated(reason: String) -> some View {
    BiometricGate(reason: reason) { self }
  }
}
