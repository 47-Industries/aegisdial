import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../services/identity_shield_service.dart';

/// Pro-only screen surfacing the Identity Shield I-P5/I-P6 stack:
///   - "Active threats near you" pulled from /v1/stats/summary
///   - List of monitored identifiers (email / phone) + add/remove
///   - List of breach findings with acknowledge actions
///
/// Hashed monitor kinds (SSN / DOB / name+address) are NOT exposed
/// here yet — they need a dedicated guarded sheet with stronger UX
/// disclosure ("we never store your SSN — only a salted hash") that's
/// out of scope for the I-P5 surface.
class IdentityShieldScreen extends StatefulWidget {
  const IdentityShieldScreen({super.key});

  @override
  State<IdentityShieldScreen> createState() => _IdentityShieldScreenState();
}

class _IdentityShieldScreenState extends State<IdentityShieldScreen> {
  final List<IdentityMonitor> _monitors = [];
  final List<IdentityFinding> _findings = [];
  IdentityShieldTile? _tile;
  bool _loading = true;
  bool _refreshing = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _refreshing = true);
    try {
      // Fan-out: tile counts, monitors, findings in parallel. Each
      // arm null-tolerant so a slow `/findings` doesn't block the
      // rest of the screen rendering.
      final stats = await api.get('/v1/stats/summary').catchError(
        (_) => <String, dynamic>{},
      );
      final monitors = await identityShieldService.listMonitors();
      final findings = await identityShieldService.listFindings(limit: 30);
      if (!mounted) return;
      setState(() {
        _tile = IdentityShieldTile.fromStats(stats);
        _monitors
          ..clear()
          ..addAll(monitors ?? const []);
        _findings
          ..clear()
          ..addAll(findings ?? const []);
        _loading = false;
        _refreshing = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _refreshing = false;
      });
    }
  }

  Future<void> _showAddSheet() async {
    final added = await showModalBottomSheet<IdentityMonitor>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AegisColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => const _AddMonitorSheet(),
    );
    if (added == null || !mounted) return;
    setState(() => _monitors.insert(0, added));
  }

  Future<void> _removeMonitor(IdentityMonitor m) async {
    setState(() => _monitors.remove(m));
    final ok = await identityShieldService.deleteMonitor(m.backendId);
    if (!ok && mounted) {
      // Transient failure — put it back so the user can retry. We
      // don't try to swallow it silently because Identity Shield is
      // a paid-feature core surface.
      setState(() => _monitors.insert(0, m));
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("Couldn't remove monitor. Try again.")),
      );
    }
  }

  Future<void> _acknowledge(IdentityFinding f) async {
    final ok = await identityShieldService.acknowledgeFinding(f.backendId);
    if (!ok || !mounted) return;
    setState(() {
      final idx = _findings.indexWhere((x) => x.backendId == f.backendId);
      if (idx >= 0) {
        _findings[idx] = IdentityFinding(
          backendId: f.backendId,
          monitorId: f.monitorId,
          monitorKind: f.monitorKind,
          valuePreview: f.valuePreview,
          breachName: f.breachName,
          breachDomain: f.breachDomain,
          breachDate: f.breachDate,
          dataClasses: f.dataClasses,
          severity: f.severity,
          surfacedAt: f.surfacedAt,
          acknowledgedAt: DateTime.now(),
          remediationCompletedAt: f.remediationCompletedAt,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final session = auth.session;
    final isGuest = session == null || session.userId == 'guest';
    final isPro = !isGuest &&
        (session.tier == 'pro' || session.tier == 'in_grace');

    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(
        title: const Text('Identity Shield'),
        actions: [
          if (isPro)
            IconButton(
              icon: const Icon(Icons.refresh_rounded),
              onPressed: _refreshing ? null : _load,
              tooltip: 'Refresh',
            ),
        ],
      ),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: AegisColors.blueAccent),
            )
          : !isPro
              ? _ProUpsell(isGuest: isGuest)
              : RefreshIndicator(
                  color: AegisColors.blueAccent,
                  backgroundColor: AegisColors.surface,
                  onRefresh: _load,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
                    children: [
                      _ThreatsTile(tile: _tile),
                      const SizedBox(height: 20),
                      Text('MONITORED IDENTIFIERS',
                          style: _sectionLabel(tt)),
                      const SizedBox(height: 10),
                      if (_monitors.isEmpty)
                        _EmptyTile(
                          icon: Icons.shield_outlined,
                          title: 'No identifiers monitored yet.',
                          subtitle:
                              'Add an email or phone to watch for fresh dark-web exposures.',
                        )
                      else
                        ..._monitors.map((m) => _MonitorTile(
                              monitor: m,
                              onRemove: () => _removeMonitor(m),
                            )),
                      const SizedBox(height: 10),
                      _AddSlot(onTap: _showAddSheet),
                      const SizedBox(height: 24),
                      Text('FINDINGS', style: _sectionLabel(tt)),
                      const SizedBox(height: 10),
                      if (_findings.isEmpty)
                        _EmptyTile(
                          icon: Icons.verified_user_outlined,
                          iconColor: AegisColors.success,
                          title: 'No findings yet.',
                          subtitle:
                              'When a monitored identifier shows up in a fresh breach, the alert appears here.',
                        )
                      else
                        ..._findings.map((f) => _FindingTile(
                              finding: f,
                              onAcknowledge:
                                  f.acknowledged ? null : () => _acknowledge(f),
                            )),
                    ],
                  ),
                ),
    );
  }

  static TextStyle? _sectionLabel(TextTheme tt) => tt.labelSmall?.copyWith(
        color: AegisColors.textTertiary,
        letterSpacing: 1.6,
        fontWeight: FontWeight.w600,
      );
}

