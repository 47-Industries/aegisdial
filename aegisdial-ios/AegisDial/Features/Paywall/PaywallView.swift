import SwiftUI
import StoreKit

// Shown after sign-in when the user hasn't yet subscribed.
//
// Positioning (2026-04-19): "the only fraud product that does both —
// stop the call before it lands, AND walk you through recovery if one
// ever does." Every other consumer scam product picks one. Truecaller,
// Hiya, RoboKiller, Apple Live Caller ID, carrier scam shields all do
// prevention only. AARP's helpline + FTC reportfraud.ftc.gov are
// recovery only. We're the integrated layer.
//
// $99 Recovery Session is the default-selected SKU because it's the
// lowest-commitment way for a new user to try us (no subscription,
// just-in-case purchase). Subscriptions sit alongside as the "ongoing
// protection" upsell. Free scam-text checker is reachable as an
// escape hatch at the bottom for the truly hesitant.

struct PaywallView: View {
  @Environment(AuthStore.self) private var auth
  @Environment(SubscriptionStore.self) private var subs

  @State private var selectedID: String = SubscriptionStore.recoverySessionID
  @State private var glow = false
  @State private var showingFreeAnalyzer = false

  var body: some View {
    ZStack {
      AegisColor.background.ignoresSafeArea()
      backgroundGlow

      ScrollView {
        VStack(spacing: AegisSpacing.l) {
          header
            .padding(.top, AegisSpacing.xxl)

          valueProps
            .padding(.top, AegisSpacing.l)

          planPicker
            .padding(.top, AegisSpacing.l)

          primaryCTA
          secondaryRow

          freeAnalyzerEscape

          footer
          .padding(.bottom, AegisSpacing.xl)
        }
        .padding(.horizontal, AegisSpacing.l)
      }
      .scrollIndicators(.hidden)
    }
    .sheet(isPresented: $showingFreeAnalyzer) {
      // Free scam-text checker. The analyzer's "Talk to Companion"
      // CTA fires onOpenTriage — for the paywall presentation we just
      // dismiss; the user is already on the paywall, the next tap is
      // theirs to make. (When this analyzer is opened from HomeView
      // for an entitled user, onOpenTriage opens triage directly.)
      // ScamTextAnalyzerView ships its own NavigationStack so we
      // present it directly — no outer wrapper needed.
      ScamTextAnalyzerView(
        onOpenTriage: { _, _ in showingFreeAnalyzer = false }
      )
      .presentationDetents([.large])
    }
    .task {
      if subs.products.isEmpty { await subs.loadProducts() }
      await subs.refreshFromBackend()
    }
    .onAppear {
      withAnimation(.easeInOut(duration: 3.4).repeatForever(autoreverses: true)) { glow.toggle() }
    }
  }

