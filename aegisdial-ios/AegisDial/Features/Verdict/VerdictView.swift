import SwiftUI

// The rich result card. Gauge on top, big statement message, then evidence
// list. User can tap "Report" to flag the number, which POSTs to /v1/report
// and ingests a user-reported complaint into the scoring pipeline.

struct VerdictView: View {
  let result: VerdictResponse
  var onReport: () -> Void
  @State private var showingEvidence = false

  var body: some View {
    VStack(spacing: AegisSpacing.l) {
      TrustScoreGauge(score: result.trustScore, verdict: result.verdict)
        .padding(.top, AegisSpacing.m)

      VStack(spacing: AegisSpacing.s) {
        Text(result.number)
          .font(AegisType.heading)
          .foregroundStyle(AegisColor.textSecondary)
        if let message = result.userMessage, !message.isEmpty {
          Text(message)
            .font(.system(size: 20, weight: .medium, design: .rounded))
            .foregroundStyle(AegisColor.textPrimary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        } else {
          Text(result.summary)
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textSecondary)
            .multilineTextAlignment(.center)
        }
      }
      .padding(.horizontal, AegisSpacing.l)

      if let business = result.signals.businessMatch {
        businessCard(business)
      }

      if let info = result.publicInfo, info.hasAnyInfo {
        publicInfoCard(info)
      }

      signalRow
      actionRow
      evidenceSection
    }
    .padding(AegisSpacing.l)
    .background(AegisColor.surfaceElevated)
    .overlay(RoundedRectangle(cornerRadius: AegisRadius.l).stroke(AegisColor.hairline, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.l, style: .continuous))
  }

  // "Who is this number?" card. Renders caller name + carrier + line
  // type when any of it is known, plus a spoofability flag for VoIP /
  // toll-free where the caller ID itself is weak evidence. Sits above
  // the reports/signals row because knowing who's calling is the
  // question the user is actually asking.
  private func publicInfoCard(_ info: VerdictResponse.PublicPhoneInfo) -> some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      HStack(spacing: AegisSpacing.s) {
        Image(systemName: info.isLikelyBurner
                ? "person.crop.circle.badge.exclamationmark"
                : (info.isSpoofable
                    ? "person.crop.circle.badge.questionmark"
                    : "person.crop.circle.fill"))
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(info.isLikelyBurner || info.isOverseas
                           ? AegisColor.verdictSpoofHigh
                           : (info.isSpoofable ? AegisColor.accent : AegisColor.verdictTrusted))
        Text(info.ownerName ?? "Caller identity unknown")
          .font(AegisType.bodyBold)
          .foregroundStyle(AegisColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
        Spacer()
      }
      VStack(alignment: .leading, spacing: 4) {
        if let carrier = info.carrierName {
          infoRow(icon: "antenna.radiowaves.left.and.right",
                  text: "\(info.displayLineType) · \(carrier)")
        } else {
          infoRow(icon: "antenna.radiowaves.left.and.right",
                  text: info.displayLineType)
        }
        if let city = info.city {
          let loc: String = {
            if let state = info.stateCode { return "\(city), \(state)" }
            return city
          }()
          infoRow(icon: "mappin.and.ellipse", text: loc)
        }
        // Most important warnings FIRST — burner and overseas override
        // a generic "spoofable VoIP" message because they're more
        // specific and more alarming.
        if info.isLikelyBurner {
          let label = info.burnerService ?? "disposable / burner service"
          infoRow(
            icon: "flame.fill",
            text: "Caller is using \(label). Scammers prefer these because they're untraceable.",
            tint: AegisColor.verdictSpoofHigh
          )
        } else if info.isSpoofable {
          infoRow(
            icon: "exclamationmark.shield.fill",
            text: "This line type is easier to spoof — trust caller ID less.",
            tint: AegisColor.verdictSpoofHigh
          )
        }
        if info.isOverseas {
          infoRow(
            icon: "globe.americas.fill",
            text: "Call is coming from outside the US/Canada. Unexpected international calls are a common elder-scam pattern.",
            tint: AegisColor.verdictSpoofHigh
          )
        }
        // "First seen X ago" from our own data. A number we're seeing
        // for the very first time — or just hours ago — is dramatically
        // more likely to be a fresh scammer provisioning.
        if let firstSeenText = firstSeenBanner(result.signals.firstSeen) {
          infoRow(
            icon: "clock.badge.exclamationmark.fill",
            text: firstSeenText,
            tint: AegisColor.verdictSpoofHigh
          )
        }
      }
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.surface)
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  /// Returns a warning string if the number was first-seen by AegisDial
  /// very recently (< 7 days). Recency + VoIP + unknown-owner is the
  /// three-legged stool of "freshly-provisioned scammer burner."
  private func firstSeenBanner(_ firstSeenIso: String?) -> String? {
    guard let firstSeenIso else { return nil }
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = iso.date(from: firstSeenIso) ?? ISO8601DateFormatter().date(from: firstSeenIso)
    guard let date else { return nil }
    let seconds = Date().timeIntervalSince(date)
    if seconds < 60 * 60 {
      let mins = max(1, Int(seconds / 60))
      return "First time we've seen this number — \(mins) \(mins == 1 ? "minute" : "minutes") ago. Fresh numbers are a scam red flag."
    }
    if seconds < 24 * 60 * 60 {
      let hrs = max(1, Int(seconds / 3600))
      return "AegisDial first saw this number \(hrs) \(hrs == 1 ? "hour" : "hours") ago. Freshly-provisioned numbers are often scams."
    }
    if seconds < 7 * 24 * 60 * 60 {
      let days = max(1, Int(seconds / 86400))
      return "AegisDial first saw this number \(days) \(days == 1 ? "day" : "days") ago — still relatively new."
    }
    return nil
  }

