import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import '../theme/app_theme.dart';
import '../services/call_screener_service.dart';

class CallScreenerScreen extends StatefulWidget {
  const CallScreenerScreen({super.key});

  @override
  State<CallScreenerScreen> createState() => _CallScreenerScreenState();
}

class _CallScreenerScreenState extends State<CallScreenerScreen> {
  ScreenerStatus? _status;
  List<ScreenedCall> _history = [];
  bool _loading = true;
  bool _provisioning = false;

  @override
  void initState() {
    super.initState();
    _loadStatus();
  }

  Future<void> _loadStatus() async {
    setState(() => _loading = true);
    final status = await callScreener.getStatus();
    final history = await callScreener.getHistory();
    if (mounted) {
      setState(() {
        _status = status;
        _history = history;
        _loading = false;
      });
    }
  }

  Future<void> _provision() async {
    setState(() => _provisioning = true);
    final result = await callScreener.provision();
    if (result != null && mounted) {
      // Show setup instructions
      await _showSetupSheet(result);
      await _loadStatus();
    } else if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Failed to provision number. Check your subscription.')),
      );
    }
    if (mounted) setState(() => _provisioning = false);
  }

  Future<void> _showSetupSheet(ScreenerProvisionResult result) async {
    await showModalBottomSheet(
      context: context,
      backgroundColor: AegisColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => _SetupSheet(result: result),
    );
  }

  Future<void> _showExistingSetup() async {
    if (_status == null || !_status!.active) return;
    final result = ScreenerProvisionResult(
      phone: _status!.phone ?? '',
      provisioned: true,
      setupCodes: _status!.setupCodes ?? {},
      instructions: [],
    );
    await _showSetupSheet(result);
  }

  Future<void> _release() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AegisColors.surface,
        title: const Text('Disable Call Screener?'),
        content: const Text(
          'This will release your screener number and stop screening calls. '
          'You\'ll need to dial ##004# to disable call forwarding on your phone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Disable', style: TextStyle(color: AegisColors.danger)),
          ),
        ],
      ),
    );
    if (confirm == true) {
      await callScreener.release();
      if (mounted) await _loadStatus();
    }
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final isActive = _status?.active == true;

    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(
        title: Text(
          'CALL SCREENER',
          style: tt.labelMedium?.copyWith(
            color: AegisColors.turquoise,
            letterSpacing: 2.5,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AegisColors.turquoise))
          : RefreshIndicator(
              onRefresh: _loadStatus,
              child: ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  // Status card
                  _StatusCard(
                    active: isActive,
                    phone: _status?.phone,
                    totalCalls: _status?.totalCalls ?? 0,
                    blockedCalls: _status?.blockedCalls ?? 0,
                    passedCalls: _status?.passedCalls ?? 0,
                  ),
                  const SizedBox(height: 16),

                  // Action button
                  if (!isActive)
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton.icon(
                        onPressed: _provisioning ? null : _provision,
                        icon: _provisioning
                            ? const SizedBox(
                                width: 18, height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2, color: Colors.black,
                                ),
                              )
                            : const Icon(Icons.shield_rounded, size: 20),
                        label: Text(_provisioning ? 'Setting up...' : 'Enable Call Screener'),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AegisColors.turquoise,
                          foregroundColor: Colors.black,
                          minimumSize: const Size.fromHeight(52),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(14),
                          ),
                        ),
                      ),
                    )
                  else ...[
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: _showExistingSetup,
                            icon: const Icon(Icons.settings_phone_rounded, size: 16),
                            label: const Text('Setup guide'),
                            style: OutlinedButton.styleFrom(
                              foregroundColor: AegisColors.turquoise,
                              side: const BorderSide(color: AegisColors.turquoise, width: 0.8),
                              padding: const EdgeInsets.symmetric(vertical: 12),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: _release,
                            icon: const Icon(Icons.power_settings_new_rounded, size: 16),
                            label: const Text('Disable'),
                            style: OutlinedButton.styleFrom(
                              foregroundColor: AegisColors.danger,
                              side: const BorderSide(color: AegisColors.danger, width: 0.8),
                              padding: const EdgeInsets.symmetric(vertical: 12),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                  const SizedBox(height: 24),

                  // How it works
                  if (!isActive) ...[
                    _HowItWorksCard(),
                    const SizedBox(height: 24),
                  ],

                  // History
                  Text(
                    'SCREENED CALLS',
                    style: tt.labelSmall?.copyWith(
                      color: AegisColors.textTertiary,
                      letterSpacing: 1.6,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 10),
                  if (_history.isEmpty)
                    Container(
                      padding: const EdgeInsets.all(20),
                      decoration: BoxDecoration(
                        color: AegisColors.surface.withValues(alpha: 0.55),
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: AegisColors.border, width: 0.6),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.phone_forwarded_rounded,
                              color: AegisColors.textTertiary, size: 20),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              isActive
                                  ? 'No calls screened yet. When someone calls and you don\'t answer, the AI will screen them.'
                                  : 'Enable Call Screener to start screening unknown callers.',
                              style: tt.bodySmall?.copyWith(
                                color: AegisColors.textTertiary,
                                height: 1.4,
                              ),
                            ),
                          ),
                        ],
                      ),
                    )
                  else
                    ..._history.map((call) => _CallTile(call: call)),

                  const SizedBox(height: 20),
                  // Privacy note
                  Row(
                    children: [
                      const Icon(Icons.lock_outline_rounded,
                          size: 14, color: AegisColors.textTertiary),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          'Caller transcripts are encrypted. Only verdicts and summaries are visible.',
                          style: tt.labelSmall?.copyWith(
                            color: AegisColors.textTertiary,
                            height: 1.4,
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
    );
  }
}

