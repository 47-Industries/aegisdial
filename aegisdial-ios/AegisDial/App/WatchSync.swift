import Foundation
import WatchConnectivity

// iPhone-side WatchConnectivity sender. Pushes the current shield
// state + unseen guardian count to the paired Watch app so the Watch
// complication/face always reflects reality.
//
// Use `.updateApplicationContext(_:)` rather than `.sendMessage(_:)`
// — context updates are queued, survive wake cycles, and don't need
// the Watch app in foreground. Perfect for ambient status.

@MainActor
final class WatchSync: NSObject {
  static let shared = WatchSync()

  /// Handler the active LiveShieldSession installs when it goes
  /// active so the Watch's END button can tear the session down.
  /// Cleared by the session in `end(outcome:)`. Held as a plain
  /// closure rather than a weak ref to the session itself — the
  /// closure can `await session.end(...)` and then `nil` itself out.
  var onRequestShieldEnd: (() -> Void)?

  private override init() {
    super.init()
    if WCSession.isSupported() {
      WCSession.default.delegate = self
      WCSession.default.activate()
    }
  }

  /// Push current protection state to the Watch. Call on shield
  /// start/end, on guardian alert refresh, and on scene active.
  func push(
    activeShield: Bool,
    currentRisk: String,
    riskScore: Int,
    unseenGuardianCount: Int
  ) {
    let session = WCSession.default
    guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else {
      return
    }
    let context: [String: Any] = [
      "active_shield": activeShield,
      "current_risk": currentRisk,
      "risk_score": riskScore,
      "unseen_guardian_count": unseenGuardianCount,
      "updated_at": Date().timeIntervalSince1970,
    ]
    do {
      try session.updateApplicationContext(context)
    } catch {
      // Watch offline or context identical — non-fatal.
    }
  }

  /// Dispatched from the nonisolated delegate callback onto the
  /// MainActor. If no handler is set (no active shield), the
  /// message is a no-op — the Watch just saw a stale END tap.
  fileprivate func handleIncomingAction(_ action: String) {
    switch action {
    case "end_shield":
      onRequestShieldEnd?()
    default:
      break
    }
  }
}

extension WatchSync: WCSessionDelegate {
  nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
  nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
  nonisolated func sessionDidDeactivate(_ session: WCSession) {
    // Reactivate for a newly-paired Watch.
    WCSession.default.activate()
  }

  /// Watch → phone command channel. The Watch app sends
  /// `["action": "end_shield"]` when the user taps its END button.
  /// Delegate fires on a background queue, so extract the Sendable
  /// `action` string first and only hop the string across to
  /// @MainActor — `[String: Any]` isn't Sendable under Swift 6.
  nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    guard let action = message["action"] as? String else { return }
    Task { @MainActor in
      WatchSync.shared.handleIncomingAction(action)
    }
  }
}
