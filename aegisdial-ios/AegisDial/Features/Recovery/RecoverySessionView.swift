import SwiftUI
import UIKit

// The core Recovery flow — one step at a time. Design priorities, in order:
//
//   1. CALM. User is upset. No red alerts, no urgent ticking timers, no
//      fear-based copy. A trusted helper sitting next to them, working
//      through a checklist.
//   2. BIG TAP TARGETS. Primary CTA (call or open URL) must be unmistakable.
//   3. ONE STEP AT A TIME. Current step expanded; completed steps collapsed
//      with a check mark; upcoming steps collapsed behind "+3 more steps".
//   4. ALWAYS AN ESCAPE HATCH. Mark Skip, Abandon — never trap the user.
//
// The backend updates the session state on every action; we re-render from
// the response so progress is server-authoritative.

struct RecoverySessionView: View {
  @Environment(\.dismiss) private var dismiss
  @State var session: RecoverySession
  var onFinished: () -> Void

  @State private var busyStepKey: String?
  @State private var showingAbandonConfirm = false
  @State private var errorMessage: String?
  @State private var showingEvidenceSheet = false
  @State private var showingFamilyContactsDeepLink = false
  @State private var notifyFamilyResult: Int?
  @State private var showingCompanion = false
  @State private var showingOutcome = false
  @State private var showingReports = false

