// APNs registration bridge.
//
// Flow:
//   1. After auth succeeds, the home shell calls
//      `deviceService.ensureRegistered()`.
//   2. We ask iOS for notification permission (if not granted yet).
//   3. iOS pops the system prompt, then — only if the user accepts —
//      asynchronously hands back an APNs device token via the
//      MethodChannel.
//   4. On token, we POST it to `/v1/device/register` so the backend's
//      family-alert + v3 critical-takeover + recovery push paths can
//      reach this device.
//
// Channel name + method names mirror the Swift side in
// `ios/Runner/AppDelegate.swift`. Android has no APNs — this whole
// service no-ops there; iOS-first feature for v1.
//
// Re-registration: iOS rotates APNs tokens on reinstall, OS upgrades,
// and occasionally for "device migration" events. The backend's
// register route is upsert-on-(user_id, apns_token) so calling it
// every cold start is safe and recommended.

import 'dart:io' show Platform;
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api_service.dart';
import 'auth_service.dart';

/// Snapshot of the device's APNs registration health. Surfaced to the
/// Settings → Push Diagnostic tile so users (and us, when debugging
/// missing pushes) can see exactly where the chain broke. Three things
/// must all be true for a push to land: permission granted, iOS handed
/// us a token, AND the backend's /v1/device/register accepted it.
class PushDiagnostic {
  /// User granted notification permission on this install.
  final bool? permissionGranted;
  /// Last token iOS handed us (truncated for display).
  final String? lastTokenPreview;
  /// When that token was registered with the backend successfully.
  final DateTime? lastRegisteredAt;
  /// Last APNs registration failure reported by iOS (e.g. "no aps
  /// entitlement", "network unreachable"). Null = no failure recorded.
  final String? lastApnsError;
  /// Last error from POSTing the token to /v1/device/register. Null =
  /// no failure recorded.
  final String? lastRegisterError;

  const PushDiagnostic({
    this.permissionGranted,
    this.lastTokenPreview,
    this.lastRegisteredAt,
    this.lastApnsError,
    this.lastRegisterError,
  });

  /// True when iOS handed us a token AND we successfully POSTed it to
  /// the backend AND no error has been recorded since. The Settings
  /// tile uses this to render the green / red dot.
  bool get healthy =>
      lastTokenPreview != null &&
      lastRegisteredAt != null &&
      lastApnsError == null &&
      lastRegisterError == null;
}

class DeviceService {
  DeviceService._();
  static final DeviceService instance = DeviceService._();

  static const _channel = MethodChannel('aegisdial/push');

  // SharedPreferences keys. Persisted across app restarts so the
  // Settings → Push Diagnostic tile reflects the last known state even
  // after a cold boot when ensureRegistered() hasn't fired yet.
  static const _kPermGranted = 'apns_permission_granted';
  static const _kTokenPreview = 'apns_last_token_preview';
  static const _kRegisteredAtMs = 'apns_last_registered_at_ms';
  static const _kApnsError = 'apns_last_apns_error';
  static const _kRegisterError = 'apns_last_register_error';

  bool _wired = false;
  String? _lastToken;

  /// Notification-tap stream. UI screens subscribe to route based on
  /// the `kind` field in the payload (e.g. `v3_takeover`,
  /// `family_alert`, `recovery_followup`). Payloads are the raw
  /// `aps` userInfo dict from APNs — the backend's push composer is
  /// the source of truth for the schema.
  final List<void Function(Map<String, dynamic>)> _tapListeners = [];

  void addTapListener(void Function(Map<String, dynamic>) cb) {
    _tapListeners.add(cb);
    // Drain any tap that the OS handed us before this listener
    // subscribed (cold-start launch from a notification tap).
    _drainPendingTap();
  }

  void removeTapListener(void Function(Map<String, dynamic>) cb) {
    _tapListeners.remove(cb);
  }

  /// Call once at app boot so the channel handler is attached before
  /// the OS can deliver a late-arriving token (e.g. token rotation
  /// during a cold start).
  void wire() {
    if (_wired || !_supportsApns) return;
    _channel.setMethodCallHandler((call) async {
      switch (call.method) {
        case 'onAPNsToken':
          final token = call.arguments as String?;
          if (token != null && token.isNotEmpty) await _onToken(token);
          return null;
        case 'onAPNsRegistrationFailed':
          // Persist so Settings → Push Diagnostic can surface this even
          // if the user is offline and we can't ship it to the backend.
          // Without this, an APNs entitlement misconfig (most common in
          // sandbox / TestFlight first-installs) would be silent in
          // production builds.
          final msg = call.arguments?.toString() ?? 'unknown_apns_error';
          await _persistApnsError(msg);
          if (kDebugMode) {
            debugPrint('APNs registration failed: $msg');
          }
          return null;
        case 'onNotificationTap':
          _dispatchTap(call.arguments);
          return null;
        default:
          return null;
      }
    });
    _wired = true;
  }

  Future<void> _drainPendingTap() async {
    if (!_supportsApns) return;
    try {
      final payload = await _channel.invokeMethod('drainPendingTap');
      _dispatchTap(payload);
    } catch (_) {
      // No-op — native side returns null when nothing pending.
    }
  }

