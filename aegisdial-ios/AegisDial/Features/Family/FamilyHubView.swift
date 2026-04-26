import SwiftUI

// "Family" tab hub. Three sub-sections:
//   - Family plan (invite, members, capacity)
//   - Family contacts (safe-word roster)
//   - Guardian alerts (if any) — summary card linking to full dashboard
//
// Keeps every family-adjacent surface in one place so users don't have
// to hunt across Home → Settings → Family Plan.

struct FamilyHubView: View {
  @State private var unseenGuardianCount: Int = 0

  var body: some View {
    List {
      Section {
        NavigationLink {
          FamilyPlanView()
        } label: {
          hubRow(
            icon: "person.3.fill",
            title: "Family Plan",
            body: "Manage who's on your plan, invite up to 5 lines."
          )
        }
        NavigationLink {
          FamilyContactsView()
        } label: {
          hubRow(
            icon: "person.crop.circle.badge.checkmark",
            title: "Family Contacts & Safe Words",
            body: "Register trusted relatives so you can verify voice-clone scams."
          )
        }
      } header: {
        Text("Your family")
      }

      Section {
        NavigationLink {
          GuardianDashboardView()
        } label: {
          hubRow(
            icon: "shield.lefthalf.filled",
            title: "Guardian Alerts",
            body: unseenGuardianCount > 0
              ? "\(unseenGuardianCount) unread alert\(unseenGuardianCount == 1 ? "" : "s")"
              : "You'll see alerts when a family member's call or account needs attention."
          )
        }
      } header: {
        Text("Watching over them")
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(AegisColor.background)
    .navigationTitle("Family")
    .task {
      if let count = try? await APIClient.shared.guardianUnseenCount() {
        unseenGuardianCount = count
      }
    }
  }

  private func hubRow(icon: String, title: String, body: String) -> some View {
    HStack(spacing: AegisSpacing.m) {
      Image(systemName: icon)
        .font(.system(size: 22, weight: .semibold))
        .foregroundStyle(AegisColor.accent)
        .frame(width: 40, height: 40)
        .background(AegisColor.accentGlow)
        .clipShape(Circle())
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(AegisType.bodyBold).foregroundStyle(AegisColor.textPrimary)
        Text(body).font(AegisType.caption).foregroundStyle(AegisColor.textSecondary)
          .lineLimit(2)
      }
    }
    .padding(.vertical, 6)
  }
}
