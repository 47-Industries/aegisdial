// Bank fraud-line lookup against `/v1/banks/search`. The verified-bank
// directory the backend exposes is the same `spoof_targets` catalog
// used by the call-verdict engine — only entries categorized as a
// financial institution (bank / credit_union / credit_card / brokerage
// / fintech / p2p_payments) are returned.
//
// The recovery chatbot uses this to surface the user's bank's REAL
// fraud-desk number the moment they say "I sent money via Chase" —
// instead of the canned "look at the back of your card" copy.

import 'api_service.dart';
import 'auth_service.dart';

class BankEntry {
  final String name;
  final String category; // 'bank' | 'credit_union' | 'credit_card' | 'brokerage' | 'fintech' | 'p2p_payments'
  final List<String> fraudPhones;
  final String? notes;

  const BankEntry({
    required this.name,
    required this.category,
    required this.fraudPhones,
    this.notes,
  });

  factory BankEntry.fromBackend(Map<String, dynamic> j) => BankEntry(
        name: (j['name'] as String?) ?? '',
        category: (j['category'] as String?) ?? 'bank',
        fraudPhones: (j['fraud_phones'] as List<dynamic>?)
                ?.map((e) => e.toString())
                .toList() ??
            const [],
        notes: j['notes'] as String?,
      );

  /// Single human-readable category label for badges in the UI.
  String get categoryLabel => switch (category) {
        'credit_union' => 'Credit Union',
        'credit_card' => 'Credit Card',
        'brokerage' => 'Brokerage',
        'fintech' => 'Fintech',
        'p2p_payments' => 'P2P',
        _ => 'Bank',
      };
}

class BankLookupService {
  BankLookupService._();
  static final BankLookupService instance = BankLookupService._();

  /// GET /v1/banks/search?q=
  /// Auth-only (no Pro gate) — the bank directory is a universal
  /// crisis resource we always want available. Returns null when not
  /// signed in or on a transient backend error so the sheet can show
  /// "sign in" copy instead of an empty list.
  Future<List<BankEntry>?> search(String q) async {
    final session = auth.session;
    if (session == null || session.userId == 'guest') return null;
    final trimmed = q.trim();
    if (trimmed.length < 2) return const [];
    try {
      final res = await api.get(
        '/v1/banks/search?q=${Uri.encodeQueryComponent(trimmed)}',
      );
      final rows = (res['banks'] as List?) ?? [];
      return rows
          .map((r) => BankEntry.fromBackend(r as Map<String, dynamic>))
          .toList();
    } on ApiException {
      return null;
    } catch (_) {
      return null;
    }
  }
}

final bankLookupService = BankLookupService.instance;
