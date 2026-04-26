import SwiftUI

// Reusable error banner. Use at the top of a List section so it
// appears above the data but inside the scroll surface. Optional retry
// closure — when present, a "Retry" button calls it.

struct ErrorBanner: View {
  let message: String
  var onRetry: (() -> Void)? = nil

  var body: some View {
    HStack(alignment: .top, spacing: AegisSpacing.m) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(AegisColor.verdictSuspicious)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Text("Something went wrong")
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
        Text(message)
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textSecondary)
          .lineLimit(3)
      }
      Spacer()
      if let onRetry {
        Button("Retry", action: onRetry)
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.accent)
      }
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Error: \(message)")
  }
}
