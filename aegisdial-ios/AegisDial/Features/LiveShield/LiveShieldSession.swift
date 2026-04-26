import Foundation
import Observation
import UIKit

// Observable session controller. Owns the lifecycle of a single shielded
// call: consent → start → stream transcription → post chunks → display
// warnings → end. The UI binds to this object.
//
// Chunking policy: flush a transcript chunk to the backend whenever we
// get a final result OR every 8 seconds of partial text OR when the
// running partial passes 200 chars of new content since the last flush.
// Those thresholds are small enough to catch a kill phrase mid-sentence
// but large enough to batch speech-recognizer partials.

@MainActor
@Observable
public final class LiveShieldSession: Identifiable {
  public let id = UUID()

  public enum State: Equatable {
    case idle
    case requestingConsent
    case starting
    case active
    case ending
    case ended
    case failed(String)
  }

  public var state: State = .idle
  public var riskScore: Int = 0
  public var riskLevel: LiveShieldRiskLevel = .low
  public var warnings: [LiveShieldWarning] = []
  public var triggeredCategories: [String] = []
  public var partialTranscript: String = ""
  public var sessionId: String?
  public var peerNumber: String?
  public var direction: LiveShieldDirection = .inbound
  public var startedAt: Date?
  public var lastError: String?
  public var familyVerifySuggested: Bool = false
  public var familySuggestion: FamilySuggestion?

  private let api = APIClient.shared
  private let engine = SpeechEngine()
  private var seq: Int = 0
  private var chunkBuffer: String = ""
  private var consumedPrefix: String = ""
  private var flushTask: Task<Void, Never>?
  private var flushScheduled: Bool = false
  private var streamTask: Task<Void, Never>?
  private let hapticWarning = UINotificationFeedbackGenerator()

  public init() {
    hapticWarning.prepare()
  }

  /// Present the consent disclosure, then on user tap start the session.
  /// Caller's responsibility to gate on `isAuthorized` first.
  public func start(peer: String?) async {
    await start(peer: peer, direction: .inbound)
  }

  /// Directional variant — inbound (caller rang us) vs outbound (user
  /// chose to place a call to a suspicious number and wants coverage).
  public func start(peer: String?, direction: LiveShieldDirection) async {
    state = .starting
    peerNumber = peer
    self.direction = direction
    let authorized = await SpeechEngine.requestAuthorization()
    guard authorized else {
      state = .failed("Microphone and speech permission are required to shield a call.")
      return
    }

    do {
      let started = try await api.liveShieldStart(
        peerNumber: peer,
        direction: direction,
        consentGiven: true
      )
      sessionId = started.sessionId
      startedAt = Date()
      riskScore = started.riskScore
      riskLevel = started.riskLevel
      triggeredCategories = started.triggeredCategories
      state = .active
      pushWatchState()
      installWatchEndHandler()
      beginTranscription()
    } catch {
      state = .failed(error.localizedDescription)
      lastError = error.localizedDescription
    }
  }

  /// End the session. Safe to call from any state — always tears down
  /// local resources, and only posts /end if the backend session exists.
  public func end(outcome: LiveShieldOutcome) async {
    let wasActive = (state == .active)
    state = .ending
    streamTask?.cancel()
    flushTask?.cancel()
    flushScheduled = false
    await engine.stop()
    if wasActive { await flushBuffer(force: true) }
    if let id = sessionId, wasActive {
      do {
        let final = try await api.liveShieldEnd(sessionId: id, outcome: outcome)
        riskScore = final.riskScore
        riskLevel = final.riskLevel
        triggeredCategories = final.triggeredCategories
      } catch {
        lastError = error.localizedDescription
      }
    }
    state = .ended
    pushWatchState()
    // Drop the WatchSync handoff — a stale END tap after the session
    // is ended should be a no-op, not a crash-on-deallocated-self.
    if WatchSync.shared.onRequestShieldEnd != nil {
      WatchSync.shared.onRequestShieldEnd = nil
    }
  }

