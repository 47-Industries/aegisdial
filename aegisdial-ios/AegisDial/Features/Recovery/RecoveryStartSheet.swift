import SwiftUI

// Entry sheet for starting a Recovery Concierge session. Users arrive here
// either from the Home screen ("Been scammed? Start Recovery") or after
// reporting a number on a verdict card.
//
// Copy voice: calm, specific, second-person. NO alarming language, NO
// marketing. Users are reading this while upset — every sentence should
// feel like a friend saying "OK, here's what to do." The three inputs are
// all optional because we don't want to block anyone from starting. Even
// a blank form produces a useful recovery session via the 'generic' path.

struct RecoveryStartSheet: View {
  @Environment(\.dismiss) private var dismiss
  let scamNumber: String?
  var preselectedScamType: ScamType?
  let onStarted: (RecoverySession) -> Void

  @State private var scamType: ScamType = .generic
  @State private var amountText: String = ""
  @State private var description: String = ""
  @State private var isStarting = false
  @State private var errorMessage: String?
  @State private var autoPopulated: Bool = false
  @State private var autoPopulatedNumber: String?

  var body: some View {
    NavigationStack {
      ZStack {
        AegisColor.background.ignoresSafeArea()
        ScrollView {
          VStack(alignment: .leading, spacing: AegisSpacing.l) {
            intro
            scamTypeSection
            amountSection
            descriptionSection
            if let errorMessage {
              errorBanner(errorMessage)
            }
            startButton
            skipForNow
          }
          .padding(AegisSpacing.l)
        }
        .scrollDismissesKeyboard(.interactively)
      }
      .navigationTitle("Recovery")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Cancel") { dismiss() }.tint(AegisColor.textSecondary)
        }
      }
    }
    .preferredColorScheme(.dark)
    .interactiveDismissDisabled(isStarting)
    .onAppear {
      if let pre = preselectedScamType { scamType = pre }
    }
    .task {
      // Auto-populate from a recent Live Shield session if one exists in
      // the last hour. We only override the form if the user hasn't
      // preselected a scam type AND the start wasn't seeded from a
      // verdict report.
      guard preselectedScamType == nil, scamNumber == nil else { return }
      if let s = try? await APIClient.shared.recoveryAutoPopulate(), let s {
        if let mapped = ScamType(rawValue: s.scamType) {
          withAnimation(AegisMotion.snappy) {
            scamType = mapped
            autoPopulatedNumber = s.scamNumber
            autoPopulated = true
          }
        }
      }
    }
  }

  private var intro: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "cross.case.fill")
        .font(.system(size: 32, weight: .semibold))
        .foregroundStyle(AegisColor.accent.gradient)
      Text("Take a breath. You're not alone.")
        .font(.system(size: 22, weight: .semibold, design: .rounded))
        .foregroundStyle(AegisColor.textPrimary)
      Text("A few quick questions so we can show you the exact steps that matter most right now. Every field is optional — answer what you can.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      if autoPopulated {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "wand.and.stars")
            .foregroundStyle(AegisColor.accent)
          VStack(alignment: .leading, spacing: 2) {
            Text("We filled in what we could")
              .font(AegisType.bodyBold)
              .foregroundStyle(AegisColor.textPrimary)
            if let n = autoPopulatedNumber {
              Text("Based on your recent shielded call from \(n). Change anything below if it's not right.")
                .font(AegisType.caption)
                .foregroundStyle(AegisColor.textSecondary)
            } else {
              Text("Based on your most recent shielded call. Change anything below if it's not right.")
                .font(AegisType.caption)
                .foregroundStyle(AegisColor.textSecondary)
            }
          }
        }
        .padding(AegisSpacing.s)
        .background(AegisColor.accent.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous))
      }
      usOnlyDisclaimer
    }
    .padding(.top, AegisSpacing.s)
  }

  private var usOnlyDisclaimer: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      HStack(alignment: .top, spacing: 8) {
        Image(systemName: "info.circle")
          .foregroundStyle(AegisColor.textTertiary)
          .accessibilityHidden(true)
        Text("Recovery steps are information, not legal or financial advice. Phone numbers shown are verified as of 2026-04 — if one has changed, use the number on the back of your card or the agency's official website.")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
      }
      HStack(alignment: .top, spacing: 8) {
        Image(systemName: "location.circle")
          .foregroundStyle(AegisColor.textTertiary)
          .accessibilityHidden(true)
        Text("Agency contacts (FTC, FBI IC3, credit bureaus, AARP) are US-only. Outside the US, use the closest equivalent — we'll still generate the non-agency steps.")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
      }
    }
    .padding(AegisSpacing.s)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous))
    .padding(.top, AegisSpacing.s)
  }

  private var scamTypeSection: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("What kind of call was it?")
      LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: AegisSpacing.s) {
        ForEach(ScamType.allCases) { type in
          scamTypeChip(type)
        }
      }
    }
  }

  private func scamTypeChip(_ type: ScamType) -> some View {
    let isSelected = scamType == type
    return Button {
      AegisHaptic.selection.play()
      withAnimation(AegisMotion.snappy) { scamType = type }
    } label: {
      VStack(alignment: .leading, spacing: AegisSpacing.xs) {
        Image(systemName: type.systemIcon)
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(isSelected ? AegisColor.accent : AegisColor.textSecondary)
        Text(type.displayName)
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(AegisSpacing.m)
      .background(isSelected ? AegisColor.surfaceElevated : AegisColor.surface)
      .overlay(
        RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
          .stroke(isSelected ? AegisColor.accent : AegisColor.hairlineStrong, lineWidth: isSelected ? 2 : 1)
      )
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .buttonStyle(.plain)
  }

  private var amountSection: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("Did you lose any money?")
      HStack(spacing: AegisSpacing.s) {
        Text("$")
          .font(AegisType.heading)
          .foregroundStyle(AegisColor.textTertiary)
        TextField("0", text: $amountText)
          .font(.system(size: 24, weight: .semibold, design: .rounded))
          .foregroundStyle(AegisColor.textPrimary)
          .keyboardType(.decimalPad)
          .tint(AegisColor.accent)
      }
      .padding(.horizontal, AegisSpacing.m)
      .frame(height: 60)
      .background(AegisColor.surface)
      .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairlineStrong, lineWidth: 1))
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      Text("Rough estimates are fine. This helps us tailor the urgency.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
    }
  }

  private var descriptionSection: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("Anything else we should know?")
      TextEditor(text: $description)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textPrimary)
        .scrollContentBackground(.hidden)
        .background(AegisColor.surface)
        .frame(minHeight: 100)
        .padding(AegisSpacing.s)
        .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairlineStrong, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        .tint(AegisColor.accent)
    }
  }

  private var startButton: some View {
    Button {
      AegisHaptic.medium.play()
      Task { await start() }
    } label: {
      HStack {
        if isStarting { ProgressView().tint(.black) }
        else {
          Text("Start Recovery").font(AegisType.bodyBold)
          Image(systemName: "arrow.right").font(.system(size: 14, weight: .bold))
        }
      }
      .frame(maxWidth: .infinity, minHeight: 54)
      .foregroundStyle(.black)
      .background(AegisColor.textPrimary)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .disabled(isStarting)
  }

  private var skipForNow: some View {
    Button {
      Task { await start() }
    } label: {
      Text("Skip and just start")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .frame(maxWidth: .infinity, minHeight: 44)
    }
    .disabled(isStarting)
  }

  // MARK: -

  private func sectionHeader(_ text: String) -> some View {
    Text(text)
      .font(AegisType.caption)
      .foregroundStyle(AegisColor.textTertiary)
      .textCase(.uppercase)
      .tracking(1.2)
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(AegisColor.verdictSpoofHigh)
      Text(message)
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textPrimary)
      Spacer()
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.verdictSpoofHigh.opacity(0.12))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private func start() async {
    isStarting = true
    defer { isStarting = false }
    errorMessage = nil
    let amount = Double(amountText.trimmingCharacters(in: .whitespaces))
    let trimmedDescription = description.trimmingCharacters(in: .whitespacesAndNewlines)
    do {
      let session = try await APIClient.shared.startRecovery(
        scamNumber: scamNumber,
        scamType: scamType,
        amountLostUSD: amount,
        description: trimmedDescription.isEmpty ? nil : trimmedDescription
      )
      AegisHaptic.success.play()
      onStarted(session)
      dismiss()
    } catch {
      AegisHaptic.error.play()
      errorMessage = error.localizedDescription
    }
  }
}
