import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../theme/app_theme.dart';
import '../widgets/hyperspace_stars.dart';

/// Two-step password recovery for email-auth users.
///
/// Step 1: user enters the email on their account. Backend sends a
/// 6-digit code via Resend. We always advance to step 2 — even when
/// the email doesn't exist — because the backend's anti-enumeration
/// posture means we can't distinguish that case.
///
/// Step 2: user enters the code + a new password. On success we pop
/// back to the email auth screen with a "Password updated — sign in
/// with the new one" snackbar.
class ForgotPasswordScreen extends StatefulWidget {
  /// Optional pre-fill from the email-auth screen so the user doesn't
  /// retype the same address they were already on.
  final String? prefilledEmail;
  const ForgotPasswordScreen({super.key, this.prefilledEmail});

  @override
  State<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends State<ForgotPasswordScreen> {
  final _emailCtrl = TextEditingController();
  final _codeCtrl = TextEditingController();
  final _newPasswordCtrl = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  bool _busy = false;
  bool _showPassword = false;
  _Step _step = _Step.email;

  @override
  void initState() {
    super.initState();
    if (widget.prefilledEmail != null) {
      _emailCtrl.text = widget.prefilledEmail!;
    }
  }

  @override
  void dispose() {
    _emailCtrl.dispose();
    _codeCtrl.dispose();
    _newPasswordCtrl.dispose();
    super.dispose();
  }

  Future<void> _sendCode() async {
    if (_busy) return;
    final email = _emailCtrl.text.trim();
    if (email.isEmpty || !email.contains('@')) {
      _toast('Enter a valid email.');
      return;
    }
    setState(() => _busy = true);
    try {
      await auth.requestPasswordReset(email: email);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _step = _Step.code;
      });
      _toast('If that email is on file, a 6-digit code is on its way.');
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      _toast(e is ApiException ? e.message : 'Could not request a code.');
    }
  }

  Future<void> _submitReset() async {
    if (_busy) return;
    final form = _formKey.currentState;
    if (form == null || !form.validate()) return;
    setState(() => _busy = true);
    try {
      await auth.resetPassword(
        email: _emailCtrl.text.trim(),
        code: _codeCtrl.text.trim(),
        newPassword: _newPasswordCtrl.text,
      );
      if (!mounted) return;
      Navigator.of(context).pop(true);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
              'Password updated. Sign in with the new one.'),
        ),
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      final msg = e.code == 'invalid_code'
          ? "That code didn't match — request a new one or try again."
          : e.message;
      _toast(msg);
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      _toast('Could not reset your password. Try again.');
    }
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
    final tt = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AegisColors.background,
      body: Stack(
        fit: StackFit.expand,
        children: [
          const Positioned.fill(
            child: HyperspaceStars(starCount: 50, speed: 0.1),
          ),
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    Colors.black.withValues(alpha: 0.3),
                    Colors.black.withValues(alpha: 0.92),
                  ],
                ),
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const SizedBox(height: 8),
                  IconButton(
                    icon: const Icon(Icons.arrow_back_rounded,
                        color: AegisColors.textPrimary),
                    onPressed: () => Navigator.of(context).maybePop(),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _step == _Step.email
                        ? 'Reset your password'
                        : 'Check your inbox',
                    style: tt.headlineMedium?.copyWith(
                        fontWeight: FontWeight.w800, letterSpacing: -0.5),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    _step == _Step.email
                        ? 'Enter the email you signed up with. We\'ll send a 6-digit code.'
                        : "We sent a 6-digit code to ${_emailCtrl.text.trim()}. It expires in 15 minutes.",
                    style: tt.bodyMedium?.copyWith(
                      color: AegisColors.textSecondary,
                      height: 1.5,
                    ),
                  ),
                  const SizedBox(height: 28),
                  Expanded(
                    child: SingleChildScrollView(
                      child: _step == _Step.email
                          ? _buildEmailStep(tt)
                          : _buildCodeStep(tt),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildEmailStep(TextTheme tt) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _emailCtrl,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          enableSuggestions: false,
          textCapitalization: TextCapitalization.none,
          decoration: const InputDecoration(
            labelText: 'Email',
            hintText: 'you@example.com',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 20),
        ElevatedButton(
          onPressed: _busy ? null : _sendCode,
          style: ElevatedButton.styleFrom(
            backgroundColor: AegisColors.turquoise,
            foregroundColor: Colors.black,
            padding: const EdgeInsets.symmetric(vertical: 14),
            shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12)),
          ),
          child: _busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                      strokeWidth: 2, color: Colors.black),
                )
              : const Text('Send code',
                  style:
                      TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
        ),
      ],
    );
  }

  Widget _buildCodeStep(TextTheme tt) {
    return Form(
      key: _formKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextFormField(
            controller: _codeCtrl,
            keyboardType: TextInputType.number,
            inputFormatters: [
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(6),
            ],
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 28,
              letterSpacing: 8,
              fontWeight: FontWeight.w700,
            ),
            decoration: const InputDecoration(
              labelText: '6-digit code',
              border: OutlineInputBorder(),
            ),
            validator: (v) => (v == null || v.length != 6)
                ? 'Code is 6 digits'
                : null,
          ),
          const SizedBox(height: 16),
          TextFormField(
            controller: _newPasswordCtrl,
            obscureText: !_showPassword,
            decoration: InputDecoration(
              labelText: 'New password',
              border: const OutlineInputBorder(),
              suffixIcon: IconButton(
                icon: Icon(_showPassword
                    ? Icons.visibility_off_outlined
                    : Icons.visibility_outlined),
                onPressed: () =>
                    setState(() => _showPassword = !_showPassword),
              ),
            ),
            validator: (v) => (v == null || v.length < 8)
                ? 'At least 8 characters'
                : null,
          ),
          const SizedBox(height: 20),
          ElevatedButton(
            onPressed: _busy ? null : _submitReset,
            style: ElevatedButton.styleFrom(
              backgroundColor: AegisColors.turquoise,
              foregroundColor: Colors.black,
              padding: const EdgeInsets.symmetric(vertical: 14),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12)),
            ),
            child: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: Colors.black),
                  )
                : const Text('Set new password',
                    style: TextStyle(
                        fontWeight: FontWeight.w700, fontSize: 15)),
          ),
          const SizedBox(height: 12),
          TextButton(
            onPressed: _busy
                ? null
                : () {
                    setState(() {
                      _step = _Step.email;
                      _codeCtrl.clear();
                      _newPasswordCtrl.clear();
                    });
                  },
            child: Text(
              'Didn\'t get the code? Resend',
              style: tt.bodySmall?.copyWith(color: AegisColors.textTertiary),
            ),
          ),
        ],
      ),
    );
  }
}

enum _Step { email, code }
