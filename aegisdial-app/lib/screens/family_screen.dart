import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:speech_to_text/speech_to_text.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';

class _FamilyMember {
  final String name;
  final String relation;
  final String phone;
  bool consentAccepted;
  bool showActivity;

  _FamilyMember(
    this.name,
    this.relation, {
    this.phone = '',
    this.consentAccepted = false,
    this.showActivity = true,
  });

  Map<String, dynamic> toJson() => {
        'n': name,
        'r': relation,
        'p': phone,
        'ca': consentAccepted,
        'sa': showActivity,
      };

  factory _FamilyMember.fromJson(Map<String, dynamic> j) => _FamilyMember(
        j['n'] as String,
        j['r'] as String,
        phone: (j['p'] as String?) ?? '',
        consentAccepted: (j['ca'] as bool?) ?? false,
        showActivity: (j['sa'] as bool?) ?? true,
      );
}

class FamilyScreen extends StatefulWidget {
  const FamilyScreen({super.key});

  @override
  State<FamilyScreen> createState() => _FamilyScreenState();
}

class _FamilyScreenState extends State<FamilyScreen> {
  // Pro covers up to 3 lines. Family+ was deprecated 2026-05-12 — existing
  // subscribers are still resolved server-side, but the iOS UI no longer
  // offers the upsell (no replacement 5-line tier yet).
  static const int _baseLines = 3;
  static const String _baseTier = 'Pro · 3 lines';
  static const String _kMembersKey = 'family_members_v1';
  static const String _kSafeWordKey = 'family_safe_word_v1';

  final List<_FamilyMember> _members = [];
  String _safeWord = '';

  int get _capacity => _baseLines;

  @override
  void initState() {
    super.initState();
    _loadState();
  }

  Future<void> _loadState() async {
    final p = await SharedPreferences.getInstance();
    try {
      final membersRaw = p.getString(_kMembersKey);
      if (membersRaw != null) {
        final list = jsonDecode(membersRaw) as List<dynamic>;
        if (mounted) {
          setState(() {
            _members.addAll(list.map(
                (e) => _FamilyMember.fromJson(e as Map<String, dynamic>)));
          });
        }
      }
      final sw = p.getString(_kSafeWordKey);
      if (sw != null && sw.isNotEmpty && mounted) {
        setState(() => _safeWord = sw);
      }
    } catch (_) {}
  }

  Future<void> _saveState() async {
    final p = await SharedPreferences.getInstance();
    await p.setString(
        _kMembersKey, jsonEncode(_members.map((e) => e.toJson()).toList()));
    await p.setString(_kSafeWordKey, _safeWord);
  }

