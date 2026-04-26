import SwiftUI
import UIKit

// Plan-owner transfer — REQUEST side. Only the current owner opens this.
// Flow:
//   1. Pick an existing plan member (cannot be yourself).
//   2. Tap "Create transfer link" → backend mints a pending transfer row
//      and hands us the RAW token exactly once.
//   3. Sheet shows the raw token + ShareLink so the owner can send it
//      via Messages / Mail / AirDrop to the receiving member.
//
// The token is NEVER persisted — not in Keychain, not in UserDefaults,
// not in `@AppStorage`, and not in any analytics event. Dismissing the
// sheet drops it. The server stores only sha256(token), so the raw
// value is unrecoverable after dismiss by design.
//
// This is destructive: whoever accepts the link becomes the billing
// owner. The pre-send copy (both in this sheet and in the ShareLink
// preview) leans into that so a mistap on Dad's row doesn't silently
// hand Dad the family subscription.

struct PlanOwnerTransferRequestSheet: View {
  @Environment(\.dismiss) private var dismiss

  /// Existing plan members — owner filters themselves out client-side.
  /// Passed in via init so this sheet never needs its own fetch.
  let eligibleMembers: [FamilyStatus.Member]
  let onCompleted: () -> Void

  @State private var selectedMemberId: String?
  @State private var isCreating = false
  @State private var errorMessage: String?
  @State private var created: OwnershipTransferCreated?

