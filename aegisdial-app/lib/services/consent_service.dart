// Live Shield consent versioning.
//
// v1 — "audio never leaves the phone" (regex-only protection). This was
//      the launch promise.
// v2 — "audio never leaves the phone; text leaves only when a call is
//      already detected as suspicious." Unlocks Claude-powered coaching
//      lines and hybrid risk scoring above threshold.
//
// The backend (src/lib/liveShieldLlm.ts) refuses to fire Claude on a
// session opened with consent_version=1, so this is a real on-the-wire
// gate, not just UI copy. The flag is per-device, persisted via
// SharedPreferences. Resetting the app clears it.

import 'package:shared_preferences/shared_preferences.dart';

class ConsentService {
  ConsentService._();
  static final ConsentService instance = ConsentService._();

  static const _kV2Key = 'live_shield_consent_v2_accepted';

  Future<bool> hasAcceptedV2() async {
    final p = await SharedPreferences.getInstance();
    return p.getBool(_kV2Key) ?? false;
  }

  Future<void> markV2Accepted() async {
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kV2Key, true);
  }

  /// Returns the consent_version to send to /v1/live-shield/start.
  /// Until the user has explicitly accepted the v2 disclosure, the
  /// client claims v1 — the safer (regex-only) backend path.
  Future<int> activeConsentVersion() async {
    return (await hasAcceptedV2()) ? 2 : 1;
  }

  /// Wipe per-user consent. Called from `auth.signOut()` so the next
  /// user on this device isn't presumed to have accepted v2 LLM
  /// coaching — consent is per-person, not per-device.
  Future<void> clearForSignOut() async {
    final p = await SharedPreferences.getInstance();
    await p.remove(_kV2Key);
  }
}

final consentService = ConsentService.instance;
