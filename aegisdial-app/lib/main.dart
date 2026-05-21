import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'theme/app_theme.dart';
import 'services/api_service.dart';
import 'services/auth_service.dart';
import 'services/trial_service.dart';
import 'services/purchase_service.dart';
import 'services/device_service.dart';
import 'services/app_version.dart';
import 'screens/splash_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.light,
      systemNavigationBarColor: Color(0xFF000000),
      systemNavigationBarIconBrightness: Brightness.light,
    ),
  );
  await auth.boot();
  // After auth boots, wire 401 → sign-out so stale tokens don't trap
  // the user in a half-authenticated state.
  api.onSessionExpired = auth.signOut;
  await TrialService.ensureStarted();
  await PurchaseService.initialize();
  // Cache the app version once at boot so Settings → About + the push
  // diagnostic don't have to FutureBuilder it. Cheap (single platform
  // channel call), and means we stop hand-editing the version string
  // every time pubspec gets bumped.
  await AppVersion.load();
  // Wire the APNs channel handler synchronously at boot so any
  // late-arriving token from a previous registration (token rotation
  // during a cold start) is delivered to a live handler — the system
  // queues the message until a handler is set.
  deviceService.wire();
  runApp(const AegisDialApp());
}

class AegisDialApp extends StatelessWidget {
  const AegisDialApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AegisDial',
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.dark,
      darkTheme: AppTheme.dark(),
      home: const SplashScreen(),
    );
  }
}
