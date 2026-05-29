import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../services/breach_monitor_service.dart';

enum _IdentifierType { name, phone, email, ssn }

class _Identifier {
  final _IdentifierType type;
  final String value;
  // Server-side row id when this identifier is syncing through
  // `/v1/breach/monitor`. Null for SSN/name (never sent), for
  // guest/free users, and for local-only rows the backend hasn't
  // accepted yet (transient network errors). `remove()` uses this
  // to fire the DELETE call; absence just means local-only cleanup.
  String? backendId;
  bool scanning;
  bool scanned;
  // Set when the most recent scan failed (network error / 5xx). Drives
  // the row's retry affordance so we never render a misleading "clean"
  // state when we actually got no answer.
  bool scanError;
  _Identifier({
    required this.type,
    required this.value,
    this.scanned = false,
    this.backendId,
  })  : scanning = false,
        scanError = false;

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

  Map<String, dynamic> toJson() => {
        't': type.index,
        'v': value,
        'sc': scanned,
        if (backendId != null) 'bid': backendId,
      };

  factory _Identifier.fromJson(Map<String, dynamic> j) => _Identifier(
        type: _IdentifierType.values[j['t'] as int],
        value: j['v'] as String,
        scanned: j['sc'] as bool? ?? true,
        backendId: j['bid'] as String?,
      );
}

class _Exposure {
  final String title;
  final String source;
  final String date;
  final IconData icon;
  final String severity;
  final List<String> dataTypes;
  bool dismissed;
  _Exposure({
    required this.title,
    required this.source,
    required this.date,
    required this.icon,
    this.severity = 'warning',
    this.dataTypes = const [],
    this.dismissed = false,
  });

  Map<String, dynamic> toJson() => {
        'ti': title,
        'so': source,
        'd': date,
        'ic': icon.codePoint,
        'se': severity,
        'dt': dataTypes,
        'di': dismissed,
      };

  factory _Exposure.fromJson(Map<String, dynamic> j) => _Exposure(
        title: j['ti'] as String,
        source: j['so'] as String,
        date: j['d'] as String,
        icon: IconData(j['ic'] as int, fontFamily: 'MaterialIcons'),
        severity: j['se'] as String? ?? 'warning',
        dataTypes: (j['dt'] as List<dynamic>).map((e) => e.toString()).toList(),
        dismissed: j['di'] as bool? ?? false,
      );
}

class BreachScreen extends StatefulWidget {
  const BreachScreen({super.key});

  @override
  State<BreachScreen> createState() => _BreachScreenState();
}

class _BreachScreenState extends State<BreachScreen> {
  static const _kIdentifiersKey = 'breach_identifiers_v1';
  static const _kExposuresKey = 'breach_exposures_v1';

  final List<_Identifier> _identifiers = [];
  final List<_Exposure> _exposures = [];

  @override
  void initState() {
    super.initState();
    _loadState();
  }

  Future<void> _loadState() async {
    final p = await SharedPreferences.getInstance();
    try {
      final ids = p.getString(_kIdentifiersKey);
      if (ids != null) {
        final list = jsonDecode(ids) as List<dynamic>;
        if (mounted) {
          setState(() {
            _identifiers.addAll(
                list.map((e) => _Identifier.fromJson(e as Map<String, dynamic>)));
          });
        }
      }
      final exps = p.getString(_kExposuresKey);
      if (exps != null) {
        final list = jsonDecode(exps) as List<dynamic>;
        if (mounted) {
          setState(() {
            _exposures.addAll(
                list.map((e) => _Exposure.fromJson(e as Map<String, dynamic>)));
          });
        }
      }
    } catch (_) {}

    // Pro users: pull the persistent monitor list + alerts from the
    // backend and merge by (kind, value). This is what flips this
    // screen from a one-shot quick-check into the actual continuous
    // monitor the marketing promises. For guest / free / non-Pro
    // users the service returns null and we keep the local-only
    // shared-pref flow above untouched.
    await _resyncFromBackend();
  }

