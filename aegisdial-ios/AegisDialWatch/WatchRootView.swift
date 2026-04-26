import SwiftUI
import WatchConnectivity
import WatchKit

// Watch face — minimal, big, glanceable. Three states:
//   1. Active shield: big risk score + color + pulse
//   2. Unseen guardian alerts: count + open CTA
//   3. Idle: status sentence + "open iPhone" hint

struct WatchRootView: View {
  @Environment(WatchStore.self) private var store
  // Two-tap confirm pattern for End Shield. A single accidental
  // wrist-brush on Apple Watch is cheap enough that users have been
  // known to end a shield mid-scam. First tap arms; second tap (within
  // the 3s window) fires. We play a warning haptic on arm so the user
  // feels the difference between tap 1 and tap 2.
  @State private var confirmingEnd: Bool = false
  @State private var confirmTimeoutTask: Task<Void, Never>?

  var body: some View {
    ScrollView {
      VStack(spacing: 12) {
        if store.activeShield {
          activeShieldCard
        } else if store.unseenGuardianCount > 0 {
          guardianSummary
        } else {
          idleCard
        }

        // Always-available "open on iPhone" action so the Watch has at
        // least one tappable control (App Review 4.2.2 floor).
        Button {
          requestOpenOnPhone()
        } label: {
          Label("Open on iPhone", systemImage: "iphone.gen3")
            .font(.system(size: 13, weight: .semibold))
        }
        .buttonStyle(.bordered)
        .tint(.blue)

        if let t = store.lastUpdated {
          Text("Updated \(relative(t))")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
      }
      .padding(.vertical, 4)
    }
    .navigationTitle("AegisDial")
  }

  /// Ask the phone app to wake & come to foreground. WCSession only
  /// delivers this when the Watch is paired and the phone app is
  /// reachable; silently no-ops otherwise.
  private func requestOpenOnPhone() {
    guard WCSession.default.activationState == .activated else { return }
    WCSession.default.sendMessage(
      ["action": "open_phone_app"],
      replyHandler: nil,
      errorHandler: nil
    )
  }

  private var activeShieldCard: some View {
    VStack(spacing: 10) {
      VStack(spacing: 8) {
        Text("SHIELD ACTIVE")
          .font(.system(size: 11, weight: .bold, design: .rounded))
          .tracking(1.3)
          .foregroundStyle(.secondary)
        Text("\(store.currentRiskScore)")
          .font(.system(size: 48, weight: .bold, design: .rounded))
          .foregroundStyle(riskColor)
          .contentTransition(.numericText())
        Text(riskHeadline)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(riskColor)
          .multilineTextAlignment(.center)
      }
      .padding(12)
      .frame(maxWidth: .infinity)
      .background(riskColor.opacity(0.12))
      .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      .accessibilityLabel("Shield active, risk \(store.currentRiskScore). \(riskHeadline)")

      // Destructive action: tell the iPhone to tear down the shield.
      // Optimistically flip state so the UI reacts instantly — if the
      // phone never got the message (Watch offline) the next
      // applicationContext push will reconcile.
      //
      // Two-tap confirm: tap 1 arms + warning haptic + relabels to
      // "Confirm end"; tap 2 (within 3s) actually ends. Any state
      // change or 3s timeout resets back to the armed-off state.
      Button(role: .destructive) {
        if confirmingEnd {
          endShield()
          resetConfirm()
        } else {
          armConfirm()
        }
      } label: {
        Label(
          confirmingEnd ? "Confirm end" : "End Shield",
          systemImage: "phone.down.fill"
        )
          .font(.system(size: 14, weight: .semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .tint(.red)
      .accessibilityHint(
        confirmingEnd
          ? "Tap again within three seconds to end the shield."
          : "Stops the active call shield on your iPhone."
      )
    }
  }

  /// Arm the two-tap confirm: flip `confirmingEnd`, play warning
  /// haptic, start a 5s auto-reset timer. Cancels any previous timer.
  /// Window is 5s (not 3s) — watchOS users often hesitate when reading
  /// a button label flip, and a silent revert at 3.0s followed by a
  /// 3.1s tap ARMS the confirm again instead of ending, which reads as
  /// a broken button. On timeout we play a `.click` haptic so the user
  /// feels the state flip back.
  private func armConfirm() {
    WKInterfaceDevice.current().play(.notification)
    confirmingEnd = true
    confirmTimeoutTask?.cancel()
    confirmTimeoutTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      if !Task.isCancelled {
        confirmingEnd = false
        WKInterfaceDevice.current().play(.click)
      }
    }
  }

  /// Clear the armed state and cancel any pending timeout. Called
  /// after a successful end, not on timeout (the Task itself handles
  /// that case so we don't double-schedule).
  private func resetConfirm() {
    confirmTimeoutTask?.cancel()
    confirmTimeoutTask = nil
    confirmingEnd = false
  }

  /// Send `end_shield` back to the phone, play a tap haptic, and flip
  /// `store.activeShield` off immediately. Errors are swallowed (logged
  /// only) — Watch reachability is intermittent and the phone will
  /// reconcile via the next applicationContext update.
  private func endShield() {
    WKInterfaceDevice.current().play(.success)
    store.activeShield = false

    // Fire-and-forget on a detached task so we never block the main
    // actor on a flaky Watch radio.
    Task.detached(priority: .userInitiated) {
      guard WCSession.default.activationState == .activated else {
        // Session not up yet — nothing to do. Context sync will
        // eventually realign state if the phone is still shielding.
        return
      }
      WCSession.default.sendMessage(
        ["action": "end_shield"],
        replyHandler: nil,
        errorHandler: { err in
          // Log only — this is best-effort. The phone side is
          // idempotent and will reconcile on next context push.
          print("[AegisDialWatch] end_shield send failed: \(err.localizedDescription)")
        }
      )
    }
  }

  private var guardianSummary: some View {
    VStack(spacing: 6) {
      Image(systemName: "bell.badge.fill")
        .font(.system(size: 24))
        .foregroundStyle(.orange)
        .accessibilityHidden(true)
      Text("\(store.unseenGuardianCount) new")
        .font(.system(size: 20, weight: .bold))
      Text(store.unseenGuardianCount == 1 ? "guardian alert" : "guardian alerts")
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
    }
    .padding(16)
    .frame(maxWidth: .infinity)
    .background(Color.orange.opacity(0.12))
    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
  }

  private var idleCard: some View {
    VStack(spacing: 8) {
      Image(systemName: "shield.lefthalf.filled")
        .font(.system(size: 32))
        .foregroundStyle(.blue)
        .accessibilityHidden(true)
      Text("All clear")
        .font(.system(size: 16, weight: .semibold))
      Text("Open AegisDial on your phone to shield a call.")
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .padding(16)
    .frame(maxWidth: .infinity)
  }

  private var riskColor: Color {
    switch store.currentRisk {
    case "critical": return .red
    case "high":     return .orange
    case "medium":   return .yellow
    default:         return .green
    }
  }

  private var riskHeadline: String {
    switch store.currentRisk {
    case "critical": return "Hang up now"
    case "high":     return "Likely scam"
    case "medium":   return "Watch this call"
    default:         return "All clear"
    }
  }

  private func relative(_ date: Date) -> String {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .abbreviated
    return f.localizedString(for: date, relativeTo: .now)
  }
}
