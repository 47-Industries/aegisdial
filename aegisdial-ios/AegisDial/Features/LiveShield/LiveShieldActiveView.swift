import SwiftUI

// Active-shield surface. Always-on indicator bar with risk color, live
// warning list (newest first), action CTAs: hang up / call my guardian /
// end session. This view stays visible for the duration of the call.
//
// Design intent: if the user only glances at their phone for half a
// second during a scam call, the color + copy alone should make the
// situation unmistakable. No verbose explanations in the hot path.

struct LiveShieldActiveView: View {
  // @Observable reference — the view auto-tracks through Observation;
  // @State here would store a frozen snapshot that never re-renders.
  let session: LiveShieldSession
  /// Called when the session ends at critical/high risk and the user
  /// might need recovery help. Parent (HomeView) uses this to present
  /// the handoff sheet. Snapshot: the risk level + categories at the
  /// moment the shield ended, so the recovery flow can prefill scam_type.
  var onMaybeNeedsRecovery: ((LiveShieldEndSnapshot) -> Void)? = nil

  @Environment(\.dismiss) private var dismiss
  @State private var showEndConfirmation = false

  var body: some View {
    ZStack {
      AegisColor.background.ignoresSafeArea()

      ScrollView {
        VStack(spacing: AegisSpacing.l) {
          riskHeader
          if session.familyVerifySuggested, let suggestion = session.familySuggestion {
            FamilyVerifyPanel(suggestion: suggestion, callSessionId: session.sessionId)
          }
          warningStack
        }
        .padding(.horizontal, AegisSpacing.l)
        .padding(.top, AegisSpacing.l)
        .padding(.bottom, 160)
      }
      VStack {
        Spacer()
        actionBar
          .padding(.horizontal, AegisSpacing.l)
          .padding(.bottom, AegisSpacing.l)
          .background(
            LinearGradient(
              colors: [AegisColor.background.opacity(0), AegisColor.background],
              startPoint: .top,
              endPoint: .bottom
            )
          )
      }
    }
    .alert("End shield?", isPresented: $showEndConfirmation) {
      Button("Keep shielding", role: .cancel) {}
      Button("End shield", role: .destructive) {
        Task { await session.end(outcome: .userCompleted); dismiss() }
      }
    } message: {
      Text("The shield will stop listening and the call will continue normally.")
    }
    .onChange(of: session.state) { _, new in
      if case .ended = new {
        // If the shield escalated to high or critical during the call,
        // hand off to Recovery Concierge on dismiss. The parent decides
        // whether to present the handoff sheet.
        if session.riskLevel == .critical || session.riskLevel == .high {
          let snap = LiveShieldEndSnapshot(
            peerNumber: session.peerNumber,
            riskScore: session.riskScore,
            riskLevel: session.riskLevel,
            triggeredCategories: session.triggeredCategories
          )
          onMaybeNeedsRecovery?(snap)
        }
        dismiss()
      }
    }
  }

