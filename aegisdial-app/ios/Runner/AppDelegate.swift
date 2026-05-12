import Flutter
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  // MARK: - APNs bridge
  //
  // Channel name must match `device_service.dart`. The Flutter side
  // owns the timing — when auth succeeds it calls
  // `requestPermission()` → `register()` here, then waits on the same
  // channel for the resulting `apns_token` event.
  //
  // We never call registerForRemoteNotifications() at launch — that
  // would prompt before the user has any context for the request.
  // Permission and registration are triggered from Flutter after the
  // home dashboard mounts.
  private let pushChannelName = "aegisdial/push"
  private var pushChannel: FlutterMethodChannel?
  // Buffered tap so a notification opening the app from terminated
  // state still routes correctly — the Flutter channel may not be
  // wired yet at the moment the OS hands us the userInfo.
  private var pendingTapPayload: [String: Any]?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // Make this class the UNUserNotificationCenter delegate so we get
    // the willPresent / didReceive callbacks below.
    UNUserNotificationCenter.current().delegate = self

    // If the app was launched by tapping a notification while it was
    // terminated, the userInfo arrives here via launchOptions. Stash
    // it for hand-off once Flutter wires the channel.
    if let userInfo = launchOptions?[.remoteNotification] as? [String: Any] {
      pendingTapPayload = userInfo
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)

    let channel = FlutterMethodChannel(
      name: pushChannelName,
      binaryMessenger: engineBridge.binaryMessenger
    )
    pushChannel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self = self else { return }
      switch call.method {
      case "requestPermissionAndRegister":
        // Two-step: ask iOS for alert/badge/sound permission, then
        // (only if granted) hand off to the OS to provision an APNs
        // token. The token comes back asynchronously via
        // didRegisterForRemoteNotificationsWithDeviceToken below.
        UNUserNotificationCenter.current().requestAuthorization(
          options: [.alert, .badge, .sound]
        ) { granted, _ in
          DispatchQueue.main.async {
            if granted {
              UIApplication.shared.registerForRemoteNotifications()
            }
            result(granted)
          }
        }
      case "isPermissionGranted":
        UNUserNotificationCenter.current().getNotificationSettings { settings in
          DispatchQueue.main.async {
            result(settings.authorizationStatus == .authorized
              || settings.authorizationStatus == .provisional)
          }
        }
      case "drainPendingTap":
        // Flutter calls this on first cold-start route. Returns the
        // userInfo of a notification that launched the app, or null.
        if let payload = self.pendingTapPayload {
          self.pendingTapPayload = nil
          result(payload)
        } else {
          result(nil)
        }
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  // Called by iOS after registerForRemoteNotifications() succeeds.
  // The deviceToken is opaque bytes — backend wants the hex string.
  override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
    pushChannel?.invokeMethod("onAPNsToken", arguments: hex)
  }

  override func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    pushChannel?.invokeMethod(
      "onAPNsRegistrationFailed",
      arguments: error.localizedDescription
    )
  }
}

// MARK: - Notification presentation + tap routing
//
// Two callbacks we care about:
//   willPresent — fires when a push arrives while the app is in the
//                 foreground. iOS would normally suppress the banner;
//                 we explicitly request .banner + .sound so a Live
//                 Shield critical-takeover push (kind=v3_takeover) is
//                 always visible even if the user has the app open.
//   didReceive  — fires when the user taps a notification. We forward
//                 the userInfo to Flutter so the route handler can
//                 deep-link to the right screen (e.g. recovery for a
//                 family-alert tap).
extension AppDelegate {
  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler:
      @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound, .badge])
  }

  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    let dict = userInfo.reduce(into: [String: Any]()) { acc, kv in
      if let key = kv.key as? String { acc[key] = kv.value }
    }
    pushChannel?.invokeMethod("onNotificationTap", arguments: dict)
    completionHandler()
  }
}
