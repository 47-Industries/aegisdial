import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';

enum _IdentifierType { name, phone, email, ssn }

class _Identifier {
  final _IdentifierType type;
  final String value;
  bool scanning;
  bool scanned;
  _Identifier({required this.type, required this.value})
      : scanning = false,
        scanned = false;

  IconData get icon => switch (type) {
        _IdentifierType.name => Icons.person_outline_rounded,
        _IdentifierType.phone => Icons.phone_outlined,
        _IdentifierType.email => Icons.email_outlined,
        _IdentifierType.ssn => Icons.fingerprint_rounded,
      };

  String get label => switch (type) {
        _IdentifierType.name => 'Name',
        _IdentifierType.phone => 'Phone',
        _IdentifierType.email => 'Email',
        _IdentifierType.ssn => 'SSN',
      };

  String get masked {
    if (type == _IdentifierType.ssn && value.length >= 4) {
      return '•••-••-${value.substring(value.length - 4)}';
    }
    return value;
  }
}

class _Exposure {
  final String title;
  final String source;
  final String date;
  final IconData icon;
  bool dismissed = false;
  _Exposure({
    required this.title,
    required this.source,
    required this.date,
    required this.icon,
  });
}

class BreachScreen extends StatefulWidget {
  const BreachScreen({super.key});

  @override
  State<BreachScreen> createState() => _BreachScreenState();
}

class _BreachScreenState extends State<BreachScreen> {
  final List<_Identifier> _identifiers = [];
  final List<_Exposure> _exposures = [];

  Future<void> _showAddSheet() async {
    final result = await showModalBottomSheet<_Identifier>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AegisColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => const _AddIdentifierSheet(),
    );
    if (result == null) return;
    setState(() => _identifiers.add(result));
    _runScan(result);
  }

  Future<void> _runScan(_Identifier id) async {
    setState(() => id.scanning = true);
    await Future.delayed(const Duration(seconds: 2));
    if (!mounted) return;
    setState(() {
      id.scanning = false;
      id.scanned = true;
      if (id.type == _IdentifierType.email) {
        _exposures.add(_Exposure(
          title: '${id.value} found in breach corpus',
          source: 'Collection #1 — credentials + hashed password',
          date: '2024-08',
          icon: Icons.cloud_off_rounded,
        ));
      }
      if (id.type == _IdentifierType.phone) {
        _exposures.add(_Exposure(
          title: 'Phone ${id.value} on scam-call list',
          source: 'FCC robocall index · reported 23×',
          date: '2025-03',
          icon: Icons.phone_disabled_rounded,
        ));
      }
      if (id.type == _IdentifierType.ssn) {
        _exposures.add(_Exposure(
          title: 'SSN partial match on dark-web forum',
          source: 'BreachForums dump · 1.4M records',
          date: '2025-11',
          icon: Icons.travel_explore_rounded,
        ));
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final visibleExposures = _exposures.where((e) => !e.dismissed).toList();

    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(title: const Text('Breach Monitor')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
        children: [
          GlassCard(
            accent: AegisColors.blueAccent,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AegisColors.blueAccent.withValues(alpha: 0.14),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(Icons.fingerprint_rounded,
                          color: AegisColors.blueAccent),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'Dark-web monitor',
                        style: tt.titleLarge
                            ?.copyWith(fontWeight: FontWeight.w700),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  'Add your name, phone, email, or SSN. AegisDial watches dark-web markets, breach dumps, and scam-call lists for your info — and alerts you the moment it surfaces.',
                  style: tt.bodyMedium?.copyWith(
                    color: AegisColors.textSecondary,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          Text(
            'MONITORED IDENTIFIERS',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.6,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          if (_identifiers.isEmpty)
            Container(
              padding:
                  const EdgeInsets.symmetric(vertical: 20, horizontal: 16),
              decoration: BoxDecoration(
                color: AegisColors.surface.withValues(alpha: 0.55),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AegisColors.border, width: 0.6),
              ),
              child: Text(
                'No identifiers added yet. Add your name, phone, email, or SSN to start monitoring.',
                style: tt.bodySmall?.copyWith(
                  color: AegisColors.textSecondary,
                  height: 1.45,
                ),
              ),
            )
          else
            ..._identifiers.map((id) => _IdentifierTile(id: id)),
          const SizedBox(height: 10),
          _AddSlot(onTap: _showAddSheet),
          const SizedBox(height: 24),
          Text(
            'EXPOSURES',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.6,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          if (visibleExposures.isEmpty)
            Container(
              padding:
                  const EdgeInsets.symmetric(vertical: 28, horizontal: 18),
              decoration: BoxDecoration(
                color: AegisColors.surface.withValues(alpha: 0.55),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AegisColors.border, width: 0.6),
              ),
              child: Column(
                children: [
                  const Icon(Icons.verified_user_outlined,
                      color: AegisColors.success, size: 32),
                  const SizedBox(height: 10),
                  Text(
                    'No exposures found.',
                    style: tt.bodyMedium
                        ?.copyWith(color: AegisColors.textSecondary),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'When your details surface, the exact source appears here.',
                    style: tt.bodySmall?.copyWith(
                      color: AegisColors.textTertiary,
                      height: 1.4,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            )
          else
            ...visibleExposures.map(
              (e) => _ExposureTile(
                exposure: e,
                onDismiss: () => setState(() => e.dismissed = true),
              ),
            ),
          const SizedBox(height: 24),
          Text(
            'SOURCES WE WATCH',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.6,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          const _SourceTile(
            icon: Icons.travel_explore_rounded,
            title: 'Dark-web marketplaces',
            subtitle: 'Stolen credentials, identity dumps, fullz listings.',
          ),
          const _SourceTile(
            icon: Icons.cloud_off_rounded,
            title: 'Breach corpora',
            subtitle: 'Public + private leak datasets, updated continuously.',
          ),
          const _SourceTile(
            icon: Icons.phone_disabled_rounded,
            title: 'Scam-call lists',
            subtitle: 'Numbers reported by FCC, BBB, and r/Scams.',
          ),
        ],
      ),
    );
  }
}

class _IdentifierTile extends StatelessWidget {
  final _Identifier id;
  const _IdentifierTile({required this.id});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
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
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: AegisColors.blueAccent.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(id.icon, color: AegisColors.blueAccent, size: 18),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  id.masked,
                  style: tt.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                ),
                Text(
                  id.label,
                  style: tt.labelSmall
                      ?.copyWith(color: AegisColors.textTertiary),
                ),
              ],
            ),
          ),
          if (id.scanning)
            const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(
                color: AegisColors.blueAccent,
                strokeWidth: 2,
              ),
            )
          else if (id.scanned)
            const Icon(Icons.check_circle_outline,
                color: AegisColors.success, size: 18)
          else
            const Icon(Icons.schedule_rounded,
                color: AegisColors.textTertiary, size: 18),
        ],
      ),
    );
  }
}

