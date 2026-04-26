import SwiftUI

// Settings → Recovery history. Shows the user's active session (if any)
// prominently at top, past completed/abandoned sessions below. Tapping any
// row opens the full RecoverySessionView — abandoned sessions can be
// resumed (we leave them read-only server-side but the UI is identical).

struct RecoveryHistoryView: View {
  @State private var active: RecoverySession?
  @State private var isLoading = true
  @State private var errorMessage: String?
  @State private var showingNewSession = false
  @State private var sessionToView: RecoverySession?

  var body: some View {
    ZStack {
      AegisColor.background.ignoresSafeArea()
      if isLoading && active == nil {
        ProgressView().tint(AegisColor.textPrimary)
      } else {
        ScrollView {
          VStack(alignment: .leading, spacing: AegisSpacing.l) {
            if let active {
              sectionHeader("Active session")
              RecoveryEntryCard(mode: .active(active)) { sessionToView = active }
            }

            sectionHeader("Start new")
            RecoveryEntryCard(mode: .idle) { showingNewSession = true }

            // Aggregate-reports entry point. We show it unconditionally
            // rather than gating on "user has ≥1 report" — the alternative
            // requires a second round-trip on every open of Recovery, and
            // the empty state inside BulkCrimeReportsView is warm enough
            // to stand on its own. TODO (noted backend-side): when we add
            // a cheap `has_bulk_reports` flag to the user profile, gate
            // this link on it to reduce clutter for users with no reports.
            sectionHeader("Aggregate crime reports")
            NavigationLink {
              BulkCrimeReportsView()
            } label: {
              bulkReportsEntryRow
            }
            .buttonStyle(.plain)

            if let errorMessage {
              Text(errorMessage)
                .font(AegisType.caption)
                .foregroundStyle(AegisColor.verdictSpoofHigh)
            }

            Text("Completed sessions will appear here once you finish them. We keep them 12 months so you can reference the steps you took.")
              .font(AegisType.caption)
              .foregroundStyle(AegisColor.textTertiary)
              .padding(.top, AegisSpacing.xl)
          }
          .padding(AegisSpacing.l)
        }
      }
    }
    .navigationTitle("Recovery")
    .navigationBarTitleDisplayMode(.inline)
    .task { await refresh() }
    .sheet(isPresented: $showingNewSession) {
      RecoveryStartSheet(
        scamNumber: nil,
        onStarted: { newSession in
          active = newSession
          sessionToView = newSession
        }
      )
      .presentationDetents([.large])
    }
    .sheet(item: $sessionToView) { session in
      RecoverySessionView(
        session: session,
        onFinished: { Task { await refresh() } }
      )
    }
  }

  private var bulkReportsEntryRow: some View {
    HStack(spacing: AegisSpacing.m) {
      ZStack {
        Circle().fill(AegisColor.surface).frame(width: 40, height: 40)
        Image(systemName: "doc.text.magnifyingglass")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(AegisColor.accent)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text("Pattern reports")
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
        Text("FTC + IC3 narratives for scams AegisDial flagged across multiple users")
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

  private func sectionHeader(_ text: String) -> some View {
    Text(text)
      .font(AegisType.caption)
      .foregroundStyle(AegisColor.textTertiary)
      .textCase(.uppercase)
      .tracking(1.2)
  }

  private func refresh() async {
    isLoading = true
    defer { isLoading = false }
    do {
      let response = try await APIClient.shared.activeRecovery()
      active = response.active ? response.session : nil
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
