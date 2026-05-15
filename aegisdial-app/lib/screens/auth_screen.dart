import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../config/app_config.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../theme/app_theme.dart';
import '../widgets/hyperspace_stars.dart';
import '../widgets/aegis_logo.dart';
import '../widgets/age_gate_sheet.dart';
import 'home_shell.dart';
import 'onboarding_screen.dart';
import 'email_auth_screen.dart';

class AuthScreen extends StatefulWidget {
  final bool initialSignUp;
  const AuthScreen({super.key, this.initialSignUp = false});

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  bool _busy = false;

  bool get _appleAvailable =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.iOS ||
          defaultTargetPlatform == TargetPlatform.macOS);

  Future<void> _enter() async {
    if (!mounted) return;
    final isGuest = auth.session?.userId == 'guest';
    final seen = isGuest ? false : await tutorialSeen();
    if (!mounted) return;
    final next = seen ? const HomeShell() : const OnboardingScreen();
    Navigator.of(context).pushReplacement(
      PageRouteBuilder(
        transitionDuration: const Duration(milliseconds: 500),
        pageBuilder: (context, anim, secondary) => next,
        transitionsBuilder: (context, anim, secondary, child) {
          return FadeTransition(opacity: anim, child: child);
        },
      ),
    );
  }

  Future<void> _apple() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      // Returning users have an apple_sub on file — backend skips the DOB
      // check entirely. New users get a 400 dob_year_required which we
      // catch below, prompt for birth year, and retry. This keeps the
      // age-gate sheet out of the path for existing accounts.
      try {
        await auth.signInWithApple();
        if (mounted) _enter();
        return;
      } on ApiException catch (e) {
        if (e.code != 'dob_year_required') rethrow;
      }

      if (!mounted) return;
      final dobYear = await showAgeGateSheet(context);
      if (dobYear == null) {
        // User cancelled the age gate — bail without an error toast.
        return;
      }

      try {
        await auth.signInWithApple(dobYear: dobYear);
        if (mounted) _enter();
      } on ApiException catch (e) {
        if (e.code == 'age_restriction') {
          _toast('AegisDial is for users aged $kAegisDialMinAge and over.');
        } else {
          _toast(e.message);
        }
      }
    } on ApiException catch (e) {
      _toast(e.message);
    } catch (e) {
      _toast('Apple sign-in cancelled.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _email() async {
    final ok = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
          builder: (_) =>
              EmailAuthScreen(initialSignUp: widget.initialSignUp)),
    );
    if (ok == true) _enter();
  }

  Future<void> _guest() async {
    await auth.continueAsGuest();
    _enter();
  }

  void _showLegal(
    BuildContext context,
    String title,
    String body,
    String fullDocUrl,
  ) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AegisColors.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: Text(title),
        content: Text(
          body,
          style: const TextStyle(
              color: AegisColors.textSecondary, height: 1.55, fontSize: 13),
        ),
        actions: [
          // Opens the canonical hosted document in the system browser.
          // Until aegisdial.com is registered this 404s — but it's the
          // correct URL and starts working the moment DNS lands, with
          // no code change. See lib/config/app_config.dart.
          TextButton(
            onPressed: () async {
              final uri = Uri.parse(fullDocUrl);
              if (await canLaunchUrl(uri)) {
                await launchUrl(uri, mode: LaunchMode.externalApplication);
              }
            },
            child: const Text(
              'Open full document',
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
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: AegisColors.surfaceElevated,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AegisColors.background,
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          const Positioned.fill(
            child: HyperspaceStars(starCount: 120, speed: 0.4),
          ),
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(gradient: AegisColors.ambientGlow),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(24, 16, 24, 28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Spacer(),
                  const Center(child: AegisLogo(size: 88)),
                  const SizedBox(height: 24),
                  Text(
                    'Welcome',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineLarge?.copyWith(
                          fontWeight: FontWeight.w700,
                          letterSpacing: -0.5,
                        ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Sign in to activate your shield.\nWe never sell your data.',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: AegisColors.textSecondary,
                          height: 1.5,
                        ),
                  ),
                  const Spacer(flex: 2),
                  if (_appleAvailable)
                    _AppleButton(onPressed: _busy ? null : _apple, busy: _busy),
                  if (_appleAvailable) const SizedBox(height: 12),
                  _SecondaryAuth(
                    icon: Icons.mail_outline_rounded,
                    label: 'Continue with email',
                    onPressed: _busy ? null : _email,
                  ),
                  const SizedBox(height: 12),
                  _SecondaryAuth(
                    icon: Icons.shield_outlined,
                    label: 'Continue as guest',
                    onPressed: _busy ? null : _guest,
                  ),
                  const SizedBox(height: 16),
                  Text.rich(
                    TextSpan(
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                            color: AegisColors.textTertiary,
                            height: 1.5,
                          ),
                      children: [
                        const TextSpan(text: 'By continuing you agree to our '),
                        TextSpan(
                          text: 'Terms',
                          style: const TextStyle(
                            color: AegisColors.turquoise,
                            decoration: TextDecoration.underline,
                            decorationColor: AegisColors.turquoise,
                          ),
                          recognizer: TapGestureRecognizer()
                            ..onTap = () => _showLegal(
                                context,
                                'Terms of Service',
                                'AegisDial Terms of Service\n\nBy using AegisDial you agree to use it lawfully. We provide fraud-detection tools for informational purposes only. We are not liable for outcomes arising from scam incidents.\n\nTap "Open full document" for the complete terms.',
                                kLegalTermsUrl),
                        ),
                        const TextSpan(text: ' and '),
                        TextSpan(
                          text: 'Privacy Policy',
                          style: const TextStyle(
                            color: AegisColors.turquoise,
                            decoration: TextDecoration.underline,
                            decorationColor: AegisColors.turquoise,
                          ),
                          recognizer: TapGestureRecognizer()
                            ..onTap = () => _showLegal(
                                context,
                                'Privacy Policy',
                                'AegisDial Privacy Policy\n\nAll call transcripts and SMS scans are processed entirely on your device. We never upload your personal conversations, contacts, or messages.\n\nTap "Open full document" for the complete policy.',
                                kLegalPrivacyUrl),
                        ),
                        const TextSpan(text: '.'),
                      ],
                    ),
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AppleButton extends StatelessWidget {
  final VoidCallback? onPressed;
  final bool busy;
  const _AppleButton({required this.onPressed, required this.busy});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 56,
      child: ElevatedButton.icon(
        onPressed: onPressed,
        icon: busy
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  valueColor: AlwaysStoppedAnimation(Colors.black),
                ),
              )
            : const Icon(Icons.apple, size: 26, color: Colors.black),
        label: Text(
          busy ? 'Signing in…' : 'Sign in with Apple',
          style: const TextStyle(
            fontWeight: FontWeight.w600,
            color: Colors.black,
          ),
        ),
        style: ElevatedButton.styleFrom(
          backgroundColor: Colors.white,
          minimumSize: const Size.fromHeight(56),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
          ),
        ),
      ),
    );
  }
}

class _SecondaryAuth extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback? onPressed;
  const _SecondaryAuth({
    required this.icon,
    required this.label,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: onPressed,
      icon: Icon(icon, size: 20, color: AegisColors.textPrimary),
      label: Text(label),
    );
  }
}
