import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../theme/app_theme.dart';
import '../services/bank_lookup_service.dart';

/// Modal bottom sheet for finding the user's bank's verified fraud line.
/// Surfaced from the Recovery chatbot's app bar so a panicking user
/// can jump straight from "I just got scammed" → "Here's Chase's real
/// fraud number" → tap-to-call, without having to leave the app.
///
/// Results come from `/v1/banks/search` (auth-only). Tap-to-call uses
/// the `tel:` URI scheme via `url_launcher`; iOS surfaces its native
/// "Call {number}?" confirmation, so we don't need a second app-side
/// confirm. Long-press a number to copy it to clipboard instead — for
/// the case where the user is mid-call and wants to read it off.
Future<void> showBankLookupSheet(BuildContext context) async {
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AegisColors.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (_) => const _BankLookupSheetBody(),
  );
}

class _BankLookupSheetBody extends StatefulWidget {
  const _BankLookupSheetBody();

  @override
  State<_BankLookupSheetBody> createState() => _BankLookupSheetBodyState();
}

class _BankLookupSheetBodyState extends State<_BankLookupSheetBody> {
  // Recently-used banks. Persisted so a user who calls their bank's
  // fraud line today finds it as a one-tap chip next time — recovery
  // is rarely a single sitting, and re-typing "Bank of America" mid-
  // crisis is friction we can cut.
  static const _kRecentsKey = 'bank_lookup_recents_v1';
  static const _kMaxRecents = 5;

  final _ctrl = TextEditingController();
  Timer? _debounce;
  bool _loading = false;
  bool _signedOut = false;
  List<BankEntry> _results = const [];
  List<String> _recents = const [];

