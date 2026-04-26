import Foundation
import StoreKit
import Observation

// Source of truth for "is this user entitled to use AegisDial right now?"
// Wraps StoreKit 2 (for in-app purchases) and pokes the backend's
// /subscription/status endpoint for server-authoritative state. The
// app always trusts the backend over local StoreKit state — if someone
// requests a refund or the receipt expires, the server catches it first.

@MainActor
@Observable
final class SubscriptionStore {
  enum State: Equatable {
    case unknown
    case refreshing
    case entitled(periodEnd: Date?)
    case notEntitled(reason: Reason)
    case purchasing
    case error(String)
  }

  enum Reason: String {
    case pending = "Subscribe to activate bank-grade live protection."
    case expired = "Your subscription has ended. Resubscribe to continue."
    case cancelled = "Your subscription was cancelled. Resubscribe to continue."
  }

  // Product IDs — must match what's configured in App Store Connect.
  // Keep in a single constant so we can swap them for a test sandbox.
  //
  // Catalog (effective 2026-04-19):
  //   Pro (3 lines)              $49.99 / mo  or  $299 / yr   (auto-renewable)
  //   Pro Family+ (5 lines)      $69.99 / mo                  (auto-renewable)
  //   Recovery Session (1 user)  $99 one-time, 30-day grant   (NON-CONSUMABLE)
  //
  // Family+ adds 2 seats to the base plan. When a user upgrades from Pro to
  // Family+, StoreKit handles the proration automatically because both SKUs
  // live in the same App Store subscription group.
  //
  // Recovery Session is the wedge SKU — for victims who just got scammed and
  // want guided recovery WITHOUT a subscription commitment. Configured in
  // App Store Connect as a NON-CONSUMABLE in-app purchase, NOT an
  // auto-renewable subscription. Backend grants 30-day Pro on verify.
  static let monthlyID = "com.aegisdial.ios.pro.monthly"
  static let yearlyID = "com.aegisdial.ios.pro.yearly"
  static let familyPlusMonthlyID = "com.aegisdial.ios.pro.family_plus.monthly"
  static let recoverySessionID = "com.aegisdial.ios.recovery.session"

  static let allIDs: Set<String> = [
    monthlyID, yearlyID, familyPlusMonthlyID, recoverySessionID,
  ]

  var state: State = .unknown
  private(set) var products: [Product] = []
  // Server-assigned stable UUID we feed into `Product.purchase(options:)`
  // so StoreKit 2 ties the resulting originalTransactionID to our user
  // row. Populated from `/subscription/status`. Nil on first launch
  // before the backend has seen this device — in that case we pass an
  // empty options set; the backend's DB ownership precheck covers the
  // anti-replay gap.
  private(set) var appAccountToken: UUID?
  private var transactionWatcher: Task<Void, Never>?

  init() { transactionWatcher = Task { await listenForTransactions() } }

  deinit { transactionWatcher?.cancel() }

  // Load App Store product metadata for the paywall.
  func loadProducts() async {
    do {
      products = try await Product.products(for: Self.allIDs)
        .sorted { lhs, rhs in
          // Put Pro Monthly first, then Pro Yearly, then Family+
          // Recovery Session first (the wedge SKU — "I just need help once").
          // Then subscriptions in escalating commitment order.
          let order: [String: Int] = [
            Self.recoverySessionID: 0,
            Self.monthlyID: 1,
            Self.yearlyID: 2,
            Self.familyPlusMonthlyID: 3,
          ]
          return (order[lhs.id] ?? 99) < (order[rhs.id] ?? 99)
        }
    } catch {
      state = .error("Couldn't load subscription options: \(error.localizedDescription)")
    }
  }

  // Ask the backend what the server thinks of this user.
  //
  // Transient-failure policy: if we were previously `.entitled` and the
  // network blips (subway, airplane mode, Fly cold-start), staying
  // entitled is the right call. The paying user should not see a paywall
  // because of a 10-second request timeout. Next successful refresh
  // reconciles. If the server authoritatively says they're not entitled,
  // apply() flips the state — that path is unchanged.
  func refreshFromBackend() async {
    let priorEntitledEnd: Date??  // double-optional: inner nil = entitled without end date
    if case .entitled(let end) = state { priorEntitledEnd = .some(end) } else { priorEntitledEnd = nil }
    state = .refreshing
    do {
      let status = try await APIClient.shared.subscriptionStatus()
      apply(status)
    } catch {
      if let end = priorEntitledEnd {
        // Restore the prior entitled state — don't punish a paying user
        // for a flaky network. The next successful refresh reconciles.
        state = .entitled(periodEnd: end)
      } else {
        state = .error(error.localizedDescription)
      }
    }
  }