  void _dispatchTap(Object? raw) {
    if (raw == null) return;
    Map<String, dynamic>? payload;
    if (raw is Map) {
      payload = raw.map((k, v) => MapEntry(k.toString(), v));
    }
    if (payload == null || payload.isEmpty) return;
    for (final cb in List.of(_tapListeners)) {
      try {
        cb(payload);
      } catch (e) {
        if (kDebugMode) debugPrint('Tap listener error: $e');
      }
    }
  }

  /// Ask iOS for notification permission (if not granted yet) and
  /// kick off APNs registration. Safe to call multiple times — the
  /// system prompt only fires the first time, and the backend's
  /// register route is idempotent.
  Future<void> ensureRegistered() async {
    if (!_supportsApns) return;
    // Guests can't post to /v1/device/register because the route
    // requires `requireAppUser`. Defer until the user signs in for
    // real — re-invoked from the home shell after auth state changes.
    final session = auth.session;
    if (session == null || session.userId == 'guest') return;
    wire();
    try {
      final granted =
          await _channel.invokeMethod<bool>('requestPermissionAndRegister') ??
              false;
      await _persistPermission(granted);
      if (!granted) {
        // Permission denial isn't an error per se, but we record it so
        // the diagnostic tile can explain "no pushes because user
        // declined" instead of looking broken.
        await _persistApnsError(
            'user_declined_notification_permission');
        if (kDebugMode) {
          debugPrint(
            'DeviceService: user declined notifications, '
            'skipping APNs registration.',
          );
        }
      } else {
        // Permission granted — clear any previously-recorded error so
        // the diagnostic tile flips green when the next token arrives.
        await _persistApnsError(null);
      }
      // The token comes back via the MethodChannel's onAPNsToken
      // callback above, not from this call.
    } on PlatformException catch (e) {
      await _persistApnsError(
          'permission_request_failed: ${e.code} ${e.message ?? ''}');
      if (kDebugMode) debugPrint('APNs permission request error: $e');
    }
  }

  Future<void> _onToken(String hex) async {
    if (hex == _lastToken) return; // de-dupe rapid re-fires
    _lastToken = hex;
    try {
      await api.post('/v1/device/register', {
        'apns_token': hex,
        'bundle_id': 'com.aegiadial.ios',
        'environment': kReleaseMode ? 'production' : 'sandbox',
      });
      // Success — record the token preview + timestamp and clear any
      // prior register-error so the Settings diagnostic flips green.
      await _persistRegistered(hex);
      if (kDebugMode) debugPrint('APNs token registered: ${hex.substring(0, 8)}…');
    } catch (e) {
      // Don't crash — push is a nice-to-have. The local UI keeps working
      // and we'll retry on the next cold start when ensureRegistered()
      // fires again. But DO persist the error so the diagnostic tile
      // can show "registered with backend: failed" instead of looking
      // healthy when it isn't.
      await _persistRegisterError(e.toString());
      if (kDebugMode) debugPrint('APNs token POST failed: $e');
      _lastToken = null; // allow retry
    }
  }

  // ── Diagnostic persistence ────────────────────────────────────────────

  /// Snapshot of push health for the Settings diagnostic tile. Reads
  /// directly from SharedPreferences so it reflects the latest persisted
  /// state even if the in-memory `_lastToken` was cleared by a retry.
  Future<PushDiagnostic> snapshot() async {
    final p = await SharedPreferences.getInstance();
    final permRaw = p.getBool(_kPermGranted);
    final tokenPreview = p.getString(_kTokenPreview);
    final regAtMs = p.getInt(_kRegisteredAtMs);
    return PushDiagnostic(
      permissionGranted: permRaw,
      lastTokenPreview: tokenPreview,
      lastRegisteredAt: regAtMs != null
          ? DateTime.fromMillisecondsSinceEpoch(regAtMs)
          : null,
      lastApnsError: p.getString(_kApnsError),
      lastRegisterError: p.getString(_kRegisterError),
    );
  }

  Future<void> _persistPermission(bool granted) async {
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kPermGranted, granted);
  }

  Future<void> _persistApnsError(String? err) async {
    final p = await SharedPreferences.getInstance();
    if (err == null) {
      await p.remove(_kApnsError);
    } else {
      await p.setString(_kApnsError, err);
    }
  }

  Future<void> _persistRegisterError(String err) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_kRegisterError, err);
  }

  Future<void> _persistRegistered(String fullToken) async {
    final p = await SharedPreferences.getInstance();
    final preview = fullToken.length >= 8
        ? '${fullToken.substring(0, 8)}…${fullToken.substring(fullToken.length - 4)}'
        : fullToken;
    await p.setString(_kTokenPreview, preview);
    await p.setInt(_kRegisteredAtMs, DateTime.now().millisecondsSinceEpoch);
    // Clear any prior register error now that we succeeded.
    await p.remove(_kRegisterError);
  }

  bool get _supportsApns {
    if (kIsWeb) return false;
    try {
      return Platform.isIOS;
    } catch (_) {
      return false;
    }
  }
}

final deviceService = DeviceService.instance;
