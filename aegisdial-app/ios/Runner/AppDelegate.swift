import Flutter
import UIKit
import UserNotifications
import CallKit

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
  private let extChannelName = "aegisdial/extensions"
  private var pushChannel: FlutterMethodChannel?
  private var extChannel: FlutterMethodChannel?
  private let appGroupSuite = "group.com.aegisdial.app"
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

    // `FlutterImplicitEngineBridge` doesn't expose `binaryMessenger`
    // directly. The recommended path is `applicationRegistrar.messenger()`
    // — same FlutterBinaryMessenger object the engine uses for its own
    // platform channels.
    let channel = FlutterMethodChannel(
      name: pushChannelName,
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
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

    // ── Extensions bridge channel ──
    let ext = FlutterMethodChannel(
      name: extChannelName,
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    extChannel = ext
    ext.setMethodCallHandler { [weak self] call, result in
      guard let self = self else { return }
      guard let defaults = UserDefaults(suiteName: self.appGroupSuite) else {
        result(false)
        return
      }

      switch call.method {
      case "pushScamPhrases":
        let args = call.arguments as? [String: Any]
        let phrases = args?["phrases"] as? [String] ?? []
        defaults.set(phrases, forKey: "aegis_scam_phrases")
        result(true)

      case "pushBlockedSenders":
        let args = call.arguments as? [String: Any]
        let senders = args?["senders"] as? [String] ?? []
        defaults.set(senders, forKey: "aegis_blocked_senders")
        result(true)

      case "pushBlockedNumbers":
        let args = call.arguments as? [String: Any]
        let numbers = args?["numbers"] as? [Int64] ?? []
        defaults.set(numbers, forKey: "aegis_blocked_numbers")
        // Trigger Call Directory reload
        CXCallDirectoryManager.sharedInstance.reloadExtension(
          withIdentifier: "com.aegisdial.app.CallDirectory"
        ) { error in
          // Best-effort — errors logged to shared container by the extension
        }
        result(true)

      case "pushLabeledNumbers":
        let args = call.arguments as? [String: Any]
        let entries = args?["entries"] as? [[String: Any]] ?? []
        defaults.set(entries, forKey: "aegis_labeled_numbers")
        CXCallDirectoryManager.sharedInstance.reloadExtension(
          withIdentifier: "com.aegisdial.app.CallDirectory"
        ) { _ in }
        result(true)

      case "reloadCallDirectory":
        CXCallDirectoryManager.sharedInstance.reloadExtension(
          withIdentifier: "com.aegisdial.app.CallDirectory"
        ) { error in
          DispatchQueue.main.async {
            result(error == nil)
          }
        }

      case "isSMSFilterEnabled":
        // There's no public API to check SMS filter status directly.
        // We check if the app group defaults have been read by the
        // extension (it writes a timestamp on each filter pass).
        let lastRun = defaults.double(forKey: "aegis_smsfilter_last_run")
        let recent = lastRun > 0 && (Date().timeIntervalSince1970 - lastRun) < 86400 * 7
        result(recent)

      case "callDirectoryStatus":
        CXCallDirectoryManager.sharedInstance.getEnabledStatusForExtension(
          withIdentifier: "com.aegisdial.app.CallDirectory"
        ) { status, _ in
          let label: String
          switch status {
          case .enabled: label = "enabled"
          case .disabled: label = "disabled"
          case .unknown: label = "unknown"
          @unknown default: label = "unknown"
          }
          DispatchQueue.main.async { result(label) }
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
    // .banner is iOS 14+. .alert is the iOS 13 spelling — iOS 14+ still
    // accepts it (deprecated but functional, maps to .banner + .list).
    // Branch with #available so the iOS 13 floor compiles + the iOS 14+
    // banner-only behavior is preserved on newer OS versions.
    if #available(iOS 14.0, *) {
      completionHandler([.banner, .list, .sound, .badge])
    } else {
      completionHandler([.alert, .sound, .badge])
    }
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
