import SwiftUI

// Top-level routing.
//   - .signedOut / .error  -> Onboarding (Apple + Email)
//   - .signingIn           -> Onboarding with loading overlay
//   - .signedIn + subscription.entitled   -> Home (the real app)
//   - .signedIn + subscription.notEntitled -> Paywall (hard gate)
// We always refresh subscription state when signing in and every time the
// app returns to the foreground, so a subscription purchased on another
// device appears here within seconds.

struct AppRootView: View {
  @Environment(AuthStore.self) private var auth
  @Environment(SubscriptionStore.self) private var subs
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    ZStack {
      switch auth.state {
      case .signedOut, .error:
        OnboardingView()
          .transition(.opacity)
      case .signingIn:
        OnboardingView()
          .overlay(loadingOverlay)
          .transition(.opacity)
      case .signedIn:
        entitledRoute
          .transition(.opacity.combined(with: .scale(scale: 0.98)))
      }
    }
    .animation(AegisMotion.spring, value: stateIsSignedIn)
    .animation(AegisMotion.spring, value: subsIsEntitled)
    .task(id: authIdentityKey) { await subs.refreshFromBackend() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active, case .signedIn = auth.state {
        Task { await subs.refreshFromBackend() }
      }
    }
  }

  @ViewBuilder
  private var entitledRoute: some View {
    switch subs.state {
    case .entitled:
      AppShellView()
    case .unknown, .refreshing:
      loadingFullscreen
    case .notEntitled, .error, .purchasing:
      PaywallView()
    }
  }

  private var stateIsSignedIn: Bool {
    if case .signedIn = auth.state { return true }
    return false
  }

  private var subsIsEntitled: Bool {
    if case .entitled = subs.state { return true }
    return false
  }

  // Refresh entitlement whenever the signed-in user identity changes.
  private var authIdentityKey: String {
    if case .signedIn(let ctx) = auth.state { return ctx.userId }
    return "signed-out"
  }

  private var loadingOverlay: some View {
    ZStack {
      Color.black.opacity(0.35).ignoresSafeArea()
      VStack(spacing: AegisSpacing.m) {
        ProgressView().tint(AegisColor.textPrimary).scaleEffect(1.2)
        Text("Signing you in...").font(AegisType.caption).foregroundStyle(AegisColor.textSecondary)
      }
      .padding(AegisSpacing.xl)
      .background(AegisColor.surfaceElevated)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous))
    }
    .transition(.opacity)
  }

  private var loadingFullscreen: some View {
    ZStack {
      AegisColor.background.ignoresSafeArea()
      VStack(spacing: AegisSpacing.m) {
        Image(systemName: "shield.lefthalf.filled")
          .font(.system(size: 32, weight: .semibold))
          .foregroundStyle(AegisColor.accent)
          .symbolEffect(.pulse, options: .repeating)
        Text("Checking your subscription...")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textSecondary)
      }
    }
  }
}