  private func infoRow(icon: String, text: String, tint: Color = AegisColor.textSecondary) -> some View {
    HStack(spacing: AegisSpacing.s) {
      Image(systemName: icon)
        .foregroundStyle(tint)
        .frame(width: 20)
      Text(text)
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      Spacer()
    }
  }

  private func businessCard(_ match: VerdictResponse.BusinessMatch) -> some View {
    HStack(spacing: AegisSpacing.m) {
      Image(systemName: "checkmark.seal.fill")
        .font(.system(size: 22))
        .foregroundStyle(AegisColor.verdictTrusted)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(match.name).font(AegisType.bodyBold).foregroundStyle(AegisColor.textPrimary)
        Text("Verified \(match.category)")
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textSecondary)
      }
      Spacer()
    }
    .padding(AegisSpacing.m)
    .background(AegisColor.verdictTrusted.opacity(0.10))
    .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.verdictTrusted.opacity(0.35), lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var signalRow: some View {
    HStack(spacing: AegisSpacing.s) {
      pill(icon: "bubble.left.and.bubble.right.fill",
           label: "\(result.signals.mentionCountAll ?? 0) reports")
      pill(icon: "flag.fill",
           label: "\(result.signals.spoofReports30d ?? 0) spoof/30d",
           tint: (result.signals.spoofReports30d ?? 0) > 0 ? AegisColor.verdictSpoofHigh : nil)
      if let carrier = result.signals.carrier {
        pill(icon: "antenna.radiowaves.left.and.right", label: carrier)
      }
    }
  }

  private func pill(icon: String, label: String, tint: Color? = nil) -> some View {
    HStack(spacing: 6) {
      Image(systemName: icon).font(.system(size: 11, weight: .semibold))
      Text(label).font(AegisType.caption)
    }
    .padding(.horizontal, AegisSpacing.m)
    .padding(.vertical, AegisSpacing.s)
    .foregroundStyle(tint ?? AegisColor.textSecondary)
    .background((tint ?? AegisColor.textSecondary).opacity(0.12))
    .clipShape(Capsule())
  }

  private var actionRow: some View {
    HStack(spacing: AegisSpacing.s) {
      Button {
        AegisHaptic.warning.play()
        onReport()
      } label: {
        Label("Report as scam", systemImage: "flag.fill")
          .font(AegisType.bodyBold)
          .frame(maxWidth: .infinity, minHeight: 48)
          .foregroundStyle(AegisColor.verdictSpoofHigh)
          .background(AegisColor.verdictSpoofHigh.opacity(0.12))
          .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      }
      Button {
        AegisHaptic.selection.play()
        withAnimation(AegisMotion.spring) { showingEvidence.toggle() }
      } label: {
        Label(
          showingEvidence ? "Hide evidence" : "Why \(result.trustScore)?",
          systemImage: showingEvidence ? "chevron.up" : "doc.text.magnifyingglass"
        )
        .font(AegisType.bodyBold)
        .frame(maxWidth: .infinity, minHeight: 48)
        .foregroundStyle(AegisColor.textPrimary)
        .background(AegisColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
      }
    }
  }

  @ViewBuilder
  private var evidenceSection: some View {
    if showingEvidence {
      VStack(alignment: .leading, spacing: AegisSpacing.s) {
        HStack {
          Text("Evidence").font(AegisType.heading).foregroundStyle(AegisColor.textPrimary)
          Spacer()
          Text("\(result.evidence.count) sources")
            .font(AegisType.caption).foregroundStyle(AegisColor.textTertiary)
        }
        if result.evidence.isEmpty {
          Text("No public reports for this number.")
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textSecondary)
            .padding(AegisSpacing.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AegisColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
        } else {
          ForEach(Array(result.evidence.enumerated()), id: \.offset) { _, e in
            EvidenceRow(evidence: e)
          }
        }
      }
      .padding(.top, AegisSpacing.s)
      .transition(.opacity.combined(with: .move(edge: .top)))
    }
  }
}

private struct EvidenceRow: View {
  let evidence: VerdictResponse.Evidence
  var body: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.xs) {
      HStack {
        Text(sourceLabel).font(AegisType.caption).foregroundStyle(AegisColor.accent)
        Spacer()
        if let d = evidence.date { Text(relativeDate(d)).font(AegisType.caption).foregroundStyle(AegisColor.textTertiary) }
      }
      if let s = evidence.snippet, !s.isEmpty {
        Text(s)
          .font(AegisType.body)
          .foregroundStyle(AegisColor.textSecondary)
          .lineLimit(4)
      }
    }
    .padding(AegisSpacing.m)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AegisColor.surface)
    .overlay(RoundedRectangle(cornerRadius: AegisRadius.m).stroke(AegisColor.hairline, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: AegisRadius.m, style: .continuous))
  }

  private var sourceLabel: String {
    switch evidence.source {
    case "fcc_complaints": return "FCC Consumer Complaint"
    case "bbb_scamtracker": return "BBB Scam Tracker"
    case "800notes": return "800notes.com"
    case "youtube_video", "youtube_comment": return "YouTube"
    case "reddit": return "Reddit"
    default: return evidence.source.replacingOccurrences(of: "_", with: " ").capitalized
    }
  }

  private func relativeDate(_ iso: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    guard let date else { return "" }
    let rf = RelativeDateTimeFormatter()
    rf.unitsStyle = .short
    return rf.localizedString(for: date, relativeTo: .now)
  }
}
