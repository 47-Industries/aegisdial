import SwiftUI

// Post-signin feature tour. Runs exactly once (gated by @AppStorage)
// the first time a user lands on Home after sign-in.
//
// REWRITE 2026-04-19 — twin-pillar repositioning. The old tour led with
// Live Shield and buried everything else as utility. That under-sold the
// moat: AegisDial is the only consumer fraud product that does BOTH
// prevention AND post-event recovery. Every competitor (Truecaller, Hiya,
// AARP helpline) picks one side. The tour now tells that full story.
//
// Page order, top-down:
//   0. Welcome             — frames the twin-pillar pitch.
//   1. Live Shield         — prevention side. On-device AI during the call.
//   2. Recovery Concierge  — recovery side. 15-minute guided playbook.
//   3. Paste-a-Text        — free top-of-funnel; 3-day trial for anon.
//   4. Family plan         — protect 3 family members, shared safe words.
//
// Each page fires `onboarding_tour_page_viewed` with its index + key
// so funnel analytics can measure drop-off between stages. "Skip" fires
// `onboarding_tour_skipped` with the last-seen page.

struct FeatureTourView: View {
  @Environment(\.dismiss) private var dismiss
  @AppStorage("tour_completed_v1") private var tourCompleted: Bool = false
  @State private var page: Int = 0

  // Callbacks kept backward-compatible with HomeView's existing wiring so
  // the content rewrite doesn't ripple into HomeView's sheet-presentation
  // plumbing. Unused hooks stay defined (nil-by-default) for future pages.
  var onGoToLiveShieldDemo: (() -> Void)?
  var onGoToRecoveryStart: (() -> Void)?
  var onGoToProtectParent: (() -> Void)?
  var onGoToFamilyContacts: (() -> Void)?
  var onGoToBreachMonitor: (() -> Void)?
  var onGoToTextAnalyzer: (() -> Void)?

  private static let lastPageIndex = 4

