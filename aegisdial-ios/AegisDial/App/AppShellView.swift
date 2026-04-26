import SwiftUI

// Primary tab shell. Four tabs:
//   Home     — lookup + recent + live shield entry
//   Inbox    — guardian alerts + breach alerts merged, time-sorted
//   Family   — plan, contacts, safe words
//   Settings — account, subscription, extensions, about, delete
//
// The onboarding tour still auto-presents from Home; deep-links from
// the tour CTAs route via the selected tab.
//
// Badge counts: Inbox surfaces the unseen-guardian + active-breach
// count so the tab bar itself surfaces "something needs attention."

struct AppShellView: View {
  @State private var selectedTab: Tab = .home
  @State private var inboxUnreadCount: Int = 0
  @State private var deepLinkedGuardianAlertId: String?
  @State private var deepLinkedBreachAlertId: String?
  @Bindable private var router: DeepLinkRouter = .shared

  enum Tab: Hashable {
    case home, inbox, family, settings
  }

  var body: some View {
    TabView(selection: $selectedTab) {
      NavigationStack { HomeView() }
        .tabItem { Label("Home", systemImage: "house.fill") }
        .tag(Tab.home)

      NavigationStack { InboxView() }
        .tabItem {
          Label("Inbox", systemImage: "tray.fill")
        }
        .badge(inboxUnreadCount > 0 ? inboxUnreadCount : 0)
        .tag(Tab.inbox)

      NavigationStack { FamilyHubView() }
        .tabItem { Label("Family", systemImage: "person.3.fill") }
        .tag(Tab.family)

      NavigationStack { SettingsView() }
        .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        .tag(Tab.settings)
    }
    .tint(AegisColor.accent)
    .task {
      await refreshInboxBadge()
    }
    .onChange(of: selectedTab) { _, new in
      // Refresh badge when user visits Inbox — they'll be marking things read.
      if new == .inbox {
        Task { await refreshInboxBadge() }
      }
    }
    .onChange(of: inboxUnreadCount) { _, newCount in
      // Keep the paired Watch in sync with the inbox badge.
      WatchSync.shared.push(
        activeShield: false,
        currentRisk: "low",
        riskScore: 0,
        unseenGuardianCount: newCount
      )
    }
    // Deep-link routing from push taps. When a user taps a guardian
    // alert push, the AppDelegate updates DeepLinkRouter, we flip the
    // tab, and the target view picks up the pending id.
    .onChange(of: router.pendingDestination) { _, dest in
      guard let dest else { return }
      switch dest {
      case .guardianAlert(let id):
        selectedTab = .inbox
        deepLinkedGuardianAlertId = id
      case .breachAlert(let id):
        selectedTab = .inbox
        deepLinkedBreachAlertId = id
      case .shieldSession:
        // Active shield UI is ephemeral — reopening from a push is
        // user-confusing. Fall back to Inbox.
        selectedTab = .inbox
      case .recoverySession:
        selectedTab = .home
      case .familyContacts:
        selectedTab = .family
      }
      router.clear()
    }
  }

  private func refreshInboxBadge() async {
    do {
      let g = try await APIClient.shared.guardianUnseenCount()
      await MainActor.run { inboxUnreadCount = g }
    } catch {
      // Silent — badge stays at previous value.
    }
  }
}
