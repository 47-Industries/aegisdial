import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import '../services/auth_service.dart';
import '../services/api_service.dart';
import 'welcome_screen.dart';
import 'family_alert_privacy_screen.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

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
    // Backend `UserTier` vocab is currently coarse: 'pending' | 'pro' |
    // 'expired' | 'cancelled' (per src/lib/subscription.ts). We don't
    // yet receive the specific product_id back through /auth/me, so we
    // can only show whether they're on a paid tier vs free — Apple owns
    // the actual line-item charge history and is the source of truth
    // for "which SKU did I buy" anyway.
    final tier = auth.session?.tier ?? 'free';
    final (productName, displayPrice, cadence) = switch (tier) {
      'pro' || 'in_grace' => (
          'AegisDial Pro',
          'Active',
          'See App Store for the price you signed up at',
        ),
      'expired' => (
          'AegisDial Pro',
          'Expired',
          'Your subscription is no longer active',
        ),
      'cancelled' => (
          'AegisDial Pro',
          'Cancelled',
          'Active until period end · See App Store',
        ),
      'guest' => (
          'Guest session',
          'Free',
          'Sign in to start your 7-day trial',
        ),
      _ => (
          'AegisDial — Free trial',
          'Free',
          '7-day trial — upgrade to keep protection active',
        ),
    };

    showModalBottomSheet(
      context: context,
      backgroundColor: AegisColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 36),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Billing',
              style: Theme.of(context)
                  .textTheme
                  .titleLarge
                  ?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 20),
            Container(
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
                    child: Text(
                      productName,
                      style: Theme.of(context)
                          .textTheme
                          .bodyMedium
                          ?.copyWith(fontWeight: FontWeight.w600),
                    ),
                  ),
                  Text(
                    displayPrice,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: AegisColors.textSecondary,
                        ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            Text(
              cadence,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: AegisColors.textTertiary,
                  ),
            ),
            const SizedBox(height: 20),
            Text(
              'Charge history and cancellation are managed by Apple. Open Settings → [Your Name] → Subscriptions → AegisDial.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: AegisColors.textTertiary,
                    height: 1.5,
                  ),
            ),
          ],
        ),
      ),
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
                  'AegisDial transcribes every call on-device using on-device AI. Nothing leaves your phone. If the transcript matches a scam pattern, you get an immediate alert.'),
              ('What is the recovery chatbot?',
                  'The recovery companion walks you through the first 60 minutes after a scam — contacting your bank, filing FTC / IC3 reports, freezing credit, and more.'),
              ('What does the SMS Filter scan?',
                  'It scans every incoming SMS and iMessage for phishing links, package-redelivery scams, fake bank alerts, and more. Paste any message in manually to scan it.'),
              ('How do I add family members?',
                  'Go to the Family tab and tap "Add a family member." Pro covers up to 3 lines.'),
              ('How do I contact support?',
                  'Email us at support@aegisdial.com. We respond within 24 hours.'),
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
            icon: Icons.info_outline,
            title: 'About AegisDial',
            trailing: 'v1.0.0 (8)',
            onTap: () => _showInfo(
              context,
              'About AegisDial',
              'AegisDial v1.0.0 (8)\n\nBuilt by 47 Industries.\n\nAegisDial helps you prevent phone scams with real-time AI call screening and recover from fraud with a guided companion.\n\nFor support: support@aegisdial.com',
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
