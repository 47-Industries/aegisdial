import SwiftUI
import UIKit

// Deepfake-defense panel. Renders when the backend sets
// `family_verify_suggested = true` on a transcript response. The user
// can:
//   - instantly dial the saved contact's known-good number
//   - ask the caller for a safe word + verify against their hash
//   - ask the caller their registered challenge question
//   - call a guardian (for elderly primary users who need backup)
//
// All buttons stay usable during the call so a scared user doesn't have
// to remember what to do — this panel tells them.

struct FamilyVerifyPanel: View {
  let suggestion: FamilySuggestion
  let callSessionId: String?
  @State private var safeWordInput: String = ""
  @State private var verifying: Bool = false
  @State private var verifyResult: Bool?
  @State private var challengeRevealed: Bool = false
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      header
      if let contact = suggestion.matchedContact {
        matchedCallBack(contact)
        if contact.hasSafeWord == true {
          safeWordChecker(contact)
        }
        if contact.hasChallenge == true, let prompt = contact.challengePrompt {
          challengeReveal(prompt)
        }
      } else {
        unknownContactWarning
      }
      if !suggestion.guardianContacts.isEmpty {
        guardianQuickDial
      }
    }
    .padding(AegisSpacing.l)
    .background(AegisColor.surface)
    .overlay(
      RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous)
        .stroke(AegisColor.verdictSpoofHigh, lineWidth: 2)
    )
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous))
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Image(systemName: "person.crop.circle.badge.exclamationmark")
          .foregroundStyle(AegisColor.verdictSpoofHigh)
        Text("VERIFY THIS FAMILY MEMBER")
          .font(AegisType.caption)
          .tracking(1.4)
          .foregroundStyle(AegisColor.verdictSpoofHigh)
      }
      Text(suggestion.instruction)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textPrimary)
    }
  }

  private func matchedCallBack(_ contact: FamilyContactBrief) -> some View {
    Button {
      dial(contact.phone)
    } label: {
      HStack(spacing: 12) {
        Image(systemName: "phone.arrow.up.right.fill")
          .font(.system(size: 20, weight: .semibold))
        VStack(alignment: .leading, spacing: 2) {
          Text("Call \(contact.displayName) back")
            .font(AegisType.bodyBold)
            .foregroundStyle(AegisColor.textPrimary)
          Text(contact.phone)
            .font(AegisType.caption.monospaced())
            .foregroundStyle(AegisColor.textSecondary)
        }
        Spacer()
        Image(systemName: "chevron.right")
          .foregroundStyle(AegisColor.textSecondary)
      }
      .padding(AegisSpacing.m)
      .background(AegisColor.surfaceElevated)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .buttonStyle(.plain)
  }

  private func safeWordChecker(_ contact: FamilyContactBrief) -> some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Text("Ask them for your safe word")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.textPrimary)
      Text("A voice clone won't know it. If they get it wrong, hang up.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textSecondary)
      HStack {
        TextField("Type what they said", text: $safeWordInput)
          .focused($focused)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .font(AegisType.body)
          .padding(AegisSpacing.s)
          .background(AegisColor.background)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous))
          .onChange(of: safeWordInput) { _, _ in verifyResult = nil }
        Button { verify(contact) } label: {
          Text(verifying ? "…" : "Check")
            .font(AegisType.bodyBold)
            .foregroundStyle(.black)
            .padding(.horizontal, AegisSpacing.m)
            .padding(.vertical, AegisSpacing.s)
            .background(AegisColor.accent)
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous))
        }
        .disabled(safeWordInput.isEmpty || verifying)
      }
      if let r = verifyResult {
        HStack(spacing: 6) {
          Image(systemName: r ? "checkmark.seal.fill" : "xmark.octagon.fill")
          Text(r ? "Match — this is probably the real person." : "NO MATCH — hang up and call them back.")
        }
        .font(AegisType.bodyBold)
        .foregroundStyle(r ? AegisColor.verdictTrusted : AegisColor.verdictSpoofHigh)
      }
    }
  }

  private func challengeReveal(_ prompt: String) -> some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Text("Challenge question")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.textPrimary)
      if challengeRevealed {
        Text(prompt)
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textPrimary)
          .padding(AegisSpacing.m)
          .background(AegisColor.background)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous))
      } else {
        Button { challengeRevealed = true } label: {
          Text("Show challenge question")
            .font(AegisType.bodyBold)
            .foregroundStyle(AegisColor.accent)
        }
      }
    }
  }

  private var unknownContactWarning: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("This number is not saved as family.")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.verdictSpoofHigh)
      Text("Voice-cloning scams spoof family members' voices. Never send money to an unsaved number claiming to be family — call a known relative first to confirm.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textSecondary)
    }
  }

  private var guardianQuickDial: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Text("Or call your guardian")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.textPrimary)
      ForEach(suggestion.guardianContacts, id: \.id) { g in
        Button { dial(g.phone) } label: {
          HStack(spacing: 10) {
            Image(systemName: "shield.checkerboard")
              .foregroundStyle(AegisColor.accent)
            Text(g.displayName).font(AegisType.bodyBold).foregroundStyle(AegisColor.textPrimary)
            Spacer()
            Text(g.phone).font(AegisType.caption.monospaced()).foregroundStyle(AegisColor.textSecondary)
          }
          .padding(AegisSpacing.s)
          .background(AegisColor.surfaceElevated)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous))
        }
        .buttonStyle(.plain)
      }
    }
  }

  private func dial(_ phone: String) {
    let digits = phone.filter { $0.isNumber || $0 == "+" }
    if let url = URL(string: "tel://\(digits)") {
      UIApplication.shared.open(url)
    }
  }

  private func verify(_ contact: FamilyContactBrief) {
    verifying = true
    let value = safeWordInput
    Task {
      do {
        let match = try await APIClient.shared.verifyFamilyContact(
          id: contact.id,
          value: value,
          kind: "safe_word",
          callSessionId: callSessionId
        )
        await MainActor.run {
          verifyResult = match
          verifying = false
          if !match {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
          } else {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
          }
        }
      } catch {
        await MainActor.run {
          verifyResult = false
          verifying = false
        }
      }
    }
  }
}