  private var riskHeader: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      HStack {
        Circle()
          .fill(riskColor)
          .frame(width: 14, height: 14)
          .shadow(color: riskColor.opacity(0.6), radius: 8)
        Text("Shield active")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textSecondary)
        Spacer()
        Text(session.peerNumber ?? "Unknown caller")
          .font(AegisType.mono)
          .foregroundStyle(AegisColor.textSecondary)
      }
      Text("\(session.riskScore)")
        .font(.system(size: 76, weight: .bold, design: .rounded))
        .foregroundStyle(AegisColor.textPrimary)
        // 76pt base + AX5 would blow the card at small widths. Cap the
        // dynamic ramp at accessibility3 (still ~1.6x base) and let
        // minimumScaleFactor shrink the glyphs if a 3-digit score +
        // landscape-locked orientation still overflows.
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
        .minimumScaleFactor(0.5)
        .lineLimit(1)
        .contentTransition(.numericText())
        .accessibilityLabel("Risk score \(session.riskScore) out of 100")
      Text(levelHeadline)
        .font(.system(size: 22, weight: .semibold))
        .foregroundStyle(riskColor)
        .accessibilityLabel("Risk level: \(levelHeadline)")
      Text(levelBody)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(AegisSpacing.l)
    .background(AegisColor.surface)
    .overlay(
      RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous)
        .stroke(riskColor.opacity(session.riskLevel.isWarning ? 0.8 : 0.1), lineWidth: 2)
    )
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous))
    .animation(AegisMotion.snappy, value: session.riskLevel)
  }

  private var warningStack: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: AegisSpacing.s) {
        if session.warnings.isEmpty {
          emptyState
        } else {
          ForEach(session.warnings.reversed(), id: \.patternId) { w in
            warningCard(w)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var emptyState: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.xs) {
      Text("Listening…")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.textPrimary)
      Text("We'll alert you the moment the caller says something that matches a scam pattern.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textSecondary)
    }
    .padding(AegisSpacing.l)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private func warningCard(_ w: LiveShieldWarning) -> some View {
    HStack(alignment: .top, spacing: AegisSpacing.m) {
      Image(systemName: iconFor(category: w.category))
        .accessibilityHidden(true)

        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(AegisColor.verdictSpoofHigh)
        .frame(width: 28)
      VStack(alignment: .leading, spacing: 2) {
        Text(w.label)
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(AegisColor.textPrimary)
        Text(w.category.replacingOccurrences(of: "_", with: " ").capitalized)
          .font(.system(size: 13))
          .foregroundStyle(AegisColor.textSecondary)
      }
      Spacer()
      severityBadge(w.severity)
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private func severityBadge(_ s: Int) -> some View {
    Text(String(repeating: "●", count: s))
      .font(.system(size: 9, weight: .bold))
      .foregroundStyle(AegisColor.verdictSpoofHigh)
  }

  private var actionBar: some View {
    VStack(spacing: AegisSpacing.s) {
      if session.riskLevel.isCritical {
        Button {
          Task { await session.end(outcome: .userHungUp); dismiss() }
        } label: {
          Label("Hang up — this is a scam", systemImage: "phone.down.fill")
            .font(.system(size: 18, weight: .bold))
            .foregroundStyle(.white)
            // Drop shadow lifts white-on-red against the mid-red brand
            // background so WCAG AA contrast is met without losing the
            // red emergency signal. Pair with a 15% black overlay on
            // the fill below.
            // TODO: promote to AegisColor.criticalEmergency token
            .shadow(color: .black.opacity(0.4), radius: 0, y: 1)
            .frame(maxWidth: .infinity, minHeight: 60)
            .background(
              ZStack {
                AegisColor.verdictSpoofHigh
                Color.black.opacity(0.15)
              }
            )
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        }
      }
      Button { showEndConfirmation = true } label: {
        Text("End shield")
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textSecondary)
          .frame(maxWidth: .infinity, minHeight: 50)
          .background(AegisColor.surface)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      }
    }
  }

  // MARK: - Helpers

  private var riskColor: Color {
    switch session.riskLevel {
    case .low: return AegisColor.verdictUnknown
    case .medium: return AegisColor.verdictSuspicious
    case .high: return AegisColor.verdictLikelySpoof
    case .critical: return AegisColor.verdictSpoofHigh
    }
  }

  private var levelHeadline: String {
    switch session.riskLevel {
    case .low: return "All clear"
    case .medium: return "Watch this call"
    case .high: return "Likely scam"
    case .critical: return "Hang up now"
    }
  }

  private var levelBody: String {
    switch session.riskLevel {
    case .low: return "Nothing suspicious yet. We're listening for scam phrases."
    case .medium: return "A couple of scam signals. Don't share any info."
    case .high: return "Multiple scam patterns detected. Do not send money or codes."
    case .critical: return "This matches a known scam script. Hang up and call the institution at the number on the back of your card."
    }
  }

  private func iconFor(category: String) -> String {
    switch category {
    case "payment_fraud", "crypto_investment": return "dollarsign.circle.fill"
    case "remote_access": return "desktopcomputer.trianglebadge.exclamationmark"
    case "impersonation_authority": return "building.columns.fill"
    case "impersonation_financial": return "building.2.fill"
    case "isolation": return "person.slash.fill"
    case "time_pressure": return "clock.badge.exclamationmark.fill"
    case "sensitive_data": return "lock.shield.fill"
    case "emergency_relative": return "person.crop.circle.badge.exclamationmark"
    default: return "exclamationmark.triangle.fill"
    }
  }
}
