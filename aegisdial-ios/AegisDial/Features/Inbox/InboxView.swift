import SwiftUI

// Unified inbox. Merges guardian alerts (family member had a critical
// call, safe word failed, recovery started) + breach alerts (your email
// showed up in a new dump) into one time-sorted feed. Users don't need
// to remember "which of the four tabs was that notification in?"
//
// Each row deep-links: guardian rows → Guardian detail; breach rows →
// Breach detail. Mark-read happens on row tap.

struct InboxView: View {
  @State private var items: [InboxItem] = []
  @State private var loading: Bool = true
  @State private var errorText: String?

  var body: some View {
    List {
      if let e = errorText {
        Section { ErrorBanner(message: e) { Task { await reload() } } }
      }

      if items.isEmpty && !loading {
        Section {
          EmptyStateBlock(
            icon: "tray.fill",
            title: "All quiet",
            body: "When a family member answers a scam call or a new breach exposure surfaces, it'll show up here."
          )
        }
      }
      ForEach(items) { item in
        InboxRow(item: item) { Task { await markSeen(item) } }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(AegisColor.background)
    .navigationTitle("Inbox")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        NavigationLink {
          ScamHeatmapView()
        } label: {
          Image(systemName: "map.fill")
        }
        .accessibilityLabel("Scam heatmap")
      }
      ToolbarItem(placement: .topBarTrailing) {
        NavigationLink {
          GuardianDashboardView()
        } label: {
          Image(systemName: "shield.lefthalf.filled")
        }
        .accessibilityLabel("Guardian dashboard")
      }
    }
    .task { await reload() }
    .refreshable { await reload() }
  }

  private func reload() async {
    loading = true
    defer { loading = false }
    errorText = nil
    do {
      async let guardians = APIClient.shared.guardianAlerts(includeSeen: true)
      async let breaches = APIClient.shared.breachListAlerts(includeDismissed: true)
      let (g, b) = try await (guardians, breaches)

      var merged: [InboxItem] = []
      merged.append(contentsOf: g.map { InboxItem.fromGuardian($0) })
      merged.append(contentsOf: b.map { InboxItem.fromBreach($0) })
      merged.sort { $0.createdAt > $1.createdAt }

      await MainActor.run { items = merged }
    } catch {
      errorText = error.localizedDescription
    }
  }

  private func markSeen(_ item: InboxItem) async {
    switch item.source {
    case .guardian(let id):
      try? await APIClient.shared.guardianMarkSeen(id: id)
    case .breach:
      // breach alerts don't have a "seen" — they have dismissed / ack;
      // tapping the row doesn't auto-dismiss (destructive).
      break
    }
    await reload()
  }
}

// MARK: - Inbox item model

struct InboxItem: Identifiable, Hashable {
  enum Source: Hashable {
    case guardian(String)
    case breach(String)
  }
  let id: String
  let source: Source
  let title: String
  let body: String
  let severity: InboxSeverity
  let icon: String
  let createdAt: String
  let isRead: Bool

  static func fromGuardian(_ a: GuardianAlert) -> InboxItem {
    InboxItem(
      id: "g-\(a.id)",
      source: .guardian(a.id),
      title: a.title,
      body: a.body,
      severity: InboxSeverity(rawValue: a.severity.rawValue) ?? .warning,
      icon: iconFor(guardianKind: a.kind),
      createdAt: a.createdAt,
      isRead: a.seenAt != nil
    )
  }

  static func fromBreach(_ a: BreachAlert) -> InboxItem {
    InboxItem(
      id: "b-\(a.id)",
      source: .breach(a.id),
      title: a.breachTitle,
      body: a.description ?? "Exposed data: \(a.dataTypes.joined(separator: ", "))",
      severity: InboxSeverity(rawValue: a.severity.rawValue) ?? .warning,
      icon: "exclamationmark.shield.fill",
      createdAt: a.createdAt,
      isRead: a.dismissedAt != nil || a.acknowledgedAt != nil
    )
  }

  private static func iconFor(guardianKind: GuardianAlertKind) -> String {
    switch guardianKind {
    case .shieldCritical: return "exclamationmark.octagon.fill"
    case .shieldFamilyEmergency: return "person.crop.circle.badge.exclamationmark"
    case .safeWordFailed: return "key.slash.fill"
    case .breachNew: return "exclamationmark.shield.fill"
    case .recoveryStarted: return "cross.case.fill"
    }
  }
}

enum InboxSeverity: String, Hashable {
  case info, warning, critical
  var color: Color {
    switch self {
    case .info: return AegisColor.accent
    case .warning: return AegisColor.verdictSuspicious
    case .critical: return AegisColor.verdictSpoofHigh
    }
  }
}

private struct InboxRow: View {
  let item: InboxItem
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(alignment: .top, spacing: AegisSpacing.m) {
        Image(systemName: item.icon)
          .font(.system(size: 22, weight: .semibold))
          .foregroundStyle(item.severity.color)
          .frame(width: 40, height: 40)
          .background(item.severity.color.opacity(0.12))
          .clipShape(Circle())
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 4) {
          HStack {
            Text(item.title)
              .font(item.isRead ? AegisType.body : AegisType.bodyBold)
              .foregroundStyle(AegisColor.textPrimary)
              .lineLimit(2)
            Spacer()
            if !item.isRead {
              Circle().fill(AegisColor.accent).frame(width: 8, height: 8)
                .accessibilityLabel("Unread")
            }
          }
          Text(item.body)
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textSecondary)
            .lineLimit(3)
        }
      }
      .padding(.vertical, 6)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(item.severity.rawValue) alert: \(item.title)")
    .accessibilityHint(item.isRead ? "" : "Tap to mark as read")
  }
}
