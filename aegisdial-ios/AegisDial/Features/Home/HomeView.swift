import SwiftUI

// Primary user surface once signed in. A big searchable phone input at the
// top (immediately actionable), recent lookups below it. The input is a
// custom-styled TextField rather than Apple's default searchbar — the
// default searchbar looks dated in 2026 and doesn't give us the glow/focus
// state we want.

struct HomeView: View {
  @Environment(AuthStore.self) private var auth
  @State private var input: String = ""
  @State private var lookingUp = false
  @State private var result: VerdictResponse?
  @State private var errorMessage: String?
  @State private var history: [VerdictResponse] = []
  @State private var activeRecovery: RecoverySession?
  // Debounce: avoid re-firing /recovery/active on every .task (tab switch,
  // sheet dismiss, scene-phase churn). 30s is tight enough that a just-
  // created triage session still appears promptly, loose enough that a
  // user tab-bouncing doesn't hammer the endpoint.
  @State private var lastActiveRecoveryFetch: Date?
  @State private var showingRecoveryStart = false
  @State private var showingTriageStart = false
  @State private var triageSession: RecoverySession?
  @State private var showingTextAnalyzer = false
  @State private var recoveryToResume: RecoverySession?
  @State private var recoveryStartSeedNumber: String?
  @State private var showingLiveShieldConsent = false
  @State private var activeLiveShield: LiveShieldSession?
  @State private var liveShieldSeedPeer: String?
  @State private var postShieldSnapshot: LiveShieldEndSnapshot?
  @State private var preselectedScamType: ScamType?
  @State private var showingTour: Bool = false
  @State private var showingFamilyContactsFromTour: Bool = false
  @State private var showingBreachFromTour: Bool = false
  @State private var showingProtectParentFromTour: Bool = false
  @State private var showingProtectParent: Bool = false
  @AppStorage("tour_completed_v1") private var tourCompleted: Bool = false
  @FocusState private var inputFocused: Bool

