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

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
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
