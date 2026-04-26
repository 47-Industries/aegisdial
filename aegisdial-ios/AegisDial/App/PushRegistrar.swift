import Foundation
import UIKit
import UserNotifications

// Handles APNs push registration end-to-end:
//   1. Ask the user for notification permission (soft prompt after
//      the onboarding tour finishes, not on first launch).
//   2. Register with APNs → OS returns a device token in the
//      AppDelegate callback.
//   3. Forward the hex token to our backend so we can fan out.
//
// AegisDialApp wires AppDelegate.didRegisterForRemoteNotificationsWithDeviceToken
// to PushRegistrar.shared.registerToken(_:).

@MainActor
final class PushRegistrar {
  static let shared = PushRegistrar()
  private init() {}

  /// Ask for permission and register. Safe to call multiple times —
  /// iOS will return the cached decision if already answered.
  func requestAndRegister() async {
    Track.event(.permissionPrompted, ["permission": "notifications"])
    do {
      let granted = try await UNUserNotificationCenter.current().requestAuthorization(
        options: [.alert, .badge, .sound]
      )
      Track.event(
        granted ? .permissionGranted : .permissionDenied,
        ["permission": "notifications"]
      )
      if granted {
        UIApplication.shared.registerForRemoteNotifications()
      }
    } catch {
      Track.event(.permissionDenied, ["permission": "notifications", "error": "\(error)"])
    }
  }

  /// Called from AppDelegate.didRegisterForRemoteNotificationsWithDeviceToken.
  func registerToken(_ deviceToken: Data) {
    let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
    Task {
      do {
        let env = APIConfig.pushEnvironment
        try await APIClient.shared.registerDevice(
          apnsToken: hex,
          environment: env,
          deviceModel: Self.deviceModel(),
          appVersion: Self.appVersion()
        )
      } catch {
        // Silent failure — user will see alerts in-app regardless.
      }
    }
  }

  private static func deviceModel() -> String {
    var sysinfo = utsname()
    uname(&sysinfo)
    let machine = withUnsafePointer(to: &sysinfo.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
    }
    return machine
  }

  private static func appVersion() -> String {
    let info = Bundle.main.infoDictionary
    let short = info?["CFBundleShortVersionString"] as? String ?? "?"
    let build = info?["CFBundleVersion"] as? String ?? "?"
    return "\(short) (\(build))"
  }
}
