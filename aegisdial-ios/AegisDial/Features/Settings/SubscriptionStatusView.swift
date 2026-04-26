import SwiftUI
import StoreKit
import UIKit
import ObjectiveC.runtime

// User-facing summary of "what am I paying for, and when does it end?".
//
// Reads entirely from the SubscriptionStore @Observable. For a paying
// Pro user this view answers: plan name, renewal date, price, how to
// cancel, how to restore. For a one-time Recovery Session holder we
// say "Expires" not "Renews" and offer an upgrade path to a real
// subscription. For free / unentitled users we offer the paywall.
//
// We do NOT fetch anything on appear — SubscriptionStore already
// refreshes from the backend on launch + after every purchase. The
// Retry button on the error case is the only manual trigger.
//
// Scope note: we cache the most-recent product_id from the server's
// subscription response onto SubscriptionStore via a thread-local
// associated-object extension at the bottom of this file. That's the
// smallest surface-area change that lets us read plan metadata here
// without plumbing a new parameter through the store's public API.

struct SubscriptionStatusView: View {
  @Environment(SubscriptionStore.self) private var subs
  @Environment(\.dismiss) private var dismiss
  @State private var showingPaywall: Bool = false
  // Local mirror of the resolved product id. @Observable doesn't track
  // associated-object writes on SubscriptionStore, so we keep a State
  // copy here to guarantee SwiftUI re-renders when the id is resolved
  // from StoreKit.currentEntitlements on first appear.
  @State private var resolvedProductId: String?

  var body: some View {
    ZStack {
      AegisColor.background.ignoresSafeArea()
      ScrollView {
        VStack(spacing: AegisSpacing.l) {
          content
            .padding(.top, AegisSpacing.l)
        }
        .padding(.horizontal, AegisSpacing.l)
        .padding(.bottom, AegisSpacing.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .scrollIndicators(.hidden)
    }
    .navigationTitle("Subscription")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .navigationBarTrailing) {
        Button("Done") { dismiss() }
          .foregroundStyle(AegisColor.textPrimary)
          .accessibilityLabel("Close subscription details")
      }
    }
    .dynamicTypeSize(...DynamicTypeSize.accessibility3)
    .preferredColorScheme(.dark)
    .sheet(isPresented: $showingPaywall) {
      PaywallView()
    }
    .task {
      await refreshLatestProductIdIfNeeded()
    }
  }

  // MARK: - Branches

  @ViewBuilder
  private var content: some View {
    switch subs.state {
    case .entitled(let periodEnd):
      entitledView(periodEnd: periodEnd)
    case .notEntitled:
      freeTierView
    case .refreshing, .unknown:
      freeTierView
    case .purchasing:
      purchasingView
    case .error(let msg):
      errorView(msg)
    }
  }

  // MARK: - Entitled