  var body: some View {
    NavigationStack {
      ZStack {
        AegisColor.background.ignoresSafeArea()
        ScrollViewReader { proxy in
          ScrollView {
            VStack(spacing: AegisSpacing.l) {
              progressHeader
              if session.session.status == .active {
                companionEntryCard
              }
              if let errorMessage {
                errorBanner(errorMessage)
              }
              stepsList
                .onChange(of: currentStepKey) { _, newKey in
                  if let key = newKey {
                    withAnimation(AegisMotion.spring) {
                      proxy.scrollTo(key, anchor: .top)
                    }
                  }
                }
              if session.session.status != .active {
                completionFooter
              }
            }
            .padding(AegisSpacing.l)
          }
        }
      }
      .navigationTitle(session.session.status == .active ? "Recovery" : "Finished")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          if session.session.status == .active {
            Button(role: .destructive) {
              showingAbandonConfirm = true
            } label: {
              Text("End").foregroundStyle(AegisColor.verdictSpoofHigh)
            }
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close") { onFinished() ; dismiss() }.tint(AegisColor.accent)
        }
      }
      .confirmationDialog(
        "End this recovery session?",
        isPresented: $showingAbandonConfirm,
        titleVisibility: .visible
      ) {
        Button("End session", role: .destructive) { Task { await abandon() } }
        Button("Keep going", role: .cancel) {}
      } message: {
        Text("You can come back to it later from Settings → Recovery.")
      }
    }
    .preferredColorScheme(.dark)
    .interactiveDismissDisabled(session.session.status == .active)
    .sheet(isPresented: $showingEvidenceSheet) {
      RecoveryEvidenceSheet(sessionId: session.session.id)
    }
    .sheet(isPresented: $showingFamilyContactsDeepLink) {
      NavigationStack { FamilyContactsView() }
    }
    .sheet(isPresented: $showingCompanion) {
      RecoveryCompanionView(sessionId: session.session.id)
        .presentationDetents([.large])
    }
    .sheet(isPresented: $showingOutcome) {
      RecoveryOutcomeSheet(
        sessionId: session.session.id,
        availableSteps: session.steps,
        onSubmitted: {}
      )
      .presentationDetents([.large])
    }
    .sheet(isPresented: $showingReports) {
      RecoveryReportsSheet(sessionId: session.session.id)
        .presentationDetents([.large])
    }
    .overlay(alignment: .top) {
      if let count = notifyFamilyResult {
        FamilyNotifyToast(deliveredCount: count) { notifyFamilyResult = nil }
          .transition(.move(edge: .top).combined(with: .opacity))
          .padding(.top, AegisSpacing.l)
      }
    }
    .animation(AegisMotion.spring, value: notifyFamilyResult)
  }

  // MARK: - Progress header

  private var progressHeader: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      HStack {
        Text("Step \(progressIndex) of \(session.steps.count)")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
          .textCase(.uppercase)
          .tracking(1.2)
        Spacer()
        Text(timeStarted)
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
      }
      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(AegisColor.surface)
          Capsule()
            .fill(progressColor)
            .frame(width: geo.size.width * progressFraction)
            .animation(AegisMotion.spring, value: progressFraction)
        }
      }
      .frame(height: 6)
      if session.session.status == .active, let current = currentStep {
        Text(current.title)
          .font(AegisType.heading)
          .foregroundStyle(AegisColor.textPrimary)
          .padding(.top, AegisSpacing.xs)
      }
    }
  }

  private var progressIndex: Int {
    let done = session.session.progress.completed + session.session.progress.skipped
    return min(done + 1, session.session.progress.total)
  }

  private var progressFraction: CGFloat {
    let done = session.session.progress.completed + session.session.progress.skipped
    guard session.session.progress.total > 0 else { return 0 }
    return CGFloat(done) / CGFloat(session.session.progress.total)
  }

  private var progressColor: Color {
    session.session.status == .completed ? AegisColor.verdictTrusted : AegisColor.accent
  }

  private var timeStarted: String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: session.session.startedAt) ?? ISO8601DateFormatter().date(from: session.session.startedAt) else {
      return ""
    }
    let rel = RelativeDateTimeFormatter()
    rel.unitsStyle = .short
    return "Started \(rel.localizedString(for: date, relativeTo: .now))"
  }

  // MARK: - Companion entry card

  // Sits above the step list whenever a session is active. Big, warm,
  // obvious — victims need to know someone is there BEFORE they start
  // the checklist. "Talk to me" framing, not "chat with AI."
  private var companionEntryCard: some View {
    Button {
      AegisHaptic.light.play()
      showingCompanion = true
    } label: {
      HStack(alignment: .center, spacing: AegisSpacing.m) {
        Image(systemName: "heart.text.square.fill")
          .font(.system(size: 28, weight: .semibold))
          .foregroundStyle(AegisColor.accent)
          .frame(width: 44, height: 44)
          .background(AegisColor.accentGlow)
          .clipShape(Circle())
        VStack(alignment: .leading, spacing: 2) {
          Text("Scared to tell anyone? Talk to me first.")
            .font(AegisType.bodyBold)
            .foregroundStyle(AegisColor.textPrimary)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
          Text("Private, judgment-free. I can help you figure out what to do next — and what to tell your family, when you're ready.")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer()
        Image(systemName: "chevron.right")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(AegisColor.textSecondary)
      }
      .padding(AegisSpacing.m)
      .background(AegisColor.surfaceElevated)
      .overlay(
        RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
          .stroke(AegisColor.accent.opacity(0.3), lineWidth: 1)
      )
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .buttonStyle(.plain)
  }

  // MARK: - Steps list

  private var stepsList: some View {
    VStack(spacing: AegisSpacing.s) {
      ForEach(session.steps) { step in
        RecoveryStepCard(
          step: step,
          isCurrent: isCurrentStep(step),
          isBusy: busyStepKey == step.stepKey,
          onAction: { action in Task { await handle(action, on: step) } }
        )
        .id(step.stepKey)
      }
    }
  }

  private var currentStep: RecoverySession.Step? {
    session.steps.first { $0.status == .pending || $0.status == .inProgress }
  }

  private var currentStepKey: String? { currentStep?.stepKey }

  private func isCurrentStep(_ step: RecoverySession.Step) -> Bool {
    step.stepKey == currentStepKey
  }

  // MARK: - Completion footer

  private var completionFooter: some View {
    VStack(spacing: AegisSpacing.m) {
      Image(systemName: session.session.status == .completed ? "checkmark.seal.fill" : "flag.checkered")
        .font(.system(size: 48, weight: .semibold))
        .foregroundStyle(session.session.status == .completed ? AegisColor.verdictTrusted : AegisColor.textSecondary)
      Text(session.session.status == .completed ? "You did the important work" : "Session ended")
        .font(AegisType.heading)
        .foregroundStyle(AegisColor.textPrimary)
      Text(footerMessage)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .multilineTextAlignment(.center)

      if session.session.status == .completed {
        VStack(spacing: AegisSpacing.s) {
          Button {
            AegisHaptic.light.play()
            showingOutcome = true
          } label: {
            Label("Tell us how it went", systemImage: "heart.text.square")
              .font(AegisType.bodyBold)
              .frame(maxWidth: .infinity, minHeight: 54)
              .foregroundStyle(.black)
              .background(AegisColor.accent)
              .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
          }
          Button {
            AegisHaptic.light.play()
            showingReports = true
          } label: {
            Label("Generate FTC + IC3 reports", systemImage: "doc.text.fill")
              .font(AegisType.bodyBold)
              .frame(maxWidth: .infinity, minHeight: 48)
              .foregroundStyle(AegisColor.textPrimary)
              .overlay(
                RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
                  .stroke(AegisColor.hairlineStrong, lineWidth: 1)
              )
          }
        }
        .padding(.top, AegisSpacing.s)
      }

      Button {
        onFinished()
        dismiss()
      } label: {
        Text("Close")
          .font(AegisType.bodyBold)
          .frame(maxWidth: .infinity, minHeight: 54)
          .foregroundStyle(.black)
          .background(AegisColor.textPrimary)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      }
      .padding(.top, AegisSpacing.s)
    }
    .padding(AegisSpacing.l)
    .frame(maxWidth: .infinity)
    .background(AegisColor.surfaceElevated)
    .overlay(RoundedRectangle(cornerRadius: AegisRadius.l).stroke(AegisColor.hairline, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous))
  }

  private var footerMessage: String {
    switch session.session.status {
    case .completed:
      return "You followed through on every step. If anything new comes up — another suspicious call, a fraudulent charge — come back and we'll help with that too."
    case .abandoned:
      return "You can resume this session anytime from Settings → Recovery. If something about this scam changes, we'll re-open the steps that need attention."
    case .active:
      return ""
    }
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(AegisColor.verdictSpoofHigh)
      Text(message).font(AegisType.caption).foregroundStyle(AegisColor.textPrimary)
      Spacer()
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.verdictSpoofHigh.opacity(0.12))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  // MARK: - Actions

  enum StepAction {
    case call
    case open
    case done
    case skip
    case reset
  }

  private func handle(_ action: StepAction, on step: RecoverySession.Step) async {
    switch action {
    case .call:
      if let phone = step.phoneToCall, let url = URL(string: "tel://\(phone.filter { $0.isNumber || $0 == "+" })") {
        AegisHaptic.medium.play()
        await UIApplication.shared.open(url)
      }
    case .open:
      // Special-cased step_keys without a URL: handle in-app.
      switch step.stepKey {
      case "notify_family":
        await notifyFamily()
        return
      case "capture_evidence":
        showingEvidenceSheet = true
        return
      case "setup_safe_word":
        showingFamilyContactsDeepLink = true
        return
      default:
        break
      }
      if let urlString = step.ctaUrl, let url = URL(string: urlString) {
        AegisHaptic.light.play()
        await UIApplication.shared.open(url)
      }
    case .done:
      await updateStatus(step.stepKey, .completed)
    case .skip:
      await updateStatus(step.stepKey, .skipped)
    case .reset:
      await updateStatus(step.stepKey, .inProgress)
    }
  }

  private func notifyFamily() async {
    AegisHaptic.medium.play()
    do {
      let delivered = try await APIClient.shared.recoveryNotifyFamily(sessionId: session.session.id)
      notifyFamilyResult = delivered
      AegisHaptic.success.play()
    } catch {
      errorMessage = error.localizedDescription
      AegisHaptic.error.play()
    }
  }

  private func updateStatus(_ stepKey: String, _ status: RecoverySession.StepStatus) async {
    busyStepKey = stepKey
    defer { busyStepKey = nil }
    do {
      let updated = try await APIClient.shared.updateRecoveryStep(
        sessionId: session.session.id,
        stepKey: stepKey,
        status: status
      )
      withAnimation(AegisMotion.spring) { session = updated }
      if status == .completed { AegisHaptic.success.play() }
      else { AegisHaptic.light.play() }
    } catch {
      errorMessage = error.localizedDescription
      AegisHaptic.error.play()
    }
  }

  private func abandon() async {
    do {
      try await APIClient.shared.abandonRecovery(id: session.session.id)
      if let refreshed = try? await APIClient.shared.recovery(id: session.session.id) {
        withAnimation(AegisMotion.spring) { session = refreshed }
      }
      AegisHaptic.medium.play()
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
