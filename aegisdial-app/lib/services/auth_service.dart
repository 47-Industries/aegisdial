import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sign_in_with_apple/sign_in_with_apple.dart';
import 'api_service.dart';
import 'consent_service.dart';
import 'device_service.dart';
import 'trial_service.dart';

class AuthSession {
  final String token;
  final String userId;
  final String tier;
  final String? displayName;
  final String? email;
  const AuthSession({
    required this.token,
    required this.userId,
    required this.tier,
    this.displayName,
    this.email,
  });

  Map<String, dynamic> toJson() => {
        'token': token,
        'user_id': userId,
        'tier': tier,
        if (displayName != null) 'display_name': displayName,
        if (email != null) 'email': email,
      };
  factory AuthSession.fromJson(Map<String, dynamic> j) => AuthSession(
        token: j['token'] as String,
        userId: j['user_id'] as String,
        tier: (j['tier'] as String?) ?? 'free',
        displayName: j['display_name'] as String?,
        email: j['email'] as String?,
      );
}

/// Apple credential cached between the dob-required 400 and the retry.
class AppleSignInPayload {
  final String idToken;
  final String? displayName;
  const AppleSignInPayload({required this.idToken, this.displayName});
}

class AuthService extends ChangeNotifier {
  AuthService._();
  static final AuthService instance = AuthService._();

  static const _kToken = 'auth_token';
  static const _kUserId = 'auth_user_id';
  static const _kTier = 'auth_tier';
  static const _kDisplayName = 'auth_display_name';
  static const _kEmail = 'auth_email';
  static const _kOnboarded = 'onboarded_v1';

  AuthSession? _session;
  bool _onboarded = false;
  bool _booted = false;

  AuthSession? get session => _session;
  bool get isSignedIn => _session != null;
  bool get hasOnboarded => _onboarded;
  bool get isBooted => _booted;

  Future<void> boot() async {
    final p = await SharedPreferences.getInstance();
    final token = p.getString(_kToken);
    final userId = p.getString(_kUserId);
    if (token != null && userId != null) {
      _session = AuthSession(
        token: token,
        userId: userId,
        tier: p.getString(_kTier) ?? 'free',
        displayName: p.getString(_kDisplayName),
        email: p.getString(_kEmail),
      );
      api.setToken(token);
      // Refresh display name + tier from server in background.
      _refreshMe();
    }
    _onboarded = p.getBool(_kOnboarded) ?? false;
    _booted = true;
    notifyListeners();
  }