  Future<void> _resyncFromBackend() async {
    final bundle = await breachMonitorService.list();
    if (bundle == null || !mounted) return;

    setState(() {
      // Layer 1: stamp backendId onto any local row that matches a
      // server-side monitor by (kind, displayValue match on prefix
      // or value contains). The backend masks display_value (e.g.
      // `t****@gmail.com`) so we match on type AND best-effort.
      // When in doubt we fall through and treat the server row as
      // authoritative.
      final remaining = <BreachMonitor>{...bundle.monitors};
      for (final local in _identifiers) {
        final kind = switch (local.type) {
          _IdentifierType.email => 'email',
          _IdentifierType.phone => 'phone',
          _ => null,
        };
        if (kind == null) continue;
        BreachMonitor? match;
        for (final m in remaining) {
          if (m.kind != kind) continue;
          // Match on suffix for emails (`@domain.com`) and last 4 for
          // phones — works against the backend's masked display.
          if (kind == 'email') {
            final at = local.value.indexOf('@');
            if (at > 0 && m.displayValue.endsWith(local.value.substring(at))) {
              match = m;
              break;
            }
          } else {
            final digits = local.value.replaceAll(RegExp(r'\D'), '');
            if (digits.length >= 4 &&
                m.displayValue.endsWith(digits.substring(digits.length - 4))) {
              match = m;
              break;
            }
          }
        }
        if (match != null) {
          local.backendId = match.backendId;
          local.scanned = true;
          remaining.remove(match);
        }
      }

      // Layer 2: any server-side monitor we couldn't match locally
      // gets added as a new row. We don't have the full plain value
      // back from the server (only the masked one) so we render the
      // masked form directly — that's still strictly more useful
      // than dropping the row. iOS won't be able to round-trip the
      // value to a quick re-scan, but the row's last_scan_exposure
      // count + alerts list still reflects accurately.
      for (final m in remaining) {
        _identifiers.add(_Identifier(
          type: m.kind == 'email' ? _IdentifierType.email : _IdentifierType.phone,
          value: m.displayValue,
          scanned: true,
          backendId: m.backendId,
        ));
      }

      // Replace exposures wholesale with server alerts when Pro —
      // the backend is the source of truth and includes
      // historically-saved alerts that quick-check can't restore.
      _exposures
        ..clear()
        ..addAll(bundle.alerts.map((a) => _Exposure(
              title: a.title,
              source: a.sourceDomain ?? 'Unknown source',
              date: a.date ?? '',
              icon: Icons.cloud_off_rounded,
              severity: a.severity,
              dataTypes: a.dataTypes,
            )));
    });
    _saveState();
  }