class _ThreatsTile extends StatelessWidget {
  final IdentityShieldTile? tile;
  const _ThreatsTile({this.tile});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final t = tile;
    return GlassCard(
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
                child: const Icon(Icons.radar_rounded,
                    color: AegisColors.blueAccent),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'Active threats near you',
                  style: tt.titleLarge?.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              _MetricChip(
                value: t == null ? '—' : '${t.activeThreatsNearUser30d}',
                label: 'Active 30d',
                color: AegisColors.blueAccent,
              ),
              const SizedBox(width: 10),
              _MetricChip(
                value: t == null
                    ? '—'
                    : (t.activeThreatsDelta7d > 0
                        ? '+${t.activeThreatsDelta7d}'
                        : '${t.activeThreatsDelta7d}'),
                label: 'New 7d',
                color: (t?.activeThreatsDelta7d ?? 0) > 0
                    ? AegisColors.warning
                    : AegisColors.textSecondary,
              ),
              const SizedBox(width: 10),
              _MetricChip(
                value: t == null ? '—' : '${t.newFindings7d}',
                label: 'Findings 7d',
                color: (t?.newFindings7d ?? 0) > 0
                    ? AegisColors.danger
                    : AegisColors.success,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _MetricChip extends StatelessWidget {
  final String value;
  final String label;
  final Color color;
  const _MetricChip({
    required this.value,
    required this.label,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 10),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: color.withValues(alpha: 0.25), width: 0.8),
        ),
        child: Column(
          children: [
            Text(
              value,
              style: tt.titleLarge?.copyWith(
                color: color,
                fontWeight: FontWeight.w800,
                letterSpacing: -0.4,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              label,
              style: tt.labelSmall?.copyWith(
                color: AegisColors.textTertiary,
                fontSize: 10.5,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MonitorTile extends StatelessWidget {
  final IdentityMonitor monitor;
  final VoidCallback onRemove;
  const _MonitorTile({required this.monitor, required this.onRemove});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final icon = switch (monitor.kind) {
      'phone_e164' => Icons.phone_outlined,
      'email' => Icons.email_outlined,
      'ssn_last4_hash' => Icons.fingerprint_rounded,
      'dob_hash' => Icons.cake_outlined,
      _ => Icons.person_outline_rounded,
    };
    final label = switch (monitor.kind) {
      'phone_e164' => 'Phone',
      'email' => 'Email',
      'ssn_last4_hash' => 'SSN',
      'dob_hash' => 'Date of Birth',
      _ => 'Identifier',
    };
    return Dismissible(
      key: ValueKey(monitor.backendId),
      direction: DismissDirection.endToStart,
      background: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 18),
        alignment: Alignment.centerRight,
        decoration: BoxDecoration(
          color: AegisColors.danger.withValues(alpha: 0.18),
          borderRadius: BorderRadius.circular(14),
        ),
        child: const Icon(Icons.delete_outline_rounded,
            color: AegisColors.danger),
      ),
      onDismissed: (_) => onRemove(),
      child: Container(
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
              child: Icon(icon, color: AegisColors.blueAccent, size: 18),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    monitor.valuePreview,
                    style: tt.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                  ),
                  Text(
                    label,
                    style: tt.labelSmall
                        ?.copyWith(color: AegisColors.textTertiary),
                  ),
                ],
              ),
            ),
            const Icon(Icons.check_circle_outline,
                color: AegisColors.success, size: 18),
          ],
        ),
      ),
    );
  }
}

