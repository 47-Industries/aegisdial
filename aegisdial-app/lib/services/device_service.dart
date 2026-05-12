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
import 'api_service.dart';
import 'auth_service.dart';

class DeviceService {
  DeviceService._();
  static final DeviceService instance = DeviceService._();

  static const _channel = MethodChannel('aegisdial/push');

  bool _wired = false;
  String? _lastToken;

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
          if (kDebugMode) {
            debugPrint('APNs registration failed: ${call.arguments}');
          }
          return null;
        default:
          return null;
      }
    });
    _wired = true;
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
      if (!granted && kDebugMode) {
        debugPrint(
          'DeviceService: user declined notifications, '
          'skipping APNs registration.',
        );
      }
      // The token comes back via the MethodChannel's onAPNsToken
      // callback above, not from this call.
    } on PlatformException catch (e) {
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
      if (kDebugMode) debugPrint('APNs token registered: ${hex.substring(0, 8)}…');
    } catch (e) {
      // Don't crash — push is a nice-to-have. The local UI keeps working
      // and we'll retry on the next cold start when ensureRegistered()
      // fires again.
      if (kDebugMode) debugPrint('APNs token POST failed: $e');
      _lastToken = null; // allow retry
    }
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
