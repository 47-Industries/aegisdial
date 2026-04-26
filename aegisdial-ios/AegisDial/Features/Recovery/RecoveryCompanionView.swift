import SwiftUI
import AVFoundation

// Recovery Companion — the AI chat that sits inside every recovery
// session. Design principles on the UI side match the service's trauma-
// informed prompt:
//
//   1. Opens with a warm acknowledgment bubble the user didn't have to
//      ask for. Victims feel alone; the first bubble tells them they
//      aren't.
//   2. Soft pastel surface, no harsh red risk colors. This isn't the
//      Live Shield alerting surface; it's the support surface.
//   3. Crisis handoff is visually distinct — if the server flags a
//      crisis, the bubble gets a "Call 988" button next to it.
//   4. Input is always at the bottom. Single-line that grows. Send
//      button visible but unobtrusive. iMessage-adjacent, not Slack.
//   5. The send button goes disabled while the server is thinking, and
//      a typing indicator appears at the bottom of the message list.

struct RecoveryCompanionView: View {
  @Environment(\.dismiss) private var dismiss
  let sessionId: String
  /// Optional seed message shown when there's zero history — the
  /// opening "I'm here with you" hello from the Companion.
  var openingMessage: String?
  /// Pre-loss "is this a scam?" consultation. In triage mode we show
  /// the triage banner + the Resolve button that lets the user wrap
  /// up (scam_confirmed / converted_to_recovery / not_a_scam / unclear).
  var triageMode: Bool = false
  /// Optional suggested scam type pre-selected in the resolve sheet.
  var suggestedScamType: ScamType? = nil

  @State private var messages: [APIClient.CompanionMessage] = []
  @State private var draft: String = ""
  @State private var isSending: Bool = false
  @State private var loadError: String?
  @State private var crisisLatched: Bool = false
  @State private var showingResolve: Bool = false
  @State private var showingCelebration: Bool = false
  @State private var celebratedScamType: String?
  @FocusState private var inputFocused: Bool

  // Voice mode — aging-parent accessibility. Persists across launches:
  // the target user may not remember they enabled it, and we'd rather
  // have it stay on (it's a discovery feature) than force them to hunt
  // for the toggle every session. Off by default for new users.
  @AppStorage("recovery.companion.voice_mode") private var voiceMode: Bool = false
  @State private var synthesizer = AVSpeechSynthesizer()
  /// Ids of assistant messages we've already spoken, so re-fetching the
  /// list (which happens after every send) doesn't re-speak old replies.
  @State private var spokenMessageIds: Set<String> = []

  var body: some View {
    NavigationStack {
      ZStack {
        AegisColor.background.ignoresSafeArea()
        VStack(spacing: 0) {
          if triageMode { triageBanner }
          if let loadError {
            errorBanner(loadError)
              .padding(.horizontal, AegisSpacing.l)
              .padding(.top, AegisSpacing.s)
          }
          scrollView
          crisisBanner
          inputBar
        }
      }
      .navigationTitle(triageMode ? "Is this a scam?" : "Here with you")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if triageMode {
          ToolbarItem(placement: .topBarLeading) {
            Button {
              showingResolve = true
            } label: {
              Text("Resolve")
                .font(AegisType.bodyBold)
                .foregroundStyle(AegisColor.accent)
            }
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          voiceToggleButton
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close") { dismiss() }.tint(AegisColor.accent)
        }
      }
    }
    .preferredColorScheme(.dark)
    .task { await initialLoad() }
    .onDisappear {
      // Leaving the view kills any in-flight utterance. Never let the
      // app keep talking over a user who's already moved on.
      synthesizer.stopSpeaking(at: .immediate)
    }
    .onChange(of: messages) { _, newMessages in
      guard voiceMode else { return }
      speakNewAssistantMessages(in: newMessages)
    }
    .onChange(of: voiceMode) { _, enabled in
      if !enabled {
        synthesizer.stopSpeaking(at: .immediate)
      } else {
        // Seed "already spoken" with everything we already have, so
        // flipping the toggle on doesn't replay the whole history.
        spokenMessageIds = Set(messages.filter { $0.role == "assistant" }.map(\.id))
      }
    }
    .sheet(isPresented: $showingResolve) {
      TriageResolveSheet(
        sessionId: sessionId,
        suggestedScamType: suggestedScamType,
        onResolved: { session, celebrate in
          if celebrate {
            celebratedScamType = session.session.scamType
            showingCelebration = true
          } else {
            // Converted to recovery, not-a-scam, or unclear — close the
            // companion so HomeView re-polls activeRecovery.
            dismiss()
          }
        }
      )
      .presentationDetents([.large])
    }
    .fullScreenCover(isPresented: $showingCelebration) {
      ScamPreventedCelebration(
        scamTypeDisplayName: prettyScamType(celebratedScamType),
        onClose: { dismiss() }
      )
    }
  }

