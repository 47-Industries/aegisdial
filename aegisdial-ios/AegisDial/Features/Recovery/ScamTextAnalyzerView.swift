import SwiftUI
import UIKit

// Paste-a-text analyzer. Sits alongside Triage and Recovery on Home —
// user pastes an SMS they suspect is a scam and gets an instant verdict
// with trust score, playbook, and red flags.
//
// UX:
//   - Large paste field (auto-paste from clipboard on first appear if
//     it looks like text, with an unobtrusive "Use pasted text" chip).
//   - Optional sender field.
//   - Check button → loading → results.
//   - Results: big trust-score ring, verdict headline, matched patterns
//     highlighted in the original text, red flags, "how this scam works"
//     collapsible, what-to-do actions, and a "Talk to the Companion"
//     CTA that opens a triage session seeded with the text.

struct ScamTextAnalyzerView: View {
  @Environment(\.dismiss) private var dismiss
  let initialText: String?
  var onOpenTriage: ((String, String?) -> Void)?

  @State private var text: String
  @State private var sender: String = ""
  @State private var result: APIClient.TextAnalysisResult?
  @State private var isChecking: Bool = false
  @State private var errorMessage: String?
  @State private var trialExpired: Bool = false
  @FocusState private var focusedField: Field?

  private enum Field { case text, sender }

  init(
    initialText: String? = nil,
    onOpenTriage: ((String, String?) -> Void)? = nil
  ) {
    self.initialText = initialText
    _text = State(initialValue: initialText ?? "")
    self.onOpenTriage = onOpenTriage
  }

