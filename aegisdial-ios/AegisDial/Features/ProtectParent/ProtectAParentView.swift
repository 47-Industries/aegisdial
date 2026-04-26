import SwiftUI

// Protect-a-Parent flow. Primary-buyer framing: the adult child is our
// first-call customer. This view is a three-step guided flow that compresses
// "add parent → set safe word → turn on Guardian push" into a single path
// the user can finish in under 90 seconds.
//
// Every step fires a funnel event so we can see where adult children drop
// off. The steps are deliberately tiny and skippable — dropout on step 3
// still leaves a protected parent.

struct ProtectAParentView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var step: Step = .invite
  @State private var parentName: String = ""
  @State private var parentPhone: String = ""
  @State private var safeWord: String = ""
  @State private var inviteCode: String?
  @State private var errorMessage: String?
  @State private var isWorking: Bool = false

  private enum Step: Int, CaseIterable {
    case invite = 0
    case safeWord = 1
    case notifications = 2
    case done = 3

    var title: String {
      switch self {
      case .invite: "Add your parent"
      case .safeWord: "Set a safe word"
      case .notifications: "Turn on alerts"
      case .done: "You're set"
      }
    }

    var subtitle: String {
      switch self {
      case .invite:
        "Send them an invite code. They install AegisDial and paste it — we'll do the rest."
      case .safeWord:
        "A phrase only the two of you know. If someone calls claiming to be them, you'll verify it in-app. A voice clone won't know it."
      case .notifications:
        "The moment one of their calls goes critical, your phone buzzes. Without notifications, alerts only land in-app."
      case .done:
        "You're watching over them. You'll see every critical alert in the Guardian tab."
      }
    }
  }

  var body: some View {
    ZStack {
      AegisColor.background.ignoresSafeArea()
      ScrollView {
        VStack(alignment: .leading, spacing: AegisSpacing.l) {
          progressBar
          hero
          stepContent
          if let errorMessage { errorBanner(errorMessage) }
          actionButton
          skipButton
        }
        .padding(AegisSpacing.l)
      }
      .scrollDismissesKeyboard(.interactively)
    }
    .navigationTitle("Protect a Parent")
    .navigationBarTitleDisplayMode(.inline)
    .preferredColorScheme(.dark)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button("Close") { dismiss() }.tint(AegisColor.textSecondary)
      }
    }
    .onAppear {
      Track.event(.protectParentFlowStarted)
    }
    .onDisappear {
      if step == .done { Track.event(.protectParentFlowCompleted) }
    }
  }

  // MARK: - Sections

  private var progressBar: some View {
    HStack(spacing: AegisSpacing.xs) {
      ForEach(0..<3, id: \.self) { i in
        RoundedRectangle(cornerRadius: 2)
          .fill(i <= step.rawValue ? AegisColor.accent : AegisColor.surface)
          .frame(height: 4)
      }
    }
  }

  private var hero: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: iconForStep(step))
        .font(.system(size: 32, weight: .semibold))
        .foregroundStyle(AegisColor.accent.gradient)
      Text(step.title)
        .font(.system(size: 24, weight: .semibold, design: .rounded))
        .foregroundStyle(AegisColor.textPrimary)
      Text(step.subtitle)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func iconForStep(_ s: Step) -> String {
    switch s {
    case .invite: "person.crop.circle.badge.plus"
    case .safeWord: "key.horizontal.fill"
    case .notifications: "bell.badge.fill"
    case .done: "checkmark.seal.fill"
    }
  }

  @ViewBuilder
  private var stepContent: some View {
    switch step {
    case .invite:
      inviteStep
    case .safeWord:
      safeWordStep
    case .notifications:
      notificationsStep
    case .done:
      doneStep
    }
  }

  private var inviteStep: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      input(
        icon: "person.fill",
        placeholder: "Parent's name (e.g. Mom)",
        text: $parentName,
        content: .name
      )
      input(
        icon: "phone.fill",
        placeholder: "Their phone number (optional)",
        text: $parentPhone,
        content: .telephoneNumber,
        keyboard: .phonePad
      )
      Text("We'll generate an invite code. Text it to them — they'll install AegisDial and paste it on first launch.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
    }
  }

  private var safeWordStep: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      if let code = inviteCode {
        inviteCodeCard(code)
      }
      input(
        icon: "key.fill",
        placeholder: "A word or short phrase",
        text: $safeWord,
        content: .oneTimeCode
      )
      Text("Not a password. Something you'd both remember easily but a scammer couldn't guess — a childhood pet, a family joke, the nickname only they'd know.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
    }
  }

  private var notificationsStep: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      HStack(spacing: AegisSpacing.s) {
        Image(systemName: "checkmark.circle.fill")
          .foregroundStyle(AegisColor.verdictTrusted)
        Text("Invite sent to \(parentName.isEmpty ? "them" : parentName)")
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textPrimary)
      }
      if !safeWord.isEmpty {
        HStack(spacing: AegisSpacing.s) {
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(AegisColor.verdictTrusted)
          Text("Safe word saved")
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textPrimary)
        }
      }
      Text("One last step: let us ping you when it matters. Without notifications, critical alerts only land when you open the app.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .padding(.top, AegisSpacing.s)
    }
  }

  private var doneStep: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      Label("They're on your plan", systemImage: "checkmark.seal.fill")
        .foregroundStyle(AegisColor.verdictTrusted)
      Label("Safe word is set", systemImage: "checkmark.seal.fill")
        .foregroundStyle(AegisColor.verdictTrusted)
      Label("You'll get critical-call alerts", systemImage: "checkmark.seal.fill")
        .foregroundStyle(AegisColor.verdictTrusted)
      Text("View their status any time in the Guardian tab.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .padding(.top, AegisSpacing.s)
    }
  }

  private func inviteCodeCard(_ code: String) -> some View {
    VStack(alignment: .leading, spacing: AegisSpacing.xs) {
      Text("INVITE CODE")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .tracking(1.2)
      HStack {
        Text(code)
          .font(.system(size: 24, weight: .bold, design: .monospaced))
          .foregroundStyle(AegisColor.textPrimary)
        Spacer()
        Button {
          UIPasteboard.general.string = code
          AegisHaptic.success.play()
        } label: {
          Image(systemName: "doc.on.doc.fill")
            .foregroundStyle(AegisColor.accent)
        }
      }
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surfaceElevated)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var actionButton: some View {
    Button {
      AegisHaptic.medium.play()
      Task { await advance() }
    } label: {
      HStack {
        if isWorking { ProgressView().tint(.black) }
        else {
          Text(primaryCTA).font(AegisType.bodyBold)
          if step != .done { Image(systemName: "arrow.right").font(.system(size: 14, weight: .bold)) }
        }
      }
      .frame(maxWidth: .infinity, minHeight: 54)
      .foregroundStyle(.black)
      .background(AegisColor.textPrimary)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      .opacity(canAdvance ? 1 : 0.4)
    }
    .disabled(!canAdvance || isWorking)
  }

  private var skipButton: some View {
    Group {
      if step != .done {
        Button {
          Track.event(.onboardingTourSkipped, [
            "flow": "protect_parent",
            "last_step": step.rawValue,
          ])
          dismiss()
        } label: {
          Text("Not now")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textTertiary)
            .frame(maxWidth: .infinity, minHeight: 44)
        }
      }
    }
  }

  // MARK: - Logic

  private var primaryCTA: String {
    switch step {
    case .invite: "Send invite"
    case .safeWord: "Save safe word"
    case .notifications: "Turn on alerts"
    case .done: "Done"
    }
  }

  private var canAdvance: Bool {
    switch step {
    case .invite: return !parentName.trimmingCharacters(in: .whitespaces).isEmpty
    case .safeWord: return safeWord.trimmingCharacters(in: .whitespaces).count >= 3
    case .notifications: return true
    case .done: return true
    }
  }

  private func advance() async {
    errorMessage = nil
    switch step {
    case .invite:
      isWorking = true
      defer { isWorking = false }
      do {
        let invite = try await APIClient.shared.createFamilyInvite(
          label: parentName.trimmingCharacters(in: .whitespaces),
          contact: parentPhone.isEmpty ? nil : parentPhone
        )
        inviteCode = invite.code
        Track.event(.protectParentInviteSent, [
          "has_phone": !parentPhone.isEmpty,
        ])
        withAnimation(AegisMotion.snappy) { step = .safeWord }
      } catch {
        errorMessage = error.localizedDescription
      }
    case .safeWord:
      // Safe words bind to a saved family contact in the current schema.
      // The parent joins via the invite code — their FamilyContact row is
      // created server-side on accept. Until that happens we save the
      // chosen phrase locally and surface a prompt on the Contacts tab
      // once they're linked.
      UserDefaults.standard.set(
        safeWord.trimmingCharacters(in: .whitespaces),
        forKey: "protect_parent.pending_safeword"
      )
      UserDefaults.standard.set(
        parentName.trimmingCharacters(in: .whitespaces),
        forKey: "protect_parent.pending_name"
      )
      Track.event(.protectParentSafeWordSaved)
      withAnimation(AegisMotion.snappy) { step = .notifications }
    case .notifications:
      isWorking = true
      defer { isWorking = false }
      await PushRegistrar.shared.requestAndRegister()
      withAnimation(AegisMotion.snappy) { step = .done }
    case .done:
      dismiss()
    }
  }

  // MARK: - Helpers

  private func input(
    icon: String,
    placeholder: String,
    text: Binding<String>,
    content: UITextContentType,
    keyboard: UIKeyboardType = .default
  ) -> some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: icon)
        .font(.system(size: 16, weight: .medium))
        .foregroundStyle(AegisColor.textTertiary)
        .frame(width: 22)
      TextField(placeholder, text: text)
        .textContentType(content)
        .keyboardType(keyboard)
        .autocorrectionDisabled()
        .textInputAutocapitalization(content == .name ? .words : .never)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textPrimary)
        .tint(AegisColor.accent)
    }
    .padding(.horizontal, AegisSpacing.m)
    .frame(height: 56)
    .background(AegisColor.surface)
    .overlay(
      RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
        .stroke(AegisColor.hairlineStrong, lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
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
}
