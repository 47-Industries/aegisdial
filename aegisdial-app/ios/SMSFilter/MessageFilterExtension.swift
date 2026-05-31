import IdentityLookup

/// AegisDial SMS Filter extension.
///
/// iOS routes every SMS/MMS from an unknown sender through this class
/// before showing it to the user. We check the message body against
/// the scam-phrase database the main app writes to the shared App
/// Group container, and return `.junk` for matches. Everything runs
/// on-device — no network calls, no data leaves the phone.
///
/// The user enables this in:
///   Settings > Apps > Messages > SMS Filtering > AegisDial
final class MessageFilterExtension: ILMessageFilterExtension {}

extension MessageFilterExtension: ILMessageFilterQueryHandling {
  func handle(
    _ queryRequest: ILMessageFilterQueryRequest,
    context: ILMessageFilterExtensionContext,
    completion: @escaping (ILMessageFilterQueryResponse) -> Void
  ) {
    let response = ILMessageFilterQueryResponse()

    let body = (queryRequest.messageBody ?? "").lowercased()
    let sender = (queryRequest.sender ?? "").lowercased()

    // Empty body → allow (can't classify nothing)
    guard !body.isEmpty else {
      response.action = .allow
      completion(response)
      return
    }

    // Load scam phrases from shared container
    let phrases = SharedScamData.loadScamPhrases()
    let blockedSenders = SharedScamData.loadBlockedSenders()

    // Check blocked senders first
    if blockedSenders.contains(where: { sender.contains($0) }) {
      response.action = .junk
      completion(response)
      return
    }

    // Score against scam phrase database
    var hitCount = 0
    for phrase in phrases {
      if body.contains(phrase) {
        hitCount += 1
      }
    }

    // 2+ phrase hits → junk. Single hit → promotion (suspicious but
    // not certain enough to hide). Zero → allow.
    if hitCount >= 2 {
      response.action = .junk
    } else if hitCount == 1 {
      if #available(iOSApplicationExtension 16.0, *) {
        response.action = .junk
        response.subAction = .transactionalOthers
      } else {
        response.action = .junk
      }
    } else {
      // Additional heuristic checks even if no phrase match
      let hasScamSignals = checkHeuristics(body: body, sender: sender)
      response.action = hasScamSignals ? .junk : .allow
    }

    completion(response)
  }

  private func checkHeuristics(body: String, sender: String) -> Bool {
    // Shortened URLs from unknown senders are suspicious
    let shortenedURLs = ["bit.ly/", "tinyurl.com/", "t.co/", "goo.gl/",
                         "rb.gy/", "is.gd/", "cutt.ly/", "shorturl.at/"]
    for url in shortenedURLs {
      if body.contains(url) { return true }
    }

    // Gift card payment demands
    if (body.contains("gift card") || body.contains("itunes card") ||
        body.contains("google play card")) &&
       (body.contains("pay") || body.contains("send") || body.contains("buy")) {
      return true
    }

    // Urgent wire/crypto demands
    if (body.contains("wire") || body.contains("bitcoin") ||
        body.contains("crypto") || body.contains("zelle")) &&
       (body.contains("immediately") || body.contains("urgent") ||
        body.contains("now") || body.contains("today")) {
      return true
    }

    return false
  }
}

// MARK: - Shared data reader

/// Reads scam data from the App Group shared container.
/// The main Flutter app writes this data via MethodChannel → UserDefaults.
enum SharedScamData {
  private static let suiteName = "group.com.aegisdial.app"
  private static let phrasesKey = "aegis_scam_phrases"
  private static let blockedKey = "aegis_blocked_senders"

  static func loadScamPhrases() -> [String] {
    guard let defaults = UserDefaults(suiteName: suiteName) else { return Self.builtInPhrases }
    let custom = defaults.stringArray(forKey: phrasesKey) ?? []
    // Merge built-in + any user/backend additions
    return custom.isEmpty ? Self.builtInPhrases : Self.builtInPhrases + custom
  }

  static func loadBlockedSenders() -> [String] {
    guard let defaults = UserDefaults(suiteName: suiteName) else { return [] }
    return defaults.stringArray(forKey: blockedKey) ?? []
  }

  /// Built-in scam phrase database. These run even if the main app has
  /// never been opened — no setup required from the user.
  static let builtInPhrases: [String] = [
    // Government impersonation
    "social security number has been suspended",
    "irs has filed a lawsuit",
    "arrest warrant has been issued",
    "your ssn has been compromised",
    "federal student loan forgiveness",
    "your benefits will be suspended",
    "department of social security",
    "your tax return has been flagged",

    // Bank / financial
    "your account has been compromised",
    "unusual activity on your account",
    "verify your account immediately",
    "your card has been locked",
    "unauthorized transaction detected",
    "click here to restore access",
    "your bank account will be closed",
    "confirm your identity or lose access",

    // Package / delivery
    "your package could not be delivered",
    "schedule your redelivery",
    "pay a small fee to release",
    "customs fee required",
    "usps redelivery fee",
    "fedex delivery attempt failed",

    // Prize / lottery
    "you have been selected as a winner",
    "claim your prize now",
    "congratulations you won",
    "lottery notification",
    "you have won a cash prize",

    // Tech support
    "your apple id has been locked",
    "your icloud account will be deleted",
    "virus detected on your device",
    "your computer has been compromised",
    "microsoft security alert",

    // Urgency / pressure
    "act now or your account will be closed",
    "this is your final notice",
    "respond within 24 hours",
    "failure to respond will result in",
    "immediate action required",

    // Crypto / investment
    "guaranteed returns",
    "double your bitcoin",
    "investment opportunity limited time",
    "crypto recovery specialist",

    // Romance / social
    "i need you to send money",
    "western union",
    "moneygram",
    "send gift cards",
    "buy itunes cards",
  ]
}