  Future<void> markOnboarded() async {
    _onboarded = true;
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kOnboarded, true);
    notifyListeners();
  }

  /// Bundled Apple credential payload — cached between the first
  /// `signInWithApple()` attempt (which may 400 with `dob_year_required`)
  /// and the retry after the user fills in the age-gate sheet. Reusing
  /// the same identity token avoids prompting Face ID twice in the
  /// new-user flow.
  AppleSignInPayload? _pendingApplePayload;

  /// Pop the Apple modal, parse the credential, and POST to the
  /// backend. On a brand-new user the backend returns 400
  /// dob_year_required — the caller should catch that, show the
  /// age-gate sheet, and call signInWithApple again with `dobYear` set.
  /// The cached Apple credential is reused so Face ID doesn't fire
  /// twice.
  Future<AuthSession> signInWithApple({int? dobYear}) async {
    var payload = _pendingApplePayload;
    if (payload == null) {
      final cred = await SignInWithApple.getAppleIDCredential(
        scopes: const [
          AppleIDAuthorizationScopes.email,
          AppleIDAuthorizationScopes.fullName,
        ],
      );
      final idToken = cred.identityToken;
      if (idToken == null) {
        throw ApiException(0, 'Apple did not return an identity token.');
      }
      final fullName = [
        cred.givenName,
        cred.familyName,
      ].where((s) => s != null && s.isNotEmpty).join(' ').trim();
      payload = AppleSignInPayload(
        idToken: idToken,
        displayName: fullName.isEmpty ? null : fullName,
      );
      _pendingApplePayload = payload;
    }

    final body = <String, dynamic>{
      'id_token': payload.idToken,
      if (payload.displayName != null) 'display_name': payload.displayName,
      'dob_year': ?dobYear,
    };

    try {
      final res = await api.post('/auth/apple', body);
      final session = AuthSession.fromJson(res);
      await _persist(session);
      _refreshMe();
      // Clear the cached credential on a successful sign-in. We only
      // keep it between a missing-DOB attempt and the retry; any other
      // failure should force a fresh Apple modal next time.
      _pendingApplePayload = null;
      return session;
    } on ApiException catch (e) {
      // Keep the cached payload only for the specific "missing DOB"
      // case the caller can recover from. All other errors mean the
      // ID token is likely stale and the next attempt should re-prompt.
      if (e.code != 'dob_year_required') {
        _pendingApplePayload = null;
      }
      rethrow;
    }
  }

  Future<AuthSession> signInWithEmail({
    required String email,
    required String password,
  }) async {
    final res = await api.post('/auth/email/login', {
      'email': email,
      'password': password,
    });
    final session = AuthSession.fromJson({...res, 'email': email});
    await _persist(session);
    _refreshMe();
    return session;
  }

  Future<AuthSession> signUpWithEmail({
    required String email,
    required String password,
    required int dobYear,
    String? displayName,
  }) async {
    final res = await api.post('/auth/email/signup', {
      'email': email,
      'password': password,
      'dob_year': dobYear,
      'display_name': ?displayName,
    });
    // Sign-up response includes display_name directly
    final session = AuthSession.fromJson({
      ...res,
      'display_name': ?displayName,
      'email': email,
    });
    await _persist(session);
    _refreshMe();
    return session;
  }

  /// Local-only "guest" session. Useful for visual demos / TestFlight reviewers.
  /// Real device-bound anonymous auth lands later via App Attest backend flow.
  Future<void> continueAsGuest() async {
    _session = const AuthSession(
      token: 'guest',
      userId: 'guest',
      tier: 'guest',
    );
    notifyListeners();
  }

  Future<void> signOut() async {
    final p = await SharedPreferences.getInstance();
    // 1. Auth credentials.
    await p.remove(_kToken);
    await p.remove(_kUserId);
    await p.remove(_kTier);
    await p.remove(_kDisplayName);
    await p.remove(_kEmail);
    // 2. Per-user state owned by other services. Each service exposes
    //    its own clearForSignOut() so the responsibility for which
    //    keys it owns stays in the service module.
    await consentService.clearForSignOut();
    await deviceService.clearForSignOut();
    // 3. Per-user state persisted by screens (recovery chat, breach
    //    monitors, SMS scan history, shield-on toggle). These are PII
    //    or preference data that MUST NOT leak to the next user on a
    //    shared device. Listed inline rather than service-owned because
    //    the screens persist directly to SharedPreferences (known smell;
    //    refactor candidate, but correctness comes first).
    await p.remove('recovery_chat_history_v1'); // recovery_chatbot_screen
    await p.remove('breach_identifiers_v1');    // breach_screen
    await p.remove('breach_exposures_v1');      // breach_screen
    await p.remove('sms_scan_history_v1');      // coverage_screen
    await p.remove('shield_on_v1');             // home_dashboard
    _session = null;
    api.setToken(null);
    // Drop the server-anchored trial start so the next user on this
    // device falls back to local (or their own server anchor on sign-in).
    TrialService.setServerStart(null);
    notifyListeners();
  }

  /// PATCH the user's profile on the backend (display_name today, more
  /// fields later). Optimistic local update is paired with the PATCH so
  /// the UI feels instant; if the request fails the session is left
  /// untouched and the caller surfaces the error.
  ///
  /// Guests get a local-only rename — no backend account to PATCH.
  Future<void> updateProfile({String? displayName}) async {
    final s = _session;
    if (s == null) return;
    if (displayName != null) {
      final trimmed = displayName.trim();
      if (s.userId == 'guest') {
        _session = AuthSession(
          token: s.token,
          userId: s.userId,
          tier: s.tier,
          displayName: trimmed.isEmpty ? null : trimmed,
          email: s.email,
        );
        notifyListeners();
        return;
      }
      await api.patch('/v1/users/me', {'display_name': trimmed});
      // Persist locally so cold-start sees the new name before /auth/me
      // catches up.
      final updated = AuthSession(
        token: s.token,
        userId: s.userId,
        tier: s.tier,
        displayName: trimmed.isEmpty ? null : trimmed,
        email: s.email,
      );
      await _persist(updated);
    }
  }

  /// Server-side cascade-delete of the user's account and all related rows
  /// (subscriptions, family plans, recovery sessions, breach watches, chat
  /// history, etc. — `users` table is ON DELETE CASCADE for every child).
  /// The backend requires `{"confirm": "DELETE"}` as a guard against
  /// accidental hits. Throws ApiException on failure so the caller can
  /// keep the user signed in and surface the error instead of silently
  /// signing them out with their account still alive.
  ///
  /// Guest sessions short-circuit to local-only signOut() — there's no
  /// backend row to remove.
  Future<void> deleteAccount() async {
    final s = _session;
    if (s == null || s.userId == 'guest') {
      await signOut();
      return;
    }
    await api.delete('/v1/users/me', {'confirm': 'DELETE'});
    await signOut();
  }

  Future<void> _persist(AuthSession s) async {
    _session = s;
    api.setToken(s.token);
    final p = await SharedPreferences.getInstance();
    await p.setString(_kToken, s.token);
    await p.setString(_kUserId, s.userId);
    await p.setString(_kTier, s.tier);
    if (s.displayName != null) await p.setString(_kDisplayName, s.displayName!);
    if (s.email != null) await p.setString(_kEmail, s.email!);
    notifyListeners();
  }

  Future<void> _refreshMe() async {
    try {
      final res = await api.get('/auth/me');
      final displayName = res['display_name'] as String?;
      final tier = (res['tier'] as String?) ?? _session?.tier ?? 'free';
      if (_session == null) return;
      final updated = AuthSession(
        token: _session!.token,
        userId: _session!.userId,
        tier: tier,
        displayName: displayName,
        email: (res['email'] as String?) ?? _session!.email,
      );
      await _persist(updated);
      // Anchor the trial start to `users.created_at` — reinstall-immune.
      // ISO 8601 string when JSON-encoded by the server.
      final createdAt = res['created_at'] as String?;
      if (createdAt != null) {
        final parsed = DateTime.tryParse(createdAt);
        if (parsed != null) {
          TrialService.setServerStart(parsed.millisecondsSinceEpoch);
        }
      }
    } catch (_) {
      // Non-fatal — stale data is fine
    }
  }
}

final auth = AuthService.instance;
