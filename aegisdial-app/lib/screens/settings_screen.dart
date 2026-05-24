import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import '../config/app_config.dart';
import '../services/auth_service.dart';
import '../services/api_service.dart';
import '../services/app_version.dart';
import '../services/device_service.dart';
import 'welcome_screen.dart';
import 'family_alert_privacy_screen.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  // Push diagnostic — surfaces the APNs registration chain so we can
  // tell whether silent pushes are because (a) user declined permission,
  // (b) iOS never handed us a token (entitlement / network issue), or
  // (c) backend's /v1/device/register rejected the POST. Without this
  // every "I'm not getting alerts" report is unfalsifiable.
  void _showPushDiagnostic(BuildContext context) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AegisColors.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: const Text('Push diagnostic'),
        content: SizedBox(
          width: 320,
          child: FutureBuilder<PushDiagnostic>(
            future: deviceService.snapshot(),
            builder: (c, snap) {
              if (snap.connectionState != ConnectionState.done) {
                return const SizedBox(
                  height: 60,
                  child: Center(child: CircularProgressIndicator()),
                );
              }
              final d = snap.data ??
                  const PushDiagnostic(); // empty = nothing recorded yet
              final dotColor = d.healthy
                  ? AegisColors.success
                  : (d.lastApnsError != null || d.lastRegisterError != null)
                      ? AegisColors.danger
                      : AegisColors.warning;
              final summary = d.healthy
                  ? 'Push notifications are wired end-to-end.'
                  : d.permissionGranted == false
                      ? 'You declined notifications. Tap "Retry" after enabling them in iOS Settings → AegisDial → Notifications.'
                      : d.lastApnsError != null
                          ? 'iOS reported an APNs error. The backend can\'t reach this device for alerts.'
                          : d.lastRegisterError != null
                              ? 'iOS gave us a token but the backend rejected it. Push will retry on next app launch.'
                              : 'No push activity yet on this install. Tap "Retry" to register now.';
              return Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: dotColor,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          summary,
                          style: const TextStyle(
                            color: AegisColors.textSecondary,
                            height: 1.4,
                            fontSize: 13,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  _diagRow('Permission', _yesNoMaybe(d.permissionGranted)),
                  _diagRow('iOS token', d.lastTokenPreview ?? '—'),
                  _diagRow(
                    'Registered with backend',
                    d.lastRegisteredAt != null
                        ? _humanTimeAgo(d.lastRegisteredAt!)
                        : '—',
                  ),
                  if (d.lastApnsError != null)
                    _diagRow('APNs error', d.lastApnsError!,
                        valueColor: AegisColors.danger),
                  if (d.lastRegisterError != null)
                    _diagRow('Backend error', d.lastRegisterError!,
                        valueColor: AegisColors.danger),
                ],
              );
            },
          ),
        ),
        actions: [
          TextButton(
            onPressed: () async {
              Navigator.of(ctx).pop();
              await deviceService.ensureRegistered();
              if (context.mounted) _showPushDiagnostic(context);
            },
            child: const Text(
              'Retry',
              style: TextStyle(color: AegisColors.turquoise),
            ),
          ),
          ElevatedButton(
            onPressed: () => Navigator.of(ctx).pop(),
            style: ElevatedButton.styleFrom(
              minimumSize: const Size(0, 44),
              backgroundColor: AegisColors.turquoise,
              foregroundColor: Colors.black,
            ),
            child: const Text('Got it'),
          ),
        ],
      ),
    );
  }

  Widget _diagRow(String label, String value, {Color? valueColor}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 110,
            child: Text(
              label,
              style: const TextStyle(
                color: AegisColors.textTertiary,
                fontSize: 12,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                color: valueColor ?? AegisColors.textPrimary,
                fontSize: 12,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _yesNoMaybe(bool? v) {
    if (v == null) return 'unknown';
    return v ? 'granted' : 'declined';
  }

  String _humanTimeAgo(DateTime when) {
    final diff = DateTime.now().difference(when);
    if (diff.inMinutes < 1) return 'just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes} min ago';
    if (diff.inHours < 24) return '${diff.inHours} hr ago';
    return '${diff.inDays} day${diff.inDays == 1 ? '' : 's'} ago';
  }

  // Opens the system mail composer pre-addressed to support, with the
  // app version pre-filled in the body so triage starts with the build
  // number instead of asking for it. Until aegisdial.com is registered
  // the message bounces — but the composer still opens, and a copyable
  // address dialog is the fallback when no mail client is configured.
  Future<void> _emailSupport(BuildContext context) async {
    final body = Uri.encodeComponent(
      '\n\n— — —\nApp: AegisDial ${AppVersion.current.short}\n'
      '(written above this line so support has the build number)',
    );
    final subject = Uri.encodeComponent(kSupportEmailSubject);
    final uri = Uri.parse('mailto:$kSupportEmail?subject=$subject&body=$body');
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
    } else if (context.mounted) {
      // No mail client — show the address so the user can copy it.
      _showInfo(
        context,
        'Email support',
        'No mail app is set up on this device.\n\nReach us at:\n$kSupportEmail\n\nWe respond within 24 hours.',
      );
    }
  }

  void _showInfo(BuildContext context, String title, String body) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AegisColors.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: Text(title),
        content: Text(
          body,
          style: const TextStyle(
            color: AegisColors.textSecondary,
            height: 1.5,
          ),
        ),
        actions: [
          ElevatedButton(
            onPressed: () => Navigator.of(ctx).pop(),
            style: ElevatedButton.styleFrom(
              minimumSize: const Size(0, 44),
              backgroundColor: AegisColors.turquoise,
              foregroundColor: Colors.black,
            ),
            child: const Text('Got it'),
          ),
        ],
      ),
    );
  }

  void _showProfileEdit(BuildContext context) {
    final session = auth.session;
    if (session == null) return;
    final ctrl = TextEditingController(text: session.displayName ?? '');
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AegisColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (sheetCtx) {
        bool saving = false;
        return StatefulBuilder(builder: (innerCtx, setSheet) {
          return Padding(
            padding: EdgeInsets.fromLTRB(
              20, 20, 20,
              20 + MediaQuery.of(innerCtx).viewInsets.bottom,
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
                const SizedBox(height: 16),
                Text(
                  'Your profile',
                  style: Theme.of(innerCtx).textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                ),
                const SizedBox(height: 6),
                Text(
                  session.email ?? (session.userId == 'guest'
                      ? 'Guest session — sign in to keep this name across devices'
                      : 'Apple sign-in'),
                  style: Theme.of(innerCtx).textTheme.bodySmall?.copyWith(
                        color: AegisColors.textTertiary,
                      ),
                ),
                const SizedBox(height: 20),
                TextField(
                  controller: ctrl,
                  textCapitalization: TextCapitalization.words,
                  maxLength: 120,
                  enabled: !saving,
                  decoration: const InputDecoration(
                    labelText: 'Display name',
                    border: OutlineInputBorder(),
                    helperText:
                        'Shown in recovery chat + family alerts. Leave blank to clear.',
                  ),
                ),
                const SizedBox(height: 8),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: saving
                        ? null
                        : () async {
                            setSheet(() => saving = true);
                            try {
                              await auth.updateProfile(
                                displayName: ctrl.text,
                              );
                              if (!innerCtx.mounted) return;
                              Navigator.of(innerCtx).pop();
                            } catch (e) {
                              setSheet(() => saving = false);
                              if (!innerCtx.mounted) return;
                              ScaffoldMessenger.of(innerCtx).showSnackBar(
                                SnackBar(
                                  content: Text(
                                    e is ApiException
                                        ? 'Save failed: ${e.message}'
                                        : 'Save failed. Check your connection.',
                                  ),
                                ),
                              );
                            }
                          },
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AegisColors.turquoise,
                      foregroundColor: Colors.black,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: saving
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.black,
                            ),
                          )
                        : const Text(
                            'Save',
                            style: TextStyle(
                              fontWeight: FontWeight.w700,
                              fontSize: 15,
                            ),
                          ),
                  ),
                ),
              ],
            ),
          );
        });
      },
    );
  }

  void _showBilling(BuildContext context) {
    showModalBottomSheet(
      context: context,
      backgroundColor: AegisColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => const _BillingSheet(),
    );
  }

  void _showDeleteConfirm(BuildContext context) {
    final isGuest = auth.session?.userId == 'guest';
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AegisColors.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: const Text('Delete account?'),
        content: Text(
          isGuest
              ? 'This clears your guest session and local data on this device.'
              : 'This permanently deletes your account on our servers, including all breach monitors, family lines, recovery chat history, and subscription records. This cannot be undone.',
          style: const TextStyle(
            color: AegisColors.textSecondary,
            height: 1.5,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () async {
              Navigator.of(ctx).pop();
              // Optimistic UX: show a blocking spinner while the cascade
              // delete runs server-side. On the dashboard build it takes
              // ~200ms; if the user is offline or the backend is down,
              // we surface the error instead of silently signing them
              // out with the row still alive.
              showDialog(
                context: context,
                barrierDismissible: false,
                builder: (_) => const Center(
                  child: CircularProgressIndicator(
                    color: AegisColors.danger,
                  ),
                ),
              );
              try {
                await auth.deleteAccount();
                if (!context.mounted) return;
                Navigator.of(context).pop(); // spinner
                Navigator.of(context).pushAndRemoveUntil(
                  MaterialPageRoute(builder: (_) => const WelcomeScreen()),
                  (_) => false,
                );
              } catch (e) {
                if (!context.mounted) return;
                Navigator.of(context).pop(); // spinner
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(
                      e is ApiException
                          ? 'Delete failed: ${e.message} (try again in a moment)'
                          : 'Delete failed. Check your connection and try again.',
                    ),
                    duration: const Duration(seconds: 5),
                  ),
                );
              }
            },
            style: ElevatedButton.styleFrom(
              minimumSize: const Size(0, 44),
              backgroundColor: AegisColors.danger,
              foregroundColor: Colors.white,
            ),
            child: const Text('Delete permanently'),
          ),
        ],
      ),
    );
  }

  void _showHelp(BuildContext context) {
    showModalBottomSheet(
      context: context,
      backgroundColor: AegisColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.55,
        builder: (_, ctrl) => ListView(
          controller: ctrl,
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 36),
          children: [
            Text(
              'Help Center',
              style: Theme.of(context)
                  .textTheme
                  .titleLarge
                  ?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 16),
            ...[
              ('How does Live Shield work?',
                  'Open Live Shield when you get a suspicious call. AegisDial transcribes the conversation in chunks, matches it against scam patterns (regex on the free tier; AI coaching on Pro), and surfaces a counter-script to steer the call away from the scam.'),
              ('What is the recovery chatbot?',
                  'The recovery companion walks you through the first 60 minutes after a scam — contacting your bank, filing FTC / IC3 reports, freezing credit, and more.'),
              ('What does the SMS Filter scan?',
                  'Paste any text message into the SMS Filter screen and AegisDial scans it for phishing links, package-redelivery scams, fake bank alerts, and more. iOS does not allow third-party apps to read inbound SMS automatically, so scanning is paste-driven.'),
              ('How do I add family members?',
                  'Go to the Family tab and tap "Add a family member." Pro covers up to 3 lines.'),
              ('How do I contact support?',
                  'Email us at $kSupportEmail. We respond within 24 hours.'),
              ('Notifications not arriving?',
                  'Tap "Push diagnostic" further up this screen to see whether iOS permission, the APNs token, and backend registration are all green. Most missing pushes are because iOS permission was declined during onboarding — re-enable it under iOS Settings → AegisDial → Notifications, then return here and tap Push diagnostic → "Retry registration."'),
            ].map(
              (faq) => Container(
                margin: const EdgeInsets.only(bottom: 10),
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: AegisColors.surfaceElevated,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      faq.$1,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      faq.$2,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: AegisColors.textSecondary,
                            height: 1.45,
                          ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
        children: [
          ListenableBuilder(
            listenable: auth,
            builder: (context, _) {
              final session = auth.session;
              final name = session?.displayName ??
                  (session?.userId == 'guest' ? 'Guest' : 'Your Account');
              final initial = name.isNotEmpty ? name[0].toUpperCase() : '?';
              final isGuest = session?.userId == 'guest';
              final email = session?.email;
              return GlassCard(
                onTap: () => _showProfileEdit(context),
                child: Row(
                  children: [
                    Container(
                      width: 56,
                      height: 56,
                      decoration: const BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: AegisColors.heroGradient,
                      ),
                      alignment: Alignment.center,
                      child: Text(
                        initial,
                        style: const TextStyle(
                          color: Colors.black,
                          fontSize: 22,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            name,
                            style: tt.titleLarge?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          if (email != null && email.isNotEmpty)
                            Text(
                              email,
                              style: tt.bodySmall?.copyWith(
                                color: AegisColors.textSecondary,
                              ),
                            )
                          else
                            Text(
                              isGuest ? 'Guest session' : 'Tap to manage profile',
                              style: tt.bodySmall?.copyWith(
                                color: AegisColors.textTertiary,
                              ),
                            ),
                        ],
                      ),
                    ),
                    const Icon(
                      Icons.chevron_right_rounded,
                      color: AegisColors.textTertiary,
                    ),
                  ],
                ),
              );
            },
          ),
          const SizedBox(height: 20),
          _SectionLabel('SUBSCRIPTION'),
          Builder(builder: (context) {
            // Backend tier vocab: 'pending' | 'pro' | 'expired' |
            // 'cancelled' | 'guest' | 'free'. We don't yet receive
            // monthly-vs-annual or Recovery Concierge specifically, so
            // the trailing text says "Active" instead of a stale price.
            final tier = auth.session?.tier ?? 'free';
            final (label, trailing, body) = switch (tier) {
              'pro' || 'in_grace' => (
                  'AegisDial Pro',
                  'Active',
                  'You\'re on Pro. Manage or cancel via App Store → Account → Subscriptions.',
                ),
              'expired' => (
                  'AegisDial Pro',
                  'Expired',
                  'Your Pro subscription has expired. Renew on the paywall to restore protection.',
                ),
              'cancelled' => (
                  'AegisDial Pro',
                  'Cancelled',
                  'You\'ve cancelled — coverage continues until the current period ends.',
                ),
              'guest' => (
                  'Free trial',
                  'Trial',
                  'You\'re using a guest session. Sign in to start your 7-day free trial.',
                ),
              _ => (
                  'Free trial',
                  '7 days free',
                  'You\'re on the free trial. Upgrade anytime to keep your protection active.',
                ),
            };
            return _SettingsTile(
              icon: Icons.workspace_premium_outlined,
              title: label,
              trailing: trailing,
              onTap: () => _showInfo(context, label, body),
            );
          }),
          _SettingsTile(
            icon: Icons.receipt_long_outlined,
            title: 'Billing history',
            onTap: () => _showBilling(context),
          ),
          const SizedBox(height: 16),
          _SectionLabel('PRIVACY & DATA'),
          _SettingsTile(
            icon: Icons.lock_outline,
            title: 'On-device only',
            trailing: 'Always-on',
            onTap: () => _showInfo(
              context,
              'On-device processing',
              'Every call transcript and SMS scan runs entirely on your iPhone. AegisDial never uploads your conversations, transcripts, or message content to any server. Only anonymized fraud verdicts are synced.',
            ),
          ),
          _SettingsTile(
            icon: Icons.shield_outlined,
            title: 'Family alert privacy',
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => const FamilyAlertPrivacyScreen(),
              ),
            ),
          ),
          _SettingsTile(
            icon: Icons.logout_rounded,
            title: 'Sign out',
            onTap: () async {
              final ok = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  backgroundColor: AegisColors.surface,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(18)),
                  title: const Text('Sign out?'),
                  content: const Text(
                    'You\'ll need to sign in again to access your protected data.',
                    style: TextStyle(
                        color: AegisColors.textSecondary, height: 1.5),
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.of(ctx).pop(false),
                      child: const Text('Cancel'),
                    ),
                    ElevatedButton(
                      onPressed: () => Navigator.of(ctx).pop(true),
                      style: ElevatedButton.styleFrom(
                        minimumSize: const Size(0, 44),
                        backgroundColor: AegisColors.turquoise,
                        foregroundColor: Colors.black,
                      ),
                      child: const Text('Sign out'),
                    ),
                  ],
                ),
              );
              if (ok == true && context.mounted) {
                await auth.signOut();
                if (!context.mounted) return;
                Navigator.of(context).pushAndRemoveUntil(
                  MaterialPageRoute(builder: (_) => const WelcomeScreen()),
                  (_) => false,
                );
              }
            },
          ),
          _SettingsTile(
            icon: Icons.delete_outline,
            title: 'Delete my account',
            destructive: true,
            onTap: () => _showDeleteConfirm(context),
          ),
          const SizedBox(height: 16),
          _SectionLabel('SUPPORT'),
          _SettingsTile(
            icon: Icons.help_outline,
            title: 'Help center',
            onTap: () => _showHelp(context),
          ),
          _SettingsTile(
            icon: Icons.mail_outline_rounded,
            title: 'Email support',
            onTap: () => _emailSupport(context),
          ),
          _SettingsTile(
            icon: Icons.notifications_active_outlined,
            title: 'Push diagnostic',
            onTap: () => _showPushDiagnostic(context),
          ),
          _SettingsTile(
            icon: Icons.info_outline,
            title: 'About AegisDial',
            trailing: AppVersion.current.short,
            onTap: () => _showInfo(
              context,
              'About AegisDial',
              'AegisDial ${AppVersion.current.short}\n\nBuilt by 47 Industries.\n\nAegisDial helps you prevent phone scams with real-time AI call screening and recover from fraud with a guided companion.\n\nFor support: $kSupportEmail',
            ),
          ),
          const SizedBox(height: 24),
          Center(
            child: Text(
              'Built by 47 Industries',
              style: tt.labelSmall?.copyWith(
                color: AegisColors.textTertiary,
                letterSpacing: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 0, 0, 8),
      child: Text(
        text,
        style: const TextStyle(
          color: AegisColors.textTertiary,
          fontSize: 11,
          letterSpacing: 1.6,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _SettingsTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? trailing;
  final bool destructive;
  final VoidCallback? onTap;
  const _SettingsTile({
    required this.icon,
    required this.title,
    this.trailing,
    this.destructive = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 14),
            decoration: BoxDecoration(
              color: AegisColors.surface.withValues(alpha: 0.55),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AegisColors.border, width: 0.6),
            ),
            child: Row(
              children: [
                Icon(
                  icon,
                  size: 20,
                  color: destructive
                      ? AegisColors.danger
                      : AegisColors.textSecondary,
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Text(
                    title,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                      color: destructive
                          ? AegisColors.danger
                          : AegisColors.textPrimary,
                    ),
                  ),
                ),
                if (trailing != null) ...[
                  Text(
                    trailing!,
                    style: const TextStyle(
                      color: AegisColors.textTertiary,
                      fontSize: 13,
                    ),
                  ),
                  const SizedBox(width: 6),
                ],
                if (!destructive)
                  const Icon(
                    Icons.chevron_right_rounded,
                    color: AegisColors.textTertiary,
                    size: 18,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _BillingSheet extends StatefulWidget {
  const _BillingSheet();

  @override
  State<_BillingSheet> createState() => _BillingSheetState();
}

class _BillingSheetState extends State<_BillingSheet> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic>? _status;

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    final session = auth.session;
    if (session == null || session.userId == 'guest') {
      setState(() => _loading = false);
      return;
    }
    try {
      final res = await api.get('/subscription/status');
      if (!mounted) return;
      setState(() {
        _status = res;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  /// Map App Store product_id → display name + cadence label.
  /// Falls back to a generic "AegisDial Pro" if the id isn't in the
  /// catalog (e.g. legacy SKU from before the bundle ID rename).
  (String name, String cadence) _displayForProduct(String? productId) {
    switch (productId) {
      case 'com.aegisdial.app.pro.monthly':
        return ('AegisDial Pro Monthly', '\$49.99 / month');
      case 'com.aegisdial.app.pro.yearly':
        return ('AegisDial Pro Annual', '\$399 / year');
      case 'com.aegisdial.app.recovery.session':
        return ('Recovery Session', '\$149 one-time · 14-day Pro');
      case 'com.aegisdial.app.recovery.monthly':
        return ('Recovery Concierge Monthly', '\$99 / month');
      case 'com.aegisdial.app.recovery.yearly':
        return ('Recovery Concierge Annual', '\$899 / year');
      case 'com.aegisdial.app.pro.family_plus.monthly':
        return ('Pro Family+', '\$69.99 / month (legacy)');
      default:
        return ('AegisDial Pro', 'See App Store for plan details');
    }
  }

  String _formatRenewal(String? iso, String? status) {
    if (iso == null) return '';
    final dt = DateTime.tryParse(iso);
    if (dt == null) return '';
    final m = const [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ][dt.month - 1];
    final label = (status == 'cancelled' || status == 'expired')
        ? 'Access until'
        : 'Renews';
    return '$label $m ${dt.day}, ${dt.year}';
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 36),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Billing',
            style: tt.titleLarge?.copyWith(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 20),
          if (_loading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: Center(
                  child: CircularProgressIndicator(
                      color: AegisColors.turquoise, strokeWidth: 2)),
            )
          else
            ..._buildBody(tt),
        ],
      ),
    );
  }

  List<Widget> _buildBody(TextTheme tt) {
    final session = auth.session;
    if (session == null || session.userId == 'guest') {
      return [
        _row(tt, 'Guest session', 'Free'),
        const SizedBox(height: 8),
        Text(
          'Sign in to start your 7-day trial.',
          style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary),
        ),
      ];
    }
    if (_error != null) {
      return [
        Text(
          "We couldn't load your billing details.",
          style: tt.bodyMedium?.copyWith(color: AegisColors.textSecondary),
        ),
        const SizedBox(height: 16),
        TextButton(
          onPressed: () {
            setState(() {
              _loading = true;
              _error = null;
            });
            _fetch();
          },
          style: TextButton.styleFrom(foregroundColor: AegisColors.turquoise),
          child: const Text('Retry'),
        ),
      ];
    }

    final tier = (_status?['tier'] as String?) ?? session.tier;
    final sub = _status?['subscription'] as Map<String, dynamic>?;
    final productId = sub?['provider_product_id'] as String?;
    final periodEnd = sub?['current_period_end'] as String?;
    final status = sub?['status'] as String?;

    if (tier != 'pro' && sub == null) {
      return [
        _row(tt, 'AegisDial — Free tier', 'Free'),
        const SizedBox(height: 8),
        Text(
          '7-day trial — upgrade to keep protection active after it ends.',
          style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary),
        ),
      ];
    }

    final (name, cadence) = _displayForProduct(productId);
    final statusBadge = switch (status) {
      'active' => 'Active',
      'in_grace' => 'Grace period',
      'cancelled' => 'Cancelled',
      'expired' => 'Expired',
      'revoked' => 'Revoked',
      _ => 'Active',
    };
    final renewLine = _formatRenewal(periodEnd, status);

    return [
      _row(tt, name, statusBadge),
      const SizedBox(height: 6),
      Text(
        cadence,
        style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary),
      ),
      if (renewLine.isNotEmpty) ...[
        const SizedBox(height: 4),
        Text(
          renewLine,
          style: tt.labelSmall?.copyWith(color: AegisColors.textTertiary),
        ),
      ],
      const SizedBox(height: 18),
      OutlinedButton.icon(
        onPressed: () async {
          final uri = Uri.parse('https://apps.apple.com/account/subscriptions');
          await launchUrl(uri, mode: LaunchMode.externalApplication);
        },
        icon: const Icon(Icons.open_in_new_rounded, size: 16),
        label: const Text('Manage subscription'),
        style: OutlinedButton.styleFrom(
          foregroundColor: AegisColors.textPrimary,
          side: const BorderSide(color: AegisColors.border, width: 0.8),
          minimumSize: const Size.fromHeight(40),
        ),
      ),
      const SizedBox(height: 12),
      Text(
        'Charge history and cancellation are managed by Apple. The button above opens iOS Settings → Subscriptions → AegisDial.',
        style: tt.bodySmall?.copyWith(
          color: AegisColors.textTertiary,
          height: 1.5,
        ),
      ),
    ];
  }

  Widget _row(TextTheme tt, String name, String trailing) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AegisColors.surfaceElevated,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          const Icon(Icons.receipt_long_outlined,
              color: AegisColors.textTertiary, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Text(name,
                style:
                    tt.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
          ),
          Text(trailing,
              style:
                  tt.bodyMedium?.copyWith(color: AegisColors.textSecondary)),
        ],
      ),
    );
  }
}