class _ExposureTile extends StatelessWidget {
  final _Exposure exposure;
  final VoidCallback onDismiss;
  const _ExposureTile({required this.exposure, required this.onDismiss});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
            color: AegisColors.danger.withValues(alpha: 0.5), width: 0.8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                padding: const EdgeInsets.all(7),
                decoration: BoxDecoration(
                  color: AegisColors.danger.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child:
                    Icon(exposure.icon, color: AegisColors.danger, size: 16),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      exposure.title,
                      style: tt.bodyMedium
                          ?.copyWith(fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      exposure.source,
                      style: tt.labelSmall
                          ?.copyWith(color: AegisColors.textTertiary),
                    ),
                    Text(
                      exposure.date,
                      style: tt.labelSmall
                          ?.copyWith(color: AegisColors.textTertiary),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: ElevatedButton.icon(
                  onPressed: () {
                    showDialog(
                      context: context,
                      builder: (ctx) => AlertDialog(
                        backgroundColor: AegisColors.surface,
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(18)),
                        title: const Text('Change your password'),
                        content: Text(
                          'Go to the service where "${exposure.title.split(" ").first}" appeared and update your password there.\n\nUse a unique password you don\'t use anywhere else. A password manager makes this easy.',
                          style: const TextStyle(
                              color: AegisColors.textSecondary, height: 1.5),
                        ),
                        actions: [
                          ElevatedButton(
                            onPressed: () => Navigator.of(ctx).pop(),
                            style: ElevatedButton.styleFrom(
                              minimumSize: const Size(0, 44),
                              backgroundColor: AegisColors.blueAccent,
                              foregroundColor: Colors.black,
                            ),
                            child: const Text('Got it'),
                          ),
                        ],
                      ),
                    );
                  },
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AegisColors.blueAccent,
                    foregroundColor: Colors.black,
                    minimumSize: const Size.fromHeight(36),
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                  ),
                  icon: const Icon(Icons.lock_reset_rounded, size: 16),
                  label: const Text('Change Password',
                      style: TextStyle(fontSize: 13)),
                ),
              ),
              const SizedBox(width: 8),
              OutlinedButton(
                onPressed: onDismiss,
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size(60, 36),
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  side: const BorderSide(
                      color: AegisColors.textTertiary, width: 0.6),
                ),
                child: const Text('Dismiss',
                    style: TextStyle(
                        color: AegisColors.textSecondary, fontSize: 13)),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _AddSlot extends StatelessWidget {
  final VoidCallback onTap;
  const _AddSlot({required this.onTap});

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
              color: AegisColors.blueAccent.withValues(alpha: 0.4),
              width: 1,
            ),
          ),
          child: Row(
            children: [
              const Icon(Icons.add_rounded, color: AegisColors.blueAccent),
              const SizedBox(width: 10),
              Text(
                'Add name, phone, email, or SSN',
                style: const TextStyle(
                  color: AegisColors.textPrimary,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AddIdentifierSheet extends StatefulWidget {
  const _AddIdentifierSheet();

  @override
  State<_AddIdentifierSheet> createState() => _AddIdentifierSheetState();
}

class _AddIdentifierSheetState extends State<_AddIdentifierSheet> {
  _IdentifierType _type = _IdentifierType.email;
  final _ctrl = TextEditingController();

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  String get _hint => switch (_type) {
        _IdentifierType.name => 'Full name',
        _IdentifierType.phone => '+1 (555) 000-0000',
        _IdentifierType.email => 'you@example.com',
        _IdentifierType.ssn => '•••-••-1234',
      };

  String get _label => switch (_type) {
        _IdentifierType.name => 'Name',
        _IdentifierType.phone => 'Phone number',
        _IdentifierType.email => 'Email address',
        _IdentifierType.ssn => 'Social Security Number',
      };

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
            'Add identifier to monitor',
            style: tt.titleLarge?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 14),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: _IdentifierType.values.map((t) {
                final selected = t == _type;
                return Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: FilterChip(
                    label: Text(switch (t) {
                      _IdentifierType.name => 'Name',
                      _IdentifierType.phone => 'Phone',
                      _IdentifierType.email => 'Email',
                      _IdentifierType.ssn => 'SSN',
                    }),
                    selected: selected,
                    onSelected: (_) => setState(() {
                      _type = t;
                      _ctrl.clear();
                    }),
                    selectedColor:
                        AegisColors.blueAccent.withValues(alpha: 0.25),
                    checkmarkColor: AegisColors.blueAccent,
                    labelStyle: TextStyle(
                      color: selected
                          ? AegisColors.blueAccent
                          : AegisColors.textSecondary,
                      fontWeight: FontWeight.w600,
                    ),
                    backgroundColor: AegisColors.surfaceElevated,
                    side: BorderSide(
                      color: selected
                          ? AegisColors.blueAccent
                          : AegisColors.border,
                      width: selected ? 1.2 : 0.6,
                    ),
                  ),
                );
              }).toList(),
            ),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: _ctrl,
            autofocus: true,
            obscureText: _type == _IdentifierType.ssn,
            keyboardType: switch (_type) {
              _IdentifierType.phone => TextInputType.phone,
              _IdentifierType.email => TextInputType.emailAddress,
              _IdentifierType.ssn => TextInputType.number,
              _ => TextInputType.text,
            },
            decoration: InputDecoration(
              labelText: _label,
              hintText: _hint,
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          ElevatedButton(
            onPressed: () {
              final v = _ctrl.text.trim();
              if (v.isEmpty) return;
              Navigator.of(context)
                  .pop(_Identifier(type: _type, value: v));
            },
            child: const Text('Add & Scan'),
          ),
        ],
      ),
    );
  }
}

class _SourceTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  const _SourceTile({
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: AegisColors.blueAccent.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: AegisColors.blueAccent, size: 18),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style:
                        tt.bodyLarge?.copyWith(fontWeight: FontWeight.w600)),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: tt.bodySmall?.copyWith(
                      color: AegisColors.textTertiary, height: 1.35),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
