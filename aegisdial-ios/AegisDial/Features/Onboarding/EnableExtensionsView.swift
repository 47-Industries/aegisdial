import SwiftUI
import IdentityLookup
import CallKit
import UIKit

// iOS extensions (Caller ID + SMS Filter) do NOT activate just by
// installing the app. Users must manually switch each on in the
// system Settings app. Without this walkthrough users will install
// the app and assume the shields are active when they're not.
//
// Both extensions expose a status API on their manager class —
// ILMessageFilterManager.enabled / CXCallDirectoryManager state —
// that we poll on appear, so we can show a green checkmark when the
// user finishes.
//
// Deep-links: iOS 16+ lets us open Settings to the app's root with
// UIApplication.openSettingsURLString. There is no public URL to open
// directly to "Call Blocking & Identification" or "Unknown & Spam,"
// so we include screenshot-style step-by-step copy alongside the
// Settings button.

struct EnableExtensionsView: View {
  @Environment(\.scenePhase) private var scenePhase
  @State private var smsEnabled: Bool = false
  @State private var callerIdEnabled: Bool = false
  @State private var checking: Bool = false

  var body: some View {
    List {
      Section {
        EmptyStateHeader()
      }

      Section {
        ExtensionStatusRow(
          title: "SMS + MMS + RCS Filter",
          subtitle: "Routes suspected scam texts from unknown senders to Junk.",
          icon: "bubble.left.and.bubble.right.fill",
          enabled: smsEnabled
        )
        stepRow("1.", "Open iOS Settings → Messages")
        stepRow("2.", "Tap Unknown & Spam")
        stepRow("3.", "Turn on Filter Unknown Senders")
        stepRow("4.", "Under SMS Filtering, enable AegisDial")
        openSettingsButton
      } header: {
        Text("Step 1 — SMS filter")
      } footer: {
        Text("iOS won't let us open this screen directly — Apple sandbox rule. Tap Open Settings and follow the steps above.")
          .font(.footnote)
      }

      Section {
        ExtensionStatusRow(
          title: "Live Caller ID Lookup",
          subtitle: "Shows a trust verdict on incoming calls from unsaved numbers.",
          icon: "phone.badge.waveform",
          enabled: callerIdEnabled
        )
        stepRow("1.", "Open iOS Settings → Apps → Phone")
        stepRow("2.", "Tap Call Blocking & Identification")
        stepRow("3.", "Turn on AegisDial")
        openSettingsButton
      } header: {
        Text("Step 2 — Caller ID")
      } footer: {
        Text("On iOS 18+ Live Caller ID lookups happen automatically once AegisDial is enabled in this list.")
          .font(.footnote)
      }

      Section {
        recheckButton
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(AegisColor.background)
    .navigationTitle("Enable iOS Extensions")
    .task { await refreshStatus() }
    .onChange(of: scenePhase) { _, phase in
      // When user returns from Settings, re-poll status so the
      // checkmarks flip to green automatically.
      if phase == .active { Task { await refreshStatus() } }
    }
  }

  private func stepRow(_ number: String, _ text: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(number)
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.accent)
        .frame(width: 22, alignment: .leading)
      Text(text)
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
    }
  }

  private var openSettingsButton: some View {
    Button {
      if let url = URL(string: UIApplication.openSettingsURLString) {
        UIApplication.shared.open(url)
      }
    } label: {
      Label("Open iOS Settings", systemImage: "arrow.up.forward.app.fill")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.accent)
    }
    .accessibilityLabel("Open iOS Settings")
  }

  private var recheckButton: some View {
    Button {
      Task { await refreshStatus() }
    } label: {
      HStack {
        if checking { ProgressView().scaleEffect(0.8) }
        Label(checking ? "Checking…" : "Re-check status", systemImage: "arrow.clockwise")
      }
    }
    .disabled(checking)
  }

  private func refreshStatus() async {
    checking = true
    defer { checking = false }

    // SMS filter status — iOS 14+ SDK: `class var shared: ILMessageFilterManager`.
    let sms = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
      ILMessageFilterManager.shared.getSettings { settings, _ in
        cont.resume(returning: settings?.enabled ?? false)
      }
    }

    // Caller ID status via CXCallDirectoryManager. Bundle id for the
    // extension matches what's declared in project.yml.
    let callerId = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
      let bundleId = (Bundle.main.bundleIdentifier ?? "com.fortyseven.aegisdial") + ".CallerID"
      CXCallDirectoryManager.sharedInstance.getEnabledStatusForExtension(withIdentifier: bundleId) { status, _ in
        cont.resume(returning: status == .enabled)
      }
    }

    await MainActor.run {
      smsEnabled = sms
      callerIdEnabled = callerId
    }
  }
}

// MARK: - Sub views

private struct EmptyStateHeader: View {
  var body: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.s) {
      Image(systemName: "gearshape.2.fill")
        .font(.system(size: 38, weight: .semibold))
        .foregroundStyle(AegisColor.accent)
      Text("Flip two switches in Settings")
        .font(AegisType.heading)
        .foregroundStyle(AegisColor.textPrimary)
      Text("iOS requires you to manually enable each extension — AegisDial can't toggle them on your behalf. Two minutes, done forever.")
        .font(AegisType.body)
        .foregroundStyle(AegisColor.textSecondary)
    }
    .padding(.vertical, 6)
  }
}

private struct ExtensionStatusRow: View {
  let title: String
  let subtitle: String
  let icon: String
  let enabled: Bool

  var body: some View {
    HStack(alignment: .top, spacing: AegisSpacing.m) {
      Image(systemName: icon)
        .font(.system(size: 24, weight: .semibold))
        .foregroundStyle(AegisColor.accent)
        .frame(width: 36)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(title).font(AegisType.bodyBold).foregroundStyle(AegisColor.textPrimary)
          Spacer()
          if enabled {
            Label("Enabled", systemImage: "checkmark.circle.fill")
              .labelStyle(.iconOnly)
              .foregroundStyle(AegisColor.verdictTrusted)
              .accessibilityLabel("Enabled")
          } else {
            Label("Off", systemImage: "xmark.circle.fill")
              .labelStyle(.iconOnly)
              .foregroundStyle(AegisColor.textTertiary)
              .accessibilityLabel("Off")
          }
        }
        Text(subtitle)
          .font(AegisType.caption)
          .foregroundStyle(AegisColor.textSecondary)
      }
    }
    .padding(.vertical, 6)
  }
}