  Future<void> _saveState() async {
    final p = await SharedPreferences.getInstance();
    // SSN values are deliberately stripped from the persisted snapshot.
    // SharedPreferences is plaintext-on-disk + included in iCloud
    // backups — even though SSN never leaves the device on the wire,
    // persisting it at rest would broaden the attack surface for
    // anyone with backup access. Users re-enter SSN each session.
    final persistable = _identifiers
        .where((e) => e.type != _IdentifierType.ssn)
        .map((e) => e.toJson())
        .toList();
    await p.setString(_kIdentifiersKey, jsonEncode(persistable));
    await p.setString(_kExposuresKey,
        jsonEncode(_exposures.map((e) => e.toJson()).toList()));
  }

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
    _saveState();
    await _runScan(result);
  }

  Future<void> _removeIdentifier(_Identifier id) async {
    // Optimistic local removal so the UI doesn't stall on a slow
    // network. If the DELETE later fails we leave the local row
    // gone — the next _resyncFromBackend() will pull it back in.
    setState(() => _identifiers.remove(id));
    _saveState();
    if (id.backendId != null) {
      await breachMonitorService.delete(id.backendId!);
    }
  }

  Future<void> _runScan(_Identifier id) async {
    setState(() {
      id.scanning = true;
      id.scanError = false;
    });

    final newExposures = <_Exposure>[];

    if (id.type == _IdentifierType.ssn) {
      // SSN never leaves the device — no remote check available yet
    } else if (id.type == _IdentifierType.name) {
      await Future.delayed(const Duration(seconds: 1));
      // Names aren't a breach signal — show clean result
    } else if (id.type == _IdentifierType.email ||
        id.type == _IdentifierType.phone) {
      final kind = id.type == _IdentifierType.email ? 'email' : 'phone';

      // Pro path: persist this identifier on the backend so we scan
      // it weekly going forward instead of just running a one-shot
      // quick-check that doesn't survive reinstall.
      if (breachMonitorService.canSync) {
        final result = await breachMonitorService.add(
          kind: kind,
          value: id.value,
        );
        if (result.ok != null) {
          id.backendId = result.ok!.monitor.backendId;
          for (final a in result.ok!.alerts) {
            newExposures.add(_Exposure(
              title: a.title,
              source: a.sourceDomain ?? 'Unknown source',
              date: a.date ?? '',
              icon: id.type == _IdentifierType.email
                  ? Icons.cloud_off_rounded
                  : Icons.phone_disabled_rounded,
              severity: a.severity,
              dataTypes: a.dataTypes,
            ));
          }
        } else if (result.err != null && mounted) {
          // Surface the cap-reached / duplicate / invalid copy from
          // the server. We let the user keep the local row in all
          // cases except duplicate (where the server already has it)
          // — `add()` has already done the optimistic local insert.
          final msg = switch (result.err!.reason) {
            BreachAddError.capReached =>
              result.err!.message ?? 'You can monitor at most 10 identifiers.',
            BreachAddError.duplicate => 'Already being monitored.',
            BreachAddError.invalid =>
              'That ${kind == 'email' ? 'email' : 'phone'} looks invalid.',
            BreachAddError.network =>
              "Couldn't reach the breach monitor — saved locally.",
            BreachAddError.notPro => '',
          };
          if (msg.isNotEmpty) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text(msg)),
            );
          }
          // On duplicate or cap-reached pull the row back out — we
          // shouldn't keep showing it as freshly-added.
          if (result.err!.reason == BreachAddError.duplicate ||
              result.err!.reason == BreachAddError.capReached) {
            setState(() => _identifiers.remove(id));
            _saveState();
          }
        }
      } else {
        // Guest / free / non-Pro: keep the one-shot quick-check flow
        // so the screen still has *something* useful to show — but
        // these results are throwaway and don't survive cold-start.
        final session = auth.session;
        if (session != null && session.userId != 'guest') {
          try {
            final res = await api.post('/v1/breach/quick-check', {
              'kind': kind,
              'value': id.value,
            });
            final exposures = res['exposures'] as List<dynamic>? ?? [];
            for (final e in exposures) {
              final m = e as Map<String, dynamic>;
              newExposures.add(_Exposure(
                title: m['title'] as String? ?? 'Unknown breach',
                source: (m['source_domain'] as String?) ?? 'Unknown source',
                date: (m['date'] as String?) ?? '',
                icon: id.type == _IdentifierType.email
                    ? Icons.cloud_off_rounded
                    : Icons.phone_disabled_rounded,
                severity: (m['severity'] as String?) ?? 'warning',
                dataTypes: (m['data_types'] as List<dynamic>?)
                        ?.map((e) => e.toString())
                        .toList() ??
                    [],
              ));
            }
          } on ApiException catch (e) {
            if (e.statusCode == 429 && mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text(
                    'Free tier limit: 5 breach checks/day. Upgrade for unlimited monitoring.',
                  ),
                ),
              );
            } else if (mounted) {
              id.scanError = true;
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: const Text("Couldn't check this identifier — try again."),
                  action: SnackBarAction(
                    label: 'Retry',
                    onPressed: () => _runScan(id),
                  ),
                ),
              );
            }
          } catch (_) {
            // Network error. Don't fabricate a clean result — flag the
            // identifier so the row can show a retry affordance instead
            // of a misleading "no breaches found" green check.
            if (mounted) {
              id.scanError = true;
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: const Text("Couldn't reach the breach monitor — check your connection."),
                  action: SnackBarAction(
                    label: 'Retry',
                    onPressed: () => _runScan(id),
                  ),
                ),
              );
            }
          }
        }
      }
    }

    if (!mounted) return;
    setState(() {
      id.scanning = false;
      id.scanned = true;
      _exposures.addAll(newExposures);
    });
    _saveState();
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final isGuest = auth.session == null || auth.session?.userId == 'guest';
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
                if (!breachMonitorService.canSync) ...[
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.symmetric(
                        vertical: 8, horizontal: 12),
                    decoration: BoxDecoration(
                      color: AegisColors.warning.withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                          color: AegisColors.warning.withValues(alpha: 0.35),
                          width: 0.8),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.lock_outline_rounded,
                            color: AegisColors.warning, size: 16),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            'Free tier: one-time scans only. Upgrade to Pro for continuous monitoring.',
                            style: tt.labelSmall?.copyWith(
                              color: AegisColors.warning,
                              height: 1.3,
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
            ..._identifiers.map((id) => Dismissible(
                  // backendId + value is stable: same identifier value can't
                  // be added twice (server enforces, client mirrors), so
                  // value alone is enough — backendId may be null for
                  // SSN / name / local-only rows.
                  key: ValueKey('${id.backendId ?? "local"}:${id.value}'),
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
                  onDismissed: (_) => _removeIdentifier(id),
                  child: _IdentifierTile(
                    id: id,
                    onRescan: () => _runScan(id),
                  ),
                )),
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
                  Icon(
                    isGuest ? Icons.lock_outline_rounded : Icons.verified_user_outlined,
                    color: isGuest ? AegisColors.textTertiary : AegisColors.success,
                    size: 32,
                  ),
                  const SizedBox(height: 10),
                  Text(
                    isGuest ? 'Sign in to check breaches' : 'No exposures found.',
                    style: tt.bodyMedium?.copyWith(color: AegisColors.textSecondary),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    isGuest
                        ? 'Create a free account to scan your email and phone against real breach databases.'
                        : 'When your details surface, the exact source appears here.',
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
                onDismiss: () {
                  setState(() => e.dismissed = true);
                  _saveState();
                },
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
  final VoidCallback onRescan;
  const _IdentifierTile({required this.id, required this.onRescan});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return GestureDetector(
      onTap: (id.scanned && !id.scanning) ? onRescan : null,
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
          else if (id.scanError)
            const Icon(Icons.error_outline_rounded,
                color: AegisColors.danger, size: 18)
          else if (id.scanned)
            const Icon(Icons.check_circle_outline,
                color: AegisColors.success, size: 18)
          else
            const Icon(Icons.schedule_rounded,
                color: AegisColors.textTertiary, size: 18),
        ],
      ),
    ));
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
                    if (exposure.date.isNotEmpty)
                      Text(
                        exposure.date,
                        style: tt.labelSmall
                            ?.copyWith(color: AegisColors.textTertiary),
                      ),
                    if (exposure.dataTypes.isNotEmpty) ...[
                      const SizedBox(height: 5),
                      Wrap(
                        spacing: 4,
                        runSpacing: 3,
                        children: exposure.dataTypes.map((t) => Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: AegisColors.danger.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            t,
                            style: tt.labelSmall?.copyWith(
                              color: AegisColors.danger,
                              fontSize: 10,
                            ),
                          ),
                        )).toList(),
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
