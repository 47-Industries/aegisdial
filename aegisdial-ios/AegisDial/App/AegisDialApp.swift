import SwiftUI
import UIKit

@main
struct AegisDialApp: App {
  @UIApplicationDelegateAdaptor(AegisAppDelegate.self) private var appDelegate
  @State private var auth = AuthStore()
  @State private var subs = SubscriptionStore()

  var body: some Scene {
    WindowGroup {
      AppRootView()
        .environment(auth)
        .environment(subs)
        .preferredColorScheme(.dark) // dark is the primary design surface
        .tint(AegisColor.accent)
    }
  }
}

// AppDelegate glue for APNs. SwiftUI's scene lifecycle doesn't expose
// the APNs device-token callback directly, so we keep a slim UIKit
// delegate just for push registration + token forwarding.
final class AegisAppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    Task { @MainActor in PushRegistrar.shared.registerToken(deviceToken) }
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    // Non-fatal — user still sees alerts in-app. But we DO want this in
    // PostHog so we can spot a cert/provisioning regression across users
    // instead of silently shipping a build where push is broken.
    Track.event(.apiErrorSilenced, [
      "endpoint": "apns_register",
      "error": String(describing: error),
    ])
  }
}

extension AegisAppDelegate: UNUserNotificationCenterDelegate {
  // Show banners even when app is in foreground.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound, .badge])
  }

  // User tapped the notification. Parse userInfo and route the app to
  // the relevant screen via DeepLinkRouter.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    Task { @MainActor in
      DeepLinkRouter.shared.handle(userInfo: userInfo)
    }
    completionHandler()
  }
}
