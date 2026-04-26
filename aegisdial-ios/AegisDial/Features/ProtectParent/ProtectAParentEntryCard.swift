import SwiftUI

// Home-screen entry point for the Protect-a-Parent flow. Surfaces the
// adult-child buyer framing as a first-class action — most scam-call
// victims are older family members, and this is where we meet that user.
//
// Hidden once the user has an active family plan with at least one member
// (the parent is already on the plan, so re-surfacing this card would be
// noise).

struct ProtectAParentEntryCard: View {
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(alignment: .center, spacing: AegisSpacing.m) {
        Image(systemName: "figure.2.and.child.holdinghands")
          .font(.system(size: 28, weight: .semibold))
          .foregroundStyle(AegisColor.accent)
          .frame(width: 44, height: 44)
          .background(AegisColor.accentGlow)
          .clipShape(Circle())
        VStack(alignment: .leading, spacing: 2) {
          Text("Protect a parent")
            .font(AegisType.bodyBold)
            .foregroundStyle(AegisColor.textPrimary)
          Text("Add a family member and get pinged when their calls go critical.")
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
