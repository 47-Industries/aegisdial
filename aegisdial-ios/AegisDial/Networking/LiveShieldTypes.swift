import Foundation

// Wire types for /v1/live-shield/*. Mirrors src/routes/liveShield.ts on the
// backend — keep the JSON keys in sync with the Zod schemas there.

public enum LiveShieldDirection: String, Codable, Sendable {
  case inbound
  case outbound
  case unknown
}

public enum LiveShieldSpeaker: String, Codable, Sendable {
  case caller
  case `self`
  case unknown
}

public enum LiveShieldOutcome: String, Codable, Sendable {
  case userHungUp = "user_hung_up"
  case userCompleted = "user_completed"
  case userCalledGuardian = "user_called_guardian"
  case userAbandoned = "user_abandoned"
  case unknown
}

public enum LiveShieldRiskLevel: String, Codable, Sendable {
  case low
  case medium
  case high
  case critical

  public var isWarning: Bool { self == .medium || self == .high || self == .critical }
  public var isCritical: Bool { self == .critical }
}

public struct LiveShieldStartResponse: Codable, Sendable {
  public let sessionId: String
  public let startedAt: String
  public let riskScore: Int
  public let riskLevel: LiveShieldRiskLevel
  public let triggeredCategories: [String]

  enum CodingKeys: String, CodingKey {
    case sessionId = "session_id"
    case startedAt = "started_at"
    case riskScore = "risk_score"
    case riskLevel = "risk_level"
    case triggeredCategories = "triggered_categories"
  }
}

public struct LiveShieldWarning: Codable, Hashable, Sendable {
  public let patternId: String
  public let label: String
  public let severity: Int
  public let category: String

  enum CodingKeys: String, CodingKey {
    case patternId = "pattern_id"
    case label
    case severity
    case category
  }
}

public struct LiveShieldTranscriptResponse: Codable, Sendable {
  public let sessionId: String
  public let riskScore: Int
  public let riskLevel: LiveShieldRiskLevel
  public let triggeredCategories: [String]
  public let rationale: [String]
  public let newWarnings: [LiveShieldWarning]
  public let familyVerifySuggested: Bool?
  public let familySuggestion: FamilySuggestion?

  enum CodingKeys: String, CodingKey {
    case sessionId = "session_id"
    case riskScore = "risk_score"
    case riskLevel = "risk_level"
    case triggeredCategories = "triggered_categories"
    case rationale
    case newWarnings = "new_warnings"
    case familyVerifySuggested = "family_verify_suggested"
    case familySuggestion = "family_suggestion"
  }
}

public struct FamilySuggestion: Codable, Hashable, Sendable {
  public let matchedContact: FamilyContactBrief?
  public let guardianContacts: [FamilyContactBrief]
  public let instruction: String

  enum CodingKeys: String, CodingKey {
    case matchedContact = "matched_contact"
    case guardianContacts = "guardian_contacts"
    case instruction
  }
}

public struct FamilyContactBrief: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let displayName: String
  public let phone: String
  public let relationship: String?
  public let isGuardian: Bool?
  public let hasSafeWord: Bool?
  public let challengePrompt: String?
  public let hasChallenge: Bool?

  enum CodingKeys: String, CodingKey {
    case id
    case displayName = "display_name"
    case phone
    case relationship
    case isGuardian = "is_guardian"
    case hasSafeWord = "has_safe_word"
    case challengePrompt = "challenge_prompt"
    case hasChallenge = "has_challenge"
  }
}

public struct FamilyContact: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let displayName: String
  public let phone: String
  public let relationship: String?
  public let isGuardian: Bool
  public let hasSafeWord: Bool
  public let challengePrompt: String?
  public let hasChallenge: Bool
  public let notes: String?
  public let createdAt: String
  public let updatedAt: String

  enum CodingKeys: String, CodingKey {
    case id
    case displayName = "display_name"
    case phone
    case relationship
    case isGuardian = "is_guardian"
    case hasSafeWord = "has_safe_word"
    case challengePrompt = "challenge_prompt"
    case hasChallenge = "has_challenge"
    case notes
    case createdAt = "created_at"
    case updatedAt = "updated_at"
  }
}

public struct FamilyContactListResponse: Codable, Sendable {
  public let contacts: [FamilyContact]
}

public struct FamilyContactWrapResponse: Codable, Sendable {
  public let contact: FamilyContact?
}

public struct FamilyVerifyResponse: Codable, Sendable {
  public let match: Bool
}

public struct LiveShieldEndResponse: Codable, Sendable {
  public let sessionId: String
  public let startedAt: String
  public let endedAt: String
  public let durationSeconds: Int
  public let riskScore: Int
  public let riskLevel: LiveShieldRiskLevel
  public let triggeredCategories: [String]
  public let outcome: LiveShieldOutcome

  enum CodingKeys: String, CodingKey {
    case sessionId = "session_id"
    case startedAt = "started_at"
    case endedAt = "ended_at"
    case durationSeconds = "duration_seconds"
    case riskScore = "risk_score"
    case riskLevel = "risk_level"
    case triggeredCategories = "triggered_categories"
    case outcome
  }
}