  private func prettyScamType(_ raw: String?) -> String? {
    guard let raw, raw != "unknown_triage", raw != "generic" else { return nil }
    return raw.replacingOccurrences(of: "_", with: " ")
  }

  private var scrollView: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: AegisSpacing.m) {
          if messages.isEmpty && loadError == nil {
            openingHello
          }
          ForEach(messages) { msg in
            messageBubble(msg).id(msg.id)
          }
          if isSending { typingIndicator.id("typing") }
          Color.clear.frame(height: 1).id("bottom")
        }
        .padding(AegisSpacing.l)
      }
      .onChange(of: messages.count) { _, _ in
        withAnimation(AegisMotion.spring) { proxy.scrollTo("bottom", anchor: .bottom) }
      }
      .onChange(of: isSending) { _, _ in
        withAnimation(AegisMotion.snappy) { proxy.scrollTo("bottom", anchor: .bottom) }
      }
    }
  }

  private var openingHello: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "heart.text.square.fill")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(AegisColor.accent.gradient)
      Text(openingMessage ?? defaultOpener)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      Text("What you say here is private. I won't tell your family or anyone else — that's your decision, when you're ready.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .padding(.top, AegisSpacing.xs)
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .overlay(
      RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
        .stroke(AegisColor.accent.opacity(0.3), lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var defaultOpener: String {
    if triageMode {
      return "It's smart of you to check before you do anything. Tell me what happened — who called, what they said, what they asked for — and I'll figure out with you whether this was a scam. If you're still on the call, hang up first. A real bank, agency, or family member will understand."
    }
    return "I'm here with you. What happened was not your fault — scammers are professional manipulators, and being caught doesn't mean you're weak or stupid. Tell me what you need most right now, or just say how you're feeling."
  }

  private var triageBanner: some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: "questionmark.bubble.fill")
        .foregroundStyle(AegisColor.accent)
      VStack(alignment: .leading, spacing: 2) {
        Text("We're figuring this out together")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textPrimary)
        Text("Tap **Resolve** when you know what happened — or keep chatting.")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
      }
      Spacer()
    }
    .padding(.horizontal, AegisSpacing.l)
    .padding(.vertical, AegisSpacing.s)
    .background(AegisColor.accent.opacity(0.12))
  }

  private func messageBubble(_ msg: APIClient.CompanionMessage) -> some View {
    HStack(alignment: .top, spacing: AegisSpacing.s) {
      if msg.role == "user" {
        Spacer(minLength: 32)
        Text(msg.content)
          .font(AegisType.body)
          .foregroundStyle(.black)
          .padding(.horizontal, AegisSpacing.m)
          .padding(.vertical, AegisSpacing.s)
          .background(AegisColor.accent)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
          .fixedSize(horizontal: false, vertical: true)
      } else {
        VStack(alignment: .leading, spacing: AegisSpacing.s) {
          // Verbatim (not Markdown-init): the server sanitizer strips
          // Markdown links, bare URLs, and HTML before the message ever
          // reaches the client, but we double-defend by rendering plain
          // text here. Bold / italic intentionally sacrificed for safety.
          Text(verbatim: msg.content)
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          if msg.crisisDetected {
            crisisActionRow
          }
        }
        .padding(.horizontal, AegisSpacing.m)
        .padding(.vertical, AegisSpacing.s)
        .background(AegisColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        Spacer(minLength: 32)
      }
    }
  }

  private var crisisActionRow: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.xs) {
      Button {
        if let url = URL(string: "tel://988") { UIApplication.shared.open(url) }
      } label: {
        Label("Call or text 988 — Crisis Lifeline", systemImage: "phone.fill")
          .font(AegisType.bodyBold)
          .frame(maxWidth: .infinity, minHeight: 48)
          .foregroundStyle(.black)
          .background(AegisColor.verdictTrusted)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous))
      }
      Button {
        if let url = URL(string: "tel://18779083360") { UIApplication.shared.open(url) }
      } label: {
        Label("AARP Fraud Helpline — 1-877-908-3360", systemImage: "phone")
          .font(AegisType.caption)
          .frame(maxWidth: .infinity, minHeight: 40)
          .foregroundStyle(AegisColor.textPrimary)
          .overlay(
            RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous)
              .stroke(AegisColor.hairlineStrong, lineWidth: 1)
          )
      }
    }
  }

  private var typingIndicator: some View {
    HStack(spacing: 6) {
      ForEach(0..<3) { i in
        Circle()
          .fill(AegisColor.textTertiary)
          .frame(width: 6, height: 6)
          .opacity(0.4)
          .scaleEffect(1)
          .animation(
            .easeInOut(duration: 0.8).repeatForever().delay(Double(i) * 0.15),
            value: isSending
          )
      }
    }
    .padding(.horizontal, AegisSpacing.m)
    .padding(.vertical, AegisSpacing.s)
    .background(AegisColor.surface)
    .clipShape(Capsule())
  }

  @ViewBuilder
  private var crisisBanner: some View {
    if crisisLatched {
      HStack(spacing: AegisSpacing.s) {
        Image(systemName: "heart.fill").foregroundStyle(AegisColor.verdictTrusted)
        Text("If you're in crisis, please call or text 988 any time. You come first.")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textPrimary)
        Spacer()
      }
      .padding(AegisSpacing.m)
      .background(AegisColor.verdictTrusted.opacity(0.12))
    }
  }

  private var inputBar: some View {
    // Apple HIG + WCAG 2.1 AA: every tappable control needs a ≥44×44
    // hit region. We enforce that on both the TextField row and the
    // send button independently so a soft / missed tap still lands on
    // the intended control.
    HStack(alignment: .bottom, spacing: AegisSpacing.s) {
      TextField("Say how you're feeling, or ask about a step…", text: $draft, axis: .vertical)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textPrimary)
        .tint(AegisColor.accent)
        .lineLimit(1...5)
        .padding(.horizontal, AegisSpacing.m)
        .padding(.vertical, AegisSpacing.s)
        .frame(minHeight: 44)
        .background(AegisColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        .focused($inputFocused)
      Button {
        Task { await send() }
      } label: {
        Image(systemName: "arrow.up.circle.fill")
          .font(.system(size: 32, weight: .semibold))
          .foregroundStyle(
            draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending
              ? AegisColor.textTertiary
              : AegisColor.accent
          )
          .frame(width: 44, height: 44, alignment: .center)
          .contentShape(Rectangle())
      }
      .disabled(
        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending
      )
    }
    .padding(.horizontal, AegisSpacing.l)
    .padding(.vertical, AegisSpacing.m)
    .background(AegisColor.background)
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

  // MARK: - Actions

  private func initialLoad() async {
    do {
      messages = try await APIClient.shared.companionMessages(sessionId: sessionId)
      crisisLatched = messages.contains { $0.crisisDetected }
      // Mark history as already-spoken on entry — we only voice
      // new assistant replies, not the scroll-back.
      spokenMessageIds = Set(messages.filter { $0.role == "assistant" }.map(\.id))
    } catch {
      loadError = error.localizedDescription
    }
  }

  // MARK: - Voice mode

  private var voiceToggleButton: some View {
    Button {
      voiceMode.toggle()
      AegisHaptic.light.play()
    } label: {
      Image(systemName: voiceMode ? "speaker.wave.2.fill" : "speaker.slash")
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(voiceMode ? AegisColor.accent : AegisColor.textSecondary)
    }
    .accessibilityLabel(voiceMode ? "Turn voice off" : "Turn voice on")
  }

  /// Speak any assistant messages we haven't spoken yet. Detached on
  /// the MainActor so the UI never blocks on queueing.
  private func speakNewAssistantMessages(in list: [APIClient.CompanionMessage]) {
    let fresh = list.filter { $0.role == "assistant" && !spokenMessageIds.contains($0.id) }
    guard !fresh.isEmpty else { return }
    for msg in fresh { spokenMessageIds.insert(msg.id) }
    Task { @MainActor in
      for msg in fresh {
        speak(msg.content)
      }
    }
  }

  private func speak(_ text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    let utterance = AVSpeechUtterance(string: trimmed)
    // Default US English voice. AVSpeechUtteranceDefaultSpeechRate is
    // ~0.5; older listeners ask us to slow down — 0.42 lands near the
    // accessibility guideline without feeling robotically slow.
    utterance.rate = 0.42
    utterance.pitchMultiplier = 1.0
    utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
    synthesizer.speak(utterance)
  }

  private func send() async {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !isSending else { return }
    // User is typing back — cut off whatever the Companion was saying.
    synthesizer.stopSpeaking(at: .immediate)
    draft = ""
    isSending = true
    defer { isSending = false }

    // Optimistic append so the user sees their message immediately.
    let provisional = APIClient.CompanionMessage(
      id: "local-\(UUID().uuidString)",
      role: "user",
      content: text,
      crisisDetected: false,
      createdAt: ISO8601DateFormatter().string(from: Date())
    )
    messages.append(provisional)

    do {
      let reply = try await APIClient.shared.sendCompanionMessage(
        sessionId: sessionId,
        message: text
      )
      // Refresh from server so optimistic row gets its real id + the
      // assistant reply lands in the history stream.
      messages = try await APIClient.shared.companionMessages(sessionId: sessionId)
      if reply.crisisDetected { crisisLatched = true }
    } catch {
      loadError = error.localizedDescription
      // Leave the optimistic message — user sees their words weren't lost.
    }
  }
}