  var body: some View {
    NavigationStack {
      ZStack {
        AegisColor.background.ignoresSafeArea()
        if let result {
          ResultsView(
            text: text,
            result: result,
            onCheckAnother: {
              withAnimation(AegisMotion.spring) { self.result = nil }
            },
            onTalkToCompanion: {
              onOpenTriage?(text, sender.isEmpty ? nil : sender)
              dismiss()
            }
          )
        } else {
          inputView
        }
      }
      .navigationTitle(result == nil ? "Check a text" : "Result")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Close") { dismiss() }.tint(AegisColor.textSecondary)
        }
      }
    }
    .preferredColorScheme(.dark)
    .interactiveDismissDisabled(isChecking)
  }

  private var inputView: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: AegisSpacing.l) {
        intro
        pasteFromClipboardChip
        textField
        senderField
        if trialExpired { trialExpiredBanner }
        if let errorMessage { errorBanner(errorMessage) }
        checkButton
      }
      .padding(AegisSpacing.l)
    }
    .scrollDismissesKeyboard(.interactively)
  }

  // Soft upsell when the 3-day anonymous trial runs out. We don't hard-
  // wall — the user can still see the form, just can't run a check
  // until they sign up free or convert. Sign-up dismisses the analyzer
  // and routes the user back to the auth flow; the existing onClose
  // toolbar button handles dismissal.
  private var trialExpiredBanner: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      HStack(spacing: AegisSpacing.s) {
        Image(systemName: "hourglass.bottomhalf.filled")
          .foregroundStyle(AegisColor.accent)
        Text("Your free 3-day text checker is up")
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
      }
      Text("You used the scam-text checker free for 3 days — thanks for trying it. Sign up free to keep checking texts, or get full Live Shield + Recovery protection on the paywall.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textSecondary)
      Button {
        AegisHaptic.medium.play()
        dismiss()
      } label: {
        HStack {
          Text("Sign up free to continue").font(AegisType.bodyBold)
          Image(systemName: "arrow.right")
        }
        .frame(maxWidth: .infinity, minHeight: 48)
        .foregroundStyle(.black)
        .background(AegisColor.textPrimary)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      }
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.surface)
    .overlay(
      RoundedRectangle(cornerRadius: AegisRadius.m)
        .stroke(AegisColor.accent.opacity(0.4), lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var intro: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "doc.text.magnifyingglass")
        .font(.system(size: 32, weight: .semibold))
        .foregroundStyle(AegisColor.accent.gradient)
      Text("Paste a suspicious text")
        .font(.system(size: 22, weight: .semibold, design: .rounded))
        .foregroundStyle(AegisColor.textPrimary)
      Text("We'll tell you what type of scam it is, how it works, and what to do. Your pasted text isn't stored unless you choose to talk about it.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder
  private var pasteFromClipboardChip: some View {
    if text.isEmpty, UIPasteboard.general.hasStrings,
       let clip = UIPasteboard.general.string,
       clip.count > 20, clip.count < 3000 {
      Button {
        text = clip
        AegisHaptic.selection.play()
      } label: {
        HStack(spacing: AegisSpacing.s) {
          Image(systemName: "doc.on.clipboard")
            .foregroundStyle(AegisColor.accent)
          Text("Paste from clipboard")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textPrimary)
          Spacer()
          Image(systemName: "arrow.up.forward")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(AegisColor.textTertiary)
        }
        .padding(AegisSpacing.s)
        .background(AegisColor.accent.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.s, style: .continuous))
      }
      .buttonStyle(.plain)
    }
  }

  private var textField: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("The text message")
      TextEditor(text: $text)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textPrimary)
        .scrollContentBackground(.hidden)
        .background(AegisColor.surface)
        .frame(minHeight: 140)
        .padding(AegisSpacing.s)
        .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairlineStrong, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        .tint(AegisColor.accent)
        .focused($focusedField, equals: .text)
    }
  }

  private var senderField: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      sectionHeader("Sender (optional — number or name)")
      HStack(spacing: AegisSpacing.s) {
        Image(systemName: "person.badge.key")
          .foregroundStyle(AegisColor.textTertiary)
          .frame(width: 22)
        TextField("e.g. +1 555 555 5555 or USPS", text: $sender)
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textPrimary)
          .tint(AegisColor.accent)
          .focused($focusedField, equals: .sender)
      }
      .padding(.horizontal, AegisSpacing.m)
      .frame(height: 56)
      .background(AegisColor.surface)
      .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairlineStrong, lineWidth: 1))
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
  }

  private var checkButton: some View {
    Button {
      AegisHaptic.medium.play()
      Task { await run() }
    } label: {
      HStack {
        if isChecking {
          ProgressView().tint(.black)
        } else {
          Image(systemName: "magnifyingglass")
          Text("Check this text").font(AegisType.bodyBold)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 54)
      .foregroundStyle(.black)
      .background(text.trimmingCharacters(in: .whitespacesAndNewlines).count >= 4
                  ? AegisColor.accent
                  : AegisColor.textTertiary)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).count < 4 || isChecking)
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

  private func run() async {
    isChecking = true
    defer { isChecking = false }
    errorMessage = nil
    trialExpired = false
    focusedField = nil
    do {
      let r = try await APIClient.shared.analyzeScamText(
        text: text,
        sender: sender.isEmpty ? nil : sender,
        anonymousId: Self.persistedAnonymousId()
      )
      withAnimation(AegisMotion.spring) { result = r }
      AegisHaptic.success.play()
    } catch APIError.badStatus(402, let code) where code == "anonymous_trial_expired" {
      // 3-day free trial is up. Don't show the generic error banner —
      // surface the soft "sign up free to keep going" upsell instead.
      AegisHaptic.warning.play()
      withAnimation(AegisMotion.spring) { trialExpired = true }
    } catch {
      AegisHaptic.error.play()
      errorMessage = AegisError.from(error).userMessage
    }
  }

  /// Returns the same Keychain-style anonymous ID the Analytics actor
  /// uses, persisted in UserDefaults so backend-side trial bookkeeping
  /// is consistent across analyzer + analytics calls.
  private static func persistedAnonymousId() -> String {
    let key = "aegisdial.analytics.anonymous_id"
    let defaults = UserDefaults.standard
    if let existing = defaults.string(forKey: key), !existing.isEmpty {
      return existing
    }
    let new = UUID().uuidString
    defaults.set(new, forKey: key)
    return new
  }
}

// MARK: - Results

