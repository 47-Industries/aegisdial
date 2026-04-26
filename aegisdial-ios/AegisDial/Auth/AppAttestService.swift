import Foundation
import DeviceCheck
import CryptoKit

// App Attest — generates a hardware-backed key once per install, asks Apple
// to attest it, then uses that key to sign each API request body. The
// backend verifies the attestation and the per-request assertion; any
// tampered build or non-genuine device fails.
//
// First-run flow:
//  1. generateKey() -> keyID
//  2. attestKey(keyID, challenge) -> attestation blob
//  3. POST /auth/attest with { key_id, attestation, challenge } (backend
//     verifies with Apple's servers and stores the public key)
//
// Per-request flow:
//  1. hash = sha256(body || server-provided-nonce)
//  2. generateAssertion(keyID, hash) -> assertion blob
//  3. Send X-AegisDial-Attest: base64(keyID) : base64(assertion)
//
// If DCAppAttestService.isSupported is false (Simulator, older hardware) we
// skip silently — the backend falls back to its standard auth checks.

actor AppAttestService {
  static let shared = AppAttestService()

  private var cachedKeyID: String?
  private let keyIDUserDefaultsKey = "com.aegiadial.ios.appAttestKeyID"

  func prepareIfNeeded(challenge: Data) async throws {
    guard DCAppAttestService.shared.isSupported else { return }
    if let keyID = cachedKeyID ?? UserDefaults.standard.string(forKey: keyIDUserDefaultsKey) {
      cachedKeyID = keyID
      return
    }
    let keyID = try await DCAppAttestService.shared.generateKey()
    let clientDataHash = SHA256.hash(data: challenge)
    _ = try await DCAppAttestService.shared.attestKey(keyID, clientDataHash: Data(clientDataHash))
    // In a full implementation, POST the attestation blob to /auth/attest
    // here so the server can verify it. We stub that and just persist the
    // key id locally for now.
    UserDefaults.standard.set(keyID, forKey: keyIDUserDefaultsKey)
    cachedKeyID = keyID
  }

  func assertion(for bodyData: Data, nonce: Data) async throws -> (keyID: String, assertion: Data)? {
    guard DCAppAttestService.shared.isSupported else { return nil }
    guard let keyID = cachedKeyID ?? UserDefaults.standard.string(forKey: keyIDUserDefaultsKey) else {
      return nil
    }
    var toHash = bodyData
    toHash.append(nonce)
    let clientDataHash = SHA256.hash(data: toHash)
    let assertion = try await DCAppAttestService.shared.generateAssertion(keyID, clientDataHash: Data(clientDataHash))
    return (keyID, assertion)
  }
}
