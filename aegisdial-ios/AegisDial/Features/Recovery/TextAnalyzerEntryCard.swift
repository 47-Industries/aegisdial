import SwiftUI

// Home-screen entry for the paste-a-text analyzer. Sits alongside
// Triage and Recovery. Uses a subtle "document under a magnifier"
// icon so the affordance is unmistakable: you give us text, we
// give you an answer.

struct TextAnalyzerEntryCard: View {
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(alignment: .center, spacing: AegisSpacing.m) {
        Image(systemName: "doc.text.magnifyingglass")
          .font(.system(size: 28, weight: .semibold))
          .foregroundStyle(AegisColor.accent)
          .frame(width: 44, height: 44)
          .background(AegisColor.accentGlow)
          .clipShape(Circle())
        VStack(alignment: .leading, spacing: 2) {
          Text("Got a weird text?")
            .font(AegisType.bodyBold)
            .foregroundStyle(AegisColor.textPrimary)
          Text("Paste it in and I'll tell you what kind of scam it is, why it works, and what to do.")
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