  /// Install the Watch END button handler. Fires `.unknown` outcome
  /// because the user ended from the Watch without picking a reason
  /// (the phone-side active view's end buttons pass a specific
  /// outcome; the Watch END is the "I had to hang up right now" path).
  private func installWatchEndHandler() {
    WatchSync.shared.onRequestShieldEnd = { [weak self] in
      Task { @MainActor [weak self] in
        await self?.end(outcome: .unknown)
      }
    }
  }

  /// Send the current shield state to the paired Watch. Without this,
  /// the Watch's "shield active" card never renders because WatchSync
  /// is otherwise only called from inbox-badge changes.
  private func pushWatchState() {
    let active = (state == .active)
    WatchSync.shared.push(
      activeShield: active,
      currentRisk: riskLevel.rawValue,
      riskScore: riskScore,
      unseenGuardianCount: 0
    )
  }

  private func beginTranscription() {
    streamTask = Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        let stream = try await self.engine.start()
        for try await partial in stream {
          self.partialTranscript = partial.text
          let newContent = self.extractNewContent(from: partial.text)
          if !newContent.isEmpty {
            self.chunkBuffer.append(newContent)
            self.consumedPrefix = partial.text
            if partial.isFinal || self.chunkBuffer.count >= 200 {
              await self.flushBuffer(force: false, confidence: partial.confidence)
            } else {
              self.scheduleFlush()
            }
          }
        }
      } catch {
        self.lastError = error.localizedDescription
        self.state = .failed(error.localizedDescription)
      }
    }
  }

  /// SFSpeechRecognizer's formattedString is the ENTIRE recognized text
  /// so far — not incremental. Diff against what we've already consumed
  /// to emit only the new suffix. On a rewrite (recognizer revised an
  /// earlier segment, so the new text does NOT start with our prefix),
  /// return the full latest — the caller resets `consumedPrefix` to
  /// `partial.text` so the next tick diffs correctly.
  private func extractNewContent(from latest: String) -> String {
    if latest.hasPrefix(consumedPrefix) {
      let start = latest.index(latest.startIndex, offsetBy: consumedPrefix.count)
      return String(latest[start...])
    }
    return latest
  }

  private func scheduleFlush() {
    // Chatty recognizers emit >1 partial/sec. The old approach
    // (`cancel()` + respawn every partial) leaked cancelled Tasks into
    // the MainActor queue. Instead: if a flush is already scheduled,
    // do nothing — the in-flight timer will fire and pick up whatever
    // is in the buffer at flush time.
    guard !flushScheduled else { return }
    flushScheduled = true
    flushTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 8_000_000_000)
      // Clear the scheduled flag BEFORE flushBuffer so that if the
      // flush itself produces more partials, the next scheduleFlush()
      // can arm a fresh timer.
      self?.flushScheduled = false
      await self?.flushBuffer(force: false)
    }
  }

  private func flushBuffer(force: Bool, confidence: Double? = nil) async {
    guard let id = sessionId else { return }
    let chunk = chunkBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !chunk.isEmpty else { return }
    guard force || chunk.count >= 12 else { return } // skip micro-chunks
    chunkBuffer = ""
    flushTask?.cancel()
    flushScheduled = false
    let currentSeq = seq
    seq += 1
    do {
      let resp = try await api.liveShieldTranscript(
        sessionId: id,
        seq: currentSeq,
        speaker: .unknown,
        text: chunk,
        confidence: confidence
      )
      riskScore = resp.riskScore
      riskLevel = resp.riskLevel
      triggeredCategories = resp.triggeredCategories
      familyVerifySuggested = resp.familyVerifySuggested ?? false
      // Always overwrite from the server — the suggestion can change
      // (contact added / deleted / safe word rotated) during the call.
      familySuggestion = resp.familySuggestion
      if !resp.newWarnings.isEmpty {
        warnings.append(contentsOf: resp.newWarnings)
        triggerHapticForLevel(resp.riskLevel)
        pushWatchState()
      }
    } catch {
      lastError = error.localizedDescription
    }
  }

  private func triggerHapticForLevel(_ level: LiveShieldRiskLevel) {
    let style: UINotificationFeedbackGenerator.FeedbackType
    switch level {
    case .critical: style = .error
    case .high, .medium: style = .warning
    case .low: style = .success
    }
    hapticWarning.notificationOccurred(style)
    hapticWarning.prepare()
  }
}
