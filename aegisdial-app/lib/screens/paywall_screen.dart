import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

enum PaywallReason { trialExpired, dailyLimitReached }

class PaywallScreen extends StatelessWidget {
  final PaywallReason reason;
  const PaywallScreen({super.key, required this.reason});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AegisColors.background,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 32, 24, 32),
          child: Column(
            children: [
              Container(
                width: 72,
                height: 72,
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: AegisColors.heroGradient,
                ),
                child: const Icon(
                  Icons.shield_moon,
                  size: 36,
                  color: Colors.black,
                ),
              ),
              const SizedBox(height: 20),
              Text(
                reason == PaywallReason.trialExpired
                    ? 'Your free trial has ended'
                    : "You've used today's free messages",
                style: tt.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w700,
                  color: AegisColors.textPrimary,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 10),
              Text(
                reason == PaywallReason.trialExpired
                    ? 'Keep your protection active. Choose a plan to continue.'
                    : 'Free trial includes 10 messages per day. Upgrade for unlimited access.',
                style: tt.bodyMedium?.copyWith(
                  color: AegisColors.textSecondary,
                  height: 1.5,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 32),
              _PlanCard(
                badge: 'BEST VALUE',
                title: 'Pro Annual',
                price: '\$299',
                period: '/year',
                detail: 'Save \$300 vs monthly · Unlimited everything',
                accent: AegisColors.turquoise,
                onTap: () => Navigator.of(context).pop(true),
              ),
              const SizedBox(height: 12),
              _PlanCard(
                title: 'Pro Monthly',
                price: '\$49.99',
                period: '/month',
                detail: 'Unlimited calls, scans, recovery sessions',
                accent: AegisColors.blue,
                onTap: () => Navigator.of(context).pop(true),
              ),
              const SizedBox(height: 12),
              _PlanCard(
                title: 'Recovery Session',
                price: '\$99',
                period: ' one-time',
                detail: 'AI-guided recovery + 30-day Pro included',
                accent: AegisColors.danger,
                onTap: () => Navigator.of(context).pop(true),
              ),
              const SizedBox(height: 28),
              TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                child: Text(
                  'Restore Purchase',
                  style: tt.bodySmall?.copyWith(
                    color: AegisColors.textTertiary,
                    decoration: TextDecoration.underline,
                    decorationColor: AegisColors.textTertiary,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              if (reason == PaywallReason.dailyLimitReached)
                TextButton(
                  onPressed: () => Navigator.of(context).pop(false),
                  child: Text(
                    'Continue with free tier',
                    style: tt.bodySmall?.copyWith(
                      color: AegisColors.textTertiary,
                    ),
                  ),
                ),
              const SizedBox(height: 12),
              Text(
                'Cancel any time · Billed through App Store',
                style: tt.labelSmall?.copyWith(
                  color: AegisColors.textTertiary,
                  letterSpacing: 0.3,
                ),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  final String? badge;
  final String title;
  final String price;
  final String period;
  final String detail;
  final Color accent;
  final VoidCallback onTap;

  const _PlanCard({
    this.badge,
    required this.title,
    required this.price,
    required this.period,
    required this.detail,
    required this.accent,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: AegisColors.surface,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(
              color: badge != null ? accent : AegisColors.border,
              width: badge != null ? 1.5 : 0.6,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      style: tt.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                        color: AegisColors.textPrimary,
                      ),
                    ),
                  ),
                  if (badge != null)
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 3,
                      ),
                      decoration: BoxDecoration(
                        color: accent.withValues(alpha: 0.18),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        badge!,
                        style: TextStyle(
                          color: accent,
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.8,
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 6),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    price,
                    style: tt.headlineMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                      color: accent,
                      height: 1,
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(bottom: 3),
                    child: Text(
                      period,
                      style: tt.bodySmall?.copyWith(
                        color: AegisColors.textSecondary,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                detail,
                style: tt.bodySmall?.copyWith(
                  color: AegisColors.textSecondary,
                  height: 1.4,
                ),
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: onTap,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: accent,
                    foregroundColor: Colors.black,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: Text(
                    title == 'Recovery Session' ? 'Start Session' : 'Start Plan',
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 15,
                    ),
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