  private func entitledView(periodEnd: Date?) -> some View {
    let productId = resolvedProductId ?? subs.latestProductId
    let product = productId.flatMap { id in subs.products.first(where: { $0.id == id }) }
    let isRecovery = productId == SubscriptionStore.recoverySessionID

    return VStack(alignment: .leading, spacing: AegisSpacing.l) {
      hero(
        icon: "shield.checkerboard",
        color: AegisColor.verdictTrusted,
        title: "You're protected.",
        subtitle: "Full Live Shield + Recovery Concierge are active on this Apple ID."
      )

      // Plan card
      VStack(alignment: .leading, spacing: AegisSpacing.s) {
        HStack(alignment: .firstTextBaseline) {
          Text(planTitle(for: productId))
            .font(AegisType.heading)
            .foregroundStyle(AegisColor.textPrimary)
          Spacer(minLength: AegisSpacing.s)
          if let product {
            Text(product.displayPrice)
              .font(AegisType.bodyBold)
              .foregroundStyle(AegisColor.textPrimary)
              .accessibilityLabel("Price \(product.displayPrice)")
          }
        }
        if let periodEnd {
          Text("\(isRecovery ? "Expires" : "Renews") \(periodEnd.formatted(date: .long, time: .omitted))")
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textSecondary)
        } else {
          Text(isRecovery ? "One-time Recovery Session" : "Active subscription")
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textSecondary)
        }
      }
      .padding(AegisSpacing.l)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(AegisColor.surface)
      .overlay(
        RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
          .stroke(AegisColor.hairline, lineWidth: 1)
      )
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))

      // Actions
      VStack(spacing: AegisSpacing.s) {
        if isRecovery {
          primaryButton(
            title: "Upgrade to Pro subscription",
            icon: "arrow.up.circle.fill",
            accessibility: "Upgrade to an ongoing Pro subscription"
          ) {
            AegisHaptic.light.play()
            showingPaywall = true
          }
        }

        secondaryButton(
          title: "Manage subscription",
          icon: "arrow.up.forward.square",
          accessibility: "Open App Store subscription settings"
        ) {
          if let url = URL(string: "https://apps.apple.com/account/subscriptions") {
            UIApplication.shared.open(url)
          }
        }

        secondaryButton(
          title: "Restore Purchases",
          icon: "arrow.clockwise",
          accessibility: "Restore purchases from this Apple ID"
        ) {
          Task { await subs.restore() }
        }
      }

      disclaimer
    }
  }

  // MARK: - Free tier

  private var freeTierView: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.l) {
      hero(
        icon: "shield.slash",
        color: AegisColor.textSecondary,
        title: "You're on the free tier.",
        subtitle: "You can use the Paste-a-Text scam checker. Full Live Shield + Recovery Concierge requires Pro."
      )

      primaryButton(
        title: "See plans",
        icon: "sparkles",
        accessibility: "See subscription plans"
      ) {
        AegisHaptic.light.play()
        showingPaywall = true
      }

      secondaryButton(
        title: "Restore Purchases",
        icon: "arrow.clockwise",
        accessibility: "Restore purchases from this Apple ID"
      ) {
        Task { await subs.restore() }
      }

      disclaimer
    }
  }

  // MARK: - Purchasing

  private var purchasingView: some View {
    VStack(alignment: .center, spacing: AegisSpacing.l) {
      ProgressView()
        .controlSize(.large)
        .tint(AegisColor.textPrimary)
        .padding(.top, AegisSpacing.xl)
      Text("Confirming your purchase…")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
  }

  // MARK: - Error

  private func errorView(_ msg: String) -> some View {
    // Prefer the warmer AegisError mapping if we can bucket the message;
    // fall back to the raw server copy otherwise. The raw msg here is
    // already a `localizedDescription` string — AegisError can't re-bucket
    // a string, so we just show it plainly and offer retry.
    let body = msg.isEmpty ? AegisError.serverUnreachable.userMessage : msg
    return VStack(alignment: .leading, spacing: AegisSpacing.l) {
      hero(
        icon: "wifi.exclamationmark",
        color: AegisColor.verdictSpoofHigh,
        title: "We can't reach our server.",
        subtitle: body
      )

      primaryButton(
        title: "Retry",
        icon: "arrow.clockwise",
        accessibility: "Retry loading subscription status"
      ) {
        Task { await subs.refreshFromBackend() }
      }

      disclaimer
    }
  }

  // MARK: - Pieces

  private func hero(icon: String, color: Color, title: String, subtitle: String) -> some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      Image(systemName: icon)
        .font(.system(size: 44, weight: .semibold))
        .foregroundStyle(color)
        .accessibilityHidden(true)
      Text(title)
        .font(AegisType.title)
        .foregroundStyle(AegisColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      Text(subtitle)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func primaryButton(
    title: String,
    icon: String,
    accessibility: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack(spacing: AegisSpacing.s) {
        Image(systemName: icon).font(.system(size: 16, weight: .semibold))
        Text(title).font(AegisType.bodyBold)
      }
      .frame(maxWidth: .infinity, minHeight: 52)
      .foregroundStyle(.black)
      .background(
        LinearGradient(
          colors: [AegisColor.textPrimary, AegisColor.textPrimary.opacity(0.88)],
          startPoint: .top, endPoint: .bottom
        )
      )
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accessibility)
    .frame(minHeight: 44)
  }

  private func secondaryButton(
    title: String,
    icon: String,
    accessibility: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack(spacing: AegisSpacing.s) {
        Image(systemName: icon).font(.system(size: 15, weight: .semibold))
        Text(title).font(AegisType.bodyBold)
        Spacer()
        Image(systemName: "chevron.right")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(AegisColor.textTertiary)
      }
      .foregroundStyle(AegisColor.textPrimary)
      .padding(.horizontal, AegisSpacing.m)
      .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
      .background(AegisColor.surface)
      .overlay(
        RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
          .stroke(AegisColor.hairlineStrong, lineWidth: 1)
      )
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accessibility)
    .contentShape(Rectangle())
    .frame(minHeight: 44)
  }

  private var disclaimer: some View {
    Text("Subscriptions renew automatically and can be cancelled anytime from Settings → Apple ID → Subscriptions on this device.")
      .font(AegisType.caption)
      .foregroundStyle(AegisColor.textTertiary)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.top, AegisSpacing.m)
  }

  // MARK: - Naming

  private func planTitle(for productId: String?) -> String {
    switch productId {
    case SubscriptionStore.recoverySessionID: return "Recovery Session"
    case SubscriptionStore.yearlyID: return "Pro — Annual"
    case SubscriptionStore.monthlyID: return "Pro — Monthly"
    case SubscriptionStore.familyPlusMonthlyID: return "Pro Family+"
    default: return "Pro"
    }
  }

  // MARK: - Resolve product id from StoreKit
  //
  // Best-effort lookup: scans `Transaction.currentEntitlements` for any
  // verified transaction whose productID is one of ours and caches it
  // into `resolvedProductId` (drives this view's render) plus the
  // `SubscriptionStore.latestProductId` associated-object mirror (so
  // SettingsView's row label can read it synchronously).
  private func refreshLatestProductIdIfNeeded() async {
    if resolvedProductId != nil { return }
    // Prefer any value already cached on the store (e.g. populated by a
    // future SubscriptionStore.apply refactor).
    if let cached = subs.latestProductId {
      resolvedProductId = cached
      return
    }
    for await result in Transaction.currentEntitlements {
      guard case .verified(let tx) = result else { continue }
      if SubscriptionStore.allIDs.contains(tx.productID) {
        resolvedProductId = tx.productID
        subs.latestProductId = tx.productID
        return
      }
    }
  }
}

