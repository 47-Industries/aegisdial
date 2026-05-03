import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sign_in_with_apple/sign_in_with_apple.dart';
import 'api_service.dart';

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

  Future<AuthSession> signInWithApple({int? dobYear}) async {
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

    final body = <String, dynamic>{
      'id_token': idToken,
      if (fullName.isNotEmpty) 'display_name': fullName,
      'dob_year': ?dobYear,
    };

    final res = await api.post('/auth/apple', body);
    final session = AuthSession.fromJson(res);
    await _persist(session);
    _refreshMe();
    return session;
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
    await p.remove(_kToken);
    await p.remove(_kUserId);
    await p.remove(_kTier);
    await p.remove(_kDisplayName);
    await p.remove(_kEmail);
    _session = null;
    api.setToken(null);
    notifyListeners();
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
    } catch (_) {
      // Non-fatal — stale data is fine
    }
  }
}

final auth = AuthService.instance;