  Future<void> _showAddMemberSheet() async {
    if (_members.length >= _baseLines) {
      // Pro tier is capped at 3 lines. No upgrade path until a >3 tier ships.
      _showLineCapToast();
      return;
    }

    final added = await showModalBottomSheet<_FamilyMember>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AegisColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => const _AddMemberSheet(),
    );
    if (added != null) {
      setState(() => _members.add(added));
      _saveState();
    }
  }

  Future<void> _showSafeWordDialog() async {
    final result = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _SafeWordSetupSheet(current: _safeWord),
    );
    if (result != null && result.isNotEmpty) {
      setState(() => _safeWord = result);
      _saveState();
    }
  }

  void _showLineCapToast() {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text(
          "Pro covers 3 lines. Remove a line first to add a new one.",
        ),
        duration: Duration(seconds: 3),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final usedLines = _members.length;
    final tierLabel = _baseTier;
    final isAtCap = _members.length >= _baseLines;

    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(title: const Text('Family')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
        children: [
          GlassCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      tierLabel,
                      style: tt.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const Spacer(),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        vertical: 4,
                        horizontal: 10,
                      ),
                      decoration: BoxDecoration(
                        color: AegisColors.turquoise.withValues(alpha: 0.16),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        'ACTIVE',
                        style: tt.labelSmall?.copyWith(
                          color: AegisColors.turquoise,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 1.4,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  '$usedLines of $_capacity lines used',
                  style: tt.bodySmall?.copyWith(
                    color: AegisColors.textTertiary,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          Text(
            'PROTECTED LINES',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.6,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          if (_members.isEmpty)
            _EmptyMembers()
          else
            ..._members.map((m) => _MemberTile(
                  member: m,
                  onRemove: () {
                    setState(() => _members.remove(m));
                    _saveState();
                  },
                  onAccept: () {
                    setState(() => m.consentAccepted = true);
                    _saveState();
                  },
                  onToggleActivity: () {
                    setState(() => m.showActivity = !m.showActivity);
                    _saveState();
                  },
                )),
          if (!isAtCap) ...[
            const SizedBox(height: 8),
            _AddSlot(
              label: 'Add a family member',
              onTap: _showAddMemberSheet,
            ),
          ],
          const SizedBox(height: 28),
          Text(
            'GUARDIAN',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.6,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          GlassCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AegisColors.turquoise.withValues(alpha: 0.14),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.shield_outlined,
                        color: AegisColors.turquoise,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Family scam exposure',
                            style: tt.titleMedium?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'See how many scams each loved one is dealing with.',
                            style: tt.bodySmall?.copyWith(
                              color: AegisColors.textTertiary,
                              height: 1.35,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                if (_members.isEmpty)
                  _GuardianEmpty()
                else
                  ..._members.map((m) => _MemberExposureTile(member: m)),
              ],
            ),
          ),
          const SizedBox(height: 16),
          GlassCard(
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: AegisColors.turquoise.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(
                    Icons.key_outlined,
                    color: AegisColors.turquoise,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Family safe word',
                        style: tt.titleMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Defeat AI voice clones — set a private word only your family knows.',
                        style: tt.bodySmall?.copyWith(
                          color: AegisColors.textTertiary,
                          height: 1.35,
                        ),
                      ),
                      if (_safeWord.isNotEmpty) ...[
                        const SizedBox(height: 5),
                        Row(
                          children: [
                            const Icon(Icons.check_circle_outline,
                                size: 13, color: AegisColors.success),
                            const SizedBox(width: 4),
                            Text(
                              'Set · ${_safeWord[0]}${'•' * (_safeWord.length - 1)}',
                              style: tt.labelSmall?.copyWith(
                                color: AegisColors.success,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
                TextButton(
                  onPressed: () => _showSafeWordDialog(),
                  child: Text(_safeWord.isEmpty ? 'Set' : 'Change'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyMembers extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 22, horizontal: 16),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Row(
        children: [
          const Icon(
            Icons.group_outlined,
            color: AegisColors.textTertiary,
            size: 22,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'No family lines yet — Pro covers up to 3 lines.',
              style: tt.bodySmall?.copyWith(
                color: AegisColors.textSecondary,
                height: 1.45,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _GuardianEmpty extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 14),
      decoration: BoxDecoration(
        color: AegisColors.surfaceElevated,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        'Add a family member above to start tracking the scam calls and texts they\'re facing.',
        style: tt.bodySmall?.copyWith(
          color: AegisColors.textTertiary,
          height: 1.45,
        ),
      ),
    );
  }
}

class _MemberTile extends StatelessWidget {
  final _FamilyMember member;
  final VoidCallback? onRemove;
  final VoidCallback? onAccept;
  final VoidCallback? onToggleActivity;
  const _MemberTile({
    required this.member,
    this.onRemove,
    this.onAccept,
    this.onToggleActivity,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final initials = member.name.isNotEmpty
        ? member.name.characters.first.toUpperCase()
        : '?';
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: member.consentAccepted ? AegisColors.border : AegisColors.warning.withValues(alpha: 0.4),
          width: 0.6,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: AegisColors.heroGradient,
                ),
                alignment: Alignment.center,
                child: Text(
                  initials,
                  style: const TextStyle(
                    color: Colors.black,
                    fontWeight: FontWeight.w700,
                    fontSize: 16,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      member.name,
                      style: tt.bodyLarge?.copyWith(fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      member.relation + (member.phone.isNotEmpty ? ' · ${member.phone}' : ''),
                      style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary),
                    ),
                  ],
                ),
              ),
              if (member.consentAccepted)
                IconButton(
                  icon: Icon(
                    member.showActivity ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                    color: AegisColors.textTertiary,
                    size: 18,
                  ),
                  onPressed: onToggleActivity,
                  tooltip: member.showActivity ? 'Hide activity' : 'Show activity',
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(),
                ),
              const SizedBox(width: 8),
              IconButton(
                icon: const Icon(Icons.remove_circle_outline_rounded,
                    color: AegisColors.textTertiary, size: 20),
                onPressed: onRemove,
                tooltip: 'Remove',
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(),
              ),
            ],
          ),
          if (!member.consentAccepted) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: AegisColors.warning.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    'INVITE PENDING',
                    style: tt.labelSmall?.copyWith(
                      color: AegisColors.warning,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.2,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Waiting for ${member.name} to accept monitoring',
                    style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary),
                  ),
                ),
                TextButton(
                  onPressed: onAccept,
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: Text(
                    'Mark accepted',
                    style: tt.labelSmall?.copyWith(
                      color: AegisColors.turquoise,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _MemberExposureTile extends StatelessWidget {
  final _FamilyMember member;
  const _MemberExposureTile({required this.member});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 14),
      decoration: BoxDecoration(
        color: AegisColors.surfaceElevated,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  member.name,
                  style: tt.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 2),
                Text(
                  member.relation,
                  style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary),
                ),
              ],
            ),
          ),
          if (!member.consentAccepted)
            Row(children: [
              const Icon(Icons.hourglass_empty_rounded, size: 13, color: AegisColors.warning),
              const SizedBox(width: 5),
              Text('Invite pending',
                  style: tt.labelSmall?.copyWith(color: AegisColors.warning, fontWeight: FontWeight.w600)),
            ])
          else if (!member.showActivity)
            Row(children: [
              const Icon(Icons.visibility_off_outlined, size: 13, color: AegisColors.textTertiary),
              const SizedBox(width: 5),
              Text('Hidden',
                  style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary)),
            ])
          else
            Row(children: [
              Container(
                width: 6, height: 6,
                decoration: const BoxDecoration(shape: BoxShape.circle, color: AegisColors.success),
              ),
              const SizedBox(width: 6),
              Text('Protected',
                  style: tt.labelSmall?.copyWith(color: AegisColors.success, fontWeight: FontWeight.w600)),
            ]),
        ],
      ),
    );
  }
}


class _AddSlot extends StatelessWidget {
  final String label;
  final VoidCallback onTap;
  const _AddSlot({required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 14),
          decoration: BoxDecoration(
            color: AegisColors.surface.withValues(alpha: 0.4),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: AegisColors.turquoise.withValues(alpha: 0.4),
              width: 1,
            ),
          ),
          child: Row(
            children: [
              const Icon(Icons.add_rounded, color: AegisColors.turquoise),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(
                    color: AegisColors.textPrimary,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AddMemberSheet extends StatefulWidget {
  const _AddMemberSheet();

  @override
  State<_AddMemberSheet> createState() => _AddMemberSheetState();
}

class _AddMemberSheetState extends State<_AddMemberSheet> {
  final _name = TextEditingController();
  final _relation = TextEditingController();
  final _phone = TextEditingController();

  @override
  void dispose() {
    _name.dispose();
    _relation.dispose();
    _phone.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final viewInsets = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + viewInsets),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Add a family member',
            style: tt.titleLarge?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: _name,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(
              labelText: 'Name',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _relation,
            decoration: const InputDecoration(
              labelText: 'Relation (e.g. "Mom", "Son")',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(
              labelText: 'Phone number (optional)',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          ElevatedButton(
            onPressed: () {
              final name = _name.text.trim();
              if (name.isEmpty) return;
              Navigator.of(context).pop(_FamilyMember(
                name,
                _relation.text.trim().isEmpty ? 'Family' : _relation.text.trim(),
                phone: _phone.text.trim(),
              ));
            },
            child: const Text('Add'),
          ),
        ],
      ),
    );
  }
}

// ── Safe word validation ─────────────────────────────────────────────────────

const _kCommonNames = {
  'mom', 'dad', 'mama', 'papa', 'mum', 'sarah', 'emily', 'jessica', 'ashley',
  'hannah', 'emma', 'olivia', 'sophia', 'isabella', 'mia', 'charlotte',
  'james', 'john', 'robert', 'michael', 'william', 'david', 'richard',
  'joseph', 'thomas', 'charles', 'grandma', 'grandpa', 'nana', 'poppy',
  'sister', 'brother', 'aunt', 'uncle', 'baby', 'honey', 'dear', 'love',
};

const _kCommonWords = {
  'apple', 'house', 'hello', 'world', 'password', 'secret', 'family',
  'water', 'fire', 'earth', 'light', 'dark', 'night', 'day', 'sun', 'moon',
  'star', 'blue', 'green', 'red', 'black', 'white', 'happy', 'good',
  'great', 'love', 'life', 'time', 'door', 'home', 'room', 'tree', 'bird',
  'fish', 'book', 'phone', 'money', 'work', 'play', 'school', 'food',
  'dance', 'music', 'heart', 'peace', 'hope', 'faith', 'trust', 'gold',
  'silver', 'diamond', 'tiger', 'lion', 'eagle', 'wolf', 'bear', 'fox',
  'cat', 'dog', 'horse', 'flower', 'garden', 'cloud', 'rain', 'snow',
  'wind', 'storm', 'thunder', 'lightning', 'power', 'strong', 'brave',
  'smile', 'laugh', 'dream', 'wish', 'magic', 'super', 'hero', 'king',
  'queen', 'prince', 'angel', 'grace', 'glory', 'honor',
};

const _kSuggestions = [
  'hummingbird', 'marigold', 'crescent moon', 'saltwater', 'persimmon',
  'tangerine', 'archipelago', 'tumbleweed', 'cobblestone', 'cinnamon',
  'cardamom', 'stargazer', 'labyrinth', 'wanderlust', 'chrysanthemum',
  'saffron', 'driftwood', 'moonflower', 'thundersnow', 'copperhead',
];

String? _validateSafeWord(String word) {
  final w = word.trim().toLowerCase();
  if (w.isEmpty) return null;
  if (w.length < 4) return 'Too short — choose at least 4 characters.';
  // Digits only
  if (RegExp(r'^\d+$').hasMatch(w)) {
    return 'Numbers only are easy to guess — add some letters.';
  }
  // Birthday / year pattern: 4-digit year 1900-2099, or MM/DD, or MMDD
  if (RegExp(r'^(19|20)\d{2}$').hasMatch(w)) {
    return 'Years are in public records — pick something more personal.';
  }
  if (RegExp(r'^\d{4,8}$').hasMatch(w)) {
    return 'Digit strings are easy to guess — use a word instead.';
  }
  if (_kCommonNames.contains(w)) {
    return 'Family names are guessable from social media — try something else.';
  }
  if (_kCommonWords.contains(w)) {
    return 'Too common — scammers guess these first.';
  }
  return null; // valid
}

_WordStrength _wordStrength(String word) {
  final len = word.trim().length;
  if (len == 0) return _WordStrength.none;
  if (len < 4) return _WordStrength.weak;
  if (len <= 5) return _WordStrength.fair;
  return _WordStrength.strong;
}

enum _WordStrength { none, weak, fair, strong }

// ── Safe word setup bottom sheet ─────────────────────────────────────────────

class _SafeWordSetupSheet extends StatefulWidget {
  final String current;
  const _SafeWordSetupSheet({required this.current});

  @override
  State<_SafeWordSetupSheet> createState() => _SafeWordSetupSheetState();
}

class _SafeWordSetupSheetState extends State<_SafeWordSetupSheet> {
  int _step = 0; // 0 = choose, 1 = say it out loud
  final _ctrl = TextEditingController();
  String? _validationError;
  late List<String> _suggestions;

  // STT state
  final _stt = SpeechToText();
  bool _sttAvailable = false;
  bool _listening = false;
  String _heard = '';
  bool _voiceConfirmed = false;
  bool _attempted = false;

  @override
  void initState() {
    super.initState();
    _ctrl.text = widget.current;
    _ctrl.addListener(_onTyped);
    // Pick 4 random suggestions
    final pool = List<String>.from(_kSuggestions)..shuffle();
    _suggestions = pool.take(4).toList();
    _initStt();
  }

  Future<void> _initStt() async {
    final available = await _stt.initialize();
    if (mounted) setState(() => _sttAvailable = available);
  }

  void _onTyped() {
    final error = _validateSafeWord(_ctrl.text);
    setState(() => _validationError = error);
  }

  bool get _step1Valid {
    final w = _ctrl.text.trim();
    return w.length >= 4 && _validateSafeWord(w) == null;
  }

  void _applySuggestion(String s) {
    _ctrl.text = s;
    _ctrl.selection = TextSelection.collapsed(offset: s.length);
    _onTyped();
  }

  Future<void> _startListening() async {
    if (!_sttAvailable) {
      final available = await _stt.initialize();
      if (mounted) setState(() => _sttAvailable = available);
      if (!available) {
        if (mounted) {
          setState(() => _attempted = true);
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Microphone access required — enable in Settings > AegisDial.'),
              duration: Duration(seconds: 4),
            ),
          );
        }
        return;
      }
    }
    setState(() {
      _listening = true;
      _heard = '';
      _voiceConfirmed = false;
      _attempted = true;
    });
    await _stt.listen(
      onResult: (result) {
        final text = result.recognizedWords.trim().toLowerCase();
        final target = _ctrl.text.trim().toLowerCase();
        setState(() {
          _heard = result.recognizedWords;
          _voiceConfirmed = text == target || text.contains(target);
        });
      },
      listenFor: const Duration(seconds: 6),
      pauseFor: const Duration(seconds: 2),
      localeId: 'en_US',
    );
    setState(() => _listening = false);
  }

  void _stopListening() {
    _stt.stop();
    setState(() => _listening = false);
  }

  @override
  void dispose() {
    _ctrl.removeListener(_onTyped);
    _ctrl.dispose();
    _stt.stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: AegisColors.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: SafeArea(
        top: false,
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 220),
          child: _step == 0 ? _buildChooseStep() : _buildVoiceStep(),
        ),
      ),
    );
  }

  Widget _buildChooseStep() {
    final tt = Theme.of(context).textTheme;
    final strength = _wordStrength(_ctrl.text);
    return Padding(
      key: const ValueKey('choose'),
      padding: EdgeInsets.fromLTRB(
        24, 20, 24, MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: AegisColors.border,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 20),
          Text(
            'Family safe word',
            style: tt.titleLarge?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 8),
          Text(
            'A private word only your family knows. If someone calls claiming to be a family member, ask for it — AI voice clones can\'t answer.',
            style: tt.bodySmall?.copyWith(
              color: AegisColors.textSecondary,
              height: 1.5,
            ),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              const Icon(Icons.people_outline_rounded,
                  size: 14, color: AegisColors.turquoise),
              const SizedBox(width: 6),
              Text(
                'Your family members will need to remember this.',
                style: tt.labelSmall?.copyWith(
                  color: AegisColors.turquoise,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 18),
          // Suggestions
          Text(
            'SUGGESTED',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.4,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 6,
            children: _suggestions.map((s) {
              final selected = _ctrl.text.trim().toLowerCase() == s.toLowerCase();
              return GestureDetector(
                onTap: () => _applySuggestion(s),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                  decoration: BoxDecoration(
                    color: selected
                        ? AegisColors.turquoise.withValues(alpha: 0.18)
                        : AegisColors.surfaceElevated,
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(
                      color: selected ? AegisColors.turquoise : AegisColors.border,
                      width: selected ? 1.2 : 0.6,
                    ),
                  ),
                  child: Text(
                    s,
                    style: TextStyle(
                      color: selected
                          ? AegisColors.turquoise
                          : AegisColors.textPrimary,
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              );
            }).toList(),
          ),
          const SizedBox(height: 16),
          // Input
          TextField(
            controller: _ctrl,
            autofocus: widget.current.isEmpty,
            textCapitalization: TextCapitalization.words,
            style: Theme.of(context).textTheme.bodyMedium,
            decoration: InputDecoration(
              labelText: 'Or type your own',
              border: const OutlineInputBorder(),
              errorText: _validationError,
              suffixIcon: _ctrl.text.isNotEmpty
                  ? IconButton(
                      icon: const Icon(Icons.clear_rounded, size: 18),
                      onPressed: () => _ctrl.clear(),
                    )
                  : null,
            ),
          ),
          const SizedBox(height: 12),
          // Strength meter
          if (_ctrl.text.isNotEmpty) _StrengthMeter(strength: strength),
          const SizedBox(height: 20),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _step1Valid
                  ? () => setState(() => _step = 1)
                  : null,
              style: ElevatedButton.styleFrom(
                backgroundColor: AegisColors.turquoise,
                foregroundColor: Colors.black,
                disabledBackgroundColor:
                    AegisColors.turquoise.withValues(alpha: 0.3),
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14)),
              ),
              child: const Text(
                'Next — say it out loud',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildVoiceStep() {
    final tt = Theme.of(context).textTheme;
    final word = _ctrl.text.trim();
    return Padding(
      key: const ValueKey('voice'),
      padding: const EdgeInsets.fromLTRB(24, 20, 24, 40),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Center(
            child: Container(
              width: 40, height: 4,
              decoration: BoxDecoration(
                color: AegisColors.border,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 20),
          Text(
            'Say it out loud',
            style: tt.titleLarge?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 8),
          Text(
            'We\'ll register how you say "$word" so we can verify it matches during emergencies. Say the word clearly when you tap the mic.',
            style: tt.bodySmall?.copyWith(
              color: AegisColors.textSecondary,
              height: 1.5,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 28),
          // Big mic button
          GestureDetector(
            onTap: _listening ? _stopListening : _startListening,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              width: 96,
              height: 96,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: _listening
                    ? AegisColors.turquoise
                    : AegisColors.surfaceElevated,
                border: Border.all(
                  color: _listening
                      ? AegisColors.turquoise
                      : AegisColors.border,
                  width: 1.5,
                ),
                boxShadow: _listening
                    ? [
                        BoxShadow(
                          color: AegisColors.turquoise.withValues(alpha: 0.4),
                          blurRadius: 20,
                          spreadRadius: 4,
                        )
                      ]
                    : [],
              ),
              child: Icon(
                _listening ? Icons.stop_rounded : Icons.mic_rounded,
                size: 40,
                color: _listening ? Colors.black : AegisColors.textSecondary,
              ),
            ),
          ),
          const SizedBox(height: 16),
          Text(
            _listening
                ? 'Listening…'
                : _voiceConfirmed
                    ? 'Heard: "$_heard"'
                    : _attempted && _heard.isNotEmpty
                        ? 'Heard: "$_heard" — didn\'t match, try again or skip'
                        : _attempted
                            ? 'Mic didn\'t catch it — try again or skip below'
                            : 'Tap to record',
            style: tt.bodySmall?.copyWith(
              color: _voiceConfirmed ? AegisColors.success : AegisColors.textTertiary,
              fontWeight: _voiceConfirmed ? FontWeight.w600 : FontWeight.normal,
            ),
            textAlign: TextAlign.center,
          ),
          if (_voiceConfirmed) ...[
            const SizedBox(height: 6),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.check_circle_rounded, color: AegisColors.success, size: 16),
                const SizedBox(width: 6),
                Text('Voice confirmed',
                    style: tt.labelSmall?.copyWith(color: AegisColors.success, fontWeight: FontWeight.w600)),
              ],
            ),
          ],
          const SizedBox(height: 28),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: (_voiceConfirmed || _attempted || !_sttAvailable)
                  ? () => Navigator.of(context).pop(word)
                  : null,
              style: ElevatedButton.styleFrom(
                backgroundColor: AegisColors.turquoise,
                foregroundColor: Colors.black,
                disabledBackgroundColor: AegisColors.turquoise.withValues(alpha: 0.3),
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              ),
              child: Text(
                _voiceConfirmed ? 'Save safe word' : _attempted ? 'Save anyway' : 'Save safe word',
                style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              TextButton(
                onPressed: () => setState(() => _step = 0),
                child: Text('← Change word',
                    style: tt.bodySmall?.copyWith(color: AegisColors.textTertiary)),
              ),
              if (_attempted && !_voiceConfirmed) ...[
                Text(' · ', style: tt.bodySmall?.copyWith(color: AegisColors.textTertiary)),
                TextButton(
                  onPressed: () => Navigator.of(context).pop(word),
                  child: Text('Skip voice step',
                      style: tt.bodySmall?.copyWith(color: AegisColors.textTertiary)),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

// ── Strength meter ────────────────────────────────────────────────────────────

class _StrengthMeter extends StatelessWidget {
  final _WordStrength strength;
  const _StrengthMeter({required this.strength});

  @override
  Widget build(BuildContext context) {
    final (label, color, filled) = switch (strength) {
      _WordStrength.weak => ('Weak', AegisColors.danger, 1),
      _WordStrength.fair => ('Fair', AegisColors.warning, 2),
      _WordStrength.strong => ('Strong', AegisColors.success, 3),
      _WordStrength.none => ('', AegisColors.border, 0),
    };
    return Row(
      children: [
        ...List.generate(3, (i) {
          return Expanded(
            child: Container(
              height: 4,
              margin: EdgeInsets.only(right: i < 2 ? 4 : 0),
              decoration: BoxDecoration(
                color: i < filled ? color : AegisColors.border,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          );
        }),
        const SizedBox(width: 10),
        Text(
          label,
          style: TextStyle(
            color: color,
            fontSize: 12,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}
