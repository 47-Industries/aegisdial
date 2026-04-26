import SwiftUI

// "Is this a scam?" pre-loss consultation. The entry point for users
// who aren't sure what just happened to them — maybe still mid-call,
// maybe just hung up, maybe haven't paid anything yet. Creates a
// triage-mode session on the backend and drops the user directly into
// the Companion chat.
//
// The ask here is deliberately minimal — victims in doubt do not want
// to fill in a 60-second form. Number + short "what happened" max.

struct ScamTriageStartSheet: View {
  @Environment(\.dismiss) private var dismiss
  let initialScamNumber: String?
  let onStarted: (RecoverySession) -> Void

  @State private var scamNumber: String
  @State private var description: String = ""
  @State private var isStarting = false
  @State private var errorMessage: String?

  init(initialScamNumber: String? = nil, onStarted: @escaping (RecoverySession) -> Void) {
    self.initialScamNumber = initialScamNumber
    _scamNumber = State(initialValue: initialScamNumber ?? "")
    self.onStarted = onStarted
  }

  var body: some View {
    NavigationStack {
      ZStack {
        AegisColor.background.ignoresSafeArea()
        ScrollView {
          VStack(alignment: .leading, spacing: AegisSpacing.l) {
            intro
            numberField
            descriptionField
            if let errorMessage { errorBanner(errorMessage) }
            startButton
            skipButton
          }
          .padding(AegisSpacing.l)
        }
        .scrollDismissesKeyboard(.interactively)
      }
      .navigationTitle("Is this a scam?")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Cancel") { dismiss() }.tint(AegisColor.textSecondary)
        }
      }
    }
    .preferredColorScheme(.dark)
    .interactiveDismissDisabled(isStarting)
  }

  private var intro: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "questionmark.bubble.fill")
        .font(.system(size: 32, weight: .semibold))
        .foregroundStyle(AegisColor.accent.gradient)
      Text("Let's figure it out together")
        .font(.system(size: 22, weight: .semibold, design: .rounded))
        .foregroundStyle(AegisColor.textPrimary)
      Text("If you're still on the call, hang up now. Then tell me what happened and I'll walk you through whether it was a scam — and if it was, how to stop it before anything is lost.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.top, AegisSpacing.s)
  }

  private var numberField: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("The number that called you (optional)")
      HStack(spacing: AegisSpacing.s) {
        Image(systemName: "phone.fill")
          .foregroundStyle(AegisColor.textTertiary)
          .frame(width: 22)
        TextField("+1 555 555 5555", text: $scamNumber)
          .keyboardType(.phonePad)
          .textContentType(.telephoneNumber)
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textPrimary)
          .tint(AegisColor.accent)
      }
      .padding(.horizontal, AegisSpacing.m)
      .frame(height: 56)
      .background(AegisColor.surface)
      .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairlineStrong, lineWidth: 1))
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
  }

  private var descriptionField: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("What did they say? (optional)")
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
      Text("A sentence or two. Who did they claim to be, what were they asking for?")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
    }
  }

  private var startButton: some View {
    Button {
      AegisHaptic.medium.play()
      Task { await start() }
    } label: {
      HStack {
        if isStarting {
          ProgressView().tint(.black)
        } else {
          Text("Talk to the Companion").font(AegisType.bodyBold)
          Image(systemName: "arrow.right").font(.system(size: 14, weight: .bold))
        }
      }
      .frame(maxWidth: .infinity, minHeight: 54)
      .foregroundStyle(.black)
      .background(AegisColor.accent)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .disabled(isStarting)
  }

  private var skipButton: some View {
    Button {
      Task { await start() }
    } label: {
      Text("Or just start — no details needed")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .frame(maxWidth: .infinity, minHeight: 44)
    }
    .disabled(isStarting)
  }

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
    do {
      let trimmedNum = scamNumber.trimmingCharacters(in: .whitespacesAndNewlines)
      let trimmedDesc = description.trimmingCharacters(in: .whitespacesAndNewlines)
      let session = try await APIClient.shared.startTriage(
        scamNumber: trimmedNum.isEmpty ? nil : trimmedNum,
        description: trimmedDesc.isEmpty ? nil : trimmedDesc
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
