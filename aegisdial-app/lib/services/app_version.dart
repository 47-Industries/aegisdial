// Loads the app version from package_info_plus once at boot and caches
// it in memory so any UI surface can read it synchronously without a
// FutureBuilder.
//
// Why a service: the About tile in Settings + the diagnostic in Push
// Diagnostic both need version + build number. Keeping them in sync
// with pubspec via hand-edited string literals broke twice in the
// last day of bumps. Now: bump pubspec, ship — UI follows automatically.

import 'package:package_info_plus/package_info_plus.dart';

class AppVersion {
  AppVersion._({
    required this.version,
    required this.buildNumber,
    required this.packageName,
  });

  /// e.g. "1.0.0"
  final String version;
  /// e.g. "18"
  final String buildNumber;
  /// e.g. "com.aegiadial.ios"
  final String packageName;

  /// "v1.0.0 (18)" — the canonical short display string used in
  /// Settings → About and the push diagnostic.
  String get short => 'v$version ($buildNumber)';

  /// Cached snapshot — populated by `load()` on app boot. Reads return
  /// the placeholder until load completes, then real values forever.
  static AppVersion current = AppVersion._(
    version: '1.0.0',
    buildNumber: '?',
    packageName: 'com.aegiadial.ios',
  );

  /// Fetch from the platform once and cache. Idempotent — safe to call
  /// multiple times (e.g. on hot-reload). Failures (e.g. running in a
  /// test harness without the platform plugin) leave the placeholder
  /// in place so the UI still renders.
  static Future<void> load() async {
    try {
      final info = await PackageInfo.fromPlatform();
      current = AppVersion._(
        version: info.version,
        buildNumber: info.buildNumber,
        packageName: info.packageName,
      );
    } catch (_) {
      // Keep the placeholder. About tile will show 'v1.0.0 (?)' which
      // is honest (we don't know) and obviously-wrong-looking enough
      // that someone notices and reports it.
    }
  }
}
