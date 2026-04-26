import SwiftUI

// Guardian Dashboard. Shown to users who are plan owners or have been
// added as a guardian for someone on their plan. Lists incoming
// events — a family member's shielded call went critical, a safe
// word failed mid-call, a new breach exposure surfaced — each with a
// "mark seen" swipe.
//
// The dashboard also surfaces a single "call them now" CTA pulled
// from the event payload (session_id → matched contact phone). For
// now it renders the event list; the callback wiring reuses the
// saved FamilyContact phone on the subject's device.

struct GuardianDashboardView: View {
  @State private var alerts: [GuardianAlert] = []
  @State private var loading: Bool = true
  @State private var showingAll: Bool = false
  @State private var error: String?
  // Subject to challenge. Identifiable-wrapped so `.sheet(item:)` swaps
  // cleanly between rows without flicker. The row only knows the
  // subject's user_id + a display title for the sheet header; we
  // derive the title from the alert's own title text.
  @State private var challengeTarget: ChallengeTarget?

  // Wrapper so `.sheet(item:)` can drive a single sheet off whichever
  // row the user tapped Challenge on.
  private struct ChallengeTarget: Identifiable, Hashable {
    let id: String        // subjectUserId (unique within the alerts list)
    let displayName: String
  }

  var body: some View {
    List {
      if let err = error {
        Section { ErrorBanner(message: err) { Task { await reload() } } }
      }
      Section {
        Toggle("Show read", isOn: $showingAll)
          .onChange(of: showingAll) { _, _ in Task { await reload() } }
      }
      if alerts.isEmpty && !loading && error == nil {
        Section {
          EmptyStateBlock(
            icon: "shield.checkerboard",
            title: "All clear",
            body: "When a family member's shielded call goes critical or a new exposure surfaces, it lands here."
          )
        }
      }
      ForEach(alerts) { a in
        Section {
          alertCard(a)
        }
      }
      if !alerts.isEmpty {
        Section {
          Button {
            Task {
              try? await APIClient.shared.guardianMarkAllSeen()
              await reload()
            }
          } label: {
            Label("Mark all read", systemImage: "envelope.open.fill")
          }
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(AegisColor.background)
    .navigationTitle("Guardian")
    .task { await reload() }
    .refreshable { await reload() }
    .sheet(item: $challengeTarget) { target in
      SafeWordChallengeInitiateSheet(
        subjectName: target.displayName,
        subjectUserId: target.id,
        onSuccess: {
          // Fire-and-forget refresh — the subject's answer arrives via
          // push/guardian_alerts anyway, but re-pulling keeps the feed
          // snappy in case a related alert was just created.
          Task { await reload() }
        }
      )
      .presentationDetents([.medium, .large])
    }
  }

  private func reload() async {
    loading = true
    defer { loading = false }
    error = nil
    do {
      alerts = try await APIClient.shared.guardianAlerts(includeSeen: showingAll)
    } catch let err {
      alerts = []
      error = err.localizedDescription
    }
  }

  @ViewBuilder
  private func alertCard(_ a: GuardianAlert) -> some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      HStack {
        Image(systemName: iconFor(a.kind))
          .foregroundStyle(colorFor(a.severity))
        Text(labelFor(a.kind))
          .font(AegisType.caption)
          .tracking(1.4)
          .foregroundStyle(colorFor(a.severity))
        Spacer()
        if a.seenAt == nil {
          Circle().fill(AegisColor.accent).frame(width: 8, height: 8)
        }
      }
      Text(a.title)
        .font(AegisType.heading)
        .foregroundStyle(AegisColor.textPrimary)
      Text(a.body)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
      HStack(spacing: AegisSpacing.m) {
        // "Challenge" — outlined secondary. Present on every alert
        // because the alert row is the moment we know who the subject
        // is (`subjectUserId` is on GuardianAlert). Keeps the user one
        // tap from "prove it's really them" the instant something
        // looks off. If they haven't paired a safe word, the backend's
        // opaque 403 maps to a gentle sentence in the sheet.
        Button {
          AegisHaptic.light.play()
          challengeTarget = ChallengeTarget(
            id: a.subjectUserId,
            displayName: displayNameForAlert(a)
          )
        } label: {
          Label("Challenge", systemImage: "key.radiowaves.forward")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.accent)
            .padding(.horizontal, AegisSpacing.m)
            .padding(.vertical, AegisSpacing.xs)
            .overlay(
              RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous)
                .stroke(AegisColor.accent.opacity(0.55), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Challenge this person with a safe word")

        Spacer()
        if a.seenAt == nil {
          Button("Mark read") {
            Task {
              try? await APIClient.shared.guardianMarkSeen(id: a.id)
              await reload()
            }
          }
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textSecondary)
        }
      }
    }
    .padding(AegisSpacing.s)
  }

  // The subject's plain-text name isn't in the alert payload today —
  // alerts carry a title string (e.g. "Mom's call went critical") and a
  // subject_user_id UUID. Extract a best-effort display handle from the
  // title for the sheet header; fall back to "this person" so we never
  // render a UUID in front of the user.
  //
  // TODO: when /v1/guardian/alerts gains a `subject_display_name` field
  // (tracked in backend TODO.md), key off that instead.
  private func displayNameForAlert(_ a: GuardianAlert) -> String {
    // Titles land in shapes like "Mom's call went critical" — pull the
    // possessive prefix if it exists, else surface the raw first word,
    // else a generic.
    if let apostrophe = a.title.firstIndex(of: "\u{2019}")
      ?? a.title.firstIndex(of: "'") {
      let name = a.title[..<apostrophe]
      let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty && trimmed.count < 40 { return trimmed }
    }
    return "this person"
  }

  private func iconFor(_ k: GuardianAlertKind) -> String {
    switch k {
    case .shieldCritical: return "exclamationmark.octagon.fill"
    case .shieldFamilyEmergency: return "person.crop.circle.badge.exclamationmark"
    case .safeWordFailed: return "key.slash.fill"
    case .breachNew: return "exclamationmark.shield.fill"
    case .recoveryStarted: return "cross.case.fill"
    }
  }

  private func labelFor(_ k: GuardianAlertKind) -> String {
    switch k {
    case .shieldCritical: return "CRITICAL CALL"
    case .shieldFamilyEmergency: return "FAMILY PRETEXT"
    case .safeWordFailed: return "SAFE WORD FAILED"
    case .breachNew: return "BREACH EXPOSURE"
    case .recoveryStarted: return "RECOVERY STARTED"
    }
  }

  private func colorFor(_ s: GuardianAlertSeverity) -> Color {
    switch s {
    case .critical: return AegisColor.verdictSpoofHigh
    case .warning: return AegisColor.verdictSuspicious
    case .info: return AegisColor.accent
    }
  }
}
