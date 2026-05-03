import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import '../services/auth_service.dart';
import 'welcome_screen.dart';

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

  void _showBilling(BuildContext context) {
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
              'Billing History',
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
                      'AegisDial Pro · Annual',
                      style: Theme.of(context)
                          .textTheme
                          .bodyMedium
                          ?.copyWith(fontWeight: FontWeight.w600),
                    ),
                  ),
                  Text(
                    '\$299.00',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: AegisColors.textSecondary,
                        ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Billed via App Store · Renews annually',
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: AegisColors.textTertiary,
                  ),
            ),
          ],
        ),
      ),
    );
  }

  void _showDeleteConfirm(BuildContext context) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AegisColors.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: const Text('Delete account?'),
        content: const Text(
          'This permanently deletes your account, all breach monitors, family lines, and chat history. This cannot be undone.',
          style: TextStyle(color: AegisColors.textSecondary, height: 1.5),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () {
              Navigator.of(ctx).pop();
              auth.signOut();
              Navigator.of(context).pushAndRemoveUntil(
                MaterialPageRoute(builder: (_) => const WelcomeScreen()),
                (_) => false,
              );
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
                  'Go to the Family tab and tap "Add a family member." You can add up to 3 on Pro, or 5 on Family+ for \$69.99/month.'),
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
          GlassCard(
            onTap: () => _showInfo(
              context,
              'Your profile',
              'Profile editing — name, photo, and notification preferences — is coming in the next update.',
            ),
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
                  child: const Text(
                    'D',
                    style: TextStyle(
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
                        'Dean',
                        style: tt.titleLarge?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      Text(
                        'kylerivers4@gmail.com',
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
          ),
          const SizedBox(height: 20),
          _SectionLabel('SUBSCRIPTION'),
          _SettingsTile(
            icon: Icons.workspace_premium_outlined,
            title: 'AegisDial Pro',
            trailing: '\$299/year',
            onTap: () => _showInfo(
              context,
              'AegisDial Pro',
              'You\'re on the Pro Annual plan at \$299/year. Manage or cancel your subscription at any time via the App Store → Account → Subscriptions.',
            ),
          ),
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
            trailing: 'v1.0.0 (4)',
            onTap: () => _showInfo(
              context,
              'About AegisDial',
              'AegisDial v1.0.0 (4)\n\nBuilt by 47 Industries.\n\nAegisDial helps you prevent phone scams with real-time AI call screening and recover from fraud with a guided companion.\n\nFor support: support@aegisdial.com',
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
