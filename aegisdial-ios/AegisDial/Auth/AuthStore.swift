import Foundation
import AuthenticationServices
import SwiftUI
import Observation

// Central source of truth for auth state. The rest of the app observes
// `state` and reacts — e.g., root view flips to Home when .signedIn,
// Onboarding when .signedOut. Any sign-in path ends with `persist(...)`.

@MainActor
@Observable
final class AuthStore {
  enum State: Equatable {
    case signedOut
    case signingIn
    case signedIn(SignedInContext)
    case error(String)
  }

  struct SignedInContext: Equatable {
    let userId: String
    let method: AuthMethod
    let tier: String
    let displayName: String?
  }

  enum AuthMethod: String, Codable {
    case apple
    case email
  }

  var state: State = .signedOut

  init() { restoreFromKeychain() }

  // MARK: - Public sign-in flows

  func signInWithApple(idToken: String, displayName: String?, dobYear: Int? = nil) async {
    await perform {
      let res = try await APIClient.shared.authApple(idToken: idToken, displayName: displayName, dobYear: dobYear)
      await self.persist(token: res.token, userId: res.userId, method: .apple, tier: res.tier, displayName: displayName)
    }
  }

  func signUpWithEmail(email: String, password: String, displayName: String?, dobYear: Int) async {
    await perform {
      let res = try await APIClient.shared.authEmailSignup(email: email, password: password, displayName: displayName, dobYear: dobYear)
      await self.persist(token: res.token, userId: res.userId, method: .email, tier: res.tier, displayName: displayName)
    }
  }

  func signInWithEmail(email: String, password: String) async {
    await perform {
      let res = try await APIClient.shared.authEmailLogin(email: email, password: password)
      await self.persist(token: res.token, userId: res.userId, method: .email, tier: res.tier, displayName: nil)
    }
  }

  func signOut() {
    KeychainStore.clearAll()
    Task { await APIClient.shared.setToken(nil) }
    state = .signedOut
  }

  // MARK: - Internals

  private func perform(_ op: @escaping () async throws -> Void) async {
    state = .signingIn
    do {
      try await op()
    } catch let err as APIError {
      state = .error(err.localizedDescription)
    } catch {
      state = .error(error.localizedDescription)
    }
  }

  private func persist(token: String, userId: String, method: AuthMethod, tier: String, displayName: String?) async {
    // Store in the shared Keychain access group so the CallerID + SMS
    // filter + Watch extensions can authenticate too — WITHOUT ever
    // writing the raw JWT to on-disk UserDefaults (which would be
    // CompleteUntilFirstUserAuth-only, readable by forensic tools).
    KeychainStore.set(.authToken, token)
    KeychainStore.set(.userId, userId)
    KeychainStore.set(.authMethod, method.rawValue)
    if let n = displayName { KeychainStore.set(.displayName, n) }
    await APIClient.shared.setToken(token)
    state = .signedIn(.init(userId: userId, method: method, tier: tier, displayName: displayName ?? KeychainStore.get(.displayName)))
  }

  private func restoreFromKeychain() {
    guard
      let token = KeychainStore.get(.authToken),
      let userId = KeychainStore.get(.userId),
      let methodRaw = KeychainStore.get(.authMethod),
      let method = AuthMethod(rawValue: methodRaw)
    else { return }
    Task { await APIClient.shared.setToken(token) }
    state = .signedIn(.init(
      userId: userId,
      method: method,
      tier: "free", // refreshed on next /auth/me call
      displayName: KeychainStore.get(.displayName)
    ))
  }
}
