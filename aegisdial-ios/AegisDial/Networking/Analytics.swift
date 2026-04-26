import Foundation

// Thin client-side analytics facade. Generates (and persists) a stable
// anonymous ID on first use so pre-signup funnel events can be stitched
// together, then fires events through APIClient.
//
// Usage:
//   Analytics.shared.track(.onboardingStarted)
//   Analytics.shared.track(.permissionGranted, ["permission": "mic"])
//
// Events are fire-and-forget — the returned Task is intentionally
// unretained. If you need sequencing, await it yourself at the call site.

public enum AnalyticsEventName: String {
  // Onboarding / signup funnel
  case onboardingStarted = "onboarding_started"
  case onboardingTourPageViewed = "onboarding_tour_page_viewed"
  case onboardingTourSkipped = "onboarding_tour_skipped"
  case onboardingTourCompleted = "onboarding_tour_completed"
  case authAppleTapped = "auth_apple_tapped"
  case authAppleAgeSubmitted = "auth_apple_age_submitted"
  case authEmailTapped = "auth_email_tapped"
  case authEmailSubmitted = "auth_email_submitted"

  // Permissions
  case permissionPrompted = "permission_prompted"
  case permissionGranted = "permission_granted"
  case permissionDenied = "permission_denied"

  // Feature CTAs
  case liveShieldCTATapped = "live_shield_cta_tapped"
  case recoveryCTATapped = "recovery_cta_tapped"
  case demoCallStarted = "demo_call_started"

  // Protect-a-Parent flow
  case protectParentFlowStarted = "protect_parent_flow_started"
  case protectParentInviteSent = "protect_parent_invite_sent"
  case protectParentSafeWordSaved = "protect_parent_safeword_saved"
  case protectParentFlowCompleted = "protect_parent_flow_completed"

  // Client telemetry — fires when we silently swallow an API error on a
  // non-critical path (e.g. Home's "resume active recovery" fetch). Lets
  // us see real outages in PostHog instead of users complaining of a
  // missing banner. Backend allowlist must accept this name too.
  case apiErrorSilenced = "api_error_silenced"
}

public actor Analytics {
  public static let shared = Analytics()

  private let anonymousIdKey = "aegisdial.analytics.anonymous_id"

  private init() {}

  private func anonymousId() -> String {
    let defaults = UserDefaults.standard
    if let existing = defaults.string(forKey: anonymousIdKey), !existing.isEmpty {
      return existing
    }
    let new = UUID().uuidString
    defaults.set(new, forKey: anonymousIdKey)
    return new
  }

  @discardableResult
  public func track(
    _ event: AnalyticsEventName,
    _ properties: [String: Any]? = nil
  ) -> Task<Void, Never> {
    // Serialize properties to JSON Data at dispatch time. `[String: Any]`
    // is not Sendable; Data is. This keeps the call-site ergonomics
    // (mixed-type dict) while satisfying Swift 6 strict concurrency.
    let name = event.rawValue
    let payload: Data? = Self.encode(properties)
    return Task.detached(priority: .background) {
      await Analytics.shared.trackRaw(name: name, propertiesJSON: payload)
    }
  }

  // Called by the detached Task. Actor-isolated so the Keychain / anon-id
  // read is serialized. Parameters are all Sendable (String + Data?).
  internal func trackRaw(name: String, propertiesJSON: Data?) async {
    let anon = anonymousId()
    await APIClient.shared.trackEventJSON(
      name: name,
      propertiesJSON: propertiesJSON,
      anonymousId: anon
    )
  }

  fileprivate static func encode(_ properties: [String: Any]?) -> Data? {
    guard let properties, !properties.isEmpty else { return nil }
    guard JSONSerialization.isValidJSONObject(properties) else {
      // A non-JSON-serializable value (e.g. a Date, a URL, a non-String
      // key) slipped into a Track.event call. In production we silently
      // drop the properties so the event still fires; in DEBUG we crash
      // so the developer notices before shipping.
      #if DEBUG
      assertionFailure("Analytics payload is not JSON-serializable: \(properties)")
      #endif
      return nil
    }
    do {
      return try JSONSerialization.data(withJSONObject: properties)
    } catch {
      #if DEBUG
      assertionFailure("Analytics payload failed JSON encode: \(error) payload=\(properties)")
      #endif
      return nil
    }
  }
}

// Sync-friendly shim for call sites that are not already inside an async
// context. The common onboarding/permission callbacks are synchronous
// closures; this keeps them one-liners.
//
// We encode `properties` to JSON Data at the sync call site, then hand
// only Sendable types (String + Data?) into the detached Task so Swift 6
// strict-concurrency captures check out.
public enum Track {
  public static func event(
    _ event: AnalyticsEventName,
    _ properties: [String: Any]? = nil
  ) {
    let name = event.rawValue
    let payload = Analytics.encode(properties)
    Task.detached(priority: .background) {
      await Analytics.shared.trackRaw(name: name, propertiesJSON: payload)
    }
  }
}
