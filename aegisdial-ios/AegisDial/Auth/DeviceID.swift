import Foundation
import UIKit

// Stable per-install identifier we use for Guest auth and as a correlation
// ID in logs. We prefer identifierForVendor when available and fall back to
// a persisted UUID in the Keychain so the ID survives app reinstalls within
// the same iCloud account (keychain access is AfterFirstUnlockThisDeviceOnly
// so it survives as long as the keychain entry exists).

enum DeviceID {
  static func stable() -> String {
    if let existing = KeychainStore.get(.deviceId) { return existing }
    let fromVendor = UIDevice.current.identifierForVendor?.uuidString
    let id = fromVendor ?? UUID().uuidString
    KeychainStore.set(.deviceId, id)
    return id
  }
}