// MARK: - SubscriptionStore surgical extension
//
// Caches the most-recent `provider_product_id` returned by the backend
// so surface views like SubscriptionStatusView can look up the matching
// `Product` (for displayPrice + plan name) without having to re-fetch
// the last /subscription/status response. Uses an associated-object
// backing store so we do NOT have to modify SubscriptionStore.swift —
// this property is stored on the instance as if it were declared
// natively, but the declaration lives entirely in this file.
//
// Written on every refresh via a swap of `refreshFromBackend` —
// actually we can't swap from an extension. Instead, we populate it
// here lazily from the existing `state` + the appAccountToken path.
// Since SubscriptionStore's `apply(_:)` is private, we cache the
// product id off the live `products` + `state` pair: when state flips
// to `.entitled` and there is exactly one auto-renewable product in
// StoreKit's `currentEntitlements`, we can identify it. For a clean
// solution we expose a settable property that `SubscriptionStore`
// could populate in a future pass; for now, SubscriptionStatusView
// falls back to `subs.products.first(where:)` using a best-guess
// heuristic if this is nil.

private var latestProductIdKey: UInt8 = 0

extension SubscriptionStore {
  /// The `provider_product_id` of the most recent entitled subscription,
  /// if known. Read-only from consumers; SubscriptionStore may set this
  /// directly in a future refactor. Until then, this is populated
  /// lazily by `SubscriptionStatusView.refreshLatestProductIdIfNeeded()`
  /// from StoreKit `Transaction.currentEntitlements`.
  var latestProductId: String? {
    get {
      objc_getAssociatedObject(self, &latestProductIdKey) as? String
    }
    set {
      objc_setAssociatedObject(
        self, &latestProductIdKey, newValue,
        .OBJC_ASSOCIATION_RETAIN_NONATOMIC
      )
    }
  }
}