  @override
  void initState() {
    super.initState();
    _loadRecents();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _loadRecents() async {
    final p = await SharedPreferences.getInstance();
    final list = p.getStringList(_kRecentsKey) ?? const [];
    if (!mounted) return;
    setState(() => _recents = list);
  }

  /// Record a bank the user actually called or copied a number for.
  /// Most-recent-first, de-duplicated, capped at _kMaxRecents.
  Future<void> _recordRecent(String bankName) async {
    final next = [
      bankName,
      ..._recents.where((r) => r.toLowerCase() != bankName.toLowerCase()),
    ].take(_kMaxRecents).toList();
    setState(() => _recents = next);
    final p = await SharedPreferences.getInstance();
    await p.setStringList(_kRecentsKey, next);
  }

  /// Tapping a recent chip re-runs the search for that bank name.
  void _searchRecent(String bankName) {
    _ctrl.text = bankName;
    _debounce?.cancel();
    _search(bankName);
  }

  /// 250ms debounce — fast enough that the list feels live, slow
  /// enough that holding down a key doesn't fire 8 requests.
  void _onChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 250), () => _search(q));
  }

  Future<void> _search(String q) async {
    final trimmed = q.trim();
    if (trimmed.length < 2) {
      setState(() {
        _results = const [];
        _loading = false;
        _signedOut = false;
      });
      return;
    }
    setState(() => _loading = true);
    final results = await bankLookupService.search(trimmed);
    if (!mounted) return;
    setState(() {
      _loading = false;
      _signedOut = results == null;
      _results = results ?? const [];
    });
  }

  Future<void> _call(String rawNumber) async {
    // Strip everything except digits + leading + for the tel: URI.
    final digits = rawNumber.replaceAll(RegExp(r'[^\d+]'), '');
    final uri = Uri.parse('tel:$digits');
    if (!await canLaunchUrl(uri)) {
      if (!mounted) return;
      // Fall back to clipboard so the user can paste it into their
      // phone app. iPads + jailbreak setups sometimes block tel:.
      await Clipboard.setData(ClipboardData(text: rawNumber));
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Number copied: $rawNumber')),
      );
      return;
    }
    await launchUrl(uri);
  }

  Future<void> _copy(String number) async {
    await Clipboard.setData(ClipboardData(text: number));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Copied $number')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final viewInsets = MediaQuery.of(context).viewInsets.bottom;
    final mh = MediaQuery.of(context).size.height;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: mh * 0.85),
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + viewInsets),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: AegisColors.turquoise.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Icon(Icons.phone_in_talk_rounded,
                      color: AegisColors.turquoise, size: 18),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    'Find your bank\'s fraud line',
                    style: tt.titleLarge
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              'Verified numbers from each bank\'s official fraud desk. Tap to dial — your iPhone confirms before placing the call.',
              style: tt.bodySmall
                  ?.copyWith(color: AegisColors.textSecondary, height: 1.45),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: _ctrl,
              autofocus: true,
              onChanged: _onChanged,
              decoration: InputDecoration(
                labelText: 'Bank, card, or app name',
                hintText: 'Chase, Bank of America, Cash App…',
                prefixIcon: const Icon(Icons.search_rounded),
                border: const OutlineInputBorder(),
                suffixIcon: _ctrl.text.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.close_rounded, size: 18),
                        onPressed: () {
                          _ctrl.clear();
                          _onChanged('');
                        },
                      ),
              ),
            ),
            const SizedBox(height: 14),
            Flexible(
              child: _loading
                  ? const Padding(
                      padding: EdgeInsets.symmetric(vertical: 32),
                      child: Center(
                        child: CircularProgressIndicator(
                            color: AegisColors.turquoise),
                      ),
                    )
                  : _signedOut
                      ? _Hint(
                          icon: Icons.lock_outline_rounded,
                          text:
                              'Sign in to search the verified bank directory.',
                        )
                      : _results.isEmpty
                          ? (_ctrl.text.trim().length < 2 &&
                                  _recents.isNotEmpty)
                              ? _RecentStrip(
                                  recents: _recents,
                                  onTap: _searchRecent,
                                )
                              : _Hint(
                                  icon: _ctrl.text.trim().length < 2
                                      ? Icons.keyboard_alt_outlined
                                      : Icons.travel_explore_rounded,
                                  text: _ctrl.text.trim().length < 2
                                      ? 'Type at least 2 letters to search.'
                                      : 'No matches. Try a shorter name or the parent brand.',
                                )
                          : ListView.separated(
                              shrinkWrap: true,
                              itemCount: _results.length,
                              separatorBuilder: (_, _) =>
                                  const SizedBox(height: 10),
                              itemBuilder: (_, i) => _BankTile(
                                entry: _results[i],
                                onCall: _call,
                                onCopy: _copy,
                                onUsed: () =>
                                    _recordRecent(_results[i].name),
                              ),
                            ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BankTile extends StatelessWidget {
  final BankEntry entry;
  final Future<void> Function(String) onCall;
  final Future<void> Function(String) onCopy;
  final VoidCallback onUsed; // fired on call OR copy → parent records a recent

  const _BankTile({
    required this.entry,
    required this.onCall,
    required this.onCopy,
    required this.onUsed,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final hasPhones = entry.fraudPhones.isNotEmpty;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AegisColors.surfaceElevated,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  entry.name,
                  style: tt.bodyLarge?.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(
                    horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: AegisColors.turquoise.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(
                    color: AegisColors.turquoise.withValues(alpha: 0.3),
                    width: 0.6,
                  ),
                ),
                child: Text(
                  entry.categoryLabel,
                  style: tt.labelSmall?.copyWith(
                    color: AegisColors.turquoise,
                    fontSize: 10,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          if (!hasPhones)
            Text(
              'No verified fraud number on file. Call the number on the back of your card.',
              style: tt.bodySmall?.copyWith(color: AegisColors.textTertiary),
            )
          else
            ...entry.fraudPhones.map((p) => Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Row(
                    children: [
                      Expanded(
                        child: ElevatedButton.icon(
                          onPressed: () {
                            onUsed();
                            onCall(p);
                          },
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AegisColors.turquoise,
                            foregroundColor: Colors.black,
                            minimumSize: const Size.fromHeight(40),
                            padding:
                                const EdgeInsets.symmetric(horizontal: 14),
                            alignment: Alignment.centerLeft,
                          ),
                          icon: const Icon(Icons.phone_rounded, size: 16),
                          label: Text(
                            p,
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 6),
                      IconButton(
                        tooltip: 'Copy number',
                        onPressed: () {
                          onUsed();
                          onCopy(p);
                        },
                        icon: const Icon(Icons.copy_rounded, size: 18),
                        color: AegisColors.textSecondary,
                      ),
                    ],
                  ),
                )),
        ],
      ),
    );
  }
}

/// Shown in the empty-query state when the user has called/copied a
/// bank before. One tap re-runs the search for that bank — turns a
/// repeat lookup into a single tap.
class _RecentStrip extends StatelessWidget {
  final List<String> recents;
  final ValueChanged<String> onTap;
  const _RecentStrip({required this.recents, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'RECENT',
          style: tt.labelSmall?.copyWith(
            color: AegisColors.textTertiary,
            letterSpacing: 1.6,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: recents
              .map((name) => Material(
                    color: AegisColors.surfaceElevated,
                    borderRadius: BorderRadius.circular(20),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(20),
                      onTap: () => onTap(name),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 14, vertical: 9),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(
                              color: AegisColors.border, width: 0.6),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.history_rounded,
                                size: 14,
                                color: AegisColors.textTertiary),
                            const SizedBox(width: 6),
                            Text(
                              name,
                              style: const TextStyle(
                                color: AegisColors.textPrimary,
                                fontSize: 13,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ))
              .toList(),
        ),
        const SizedBox(height: 14),
        Text(
          'Or type a bank, card, or app name above.',
          style: tt.bodySmall?.copyWith(color: AegisColors.textTertiary),
        ),
      ],
    );
  }
}

class _Hint extends StatelessWidget {
  final IconData icon;
  final String text;
  const _Hint({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 22, horizontal: 16),
        child: Column(
          children: [
            Icon(icon, color: AegisColors.textTertiary, size: 28),
            const SizedBox(height: 10),
            Text(
              text,
              style: tt.bodySmall?.copyWith(
                color: AegisColors.textSecondary,
                height: 1.5,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
