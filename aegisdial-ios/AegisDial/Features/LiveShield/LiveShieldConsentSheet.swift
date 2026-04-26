import SwiftUI

// All-party-consent-safe disclosure. Presented BEFORE any audio capture.
// Copy is deliberately plain-language — this is a legal disclosure, not
// marketing. The 11 US two-party / all-party states (CA, CT, DE, FL, IL,
// MD, MA, MT, NH, PA, WA — plus practical treatment of OR) require every
// participant in a call to consent before any form of recording or
// interception. We avoid that risk by:
//   (a) never recording call audio to disk,
//   (b) using on-device speech recognition only, and
//   (c) giving the user a scripted verbal notice to read to the other
//       party that covers both single- and all-party jurisdictions.
//
// LEGAL REVIEW NEEDED: the script below is a best-effort universal
// phrasing, not legal-reviewed copy. A consumer-fraud attorney needs to
// sign off before we ship to production. Tracked in backend TODO.md.

struct LiveShieldConsentSheet: View {
  @Environment(\.dismiss) private var dismiss
  let peerNumber: String?
  let onStart: () -> Void

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: AegisSpacing.l) {
          header
          bulletList
          legalNote
          Spacer(minLength: AegisSpacing.l)
          startButton
          cancelButton
        }
        .padding(AegisSpacing.l)
      }
      .background(AegisColor.background.ignoresSafeArea())
      .toolbar(.hidden, for: .navigationBar)
    }
    // NOTE: aging-parent DynamicType pass 2026-04-19
    // Consent sheet clamped at AX3 — this is a legal disclosure that has to
    // fit the bullet list, legal note, and two CTAs on-screen without the
    // user having to hunt for the Start button.
    .dynamicTypeSize(...DynamicTypeSize.accessibility3)
  }

  private var header: some View {
    // NOTE: aging-parent DynamicType pass 2026-04-19
    // 48pt icon + 30pt title have no exact tokens; preserve sizes (so the
    // sheet looks identical at default type) and let the title shrink
    // instead of truncating. Peer number maps to AegisType.mono.
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "shield.lefthalf.filled")
        .font(.system(size: 48, weight: .semibold))
        .foregroundStyle(AegisColor.accent)
      Text("Shield this call")
        .font(.system(size: 30, weight: .bold))
        .minimumScaleFactor(0.7)
        .foregroundStyle(AegisColor.textPrimary)
      if let peer = peerNumber, !peer.isEmpty {
        Text(peer)
          .font(AegisType.mono)
          .foregroundStyle(AegisColor.textSecondary)
      }
    }
  }

  private var bulletList: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      bullet(
        icon: "quote.bubble",
        title: "Read this aloud to the other party",
        body: "\"For your protection, I'm letting you know I'm using an AI assistant on this call to help spot scam patterns. Transcripts stay on my phone and are deleted after 30 days.\" Then ask: \"OK to continue?\""
      )
      bullet(
        icon: "waveform",
        title: "On-device listening",
        body: "Your phone transcribes speech locally using Apple's on-device engine. Audio never leaves this device."
      )
      bullet(
        icon: "text.magnifyingglass",
        title: "Only text is sent",
        body: "We send short transcript snippets to check for known scam phrases (\"gift card,\" \"safe account,\" \"don't hang up,\" etc.)."
      )
      bullet(
        icon: "bell.badge",
        title: "You'll see live warnings",
        body: "If the caller says something that matches a scam pattern, you'll get a color-coded alert in real time."
      )
      bullet(
        icon: "lock.shield",
        title: "Transcripts never leave your phone unencrypted",
        body: "Transcript snippets are encrypted at rest, auto-deleted after 30 days, and you can export or delete them any time from Settings."
      )
    }
  }

  private func bullet(icon: String, title: String, body: String) -> some View {
    // NOTE: aging-parent DynamicType pass 2026-04-19
    // Bullet icon (20pt) sits between AegisType.body(17) and .heading(22);
    // preserve the size, scale it at AX3. Title maps cleanly to
    // AegisType.bodyBold (17/semibold). Body copy is 15pt — no token match,
    // preserve + scale and allow unlimited lines since these bullets are
    // legal-disclosure prose.
    HStack(alignment: .top, spacing: AegisSpacing.m) {
      Image(systemName: icon)
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(AegisColor.accent)
        .frame(width: 28)
      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
        Text(body)
          .font(.system(size: 15))
          .foregroundStyle(AegisColor.textSecondary)
          .minimumScaleFactor(0.7)
          .lineLimit(nil)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private var legalNote: some View {
    // NOTE: aging-parent DynamicType pass 2026-04-19
    // Legal 13pt regular maps to AegisType.caption (13 medium); the link at
    // 13pt semibold has no exact token — preserve size, let it scale.
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Text(
        "AegisDial does not record or store call audio. We only transcribe speech on-device and analyze short text snippets for known scam patterns. Even so, several US states — California, Connecticut, Delaware, Florida, Illinois, Maryland, Massachusetts, Montana, New Hampshire, Pennsylvania, Washington (and Oregon in practice) — require every party on a call to consent before any interception or analysis. Reading the notice above aloud and waiting for the other party's \"yes\" keeps you covered in every US state."
      )
      .font(AegisType.caption)
      .foregroundStyle(AegisColor.textSecondary)
      .lineLimit(nil)
      .fixedSize(horizontal: false, vertical: true)
      Link(
        "Read the full privacy policy",
        destination: URL(string: "https://aegisdial.com/legal/privacy.html")!
      )
      .font(.system(size: 13, weight: .semibold))
      .minimumScaleFactor(0.7)
      .foregroundStyle(AegisColor.accent)
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
  }

  private var startButton: some View {
    // NOTE: aging-parent DynamicType pass 2026-04-19
    // 17pt semibold = AegisType.bodyBold — token swap preserves the look.
    Button {
      onStart()
      dismiss()
    } label: {
      Text("I've given notice — start shield")
        .font(AegisType.bodyBold)
        .minimumScaleFactor(0.7)
        .lineLimit(2)
        .multilineTextAlignment(.center)
        .foregroundStyle(Color.black)
        .frame(maxWidth: .infinity, minHeight: 54)
        .background(AegisColor.accent)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
  }

  private var cancelButton: some View {
    // NOTE: aging-parent DynamicType pass 2026-04-19
    // 17pt medium has no token (body is regular, bodyBold is semibold);
    // preserve the size + add scaling.
    Button { dismiss() } label: {
      Text("Cancel")
        .font(.system(size: 17, weight: .medium))
        .minimumScaleFactor(0.7)
        .foregroundStyle(AegisColor.textSecondary)
        .frame(maxWidth: .infinity, minHeight: 44)
    }
  }
}
