import 'package:purchases_flutter/purchases_flutter.dart';
import 'package:flutter/foundation.dart';

// Replace with your RevenueCat iOS public SDK key from dashboard.revenuecat.com
const _kRevenueCatApiKey = 'REVENUECAT_IOS_API_KEY_PLACEHOLDER';

// Product IDs — must match App Store Connect in-app purchase IDs exactly
const kProductProAnnual = 'aegisdial_pro_annual';
const kProductProMonthly = 'aegisdial_pro_monthly';
const kProductRecoverySession = 'aegisdial_recovery_session';

// Entitlement IDs — must match RevenueCat dashboard entitlements
const _kEntitlementPro = 'pro';
const _kEntitlementRecovery = 'recovery';

class PurchaseService {
  static bool _initialized = false;

  static Future<void> initialize() async {
    if (_initialized) return;
    await Purchases.setLogLevel(kDebugMode ? LogLevel.debug : LogLevel.error);
    final config = PurchasesConfiguration(_kRevenueCatApiKey);
    await Purchases.configure(config);
    _initialized = true;
  }

  static Future<Offerings?> getOfferings() async {
    try {
      return await Purchases.getOfferings();
    } catch (e) {
      debugPrint('RevenueCat getOfferings error: $e');
      return null;
    }
  }

  static Future<bool> purchaseProduct(String productId) async {
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
        debugPrint('Product $productId not found in offerings');
        return false;
      }

      await Purchases.purchasePackage(pkg);
      return true;
    } on PurchasesErrorCode catch (e) {
      if (e == PurchasesErrorCode.purchaseCancelledError) return false;
      debugPrint('Purchase error: $e');
      return false;
    } catch (e) {
      debugPrint('Purchase error: $e');
      return false;
    }
  }

  static Future<bool> restorePurchases() async {
    try {
      final info = await Purchases.restorePurchases();
      return _hasAnyEntitlement(info);
    } catch (e) {
      debugPrint('Restore error: $e');
      return false;
    }
  }

  static Future<bool> isPro() async {
    try {
      final info = await Purchases.getCustomerInfo();
      return _hasAnyEntitlement(info);
    } catch (e) {
      return false;
    }
  }

  static bool _hasAnyEntitlement(CustomerInfo info) {
    return info.entitlements.active.containsKey(_kEntitlementPro) ||
        info.entitlements.active.containsKey(_kEntitlementRecovery);
  }
}
