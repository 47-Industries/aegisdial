import SwiftUI

// Permission priming. Shown BEFORE we trigger any iOS permission
// prompt. iOS only lets us ask for each permission ONCE per install —
// if the user taps "Don't Allow" on the system alert, we can't ask
// again without sending them to Settings. Priming with context
// measurably improves first-time grant rates (Apple-cited data: ~3×).

struct PermissionPrimingView: View {
  let kind: Kind
  let onContinue: () -> Void
  let onDismiss: () -> Void

  enum Kind {
    case microphoneAndSpeech
    case notifications
    case contacts

    var icon: String {
      switch self {
      case .microphoneAndSpeech: return "waveform.circle.fill"
      case .notifications: return "bell.badge.circle.fill"
      case .contacts: return "person.2.circle.fill"
      }
    }

    var title: String {
      switch self {
      case .microphoneAndSpeech: return "We need your mic to listen for scams"
      case .notifications: return "We'll only notify you when it matters"
      case .contacts: return "Import family faster"
      }
    }

    var points: [(icon: String, label: String)] {
      switch self {
      case .microphoneAndSpeech:
        return [
          ("lock.shield.fill", "Audio NEVER leaves your phone. Apple's on-device speech recognizer transcribes the call locally."),
          ("bolt.fill", "We only check for known scam phrases — \"safe account,\" \"don't hang up,\" \"gift cards,\" etc."),
          ("trash.slash.fill", "The transcript is deleted the moment the call ends."),
        ]
      case .notifications:
        return [
          ("exclamationmark.octagon.fill", "When a family member's shielded call goes critical, you'll know within seconds."),
          ("shield.lefthalf.filled", "When a new breach exposes your email or phone, we'll flag it."),
          ("moon.fill", "We don't send marketing pushes. Ever."),
        ]
      case .contacts:
        return [
          ("person.3.fill", "Pick family members from your contacts list instead of typing each one."),
          ("lock.shield.fill", "We only read contacts when you tap \"Import\" — never in the background."),
          ("trash.slash.fill", "Nothing leaves your phone. Imported names + phones stay on-device."),
        ]
      }
    }

    var ctaLabel: String {
      switch self {
      case .microphoneAndSpeech: return "Ask iOS for permission"
      case .notifications:       return "Turn on notifications"
      case .contacts:            return "Pick from my contacts"
      }
    }
  }

  var body: some View {
    ZStack {
      AegisColor.background.ignoresSafeArea()
      ScrollView {
        VStack(alignment: .leading, spacing: AegisSpacing.l) {
          header
          bullets
          Spacer(minLength: AegisSpacing.xl)
          continueButton
          dismissButton
        }
        .padding(AegisSpacing.l)
      }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: kind.icon)
        .font(.system(size: 56, weight: .semibold))
        .foregroundStyle(AegisColor.accent)
        .accessibilityHidden(true)
      Text(kind.title)
        .font(.system(size: 28, weight: .bold))
        .foregroundStyle(AegisColor.textPrimary)
        .padding(.top, AegisSpacing.s)
    }
  }

  private var bullets: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      ForEach(Array(kind.points.enumerated()), id: \.offset) { _, point in
        HStack(alignment: .top, spacing: AegisSpacing.m) {
          Image(systemName: point.icon)
            .font(.system(size: 22, weight: .semibold))
            .foregroundStyle(AegisColor.accent)
            .frame(width: 32)
            .accessibilityHidden(true)
          Text(point.label)
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textSecondary)
        }
      }
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var continueButton: some View {
    Button(action: onContinue) {
      Text(kind.ctaLabel)
        .font(AegisType.bodyBold)
        .foregroundStyle(.black)
        .frame(maxWidth: .infinity, minHeight: 54)
        .background(AegisColor.accent)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .accessibilityLabel(kind.ctaLabel)
  }

  private var dismissButton: some View {
    Button(action: onDismiss) {
      Text("Not right now")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.textSecondary)
        .frame(maxWidth: .infinity, minHeight: 50)
    }
  }
}
