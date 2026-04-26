import SwiftUI
import UIKit

// Sheet presented from FamilyPlanView and (first-time) from the "Start my
// family plan" CTA. Flow:
//   1. User types a label ("Mom", "Dad", "Kevin" — optional)
//   2. Tap "Create Invite"
//   3. We show the 8-char code + share sheet with pre-formatted message
// Codes expire after 7 days server-side. The sheet stays open so the user
// can tap "Share Code" to send via Messages / Mail / AirDrop without losing
// the code in the meantime.

struct FamilyInviteSheet: View {
  @Environment(\.dismiss) private var dismiss
  let onCreated: () -> Void

  @State private var label: String = ""
  @State private var invite: FamilyInviteResponse?
  @State private var isCreating = false
  @State private var errorMessage: String?
  @State private var showingShareSheet = false

  var body: some View {
    NavigationStack {
      ZStack {
        AegisColor.background.ignoresSafeArea()
        Group {
          if let invite {
            createdView(invite)
          } else {
            formView
          }
        }
      }
      .navigationTitle(invite == nil ? "Invite a Family Member" : "Invite Ready")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(invite == nil ? "Cancel" : "Done") {
            if invite != nil { onCreated() }
            dismiss()
          }.tint(AegisColor.accent)
        }
      }
    }
    .preferredColorScheme(.dark)
    .sheet(isPresented: $showingShareSheet) {
      if let invite {
        ShareSheet(items: [invite.shareMessage])
      }
    }
  }

  // MARK: - Create form

  private var formView: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.l) {
      Text("Give this invite a label so you remember who it's for. They'll use the code you generate to join your plan.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .padding(.top, AegisSpacing.l)

      HStack(spacing: AegisSpacing.s) {
        Image(systemName: "tag.fill")
          .foregroundStyle(AegisColor.textTertiary)
          .frame(width: 22)
        TextField("Mom, Dad, Kevin...", text: $label)
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textPrimary)
          .textInputAutocapitalization(.words)
          .autocorrectionDisabled()
          .tint(AegisColor.accent)
      }
      .padding(.horizontal, AegisSpacing.m)
      .frame(height: 56)
      .background(AegisColor.surface)
      .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairlineStrong, lineWidth: 1))
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))

      if let errorMessage {
        Text(errorMessage)
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.verdictSpoofHigh)
      }

      Spacer()

      Button {
        AegisHaptic.medium.play()
        Task { await create() }
      } label: {
        HStack {
          if isCreating { ProgressView().tint(.black) }
          else { Text("Create Invite").font(AegisType.bodyBold) }
        }
        .frame(maxWidth: .infinity, minHeight: 54)
        .foregroundStyle(.black)
        .background(AegisColor.textPrimary)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      }
      .disabled(isCreating)
    }
    .padding(.horizontal, AegisSpacing.l)
    .padding(.bottom, AegisSpacing.xl)
  }

  // MARK: - Post-create view

  private func createdView(_ invite: FamilyInviteResponse) -> some View {
    VStack(spacing: AegisSpacing.l) {
      Spacer()
      VStack(spacing: AegisSpacing.s) {
        Image(systemName: "checkmark.seal.fill")
          .font(.system(size: 48, weight: .semibold))
          .foregroundStyle(AegisColor.verdictTrusted)
        Text("Invite created")
          .font(AegisType.heading)
          .foregroundStyle(AegisColor.textPrimary)
        if let label = invite.label {
          Text("for \(label)")
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textSecondary)
        }
      }

      // Big, scannable code display
      VStack(spacing: AegisSpacing.xs) {
        Text("Invite code")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
          .textCase(.uppercase)
          .tracking(1.2)
        Text(formattedCode(invite.code))
          .font(.system(size: 36, weight: .bold, design: .monospaced))
          .foregroundStyle(AegisColor.textPrimary)
          .tracking(4)
          .padding(.vertical, AegisSpacing.m)
          .padding(.horizontal, AegisSpacing.l)
          .background(AegisColor.surfaceElevated)
          .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.accent.opacity(0.6), lineWidth: 2))
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        Text("Expires in 7 days")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
      }

      Spacer()

      VStack(spacing: AegisSpacing.s) {
        Button {
          AegisHaptic.medium.play()
          showingShareSheet = true
        } label: {
          Label("Share Code", systemImage: "square.and.arrow.up")
            .font(AegisType.bodyBold)
            .frame(maxWidth: .infinity, minHeight: 54)
            .foregroundStyle(.black)
            .background(AegisColor.textPrimary)
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        }
        Button {
          UIPasteboard.general.string = invite.code
          AegisHaptic.success.play()
        } label: {
          Label("Copy Code", systemImage: "doc.on.doc")
            .font(AegisType.bodyBold)
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(AegisColor.textPrimary)
            .background(AegisColor.surface)
            .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairlineStrong, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        }
      }
    }
    .padding(.horizontal, AegisSpacing.l)
    .padding(.bottom, AegisSpacing.xl)
  }

  private func formattedCode(_ code: String) -> String {
    guard code.count == 8 else { return code }
    let mid = code.index(code.startIndex, offsetBy: 4)
    return "\(code[..<mid])-\(code[mid...])"
  }

  // MARK: - Actions

  private func create() async {
    isCreating = true
    defer { isCreating = false }
    errorMessage = nil
    do {
      let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
      let response = try await APIClient.shared.createFamilyInvite(
        label: trimmedLabel.isEmpty ? nil : trimmedLabel,
        contact: nil
      )
      invite = response
      AegisHaptic.success.play()
    } catch {
      AegisHaptic.error.play()
      errorMessage = error.localizedDescription
    }
  }
}

// UIKit share sheet wrapper. SwiftUI's ShareLink is iOS 16+ and works, but
// passing a plain String through UIActivityViewController gives us more
// control over which apps appear (Messages + Mail + AirDrop as the common
// cases for sharing a family invite code).
struct ShareSheet: UIViewControllerRepresentable {
  let items: [Any]

  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: items, applicationActivities: nil)
  }
  func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
