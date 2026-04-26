import Foundation

// Plain-language error surface for user-facing banners / toasts.
//
// `Error.localizedDescription` for a URLError or a decoding error tends
// to read like "The Internet connection appears to be offline." or
// "The data couldn't be read because it is missing." — technically
// accurate but cold. AegisDial serves people who have just been
// targeted by a scam; reassurance matters more than precision.
//
// This type maps any `Error` the app raises into one of a small number
// of buckets, each with copy the CEO / founder has signed off on, plus
// a `retryable` hint so views can optionally show a retry CTA.

public enum AegisError: Error, Equatable, Sendable {
  case offline
  case serverUnreachable
  case unauthorized
  case paywall
  case rateLimited
  case unknown(String)

  /// Convert any `Error` into an AegisError. Order matters: more
  /// specific types (`APIError`, `URLError`) are checked before the
  /// generic fallback.
  public static func from(_ error: Error) -> AegisError {
    // Idempotent: if someone already mapped this error to an
    // AegisError, pass it through instead of re-wrapping as `.unknown`
    // which would drop the bucket and lose retryable/category info.
    if let already = error as? AegisError { return already }
    if let api = error as? APIError {
      return fromAPI(api)
    }
    if let urlError = error as? URLError {
      return fromURL(urlError)
    }
    // NSError wraps a surprising number of transport failures on iOS.
    // Cocoa's `NSURLErrorDomain` maps 1:1 to `URLError.Code`.
    let ns = error as NSError
    if ns.domain == NSURLErrorDomain {
      let code = URLError.Code(rawValue: ns.code)
      return fromURL(URLError(code))
    }
    return .unknown(error.localizedDescription)
  }

  private static func fromAPI(_ api: APIError) -> AegisError {
    switch api {
    case .notAuthenticated:
      return .unauthorized
    case .badStatus(let code, _):
      switch code {
      case 401, 403: return .unauthorized
      case 402: return .paywall
      case 429: return .rateLimited
      case 500...599: return .serverUnreachable
      default: return .unknown("Request failed (\(code))")
      }
    case .invalidResponse:
      return .serverUnreachable
    case .transport(let underlying):
      if let u = underlying as? URLError { return fromURL(u) }
      return .unknown(underlying.localizedDescription)
    case .decoding:
      return .unknown("We had trouble reading the server's reply.")
    }
  }

  private static func fromURL(_ url: URLError) -> AegisError {
    switch url.code {
    case .notConnectedToInternet,
         .dataNotAllowed,
         .internationalRoamingOff,
         .callIsActive:
      return .offline
    case .timedOut,
         .cannotFindHost,
         .cannotConnectToHost,
         .networkConnectionLost,
         .dnsLookupFailed,
         .resourceUnavailable,
         .httpTooManyRedirects,
         .secureConnectionFailed:
      return .serverUnreachable
    case .userAuthenticationRequired:
      return .unauthorized
    default:
      return .serverUnreachable
    }
  }

  /// Copy shown to the user. Warm, plain, actionable.
  public var userMessage: String {
    switch self {
    case .offline:
      return "Check your internet and try again."
    case .serverUnreachable:
      return "We're reconnecting — one moment."
    case .unauthorized:
      return "Your subscription needs refreshing. Open Settings to sign back in."
    case .paywall:
      return "This feature needs an active subscription. Tap to resubscribe."
    case .rateLimited:
      return "Too fast — give it a few seconds and try again."
    case .unknown(let msg):
      // If a caller explicitly supplied a friendlier sentence (e.g. the
      // safe-word-challenge 403 mapper), surface it. Fallback copy only
      // fires for truly-unknown errors where the msg is a raw
      // localizedDescription we don't want to parade at the user.
      if !msg.isEmpty && !msg.contains("(") && msg.count < 140 {
        return msg
      }
      return "Something went sideways. If this keeps happening, tap Settings → Support."
    }
  }

  /// Whether a retry CTA makes sense. Retrying an offline state is
  /// fine; retrying a paywall is not (the user has to act first).
  public var retryable: Bool {
    switch self {
    case .offline, .serverUnreachable, .rateLimited, .unknown: return true
    case .unauthorized, .paywall: return false
    }
  }
}
