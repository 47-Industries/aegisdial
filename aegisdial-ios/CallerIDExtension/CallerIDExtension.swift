import Foundation
import Security
import LiveCallerIDLookupExtension

// iOS 18+ Live Caller ID Lookup extension. Called by the system whenever an
// incoming call arrives for a number the user hasn't saved in Contacts. We
// synchronously hit our backend (with a tight timeout) and return a
// LiveCallerIDLookupResult that the system renders as the caller label.
//
// The extension runs in a sandboxed process with limited memory. Keep this
// file dependency-free; do not import any of the main app's files.

final class CallerIDExtension: LiveCallerIDLookupExtension {
  // Baked at build time. The production build should point at the real API.
  // URL(static:) isn't available on this SDK, so guard the parse: if it
  // ever returns nil (only possible if the literal above gets mangled),
  // fall back to localhost — which won't resolve in the extension sandbox
  // and will cause `fetchVerdict` to return `.unknown`, the safe default.
  private let backendURL: URL = URL(string: "https://api.aegisdial.com") ?? URL(fileURLWithPath: "/")
  private let timeout: TimeInterval = 2.5
  // The class holds no mutable state (backendURL/timeout are `let`, apiKey
  // is computed per-call from the Keychain). `@unchecked Sendable` was
  // covering for earlier code that had `var`; now it's unnecessary.
  // Read the JWT from the shared Keychain access group (not App Group
  // UserDefaults — that's disk-plaintext at CompleteUntilFirstUserAuth).
  // Requires `keychain-access-groups` entitlement with
  // "$(AppIdentifierPrefix)com.aegisdial.ios.shared".
  //
  // No fallback: if the user isn't signed in or the entitlement is missing
  // the extension returns an unknown-verdict label rather than firing a
  // request with a hardcoded secret (which would leak a shared token into
  // network logs and bypass per-user rate limits).
  private var apiKey: String? { Self.readSharedKeychainToken() }

  private static func readSharedKeychainToken() -> String? {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: "com.aegisdial.ios.authToken",
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    #if !targetEnvironment(simulator)
    q[kSecAttrAccessGroup as String] = "com.aegisdial.ios.shared"
    #endif
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
          let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  override func lookup(phoneNumber: String) async throws -> LiveCallerIDLookupResult {
    let e164 = phoneNumber.starts(with: "+") ? phoneNumber : "+\(phoneNumber)"
    let verdict = try await fetchVerdict(for: e164)
    return .init(
      contactIdentifier: "aegisdial:\(e164)",
      attributes: [
        .name: verdict.label,
        .category: verdict.category,
        .flag: verdict.isSpam ? "Spam" : nil,
      ].compactMapValues { $0 }
    )
  }

  // MARK: - Networking

  private func fetchVerdict(for e164: String) async throws -> ExtensionVerdict {
    // No token → we can't authenticate, so we short-circuit to an unknown
    // verdict instead of leaking a hardcoded dev secret on the wire.
    guard let apiKey else { return .unknown(e164) }

    var req = URLRequest(url: backendURL.appendingPathComponent("/v1/verdict"), timeoutInterval: timeout)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
    req.httpBody = try JSONSerialization.data(withJSONObject: ["number": e164])

    let (data, response) = try await URLSession.shared.data(for: req)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      return .unknown(e164)
    }
    let decoded = try JSONDecoder().decode(ExtensionPayload.self, from: data)
    return ExtensionVerdict(from: decoded, number: e164)
  }
}

// Minimal JSON shape — keep decoder independent of the main app's types.
private struct ExtensionPayload: Decodable {
  let trust_score: Int?
  let verdict: String?
  let summary: String?
  let user_message: String?
  let signals: ExtSignals?

  struct ExtSignals: Decodable {
    let business_match: ExtBusiness?
    struct ExtBusiness: Decodable { let name: String; let verified: Bool }
  }
}

private struct ExtensionVerdict {
  let label: String
  let category: String
  let isSpam: Bool

  init(from p: ExtensionPayload, number: String) {
    let score = p.trust_score ?? 50
    let verdict = p.verdict ?? "unknown"
    let business = p.signals?.business_match
    self.isSpam = score < 40 || verdict == "spoof_risk_high" || verdict == "likely_spoof"

    if let bm = business, bm.verified, !isSpam {
      self.label = "✓ \(bm.name)"
      self.category = "Verified"
    } else if verdict == "spoof_risk_high" {
      self.label = "⚠️ Possible Spoof – \(p.signals?.business_match?.name ?? number)"
      self.category = "Spoof Risk"
    } else if isSpam {
      self.label = "🚫 Suspected Scam (\(score))"
      self.category = "Scam"
    } else if score >= 70 {
      self.label = "✓ Trusted (\(score))"
      self.category = "Trusted"
    } else {
      self.label = "• Unknown (\(score))"
      self.category = "Unknown"
    }
  }

  static func unknown(_ number: String) -> ExtensionVerdict {
    .init(from: ExtensionPayload(trust_score: 50, verdict: "unknown", summary: nil, user_message: nil, signals: nil), number: number)
  }
}
