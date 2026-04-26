import Foundation
import Observation

// Canned demo scenarios that feed the REAL /v1/live-shield endpoints
// with scripted transcripts. Users can see exactly how the shield
// reacts to a scam call without having to take one. Fires a timer
// that drips chunks at roughly natural speech speed (~3.5 s/chunk).

@MainActor
@Observable
public final class LiveShieldDemoRunner: Identifiable {
  public let id = UUID()
  public let session: LiveShieldSession
  public let scenario: Scenario
  private var driver: Task<Void, Never>?

  public init(scenario: Scenario) {
    self.scenario = scenario
    self.session = LiveShieldSession()
  }

  public func start() async {
    // Bypass real mic/speech — we'll just post scripted chunks.
    // LiveShieldSession.start() hits /v1/live-shield/start then opens
    // the mic. For demo, we call the API directly.
    do {
      let started = try await APIClient.shared.liveShieldStart(
        peerNumber: scenario.peerNumber,
        direction: .inbound,
        consentGiven: true
      )
      session.sessionId = started.sessionId
      session.peerNumber = scenario.peerNumber
      session.startedAt = Date()
      session.state = .active
      session.riskScore = started.riskScore
      session.riskLevel = started.riskLevel
    } catch {
      session.state = .failed(error.localizedDescription)
      return
    }

    driver = Task { @MainActor [weak self] in
      guard let self, let sid = self.session.sessionId else { return }
      var seq = 0
      for line in self.scenario.lines {
        try? await Task.sleep(nanoseconds: UInt64(line.delaySeconds * 1_000_000_000))
        if Task.isCancelled { break }
        do {
          let resp = try await APIClient.shared.liveShieldTranscript(
            sessionId: sid,
            seq: seq,
            speaker: .caller,
            text: line.text,
            confidence: 0.92
          )
          self.session.partialTranscript += line.text + " "
          self.session.riskScore = resp.riskScore
          self.session.riskLevel = resp.riskLevel
          self.session.triggeredCategories = resp.triggeredCategories
          self.session.familyVerifySuggested = resp.familyVerifySuggested ?? false
          self.session.familySuggestion = resp.familySuggestion
          if !resp.newWarnings.isEmpty {
            self.session.warnings.append(contentsOf: resp.newWarnings)
          }
        } catch {
          self.session.lastError = error.localizedDescription
        }
        seq += 1
      }
    }
  }

  public func stop() async {
    driver?.cancel()
    driver = nil
    await session.end(outcome: .userCompleted)
  }

  // MARK: - Scenarios

  public struct Scenario: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let description: String
    public let peerNumber: String
    public let lines: [Line]
    public let icon: String
  }

  public struct Line: Hashable, Sendable {
    public let text: String
    public let delaySeconds: Double
  }

  public static let scenarios: [Scenario] = [
    .init(
      id: "bank_fraud_dept",
      title: "\"Bank fraud department\"",
      description: "Classic bank-impersonation scam: fake fraud alert, safe-account request, isolation pressure.",
      peerNumber: "+18001234567",
      icon: "building.2.fill",
      lines: [
        .init(text: "Hi this is Sarah from the Chase fraud department.", delaySeconds: 2.0),
        .init(text: "We've seen unauthorized charges on your account.", delaySeconds: 3.5),
        .init(text: "To secure your money you need to move it to a safe account right now.", delaySeconds: 4.0),
        .init(text: "Do not hang up the phone and do not tell the teller why you're withdrawing.", delaySeconds: 4.5),
      ]
    ),
    .init(
      id: "grandchild_bail",
      title: "\"Grandma, I'm in jail\"",
      description: "Voice-clone emergency-relative scam. Watch the family-verify panel appear.",
      peerNumber: "+14155559876",
      icon: "person.crop.circle.badge.exclamationmark",
      lines: [
        .init(text: "Grandma it's me please don't hang up", delaySeconds: 2.0),
        .init(text: "I've been arrested and I need bail money", delaySeconds: 3.5),
        .init(text: "Please don't tell mom or dad I'm embarrassed", delaySeconds: 4.0),
        .init(text: "Can you wire me the money right now", delaySeconds: 4.0),
      ]
    ),
    .init(
      id: "tech_support_remote",
      title: "\"Microsoft tech support\"",
      description: "Fake tech-support scam: remote access request + urgency.",
      peerNumber: "+18005551212",
      icon: "desktopcomputer.trianglebadge.exclamationmark",
      lines: [
        .init(text: "Your computer has been compromised by a virus.", delaySeconds: 2.0),
        .init(text: "Please download AnyDesk so I can remotely fix it.", delaySeconds: 3.5),
        .init(text: "Share your screen and give me the code on your screen immediately.", delaySeconds: 4.0),
      ]
    ),
    .init(
      id: "irs_warrant",
      title: "\"IRS arrest warrant\"",
      description: "Government impersonation with arrest threat + urgency + gift cards.",
      peerNumber: "+18002223333",
      icon: "building.columns.fill",
      lines: [
        .init(text: "This is the IRS and there is an arrest warrant in your name for tax fraud.", delaySeconds: 2.0),
        .init(text: "You must pay the balance within the hour or police will be dispatched.", delaySeconds: 4.0),
        .init(text: "Please go to Walmart and buy Apple gift cards to settle the debt.", delaySeconds: 4.0),
        .init(text: "Stay on the line until you complete the transaction.", delaySeconds: 3.5),
      ]
    ),
  ]
}
