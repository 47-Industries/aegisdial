import SwiftUI

// Account deletion — App Store guideline 5.1.1(v) requires this be
// reachable in-app. We do NOT soft-delete: a successful DELETE /v1/users/me
// cascades every row in the database (family contacts, breach monitors,
// call sessions, recoveries — everything).
//
// Double safeguard: the user must type DELETE in all caps before the
// button enables. That way a single accidental tap can't wipe their
// footprint.

struct DeleteAccountSheet: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(AuthStore.self) private var auth
  @State private var typedConfirmation: String = ""
  @State private var deleting: Bool = false
  @State private var errorText: String?

  private let requiredText = "DELETE"

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: AegisSpacing.l) {
          header
          whatHappens
          confirmField
          if let errorText {
            Text(errorText)
              .font(AegisType.caption)
              .foregroundStyle(AegisColor.verdictSpoofHigh)
          }
          deleteButton
          cancelButton
        }
        .padding(AegisSpacing.l)
      }
      .background(AegisColor.background.ignoresSafeArea())
      .navigationTitle("Delete Account")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Cancel") { dismiss() }
            .accessibilityLabel("Cancel delete account")
        }
      }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "person.crop.circle.badge.xmark.fill")
        .font(.system(size: 40, weight: .semibold))
        .foregroundStyle(AegisColor.verdictSpoofHigh)
      Text("This deletes everything.")
        .font(.system(size: 24, weight: .bold))
        .foregroundStyle(AegisColor.textPrimary)
      Text("You can't undo this. If you'd rather just pause, you can cancel your subscription in Settings → Manage in App Store and keep the account.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
    }
  }

  private var whatHappens: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      Text("What gets deleted")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.textPrimary)
      VStack(alignment: .leading, spacing: 8) {
        bullet("Your account and sign-in")
        bullet("Every family contact and safe word")
        bullet("Every saved number and lookup history")
        bullet("Every shielded call transcript")
        bullet("Every breach monitor and alert")
        bullet("Your recovery sessions and any guardian alerts about you")
        bullet("Your device push token")
      }
      Text("If you're on a family plan, the plan stays active but you leave it. Your subscription does not automatically cancel — manage that in the App Store.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textSecondary)
        .padding(.top, AegisSpacing.s)
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private func bullet(_ text: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text("•").foregroundStyle(AegisColor.textSecondary)
      Text(text).foregroundStyle(AegisColor.textSecondary)
    }
    .font(AegisType.body)
  }

  private var confirmField: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Text("Type DELETE to confirm")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.textPrimary)
      TextField("DELETE", text: $typedConfirmation)
        .autocorrectionDisabled()
        .textInputAutocapitalization(.characters)
        .font(AegisType.mono)
        .padding(AegisSpacing.m)
        .background(AegisColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous))
    }
  }

  private var isReady: Bool {
    typedConfirmation.trimmingCharacters(in: .whitespaces) == requiredText && !deleting
  }

  private var deleteButton: some View {
    Button {
      Task { await deleteAccount() }
    } label: {
      HStack {
        if deleting { ProgressView().tint(.white) }
        Text(deleting ? "Deleting…" : "Delete my account")
          .font(AegisType.bodyBold)
      }
      .foregroundStyle(.white)
      .frame(maxWidth: .infinity, minHeight: 54)
      .background(isReady ? AegisColor.verdictSpoofHigh : AegisColor.surface)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .disabled(!isReady)
    .accessibilityLabel("Delete my account")
    .accessibilityHint(isReady ? "Permanently deletes all your data" : "Type DELETE in the field above to enable")
  }

  private var cancelButton: some View {
    Button { dismiss() } label: {
      Text("Keep my account")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.accent)
        .frame(maxWidth: .infinity, minHeight: 50)
    }
  }

  private func deleteAccount() async {
    deleting = true
    defer { deleting = false }
    do {
      try await APIClient.shared.deleteAccount()
      AegisHaptic.warning.play()
      auth.signOut()
      dismiss()
    } catch {
      errorText = error.localizedDescription
      AegisHaptic.error.play()
    }
  }
}
