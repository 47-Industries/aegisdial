import SwiftUI

// Home-screen entry point. One card. Big, obvious, not buried in a menu.
// Because elderly users are our highest-value cohort, the button must
// be reachable without thinking.

struct LiveShieldEntryCard: View {
  let peerNumber: String?
  let onTap: () -> Void
  /// Optional outbound entry — "I'm about to call a suspicious number."
  /// Left as an optional so existing call-sites keep compiling; callers
  /// that want the secondary CTA pass a non-nil closure.
  var onTapOutbound: (() -> Void)? = nil

  var body: some View {
    VStack(spacing: AegisSpacing.s) {
      Button(action: onTap) {
        HStack(alignment: .center, spacing: AegisSpacing.m) {
          Image(systemName: "shield.lefthalf.filled")
            .font(.system(size: 28, weight: .semibold))
            .foregroundStyle(AegisColor.accent)
            .frame(width: 44, height: 44)
            .background(AegisColor.accentGlow)
            .clipShape(Circle())
          VStack(alignment: .leading, spacing: 2) {
            Text("Shield this call")
              .font(AegisType.bodyBold)
              .foregroundStyle(AegisColor.textPrimary)
            Text("Live scam-phrase detection while you're on the phone.")
              .font(AegisType.caption)
              .foregroundStyle(AegisColor.textSecondary)
              .lineLimit(nil)
              .fixedSize(horizontal: false, vertical: true)
          }
          Spacer()
          // NOTE: aging-parent DynamicType pass 2026-04-19
          // Chevron was locked at 14pt while the label scaled — at AX3 the
          // label dwarfed the chevron and the tap target looked lopsided.
          // Use AegisType.body so the glyph tracks the label.
          Image(systemName: "chevron.right")
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textSecondary)
        }
        .padding(AegisSpacing.m)
        .background(AegisColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      }
      .buttonStyle(.plain)

      if let onTapOutbound {
        Button(action: onTapOutbound) {
          HStack(spacing: AegisSpacing.s) {
            Image(systemName: "phone.arrow.up.right")
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(AegisColor.accent)
            Text("I'm making a call to a suspicious number")
              .font(AegisType.caption)
              .foregroundStyle(AegisColor.textSecondary)
              .lineLimit(nil)
              .fixedSize(horizontal: false, vertical: true)
            Spacer()
            // NOTE: aging-parent DynamicType pass 2026-04-19
            // Match chevron size to the caption-scale label beside it.
            Image(systemName: "chevron.right")
              .font(AegisType.caption)
              .foregroundStyle(AegisColor.textSecondary)
          }
          .padding(.horizontal, AegisSpacing.m)
          .padding(.vertical, AegisSpacing.s)
          .frame(maxWidth: .infinity)
          .background(AegisColor.surface.opacity(0.6))
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Start shield for a call I'm placing to a suspicious number")
      }
    }
  }
}
