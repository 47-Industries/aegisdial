import SwiftUI

// Presented right after a Live Shield ends at high or critical risk.
// The only question that matters in that moment is: did you give them
// anything? If yes → start Recovery Concierge prefilled with whatever
// the shield learned about the scam type.
//
// Deliberately low-friction: two buttons, calm copy, no "are you sure"
// confirmations. The cognitive load during a just-ended scam call is
// already maxed.

struct PostShieldRecoveryHandoffSheet: View {
  let snapshot: LiveShieldEndSnapshot
  let onDecision: (Bool) -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.l) {
      header
      question
      Spacer()
      startRecovery
      keepProtected
    }
    .padding(AegisSpacing.l)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.background)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "shield.slash.fill")
        .font(.system(size: 40, weight: .semibold))
        .foregroundStyle(AegisColor.verdictSpoofHigh)
        .accessibilityHidden(true)
      Text("That call hit critical.")
        .font(.system(size: 26, weight: .bold))
        .foregroundStyle(AegisColor.textPrimary)
      if let peer = snapshot.peerNumber {
        Text(peer)
          .font(AegisType.mono)
          .foregroundStyle(AegisColor.textSecondary)
      }
    }
  }

  private var question: some View {
    Text("Did you share anything or send money? Take a breath — we've got a 15-minute recovery flow that freezes everything they could have used.")
      .font(AegisType.body)
      .foregroundStyle(AegisColor.textSecondary)
  }

  private var startRecovery: some View {
    Button {
      onDecision(true)
      dismiss()
    } label: {
      Label("Start Recovery", systemImage: "cross.case.fill")
        .font(AegisType.bodyBold)
        .foregroundStyle(.black)
        .frame(maxWidth: .infinity, minHeight: 54)
        .background(AegisColor.accent)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .accessibilityHint("Opens the recovery flow with your scam details prefilled")
  }

  private var keepProtected: some View {
    Button {
      onDecision(false)
      dismiss()
    } label: {
      Text("I'm fine — I didn't give them anything")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.textSecondary)
        .frame(maxWidth: .infinity, minHeight: 50)
    }
  }
}