  var body: some View {
    // NavigationStack is provided by AppShellView's tab wrapper; Home is
    // just the root content of the Home tab.
    ZStack {
      AegisColor.background.ignoresSafeArea()

      ScrollView {
          VStack(alignment: .leading, spacing: AegisSpacing.l) {
            header
            // Active recovery always pins to the top — if you're mid-flow
            // through a session, that's the most important thing on screen.
            if let active = activeRecovery {
              RecoveryEntryCard(mode: .active(active)) { recoveryToResume = active }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            // ── Hero tier — the "we do both" positioning ─────────────
            // Live Shield (prevention) + Recovery (if one lands) are
            // the twin headline products. No other consumer fraud
            // product offers both — that IS the moat. Paste-a-Text
            // sits alongside as the free top-of-funnel.
            //
            // Same `activeRecovery == nil && result == nil` gate —
            // once the user is mid-recovery or mid-lookup, hide these
            // to focus the screen on the active task.
            if activeRecovery == nil && result == nil {
              LiveShieldEntryCard(
                peerNumber: liveShieldSeedPeer,
                onTap: {
                  Track.event(.liveShieldCTATapped, ["source": "home_card"])
                  liveShieldSeedPeer = result?.number ?? (input.isEmpty ? nil : input)
                  showingLiveShieldConsent = true
                },
                onTapOutbound: {
                  // User is ABOUT to place a call to a suspicious number —
                  // route through the same consent gate as inbound (same
                  // on-device transcription + all-party notice applies).
                  // Consent sheet → session wire-up is direction-agnostic
                  // today; plumbing `direction: .outbound` end-to-end
                  // pulls in a refactor across HomeView state +
                  // LiveShieldConsentSheet signature and is deferred in
                  // TODO.md. Source tag still distinguishes the two CTAs
                  // so analytics + backend eventing can track the intent.
                  Track.event(.liveShieldCTATapped, ["source": "home_card_outbound"])
                  liveShieldSeedPeer = result?.number ?? (input.isEmpty ? nil : input)
                  showingLiveShieldConsent = true
                }
              )

              RecoveryEntryCard(mode: .idle) {
                Track.event(.recoveryCTATapped, ["source": "home_card"])
                recoveryStartSeedNumber = nil
                showingRecoveryStart = true
              }
              .padding(.top, AegisSpacing.s)

              TextAnalyzerEntryCard {
                AegisHaptic.light.play()
                showingTextAnalyzer = true
              }
              .padding(.top, AegisSpacing.s)

              TriageEntryCard {
                AegisHaptic.light.play()
                showingTriageStart = true
              }
              .padding(.top, AegisSpacing.s)
            }

            EngagementStatsCard()
              .padding(.top, AegisSpacing.m)
            lookupCard

            if let r = result {
              VerdictView(result: r, onReport: { reportCurrent() })
                .transition(.asymmetric(
                  insertion: .scale(scale: 0.92).combined(with: .opacity),
                  removal: .opacity
                ))
            } else if let msg = errorMessage {
              errorBanner(msg)
            }

            if !history.isEmpty && result == nil {
              recentSection
            }

            // ── More protection ──────────────────────────────────────
            // Family-coordination features that require setup (safe
            // words, guardian alerts) live below the hero tier. Same
            // Pro gate, just less in-your-face on first launch.
            Text("More protection")
              .font(AegisType.heading)
              .foregroundStyle(AegisColor.textSecondary)
              .padding(.top, AegisSpacing.l)
              .accessibilityAddTraits(.isHeader)

            ProtectAParentEntryCard {
              Track.event(.protectParentFlowStarted, ["source": "home_card"])
              showingProtectParent = true
            }

            Spacer(minLength: 40)
          }
        .padding(.horizontal, AegisSpacing.l)
        .padding(.top, AegisSpacing.m)
      }
      .scrollDismissesKeyboard(.interactively)
      .animation(AegisMotion.spring, value: result)
    }
    .toolbar(.hidden, for: .navigationBar)
      .sheet(isPresented: $showingRecoveryStart) {
        RecoveryStartSheet(
          scamNumber: recoveryStartSeedNumber,
          preselectedScamType: preselectedScamType,
          onStarted: { newSession in
            activeRecovery = newSession
            recoveryToResume = newSession
            preselectedScamType = nil
          }
        )
        .presentationDetents([.large])
      }
      .sheet(item: $recoveryToResume) { session in
        RecoverySessionView(
          session: session,
          onFinished: {
            recoveryToResume = nil
            Task { await refreshActiveRecovery(force: true) }
          }
        )
      }
      .sheet(isPresented: $showingLiveShieldConsent) {
        LiveShieldConsentSheet(peerNumber: liveShieldSeedPeer) {
          let session = LiveShieldSession()
          activeLiveShield = session
          Task { await session.start(peer: liveShieldSeedPeer) }
        }
        .presentationDetents([.large])
      }
      .fullScreenCover(item: $activeLiveShield) { session in
        LiveShieldActiveView(session: session) { snapshot in
          postShieldSnapshot = snapshot
        }
      }
      .sheet(item: $postShieldSnapshot) { snap in
        PostShieldRecoveryHandoffSheet(snapshot: snap) { startRecovery in
          if startRecovery {
            recoveryStartSeedNumber = snap.peerNumber
            preselectedScamType = snap.suggestedScamType
            showingRecoveryStart = true
          }
          postShieldSnapshot = nil
        }
        .presentationDetents([.medium])
      }
      .sheet(isPresented: $showingTour) {
        FeatureTourView(
          onGoToLiveShieldDemo: {
            liveShieldSeedPeer = nil
            showingLiveShieldConsent = true
          },
          onGoToRecoveryStart: {
            recoveryStartSeedNumber = nil
            showingRecoveryStart = true
          },
          onGoToProtectParent: { showingProtectParentFromTour = true },
          onGoToFamilyContacts: { showingFamilyContactsFromTour = true },
          onGoToBreachMonitor: { showingBreachFromTour = true },
          onGoToTextAnalyzer: { showingTextAnalyzer = true }
        )
        .presentationDetents([.large])
      }
      .sheet(isPresented: $showingProtectParentFromTour) {
        NavigationStack { ProtectAParentView() }
      }
      .sheet(isPresented: $showingProtectParent) {
        NavigationStack { ProtectAParentView() }
      }
      .sheet(isPresented: $showingTriageStart) {
        ScamTriageStartSheet(initialScamNumber: nil) { session in
          // Drop the user straight into the Companion in triage mode.
          triageSession = session
        }
      }
      .sheet(isPresented: $showingTextAnalyzer) {
        ScamTextAnalyzerView(initialText: nil) { pastedText, sender in
          // User wants to keep talking about the text → create a triage
          // session seeded with it, then drop into the Companion.
          Task {
            do {
              let session = try await APIClient.shared.startTriage(
                scamNumber: sender,
                description: pastedText
              )
              triageSession = session
            } catch {
              // Surface the failure to the user AND to PostHog. Silent
              // swallow was stranding users with no feedback when the
              // triage endpoint 500'd — they'd tap "keep talking," see
              // nothing happen, and bounce. Also emit apiErrorSilenced
              // telemetry so the outage shows up in our dashboards.
              errorMessage = AegisError.from(error).userMessage
              Track.event(.apiErrorSilenced, [
                "endpoint": "startTriage",
                "error": String(describing: error),
              ])
              AegisHaptic.error.play()
            }
          }
        }
      }
      .sheet(item: $triageSession, onDismiss: {
        // After triage closes (converted, not-a-scam, unclear, or just
        // closed), re-poll the active recovery so a just-converted
        // session appears on Home without requiring an app relaunch.
        Task { await refreshActiveRecovery(force: true) }
      }) { session in
        RecoveryCompanionView(
          sessionId: session.session.id,
          openingMessage: nil,
          triageMode: true,
          suggestedScamType: nil
        )
        .presentationDetents([.large])
      }
      .sheet(isPresented: $showingFamilyContactsFromTour) {
        NavigationStack { FamilyContactsView() }
      }
      .sheet(isPresented: $showingBreachFromTour) {
        NavigationStack { MonitoredIdentifiersView() }
      }
      .task {
        await refreshActiveRecovery()
        // Previously we slept 500ms before presenting the tour "so the
        // layout settles." In practice that 500ms window is where users
        // tap something and the tour then yanks control away from
        // them, reading as a bug. Decide synchronously: if the user
        // already finished the tour or has an active recovery in
        // flight, do nothing. Otherwise present immediately.
        guard !tourCompleted, activeRecovery == nil else { return }
        showingTour = true
      }
  }

  private func refreshActiveRecovery(force: Bool = false) async {
    // Debounce: skip the network round-trip if we already have an active
    // session OR we fetched within the last 30 seconds. The triage/close
    // handlers pass `force: true` so a just-created or just-ended session
    // is reflected immediately regardless of the cooldown.
    if !force {
      if activeRecovery != nil { return }
      if let last = lastActiveRecoveryFetch, Date().timeIntervalSince(last) < 30 {
        return
      }
    }
    do {
      let response = try await APIClient.shared.activeRecovery()
      lastActiveRecoveryFetch = Date()
      withAnimation(AegisMotion.spring) {
        activeRecovery = response.active ? response.session : nil
      }
    } catch {
      // Don't block the whole Home screen on a transient 401 or network
      // blip — but DO log so a real backend outage is discoverable in
      // the PostHog + Sentry feed instead of silently stranding the
      // user's "resume recovery" card.
      Track.event(.apiErrorSilenced, ["endpoint": "activeRecovery", "error": String(describing: error)])
    }
  }

  private var header: some View {
    HStack(alignment: .center) {
      VStack(alignment: .leading, spacing: AegisSpacing.xs) {
        Text(greeting)
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
          .textCase(.uppercase)
          .tracking(1.2)
        Text("AegisDial")
          .font(AegisType.title)
          .foregroundStyle(AegisColor.textPrimary)
      }
      Spacer()
    }
  }

  private var greeting: String {
    let hour = Calendar.current.component(.hour, from: .now)
    switch hour {
    case 5..<12: return "Good morning"
    case 12..<17: return "Good afternoon"
    case 17..<22: return "Good evening"
    default: return "Late night"
    }
  }

  private var lookupCard: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      Text("Look up a number")
        .font(AegisType.heading)
        .foregroundStyle(AegisColor.textPrimary)

      HStack(spacing: AegisSpacing.s) {
        Image(systemName: "phone.fill")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(AegisColor.textTertiary)
          .frame(width: 24)
          .accessibilityHidden(true)

        TextField("+1 555 123 4567", text: $input)
          .font(AegisType.mono)
          .foregroundStyle(AegisColor.textPrimary)
          .keyboardType(.phonePad)
          .textContentType(.telephoneNumber)
          .focused($inputFocused)
          .submitLabel(.search)
          .onSubmit { Task { await runLookup() } }
          .tint(AegisColor.accent)

        if !input.isEmpty {
          Button { input = "" } label: {
            Image(systemName: "xmark.circle.fill")
              .font(.system(size: 18))
              .foregroundStyle(AegisColor.textTertiary)
          }
          .transition(.opacity.combined(with: .scale))
          .accessibilityLabel("Clear phone number")
        }
      }
      .padding(.horizontal, AegisSpacing.m)
      .frame(height: 60)
      .background(AegisColor.surface)
      .overlay(
        RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous)
          .stroke(inputFocused ? AegisColor.accent.opacity(0.7) : AegisColor.hairlineStrong, lineWidth: 1.5)
      )
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous))
      .animation(AegisMotion.snappy, value: inputFocused)
      .animation(AegisMotion.snappy, value: input.isEmpty)

      Button { Task { await runLookup() } } label: {
        HStack(spacing: AegisSpacing.s) {
          if lookingUp {
            ProgressView().tint(.black).controlSize(.small)
          } else {
            Image(systemName: "shield.lefthalf.filled")
              .accessibilityHidden(true)
          }
          Text(lookingUp ? "Analyzing..." : "Check this number")
            .font(AegisType.bodyBold)
        }
        .frame(maxWidth: .infinity, minHeight: 54)
        .foregroundStyle(.black)
        .background(AegisColor.textPrimary)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        .opacity(canLookup ? 1 : 0.35)
      }
      .disabled(!canLookup || lookingUp)
    }
    .padding(AegisSpacing.l)
    .background(AegisColor.surfaceElevated)
    .overlay(RoundedRectangle(cornerRadius: AegisRadius.l).stroke(AegisColor.hairline, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous))
  }

  private var canLookup: Bool {
    input.filter(\.isNumber).count >= 10
  }

  private var recentSection: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      HStack {
        Text("Recent lookups")
          .font(AegisType.heading)
          .foregroundStyle(AegisColor.textPrimary)
        Spacer()
        Text("\(history.count)")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
      }
      VStack(spacing: AegisSpacing.s) {
        ForEach(Array(history.prefix(5).enumerated()), id: \.offset) { _, r in
          HistoryRow(result: r)
            .onTapGesture { result = r }
        }
      }
    }
    .padding(.top, AegisSpacing.l)
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(AegisColor.verdictSpoofHigh)
      Text(message).font(AegisType.body).foregroundStyle(AegisColor.textPrimary)
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.verdictSpoofHigh.opacity(0.12))
    .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.verdictSpoofHigh.opacity(0.35), lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  // MARK: - Actions

  private func runLookup() async {
    let normalized = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return }
    inputFocused = false
    errorMessage = nil
    lookingUp = true
    AegisHaptic.light.play()
    do {
      let r = try await APIClient.shared.verdict(number: normalized)
      result = r
      history.insert(r, at: 0)
      if history.count > 20 { history.removeLast(history.count - 20) }
      hapticForVerdict(r.verdict)
    } catch {
      // Unified mapping: APIError, URLError, and anything else all
      // flow through AegisError.from so the user sees consistent,
      // plain-language copy instead of Cocoa's "The data couldn't…"
      errorMessage = AegisError.from(error).userMessage
      AegisHaptic.error.play()
    }
    lookingUp = false
  }

  private func hapticForVerdict(_ v: VerdictResponse.Verdict) {
    switch v {
    case .trusted: AegisHaptic.success.play()
    case .unknown: AegisHaptic.soft.play()
    case .suspicious, .likelySpoof: AegisHaptic.warning.play()
    case .spoofRiskHigh: AegisHaptic.error.play()
    }
  }

  private func reportCurrent() {
    guard let r = result else { return }
    Task {
      try? await APIClient.shared.report(number: r.number, category: "scam", note: nil)
      AegisHaptic.success.play()
      // Immediately offer Recovery — this is the moment of peak user
      // intent. They just confirmed it's a scam; they're likely thinking
      // "what now?"
      recoveryStartSeedNumber = r.number
      showingRecoveryStart = true
    }
  }
}

