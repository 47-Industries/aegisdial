import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/glass_card.dart';
import 'recovery_chatbot_screen.dart';

class ScamTypeInfo {
  final String name;
  final IconData icon;
  final String definition;
  final String example;
  final List<String> redFlags;
  final List<String> whatToDo;

  const ScamTypeInfo({
    required this.name,
    required this.icon,
    required this.definition,
    required this.example,
    required this.redFlags,
    required this.whatToDo,
  });
}

class ScamTypeDetailScreen extends StatelessWidget {
  final ScamTypeInfo info;
  const ScamTypeDetailScreen({super.key, required this.info});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AegisColors.background,
      appBar: AppBar(title: Text(info.name)),
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
                      child: Icon(info.icon, color: AegisColors.blueAccent),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'What this scam is',
                        style: tt.titleMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  info.definition,
                  style: tt.bodyMedium?.copyWith(
                    color: AegisColors.textSecondary,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          _Section(
            title: 'EXAMPLE',
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AegisColors.surfaceElevated,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AegisColors.border, width: 0.6),
              ),
              child: Text(
                info.example,
                style: tt.bodyMedium?.copyWith(
                  color: AegisColors.textPrimary,
                  fontStyle: FontStyle.italic,
                  height: 1.5,
                ),
              ),
            ),
          ),
          const SizedBox(height: 20),
          _Section(
            title: 'RED FLAGS',
            child: Column(
              children: info.redFlags
                  .map((f) => _BulletTile(
                        icon: Icons.warning_amber_rounded,
                        color: AegisColors.danger,
                        text: f,
                      ))
                  .toList(),
            ),
          ),
          const SizedBox(height: 20),
          _Section(
            title: 'WHAT TO DO IF IT HAPPENED',
            child: Column(
              children: [
                ...info.whatToDo.asMap().entries.map((e) => _StepTile(
                      step: e.key + 1,
                      text: e.value,
                    )),
              ],
            ),
          ),
          const SizedBox(height: 24),
          ElevatedButton.icon(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => const RecoveryChatbotScreen(),
              ),
            ),
            icon: const Icon(Icons.chat_bubble_outline_rounded),
            label: const Text('Talk to my recovery companion'),
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  final String title;
  final Widget child;
  const _Section({required this.title, required this.child});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: tt.labelSmall?.copyWith(
            color: AegisColors.textTertiary,
            letterSpacing: 1.6,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 10),
        child,
      ],
    );
  }
}

class _BulletTile extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String text;
  const _BulletTile({
    required this.icon,
    required this.color,
    required this.text,
  });

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: tt.bodyMedium?.copyWith(
                color: AegisColors.textPrimary,
                height: 1.45,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _StepTile extends StatelessWidget {
  final int step;
  final String text;
  const _StepTile({required this.step, required this.text});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 14),
      decoration: BoxDecoration(
        color: AegisColors.surface.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AegisColors.border, width: 0.6),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 26,
            height: 26,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: AegisColors.turquoise.withValues(alpha: 0.18),
              shape: BoxShape.circle,
            ),
            child: Text(
              '$step',
              style: tt.labelMedium?.copyWith(
                color: AegisColors.turquoise,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              text,
              style: tt.bodyMedium?.copyWith(
                color: AegisColors.textPrimary,
                height: 1.45,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
