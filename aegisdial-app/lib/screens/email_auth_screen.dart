import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../theme/app_theme.dart';
import '../widgets/hyperspace_stars.dart';

class EmailAuthScreen extends StatefulWidget {
  final bool initialSignUp;
  const EmailAuthScreen({super.key, this.initialSignUp = false});

  @override
  State<EmailAuthScreen> createState() => _EmailAuthScreenState();
}

class _EmailAuthScreenState extends State<EmailAuthScreen> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _name = TextEditingController();
  final _dob = TextEditingController();
  late bool _isSignUp;
  bool _busy = false;
  bool _showPassword = false;

  @override
  void initState() {
    super.initState();
    _isSignUp = widget.initialSignUp;
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _name.dispose();
    _dob.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final form = _formKey.currentState;
    if (form == null || !form.validate()) return;
    setState(() => _busy = true);
    try {
      if (_isSignUp) {
        final dobYear = int.tryParse(_dob.text.trim());
        if (dobYear == null || dobYear < 1900 || dobYear > DateTime.now().year) {
          throw ApiException(0, 'Birth year is required.');
        }
        await auth.signUpWithEmail(
          email: _email.text.trim(),
          password: _password.text,
          dobYear: dobYear,
          displayName: _name.text.trim().isEmpty ? null : _name.text.trim(),
        );
      } else {
        await auth.signInWithEmail(
          email: _email.text.trim(),
          password: _password.text,
        );
      }
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      _toast(e.message);
    } catch (e) {
      _toast('Could not sign in. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
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
            child: HyperspaceStars(starCount: 90, speed: 0.3),
          ),
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(gradient: AegisColors.ambientGlow),
            ),
          ),
          SafeArea(
            child: Form(
              key: _formKey,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 24, 24, 32),
                children: [
                  Text(
                    _isSignUp ? 'Create your account' : 'Sign in',
                    style: tt.headlineMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.5,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _isSignUp
                        ? 'Email + password — guarded by AegisDial.'
                        : 'Welcome back.',
                    style: tt.bodyMedium?.copyWith(
                      color: AegisColors.textSecondary,
                    ),
                  ),
                  const SizedBox(height: 28),
                  if (_isSignUp) ...[
                    _Field(
                      controller: _name,
                      label: 'Display name (optional)',
                      icon: Icons.person_outline_rounded,
                      validator: (_) => null,
                    ),
                    const SizedBox(height: 14),
                  ],
                  _Field(
                    controller: _email,
                    label: 'Email',
                    icon: Icons.mail_outline_rounded,
                    keyboardType: TextInputType.emailAddress,
                    validator: (v) {
                      if (v == null || !v.contains('@')) {
                        return 'Enter a valid email.';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 14),
                  _Field(
                    controller: _password,
                    label: 'Password',
                    icon: Icons.lock_outline_rounded,
                    obscureText: !_showPassword,
                    suffixIcon: IconButton(
                      icon: Icon(
                        _showPassword
                            ? Icons.visibility_off_outlined
                            : Icons.visibility_outlined,
                        size: 20,
                        color: AegisColors.textTertiary,
                      ),
                      onPressed: () =>
                          setState(() => _showPassword = !_showPassword),
                    ),
                    validator: (v) {
                      if (v == null || v.length < 8) {
                        return 'Min 8 characters.';
                      }
                      return null;
                    },
                  ),
                  if (_isSignUp) ...[
                    const SizedBox(height: 14),
                    _Field(
                      controller: _dob,
                      label: 'Birth year (e.g. 1985)',
                      icon: Icons.cake_outlined,
                      keyboardType: TextInputType.number,
                      validator: (v) {
                        final y = int.tryParse(v ?? '');
                        if (y == null || y < 1900 || y > DateTime.now().year) {
                          return 'Enter a 4-digit birth year.';
                        }
                        return null;
                      },
                    ),
                  ],
                  const SizedBox(height: 24),
                  ElevatedButton(
                    onPressed: _busy ? null : _submit,
                    child: Text(
                      _busy
                          ? 'Working…'
                          : (_isSignUp ? 'Create account' : 'Sign in'),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Center(
                    child: TextButton(
                      onPressed: () => setState(() => _isSignUp = !_isSignUp),
                      child: Text(
                        _isSignUp
                            ? 'Already have an account? Sign in'
                            : 'New here? Create an account',
                        style: const TextStyle(color: AegisColors.turquoise),
                      ),
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
}

class _Field extends StatelessWidget {
  final TextEditingController controller;
  final String label;
  final IconData icon;
  final bool obscureText;
  final Widget? suffixIcon;
  final TextInputType? keyboardType;
  final String? Function(String?)? validator;

  const _Field({
    required this.controller,
    required this.label,
    required this.icon,
    this.obscureText = false,
    this.suffixIcon,
    this.keyboardType,
    this.validator,
  });

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: controller,
      obscureText: obscureText,
      keyboardType: keyboardType,
      validator: validator,
      style: const TextStyle(color: AegisColors.textPrimary, fontSize: 16),
      cursorColor: AegisColors.turquoise,
      decoration: InputDecoration(
        labelText: label,
        labelStyle: const TextStyle(color: AegisColors.textTertiary),
        prefixIcon: Icon(icon, color: AegisColors.turquoise, size: 20),
        suffixIcon: suffixIcon,
        filled: true,
        fillColor: AegisColors.surface.withValues(alpha: 0.7),
        contentPadding:
            const EdgeInsets.symmetric(vertical: 18, horizontal: 12),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: AegisColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: AegisColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: AegisColors.turquoise, width: 1.4),
        ),
      ),
    );
  }
}
