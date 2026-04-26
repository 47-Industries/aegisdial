import SwiftUI

// Reusable empty-state block. Every list view can use this instead of
// shipping its own "no items" layout. Generous padding, centered,
// accessible.

struct EmptyStateBlock: View {
  let icon: String
  let title: String
  let body: String
  var cta: (String, () -> Void)? = nil

  var body: some View {
    VStack(spacing: AegisSpacing.m) {
      Image(systemName: icon)
        .font(.system(size: 44, weight: .light))
        .foregroundStyle(AegisColor.textSecondary)
        .accessibilityHidden(true)
      Text(title)
        .font(AegisType.heading)
        .foregroundStyle(AegisColor.textPrimary)
        .multilineTextAlignment(.center)
      Text(body)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, AegisSpacing.m)
      if let (label, action) = cta {
        Button(action: action) {
          Text(label)
            .font(AegisType.bodyBold)
            .foregroundStyle(.black)
            .frame(minHeight: 44)
            .padding(.horizontal, AegisSpacing.l)
            .background(AegisColor.accent)
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        }
        .padding(.top, AegisSpacing.s)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, AegisSpacing.xl)
    .accessibilityElement(children: .combine)
  }
}
