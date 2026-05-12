import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../services/purchase_service.dart';

enum PaywallReason { trialExpired, dailyLimitReached }

class PaywallScreen extends StatefulWidget {
  final PaywallReason reason;
  const PaywallScreen({super.key, required this.reason});

  @override
  State<PaywallScreen> createState() => _PaywallScreenState();
}

class _PaywallScreenState extends State<PaywallScreen> {
  String? _purchasing;
  bool _restoring = false;

  Future<void> _buy(String productId) async {
    setState(() => _purchasing = productId);
    final ok = await PurchaseService.purchaseProduct(productId);
    if (!mounted) return;
    setState(() => _purchasing = null);
    if (ok) Navigator.of(context).pop(true);
  }

  Future<void> _restore() async {
    setState(() => _restoring = true);
    final ok = await PurchaseService.restorePurchases();
    if (!mounted) return;
    setState(() => _restoring = false);
    if (ok) {
      Navigator.of(context).pop(true);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('No active purchases found.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    final busy = _purchasing != null || _restoring;
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
                child: const Icon(Icons.shield_moon, size: 36, color: Colors.black),
              ),
              const SizedBox(height: 20),
              Text(
                widget.reason == PaywallReason.trialExpired
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
                widget.reason == PaywallReason.trialExpired
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
                price: '\$399',
                period: '/year',
                detail: 'Save \$200 vs monthly · \$33/mo · Unlimited everything',
                accent: AegisColors.turquoise,
                loading: _purchasing == kProductProAnnual,
                disabled: busy,
                onTap: () => _buy(kProductProAnnual),
              ),
              const SizedBox(height: 12),
              _PlanCard(
                title: 'Pro Monthly',
                price: '\$49.99',
                period: '/month',
                detail: 'Unlimited calls, scans, recovery sessions',
                accent: AegisColors.blue,
                loading: _purchasing == kProductProMonthly,
                disabled: busy,
                onTap: () => _buy(kProductProMonthly),
              ),
              const SizedBox(height: 12),
              _PlanCard(
                title: 'Recovery Session',
                price: '\$149',
                period: ' one-time',
                detail: 'AI-guided recovery + 14-day Pro included',
                accent: AegisColors.danger,
                loading: _purchasing == kProductRecoverySession,
                disabled: busy,
                onTap: () => _buy(kProductRecoverySession),
              ),
              const SizedBox(height: 12),
              _PlanCard(
                badge: 'CONCIERGE',
                title: 'Recovery Annual',
                price: '\$899',
                period: '/year',
                detail: 'Dedicated agent · Priority response · Save \$289 vs monthly',
                accent: AegisColors.danger,
                loading: _purchasing == kProductRecoveryAnnual,
                disabled: busy,
                onTap: () => _buy(kProductRecoveryAnnual),
              ),
              const SizedBox(height: 12),
              _PlanCard(
                title: 'Recovery Monthly',
                price: '\$99',
                period: '/month',
                detail: 'Dedicated agent · Priority response',
                accent: AegisColors.danger,
                loading: _purchasing == kProductRecoveryMonthly,
                disabled: busy,
                onTap: () => _buy(kProductRecoveryMonthly),
              ),
              const SizedBox(height: 28),
              TextButton(
                onPressed: busy ? null : _restore,
                child: _restoring
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(
                        'Restore Purchase',
                        style: tt.bodySmall?.copyWith(
                          color: AegisColors.textTertiary,
                          decoration: TextDecoration.underline,
                          decorationColor: AegisColors.textTertiary,
                        ),
                      ),
              ),
              const SizedBox(height: 8),
              if (widget.reason == PaywallReason.dailyLimitReached)
                TextButton(
                  onPressed: busy ? null : () => Navigator.of(context).pop(false),
                  child: Text(
                    'Continue with free tier',
                    style: tt.bodySmall?.copyWith(color: AegisColors.textTertiary),
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
  final bool loading;
  final bool disabled;
  final VoidCallback onTap;

  const _PlanCard({
    this.badge,
    required this.title,
    required this.price,
    required this.period,
    required this.detail,
    required this.accent,
    required this.loading,
    required this.disabled,
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
        onTap: disabled ? null : onTap,
        child: Opacity(
          opacity: disabled && !loading ? 0.5 : 1.0,
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
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
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
                        style: tt.bodySmall?.copyWith(color: AegisColors.textSecondary),
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
                    onPressed: disabled ? null : onTap,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: accent,
                      foregroundColor: Colors.black,
                      disabledBackgroundColor: accent.withValues(alpha: 0.4),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: loading
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2.5,
                              color: Colors.black,
                            ),
                          )
                        : Text(
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
      ),
    );
  }
}
