import SwiftUI
import UIKit

// Plan-owner transfer — ACCEPT side. Reached from:
//   1. FamilyPlanView (member sees "Accept transferred ownership" row)
//   2. Settings (same sheet, different launch point — defer wiring to
//      Settings agent; this view is ready as soon as its presenter is)
//   3. Deep link `aegisdial://family/transfer/accept?token=…` — deep
//      link resolution itself is deferred to a top-level router; this
//      sheet accepts a pre-seeded token via `initialInput` so a future
//      router can pass the pasted/clicked value in without a second
//      paste step.
//
// Token extraction tolerates either a raw base64-ish token OR the full
// share URL shape (scheme + host + query). A member who copies the
// Messages preview gets the URL; a member who copies from the owner's
// pasteboard gets the raw token. Both paths converge on the same POST.

struct PlanOwnerTransferAcceptSheet: View {
  @Environment(\.dismiss) private var dismiss

  /// Optional pre-seeded value from a deep-link handoff. When present,
  /// the input field is pre-filled and the primary CTA is enabled.
  var initialInput: String = ""
  let onAccepted: () -> Void

  @State private var pasted: String = ""
  @State private var isAccepting = false
  @State private var errorMessage: String?
  @State private var accepted = false
  @State private var showingConfirm = false
  @FocusState private var isFocused: Bool

