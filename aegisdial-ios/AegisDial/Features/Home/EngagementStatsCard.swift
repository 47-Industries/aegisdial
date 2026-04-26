import SwiftUI

// Home-screen engagement card. Four metrics the user sees first thing
// when they open the app. Copy is warm and specific — "shielded 4
// calls this week" lands better than "shield sessions: 4".
//
// Pulled on Home load + pull-to-refresh. Silent failure keeps Home
// from breaking when the user is offline; the card just hides.

struct EngagementStatsCard: View {
  @State private var stats: APIClient.StatsSummary?
  @State private var loading: Bool = true

  var body: some View {
    if let s = stats {
      card(s)
        .transition(.opacity.combined(with: .scale(scale: 0.98)))
    } else if loading {
      skeleton
    }
    // When load fails, render nothing — Home isn't broken without this.
    else {
      EmptyView()
    }
  }

  private func card(_ s: APIClient.StatsSummary) -> some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      HStack(spacing: 6) {
        Image(systemName: "shield.lefthalf.filled")
          .foregroundStyle(AegisColor.accent)
          .accessibilityHidden(true)
        Text("YOUR PROTECTION")
          .font(AegisType.caption)
          .tracking(1.4)
          .foregroundStyle(AegisColor.textSecondary)
      }

      HStack(spacing: AegisSpacing.m) {
        stat(
          value: s.shieldsThisWeek,
          label: "shields\nthis week",
          color: AegisColor.accent
        )
        stat(
          value: s.criticalCallsAvoided30d,
          label: "scams\navoided (30d)",
          color: AegisColor.verdictTrusted
        )
        stat(
          value: s.scamsBlockedAllTime,
          label: "blocked\nall time",
          color: AegisColor.verdictSuspicious
        )
      }

      if s.breachesFound30d > 0 {
        breachRow(count: s.breachesFound30d)
      }
    }
    .padding(AegisSpacing.l)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.surface)
    .overlay(
      RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous)
        .stroke(AegisColor.hairline, lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "Protection summary: \(s.shieldsThisWeek) shields this week, " +
      "\(s.criticalCallsAvoided30d) scams avoided in 30 days, " +
      "\(s.scamsBlockedAllTime) blocked all time."
    )
    // NOTE: aging-parent DynamicType pass 2026-04-19
    // Clamp the stats card at AX3. Above AX3 three-column layout breaks
    // regardless of scale factor — card-level clamp keeps it usable without
    // limiting the rest of Home.
    .dynamicTypeSize(...DynamicTypeSize.accessibility3)
  }

  private func stat(value: Int, label: String, color: Color) -> some View {
    // NOTE: aging-parent DynamicType pass 2026-04-19
    // Numbers were locked at 32pt (non-scaling) while labels scaled via
    // AegisType.caption — at AX3 the caption outgrew the number and the row
    // went asymmetric. Preserve the 32pt default (don't change the home-card
    // look for younger users), but add minimumScaleFactor(0.5) + lineLimit(1)
    // so at AX3-AX5 the numeric shrinks instead of truncating, and clamp the
    // card root so three stats stay side-by-side.
    VStack(alignment: .leading, spacing: 4) {
      Text("\(value)")
        .font(.system(size: 32, weight: .bold, design: .rounded))
        .foregroundStyle(color)
        .minimumScaleFactor(0.5)
        .lineLimit(1)
        .contentTransition(.numericText())
      Text(label)
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textSecondary)
        .minimumScaleFactor(0.7)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func breachRow(count: Int) -> some View {
    HStack(spacing: 6) {
      Image(systemName: "exclamationmark.shield.fill")
        .foregroundStyle(AegisColor.verdictSpoofHigh)
        .accessibilityHidden(true)
      Text("\(count) breach exposure\(count == 1 ? "" : "s") in the last 30 days")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.verdictSpoofHigh)
    }
    .padding(.top, 2)
  }

  private var skeleton: some View {
    RoundedRectangle(cornerRadius: AegisRadius.l)
      .fill(AegisColor.surface.opacity(0.6))
      .frame(height: 130)
      .overlay(
        ProgressView()
          .tint(AegisColor.textSecondary)
          .scaleEffect(0.8)
      )
      .task { await load() }
  }

  func load() async {
    do {
      let s = try await APIClient.shared.statsSummary()
      await MainActor.run {
        stats = s
        loading = false
      }
    } catch {
      await MainActor.run { loading = false }
    }
  }
}
