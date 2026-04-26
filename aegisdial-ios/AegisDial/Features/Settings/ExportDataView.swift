import SwiftUI
import UniformTypeIdentifiers

// GDPR Art. 20 + CCPA §1798.110 data export. Fetches the server's full
// JSON dump of the user's rows, writes it to a temp file, then hands it
// to a share sheet so the user can AirDrop / Mail / save-to-Files.
//
// Gate this view with `.biometricallyGated` at the call site — the export
// contains decrypted breach monitors, recovery notes, and evidence
// payloads.

struct ExportDataView: View {
  @State private var phase: Phase = .idle
  @State private var exportedFile: URL?
  @State private var shareItem: ShareItem?

  private enum Phase: Equatable {
    case idle
    case preparing
    case ready
    case error(String)
  }

  private struct ShareItem: Identifiable {
    let id = UUID()
    let url: URL
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: AegisSpacing.l) {
        header
        whatYouGetSection
        Spacer(minLength: AegisSpacing.l)
        actionButton
        if case .error(let msg) = phase { errorBanner(msg) }
      }
      .padding(AegisSpacing.l)
    }
    .background(AegisColor.background)
    .navigationTitle("Export My Data")
    .preferredColorScheme(.dark)
    .sheet(item: $shareItem) { item in
      ShareSheet(items: [item.url])
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "arrow.down.doc.fill")
        .font(.system(size: 32, weight: .semibold))
        .foregroundStyle(AegisColor.accent.gradient)
      Text("Download a copy")
        .font(.system(size: 22, weight: .semibold, design: .rounded))
        .foregroundStyle(AegisColor.textPrimary)
      Text("A single JSON file with every row we store about you. Takes a few seconds to assemble on our server.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var whatYouGetSection: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("What's inside")
      ForEach([
        ("person.circle", "Profile", "Email, display name, tier, birth year, created-at."),
        ("phone.fill", "Call history", "Up to 5,000 recent Live Shield sessions."),
        ("exclamationmark.shield", "Breach alerts", "Every monitored email/phone and the breaches we matched."),
        ("cross.case.fill", "Recovery sessions", "Every session you started, plus evidence notes — decrypted."),
        ("person.3.fill", "Family & Guardian", "Your family contacts, guardian links, and alerts."),
      ], id: \.0) { icon, title, subtitle in
        HStack(alignment: .top, spacing: AegisSpacing.s) {
          Image(systemName: icon)
            .foregroundStyle(AegisColor.accent)
            .frame(width: 22)
          VStack(alignment: .leading, spacing: 2) {
            Text(title).font(AegisType.bodyBold).foregroundStyle(AegisColor.textPrimary)
            Text(subtitle).font(AegisType.caption).foregroundStyle(AegisColor.textTertiary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var actionButton: some View {
    Button {
      AegisHaptic.medium.play()
      Task { await runExport() }
    } label: {
      HStack(spacing: AegisSpacing.s) {
        if phase == .preparing {
          ProgressView().tint(.black)
          Text("Preparing export…").font(AegisType.bodyBold)
        } else {
          Image(systemName: "square.and.arrow.down.fill")
          Text(phase == .ready ? "Share Again" : "Export My Data")
            .font(AegisType.bodyBold)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 54)
      .foregroundStyle(.black)
      .background(AegisColor.textPrimary)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .disabled(phase == .preparing)
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
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private func sectionHeader(_ text: String) -> some View {
    Text(text)
      .font(AegisType.caption)
      .foregroundStyle(AegisColor.textTertiary)
      .textCase(.uppercase)
      .tracking(1.2)
  }

  private func runExport() async {
    phase = .preparing
    do {
      let data = try await APIClient.shared.exportAccountData()
      let filename = "aegisdial-export-\(Self.timestampSlug()).json"
      let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
      try data.write(to: tmp, options: .atomic)
      exportedFile = tmp
      shareItem = ShareItem(url: tmp)
      phase = .ready
      AegisHaptic.success.play()
    } catch {
      phase = .error(error.localizedDescription)
      AegisHaptic.error.play()
    }
  }

  private static func timestampSlug() -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withFullDate]
    return f.string(from: Date())
  }
}

// Lightweight UIActivityViewController bridge. Standalone because this is
// the only place in the app that currently needs it — not worth a shared
// helper module.
private struct ShareSheet: UIViewControllerRepresentable {
  let items: [Any]
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: items, applicationActivities: nil)
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
