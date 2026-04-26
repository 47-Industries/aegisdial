import SwiftUI

struct MonitoredIdentifiersView: View {
  @State private var items: [MonitoredIdentifier] = []
  @State private var showingAdd = false
  @State private var error: String?

  var body: some View {
    List {
      if let err = error {
        Section { ErrorBanner(message: err) { Task { await reload() } } }
      }
      Section {
        if items.isEmpty && error == nil {
          EmptyStateBlock(
            icon: "envelope.badge.shield.half.filled",
            title: "Nothing monitored yet",
            body: "Add an email or phone to check for dark-web leaks."
          )
        }
        ForEach(items) { item in
          identifierRow(item)
            .swipeActions {
              Button(role: .destructive) {
                Task { await remove(item) }
              } label: { Label("Delete", systemImage: "trash") }
            }
        }
      }
      if let error {
        Section { Text(error).foregroundStyle(AegisColor.verdictSpoofHigh) }
      }
    }
    .navigationTitle("Monitored")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button { showingAdd = true } label: { Image(systemName: "plus") }
      }
    }
    .sheet(isPresented: $showingAdd) {
      AddMonitoredSheet { newItem in
        items.insert(newItem, at: 0)
      }
    }
    .task { await reload() }
    .refreshable { await reload() }
  }

  private func reload() async {
    do { items = try await APIClient.shared.breachListMonitored() }
    catch { self.error = error.localizedDescription }
  }

  private func rescan(_ item: MonitoredIdentifier) async {
    do { try await APIClient.shared.breachRescan(id: item.id); await reload() }
    catch { self.error = error.localizedDescription }
  }

  private func remove(_ item: MonitoredIdentifier) async {
    do {
      try await APIClient.shared.breachDeleteMonitored(id: item.id)
      items.removeAll { $0.id == item.id }
    } catch { self.error = error.localizedDescription }
  }

  // MARK: - Rows

  /// Phone-kind identifiers with `status == "provider_disabled"` render a
  /// "coming soon" variant instead of the normal "No exposures" trusted-
  /// green line. Without this, phone rows lied to the user by implying
  /// the lookup succeeded and found nothing.
  @ViewBuilder
  private func identifierRow(_ item: MonitoredIdentifier) -> some View {
    if item.kind == .phone && item.status == "provider_disabled" {
      HStack {
        Image(systemName: "clock.fill")
          .foregroundStyle(AegisColor.textTertiary)
        VStack(alignment: .leading, spacing: 2) {
          Text(item.displayValue)
            .font(AegisType.bodyBold)
            .foregroundStyle(AegisColor.textPrimary)
          Text("Phone monitoring coming soon")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textSecondary)
          Text("Our data partner doesn't support phone lookups yet. Email monitoring works today.")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textTertiary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer()
      }
    } else {
      HStack {
        Image(systemName: item.kind == .email ? "envelope.fill" : "phone.fill")
          .foregroundStyle(AegisColor.accent)
        VStack(alignment: .leading, spacing: 2) {
          Text(item.displayValue).font(AegisType.bodyBold).foregroundStyle(AegisColor.textPrimary)
          Text(item.lastScanExposureCount > 0
               ? "\(item.lastScanExposureCount) exposures found"
               : "No exposures")
            .font(AegisType.caption)
            .foregroundStyle(item.lastScanExposureCount > 0 ? AegisColor.verdictSpoofHigh : AegisColor.verdictTrusted)
        }
        Spacer()
        Button { Task { await rescan(item) } } label: {
          Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(.plain)
        .foregroundStyle(AegisColor.textSecondary)
      }
    }
  }
}

private struct AddMonitoredSheet: View {
  @Environment(\.dismiss) private var dismiss
  @State private var kind: MonitoredIdentifierKind = .email
  @State private var value: String = ""
  @State private var saving: Bool = false
  @State private var error: String?
  let onAdded: (MonitoredIdentifier) -> Void

  var body: some View {
    NavigationStack {
      Form {
        Picker("Type", selection: $kind) {
          Text("Email").tag(MonitoredIdentifierKind.email)
          Text("Phone").tag(MonitoredIdentifierKind.phone)
        }
        .pickerStyle(.segmented)
        TextField(kind == .email ? "you@example.com" : "+1 555 123 4567", text: $value)
          .keyboardType(kind == .email ? .emailAddress : .phonePad)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        if let error {
          Text(error).foregroundStyle(AegisColor.verdictSpoofHigh)
        }
      }
      .navigationTitle("Monitor identity")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .topBarTrailing) {
          Button(saving ? "…" : "Add") { Task { await add() } }
            .disabled(saving || value.isEmpty)
        }
      }
    }
  }

  private func add() async {
    saving = true; defer { saving = false }
    do {
      let resp = try await APIClient.shared.breachAddMonitor(kind: kind, value: value)
      onAdded(resp.monitored)
      dismiss()
    } catch {
      self.error = error.localizedDescription
    }
  }
}
