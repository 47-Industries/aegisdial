import SwiftUI

// Pre-attack signal view. Lists active breach alerts — the "your email
// showed up in the LinkedIn dump, here's what scammers now know about
// you" panel. From here users can dismiss, acknowledge (meaning "I've
// rotated my password"), or open the monitored-identifiers settings
// to add/remove emails and phones.

struct BreachAlertsView: View {
  @State private var alerts: [BreachAlert] = []
  @State private var loading = true
  @State private var error: String?
  @State private var showingAdd = false

  var body: some View {
    List {
      if let err = error {
        Section { ErrorBanner(message: err) { Task { await reload() } } }
      }
      if alerts.isEmpty && !loading && error == nil {
        Section {
          EmptyStateBlock(
            icon: "checkmark.shield.fill",
            title: "No active exposures",
            body: "Add your email or phone to check for dark-web leaks that could target you."
          )
        }
      }
      ForEach(alerts) { alert in
        Section {
          BreachAlertCard(alert: alert, onDismiss: { dismiss(alert) }, onAck: { ack(alert) })
        }
      }
      Section {
        NavigationLink {
          MonitoredIdentifiersView()
        } label: {
          Label("Manage monitored identities", systemImage: "person.badge.key.fill")
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(AegisColor.background)
    .navigationTitle("Breach Alerts")
    .task { await reload() }
    .refreshable { await reload() }
  }

  private func reload() async {
    loading = true
    defer { loading = false }
    do {
      alerts = try await APIClient.shared.breachListAlerts()
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func dismiss(_ alert: BreachAlert) {
    Task {
      do {
        try await APIClient.shared.breachDismissAlert(id: alert.id)
        await MainActor.run { alerts.removeAll { $0.id == alert.id } }
      } catch { }
    }
  }

  private func ack(_ alert: BreachAlert) {
    Task {
      do {
        try await APIClient.shared.breachAckAlert(id: alert.id)
        await reload()
      } catch { }
    }
  }
}

struct BreachAlertCard: View {
  let alert: BreachAlert
  let onDismiss: () -> Void
  let onAck: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      HStack {
        Image(systemName: severityIcon)
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(severityColor)
        Text(alert.severity.rawValue.uppercased())
          .font(AegisType.caption)
          .tracking(1.5)
          .foregroundStyle(severityColor)
        Spacer()
        if let date = alert.breachDate {
          Text(formattedDate(date))
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textSecondary)
        }
      }
      Text(alert.breachTitle)
        .font(.system(size: 20, weight: .bold))
        .foregroundStyle(AegisColor.textPrimary)
      if let source = alert.sourceDomain {
        Text(source)
          .font(AegisType.caption.monospaced())
          .foregroundStyle(AegisColor.textSecondary)
      }
      if !alert.dataTypes.isEmpty {
        FlowText(items: alert.dataTypes)
      }
      if let desc = alert.description {
        Text(desc)
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textSecondary)
      }
      if let entries = alert.entriesCount {
        Text("\(formatNumber(entries)) records exposed")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textSecondary)
      }
      HStack {
        Button { onAck() } label: {
          Text("I've rotated passwords")
            .font(AegisType.bodyBold)
            .foregroundStyle(.black)
            .padding(.horizontal, AegisSpacing.m)
            .padding(.vertical, AegisSpacing.s)
            .background(AegisColor.accent)
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous))
        }
        Spacer()
        Button { onDismiss() } label: {
          Text("Dismiss").font(AegisType.caption).foregroundStyle(AegisColor.textSecondary)
        }
      }
      .padding(.top, AegisSpacing.s)
    }
    .padding(AegisSpacing.s)
  }

  private var severityColor: Color {
    switch alert.severity {
    case .critical: return AegisColor.verdictSpoofHigh
    case .warning: return AegisColor.verdictSuspicious
    case .info: return AegisColor.accent
    }
  }

  private var severityIcon: String {
    switch alert.severity {
    case .critical: return "exclamationmark.octagon.fill"
    case .warning: return "exclamationmark.triangle.fill"
    case .info: return "info.circle.fill"
    }
  }

  private func formattedDate(_ iso: String) -> String {
    let f = ISO8601DateFormatter()
    if let d = f.date(from: iso) {
      let out = DateFormatter()
      out.dateStyle = .medium
      return out.string(from: d)
    }
    return iso
  }

  private func formatNumber(_ n: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    return f.string(from: NSNumber(value: n)) ?? "\(n)"
  }
}

// Simple horizontal wrapping layout for the data-types pills.
private struct FlowText: View {
  let items: [String]
  var body: some View {
    HStack(alignment: .center, spacing: 6) {
      ForEach(items.prefix(4), id: \.self) { item in
        Text(item.capitalized)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(AegisColor.textPrimary)
          .padding(.horizontal, 10)
          .padding(.vertical, 4)
          .background(AegisColor.surfaceElevated)
          .clipShape(Capsule())
      }
      if items.count > 4 {
        Text("+\(items.count - 4)")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(AegisColor.textSecondary)
      }
    }
  }
}
