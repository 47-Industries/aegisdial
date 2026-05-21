import 'package:purchases_flutter/purchases_flutter.dart';
import 'package:flutter/foundation.dart';

// RevenueCat iOS public SDK key from dashboard.revenuecat.com →
// Project Settings → API Keys. Injected at build time via Codemagic
// `--dart-define=REVENUECAT_IOS_API_KEY=appl_xxx`. The default is a
// recognizable placeholder so initialize() can short-circuit instead
// of calling Purchases.configure() with garbage (which silently breaks
// every IAP downstream — paywall, restore, entitlement listener).
const _kRevenueCatApiKey = String.fromEnvironment(
  'REVENUECAT_IOS_API_KEY',
  defaultValue: 'REVENUECAT_IOS_API_KEY_PLACEHOLDER',
);
const _kRevenueCatPlaceholder = 'REVENUECAT_IOS_API_KEY_PLACEHOLDER';

// Product IDs — must match App Store Connect in-app purchase IDs exactly.
// Pricing tier locked 2026-05-12 per founder's spec. After the bundle
// ID rename (com.aegiadial.ios → com.aegisdial.app, commit 794a5f0)
// the SKU prefix follows the bundle ID per Apple convention.
const kProductProAnnual = 'com.aegisdial.app.pro.yearly';             // $399/yr
const kProductProMonthly = 'com.aegisdial.app.pro.monthly';           // $49.99/mo
const kProductRecoverySession = 'com.aegisdial.app.recovery.session'; // $149 one-time + 14d Pro
const kProductRecoveryAnnual = 'com.aegisdial.app.recovery.yearly';   // $899/yr (Concierge)
const kProductRecoveryMonthly = 'com.aegisdial.app.recovery.monthly'; // $99/mo (Concierge)

// DEPRECATED 2026-05-12: `aegisdial_family_plus_monthly` ($69.99/mo,
// 3 + 2 add-on lines). The constant lived here so iOS code could
// reference it directly, but every call path (paywall, purchase,
// restore) is now driven through the RevenueCat customer-info object
// keyed by entitlement, not by product_id — so the iOS app needs no
// knowledge of the SKU string. The backend (src/lib/plans.ts,
// src/lib/stripeVerify.ts) is the single resolver for legacy Family+
// subscriptions on both the App Store and Stripe sides.

// Entitlement IDs — must match RevenueCat dashboard entitlements
const _kEntitlementPro = 'pro';
const _kEntitlementRecovery = 'recovery';

// Notified when entitlement status changes (purchase completes, subscription renews, etc.)
typedef EntitlementCallback = void Function(bool isPro);

class PurchaseService {
  static bool _initialized = false;
  static final List<EntitlementCallback> _listeners = [];

  static void addListener(EntitlementCallback cb) => _listeners.add(cb);
  static void removeListener(EntitlementCallback cb) => _listeners.remove(cb);

  /// True only when RevenueCat actually initialized with a real key.
  /// Every IAP path gates on this so a missing build-time secret can't
  /// blow up the app — the paywall buttons fall through gracefully and
  /// log instead of calling into an unconfigured SDK.
  static bool get isConfigured =>
      _initialized && _kRevenueCatApiKey != _kRevenueCatPlaceholder;

  static Future<void> initialize() async {
    if (_initialized) return;
    if (_kRevenueCatApiKey == _kRevenueCatPlaceholder) {
      // Loud warning, not a crash — we want TestFlight builds to keep
      // booting and the rest of the app to work. The paywall surfaces
      // an in-app banner via isConfigured below.
      if (kDebugMode) {
        debugPrint(
          'PurchaseService: REVENUECAT_IOS_API_KEY not provided at build '
          'time (Codemagic env var). All IAP paths will no-op until a '
          'real key is injected via --dart-define=REVENUECAT_IOS_API_KEY=...',
        );
      }
      _initialized = true; // mark so we don't retry on every cold start
      return;
    }
    await Purchases.setLogLevel(kDebugMode ? LogLevel.debug : LogLevel.error);
    final config = PurchasesConfiguration(_kRevenueCatApiKey);
    await Purchases.configure(config);
    // Notify listeners when entitlement status changes in real time
    // (covers purchase completion, renewal, expiry, and restore).
    Purchases.addCustomerInfoUpdateListener((info) {
      final pro = _hasAnyEntitlement(info);
      for (final cb in List.of(_listeners)) {
        cb(pro);
      }
    });
    _initialized = true;
  }

