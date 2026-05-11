// Live Shield v2 consent disclosure modal.
//
// Shown the first time a user starts a Live Shield session after the
// v2 backend is wired. They must explicitly tap "Enable AI coaching" to
// flip the device-local flag — until then the client falls back to v1
// (regex-only) on every shielded call.
//
// Copy is intentionally plain. The legal team can swap this string if
// they want, but the structure (what's new + what stays the same + an
// explicit Accept) is the consent pattern we want to keep.

import 'package:flutter/material.dart';
import '../services/consent_service.dart';
import '../theme/app_theme.dart';

/// Shows the modal. Returns true if the user accepted v2 in this
/// presentation (or had already accepted it before opening). False if
/// they declined / dismissed.
Future<bool> showLiveShieldConsentV2Sheet(BuildContext context) async {
  if (await consentService.hasAcceptedV2()) return true;
  // Caller may have async-gapped before us — bail if the page is gone.
  if (!context.mounted) return false;

  final accepted = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    isDismissible: false,
    enableDrag: false,
    backgroundColor: AegisColors.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
    ),
    builder: (ctx) => const _ConsentV2Sheet(),
  );

  if (accepted == true) {
    await consentService.markV2Accepted();
  }
  return accepted == true;
}

class _ConsentV2Sheet extends StatelessWidget {
  const _ConsentV2Sheet();

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 18, 24, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Drag handle
            Center(
              child: Container(
                width: 40,
                height: 4,
                margin: const EdgeInsets.only(bottom: 18),
                decoration: BoxDecoration(
                  color: AegisColors.textTertiary.withValues(alpha: 0.4),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),

            // Icon
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                color: AegisColors.turquoise.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(16),
              ),
              child: const Icon(
                Icons.auto_awesome_rounded,
                color: AegisColors.turquoise,
                size: 28,
              ),
            ),
            const SizedBox(height: 14),
            Text(
              'AI coaching is new — want it on?',
              style: tt.headlineSmall?.copyWith(
                fontWeight: FontWeight.w800,
                letterSpacing: -0.6,
              ),
            ),
            const SizedBox(height: 10),
            Text(
              'AegisDial can now suggest exactly what to say when a call gets risky. '
              'To do that, we need to send the transcript of suspicious calls to our AI '
              'partner. Here\'s what stays the same and what\'s different:',
              style: tt.bodyMedium?.copyWith(
                color: AegisColors.textSecondary,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 20),

            _Row(
              icon: Icons.shield_outlined,
              title: 'Audio never leaves your phone',
              body:
                  'Same as before. Speech-to-text runs entirely on your device. We never receive '
                  'an audio recording.',
            ),
            const SizedBox(height: 14),
            _Row(
              icon: Icons.text_fields_rounded,
              title: 'Transcript text leaves only when a call looks risky',
              body:
                  'If our on-device regex flags a call above a risk threshold, we send the recent '
                  'transcript to Anthropic\'s Claude to generate a coaching line and refined score. '
                  'Safe calls never leave your phone.',
            ),
            const SizedBox(height: 14),
            _Row(
              icon: Icons.timer_off_outlined,
              title: 'No retention with our AI partner',
              body:
                  'Anthropic does not store, train on, or share the transcripts we send. They process '
                  'and discard within seconds.',
            ),
            const SizedBox(height: 14),
            _Row(
              icon: Icons.toggle_off_outlined,
              title: 'You can turn this off anytime',
              body:
                  'If you decline now, AegisDial keeps protecting you with the original regex engine '
                  '— just without AI coaching lines. You can flip this back on later in Settings.',
            ),

            const SizedBox(height: 22),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: () => Navigator.of(context).pop(true),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AegisColors.turquoise,
                  foregroundColor: Colors.black,
                  minimumSize: const Size(0, 52),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                  elevation: 0,
                ),
                child: Text(
                  'Enable AI coaching',
                  style: tt.titleMedium?.copyWith(
                    color: Colors.black,
                    fontWeight: FontWeight.w800,
                    letterSpacing: -0.2,
                  ),
                ),
              ),
            ),
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                style: TextButton.styleFrom(
                  foregroundColor: AegisColors.textSecondary,
                  minimumSize: const Size(0, 44),
                ),
                child: const Text(
                  'Not now — keep regex-only protection',
                  style: TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  final IconData icon;
  final String title;
  final String body;
  const _Row({required this.icon, required this.title, required this.body});

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: AegisColors.turquoise, size: 20),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: tt.titleSmall?.copyWith(
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.2,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                body,
                style: tt.bodySmall?.copyWith(
                  color: AegisColors.textSecondary,
                  height: 1.45,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