class _FindingTile extends StatelessWidget {
  final IdentityFinding finding;
  final VoidCallback? onAcknowledge;
  const _FindingTile({required this.finding, this.onAcknowledge});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final accent = switch (finding.severity) {
      'critical' => AegisColors.danger,
      'warning' => AegisColors.warning,
      _ => AegisColors.blueAccent,
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: accent.withValues(alpha: 0.5),
          width: 0.8,
        ),
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
                  color: accent.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(Icons.cloud_off_rounded, color: accent, size: 16),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      finding.breachName,
                      style: tt.bodyMedium
                          ?.copyWith(fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      finding.breachDomain ?? finding.valuePreview,
                      style: tt.labelSmall
                          ?.copyWith(color: AegisColors.textTertiary),
                    ),
                    if (finding.breachDate != null)
                      Text(
                        'Breached ${finding.breachDate}',
                        style: tt.labelSmall
                            ?.copyWith(color: AegisColors.textTertiary),
                      ),
                    if (finding.dataClasses.isNotEmpty) ...[
                      const SizedBox(height: 5),
                      Wrap(
                        spacing: 4,
                        runSpacing: 3,
                        children: finding.dataClasses
                            .map((t) => Container(
                                  padding: const EdgeInsets.symmetric(
                                      horizontal: 6, vertical: 2),
                                  decoration: BoxDecoration(
                                    color: accent.withValues(alpha: 0.12),
                                    borderRadius: BorderRadius.circular(4),
                                  ),
                                  child: Text(
                                    t,
                                    style: tt.labelSmall?.copyWith(
                                      color: accent,
                                      fontSize: 10,
                                    ),
                                  ),
                                ))
                            .toList(),
                      ),
                    ],
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
                  onPressed: onAcknowledge,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: onAcknowledge == null
                        ? AegisColors.surfaceElevated
                        : AegisColors.blueAccent,
                    foregroundColor: onAcknowledge == null
                        ? AegisColors.textTertiary
                        : Colors.black,
                    minimumSize: const Size.fromHeight(36),
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                  ),
                  icon: Icon(
                    onAcknowledge == null
                        ? Icons.check_rounded
                        : Icons.visibility_outlined,
                    size: 16,
                  ),
                  label: Text(
                    onAcknowledge == null ? 'Acknowledged' : 'Mark seen',
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
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
            children: const [
              Icon(Icons.add_rounded, color: AegisColors.blueAccent),
              SizedBox(width: 10),
              Text(
                'Add email or phone to monitor',
                style: TextStyle(
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

class _EmptyTile extends StatelessWidget {
  final IconData icon;
  final Color? iconColor;
  final String title;
  final String subtitle;
  const _EmptyTile({
    required this.icon,
    this.iconColor,
    required this.title,
    required this.subtitle,
  });

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
      child: Column(
        children: [
          Icon(icon, color: iconColor ?? AegisColors.textTertiary, size: 32),
          const SizedBox(height: 10),
          Text(
            title,
            style: tt.bodyMedium?.copyWith(color: AegisColors.textSecondary),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 4),
          Text(
            subtitle,
            style: tt.bodySmall?.copyWith(
              color: AegisColors.textTertiary,
              height: 1.4,
            ),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}

class _ProUpsell extends StatelessWidget {
  final bool isGuest;
  const _ProUpsell({required this.isGuest});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.lock_outline_rounded,
                color: AegisColors.blueAccent, size: 48),
            const SizedBox(height: 16),
            Text(
              'Identity Shield is Pro-only',
              style: tt.titleLarge?.copyWith(fontWeight: FontWeight.w700),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            Text(
              isGuest
                  ? 'Create an account and start your free trial to monitor your email, phone, and identity for fresh dark-web exposures.'
                  : 'Upgrade to Pro to monitor your email, phone, and identity for fresh dark-web exposures.',
              style: tt.bodyMedium?.copyWith(
                color: AegisColors.textSecondary,
                height: 1.55,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

class _AddMonitorSheet extends StatefulWidget {
  const _AddMonitorSheet();

  @override
  State<_AddMonitorSheet> createState() => _AddMonitorSheetState();
}

class _AddMonitorSheetState extends State<_AddMonitorSheet> {
  String _kind = 'email'; // 'email' | 'phone_e164'
  final _ctrl = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final v = _ctrl.text.trim();
    if (v.isEmpty) return;
    setState(() => _submitting = true);
    final result = await identityShieldService.addMonitor(kind: _kind, value: v);
    if (!mounted) return;
    setState(() => _submitting = false);
    if (result.ok != null) {
      Navigator.of(context).pop(result.ok);
      return;
    }
    final code = result.err ?? '';
    final msg = code.contains('409') || code.contains('duplicate')
        ? 'Already being monitored.'
        : code.contains('400') || code.contains('invalid')
            ? 'That doesn\'t look like a valid ${_kind == 'email' ? 'email' : 'phone number'}.'
            : code.contains('429')
                ? 'You\'ve reached the monitor cap. Remove one to add another.'
                : "Couldn't add monitor. Try again.";
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
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
            'Add identity monitor',
            style: tt.titleLarge?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              for (final entry in const [
                ('email', 'Email'),
                ('phone_e164', 'Phone'),
              ])
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: FilterChip(
                    label: Text(entry.$2),
                    selected: _kind == entry.$1,
                    onSelected: (_) => setState(() {
                      _kind = entry.$1;
                      _ctrl.clear();
                    }),
                    selectedColor:
                        AegisColors.blueAccent.withValues(alpha: 0.25),
                    checkmarkColor: AegisColors.blueAccent,
                    labelStyle: TextStyle(
                      color: _kind == entry.$1
                          ? AegisColors.blueAccent
                          : AegisColors.textSecondary,
                      fontWeight: FontWeight.w600,
                    ),
                    backgroundColor: AegisColors.surfaceElevated,
                    side: BorderSide(
                      color: _kind == entry.$1
                          ? AegisColors.blueAccent
                          : AegisColors.border,
                      width: _kind == entry.$1 ? 1.2 : 0.6,
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 14),
          TextField(
            controller: _ctrl,
            autofocus: true,
            keyboardType: _kind == 'email'
                ? TextInputType.emailAddress
                : TextInputType.phone,
            decoration: InputDecoration(
              labelText: _kind == 'email' ? 'Email address' : 'Phone number',
              hintText: _kind == 'email'
                  ? 'you@example.com'
                  : '+1 (555) 000-0000',
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          ElevatedButton(
            onPressed: _submitting ? null : _submit,
            child: _submitting
                ? const SizedBox(
                    height: 16,
                    width: 16,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.black,
                    ),
                  )
                : const Text('Start monitoring'),
          ),
        ],
      ),
    );
  }
}
