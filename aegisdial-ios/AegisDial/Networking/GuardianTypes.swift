import Foundation

public enum GuardianAlertKind: String, Codable, Sendable {
  case shieldCritical = "shield_critical"
  case shieldFamilyEmergency = "shield_family_emergency"
  case safeWordFailed = "safe_word_failed"
  case breachNew = "breach_new"
  case recoveryStarted = "recovery_started"
}

public enum GuardianAlertSeverity: String, Codable, Sendable {
  case info
  case warning
  case critical
}

public struct GuardianAlert: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let guardianUserId: String
  public let subjectUserId: String
  public let familyPlanId: String?
  public let kind: GuardianAlertKind
  public let severity: GuardianAlertSeverity
  public let title: String
  public let body: String
  public let createdAt: String
  public let seenAt: String?

  enum CodingKeys: String, CodingKey {
    case id
    case guardianUserId = "guardian_user_id"
    case subjectUserId = "subject_user_id"
    case familyPlanId = "family_plan_id"
    case kind
    case severity
    case title
    case body
    case createdAt = "created_at"
    case seenAt = "seen_at"
  }
}
