import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:aegisdial_app/services/auth_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('AuthService boots without throwing', () async {
    await auth.boot();
    expect(auth.isBooted, isTrue);
    expect(auth.isSignedIn, isFalse);
  });
}