  func purchase(_ product: Product) async {
    state = .purchasing
    AegisHaptic.medium.play()
    do {
      // If the backend has handed us an appAccountToken, pass it through
      // as a StoreKit purchase option so Apple records it on the
      // transaction. If it's nil (first launch before backend seen),
      // omit the option entirely — an empty options set is valid.
      let options: Set<Product.PurchaseOption> = appAccountToken.map {
        [.appAccountToken($0)]
      } ?? []
      let result = try await product.purchase(options: options)
      switch result {
      case .success(let verification):
        let transaction = try checkVerified(verification)
        await forwardToBackend(transaction: transaction)
        await transaction.finish()
        AegisHaptic.success.play()
      case .userCancelled:
        AegisHaptic.light.play()
        await refreshFromBackend() // revert to prior state
      case .pending:
        state = .notEntitled(reason: .pending)
      @unknown default:
        state = .error("Unexpected purchase state.")
      }
    } catch {
      AegisHaptic.error.play()
      state = .error(error.localizedDescription)
    }
  }

  func restore() async {
    state = .refreshing
    do {
      try await AppStore.sync()
      for await result in Transaction.currentEntitlements {
        if case .verified(let transaction) = result,
           transaction.productType == .autoRenewable {
          await forwardToBackend(transaction: transaction)
        }
      }
      await refreshFromBackend()
    } catch {
      state = .error(error.localizedDescription)
    }
  }

  // MARK: - Internal

  private func apply(_ status: SubscriptionStatus) {
    // Capture the server-assigned appAccountToken on every refresh so
    // the next purchase() call can thread it through to StoreKit. Only
    // overwrite when the server actually sent a value — a momentarily
    // absent field (older API build) should not erase a previously
    // known good token.
    if let tokenString = status.appAccountToken,
       let token = UUID(uuidString: tokenString) {
      appAccountToken = token
    }

    if status.active {
      let end = status.subscription.flatMap { iso($0.currentPeriodEnd) }
      state = .entitled(periodEnd: end)
    } else {
      let reason: Reason
      switch status.tier {
      case .expired: reason = .expired
      case .cancelled: reason = .cancelled
      case .pending, .pro: reason = .pending
      }
      state = .notEntitled(reason: reason)
    }
  }

  private func iso(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
  }

  private func listenForTransactions() async {
    for await result in Transaction.updates {
      switch result {
      case .verified(let transaction):
        await forwardToBackend(transaction: transaction)
        await transaction.finish()
      case .unverified(let transaction, let error):
        // StoreKit handed us a transaction whose JWS didn't validate
        // against Apple's cert chain. Never forward to the backend —
        // Apple would reject it and it could mask tampering. We DO
        // call `.finish()` so the same bogus transaction doesn't get
        // re-queued on every relaunch (Transaction.updates will keep
        // emitting it otherwise). A legitimate purchase retry comes
        // back through `purchase()` with a fresh verified transaction.
        #if DEBUG
        print("SubscriptionStore: dropping unverified StoreKit transaction id=\(transaction.id) err=\(error)")
        #endif
        await transaction.finish()
      }
    }
  }

  private func forwardToBackend(transaction: Transaction) async {
    // `jwsRepresentation` is a non-optional String in StoreKit 2; the
    // previous `?? "" as String?` was dead code that always bound to
    // the raw value (or empty string), which we'd then forward to the
    // backend for Apple to reject with "invalid_jws". Guard on
    // emptiness explicitly instead so malformed transactions never
    // hit our verify endpoint.
    let jwsRepresentation = transaction.jwsRepresentation
    guard !jwsRepresentation.isEmpty else {
      // Empty JWS shouldn't happen on a verified StoreKit 2 transaction,
      // but if it does we must not silently return — the caller is
      // still sitting in `.purchasing` and the paywall would deadlock.
      // Surface a recoverable error so the user can tap Restore.
      state = .error("Purchase completed but the receipt is missing. Tap Restore Purchases to re-sync.")
      return
    }
    do {
      _ = try await APIClient.shared.verifyAppleTransaction(
        jws: jwsRepresentation,
        productId: transaction.productID,
        expiresDateMs: transaction.expirationDate.map { Int64($0.timeIntervalSince1970 * 1000) },
        originalTransactionId: String(transaction.originalID)
      )
      await refreshFromBackend()
    } catch {
      // Stay in the current state and let the next refresh reconcile.
      state = .error("Couldn't confirm purchase with server: \(error.localizedDescription)")
    }
  }

  private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
    switch result {
    case .verified(let safe): return safe
    case .unverified(_, let error): throw error
    }
  }
}