  var body: some View {
    ZStack {
      AegisColor.background.ignoresSafeArea()
      TabView(selection: $page) {
        pageCard(0, "welcome", .init(
          icon: "shield.lefthalf.filled.badge.checkmark",
          title: "The only fraud app that prevents AND recovers.",
          body: "Every other product picks one. AegisDial does both — it stops the call before money moves, and walks you through the first 15 minutes if one ever lands."
        ))
        pageCard(1, "live_shield", .init(
          icon: "phone.badge.waveform",
          title: "Stop the call before money moves.",
          body: "Turn on Live Shield during a suspicious call. On-device AI listens for scam phrases and warns you mid-conversation. Your audio and transcripts never leave your phone.",
          primaryCTA: "Enable Live Shield",
          primaryAction: {
            Track.event(.liveShieldCTATapped, ["source": "tour"])
            Track.event(.demoCallStarted, ["source": "tour"])
            tourCompleted = true
            dismiss()
            Task { @MainActor in
              try? await Task.sleep(nanoseconds: 400_000_000)
              onGoToLiveShieldDemo?()
            }
          }
        ))
        pageCard(2, "recovery_concierge", .init(
          icon: "cross.case.fill",
          title: "If one ever lands, we walk you through it.",
          body: "An AI guide for the first 15 minutes after a scam. 52 scam types, pre-filled FTC and IC3 reports, safe-word family verification. AARP's helpline in your pocket — instant, and tailored to you.",
          primaryCTA: "See how Recovery works",
          primaryAction: {
            Track.event(.recoveryCTATapped, ["source": "tour"])
            withAnimation(AegisMotion.snappy) { page = 3 }
          }
        ))
        pageCard(3, "text_analyzer", .init(
          icon: "text.badge.checkmark",
          title: "Got a sus text? Paste it here.",
          body: "A free scam-text checker — no signup, no payment. Three-day trial for anonymous users, unlimited once you sign in. The fastest way to prove the app works before you commit.",
          primaryCTA: "Try it now",
          primaryAction: {
            tourCompleted = true
            dismiss()
            Task { @MainActor in
              try? await Task.sleep(nanoseconds: 400_000_000)
              onGoToTextAnalyzer?()
            }
          }
        ))
        pageCard(4, "family_plan", .init(
          icon: "figure.2.and.child.holdinghands",
          title: "Protect 3 family members.",
          body: "Share safe words. Get a ping the moment a parent's call goes critical. Most scam-call victims are older family — this is the reason adult children buy AegisDial in the first place.",
          primaryCTA: "Get started",
          primaryAction: {
            Track.event(.protectParentFlowStarted, ["source": "tour"])
            Track.event(.onboardingTourCompleted)
            tourCompleted = true
            dismiss()
            Task { @MainActor in
              try? await Task.sleep(nanoseconds: 400_000_000)
              onGoToProtectParent?()
            }
          }
        ))
      }
      .tabViewStyle(.page(indexDisplayMode: .always))
      .indexViewStyle(.page(backgroundDisplayMode: .always))
      .onChange(of: page) { _, newPage in
        Track.event(.onboardingTourPageViewed, [
          "page_index": newPage,
          "feature": Self.featureKey(for: newPage),
        ])
      }

      VStack {
        HStack {
          Spacer()
          Button("Skip") {
            Track.event(.onboardingTourSkipped, [
              "last_page_index": page,
              "last_feature": Self.featureKey(for: page),
            ])
            tourCompleted = true
            dismiss()
          }
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textSecondary)
          .padding()
        }
        Spacer()
      }
    }
    .onAppear {
      Track.event(.onboardingTourPageViewed, [
        "page_index": 0,
        "feature": Self.featureKey(for: 0),
      ])
    }
    .onDisappear {
      // Reaching the final page + dismissing counts as completed; the
      // skip button + last-page primary action handle the rest.
      if page >= Self.lastPageIndex {
        Track.event(.onboardingTourCompleted)
      }
    }
    // NOTE: aging-parent DynamicType pass 2026-04-19
    // Clamp at AX3 so page titles + CTAs stay on-screen at the largest
    // commonly-used accessibility sizes without clipping the TabView dots.
    .dynamicTypeSize(...DynamicTypeSize.accessibility3)
  }

  private static func featureKey(for index: Int) -> String {
    switch index {
    case 0: return "welcome"
    case 1: return "live_shield"
    case 2: return "recovery_concierge"
    case 3: return "text_analyzer"
    case 4: return "family_plan"
    default: return "unknown"
    }
  }

  private struct PageContent {
    let icon: String
    let title: String
    let body: String
    var primaryCTA: String? = nil
    var primaryAction: (() -> Void)? = nil
  }

  @ViewBuilder
  private func pageCard(_ index: Int, _ featureKey: String, _ c: PageContent) -> some View {
    VStack(spacing: AegisSpacing.l) {
      Spacer()
      Image(systemName: c.icon)
        .font(.system(size: 72, weight: .semibold))
        .foregroundStyle(AegisColor.accent)
        .padding(AegisSpacing.l)
        .background(AegisColor.accentGlow)
        .clipShape(Circle())
      // NOTE: aging-parent DynamicType pass 2026-04-19
      // 28pt bold doesn't map cleanly to a token; keep the size but let it
      // shrink rather than truncate at AX3.
      Text(c.title)
        .font(.system(size: 28, weight: .bold))
        .multilineTextAlignment(.center)
        .minimumScaleFactor(0.7)
        .foregroundStyle(AegisColor.textPrimary)
        .padding(.horizontal, AegisSpacing.l)
      Text(c.body)
        .font(AegisType.body)
        .multilineTextAlignment(.center)
        .foregroundStyle(AegisColor.textSecondary)
        .padding(.horizontal, AegisSpacing.xl)
      Spacer()
      if let cta = c.primaryCTA, let action = c.primaryAction {
        Button(action: action) {
          Text(cta)
            .font(AegisType.bodyBold)
            .foregroundStyle(.black)
            .frame(maxWidth: .infinity, minHeight: 54)
            .background(AegisColor.accent)
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        }
        .padding(.horizontal, AegisSpacing.l)
      } else {
        // Every page gets a primary Continue CTA — aging-parent testers
        // previously swiped past dot-only pages by accident. Last page
        // always ships an explicit primaryCTA above, so this branch only
        // fires for the Welcome page.
        Button {
          if index >= Self.lastPageIndex {
            Track.event(.onboardingTourCompleted)
            tourCompleted = true
            dismiss()
          } else {
            withAnimation(AegisMotion.snappy) { page = index + 1 }
          }
        } label: {
          Text(index >= Self.lastPageIndex ? "Get started" : "Continue")
            .font(AegisType.bodyBold)
            .foregroundStyle(.black)
            .frame(maxWidth: .infinity, minHeight: 54)
            .background(AegisColor.accent)
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        }
        .padding(.horizontal, AegisSpacing.l)
      }
      Spacer().frame(height: 60) // room for page indicator
    }
    .tag(index)
  }
}
