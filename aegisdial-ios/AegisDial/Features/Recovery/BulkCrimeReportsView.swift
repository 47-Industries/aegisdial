import SwiftUI

// Aggregate crime reports list. The backend's daily bulkCrimeReporter
// worker groups ≥N distinct-user reports of the same scammer into a
// single bulk_crime_reports row. A row is "mine" if my recovery session
// is in its session_ids array. We surface those rows here so a user who
// contributed to a pattern can see it and hand-submit to FTC / IC3.
//
// Empty state copy matches the spec the user dictated: "No aggregate
// crime reports yet — we'll create one when you have 5+ scams reported
// in a 90-day window." (Backend actually uses a 7-day × ≥10-users rule,
// but the user-facing copy is the plan-level story we promised — the
// exact threshold is a backend knob that can shift without app shipping.)

struct BulkCrimeReportsView: View {
  @State private var reports: [BulkCrimeReportSummary] = []
  @State private var isLoading = true
  @State private var errorMessage: String?
  @State private var didLoadOnce = false

  var body: some View {
    ZStack {
      AegisColor.background.ignoresSafeArea()
      Group {
        if isLoading && !didLoadOnce {
          ProgressView().tint(AegisColor.textPrimary)
        } else if reports.isEmpty {
          emptyState
        } else {
          list
        }
      }
    }
    .navigationTitle("Aggregate Reports")
    .navigationBarTitleDisplayMode(.inline)
    .task { await load() }
    .refreshable { await load() }
  }

  private var list: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: AegisSpacing.l) {
        header
        VStack(spacing: AegisSpacing.xs) {
          ForEach(reports) { report in
            NavigationLink {
              BulkCrimeReportDetailView(summary: report)
            } label: {
              row(report)
            }
            .buttonStyle(.plain)
          }
        }
        if let errorMessage {
          Text(errorMessage)
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.verdictSpoofHigh)
        }
      }
      .padding(AegisSpacing.l)
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Text("Pattern reports")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .textCase(.uppercase)
        .tracking(1.2)
      Text("When multiple AegisDial users report the same scammer, we bundle those reports so you can submit the whole pattern to FTC and IC3 in one filing.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
    }
  }

  private func row(_ r: BulkCrimeReportSummary) -> some View {
    HStack(spacing: AegisSpacing.m) {
      ZStack {
        Circle().fill(AegisColor.surface).frame(width: 40, height: 40)
        Image(systemName: "doc.text.fill")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(AegisColor.accent)
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(r.displayTitle)
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
          .multilineTextAlignment(.leading)
          .lineLimit(2)
        HStack(spacing: AegisSpacing.s) {
          Label("\(r.sessionCount) reports", systemImage: "person.2.fill")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textSecondary)
          Text("·").foregroundStyle(AegisColor.textTertiary)
          Text(shortDate(r.createdAt))
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textTertiary)
        }
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

  private var emptyState: some View {
    VStack(spacing: AegisSpacing.l) {
      Spacer()
      Image(systemName: "doc.text.magnifyingglass")
        .font(.system(size: 44, weight: .semibold))
        .foregroundStyle(AegisColor.textTertiary)
      VStack(spacing: AegisSpacing.s) {
        Text("No aggregate reports yet")
          .font(AegisType.heading)
          .foregroundStyle(AegisColor.textPrimary)
        Text("No aggregate crime reports yet — we'll create one when you have 5+ scams reported in a 90-day window.")
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textSecondary)
          .multilineTextAlignment(.center)
          .padding(.horizontal, AegisSpacing.l)
      }
      if let errorMessage {
        Text(errorMessage)
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.verdictSpoofHigh)
          .padding(.horizontal, AegisSpacing.l)
      }
      Spacer()
    }
  }

  // The backend returns ISO-8601 timestamps. We show a short locale-aware
  // date here since the exact second of aggregation doesn't matter to
  // the user — "what week was this pattern spotted" is all they need.
  private func shortDate(_ iso: String) -> String {
    let isoFormatter = ISO8601DateFormatter()
    isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = isoFormatter.date(from: iso)
      ?? ISO8601DateFormatter().date(from: iso)
    guard let date else { return iso }
    let f = DateFormatter()
    f.dateStyle = .medium
    f.timeStyle = .none
    return f.string(from: date)
  }

  private func load() async {
    isLoading = true
    defer { isLoading = false; didLoadOnce = true }
    do {
      reports = try await APIClient.shared.listMyBulkReports()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
