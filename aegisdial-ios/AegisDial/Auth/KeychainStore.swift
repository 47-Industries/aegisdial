import Foundation
import Security

// Minimal wrapper on kSec* APIs. We keep five keys: auth token, user id,
// auth method, device id, display name. Values are stored as UTF-8
// strings. Passwords are not stored locally — we exchange them once
// for a JWT and discard.
//
// Keychain access group lets the extensions (CallerID, SMS filter,
// Watch) read the same JWT without it ever hitting the App Group
// UserDefaults (which is disk-plaintext at CompleteUntilFirstUserAuth).
// Requires `keychain-access-groups` entitlement with value
// "$(AppIdentifierPrefix)com.aegiadial.ios.shared" on every target.

enum KeychainKey: String {
  case authToken = "com.aegiadial.ios.authToken"
  case deviceId = "com.aegiadial.ios.deviceId"
  case authMethod = "com.aegiadial.ios.authMethod"
  case userId = "com.aegiadial.ios.userId"
  case displayName = "com.aegiadial.ios.displayName"
}

enum KeychainStore {
  /// Shared across the 4 targets. The `$(AppIdentifierPrefix)` is the
  /// team ID prefix Xcode inserts at sign time; we don't hardcode it.
  /// The entitlement file includes the team-prefix token so the OS
  /// expands it at install time.
  static let accessGroup = "com.aegiadial.ios.shared"

  static func set(_ key: KeychainKey, _ value: String?) {
    delete(key)
    guard let data = value?.data(using: .utf8) else { return }
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: key.rawValue,
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    // Only attach the access group when running as a real device build
    // — in the Simulator with no proper team prefix, an access-group
    // attribute triggers errSecMissingEntitlement.
    #if !targetEnvironment(simulator)
    q[kSecAttrAccessGroup as String] = accessGroup
    #endif
    SecItemAdd(q as CFDictionary, nil)
  }

  static func get(_ key: KeychainKey) -> String? {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: key.rawValue,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    #if !targetEnvironment(simulator)
    q[kSecAttrAccessGroup as String] = accessGroup
    #endif
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
          let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func delete(_ key: KeychainKey) {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: key.rawValue,
    ]
    #if !targetEnvironment(simulator)
    q[kSecAttrAccessGroup as String] = accessGroup
    #endif
    SecItemDelete(q as CFDictionary)
  }

  static func clearAll() {
    KeychainKey.allCases.forEach { delete($0) }
  }
}

extension KeychainKey: CaseIterable {}
