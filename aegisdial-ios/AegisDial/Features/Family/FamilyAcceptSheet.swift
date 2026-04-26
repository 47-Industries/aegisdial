import SwiftUI

// Sheet for joining an existing family plan by entering a code. The input
// accepts the code with or without the hyphen (we uppercase + strip the
// hyphen before calling the API, which is also what the backend does).

struct FamilyAcceptSheet: View {
  @Environment(\.dismiss) private var dismiss
  let onAccepted: () -> Void

  @State private var code: String = ""
  @State private var isJoining = false
  @State private var errorMessage: String?
  @State private var joined = false
  @FocusState private var isFocused: Bool

  var body: some View {
    NavigationStack {
      ZStack {
        AegisColor.background.ignoresSafeArea()
        Group {
          if joined { joinedView }
          else { formView }
        }
      }
      .navigationTitle(joined ? "Welcome" : "Join a Family Plan")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(joined ? "Done" : "Cancel") {
            if joined { onAccepted() }
            dismiss()
          }.tint(AegisColor.accent)
        }
      }
    }
    .preferredColorScheme(.dark)
  }

  private var formView: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.l) {
      Text("Someone in your family shared a code with you. Enter it below to join their AegisDial plan — no subscription required.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .padding(.top, AegisSpacing.l)

      VStack(alignment: .leading, spacing: AegisSpacing.s) {
        Text("Invite Code")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
          .textCase(.uppercase)
          .tracking(1.2)

        TextField("XXXX-XXXX", text: Binding(
          get: { code },
          set: { code = $0.uppercased().filter { $0.isLetter || $0.isNumber || $0 == "-" } }
        ))
        .font(.system(size: 28, weight: .bold, design: .monospaced))
        .tracking(4)
        .foregroundStyle(AegisColor.textPrimary)
        .autocorrectionDisabled()
        .textInputAutocapitalization(.characters)
        .keyboardType(.asciiCapable)
        .submitLabel(.go)
        .focused($isFocused)
        .onSubmit { Task { await join() } }
        .tint(AegisColor.accent)
        .padding(AegisSpacing.m)
        .frame(maxWidth: .infinity)
        .background(AegisColor.surface)
        .overlay(
          RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
            .stroke(isFocused ? AegisColor.accent.opacity(0.7) : AegisColor.hairlineStrong, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        .animation(AegisMotion.snappy, value: isFocused)
      }

      if let errorMessage {
        Text(friendlyError(errorMessage))
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.verdictSpoofHigh)
      }

      Spacer()

      Button {
        AegisHaptic.medium.play()
        Task { await join() }
      } label: {
        HStack {
          if isJoining { ProgressView().tint(.black) }
          else { Text("Join Plan").font(AegisType.bodyBold) }
        }
        .frame(maxWidth: .infinity, minHeight: 54)
        .foregroundStyle(.black)
        .background(AegisColor.textPrimary)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        .opacity(canJoin ? 1 : 0.35)
      }
      .disabled(!canJoin || isJoining)
    }
    .padding(.horizontal, AegisSpacing.l)
    .padding(.bottom, AegisSpacing.xl)
    .onAppear { isFocused = true }
  }

  private var joinedView: some View {
    VStack(spacing: AegisSpacing.l) {
      Spacer()
      Image(systemName: "checkmark.shield.fill")
        .font(.system(size: 56, weight: .semibold))
        .foregroundStyle(AegisColor.verdictTrusted)
        .symbolEffect(.bounce, options: .nonRepeating)
      VStack(spacing: AegisSpacing.s) {
        Text("You're protected")
          .font(AegisType.heading)
          .foregroundStyle(AegisColor.textPrimary)
        Text("Your AegisDial protection is now active. Incoming calls will be analyzed in real time, and you'll see evidence behind every verdict.")
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textSecondary)
          .multilineTextAlignment(.center)
          .padding(.horizontal, AegisSpacing.l)
      }
      Spacer()
      Button {
        onAccepted()
        dismiss()
      } label: {
        Text("Get Started")
          .font(AegisType.bodyBold)
          .frame(maxWidth: .infinity, minHeight: 54)
          .foregroundStyle(.black)
          .background(AegisColor.textPrimary)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      }
      .padding(.horizontal, AegisSpacing.l)
      .padding(.bottom, AegisSpacing.xl)
    }
  }

  private var canJoin: Bool {
    let stripped = code.replacingOccurrences(of: "-", with: "")
    return stripped.count >= 4 && stripped.count <= 16
  }

  // Surface backend error codes as something a non-technical user understands.
  private func friendlyError(_ raw: String) -> String {
    let lower = raw.lowercased()
    if lower.contains("invite_not_found") { return "That code isn't valid. Double-check and try again." }
    if lower.contains("invite_expired") { return "That invite expired. Ask your family member to send a new code." }
    if lower.contains("already_on_plan") { return "You're already on a family plan. Leave it first to join a new one." }
    if lower.contains("cannot_join_own_plan") { return "You can't join your own plan. Share the code with someone else." }
    if lower.contains("plan_at_capacity") { return "That plan is full. Ask the owner to remove someone or upgrade." }
    return raw
  }

  private func join() async {
    let normalized = code.replacingOccurrences(of: "-", with: "").uppercased()
    guard !normalized.isEmpty else { return }
    isJoining = true
    defer { isJoining = false }
    errorMessage = nil
    do {
      _ = try await APIClient.shared.acceptFamilyInvite(code: normalized)
      AegisHaptic.success.play()
      joined = true
    } catch {
      AegisHaptic.error.play()
      errorMessage = error.localizedDescription
    }
  }
}
