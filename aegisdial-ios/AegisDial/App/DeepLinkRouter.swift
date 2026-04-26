import SwiftUI
import Observation

// Central routing target for push notification taps. AppDelegate
// forwards the userInfo payload here; AppShellView observes this
// object and flips the selected tab / drives a deep-link sheet.
//
// The payload shape matches what pushDispatcher.ts sends on the
// backend (see guardian_alert data field):
//   { alert_id, kind, severity, session_id?, monitored_id?, … }

@MainActor
@Observable
public final class DeepLinkRouter {
  public static let shared = DeepLinkRouter()

  public enum Destination: Hashable {
    case guardianAlert(id: String)
    case breachAlert(id: String)
    case shieldSession(id: String)
    case recoverySession(id: String)
    case familyContacts
  }

  /// Tab the shell should flip to when `destination` is set. Reset to
  /// nil by the target view once it's handled the deep link.
  public var pendingDestination: Destination?

  public func handle(userInfo: [AnyHashable: Any]) {
    let kind = userInfo["kind"] as? String ?? ""
    switch kind {
    case "shield_critical", "shield_family_emergency", "safe_word_failed", "recovery_started":
      if let id = userInfo["alert_id"] as? String {
        pendingDestination = .guardianAlert(id: id)
      } else if let sid = userInfo["session_id"] as? String {
        pendingDestination = .shieldSession(id: sid)
      }
    case "breach_new":
      if let id = userInfo["alert_id"] as? String {
        pendingDestination = .breachAlert(id: id)
      }
    default:
      // Fallback: if we got an alert_id we don't recognize, route to Inbox.
      if let id = userInfo["alert_id"] as? String {
        pendingDestination = .guardianAlert(id: id)
      }
    }
  }

  public func clear() { pendingDestination = nil }
}
