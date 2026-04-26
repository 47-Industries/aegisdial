import SwiftUI

// Pre-filled report viewer. Shows the narrative the server generated,
// the structured checklist, and one-tap Copy / Open buttons so the user
// finishes what would otherwise be a 45-minute form in under 3 minutes.
//
// Flow:
//   1. User taps "Generate FTC + IC3 reports" on the session.
//   2. We fetch both reports in parallel.
//   3. Segmented picker to switch between FTC and IC3.
//   4. "Copy narrative" → pastes the full narrative text.
//   5. "Open form" → opens the agency URL in Safari. They paste + submit.

struct RecoveryReportsSheet: View {
  @Environment(\.dismiss) private var dismiss
  let sessionId: String

  @State private var selected: Agency = .ftc
  @State private var ftc: APIClient.PrefilledReport?
  @State private var ic3: APIClient.PrefilledReport?
  @State private var loading = true
  @State private var errorMessage: String?
  @State private var copiedFlash: String?

  enum Agency: String, CaseIterable, Identifiable {
    case ftc = "FTC"
    case ic3 = "FBI IC3"
    var id: String { rawValue }
  }

  private var current: APIClient.PrefilledReport? {
    selected == .ftc ? ftc : ic3
  }

  var body: some View {
    NavigationStack {
      ZStack {
        AegisColor.background.ignoresSafeArea()
        VStack(alignment: .leading, spacing: AegisSpacing.m) {
          header
          Picker("Agency", selection: $selected) {
            ForEach(Agency.allCases) { Text($0.rawValue).tag($0) }
          }
          .pickerStyle(.segmented)
          .padding(.horizontal, AegisSpacing.l)

          if loading {
            Spacer()
            ProgressView().tint(AegisColor.accent)
            Spacer()
          } else if let errorMessage {
            Spacer()
            errorBanner(errorMessage)
              .padding(.horizontal, AegisSpacing.l)
            Spacer()
          } else if let report = current {
            ScrollView {
              VStack(alignment: .leading, spacing: AegisSpacing.l) {
                narrativeCard(report.narrative)
                if !report.fields.isEmpty { fieldsCard(report.fields) }
              }
              .padding(.horizontal, AegisSpacing.l)
            }
            actionBar(report: report)
          }
        }
      }
      .navigationTitle("Report this scam")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close") { dismiss() }.tint(AegisColor.accent)
        }
      }
    }
    .preferredColorScheme(.dark)
    .task { await loadBoth() }
    .overlay(alignment: .bottom) {
      if let copiedFlash {
        Text(copiedFlash)
          .font(AegisType.caption)
          .foregroundStyle(.black)
          .padding(.horizontal, AegisSpacing.m)
          .padding(.vertical, AegisSpacing.s)
          .background(AegisColor.verdictTrusted)
          .clipShape(Capsule())
          .padding(.bottom, AegisSpacing.xl)
          .transition(.opacity.combined(with: .move(edge: .bottom)))
      }
    }
    .animation(AegisMotion.spring, value: copiedFlash)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "doc.text.fill")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(AegisColor.accent.gradient)
      Text("We wrote your report")
        .font(.system(size: 20, weight: .semibold, design: .rounded))
        .foregroundStyle(AegisColor.textPrimary)
      Text("Copy the narrative below and paste it into the agency form — it already has everything you'd have had to retype.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, AegisSpacing.l)
    .padding(.top, AegisSpacing.s)
  }

  private func narrativeCard(_ text: String) -> some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Text("NARRATIVE")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .tracking(1.2)
      Text(text)
        .font(.system(size: 15, design: .monospaced))
        .foregroundStyle(AegisColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private func fieldsCard(_ fields: [APIClient.PrefilledReport.ReportField]) -> some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Text("FIELDS TO FILL IN")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .tracking(1.2)
      ForEach(fields, id: \.label) { f in
        VStack(alignment: .leading, spacing: 2) {
          Text(f.label)
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textTertiary)
          Text(f.value)
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textPrimary)
            .textSelection(.enabled)
        }
        .padding(.vertical, 4)
      }
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private func actionBar(report: APIClient.PrefilledReport) -> some View {
    HStack(spacing: AegisSpacing.s) {
      Button {
        UIPasteboard.general.string = report.narrative
        withAnimation { copiedFlash = "Copied ✓" }
        AegisHaptic.success.play()
        Task { @MainActor in
          try? await Task.sleep(nanoseconds: 1_800_000_000)
          withAnimation { copiedFlash = nil }
        }
      } label: {
        Label("Copy narrative", systemImage: "doc.on.doc")
          .font(AegisType.bodyBold)
          .frame(maxWidth: .infinity, minHeight: 54)
          .foregroundStyle(AegisColor.textPrimary)
          .overlay(
            RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
              .stroke(AegisColor.hairlineStrong, lineWidth: 1)
          )
      }
      Button {
        guard let url = URL(string: report.url) else { return }
        UIApplication.shared.open(url)
        AegisHaptic.light.play()
      } label: {
        Label("Open form", systemImage: "arrow.up.right.square.fill")
          .font(AegisType.bodyBold)
          .frame(maxWidth: .infinity, minHeight: 54)
          .foregroundStyle(.black)
          .background(AegisColor.accent)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      }
    }
    .padding(AegisSpacing.l)
  }

  private func errorBanner(_ msg: String) -> some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(AegisColor.verdictSpoofHigh)
      Text(msg)
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textPrimary)
      Spacer()
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.verdictSpoofHigh.opacity(0.12))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private func loadBoth() async {
    loading = true
    defer { loading = false }
    errorMessage = nil
    do {
      async let ftcTask = APIClient.shared.recoveryReportFtc(sessionId: sessionId)
      async let ic3Task = APIClient.shared.recoveryReportIc3(sessionId: sessionId)
      let (a, b) = try await (ftcTask, ic3Task)
      ftc = a
      ic3 = b
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