  var body: some View {
    NavigationStack {
      ZStack {
        AegisColor.background.ignoresSafeArea()
        Group {
          if let created {
            tokenView(created)
          } else {
            pickerView
          }
        }
      }
      .navigationTitle(created == nil ? "Transfer Ownership" : "Transfer Link Ready")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button(created == nil ? "Cancel" : "Done") {
            if created != nil { onCompleted() }
            // Resetting state on dismiss is both a UX nicety and a belt
            // on the "don't keep the raw token in memory after close"
            // invariant — the @State token string is released with the
            // sheet's view graph, but zeroing it here is cheap.
            created = nil
            selectedMemberId = nil
            dismiss()
          }
          .tint(AegisColor.accent)
        }
      }
    }
    .preferredColorScheme(.dark)
  }

  // MARK: - Pre-create picker

  private var pickerView: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: AegisSpacing.l) {
        warningBanner

        Text("Pick the family member who'll take over the plan. They become responsible for the subscription and billing.")
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textSecondary)

        if eligibleMembers.isEmpty {
          Text("No eligible members on this plan. Invite someone first, then transfer.")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textTertiary)
            .padding(AegisSpacing.m)
            .frame(maxWidth: .infinity)
            .background(AegisColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        } else {
          sectionHeader("Eligible members")
          VStack(spacing: AegisSpacing.xs) {
            ForEach(eligibleMembers) { member in
              memberRow(member)
            }
          }
        }

        if let errorMessage {
          Text(errorMessage)
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.verdictSpoofHigh)
        }

        Button {
          AegisHaptic.medium.play()
          Task { await create() }
        } label: {
          HStack {
            if isCreating { ProgressView().tint(.black) }
            else { Text("Create transfer link").font(AegisType.bodyBold) }
          }
          .frame(maxWidth: .infinity, minHeight: 54)
          .foregroundStyle(.black)
          .background(AegisColor.textPrimary)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
          .opacity(canCreate ? 1 : 0.35)
        }
        .disabled(!canCreate || isCreating)
        .padding(.top, AegisSpacing.m)
      }
      .padding(AegisSpacing.l)
    }
  }

  private var warningBanner: some View {
    HStack(alignment: .top, spacing: AegisSpacing.s) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(AegisColor.verdictSuspicious)
      VStack(alignment: .leading, spacing: 4) {
        Text("This is a one-way handoff")
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
        Text("Anyone with this link can take over your plan. Share only with the person taking over, and only once.")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textSecondary)
      }
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

  private func memberRow(_ member: FamilyStatus.Member) -> some View {
    let isSelected = selectedMemberId == member.userId
    return Button {
      AegisHaptic.light.play()
      selectedMemberId = member.userId
    } label: {
      HStack(spacing: AegisSpacing.m) {
        ZStack {
          Circle().fill(AegisColor.surface).frame(width: 40, height: 40)
          Image(systemName: "person.fill")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(AegisColor.textSecondary)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(member.displayName ?? member.label ?? "Family Member")
            .font(AegisType.bodyBold)
            .foregroundStyle(AegisColor.textPrimary)
          Text("Member")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textTertiary)
        }
        Spacer()
        Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
          .font(.system(size: 20))
          .foregroundStyle(isSelected ? AegisColor.accent : AegisColor.textTertiary)
      }
      .padding(AegisSpacing.m)
      .background(AegisColor.surface)
      .overlay(
        RoundedRectangle(cornerRadius: AegisRadius.m)
          .stroke(isSelected ? AegisColor.accent.opacity(0.6) : AegisColor.hairline, lineWidth: 1)
      )
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .buttonStyle(.plain)
  }

  // MARK: - Post-create view (raw token)

  private func tokenView(_ created: OwnershipTransferCreated) -> some View {
    ScrollView {
      VStack(spacing: AegisSpacing.l) {
        VStack(spacing: AegisSpacing.s) {
          Image(systemName: "checkmark.seal.fill")
            .font(.system(size: 48, weight: .semibold))
            .foregroundStyle(AegisColor.verdictTrusted)
          Text("Transfer link ready")
            .font(AegisType.heading)
            .foregroundStyle(AegisColor.textPrimary)
          Text("Send this link to the person taking over. It works once, then disappears.")
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textSecondary)
            .multilineTextAlignment(.center)
        }

        VStack(alignment: .leading, spacing: AegisSpacing.xs) {
          Text("Transfer link")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textTertiary)
            .textCase(.uppercase)
            .tracking(1.2)
          // DynamicType clamp + wrap-anywhere so a Grandma-sized
          // accessibility font still shows the full token rather than
          // eliding the middle. The raw token is long (base64ish) and
          // must be fully visible for a human to copy by hand if the
          // share-sheet path fails.
          Text(created.token)
            .font(.system(size: 15, weight: .medium, design: .monospaced))
            .dynamicTypeSize(...DynamicTypeSize.xxLarge)
            .textSelection(.enabled)
            .foregroundStyle(AegisColor.textPrimary)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(AegisSpacing.m)
            .background(AegisColor.surfaceElevated)
            .overlay(
              RoundedRectangle(cornerRadius: AegisRadius.m)
                .stroke(AegisColor.accent.opacity(0.6), lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        }

        Text("Expires: \(created.expiresAt)")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
          .frame(maxWidth: .infinity, alignment: .leading)

        warningBanner

        VStack(spacing: AegisSpacing.s) {
          ShareLink(
            item: shareURL(for: created.token),
            message: Text("I'm transferring the AegisDial family plan to you. Open this link to accept — it only works once."),
            preview: SharePreview("AegisDial plan transfer")
          ) {
            Label("Share Link", systemImage: "square.and.arrow.up")
              .font(AegisType.bodyBold)
              .frame(maxWidth: .infinity, minHeight: 54)
              .foregroundStyle(.black)
              .background(AegisColor.textPrimary)
              .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
          }

          Button {
            UIPasteboard.general.string = created.token
            AegisHaptic.success.play()
          } label: {
            Label("Copy Link", systemImage: "doc.on.doc")
              .font(AegisType.bodyBold)
              .frame(maxWidth: .infinity, minHeight: 48)
              .foregroundStyle(AegisColor.textPrimary)
              .background(AegisColor.surface)
              .overlay(
                RoundedRectangle(cornerRadius: AegisRadius.m)
                  .stroke(AegisColor.hairlineStrong, lineWidth: 1)
              )
              .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
          }
        }
      }
      .padding(AegisSpacing.l)
    }
  }

  // Deep-link-friendly share target. The scheme is the existing app
  // scheme; the accept sheet parses either this URL shape OR a raw
  // token, so if Messages mangles the URL the receiver can still paste.
  private func shareURL(for token: String) -> URL {
    var comps = URLComponents()
    comps.scheme = "aegisdial"
    comps.host = "family"
    comps.path = "/transfer/accept"
    comps.queryItems = [URLQueryItem(name: "token", value: token)]
    return comps.url ?? URL(string: "aegisdial://family/transfer/accept?token=\(token)")!
  }

  // MARK: - Helpers

  private var canCreate: Bool { selectedMemberId != nil }

  private func sectionHeader(_ text: String) -> some View {
    Text(text)
      .font(AegisType.caption)
      .foregroundStyle(AegisColor.textTertiary)
      .textCase(.uppercase)
      .tracking(1.2)
  }

  // MARK: - Actions

  private func create() async {
    guard let memberId = selectedMemberId, !isCreating else { return }
    isCreating = true
    defer { isCreating = false }
    errorMessage = nil
    do {
      let resp = try await APIClient.shared.requestOwnershipTransfer(newOwnerUserId: memberId)
      AegisHaptic.success.play()
      created = resp
    } catch {
      AegisHaptic.error.play()
      errorMessage = friendlyError(error)
    }
  }

  private func friendlyError(_ error: Error) -> String {
    let raw = error.localizedDescription.lowercased()
    if raw.contains("not_plan_owner") { return "Only the plan owner can start a transfer." }
    if raw.contains("cannot_transfer_to_self") { return "Pick a different member — you can't transfer to yourself." }
    if raw.contains("target_not_plan_member") { return "That person isn't on your plan anymore. Refresh and try again." }
    return error.localizedDescription
  }
}