  static Future<Offerings?> getOfferings() async {
    if (!isConfigured) return null;
    try {
      return await Purchases.getOfferings();
    } catch (e) {
      if (kDebugMode) debugPrint('RevenueCat getOfferings error: $e');
      return null;
    }
  }

  static Future<bool> purchaseProduct(String productId) async {
    if (!isConfigured) {
      if (kDebugMode) {
        debugPrint(
          'PurchaseService.purchaseProduct($productId) no-op: RevenueCat '
          'is not configured. Set REVENUECAT_IOS_API_KEY at build time.',
        );
      }
      return false;
    }
    try {
      final offerings = await Purchases.getOfferings();
      final allPackages = offerings.current?.availablePackages ?? [];

      // Fall back to searching all offerings if current is empty
      if (allPackages.isEmpty) {
        for (final offering in offerings.all.values) {
          final pkg = offering.availablePackages
              .where((p) => p.storeProduct.identifier == productId)
              .firstOrNull;
          if (pkg != null) {
            await Purchases.purchasePackage(pkg);
            return true;
          }
        }
      }

      final pkg = allPackages
          .where((p) => p.storeProduct.identifier == productId)
          .firstOrNull;

      if (pkg == null) {
        if (kDebugMode) debugPrint('Product $productId not found in offerings');
        return false;
      }

      await Purchases.purchasePackage(pkg);
      return true;
    } on PurchasesErrorCode catch (e) {
      if (e == PurchasesErrorCode.purchaseCancelledError) return false;
      if (kDebugMode) debugPrint('Purchase error: $e');
      return false;
    } catch (e) {
      if (kDebugMode) debugPrint('Purchase error: $e');
      return false;
    }
  }

  static Future<bool> restorePurchases() async {
    if (!isConfigured) return false;
    try {
      final info = await Purchases.restorePurchases();
      return _hasAnyEntitlement(info);
    } catch (e) {
      if (kDebugMode) debugPrint('Restore error: $e');
      return false;
    }
  }

  static Future<bool> isPro() async {
    if (!isConfigured) return false;
    try {
      final info = await Purchases.getCustomerInfo();
      return _hasAnyEntitlement(info);
    } catch (e) {
      return false;
    }
  }

  /// Tie RevenueCat's app_user_id to AegisDial's stable user id. Called
  /// right after sign-in. Without this, the RevenueCat → backend webhook
  /// has no reliable way to find which DB row to flip to Pro when a
  /// purchase, renewal, or refund event fires server-to-server.
  static Future<void> logIn(String userId) async {
    if (!isConfigured) return;
    try {
      await Purchases.logIn(userId);
    } catch (e) {
      if (kDebugMode) debugPrint('RevenueCat logIn error: $e');
    }
  }

  /// Detach the local install from the previous user's RevenueCat
  /// identity. Called on sign-out so a different account on the same
  /// device doesn't inherit the prior user's entitlement state in cache.
  static Future<void> logOut() async {
    if (!isConfigured) return;
    try {
      await Purchases.logOut();
    } catch (e) {
      if (kDebugMode) debugPrint('RevenueCat logOut error: $e');
    }
  }

  static bool _hasAnyEntitlement(CustomerInfo info) {
    return info.entitlements.active.containsKey(_kEntitlementPro) ||
        info.entitlements.active.containsKey(_kEntitlementRecovery);
  }
}
