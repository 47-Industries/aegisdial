import SwiftUI

// Outcome-capture sheet. Shown when a session finishes, or surfaced by
// the T+7 follow-up email link. Keeps the ask short — long surveys at
// emotional moments have terrible completion rates.
//
// The data feeds the Recovery flywheel: which steps actually helped,
// how much was recovered, was the user able to tell family. Over time
// this reorders steps based on measured success, not guesses.

struct RecoveryOutcomeSheet: View {
  @Environment(\.dismiss) private var dismiss
  let sessionId: String
  let availableSteps: [RecoverySession.Step]
  var onSubmitted: () -> Void

  @State private var recoveredAny: Bool? = nil
  @State private var recoveredAmountText: String = ""
  @State private var moodAfter: Int = 3
  @State private var toldFamily: Bool? = nil
  @State private var reportedToPolice: Bool? = nil
  @State private var helpfulStepKeys: Set<String> = []
  @State private var notes: String = ""
  @State private var isSubmitting = false
  @State private var errorMessage: String?

  var body: some View {
    NavigationStack {
      ZStack {
        AegisColor.background.ignoresSafeArea()
        ScrollView {
          VStack(alignment: .leading, spacing: AegisSpacing.l) {
            intro
            recoveryQuestion
            if recoveredAny == true { recoveryAmountField }
            moodQuestion
            toldFamilyQuestion
            policeQuestion
            if !availableSteps.isEmpty { helpfulStepsSection }
            notesSection
            if let errorMessage { errorBanner(errorMessage) }
            submitButton
            skipButton
          }
          .padding(AegisSpacing.l)
        }
        .scrollDismissesKeyboard(.interactively)
      }
      .navigationTitle("How did it go?")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close") { dismiss() }.tint(AegisColor.textSecondary)
        }
      }
    }
    .preferredColorScheme(.dark)
  }

  private var intro: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "heart.text.square")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(AegisColor.accent.gradient)
      Text("Your answers help the next person")
        .font(.system(size: 20, weight: .semibold, design: .rounded))
        .foregroundStyle(AegisColor.textPrimary)
      Text("Every answer is optional. What you share helps us learn which steps actually help real people — and it stays encrypted and private.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var recoveryQuestion: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("Did you recover any money?")
      HStack(spacing: AegisSpacing.s) {
        triChip("Yes", selected: recoveredAny == true) { recoveredAny = true }
        triChip("No", selected: recoveredAny == false) { recoveredAny = false }
        triChip("Still pending", selected: recoveredAny == nil) { recoveredAny = nil }
      }
    }
  }

  private var recoveryAmountField: some View {
    HStack(spacing: AegisSpacing.s) {
      Text("$").font(AegisType.heading).foregroundStyle(AegisColor.textTertiary)
      TextField("Amount recovered", text: $recoveredAmountText)
        .keyboardType(.decimalPad)
        .font(.system(size: 22, weight: .semibold, design: .rounded))
        .foregroundStyle(AegisColor.textPrimary)
    }
    .padding(.horizontal, AegisSpacing.m)
    .frame(height: 56)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    .transition(.opacity.combined(with: .move(edge: .top)))
  }

  private var moodQuestion: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("How are you feeling now?")
      HStack(spacing: AegisSpacing.s) {
        ForEach(1...5, id: \.self) { v in
          Button {
            AegisHaptic.selection.play()
            withAnimation(AegisMotion.snappy) { moodAfter = v }
          } label: {
            Text(moodEmoji(v))
              .font(.system(size: 32))
              .frame(maxWidth: .infinity)
              .padding(.vertical, AegisSpacing.s)
              .background(moodAfter == v ? AegisColor.accentGlow : AegisColor.surface)
              .overlay(
                RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
                  .stroke(moodAfter == v ? AegisColor.accent : .clear, lineWidth: 2)
              )
              .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
          }
        }
      }
    }
  }

  private func moodEmoji(_ v: Int) -> String {
    switch v {
    case 1: "😞"; case 2: "😕"; case 3: "😐"; case 4: "🙂"; case 5: "😊"
    default: "😐"
    }
  }

  private var toldFamilyQuestion: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("Did you tell a family member or friend?")
      HStack(spacing: AegisSpacing.s) {
        triChip("Yes", selected: toldFamily == true) { toldFamily = true }
        triChip("Not yet", selected: toldFamily == false) { toldFamily = false }
      }
    }
  }

  private var policeQuestion: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("Did you file a police report?")
      HStack(spacing: AegisSpacing.s) {
        triChip("Yes", selected: reportedToPolice == true) { reportedToPolice = true }
        triChip("No", selected: reportedToPolice == false) { reportedToPolice = false }
      }
    }
  }

  private var helpfulStepsSection: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("Which steps actually helped?")
      ForEach(availableSteps, id: \.stepKey) { step in
        Button {
          AegisHaptic.selection.play()
          if helpfulStepKeys.contains(step.stepKey) {
            helpfulStepKeys.remove(step.stepKey)
          } else {
            helpfulStepKeys.insert(step.stepKey)
          }
        } label: {
          HStack(spacing: AegisSpacing.s) {
            Image(systemName: helpfulStepKeys.contains(step.stepKey) ? "checkmark.circle.fill" : "circle")
              .foregroundStyle(helpfulStepKeys.contains(step.stepKey) ? AegisColor.accent : AegisColor.textTertiary)
            Text(step.title)
              .font(AegisType.body)
              .foregroundStyle(AegisColor.textPrimary)
              .multilineTextAlignment(.leading)
              .fixedSize(horizontal: false, vertical: true)
            Spacer()
          }
          .padding(AegisSpacing.s)
        }
        .buttonStyle(.plain)
      }
    }
  }

  private var notesSection: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("Anything else that would help us improve?")
      TextEditor(text: $notes)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textPrimary)
        .scrollContentBackground(.hidden)
        .background(AegisColor.surface)
        .frame(minHeight: 90)
        .padding(AegisSpacing.s)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        .tint(AegisColor.accent)
    }
  }

  private var submitButton: some View {
    Button {
      AegisHaptic.medium.play()
      Task { await submit() }
    } label: {
      HStack {
        if isSubmitting { ProgressView().tint(.black) }
        else { Text("Submit").font(AegisType.bodyBold) }
      }
      .frame(maxWidth: .infinity, minHeight: 54)
      .foregroundStyle(.black)
      .background(AegisColor.textPrimary)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .disabled(isSubmitting)
  }

  private var skipButton: some View {
    Button {
      dismiss()
    } label: {
      Text("Not now")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .frame(maxWidth: .infinity, minHeight: 44)
    }
  }

  private func triChip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: {
      AegisHaptic.selection.play()
      action()
    }) {
      Text(label)
        .font(AegisType.bodyBold)
        .foregroundStyle(selected ? .black : AegisColor.textPrimary)
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(selected ? AegisColor.accent : AegisColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
  }

  private func sectionHeader(_ text: String) -> some View {
    Text(text)
      .font(AegisType.caption)
      .foregroundStyle(AegisColor.textTertiary)
      .textCase(.uppercase)
      .tracking(1.2)
  }

  private func errorBanner(_ msg: String) -> some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(AegisColor.verdictSpoofHigh)
      Text(msg)
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textPrimary)
      Spacer()
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.verdictSpoofHigh.opacity(0.12))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private func submit() async {
    isSubmitting = true
    defer { isSubmitting = false }
    errorMessage = nil
    let cents: Int? = {
      guard let d = Double(recoveredAmountText) else { return nil }
      return Int(d * 100)
    }()
    let feedback: [String: [String: Any]] = Dictionary(
      uniqueKeysWithValues: helpfulStepKeys.map { ($0, ["helpful": true] as [String: Any]) }
    )
    do {
      try await APIClient.shared.submitRecoveryOutcome(
        sessionId: sessionId,
        recoveredAny: recoveredAny,
        recoveredCents: cents,
        notes: notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : notes,
        stepFeedback: feedback.isEmpty ? nil : feedback,
        moodBefore: nil,
        moodAfter: moodAfter,
        toldFamily: toldFamily,
        reportedToPolice: reportedToPolice
      )
      AegisHaptic.success.play()
      onSubmitted()
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
      AegisHaptic.error.play()
    }
  }
}