// ── Status Card ──────────────────────────────────────────────────────────

class _StatusCard extends StatelessWidget {
  final bool active;
  final String? phone;
  final int totalCalls;
  final int blockedCalls;
  final int passedCalls;

  const _StatusCard({
    required this.active,
    this.phone,
    required this.totalCalls,
    required this.blockedCalls,
    required this.passedCalls,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: active
              ? AegisColors.success.withValues(alpha: 0.5)
              : AegisColors.border,
          width: active ? 1.2 : 0.6,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: (active ? AegisColors.success : AegisColors.turquoise)
                      .withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(
                  active ? Icons.verified_user_rounded : Icons.phone_forwarded_rounded,
                  color: active ? AegisColors.success : AegisColors.turquoise,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      active ? 'Screening active' : 'Call Screener',
                      style: tt.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      active
                          ? 'AI answers calls you miss and blocks scams'
                          : 'Screen unknown callers with AI before they reach you',
                      style: tt.bodySmall?.copyWith(
                        color: AegisColors.textTertiary,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (active && phone != null) ...[
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
              decoration: BoxDecoration(
                color: AegisColors.surfaceElevated,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                children: [
                  const Icon(Icons.phone_rounded,
                      size: 14, color: AegisColors.turquoise),
                  const SizedBox(width: 8),
                  Text(
                    phone!,
                    style: tt.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                      fontFamily: 'monospace',
                    ),
                  ),
                  const Spacer(),
                  GestureDetector(
                    onTap: () {
                      Clipboard.setData(ClipboardData(text: phone!));
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Number copied')),
                      );
                    },
                    child: const Icon(Icons.copy_rounded,
                        size: 16, color: AegisColors.textTertiary),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                _StatChip(
                  label: 'Screened',
                  value: '$totalCalls',
                  color: AegisColors.turquoise,
                ),
                const SizedBox(width: 8),
                _StatChip(
                  label: 'Blocked',
                  value: '$blockedCalls',
                  color: AegisColors.danger,
                ),
                const SizedBox(width: 8),
                _StatChip(
                  label: 'Passed',
                  value: '$passedCalls',
                  color: AegisColors.success,
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _StatChip extends StatelessWidget {
  final String label;
  final String value;
  final Color color;
  const _StatChip({required this.label, required this.value, required this.color});

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Column(
          children: [
            Text(
              value,
              style: TextStyle(
                color: color,
                fontSize: 18,
                fontWeight: FontWeight.w800,
              ),
            ),
            Text(
              label,
              style: TextStyle(
                color: color.withValues(alpha: 0.7),
                fontSize: 10,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── How It Works Card ────────────────────────────────────────────────────

class _HowItWorksCard extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    const steps = [
      (Icons.phone_forwarded_rounded, 'We give you a screener number'),
      (Icons.dialpad_rounded, 'You set up call forwarding with a quick dial code'),
      (Icons.smart_toy_rounded, 'AI answers calls you miss and asks who\'s calling'),
      (Icons.block_rounded, 'Scam calls get blocked. Legit calls get forwarded to you.'),
    ];
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'HOW IT WORKS',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.4,
              fontWeight: FontWeight.w600,
              fontSize: 10,
            ),
          ),
          const SizedBox(height: 12),
          for (int i = 0; i < steps.length; i++)
            Padding(
              padding: EdgeInsets.only(bottom: i < steps.length - 1 ? 12 : 0),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 28,
                    height: 28,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: AegisColors.turquoise.withValues(alpha: 0.12),
                    ),
                    child: Icon(steps[i].$1, size: 14, color: AegisColors.turquoise),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        steps[i].$2,
                        style: tt.bodySmall?.copyWith(
                          color: AegisColors.textSecondary,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

// ── Setup Sheet ──────────────────────────────────────────────────────────

class _SetupSheet extends StatelessWidget {
  final ScreenerProvisionResult result;
  const _SetupSheet({required this.result});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final codes = result.setupCodes;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 20, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 36, height: 4,
              decoration: BoxDecoration(
                color: AegisColors.textTertiary.withValues(alpha: 0.3),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            const SizedBox(height: 20),
            const Icon(Icons.phone_forwarded_rounded,
                color: AegisColors.turquoise, size: 36),
            const SizedBox(height: 12),
            Text(
              'Set up call forwarding',
              style: tt.titleMedium?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            Text(
              'Open your Phone app and dial each code below. '
              'Each one should show a confirmation message.',
              textAlign: TextAlign.center,
              style: tt.bodySmall?.copyWith(
                color: AegisColors.textSecondary, height: 1.5,
              ),
            ),
            const SizedBox(height: 20),

            if (codes.containsKey('forwardUnanswered'))
              _SetupCodeTile(
                label: 'Forward unanswered calls',
                code: codes['forwardUnanswered']!,
                icon: Icons.phone_missed_rounded,
              ),
            const SizedBox(height: 8),
            if (codes.containsKey('forwardBusy'))
              _SetupCodeTile(
                label: 'Forward when busy',
                code: codes['forwardBusy']!,
                icon: Icons.phone_locked_rounded,
              ),
            const SizedBox(height: 8),
            if (codes.containsKey('forwardUnreachable'))
              _SetupCodeTile(
                label: 'Forward when unreachable',
                code: codes['forwardUnreachable']!,
                icon: Icons.signal_cellular_off_rounded,
              ),

            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: () => Navigator.pop(context),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AegisColors.turquoise,
                  foregroundColor: Colors.black,
                  minimumSize: const Size.fromHeight(48),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
                child: const Text("I've set up forwarding"),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SetupCodeTile extends StatelessWidget {
  final String label;
  final String code;
  final IconData icon;
  const _SetupCodeTile({
    required this.label,
    required this.code,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
      decoration: BoxDecoration(
        color: AegisColors.surfaceElevated,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Row(
        children: [
          Icon(icon, size: 18, color: AegisColors.turquoise),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label,
                    style: tt.labelSmall?.copyWith(
                        color: AegisColors.textTertiary, fontSize: 10)),
                const SizedBox(height: 2),
                Text(
                  code,
                  style: tt.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                    fontFamily: 'monospace',
                    letterSpacing: 1.2,
                  ),
                ),
              ],
            ),
          ),
          GestureDetector(
            onTap: () async {
              // Open Phone app with the dial code
              final uri = Uri(scheme: 'tel', path: code);
              if (await canLaunchUrl(uri)) {
                await launchUrl(uri);
              } else {
                if (context.mounted) {
                  Clipboard.setData(ClipboardData(text: code));
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text('Copied: $code')),
                  );
                }
              }
            },
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: AegisColors.turquoise.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Text(
                'Dial',
                style: TextStyle(
                  color: AegisColors.turquoise,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Call History Tile ─────────────────────────────────────────────────────

class _CallTile extends StatelessWidget {
  final ScreenedCall call;
  const _CallTile({required this.call});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final isScam = call.verdict == 'scam';
    final isSafe = call.verdict == 'safe';
    final accent = isScam
        ? AegisColors.danger
        : isSafe
            ? AegisColors.success
            : AegisColors.warning;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: accent.withValues(alpha: 0.3),
          width: 0.6,
        ),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: accent.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(
              isScam
                  ? Icons.block_rounded
                  : isSafe
                      ? Icons.check_circle_rounded
                      : Icons.help_outline_rounded,
              color: accent,
              size: 18,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  call.callerName ?? call.fromE164,
                  style: tt.bodySmall?.copyWith(fontWeight: FontWeight.w600),
                ),
                if (call.summary != null)
                  Text(
                    call.summary!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: tt.labelSmall?.copyWith(
                      color: AegisColors.textTertiary,
                      height: 1.3,
                    ),
                  ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  isScam
                      ? 'BLOCKED'
                      : isSafe
                          ? call.forwarded ? 'FORWARDED' : 'SAFE'
                          : 'UNKNOWN',
                  style: TextStyle(
                    color: accent,
                    fontSize: 9,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.6,
                  ),
                ),
              ),
              if (call.riskScore != null) ...[
                const SizedBox(height: 4),
                Text(
                  '${call.riskScore}%',
                  style: TextStyle(
                    color: accent,
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}
