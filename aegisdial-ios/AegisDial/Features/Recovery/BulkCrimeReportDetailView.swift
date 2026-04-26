import SwiftUI
import UIKit

// Bulk-report detail. The backend returns deterministic FTC + IC3
// narratives for an aggregate pattern. This view lets the user:
//   1. Toggle between the two narratives (segmented picker).
//   2. Read the full text (select-to-copy enabled).
//   3. Share via UIActivityViewController — iPad popover anchor set so
//      the sheet doesn't crash on the iPad form factor.
//   4. See provenance in the footer so they know when the narrative
//      was generated and where to paste it.
//
// We intentionally do NOT auto-submit to FTC / IC3 — IC3 has no
// programmatic intake and FTC's intake is a web form, so a human
// pasting the narrative into the real form is the supported path.

struct BulkCrimeReportDetailView: View {
  let summary: BulkCrimeReportSummary

  @State private var detail: BulkCrimeReportDetail?
  @State private var isLoading = true
  @State private var errorMessage: String?
  @State private var selectedKind: Kind = .ftc
  @State private var showingShare = false

  enum Kind: String, CaseIterable, Identifiable {
    case ftc, ic3
    var id: String { rawValue }
    var label: String { self == .ftc ? "FTC" : "IC3" }
  }

  var body: some View {
    ZStack {
      AegisColor.background.ignoresSafeArea()
      if isLoading && detail == nil {
        ProgressView().tint(AegisColor.textPrimary)
      } else if let detail {
        content(detail)
      } else if let errorMessage {
        VStack(spacing: AegisSpacing.s) {
          Text("Couldn't load report")
            .font(AegisType.bodyBold)
            .foregroundStyle(AegisColor.textPrimary)
          Text(errorMessage)
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.verdictSpoofHigh)
          Button("Retry") { Task { await load() } }
            .buttonStyle(.borderedProminent)
            .tint(AegisColor.accent)
        }
        .padding(AegisSpacing.l)
      }
    }
    .navigationTitle(summary.displayTitle)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          AegisHaptic.light.play()
          showingShare = true
        } label: {
          Image(systemName: "square.and.arrow.up")
        }
        .disabled(detail == nil)
        .tint(AegisColor.accent)
      }
    }
    .task { await load() }
    .sheet(isPresented: $showingShare) {
      if let detail {
        BulkReportShareSheet(text: currentNarrative(detail))
      }
    }
  }

  private func content(_ detail: BulkCrimeReportDetail) -> some View {
    VStack(spacing: 0) {
      Picker("Narrative", selection: $selectedKind) {
        ForEach(Kind.allCases) { kind in
          Text(kind.label).tag(kind)
        }
      }
      .pickerStyle(.segmented)
      .padding(AegisSpacing.l)

      ScrollView {
        VStack(alignment: .leading, spacing: AegisSpacing.l) {
          // Narrative body. DynamicType clamp keeps the text readable
          // for aging-parent users without blowing up a 2,000-char
          // narrative into a 20-screen scroll.
          Text(currentNarrative(detail))
            .font(.system(size: 15, weight: .regular, design: .monospaced))
            .dynamicTypeSize(...DynamicTypeSize.xxLarge)
            .foregroundStyle(AegisColor.textPrimary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(AegisSpacing.m)
            .background(AegisColor.surface)
            .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairline, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))

          footer(detail)
        }
        .padding(.horizontal, AegisSpacing.l)
        .padding(.bottom, AegisSpacing.xl)
      }
    }
  }

  private func footer(_ detail: BulkCrimeReportDetail) -> some View {
    VStack(alignment: .leading, spacing: AegisSpacing.xs) {
      Text("Generated \(humanDate(detail.createdAt)). Print or paste into the actual form at reportfraud.ftc.gov or ic3.gov.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .multilineTextAlignment(.leading)
      Text("\(detail.sessionCount) reports bundled into this pattern.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func currentNarrative(_ detail: BulkCrimeReportDetail) -> String {
    switch selectedKind {
    case .ftc: return detail.narrativeFtc
    case .ic3: return detail.narrativeIc3
    }
  }

  private func humanDate(_ iso: String) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    guard let date else { return iso }
    let df = DateFormatter()
    df.dateStyle = .medium
    df.timeStyle = .short
    return df.string(from: date)
  }

  private func load() async {
    isLoading = true
    defer { isLoading = false }
    do {
      detail = try await APIClient.shared.getBulkReport(id: summary.id)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

// UIActivityViewController wrapper with an iPad popover anchor.
// FamilyInviteSheet's ShareSheet doesn't set a source view; presenting
// it from the iPad navigation bar would crash at runtime. This one
// anchors to the presenting view so iPad Pro / iPad mini don't trap.
private struct BulkReportShareSheet: UIViewControllerRepresentable {
  let text: String

  func makeUIViewController(context: Context) -> UIActivityViewController {
    let vc = UIActivityViewController(activityItems: [text], applicationActivities: nil)
    return vc
  }

  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {
    // On iPad, UIActivityViewController requires a popover anchor. We
    // resolve the topmost key-window scene's rootView at present time
    // and pin the popover to its centre bottom edge — matches Mail /
    // Messages default positioning when shared from a navbar button.
    if let pop = controller.popoverPresentationController {
      let scenes = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
      let keyWindow = scenes
        .flatMap { $0.windows }
        .first { $0.isKeyWindow }
      if let view = keyWindow?.rootViewController?.view {
        pop.sourceView = view
        pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
        pop.permittedArrowDirections = []
      }
    }
  }
}
