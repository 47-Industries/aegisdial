import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'theme/app_theme.dart';
import 'services/auth_service.dart';
import 'services/trial_service.dart';
import 'services/purchase_service.dart';
import 'services/device_service.dart';
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
  await TrialService.ensureStarted();
  await PurchaseService.initialize();
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
