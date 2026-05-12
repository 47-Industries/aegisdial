// Age-gate modal — collects birth year before a NEW Apple sign-in.
//
// Apple's Sign in with Apple flow doesn't share DOB. The backend
// (src/routes/auth.ts) enforces COPPA: new accounts need dob_year, and
// users under 13 are rejected with HTTP 403. Apple sign-in for an
// EXISTING user does not need dob_year — the backend looks up apple_sub
// first and only enforces the age gate on insert.
//
// Pattern: try the sign-in cold. If the server says `dob_year_required`,
// surface this sheet, then retry with the user-supplied year. We don't
// pre-show the sheet for every Apple tap because that would prompt
// returning users too.
//
// The local clamp (year >= 1900, year <= currentYear, age >= 13) keeps
// us from making a round-trip with obviously-invalid input. The backend
// remains the source of truth — never trust the client age claim alone.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme/app_theme.dart';

const int kAegisDialMinAge = 13;

/// Opens the age-gate sheet. Returns the entered birth year on success,
/// or null if the user cancelled / dismissed.
Future<int?> showAgeGateSheet(BuildContext context) {
  return showModalBottomSheet<int>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AegisColors.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
    ),
    builder: (_) => const _AgeGateSheet(),
  );
}

class _AgeGateSheet extends StatefulWidget {
  const _AgeGateSheet();

  @override
  State<_AgeGateSheet> createState() => _AgeGateSheetState();
}

class _AgeGateSheetState extends State<_AgeGateSheet> {
  final _ctrl = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  int get _currentYear => DateTime.now().year;

  void _submit() {
    final raw = _ctrl.text.trim();
    final year = int.tryParse(raw);
    if (year == null || raw.length != 4) {
      setState(() => _error = 'Enter a 4-digit year (e.g. 1985).');
      return;
    }
    if (year < 1900 || year > _currentYear) {
      setState(() => _error = 'That year doesn\'t look right.');
      return;
    }
    if (_currentYear - year < kAegisDialMinAge) {
      setState(
        () => _error =
            'AegisDial is for users aged $kAegisDialMinAge and over.',
      );
      return;
    }
    Navigator.of(context).pop(year);
  }

  @override
  Widget build(BuildContext context) {
    final tt = Theme.of(context).textTheme;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        24, 18, 24, 24 + MediaQuery.of(context).viewInsets.bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
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
          const SizedBox(height: 18),
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AegisColors.turquoise.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Icon(
                  Icons.cake_outlined,
                  color: AegisColors.turquoise,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'One quick thing',
                  style: tt.titleLarge?.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Text(
            'We need your birth year to confirm you\'re old enough to use '
            'AegisDial. Apple doesn\'t share this with us automatically.',
            style: tt.bodyMedium?.copyWith(
              color: AegisColors.textSecondary,
              height: 1.55,
            ),
          ),
          const SizedBox(height: 20),
          TextField(
            controller: _ctrl,
            autofocus: true,
            keyboardType: TextInputType.number,
            inputFormatters: [
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(4),
            ],
            decoration: InputDecoration(
              labelText: 'Birth year',
              hintText: 'e.g. 1985',
              border: const OutlineInputBorder(),
              errorText: _error,
            ),
            onSubmitted: (_) => _submit(),
          ),
          const SizedBox(height: 18),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: _submit,
              style: ElevatedButton.styleFrom(
                backgroundColor: AegisColors.turquoise,
                foregroundColor: Colors.black,
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              child: const Text(
                'Continue',
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  fontSize: 15,
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Center(
            child: TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: Text(
                'Cancel',
                style: tt.bodySmall?.copyWith(
                  color: AegisColors.textTertiary,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
