import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';

class _FamilyMember {
  final String name;
  final String relation;
  const _FamilyMember(this.name, this.relation);
}

class FamilyScreen extends StatefulWidget {
  const FamilyScreen({super.key});

  @override
  State<FamilyScreen> createState() => _FamilyScreenState();
}

class _FamilyScreenState extends State<FamilyScreen> {
  static const int _baseLines = 3;
  static const int _maxLines = 5;
  static const String _baseTier = 'Pro · 3 lines';
  static const String _plusTier = 'Family+ · up to 5 lines';
  static const String _plusPrice = '\$69.99 / mo';

  final List<_FamilyMember> _members = const [];

  bool get _isFamilyPlus => _members.length > _baseLines;
  int get _capacity => _isFamilyPlus ? _maxLines : _baseLines;

  Future<void> _showAddMemberSheet() async {
    if (_members.length >= _maxLines) return;

    if (_members.length >= _baseLines && !_isFamilyPlus) {
      // Already at base capacity — adding triggers Family+ upgrade prompt.
      final upgrade = await _confirmUpgrade();
      if (upgrade != true) return;
    }

    if (!mounted) return;
    final added = await showModalBottomSheet<_FamilyMember>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AegisColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => const _AddMemberSheet(),
    );
    if (added != null) setState(() => _members.add(added));
  }

  Future<bool?> _confirmUpgrade() {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AegisColors.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: const Text('Upgrade to Family+'),
        content: const Text(
          "You're at 3 lines on Pro. Adding a 4th line upgrades you to Family+ (up to 5 lines) at \$69.99 / month.",
          style: TextStyle(color: AegisColors.textSecondary, height: 1.45),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Not now'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: ElevatedButton.styleFrom(
              minimumSize: const Size(0, 44),
              backgroundColor: AegisColors.turquoise,
              foregroundColor: Colors.black,
            ),
            child: const Text('Upgrade'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final usedLines = _members.length;
    final tierLabel = _isFamilyPlus ? _plusTier : _baseTier;

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
                if (!_isFamilyPlus) ...[
                  const SizedBox(height: 10),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      vertical: 10,
                      horizontal: 12,
                    ),
                    decoration: BoxDecoration(
                      color: AegisColors.surfaceElevated,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Row(
                      children: [
                        const Icon(
                          Icons.info_outline_rounded,
                          size: 16,
                          color: AegisColors.textTertiary,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            'Add 2 more lines to upgrade to Family+ ($_plusPrice).',
                            style: tt.bodySmall?.copyWith(
                              color: AegisColors.textSecondary,
                              height: 1.4,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
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
            ..._members.map((m) => _MemberTile(member: m)),
          if (_members.length < _maxLines) ...[
            const SizedBox(height: 8),
            _AddSlot(
              label: _members.length >= _baseLines
                  ? 'Add a line — upgrades to Family+ ($_plusPrice)'
                  : 'Add a family member',
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
                    ],
                  ),
                ),
                TextButton(onPressed: () {}, child: const Text('Set')),
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
              'No family lines yet — add up to 3 on Pro, or 5 on Family+.',
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
  const _MemberTile({required this.member});

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
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Row(
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
                  member.relation,
                  style: tt.labelSmall?.copyWith(
                    color: AegisColors.textTertiary,
                  ),
                ),
              ],
            ),
          ),
          const Icon(
            Icons.fiber_manual_record,
            color: AegisColors.textTertiary,
            size: 10,
          ),
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
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  member.name,
                  style: tt.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Text(
                member.relation,
                style: tt.labelSmall?.copyWith(
                  color: AegisColors.textTertiary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: const [
              Expanded(
                child: _ExposureStat(
                  icon: Icons.phone_disabled_rounded,
                  label: 'Calls blocked',
                  value: '0',
                ),
              ),
              SizedBox(width: 8),
              Expanded(
                child: _ExposureStat(
                  icon: Icons.delete_sweep_outlined,
                  label: 'Texts deleted',
                  value: '0',
                ),
              ),
              SizedBox(width: 8),
              Expanded(
                child: _ExposureStat(
                  icon: Icons.fingerprint_rounded,
                  label: 'Breaches',
                  value: '0',
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Container(
                width: 6,
                height: 6,
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  color: AegisColors.success,
                ),
              ),
              const SizedBox(width: 6),
              Text(
                'Protected · last scam attempt: never',
                style: tt.labelSmall?.copyWith(
                  color: AegisColors.textTertiary,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ExposureStat extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  const _ExposureStat({
    required this.icon,
    required this.label,
    required this.value,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 10),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: AegisColors.turquoise, size: 14),
          const SizedBox(height: 6),
          Text(
            value,
            style: tt.titleMedium?.copyWith(
              color: AegisColors.textPrimary,
              fontWeight: FontWeight.w700,
            ),
          ),
          Text(
            label,
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              height: 1.2,
            ),
          ),
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

  @override
  void dispose() {
    _name.dispose();
    _relation.dispose();
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
          const SizedBox(height: 16),
          ElevatedButton(
            onPressed: () {
              final name = _name.text.trim();
              if (name.isEmpty) return;
              Navigator.of(context).pop(_FamilyMember(
                name,
                _relation.text.trim().isEmpty ? 'Family' : _relation.text.trim(),
              ));
            },
            child: const Text('Add'),
          ),
        ],
      ),
    );
  }
}
