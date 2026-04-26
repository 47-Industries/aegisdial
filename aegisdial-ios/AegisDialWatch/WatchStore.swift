import Foundation
import Observation
import WatchConnectivity

// Shared state that the watch app renders from. Populated via
// WatchConnectivity messages from the iPhone app. Persists last-known
// values in UserDefaults so the watch face shows something useful
// even when the phone is out of range.

@MainActor
@Observable
final class WatchStore: NSObject {
  static let shared = WatchStore()

  var activeShield: Bool = false
  var currentRisk: String = "low"   // low / medium / high / critical
  var currentRiskScore: Int = 0
  var unseenGuardianCount: Int = 0
  var lastUpdated: Date?

  private let defaults = UserDefaults.standard

  private override init() {
    super.init()
    loadCached()
    if WCSession.isSupported() {
      WCSession.default.delegate = self
      WCSession.default.activate()
    }
  }

  private func loadCached() {
    activeShield = defaults.bool(forKey: "watch.active_shield")
    currentRisk = defaults.string(forKey: "watch.current_risk") ?? "low"
    currentRiskScore = defaults.integer(forKey: "watch.risk_score")
    unseenGuardianCount = defaults.integer(forKey: "watch.unseen_guardian_count")
    if let t = defaults.object(forKey: "watch.updated_at") as? Date {
      lastUpdated = t
    }
  }

  private func apply(_ payload: [String: Any]) {
    if let v = payload["active_shield"] as? Bool { activeShield = v }
    if let v = payload["current_risk"] as? String { currentRisk = v }
    if let v = payload["risk_score"] as? Int { currentRiskScore = v }
    if let v = payload["unseen_guardian_count"] as? Int { unseenGuardianCount = v }
    lastUpdated = Date()
    defaults.set(activeShield, forKey: "watch.active_shield")
    defaults.set(currentRisk, forKey: "watch.current_risk")
    defaults.set(currentRiskScore, forKey: "watch.risk_score")
    defaults.set(unseenGuardianCount, forKey: "watch.unseen_guardian_count")
    defaults.set(lastUpdated, forKey: "watch.updated_at")
  }
}

extension WatchStore: WCSessionDelegate {
  nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

  nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    Task { @MainActor in self.apply(message) }
  }

  nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    Task { @MainActor in self.apply(applicationContext) }
  }
}
