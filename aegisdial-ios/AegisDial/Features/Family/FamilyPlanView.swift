import SwiftUI

// The family-plan dashboard. Three states:
//   1. Not on a plan       -> "Start my family plan" + "Join with a code" buttons
//   2. On a plan as owner  -> member list, pending invites, invite new member CTA
//   3. On a plan as member -> member list, leave-plan action
//
// The view is intentionally quiet — people come here once or twice a year.
// No animations beyond the standard ones; clean list-with-cards aesthetic
// that matches Settings, not the marketing-flavored Home/Paywall.

struct FamilyPlanView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var status: FamilyStatus?
  @State private var loadError: String?
  @State private var actionError: String?
  @State private var isLoading = true
  @State private var showingInviteSheet = false
  @State private var showingAcceptSheet = false
  @State private var showingTransferRequestSheet = false
  @State private var showingTransferAcceptSheet = false
  @State private var pendingRemoval: FamilyStatus.Member?

  var body: some View {
    NavigationStack {
      ZStack {
        AegisColor.background.ignoresSafeArea()
        Group {
          if isLoading && status == nil {
            ProgressView().tint(AegisColor.textPrimary)
          } else if let status, status.onPlan {
            onPlanContent(status)
          } else {
            notOnPlanContent
          }
        }
      }
      .navigationTitle("Family Plan")
      .navigationBarTitleDisplayMode(.large)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }.tint(AegisColor.accent)
        }
      }
    }
    .preferredColorScheme(.dark)
    .task { await refresh() }
    .sheet(isPresented: $showingInviteSheet) {
      FamilyInviteSheet(onCreated: { Task { await refresh() } })
        .presentationDetents([.medium])
        .presentationBackground(.thickMaterial)
    }
    .sheet(isPresented: $showingAcceptSheet) {
      FamilyAcceptSheet(onAccepted: { Task { await refresh() } })
        .presentationDetents([.medium])
        .presentationBackground(.thickMaterial)
    }
    .sheet(isPresented: $showingTransferRequestSheet) {
      PlanOwnerTransferRequestSheet(
        eligibleMembers: (status?.members ?? []).filter { $0.role == .member && !$0.isYou },
        onCompleted: { Task { await refresh() } }
      )
      .presentationDetents([.large])
      .presentationBackground(.thickMaterial)
    }
    .sheet(isPresented: $showingTransferAcceptSheet) {
      PlanOwnerTransferAcceptSheet(onAccepted: { Task { await refresh() } })
        .presentationDetents([.large])
        .presentationBackground(.thickMaterial)
    }
    .onReceive(NotificationCenter.default.publisher(for: .aegisFamilyStateChanged)) { _ in
      Task { await refresh() }
    }
    .confirmationDialog(
      "Remove \(pendingRemoval?.displayName ?? "this member")?",
      isPresented: .init(
        get: { pendingRemoval != nil },
        set: { if !$0 { pendingRemoval = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Remove", role: .destructive) {
        if let member = pendingRemoval { Task { await remove(member) } }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("They'll lose AegisDial protection immediately.")
    }
  }

  // MARK: - Signed-in-but-no-plan

  private var notOnPlanContent: some View {
    VStack(spacing: AegisSpacing.l) {
      Spacer()
      VStack(spacing: AegisSpacing.m) {
        Image(systemName: "person.3.fill")
          .font(.system(size: 48, weight: .semibold))
          .foregroundStyle(AegisColor.accent.gradient)
        Text("Protect your family")
          .font(AegisType.heading)
          .foregroundStyle(AegisColor.textPrimary)
        Text("Your Pro subscription covers up to 3 lines. Invite the people you care about — parents, spouse, kids — and they're protected at no extra cost.")
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textSecondary)
          .multilineTextAlignment(.center)
          .padding(.horizontal, AegisSpacing.l)
      }

      VStack(spacing: AegisSpacing.s) {
        Button {
          AegisHaptic.light.play()
          showingInviteSheet = true
        } label: {
          Label("Invite a Family Member", systemImage: "person.badge.plus")
            .font(AegisType.bodyBold)
            .frame(maxWidth: .infinity, minHeight: 54)
            .foregroundStyle(.black)
            .background(AegisColor.textPrimary)
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        }
        Button {
          AegisHaptic.light.play()
          showingAcceptSheet = true
        } label: {
          Label("Join with an Invite Code", systemImage: "key.fill")
            .font(AegisType.bodyBold)
            .frame(maxWidth: .infinity, minHeight: 54)
            .foregroundStyle(AegisColor.textPrimary)
            .background(AegisColor.surface)
            .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairlineStrong, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        }
      }
      .padding(.horizontal, AegisSpacing.l)
      Spacer()
    }
  }

  // MARK: - On-plan content

  private func onPlanContent(_ status: FamilyStatus) -> some View {
    ScrollView {
      VStack(spacing: AegisSpacing.l) {
        if let err = actionError {
          errorBanner(err)
        }
        planHeader(status)
        membersSection(status)
        if status.role == .owner {
          pendingInvitesSection(status)
          addMemberButton(status)
          transferOwnershipRow(status)
        } else {
          acceptTransferRow
          leavePlanButton(status)
        }
      }
      .padding(AegisSpacing.l)
    }
    .refreshable { await refresh() }
  }

  @ViewBuilder
  private func planHeader(_ status: FamilyStatus) -> some View {
    // If the backend says `onPlan` but didn't populate `plan` we render an
    // empty view rather than crashing. This shouldn't happen in practice —
    // it would be a backend bug — but force-unwrapping a server field is
    // never OK. Next refresh reconciles the state.
    if let plan = status.plan {
      VStack(alignment: .leading, spacing: AegisSpacing.s) {
        HStack {
          Text(status.role == .owner ? "You own this plan" : "You're a member")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textTertiary)
            .textCase(.uppercase)
            .tracking(1.2)
          Spacer()
        }
        HStack(alignment: .firstTextBaseline, spacing: AegisSpacing.s) {
          Text("\(plan.seatsUsed)")
            .font(.system(size: 52, weight: .bold, design: .rounded))
            .foregroundStyle(AegisColor.textPrimary)
          Text("of \(plan.capacity) protected")
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textSecondary)
          Spacer()
        }
        capacityBar(used: plan.seatsUsed, capacity: plan.capacity)
        if plan.seatsAvailable > 0 && status.role == .owner {
          Text("\(plan.seatsAvailable) seat\(plan.seatsAvailable == 1 ? "" : "s") available")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.verdictTrusted)
        }
      }
      .padding(AegisSpacing.l)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(AegisColor.surfaceElevated)
      .overlay(RoundedRectangle(cornerRadius: AegisRadius.l).stroke(AegisColor.hairline, lineWidth: 1))
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous))
    }
  }

  private func capacityBar(used: Int, capacity: Int) -> some View {
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule().fill(AegisColor.surface)
        Capsule()
          .fill(AegisColor.verdictTrusted)
          .frame(width: capacity == 0 ? 0 : geo.size.width * CGFloat(used) / CGFloat(capacity))
      }
    }
    .frame(height: 6)
  }

  private func membersSection(_ status: FamilyStatus) -> some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("Members")
      VStack(spacing: AegisSpacing.xs) {
        ForEach(status.members) { member in
          memberRow(member, status: status)
        }
      }
    }
  }

  private func memberRow(_ member: FamilyStatus.Member, status: FamilyStatus) -> some View {
    HStack(spacing: AegisSpacing.m) {
      ZStack {
        Circle().fill(AegisColor.surface).frame(width: 40, height: 40)
        Image(systemName: member.role == .owner ? "crown.fill" : "person.fill")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(member.role == .owner ? AegisColor.verdictSuspicious : AegisColor.textSecondary)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(member.displayName ?? member.label ?? "Family Member")
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
        Text(member.role == .owner ? "Owner" : member.isYou ? "You" : "Member")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
      }
      Spacer()
      if status.role == .owner && member.role == .member && !member.isYou {
        // NOTE: aging-parent DynamicType pass 2026-04-19
        // Remove-member X was a 20pt glyph with no touch-target padding —
        // Apple HIG minimum is 44pt square. Wrap with minWidth/minHeight 44
        // so older or tremor-affected users can hit it reliably.
        Button {
          AegisHaptic.medium.play()
          pendingRemoval = member
        } label: {
          Image(systemName: "xmark.circle.fill")
            .font(.system(size: 20))
            .foregroundStyle(AegisColor.textTertiary)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Remove \(member.displayName ?? member.label ?? "family member")")
      }
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairline, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  @ViewBuilder
  private func pendingInvitesSection(_ status: FamilyStatus) -> some View {
    if !status.pendingInvites.isEmpty {
      VStack(alignment: .leading, spacing: AegisSpacing.s) {
        sectionHeader("Pending invites")
        VStack(spacing: AegisSpacing.xs) {
          ForEach(status.pendingInvites) { invite in
            pendingInviteRow(invite)
          }
        }
      }
    }
  }

  private func pendingInviteRow(_ invite: FamilyStatus.PendingInvite) -> some View {
    HStack(spacing: AegisSpacing.m) {
      VStack(alignment: .leading, spacing: 2) {
        Text(invite.label ?? "Untitled invite")
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
        Text("Code: \(invite.code)")
          .font(AegisType.mono)
          .foregroundStyle(AegisColor.textSecondary)
      }
      Spacer()
      Button {
        UIPasteboard.general.string = invite.code
        AegisHaptic.success.play()
      } label: {
        Image(systemName: "doc.on.doc")
          .font(.system(size: 16))
          .foregroundStyle(AegisColor.accent)
      }
      Button {
        Task { await revoke(invite) }
      } label: {
        Image(systemName: "trash")
          .font(.system(size: 16))
          .foregroundStyle(AegisColor.textTertiary)
      }
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairline, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  @ViewBuilder
  private func addMemberButton(_ status: FamilyStatus) -> some View {
    if (status.plan?.seatsAvailable ?? 0) > 0 {
      Button {
        AegisHaptic.light.play()
        showingInviteSheet = true
      } label: {
        Label("Invite a Family Member", systemImage: "person.badge.plus")
          .font(AegisType.bodyBold)
          .frame(maxWidth: .infinity, minHeight: 54)
          .foregroundStyle(.black)
          .background(AegisColor.textPrimary)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      }
    } else {
      Text("Your plan is full. Upgrade to Family+ in Settings for 2 additional seats.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textSecondary)
        .frame(maxWidth: .infinity)
        .padding(AegisSpacing.m)
        .background(AegisColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
  }

  // Owner-only. Hidden if there's no eligible member (can't transfer to
  // yourself, and the sheet would open empty). We keep the row label
  // low-drama and lean the "this is destructive" copy into the sheet
  // itself — a scary row in the main list would be too noisy for a
  // surface most owners visit only once.
  @ViewBuilder
  private func transferOwnershipRow(_ status: FamilyStatus) -> some View {
    let eligible = status.members.filter { $0.role == .member && !$0.isYou }
    if !eligible.isEmpty {
      Button {
        AegisHaptic.light.play()
        showingTransferRequestSheet = true
      } label: {
        HStack(spacing: AegisSpacing.m) {
          Image(systemName: "arrow.left.arrow.right.square.fill")
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(AegisColor.accent)
            .frame(width: 28)
          VStack(alignment: .leading, spacing: 2) {
            Text("Transfer ownership")
              .font(AegisType.bodyBold)
              .foregroundStyle(AegisColor.textPrimary)
            Text("Hand off billing and admin to another member")
              .font(AegisType.caption)
              .foregroundStyle(AegisColor.textTertiary)
              .multilineTextAlignment(.leading)
          }
          Spacer()
          Image(systemName: "chevron.right")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(AegisColor.textTertiary)
        }
        .padding(AegisSpacing.m)
        .background(AegisColor.surface)
        .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairline, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      }
      .buttonStyle(.plain)
    }
  }

  // Member-only. Shown unconditionally on the member view — we don't
  // know in advance whether the current owner has created a pending
  // transfer for this user, so surfacing the entry point is the only
  // way a member can act on an out-of-band "I sent you a transfer link"
  // text. Tapping opens the paste sheet.
  private var acceptTransferRow: some View {
    Button {
      AegisHaptic.light.play()
      showingTransferAcceptSheet = true
    } label: {
      HStack(spacing: AegisSpacing.m) {
        Image(systemName: "crown.fill")
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(AegisColor.verdictSuspicious)
          .frame(width: 28)
        VStack(alignment: .leading, spacing: 2) {
          Text("Accept transferred ownership")
            .font(AegisType.bodyBold)
            .foregroundStyle(AegisColor.textPrimary)
          Text("Paste a link the current owner sent you")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textTertiary)
            .multilineTextAlignment(.leading)
        }
        Spacer()
        Image(systemName: "chevron.right")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(AegisColor.textTertiary)
      }
      .padding(AegisSpacing.m)
      .background(AegisColor.surface)
      .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairline, lineWidth: 1))
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .buttonStyle(.plain)
  }

  private func leavePlanButton(_ status: FamilyStatus) -> some View {
    Button(role: .destructive) {
      AegisHaptic.medium.play()
      if let me = status.members.first(where: { $0.isYou }) {
        pendingRemoval = me
      }
    } label: {
      Label("Leave this Family Plan", systemImage: "rectangle.portrait.and.arrow.right")
        .font(AegisType.bodyBold)
        .frame(maxWidth: .infinity, minHeight: 54)
        .foregroundStyle(AegisColor.verdictSpoofHigh)
        .background(AegisColor.verdictSpoofHigh.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
  }

  // MARK: - Helpers

  private func sectionHeader(_ title: String) -> some View {
    Text(title)
      .font(AegisType.caption)
      .foregroundStyle(AegisColor.textTertiary)
      .textCase(.uppercase)
      .tracking(1.2)
      .frame(maxWidth: .infinity, alignment: .leading)
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
    .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.verdictSpoofHigh.opacity(0.35), lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  // MARK: - Actions

  private func refresh() async {
    isLoading = true
    defer { isLoading = false }
    do {
      status = try await APIClient.shared.familyStatus()
      loadError = nil
    } catch {
      loadError = error.localizedDescription
    }
  }

  private func revoke(_ invite: FamilyStatus.PendingInvite) async {
    do {
      try await APIClient.shared.revokeFamilyInvite(id: invite.id)
      AegisHaptic.light.play()
      await refresh()
    } catch {
      actionError = "Couldn't revoke: \(error.localizedDescription)"
    }
  }

  private func remove(_ member: FamilyStatus.Member) async {
    do {
      try await APIClient.shared.removeFamilyMember(userId: member.userId)
      AegisHaptic.success.play()
      pendingRemoval = nil
      await refresh()
    } catch {
      actionError = "Couldn't remove: \(error.localizedDescription)"
    }
  }
}
