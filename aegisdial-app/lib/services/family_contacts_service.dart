// Family-contacts sync to `/v1/family-contacts` on the backend.
//
// Backend cap: 50 contacts/user, Pro-only. Returns 403 for non-Pro
// users so this service is wrapped behind an "isPro" gate on every
// call. Guests + free-trial users keep using the local-only shared
// pref store, and we transparently push their contacts up to the
// backend the first time they hit Pro.
//
// Shape mirrors what the backend's publicShape() returns — encrypted
// columns are decrypted server-side before serialization, and the
// `safe_word_hash` is never sent to the client (we only get a
// `has_safe_word` bool indicating presence).

import 'api_service.dart';
import 'auth_service.dart';

class FamilyContact {
  final String? backendId; // null when local-only (guest / non-Pro / offline)
  final String displayName;
  final String relationship;
  final String phone; // E.164 once round-tripped through backend
  final bool isGuardian;
  final bool hasSafeWord;
  final bool consentAccepted; // local flag mirroring acceptance UX

  const FamilyContact({
    this.backendId,
    required this.displayName,
    required this.relationship,
    required this.phone,
    this.isGuardian = false,
    this.hasSafeWord = false,
    this.consentAccepted = false,
  });

  FamilyContact copyWith({
    String? backendId,
    String? displayName,
    String? relationship,
    String? phone,
    bool? isGuardian,
    bool? hasSafeWord,
    bool? consentAccepted,
  }) =>
      FamilyContact(
        backendId: backendId ?? this.backendId,
        displayName: displayName ?? this.displayName,
        relationship: relationship ?? this.relationship,
        phone: phone ?? this.phone,
        isGuardian: isGuardian ?? this.isGuardian,
        hasSafeWord: hasSafeWord ?? this.hasSafeWord,
        consentAccepted: consentAccepted ?? this.consentAccepted,
      );

  Map<String, dynamic> toJson() => {
        if (backendId != null) 'id': backendId,
        'n': displayName,
        'r': relationship,
        'p': phone,
        'g': isGuardian,
        'sw': hasSafeWord,
        'ca': consentAccepted,
      };

  factory FamilyContact.fromJson(Map<String, dynamic> j) => FamilyContact(
        backendId: j['id'] as String?,
        displayName: (j['n'] as String?) ?? '',
        relationship: (j['r'] as String?) ?? '',
        phone: (j['p'] as String?) ?? '',
        isGuardian: (j['g'] as bool?) ?? false,
        hasSafeWord: (j['sw'] as bool?) ?? false,
        consentAccepted: (j['ca'] as bool?) ?? false,
      );

  /// Decode a row from `/v1/family-contacts` (the backend's publicShape).
  factory FamilyContact.fromBackend(Map<String, dynamic> j) => FamilyContact(
        backendId: j['id'] as String?,
        displayName: (j['display_name'] as String?) ?? '',
        relationship: (j['relationship'] as String?) ?? '',
        phone: (j['phone'] as String?) ?? (j['phone_e164'] as String?) ?? '',
        isGuardian: (j['is_guardian'] as bool?) ?? false,
        hasSafeWord: (j['has_safe_word'] as bool?) ?? false,
        // The backend doesn't track "user has acknowledged this contact"
        // — that's a local UX flag. Default to true on server-fetched
        // rows since persisting through the backend implies the user
        // already accepted the contact at create time.
        consentAccepted: true,
      );
}

class FamilyContactsService {
  FamilyContactsService._();
  static final FamilyContactsService instance = FamilyContactsService._();

  /// True only when the user has a real backend account AND a Pro tier.
  /// Guests, free-trial, and expired users still see a working Family
  /// screen — it just lives in shared prefs until they pay.
  bool get _canSync {
    final s = auth.session;
    if (s == null || s.userId == 'guest') return false;
    return s.tier == 'pro' || s.tier == 'in_grace';
  }

  bool get canSync => _canSync;

  /// GET /v1/family-contacts → list. Returns null when sync is not
  /// available (caller falls back to local).
  Future<List<FamilyContact>?> list() async {
    if (!_canSync) return null;
    try {
      final res = await api.get('/v1/family-contacts');
      final rows = (res['contacts'] as List?) ?? [];
      return rows
          .map((r) => FamilyContact.fromBackend(r as Map<String, dynamic>))
          .toList();
    } on ApiException {
      // 401 / 403 / 5xx — surface as null so caller uses local. We
      // don't want a transient backend dip to wipe the user's family
      // list from the UI.
      return null;
    } catch (_) {
      return null;
    }
  }

  /// POST /v1/family-contacts. Returns the persisted contact with its
  /// backend id on success, null on failure. Caller stores locally
  /// regardless so the UI stays responsive when the network is flaky.
  Future<FamilyContact?> create({
    required String displayName,
    required String relationship,
    required String phone,
    bool isGuardian = false,
  }) async {
    if (!_canSync) return null;
    try {
      final res = await api.post('/v1/family-contacts', {
        'display_name': displayName,
        'relationship': relationship,
        'phone': phone,
        if (isGuardian) 'is_guardian': true,
      });
      final raw = res['contact'] as Map<String, dynamic>?;
      if (raw == null) return null;
      return FamilyContact.fromBackend(raw);
    } on ApiException {
      return null;
    } catch (_) {
      return null;
    }
  }

  /// DELETE /v1/family-contacts/:id. Best-effort — returns true on
  /// success or 404 (already gone), false on transient failure so the
  /// caller can keep the local row pending a retry.
  Future<bool> delete(String backendId) async {
    if (!_canSync) return true; // nothing server-side to remove
    try {
      await api.delete('/v1/family-contacts/$backendId');
      return true;
    } on ApiException catch (e) {
      if (e.statusCode == 404) return true; // already gone
      return false;
    } catch (_) {
      return false;
    }
  }
}

final familyContactsService = FamilyContactsService.instance;
