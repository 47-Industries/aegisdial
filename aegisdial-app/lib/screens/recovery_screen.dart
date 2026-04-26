import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';

class RecoveryScreen extends StatelessWidget {
  const RecoveryScreen({super.key});

  static const _categories = <_Category>[
    _Category('Bank impersonation', '"Your Wells Fargo account…"',
        Icons.account_balance_outlined, 12),
    _Category('IRS / government', '"Officer Martinez, IRS warrant…"',
        Icons.gavel_outlined, 6),
    _Category('Romance scam', 'Long-distance, never met',
        Icons.favorite_outline, 8),
    _Category('Crypto recovery scam',
        'Promise to "recover" your stolen crypto', Icons.currency_bitcoin, 4),
    _Category('Tech support', '"Your Apple ID has been compromised"',
        Icons.computer_outlined, 9),
    _Category('Grandparent / family emergency',
        '"Grandma, I need bail money"', Icons.family_restroom_outlined, 5),
    _Category('Job offer / check fraud', 'Overpayment + send back',
        Icons.work_outline, 4),
    _Category('Investment / pig butchering',
        'Slow trust, then "guaranteed returns"', Icons.trending_up, 4),
  ];

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(
        title: const Text('Recovery'),
        elevation: 0,
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
        children: [
          GlassCard(
            accent: AegisColors.danger,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AegisColors.danger.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(
                        Icons.bolt_rounded,
                        color: AegisColors.danger,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'Just got scammed?',
                        style: tt.titleLarge?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  'Start the 15-minute recovery flow. We\'ll walk you through bank calls, credit freezes, FTC + IC3 reports, and family loop-in.',
                  style: tt.bodyMedium?.copyWith(
                    color: AegisColors.textSecondary,
                    height: 1.5,
                  ),
                ),
                const SizedBox(height: 16),
                ElevatedButton.icon(
                  onPressed: () {},
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AegisColors.danger,
                    foregroundColor: Colors.white,
                  ),
                  icon: const Icon(Icons.play_arrow_rounded),
                  label: const Text('Start Recovery Now'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          Text(
            'BROWSE BY SCAM TYPE',
            style: tt.labelSmall?.copyWith(
              color: AegisColors.textTertiary,
              letterSpacing: 1.6,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          ..._categories.map((c) => _CategoryTile(category: c)),
          const SizedBox(height: 12),
          Center(
            child: Text(
              '+ 44 more playbooks',
              style: tt.bodySmall?.copyWith(color: AegisColors.textTertiary),
            ),
          ),
        ],
      ),
    );
  }
}

class _Category {
  final String name;
  final String example;
  final IconData icon;
  final int playbooks;
  const _Category(this.name, this.example, this.icon, this.playbooks);
}

class _CategoryTile extends StatelessWidget {
  final _Category category;
  const _CategoryTile({required this.category});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: () {},
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 14),
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
                    color: AegisColors.blue.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(
                    category.icon,
                    color: AegisColors.blueAccent,
                    size: 18,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        category.name,
                        style: tt.bodyLarge?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        category.example,
                        style: tt.bodySmall?.copyWith(
                          color: AegisColors.textTertiary,
                        ),
                      ),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    vertical: 4,
                    horizontal: 8,
                  ),
                  decoration: BoxDecoration(
                    color: AegisColors.surfaceElevated,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    '${category.playbooks}',
                    style: tt.labelSmall?.copyWith(
                      color: AegisColors.turquoise,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                const Icon(
                  Icons.chevron_right_rounded,
                  color: AegisColors.textTertiary,
                  size: 20,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