private struct HistoryRow: View {
  let result: VerdictResponse
  var body: some View {
    HStack(spacing: AegisSpacing.m) {
      Circle()
        .fill(result.verdict.color)
        .frame(width: 10, height: 10)
      VStack(alignment: .leading, spacing: 2) {
        Text(result.number)
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
        Text(result.verdict.displayName)
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
      }
      Spacer()
      Text("\(result.trustScore)")
        .font(.system(size: 20, weight: .semibold, design: .rounded))
        .foregroundStyle(result.verdict.color)
      Image(systemName: "chevron.right")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(AegisColor.textTertiary)
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairline, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }
}

extension VerdictResponse.Verdict {
  var color: Color {
    switch self {
    case .trusted: return AegisColor.verdictTrusted
    case .unknown: return AegisColor.verdictUnknown
    case .suspicious: return AegisColor.verdictSuspicious
    case .likelySpoof: return AegisColor.verdictLikelySpoof
    case .spoofRiskHigh: return AegisColor.verdictSpoofHigh
    }
  }

  var displayName: String {
    switch self {
    case .trusted: return "Trusted"
    case .unknown: return "Unknown"
    case .suspicious: return "Suspicious"
    case .likelySpoof: return "Likely Spoof"
    case .spoofRiskHigh: return "High Spoof Risk"
    }
  }
}