  private var backgroundGlow: some View {
    ZStack {
      RadialGradient(
        colors: [AegisColor.accentGlow.opacity(glow ? 0.45 : 0.22), .clear],
        center: .topLeading, startRadius: 10, endRadius: 420
      ).blendMode(.screen).ignoresSafeArea()
      RadialGradient(
        colors: [AegisColor.verdictTrusted.opacity(glow ? 0.18 : 0.08), .clear],
        center: .bottomTrailing, startRadius: 10, endRadius: 480
      ).blendMode(.screen).ignoresSafeArea()
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      HStack(spacing: AegisSpacing.s) {
        Image(systemName: "shield.lefthalf.filled.badge.checkmark")
          .font(.system(size: 28, weight: .semibold))
          .foregroundStyle(AegisColor.accent.gradient)
          .accessibilityHidden(true)
        Text("PREVENT + RECOVER")
          .font(.system(size: 12, weight: .heavy, design: .rounded))
          .tracking(2)
          .foregroundStyle(AegisColor.accent)
      }
      Text("Stop the call. And if one ever lands,\nwe walk you through it.")
        .font(AegisType.title)
        .foregroundStyle(AegisColor.textPrimary)
        .lineSpacing(4)
        .minimumScaleFactor(0.7)
      Text("Every other scam product makes you pick one — block calls, OR get help after a scam. AegisDial is the only one that does both, because no prevention is perfect and recovery without prevention means you'll get hit again.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var valueProps: some View {
    VStack(spacing: AegisSpacing.s) {
      valueRow(icon: "waveform.path.ecg", title: "Live Shield — stop the call",
               detail: "On-device AI listens for scam patterns mid-call and warns you before money moves. Transcripts never leave your phone. Truecaller and Hiya can't do this.")
      valueRow(icon: "cross.case.fill", title: "Recovery Concierge — if one lands",
               detail: "AI guide for the first 15 minutes after a scam: bank calls, credit freezes, FTC and IC3 reports, telling your family. 52 scam types. Nobody else has this.")
      valueRow(icon: "person.2.fill", title: "Family safe words + Guardian alerts",
               detail: "When the 'grandchild emergency' call comes, the real grandchild knows the word. The scammer doesn't.")
      valueRow(icon: "lock.shield.fill", title: "Breach Monitor",
               detail: "Get alerted when your email shows up in a new data breach. Add up to 5 family members on Family+.")
    }
  }

  private func valueRow(icon: String, title: String, detail: String) -> some View {
    HStack(alignment: .top, spacing: AegisSpacing.m) {
      Image(systemName: icon)
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(AegisColor.accent)
        .frame(width: 28, height: 28)
        .background(AegisColor.accent.opacity(0.14))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(AegisType.bodyBold).foregroundStyle(AegisColor.textPrimary)
        Text(detail).font(AegisType.caption).foregroundStyle(AegisColor.textSecondary).fixedSize(horizontal: false, vertical: true)
      }
      Spacer()
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairline, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var planPicker: some View {
    VStack(spacing: AegisSpacing.m) {
      ForEach(subs.products, id: \.id) { product in
        planCard(product)
      }
      if subs.products.isEmpty {
        ProgressView().tint(AegisColor.textPrimary).padding(AegisSpacing.l)
      }
    }
  }

  private func planCard(_ product: Product) -> some View {
    let isSelected = product.id == selectedID
    let meta = metaFor(product)
    return Button {
      AegisHaptic.selection.play()
      withAnimation(AegisMotion.snappy) { selectedID = product.id }
    } label: {
      HStack(spacing: AegisSpacing.m) {
        ZStack {
          Circle().stroke(AegisColor.hairlineStrong, lineWidth: 2).frame(width: 24, height: 24)
          if isSelected {
            Circle().fill(AegisColor.accent).frame(width: 14, height: 14)
          }
        }
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: AegisSpacing.s) {
            Text(meta.title).font(AegisType.bodyBold).foregroundStyle(AegisColor.textPrimary)
            if let badge = meta.badge {
              Text(badge)
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .tracking(1)
                .foregroundStyle(.black)
                .padding(.horizontal, 6).padding(.vertical, 3)
                .background(AegisColor.verdictTrusted)
                .clipShape(Capsule())
            }
          }
          Text(meta.subtitle).font(AegisType.caption).foregroundStyle(AegisColor.textSecondary)
        }
        Spacer()
        VStack(alignment: .trailing, spacing: 2) {
          Text(product.displayPrice).font(AegisType.heading).foregroundStyle(AegisColor.textPrimary)
          Text(meta.cadence).font(AegisType.caption).foregroundStyle(AegisColor.textTertiary)
        }
      }
      .padding(AegisSpacing.l)
      .background(isSelected ? AegisColor.surfaceElevated : AegisColor.surface)
      .overlay(
        RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous)
          .stroke(isSelected ? AegisColor.accent : AegisColor.hairlineStrong, lineWidth: isSelected ? 2 : 1)
      )
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous))
      .shadow(color: isSelected ? AegisColor.accentGlow : .clear, radius: 14)
    }
    .buttonStyle(.plain)
  }

  private struct PlanMeta {
    let title: String
    let subtitle: String
    let badge: String?
    let cadence: String
  }

  private func metaFor(_ product: Product) -> PlanMeta {
    switch product.id {
    case SubscriptionStore.recoverySessionID:
      return PlanMeta(
        title: "Single Recovery Session",
        subtitle: "30 days of full access · for one scam event · no subscription",
        badge: "JUST ONCE",
        cadence: "one-time"
      )
    case SubscriptionStore.yearlyID:
      return PlanMeta(
        title: "Pro — Annual",
        subtitle: "3 lines · $24.92/mo equivalent · billed once per year",
        badge: "SAVE 50%",
        cadence: "/ year"
      )
    case SubscriptionStore.familyPlusMonthlyID:
      return PlanMeta(
        title: "Pro Family+",
        subtitle: "5 lines · extended family coverage",
        badge: "5 LINES",
        cadence: "/ month"
      )
    default:
      return PlanMeta(
        title: "Pro",
        subtitle: "3 lines · billed monthly · cancel anytime",
        badge: nil,
        cadence: "/ month"
      )
    }
  }

  private var primaryCTA: some View {
    let isRecovery = selectedID == SubscriptionStore.recoverySessionID
    return Button {
      guard let product = subs.products.first(where: { $0.id == selectedID }) else { return }
      Task { await subs.purchase(product) }
    } label: {
      HStack {
        if case .purchasing = subs.state {
          ProgressView().tint(.black)
        } else {
          Text(isRecovery ? "Start Recovery now" : "Activate Protection")
            .font(AegisType.bodyBold)
          Image(systemName: "arrow.right").font(.system(size: 14, weight: .bold))
        }
      }
      .frame(maxWidth: .infinity, minHeight: 56)
      .foregroundStyle(.black)
      .background(
        LinearGradient(
          colors: [AegisColor.textPrimary, AegisColor.textPrimary.opacity(0.88)],
          startPoint: .top, endPoint: .bottom
        )
      )
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      .shadow(color: AegisColor.accentGlow, radius: 18)
    }
    .disabled(subs.products.isEmpty || subs.state == .purchasing)
    .padding(.top, AegisSpacing.s)
  }

  // Free escape hatch — the viral wedge entry point. A user who landed
  // here without an immediate scam to recover from can use the free
  // scam-text checker to evaluate the product without paying. After
  // they get a verdict, the analyzer's own "Start Recovery" CTA brings
  // them back to this paywall warmer.
  private var freeAnalyzerEscape: some View {
    VStack(spacing: AegisSpacing.s) {
      Text("Not sure yet? Try the free scam-text checker.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textSecondary)
        .multilineTextAlignment(.center)
      Button {
        AegisHaptic.light.play()
        showingFreeAnalyzer = true
      } label: {
        HStack(spacing: AegisSpacing.s) {
          Image(systemName: "text.magnifyingglass")
          Text("Open free scam-text checker").font(AegisType.bodyBold)
        }
        .frame(maxWidth: .infinity, minHeight: 48)
        .foregroundStyle(AegisColor.textPrimary)
        .overlay(
          RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
            .stroke(AegisColor.hairlineStrong, lineWidth: 1)
        )
      }
    }
    .padding(.top, AegisSpacing.l)
  }

  private var secondaryRow: some View {
    HStack(spacing: AegisSpacing.m) {
      Button("Restore Purchases") { Task { await subs.restore() } }
        .font(AegisType.caption).foregroundStyle(AegisColor.textSecondary)
      Spacer()
      Button("Sign Out") { auth.signOut() }
        .font(AegisType.caption).foregroundStyle(AegisColor.textTertiary)
    }
  }

  private var footer: some View {
    VStack(spacing: AegisSpacing.xs) {
      if case .error(let msg) = subs.state {
        Text(msg).font(AegisType.caption).foregroundStyle(AegisColor.verdictSpoofHigh).multilineTextAlignment(.center)
      }
      Text("Your subscription renews automatically and can be cancelled anytime from Settings > Apple ID > Subscriptions. We will never sell your lookup history.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .multilineTextAlignment(.center)
        .padding(.top, AegisSpacing.m)
    }
  }
}
