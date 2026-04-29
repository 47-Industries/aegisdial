import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';

class BreachScreen extends StatelessWidget {
  const BreachScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(title: const Text('Breach')),
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
                      child: const Icon(
                        Icons.fingerprint_rounded,
                        color: AegisColors.blueAccent,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'Where your exposure starts',
                        style: tt.titleLarge?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  'AegisDial monitors dark-web markets, breach corpora, and known scam-call lists for any sign of your email, phone number, or identity. When something surfaces, you see exactly where it came from and what to do about it.',
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
          Container(
            padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 14),
            decoration: BoxDecoration(
              color: AegisColors.surface.withValues(alpha: 0.55),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AegisColors.border, width: 0.6),
            ),
            child: Row(
              children: [
                const Icon(
                  Icons.add_rounded,
                  color: AegisColors.turquoise,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Add an email or phone number to watch',
                    style: tt.bodyMedium?.copyWith(
                      color: AegisColors.textPrimary,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                TextButton(onPressed: () {}, child: const Text('Add')),
              ],
            ),
          ),
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
          Container(
            padding: const EdgeInsets.symmetric(vertical: 28, horizontal: 18),
            decoration: BoxDecoration(
              color: AegisColors.surface.withValues(alpha: 0.55),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AegisColors.border, width: 0.6),
            ),
            child: Column(
              children: [
                const Icon(
                  Icons.verified_user_outlined,
                  color: AegisColors.success,
                  size: 32,
                ),
                const SizedBox(height: 10),
                Text(
                  'No exposures found.',
                  style: tt.bodyMedium?.copyWith(
                    color: AegisColors.textSecondary,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 4),
                Text(
                  'When your details surface, the exact source — dark-web forum, breach corpus, or scam-call list — appears here.',
                  style: tt.bodySmall?.copyWith(
                    color: AegisColors.textTertiary,
                    height: 1.4,
                  ),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          const _ExposurePreviewCard(),
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

class _ExposurePreviewCard extends StatelessWidget {
  const _ExposurePreviewCard();

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: AegisColors.blueAccent.withValues(alpha: 0.4),
          width: 0.8,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding:
                    const EdgeInsets.symmetric(vertical: 3, horizontal: 8),
                decoration: BoxDecoration(
                  color: AegisColors.blueAccent.withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  'PREVIEW',
                  style: tt.labelSmall?.copyWith(
                    color: AegisColors.blueAccent,
                    letterSpacing: 1.4,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                'What an exposure looks like',
                style: tt.bodySmall?.copyWith(
                  color: AegisColors.textTertiary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          _PreviewRow(
            icon: Icons.travel_explore_rounded,
            title: 'Phone +1 555… surfaced on dark-web forum',
            subtitle: 'Source: BreachForums dump · 2025-11 · 3.2M records',
          ),
          const SizedBox(height: 8),
          _PreviewRow(
            icon: Icons.cloud_off_rounded,
            title: 'Email surfaced in breach corpus',
            subtitle: 'Source: Collection #1 — credentials + plaintext password',
          ),
          const SizedBox(height: 8),
          _PreviewRow(
            icon: Icons.phone_disabled_rounded,
            title: 'Number flagged on scam-call list',
            subtitle: 'Source: FCC robocall index · reported 47×',
          ),
        ],
      ),
    );
  }
}

class _PreviewRow extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  const _PreviewRow({
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          padding: const EdgeInsets.all(7),
          decoration: BoxDecoration(
            color: AegisColors.surfaceElevated,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Icon(icon, color: AegisColors.blueAccent, size: 16),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: tt.bodyMedium?.copyWith(
                  color: AegisColors.textPrimary,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                subtitle,
                style: tt.labelSmall?.copyWith(
                  color: AegisColors.textTertiary,
                  height: 1.35,
                ),
              ),
            ],
          ),
        ),
      ],
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
                Text(
                  title,
                  style: tt.bodyLarge?.copyWith(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: tt.bodySmall?.copyWith(
                    color: AegisColors.textTertiary,
                    height: 1.35,
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