private struct ResultsView: View {
  let text: String
  let result: APIClient.TextAnalysisResult
  let onCheckAnother: () -> Void
  let onTalkToCompanion: () -> Void

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: AegisSpacing.l) {
        verdictHero
        originalTextCard
        if !result.redFlags.isEmpty { redFlagsCard }
        if let playbook = result.playbook { playbookCard(playbook) }
        if !result.whatToDo.isEmpty { whatToDoCard }
        if !result.urlFindings.isEmpty { urlsCard }
        footerActions
      }
      .padding(AegisSpacing.l)
    }
  }

  private var verdictHero: some View {
    VStack(spacing: AegisSpacing.m) {
      HStack(alignment: .center, spacing: AegisSpacing.l) {
        TrustScoreRing(score: result.trustScore, color: verdictTint)
          .frame(width: 96, height: 96)
        VStack(alignment: .leading, spacing: AegisSpacing.xs) {
          Text(verdictLabel)
            .font(AegisType.caption)
            .foregroundStyle(verdictTint)
            .textCase(.uppercase)
            .tracking(1.2)
          Text(result.verdictHeadline)
            .font(.system(size: 18, weight: .semibold, design: .rounded))
            .foregroundStyle(AegisColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(AegisSpacing.m)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(AegisColor.surface)
      .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
    }
  }

  private var originalTextCard: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.xs) {
      Text("THE MESSAGE")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .tracking(1.2)
      Text(text)
        .font(.system(size: 15, design: .monospaced))
        .foregroundStyle(AegisColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var redFlagsCard: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Text("RED FLAGS IN THIS TEXT")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .tracking(1.2)
      ForEach(Array(result.redFlags.enumerated()), id: \.offset) { _, flag in
        HStack(alignment: .top, spacing: AegisSpacing.s) {
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(verdictTint)
          Text(flag)
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private func playbookCard(_ playbook: String) -> some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      HStack(spacing: AegisSpacing.s) {
        Image(systemName: "book.closed.fill")
          .foregroundStyle(AegisColor.accent)
        Text("How this scam works")
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
        if let display = result.scamTypeDisplay {
          Spacer()
          Text(display)
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.accent)
        }
      }
      Text(playbook)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      if let why = result.whyItWorks {
        Divider().background(AegisColor.hairline)
        Text("Why it works on careful people")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
          .textCase(.uppercase)
          .tracking(1.2)
        Text(why)
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var whatToDoCard: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Text("WHAT TO DO")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .tracking(1.2)
      ForEach(Array(result.whatToDo.enumerated()), id: \.offset) { idx, action in
        HStack(alignment: .top, spacing: AegisSpacing.s) {
          Text("\(idx + 1)")
            .font(AegisType.bodyBold)
            .foregroundStyle(AegisColor.accent)
            .frame(width: 20, alignment: .leading)
          Text(action)
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var urlsCard: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Text("LINKS IN THE MESSAGE")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .tracking(1.2)
      ForEach(result.urlFindings, id: \.url) { u in
        HStack(alignment: .top, spacing: AegisSpacing.s) {
          Image(systemName: u.isMalicious ? "xmark.octagon.fill" : "link")
            .foregroundStyle(u.isMalicious ? AegisColor.verdictSpoofHigh : AegisColor.textSecondary)
          VStack(alignment: .leading, spacing: 2) {
            Text(u.url)
              .font(.system(size: 13, design: .monospaced))
              .foregroundStyle(AegisColor.textPrimary)
              .lineLimit(2)
              .truncationMode(.middle)
            if let reason = u.reason {
              Text(reason)
                .font(AegisType.caption)
                .foregroundStyle(AegisColor.textTertiary)
            }
          }
          Spacer()
        }
      }
      Text("Don't tap any link in a suspicious text — even previews can leak information.")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textTertiary)
        .padding(.top, AegisSpacing.xs)
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var footerActions: some View {
    VStack(spacing: AegisSpacing.s) {
      Button {
        AegisHaptic.medium.play()
        onTalkToCompanion()
      } label: {
        Label("Talk to the Companion about this", systemImage: "heart.text.square.fill")
          .font(AegisType.bodyBold)
          .frame(maxWidth: .infinity, minHeight: 54)
          .foregroundStyle(.black)
          .background(AegisColor.accent)
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      }
      Button {
        onCheckAnother()
      } label: {
        Text("Check another text")
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
          .frame(maxWidth: .infinity, minHeight: 48)
          .overlay(
            RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous)
              .stroke(AegisColor.hairlineStrong, lineWidth: 1)
          )
      }
    }
    .padding(.top, AegisSpacing.s)
  }

  private var verdictLabel: String {
    switch result.verdict {
    case "trusted": "Looks ok"
    case "unknown": "Inconclusive"
    case "suspicious": "Suspicious"
    case "likely_scam": "Likely scam"
    case "definitely_scam": "Definitely a scam"
    default: "Unknown"
    }
  }

  private var verdictTint: Color {
    switch result.verdict {
    case "trusted": AegisColor.verdictTrusted
    case "unknown": AegisColor.textSecondary
    case "suspicious": AegisColor.accent
    case "likely_scam", "definitely_scam": AegisColor.verdictSpoofHigh
    default: AegisColor.textSecondary
    }
  }
}

// Small trust-score ring — reuses the verdict palette.
private struct TrustScoreRing: View {
  let score: Int
  let color: Color

  var body: some View {
    ZStack {
      Circle()
        .stroke(AegisColor.surfaceElevated, lineWidth: 8)
      Circle()
        .trim(from: 0, to: CGFloat(score) / 100)
        .stroke(color, style: StrokeStyle(lineWidth: 8, lineCap: .round))
        .rotationEffect(.degrees(-90))
        .animation(AegisMotion.spring, value: score)
      VStack(spacing: 0) {
        Text("\(score)")
          .font(.system(size: 30, weight: .bold, design: .rounded))
          .foregroundStyle(AegisColor.textPrimary)
        Text("trust")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textTertiary)
      }
    }
  }
}