  var body: some View {
    NavigationStack {
      ZStack {
        AegisColor.background.ignoresSafeArea()
        Group {
          if accepted { acceptedView }
          else { formView }
        }
      }
      .navigationTitle(accepted ? "You're the Owner" : "Accept Ownership")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(accepted ? "Done" : "Cancel") {
            if accepted { onAccepted() }
            dismiss()
          }
          .tint(AegisColor.accent)
        }
      }
    }
    .preferredColorScheme(.dark)
    .onAppear {
      if pasted.isEmpty, !initialInput.isEmpty { pasted = initialInput }
    }
    .confirmationDialog(
      "Accept plan ownership?",
      isPresented: $showingConfirm,
      titleVisibility: .visible
    ) {
      Button("Accept", role: .destructive) { Task { await accept() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This makes you responsible for the subscription and billing. Continue?")
    }
  }

  private var formView: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: AegisSpacing.l) {
        Text("Paste the transfer link the current plan owner sent you. Accepting makes you the owner of the family plan.")
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textSecondary)
          .padding(.top, AegisSpacing.l)

        VStack(alignment: .leading, spacing: AegisSpacing.s) {
          Text("Transfer Link")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textTertiary)
            .textCase(.uppercase)
            .tracking(1.2)

          TextField("Paste link or token…", text: $pasted, axis: .vertical)
            .font(.system(size: 15, weight: .medium, design: .monospaced))
            .dynamicTypeSize(...DynamicTypeSize.xxLarge)
            .foregroundStyle(AegisColor.textPrimary)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .keyboardType(.asciiCapable)
            .focused($isFocused)
            .tint(AegisColor.accent)
            .lineLimit(3...6)
            .padding(AegisSpacing.m)
            .frame(maxWidth: .infinity)
            .background(AegisColor.surface)
            .overlay(
              RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
                .stroke(isFocused ? AegisColor.accent.opacity(0.7) : AegisColor.hairlineStrong, lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
            .animation(AegisMotion.snappy, value: isFocused)

          Button {
            if let s = UIPasteboard.general.string { pasted = s }
          } label: {
            Label("Paste from clipboard", systemImage: "doc.on.clipboard")
              .font(AegisType.caption)
              .foregroundStyle(AegisColor.accent)
          }
        }

        warningBanner

        if let errorMessage {
          Text(errorMessage)
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.verdictSpoofHigh)
        }

        Button(role: .destructive) {
          AegisHaptic.medium.play()
          showingConfirm = true
        } label: {
          HStack {
            if isAccepting { ProgressView().tint(.white) }
            else { Text("Accept ownership").font(AegisType.bodyBold) }
          }
          .frame(maxWidth: .infinity, minHeight: 54)
          .foregroundStyle(.white)
          .background(AegisColor.verdictSpoofHigh)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
          .opacity(canAccept ? 1 : 0.35)
        }
        .disabled(!canAccept || isAccepting)
      }
      .padding(.horizontal, AegisSpacing.l)
      .padding(.bottom, AegisSpacing.xl)
    }
  }

  private var warningBanner: some View {
    HStack(alignment: .top, spacing: AegisSpacing.s) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(AegisColor.verdictSuspicious)
      Text("Accepting makes you the billing owner. The previous owner keeps protection as a member, but the subscription moves to your account.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textSecondary)
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.verdictSuspicious.opacity(0.12))
    .overlay(
      RoundedRectangle(cornerRadius: AegisRadius.m)
        .stroke(AegisColor.verdictSuspicious.opacity(0.4), lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var acceptedView: some View {
    VStack(spacing: AegisSpacing.l) {
      Spacer()
      Image(systemName: "crown.fill")
        .font(.system(size: 56, weight: .semibold))
        .foregroundStyle(AegisColor.verdictSuspicious)
        .symbolEffect(.bounce, options: .nonRepeating)
      VStack(spacing: AegisSpacing.s) {
        Text("You own the plan")
          .font(AegisType.heading)
          .foregroundStyle(AegisColor.textPrimary)
        Text("The subscription is now billed to your account. You can invite, remove, or transfer again from the Family Plan screen.")
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
        Text("Continue")
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

  private var canAccept: Bool {
    !extractedToken.isEmpty && !isAccepting
  }

  /// Pulls the raw token out of a paste. Accepts either:
  ///   - a full URL like `aegisdial://family/transfer/accept?token=XYZ`
  ///   - a raw token (anything else — we trim whitespace and hand off)
  /// Kept permissive because older iOS Messages previews sometimes add
  /// a trailing period, leading space, or wrap the URL in angle brackets.
  private var extractedToken: String {
    let trimmed = pasted
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: "<>"))
    guard !trimmed.isEmpty else { return "" }
    if let url = URL(string: trimmed),
       let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
       let token = comps.queryItems?.first(where: { $0.name == "token" })?.value,
       !token.isEmpty {
      return token
    }
    return trimmed
  }

  // MARK: - Actions

  private func accept() async {
    let token = extractedToken
    guard !token.isEmpty, !isAccepting else { return }
    isAccepting = true
    defer { isAccepting = false }
    errorMessage = nil
    do {
      _ = try await APIClient.shared.acceptOwnershipTransfer(token: token)
      AegisHaptic.success.play()
      accepted = true
      // Broadcast so any open FamilyPlanView refreshes without the
      // parent having to thread a callback. The parent that presented
      // this sheet also gets its own onAccepted() callback — this
      // notification is purely for sibling surfaces (Settings, Home).
      NotificationCenter.default.post(name: .aegisFamilyStateChanged, object: nil)
    } catch {
      AegisHaptic.error.play()
      errorMessage = friendlyError(error)
    }
  }

  private func friendlyError(_ error: Error) -> String {
    let raw = error.localizedDescription.lowercased()
    if raw.contains("transfer_not_found") { return "That link isn't valid. Ask the current owner to send a new one." }
    if raw.contains("transfer_expired") { return "That transfer link expired. Ask the current owner to send a new one." }
    if raw.contains("transfer_already_accepted") { return "That link has already been used." }
    if raw.contains("transfer_not_for_you") { return "That link was created for a different family member." }
    if raw.contains("transfer_membership_stale") { return "The plan changed since this link was created. Ask for a new link." }
    return error.localizedDescription
  }
}

// Shared notification name so non-Family surfaces can refresh on accept
// without an explicit callback dependency. FamilyPlanView listens for
// this on `.onReceive`. Also consumable by the Settings surface once
// its owner wires the accept sheet.
extension Notification.Name {
  static let aegisFamilyStateChanged = Notification.Name("aegis.family.stateChanged")
}
