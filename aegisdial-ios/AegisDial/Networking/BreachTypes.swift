import Foundation

public enum MonitoredIdentifierKind: String, Codable, Sendable, CaseIterable {
  case email
  case phone
}

public struct MonitoredIdentifier: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let kind: MonitoredIdentifierKind
  public let displayValue: String
  public let createdAt: String
  public let lastScannedAt: String?
  public let lastScanExposureCount: Int
  /// Provider-level status for this identifier. Known values today:
  /// `"active"` (normal), `"provider_disabled"` (our data partner
  /// doesn't support this kind yet — e.g. phone lookups). Optional so
  /// older clients stay decoded against newer server payloads and
  /// newer clients stay decoded against older server payloads.
  public let status: String?

  public init(
    id: String,
    kind: MonitoredIdentifierKind,
    displayValue: String,
    createdAt: String,
    lastScannedAt: String?,
    lastScanExposureCount: Int,
    status: String? = nil
  ) {
    self.id = id
    self.kind = kind
    self.displayValue = displayValue
    self.createdAt = createdAt
    self.lastScannedAt = lastScannedAt
    self.lastScanExposureCount = lastScanExposureCount
    self.status = status
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.id = try c.decode(String.self, forKey: .id)
    self.kind = try c.decode(MonitoredIdentifierKind.self, forKey: .kind)
    self.displayValue = try c.decode(String.self, forKey: .displayValue)
    self.createdAt = try c.decode(String.self, forKey: .createdAt)
    self.lastScannedAt = try c.decodeIfPresent(String.self, forKey: .lastScannedAt)
    self.lastScanExposureCount = try c.decode(Int.self, forKey: .lastScanExposureCount)
    self.status = try c.decodeIfPresent(String.self, forKey: .status)
  }

  enum CodingKeys: String, CodingKey {
    case id
    case kind
    case displayValue = "display_value"
    case createdAt = "created_at"
    case lastScannedAt = "last_scanned_at"
    case lastScanExposureCount = "last_scan_exposure_count"
    case status
  }
}

public enum BreachAlertSeverity: String, Codable, Sendable {
  case info
  case warning
  case critical
}

public struct BreachAlert: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let monitoredId: String
  public let source: String
  public let exposureId: String
  public let breachTitle: String
  public let breachDate: String?
  public let sourceDomain: String?
  public let dataTypes: [String]
  public let entriesCount: Int?
  public let severity: BreachAlertSeverity
  public let description: String?
  public let createdAt: String
  public let dismissedAt: String?
  public let acknowledgedAt: String?

  enum CodingKeys: String, CodingKey {
    case id
    case monitoredId = "monitored_id"
    case source
    case exposureId = "exposure_id"
    case breachTitle = "breach_title"
    case breachDate = "breach_date"
    case sourceDomain = "source_domain"
    case dataTypes = "data_types"
    case entriesCount = "entries_count"
    case severity
    case description
    case createdAt = "created_at"
    case dismissedAt = "dismissed_at"
    case acknowledgedAt = "acknowledged_at"
  }
}

public struct MonitoredAddResponse: Codable, Sendable {
  public let monitored: MonitoredIdentifier
  public let alerts: [BreachAlert]
  public let newAlerts: Int

  enum CodingKeys: String, CodingKey {
    case monitored
    case alerts
    case newAlerts = "new_alerts"
  }
}
