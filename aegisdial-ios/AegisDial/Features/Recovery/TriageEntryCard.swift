import SwiftUI

// Home-screen card for the "Is this a scam?" triage flow. Sits above
// the existing Recovery card — many users will come here FIRST (before
// they've lost anything). Visually calmer than Recovery so we don't
// alarm someone who's just uncertain.

struct TriageEntryCard: View {
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(alignment: .center, spacing: AegisSpacing.m) {
        Image(systemName: "questionmark.bubble.fill")
          .font(.system(size: 28, weight: .semibold))
          .foregroundStyle(AegisColor.accent)
          .frame(width: 44, height: 44)
          .background(AegisColor.accentGlow)
          .clipShape(Circle())
        VStack(alignment: .leading, spacing: 2) {
          Text("Is this a scam?")
            .font(AegisType.bodyBold)
            .foregroundStyle(AegisColor.textPrimary)
          Text("Not sure what just happened? Talk to me before you do anything — we'll figure it out together.")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer()
        Image(systemName: "chevron.right")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(AegisColor.textSecondary)
      }
      .padding(AegisSpacing.m)
      .background(AegisColor.surface)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .buttonStyle(.plain)
  }
}
