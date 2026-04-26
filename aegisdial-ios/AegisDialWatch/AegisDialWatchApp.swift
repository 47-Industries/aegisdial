import SwiftUI

// AegisDial Watch companion. Two primary surfaces for watchOS 11+:
//   - WatchRootView — shows active-shield status + unseen guardian count
//   - WatchGuardianListView — tap-through to see individual guardian alerts
//
// Data sync: reads from the shared App Group (`group.com.aegisdial.app`)
// where the phone app writes the current user's auth token + last-known
// state. We don't hit the backend directly from the watch — watchOS
// network is flaky and battery-expensive. The phone does the heavy
// lifting and publishes via WatchConnectivity.

@main
struct AegisDialWatchApp: App {
  @State private var store = WatchStore.shared

  var body: some Scene {
    WindowGroup {
      WatchRootView()
        .environment(store)
    }
  }
}
