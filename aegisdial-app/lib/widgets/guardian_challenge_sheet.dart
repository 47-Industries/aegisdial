import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../services/guardian_service.dart';
import '../services/api_service.dart';

Future<void> showGuardianChallengeSheet(
  BuildContext context, {
  required String challengeId,
  String? prompt,
}) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _GuardianChallengeSheet(
      challengeId: challengeId,
      prompt: prompt,
    ),
  );
}

class _GuardianChallengeSheet extends StatefulWidget {
  final String challengeId;
  final String? prompt;
  const _GuardianChallengeSheet({
    required this.challengeId,
    this.prompt,
  });

  @override
  State<_GuardianChallengeSheet> createState() =>
      _GuardianChallengeSheetState();
}

enum _ChallengeState { input, submitting, matched, failed, error }

class _GuardianChallengeSheetState extends State<_GuardianChallengeSheet> {
  final _ctrl = TextEditingController();
  _ChallengeState _state = _ChallengeState.input;
  String? _errorMsg;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final answer = _ctrl.text.trim();
    if (answer.isEmpty) return;

    setState(() => _state = _ChallengeState.submitting);
    try {
      final res = await guardianService.respondToChallenge(
        challengeId: widget.challengeId,
        answer: answer,
      );
      if (!mounted) return;
      final matched = res?['matched'] == true;
      setState(() => _state =
          matched ? _ChallengeState.matched : _ChallengeState.failed);
    } on ApiException catch (e) {
      if (!mounted) return;
      final msg = switch (e.code) {
        'challenge_expired' => 'This challenge has expired.',
        'already_resolved' => 'This challenge was already answered.',
        'no_safe_word_configured' =>
          'No safe word is set up yet. Set one in Family > Safe Word.',
        _ => e.message,
      };
      setState(() {
        _state = _ChallengeState.error;
        _errorMsg = msg;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _state = _ChallengeState.error;
        _errorMsg = 'Something went wrong. Please try again.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Container(
      decoration: const BoxDecoration(
        color: AegisColors.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.fromLTRB(
            24,
            20,
            24,
            MediaQuery.of(context).viewInsets.bottom + 24,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AegisColors.border,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 20),
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: _iconBgColor,
                ),
                child: Icon(_icon, color: _iconColor, size: 32),
              ),
              const SizedBox(height: 16),
              Text(
                _title,
                style: tt.titleLarge?.copyWith(fontWeight: FontWeight.w700),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              Text(
                _subtitle,
                style: tt.bodySmall?.copyWith(
                  color: AegisColors.textSecondary,
                  height: 1.5,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 20),
              if (_state == _ChallengeState.input ||
                  _state == _ChallengeState.submitting) ...[
                TextField(
                  controller: _ctrl,
                  autofocus: true,
                  textCapitalization: TextCapitalization.none,
                  enabled: _state != _ChallengeState.submitting,
                  style: tt.bodyMedium,
                  decoration: const InputDecoration(
                    labelText: 'Enter your family safe word',
                    border: OutlineInputBorder(),
                  ),
                  onSubmitted: (_) => _submit(),
                ),
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed:
                        _state == _ChallengeState.submitting ? null : _submit,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AegisColors.turquoise,
                      foregroundColor: Colors.black,
                      disabledBackgroundColor:
                          AegisColors.turquoise.withValues(alpha: 0.3),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(14)),
                    ),
                    child: _state == _ChallengeState.submitting
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              color: Colors.black,
                              strokeWidth: 2,
                            ),
                          )
                        : const Text(
                            'Verify',
                            style: TextStyle(
                                fontWeight: FontWeight.w700, fontSize: 15),
                          ),
                  ),
                ),
              ] else ...[
                const SizedBox(height: 8),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: _state == _ChallengeState.matched
                          ? AegisColors.success
                          : AegisColors.surfaceElevated,
                      foregroundColor: _state == _ChallengeState.matched
                          ? Colors.black
                          : AegisColors.textPrimary,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(14)),
                    ),
                    child: const Text(
                      'Done',
                      style:
                          TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  String get _title => switch (_state) {
        _ChallengeState.input || _ChallengeState.submitting =>
          'Family verification',
        _ChallengeState.matched => 'Identity confirmed',
        _ChallengeState.failed => 'Safe word didn\'t match',
        _ChallengeState.error => 'Something went wrong',
      };

  String get _subtitle => switch (_state) {
        _ChallengeState.input || _ChallengeState.submitting =>
          widget.prompt ??
              'A family member wants to verify it\'s really you. Enter your family safe word below.',
        _ChallengeState.matched =>
          'Your family member has been notified that it\'s really you.',
        _ChallengeState.failed =>
          'The safe word didn\'t match. Your family member has been notified. If this is you, check the safe word in Family settings.',
        _ChallengeState.error => _errorMsg ?? 'Please try again.',
      };

  IconData get _icon => switch (_state) {
        _ChallengeState.input || _ChallengeState.submitting =>
          Icons.key_rounded,
        _ChallengeState.matched => Icons.check_circle_rounded,
        _ChallengeState.failed => Icons.warning_amber_rounded,
        _ChallengeState.error => Icons.error_outline_rounded,
      };

  Color get _iconColor => switch (_state) {
        _ChallengeState.input || _ChallengeState.submitting =>
          AegisColors.turquoise,
        _ChallengeState.matched => AegisColors.success,
        _ChallengeState.failed => AegisColors.warning,
        _ChallengeState.error => AegisColors.danger,
      };

  Color get _iconBgColor => switch (_state) {
        _ChallengeState.input || _ChallengeState.submitting =>
          AegisColors.turquoise.withValues(alpha: 0.15),
        _ChallengeState.matched =>
          AegisColors.success.withValues(alpha: 0.15),
        _ChallengeState.failed =>
          AegisColors.warning.withValues(alpha: 0.15),
        _ChallengeState.error =>
          AegisColors.danger.withValues(alpha: 0.15),
      };
}
